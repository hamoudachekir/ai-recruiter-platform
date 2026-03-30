/**
 * LinkedIn Routes
 * Handles LinkedIn URL storage and OAuth authentication
 * Path: Backend/server/routes/linkedinRoute.js
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const mongoose = require('mongoose');
const { UserModel } = require('../models/user');

function isValidCandidateId(candidateId) {
  if (!candidateId || typeof candidateId !== 'string') return false;
  const normalized = candidateId.trim();
  if (!normalized || normalized === 'null' || normalized === 'undefined') return false;
  return mongoose.Types.ObjectId.isValid(normalized);
}

function parseScopeList(scopeValue) {
  if (!scopeValue || typeof scopeValue !== 'string') return [];
  return scopeValue
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasMemberSocialScope(scopeValue) {
  return parseScopeList(scopeValue).some((scope) => /member_social/i.test(scope));
}

function buildScopesForMode(flowMode, includeActivityScope) {
  const defaultBaseScopes = flowMode === 'classic'
    ? ['r_liteprofile']
    : ['openid', 'profile', 'email'];

  const configuredBaseScopes = parseScopeList(process.env.LINKEDIN_SCOPES);
  const baseScopes = configuredBaseScopes.length > 0 ? configuredBaseScopes : defaultBaseScopes;

  const activityScopes = parseScopeList(process.env.LINKEDIN_ACTIVITY_SCOPES || 'r_member_social');
  const finalScopes = includeActivityScope
    ? Array.from(new Set([...baseScopes, ...activityScopes]))
    : baseScopes;

  return finalScopes.join(' ');
}

function extractPostText(item) {
  const candidates = [
    item?.text?.text,
    item?.commentary,
    item?.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text,
    item?.content?.article?.description,
    item?.content?.text,
    item?.shareCommentary?.text
  ];

  const selected = candidates.find((value) => typeof value === 'string' && value.trim());
  return selected ? selected.trim() : '';
}

// Helper: Extract vanity name from LinkedIn URL
function extractVanityName(url) {
  try {
    // Pattern: linkedin.com/in/john-doe or linkedin.com/in/john-doe/
    const match = url.match(/linkedin\.com\/(in|company)\/([\w-]+)/i);
    return match ? match[2].toLowerCase() : null;
  } catch {
    return null;
  }
}

// Helper: Validate LinkedIn URL format
function isValidLinkedInUrl(url) {
  if (!url) return false;
  const pattern = /^https?:\/\/(www\.)?linkedin\.com\/(in|company)\/[\w-]+\/?$/i;
  return pattern.test(url);
}

// Helper: Normalize LinkedIn URL
function normalizeLinkedInUrl(url) {
  try {
    const urlObj = new URL(url);
    let path = urlObj.pathname;
    
    // Remove trailing slash
    path = path.replace(/\/$/, '');
    
    // Reconstruct
    return `https://www.linkedin.com${path}`;
  } catch {
    return url;
  }
}

/**
 * POST /api/linkedin/save-url
 * Save a LinkedIn URL to candidate profile
 * 
 * Phase 1: Just store the URL, no OAuth needed
 * 
 * Request:
 * {
 *   "candidateId": "user123",
 *   "linkedinUrl": "https://www.linkedin.com/in/john-doe"
 * }
 */
router.post('/save-url', async (req, res) => {
  try {
    const { candidateId, linkedinUrl } = req.body;

    if (!candidateId || !linkedinUrl) {
      return res.status(400).json({
        error: 'candidateId and linkedinUrl are required'
      });
    }

    if (!isValidCandidateId(String(candidateId))) {
      return res.status(400).json({ error: 'Invalid candidateId' });
    }

    // Validate URL format
    if (!isValidLinkedInUrl(linkedinUrl)) {
      return res.status(400).json({
        error: 'Invalid LinkedIn URL. Must be in format: https://www.linkedin.com/in/username'
      });
    }

    // Normalize URL
    const normalizedUrl = normalizeLinkedInUrl(linkedinUrl);
    const vanityName = extractVanityName(normalizedUrl);

    // Update user
    const updated = await UserModel.findByIdAndUpdate(
      candidateId,
      {
        $set: {
          'linkedin.url': normalizedUrl,
          'linkedin.vanityName': vanityName,
          'linkedin.status': 'url_added',
          'linkedin.source': 'manual_url',
          'linkedin.addedAt': new Date()
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    res.json({
      success: true,
      message: 'LinkedIn URL saved successfully',
      linkedin: updated.linkedin
    });

  } catch (error) {
    console.error('Error saving LinkedIn URL:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/linkedin/candidate/:candidateId
 * Get LinkedIn profile data for a candidate
 */
router.get('/candidate/:candidateId', async (req, res) => {
  try {
    const { candidateId } = req.params;

    if (!isValidCandidateId(String(candidateId))) {
      return res.status(400).json({ error: 'Invalid candidateId' });
    }

    const candidate = await UserModel.findById(candidateId);
    
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    res.json({
      candidateId: candidate._id,
      linkedin: candidate.linkedin || {},
      message: candidate.linkedin?.url ? 'LinkedIn profile found' : 'No LinkedIn profile attached'
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/linkedin/candidate/:candidateId
 * Remove LinkedIn profile from candidate
 */
router.delete('/candidate/:candidateId', async (req, res) => {
  try {
    const { candidateId } = req.params;

    if (!isValidCandidateId(String(candidateId))) {
      return res.status(400).json({ error: 'Invalid candidateId' });
    }

    const updated = await UserModel.findByIdAndUpdate(
      candidateId,
      {
        $set: {
          'linkedin.url': null,
          'linkedin.vanityName': null,
          'linkedin.status': 'not_linked',
          'linkedin.isConnected': false,
          'linkedin.isVerified': false,
          'linkedin.headline': null,
          'linkedin.currentRole': null,
          'linkedin.currentCompany': null,
          'linkedin.profilePhoto': null
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    res.json({
      success: true,
      message: 'LinkedIn profile removed',
      linkedin: updated.linkedin
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /auth/linkedin/start
 * Initiate LinkedIn OAuth flow
 * 
 * Redirects user to LinkedIn authorization page
 * LinkedIn will redirect back to /auth/linkedin/callback with authorization code
 */
router.get('/start', (req, res) => {
  const manualOnly = process.env.LINKEDIN_MANUAL_ONLY !== 'false';
  if (manualOnly) {
    return res.status(410).json({
      error: 'LinkedIn OAuth is disabled in manual-only mode',
      mode: 'manual_only',
      next: 'Use /api/linkedin/enrich with userId + linkedinUrl'
    });
  }
  try {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
    const requestedMode = req.query.mode;
    const defaultMode = process.env.LINKEDIN_DEFAULT_MODE || 'oidc';
    const flowMode = requestedMode === 'oidc' || requestedMode === 'classic'
      ? requestedMode
      : defaultMode;
    const includeActivityScope = req.query.activity === '1' || req.query.activity === 'true';
    const state = `${flowMode}|activity:${includeActivityScope ? '1' : '0'}|${Math.random().toString(36).substring(7)}`;
    
    // Debug logging
    console.log('🔍 LinkedIn OAuth DEBUG:');
    console.log('  LINKEDIN_CLIENT_ID:', clientId ? '✅ Loaded' : '❌ Missing');
    console.log('  LINKEDIN_REDIRECT_URI:', redirectUri ? '✅ Loaded' : '❌ Missing');
    console.log('  Full value:', { clientId, redirectUri });
    
    if (!clientId || !redirectUri) {
      return res.status(500).json({
        error: 'LinkedIn OAuth not configured. Set LINKEDIN_CLIENT_ID and LINKEDIN_REDIRECT_URI in .env',
        debug: {
          clientId: clientId ? 'SET' : 'MISSING',
          redirectUri: redirectUri ? 'SET' : 'MISSING'
        }
      });
    }

    // Store state in session for verification (you should use sessions/cookies)
    // For now, we'll pass it as-is
    
    const requestedScopes = buildScopesForMode(flowMode, includeActivityScope);
    const scope = encodeURIComponent(requestedScopes);
    const authUrl = `https://www.linkedin.com/oauth/v2/authorization?` +
      `response_type=code&` +
      `client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${scope}&` +
      `state=${state}`;

    res.redirect(authUrl);

  } catch (error) {
    console.error('Error starting OAuth:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /auth/linkedin/callback
 * LinkedIn OAuth callback
 * 
 * Receives authorization code and exchanges it for access token
 * Then fetches user profile info
 */
router.get('/callback', async (req, res) => {
  const manualOnly = process.env.LINKEDIN_MANUAL_ONLY !== 'false';
  if (manualOnly) {
    return res.status(410).json({
      error: 'LinkedIn OAuth callback is disabled in manual-only mode',
      mode: 'manual_only'
    });
  }
  try {
    const { code, state, error } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const stateValue = typeof state === 'string' ? state : '';
    const [stateModeRaw = 'oidc', stateActivityRaw = 'activity:0'] = stateValue.split('|');
    const stateMode = stateModeRaw === 'classic' ? 'classic' : 'oidc';
    const activityRequested = stateActivityRaw === 'activity:1';

    if (error) {
      const errorDescription = req.query.error_description || 'LinkedIn OAuth error';

      // If OIDC scopes are rejected, retry once with classic scopes automatically.
      if (error === 'invalid_scope_error' && activityRequested) {
        return res.redirect(`/auth/linkedin/start?mode=${stateMode}`);
      }

      if (error === 'invalid_scope_error' && stateMode === 'oidc') {
        return res.redirect('/auth/linkedin/start?mode=classic');
      }

      return res.redirect(
        `${frontendUrl}/linkedin-oauth-callback?success=false&error=${encodeURIComponent(error)}&details=${encodeURIComponent(errorDescription)}`
      );
    }

    if (!code) {
      return res.status(400).json({ error: 'No authorization code received' });
    }

    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).json({
        error: 'LinkedIn OAuth not configured'
      });
    }

    // Step 1: Exchange code for access token
    const tokenResponse = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      null,
      {
        params: {
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    const grantedScope = tokenResponse.data.scope || '';
    const usesOidc = /\bopenid\b|\bprofile\b|\bemail\b/.test(grantedScope);

    let firstName = '';
    let lastName = '';
    let headline = '';
    let profilePictureUrl = '';
    let memberId = '';

    // Step 2: Fetch profile info using access token
    if (usesOidc) {
      const profileResponse = await axios.get(
        'https://api.linkedin.com/v2/userinfo',
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      const profileData = profileResponse.data;
      firstName = profileData.given_name || profileData.givenName || '';
      lastName = profileData.family_name || profileData.familyName || '';
      headline = profileData.headline || profileData.jobTitle || '';
      profilePictureUrl = profileData.picture || '';
      memberId = profileData.sub || profileData.id || '';
    } else {
      const profileResponse = await axios.get(
        'https://api.linkedin.com/v2/me',
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      const profileData = profileResponse.data;
      firstName = profileData.localizedFirstName || profileData.firstName?.localized?.en_US || '';
      lastName = profileData.localizedLastName || profileData.lastName?.localized?.en_US || '';
      headline = profileData.headline?.values?.[0]?.localized?.en_US ||
                 profileData.headline?.localized?.en_US || '';
      profilePictureUrl = profileData.profilePicture?.displayImage || profileData.profilePicture || '';
      memberId = profileData.id || '';
    }

    // Step 4: Try to find user from state or request param
    // For now, we'll redirect to frontend with data in URL (can improve later with sessions)
    const redirectUrl = `${frontendUrl}/linkedin-oauth-callback?` +
      `success=true&` +
      `firstName=${encodeURIComponent(firstName)}&` +
      `lastName=${encodeURIComponent(lastName)}&` +
      `headline=${encodeURIComponent(headline)}&` +
      `profilePictureUrl=${encodeURIComponent(profilePictureUrl)}&` +
      `memberId=${encodeURIComponent(memberId)}&` +
      `scope=${encodeURIComponent(grantedScope)}&` +
      `token=${encodeURIComponent(accessToken)}`;

    res.redirect(redirectUrl);

  } catch (error) {
    console.error('Error in OAuth callback:', error.response?.data || error.message);
    res.status(500).json({
      error: 'OAuth exchange failed',
      details: error.response?.data?.error_description || error.message
    });
  }
});

/**
 * POST /api/linkedin/connect-profile
 * Save LinkedIn profile after successful OAuth
 * 
 * Called after callback redirects user back to frontend
 */
router.post('/connect-profile', async (req, res) => {
  const manualOnly = process.env.LINKEDIN_MANUAL_ONLY !== 'false';
  if (manualOnly) {
    return res.status(410).json({
      error: 'LinkedIn OAuth connect is disabled in manual-only mode',
      mode: 'manual_only'
    });
  }
  try {
    const { candidateId, linkedinToken, firstName, lastName, headline, profilePictureUrl, memberId, grantedScope } = req.body;

    if (!candidateId || !linkedinToken) {
      return res.status(400).json({
        error: 'candidateId and linkedinToken are required'
      });
    }

    if (!isValidCandidateId(String(candidateId))) {
      return res.status(400).json({ error: 'Invalid candidateId' });
    }

    const grantedScopes = parseScopeList(grantedScope || '');

    // Update user with LinkedIn data
    const updated = await UserModel.findByIdAndUpdate(
      candidateId,
      {
        $set: {
          'linkedin.oauthToken': linkedinToken,
          'linkedin.status': 'connected',
          'linkedin.isConnected': true,
          'linkedin.isVerified': true,
          'linkedin.source': 'oauth',
          'linkedin.headline': headline || '',
          'linkedin.currentRole': firstName && lastName ? `${firstName} ${lastName}` : '',
          'linkedin.profilePhoto': profilePictureUrl || null,
          'linkedin.memberId': memberId || null,
          'linkedin.grantedScopes': grantedScopes,
          'linkedin.canReadPosts': grantedScopes.some((scope) => /member_social/i.test(scope)),
          'linkedin.connectedAt': new Date(),
          'linkedin.lastSyncedAt': new Date()
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      message: 'LinkedIn profile connected and saved',
      linkedin: updated.linkedin
    });

  } catch (error) {
    console.error('Error connecting LinkedIn profile:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/sync-activity', async (req, res) => {
  const manualOnly = process.env.LINKEDIN_MANUAL_ONLY !== 'false';
  if (manualOnly) {
    return res.status(410).json({
      error: 'LinkedIn activity sync via OAuth is disabled in manual-only mode',
      mode: 'manual_only',
      next: 'Use /api/linkedin/enrich with userId + linkedinUrl'
    });
  }
  try {
    const { candidateId } = req.body;

    if (!candidateId) {
      return res.status(400).json({ error: 'candidateId is required' });
    }

    if (!isValidCandidateId(String(candidateId))) {
      return res.status(400).json({ error: 'Invalid candidateId' });
    }

    const user = await UserModel.findById(candidateId);
    if (!user?.linkedin?.isConnected || !user?.linkedin?.oauthToken || !user?.linkedin?.memberId) {
      return res.status(400).json({
        error: 'LinkedIn account not fully connected (missing token/memberId)'
      });
    }

    const accessToken = user.linkedin.oauthToken;
    const personUrn = `urn:li:person:${user.linkedin.memberId}`;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    };

    const restHeaders = {
      ...headers,
      'LinkedIn-Version': process.env.LINKEDIN_API_VERSION || '202401'
    };

    let elements = [];
    let syncSource = '';
    let syncWarning = null;
    let lastProviderStatus = null;
    const grantedScopes = Array.isArray(user.linkedin.grantedScopes)
      ? user.linkedin.grantedScopes.join(' ')
      : '';

    if (!hasMemberSocialScope(grantedScopes)) {
      const updatedNoScope = await UserModel.findByIdAndUpdate(
        candidateId,
        {
          $set: {
            'linkedin.recentPosts': [],
            'linkedin.activitySource': 'no_activity_access',
            'linkedin.activityWarningCode': 'ACTIVITY_SCOPE_NOT_GRANTED',
            'linkedin.status': 'synced',
            'linkedin.lastSyncedAt': new Date()
          }
        },
        { new: true }
      );

      return res.json({
        success: true,
        message: 'LinkedIn activity synced',
        source: 'no_activity_access',
        warning: {
          code: 'ACTIVITY_SCOPE_NOT_GRANTED',
          message: 'This LinkedIn token cannot read member posts. Reconnect with activity access, or use Licenses & Certifications fallback.',
          status: 403
        },
        recentPosts: [],
        linkedin: updatedNoScope?.linkedin
      });
    }

    const attempts = [
      {
        label: 'rest_posts',
        request: () => axios.get('https://api.linkedin.com/rest/posts', {
          headers: restHeaders,
          params: {
            q: 'author',
            author: personUrn,
            count: 5,
            sortBy: 'LAST_MODIFIED'
          }
        })
      },
      {
        label: 'ugcPosts_list_author',
        request: () => axios.get('https://api.linkedin.com/v2/ugcPosts', {
          headers,
          params: {
            q: 'authors',
            authors: `List(${personUrn})`,
            count: 5,
            sortBy: 'LAST_MODIFIED'
          }
        })
      },
      {
        label: 'ugcPosts_author',
        request: () => axios.get('https://api.linkedin.com/v2/ugcPosts', {
          headers,
          params: {
            q: 'authors',
            authors: personUrn,
            count: 5,
            sortBy: 'LAST_MODIFIED'
          }
        })
      },
      {
        label: 'shares_owner',
        request: () => axios.get('https://api.linkedin.com/v2/shares', {
          headers,
          params: {
            q: 'owners',
            owners: personUrn,
            count: 5,
            sortBy: 'LAST_MODIFIED'
          }
        })
      },
      {
        label: 'shares_list_owner',
        request: () => axios.get('https://api.linkedin.com/v2/shares', {
          headers,
          params: {
            q: 'owners',
            owners: `List(${personUrn})`,
            count: 5,
            sortBy: 'LAST_MODIFIED'
          }
        })
      }
    ];

    for (const attempt of attempts) {
      try {
        const response = await attempt.request();
        const rawElements = response.data?.elements || response.data?.results || [];
        elements = Array.isArray(rawElements) ? rawElements : [];
        syncSource = attempt.label;
        break;
      } catch (providerError) {
        lastProviderStatus = providerError.response?.status || lastProviderStatus;
        console.warn(`LinkedIn activity attempt failed (${attempt.label}):`, providerError.response?.data || providerError.message);
      }
    }

    if (!syncSource) {
      syncSource = 'no_activity_access';
      syncWarning = {
        code: hasMemberSocialScope(grantedScopes) ? 'ACTIVITY_API_UNAVAILABLE' : 'ACTIVITY_SCOPE_NOT_GRANTED',
        message: hasMemberSocialScope(grantedScopes)
          ? 'LinkedIn activity API is unavailable for this app/token at the moment.'
          : 'Token does not include member social scope. Reconnect LinkedIn with activity access enabled.',
        status: lastProviderStatus
      };
    } else if (elements.length === 0) {
      syncWarning = {
        code: 'NO_POSTS_FOUND',
        message: 'LinkedIn connection is valid, but no recent posts were returned for this profile.',
        status: 200
      };
    }

    const recentPosts = elements
      .map((item) => extractPostText(item))
      .filter(Boolean)
      .slice(0, 5);

    const updated = await UserModel.findByIdAndUpdate(
      candidateId,
      {
        $set: {
          'linkedin.recentPosts': recentPosts,
          'linkedin.activitySource': syncSource,
          'linkedin.activityWarningCode': syncWarning?.code || null,
          'linkedin.status': 'synced',
          'linkedin.lastSyncedAt': new Date()
        }
      },
      { new: true }
    );

    return res.json({
      success: true,
      message: 'LinkedIn activity synced',
      source: syncSource,
      warning: syncWarning,
      recentPosts: recentPosts,
      linkedin: updated?.linkedin
    });
  } catch (error) {
    console.error('Error syncing LinkedIn activity:', error.response?.data || error.message);
    return res.status(500).json({
      error: 'Failed to sync LinkedIn activity',
      details: error.response?.data?.message || error.message
    });
  }
});

/**
 * POST /api/linkedin/sync
 * Manually sync LinkedIn profile data
 * 
 * Refreshes profile data for connected account
 */
router.post('/sync', async (req, res) => {
  const manualOnly = process.env.LINKEDIN_MANUAL_ONLY !== 'false';
  if (manualOnly) {
    return res.status(410).json({
      error: 'LinkedIn sync via OAuth is disabled in manual-only mode',
      mode: 'manual_only'
    });
  }
  try {
    const { candidateId } = req.body;

    if (!candidateId) {
      return res.status(400).json({ error: 'candidateId is required' });
    }

    if (!isValidCandidateId(String(candidateId))) {
      return res.status(400).json({ error: 'Invalid candidateId' });
    }

    const candidate = await UserModel.findById(candidateId);
    
    if (!candidate || !candidate.linkedin?.isConnected) {
      return res.status(400).json({
        error: 'Candidate not connected to LinkedIn'
      });
    }

    // TODO: Implement actual sync using stored access token
    // For now, just update lastSyncedAt
    
    const updated = await UserModel.findByIdAndUpdate(
      candidateId,
      {
        $set: {
          'linkedin.lastSyncedAt': new Date(),
          'linkedin.status': 'synced'
        }
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'LinkedIn profile synced',
      linkedin: updated.linkedin
    });

  } catch (error) {
    console.error('Error syncing LinkedIn:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/save-certifications', async (req, res) => {
  try {
    const { candidateId, certifications } = req.body;

    if (!candidateId) {
      return res.status(400).json({ error: 'candidateId is required' });
    }

    if (!isValidCandidateId(String(candidateId))) {
      return res.status(400).json({ error: 'Invalid candidateId' });
    }

    let normalized = [];
    if (Array.isArray(certifications)) {
      normalized = certifications;
    } else if (typeof certifications === 'string') {
      normalized = certifications.split(/\r?\n|,/);
    }

    normalized = normalized
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 30);

    const updated = await UserModel.findByIdAndUpdate(
      candidateId,
      {
        $set: {
          'linkedin.licensesCertifications': normalized,
          'linkedin.lastSyncedAt': new Date()
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      success: true,
      message: 'Licenses & certifications saved',
      linkedin: updated.linkedin
    });
  } catch (error) {
    console.error('Error saving LinkedIn certifications:', error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
