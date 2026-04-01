const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { UserModel, JobModel } = require('../models/user');
const { OAuth2Client } = require('google-auth-library');

const INTERNAL_API_HEADER = 'x-internal-api-key';

const isLocalRequest = (req) => {
  const ip = String(req.ip || req.connection?.remoteAddress || '').toLowerCase();
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
};

const verifyInternalApiKey = (req, res, next) => {
  const configuredApiKey = process.env.SCHEDULING_INTERNAL_API_KEY || process.env.API_KEY;

  if (!configuredApiKey) {
    if (isLocalRequest(req) && process.env.NODE_ENV !== 'production') {
      return next();
    }
    return res.status(503).json({ message: 'Internal API key is not configured on server' });
  }

  const providedApiKey = req.headers[INTERNAL_API_HEADER];
  if (!providedApiKey || providedApiKey !== configuredApiKey) {
    return res.status(401).json({ message: 'Unauthorized internal request' });
  }

  return next();
};

const getGoogleRedirectUri = (req) => {
  const configured = String(process.env.GOOGLE_CALENDAR_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}/auth/google/callback`;
};

const refreshRecruiterAccessTokenIfNeeded = async (req, userDoc) => {
  const accessToken = userDoc?.googleCalendar?.accessToken || null;
  const refreshToken = userDoc?.googleCalendar?.refreshToken || null;
  const tokenExpiry = userDoc?.googleCalendar?.tokenExpiry
    ? new Date(userDoc.googleCalendar.tokenExpiry).getTime()
    : null;

  const shouldRefresh =
    !accessToken ||
    (tokenExpiry !== null && tokenExpiry <= Date.now() + 60000);

  if (!shouldRefresh) {
    return {
      accessToken,
      tokenExpiry: userDoc?.googleCalendar?.tokenExpiry || null,
      refreshed: false,
    };
  }

  if (!refreshToken) {
    return {
      accessToken,
      tokenExpiry: userDoc?.googleCalendar?.tokenExpiry || null,
      refreshed: false,
      refreshError: 'Refresh token not available',
    };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      accessToken,
      tokenExpiry: userDoc?.googleCalendar?.tokenExpiry || null,
      refreshed: false,
      refreshError: 'Google OAuth client credentials are missing on server',
    };
  }

  try {
    const oauthClient = new OAuth2Client(clientId, clientSecret, getGoogleRedirectUri(req));
    oauthClient.setCredentials({ refresh_token: refreshToken });

    const { credentials } = await oauthClient.refreshAccessToken();
    const newAccessToken = credentials?.access_token;
    const newExpiryDate = credentials?.expiry_date ? new Date(credentials.expiry_date) : null;

    if (!newAccessToken) {
      return {
        accessToken,
        tokenExpiry: userDoc?.googleCalendar?.tokenExpiry || null,
        refreshed: false,
        refreshError: 'Google did not return a refreshed access token',
      };
    }

    userDoc.googleCalendar.accessToken = newAccessToken;
    userDoc.googleCalendar.tokenExpiry = newExpiryDate;
    userDoc.googleCalendar.connectedAt = new Date();
    await userDoc.save();

    return {
      accessToken: newAccessToken,
      tokenExpiry: newExpiryDate,
      refreshed: true,
    };
  } catch (error) {
    return {
      accessToken,
      tokenExpiry: userDoc?.googleCalendar?.tokenExpiry || null,
      refreshed: false,
      refreshError: error?.message || 'Failed to refresh Google access token',
    };
  }
};

router.get('/context', verifyInternalApiKey, async (req, res) => {
  try {
    const { candidateId, recruiterId, jobId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(String(candidateId || ''))) {
      return res.status(400).json({ message: 'candidateId is required and must be valid' });
    }
    if (!mongoose.Types.ObjectId.isValid(String(recruiterId || ''))) {
      return res.status(400).json({ message: 'recruiterId is required and must be valid' });
    }
    if (!mongoose.Types.ObjectId.isValid(String(jobId || ''))) {
      return res.status(400).json({ message: 'jobId is required and must be valid' });
    }

    const [candidate, recruiter, job] = await Promise.all([
      UserModel.findById(candidateId).select('name email').lean(),
      UserModel.findById(recruiterId).select('name email role enterprise.name').lean(),
      JobModel.findById(jobId).select('title').lean(),
    ]);

    if (!candidate) {
      return res.status(404).json({ message: 'Candidate not found' });
    }
    if (!recruiter) {
      return res.status(404).json({ message: 'Recruiter not found' });
    }
    if (recruiter.role !== 'ENTERPRISE' && recruiter.role !== 'ADMIN') {
      return res.status(400).json({ message: 'User is not eligible as recruiter' });
    }
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    return res.status(200).json({
      candidate: {
        id: String(candidate._id),
        name: candidate.name || 'Candidate',
        email: candidate.email || '',
      },
      recruiter: {
        id: String(recruiter._id),
        name: recruiter.name || recruiter.enterprise?.name || 'Recruiter',
        email: recruiter.email || '',
      },
      job: {
        id: String(job._id),
        title: job.title || 'Position',
      },
    });
  } catch (error) {
    console.error('Internal scheduling context endpoint error:', error);
    return res.status(500).json({ message: 'Failed to fetch scheduling context' });
  }
});

router.get('/google-token/:recruiterId', verifyInternalApiKey, async (req, res) => {
  try {
    const { recruiterId } = req.params;

    const user = await UserModel.findById(recruiterId)
      .select('+googleCalendar.accessToken +googleCalendar.refreshToken +googleCalendar.tokenExpiry +googleCalendar.calendarId email name role')
      ;

    if (!user) {
      return res.status(404).json({ message: 'Recruiter not found' });
    }

    if (user.role !== 'ENTERPRISE' && user.role !== 'ADMIN') {
      return res.status(400).json({ message: 'User is not eligible as recruiter' });
    }

    const accessToken = user.googleCalendar?.accessToken || null;
    const refreshedToken = await refreshRecruiterAccessTokenIfNeeded(req, user);
    const effectiveAccessToken = refreshedToken.accessToken || accessToken;

    if (!effectiveAccessToken) {
      return res.status(404).json({ message: 'Recruiter Google Calendar token not found' });
    }

    return res.status(200).json({
      recruiter_id: recruiterId,
      recruiter_name: user.name,
      recruiter_email: user.email,
      access_token: effectiveAccessToken,
      refresh_token: user.googleCalendar?.refreshToken || null,
      token_expiry: refreshedToken.tokenExpiry || user.googleCalendar?.tokenExpiry || null,
      calendar_id: user.googleCalendar?.calendarId || 'primary',
      token_refreshed: refreshedToken.refreshed || false,
      refresh_error: refreshedToken.refreshError || null,
    });
  } catch (error) {
    console.error('Internal scheduling token endpoint error:', error);
    return res.status(500).json({ message: 'Failed to fetch recruiter calendar token' });
  }
});

module.exports = router;
