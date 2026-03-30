const axios = require('axios');
const { UserModel } = require('../models/user');

const APIFY_BASE_URL = 'https://api.apify.com/v2';

function createServiceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mapApifyAxiosError(error, contextMessage, actorId) {
  const status = error?.response?.status;
  if (status === 404) {
    return createServiceError(
      `Apify actor not found or inaccessible: ${actorId}. Verify APIFY_ACTOR_ID in .env.`,
      'ACTOR_NOT_FOUND'
    );
  }

  if (status === 401 || status === 403) {
    return createServiceError('Apify token is invalid or has insufficient permissions.', 'APIFY_UNAUTHORIZED');
  }

  if (status === 408 || status === 504 || error?.code === 'ECONNABORTED') {
    return createServiceError('Apify request timed out.', 'TIMEOUT');
  }

  return createServiceError(`${contextMessage}: ${error.message}`, 'APIFY_REQUEST_FAILED');
}

function isValidLinkedInProfileUrl(linkedinUrl) {
  if (!linkedinUrl || typeof linkedinUrl !== 'string') return false;
  return /^https?:\/\/(www\.)?linkedin\.com\/(in|company)\/[\w-]+\/?(?:\?.*)?$/i.test(linkedinUrl.trim());
}

function normalizeLinkedInProfileUrl(linkedinUrl) {
  const trimmed = String(linkedinUrl || '').trim();
  const noQuery = trimmed.replace(/\?.*$/, '');
  return noQuery.replace(/\/$/, '');
}

function buildActorInput(linkedinUrl) {
  const normalized = normalizeLinkedInProfileUrl(linkedinUrl);
  return {
    linkedinUrl: normalized,
    profileUrls: [normalized],
    urls: [normalized],
    startUrls: [{ url: normalized }],
  };
}

async function waitForRunToFinish(runId, token, timeoutMs = 180000, pollIntervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data } = await axios.get(`${APIFY_BASE_URL}/actor-runs/${runId}`, {
      params: { token },
      timeout: 15000,
    });

    const status = data?.data?.status;
    if (status === 'SUCCEEDED') {
      return data.data;
    }

    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      const error = new Error(`Actor run failed with status: ${status}`);
      error.code = 'ACTOR_FAILURE';
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const timeoutError = new Error('Apify actor run timed out while waiting for completion');
  timeoutError.code = 'TIMEOUT';
  throw timeoutError;
}

async function runActorSyncGetItems(actorId, token, actorInput) {
  const actorPath = encodeURIComponent(actorId);
  try {
    const { data } = await axios.post(
      `${APIFY_BASE_URL}/acts/${actorPath}/run-sync-get-dataset-items`,
      actorInput,
      {
        params: {
          token,
          clean: true,
          format: 'json',
        },
        timeout: 200000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    return [];
  } catch (error) {
    throw mapApifyAxiosError(error, 'Failed to run Apify sync actor', actorId);
  }
}

function mapProfileData(rawData, fallbackUrl) {
  if (!rawData || typeof rawData !== 'object') return null;

  let experiences = [];
  if (Array.isArray(rawData.experience)) {
    experiences = rawData.experience;
  } else if (Array.isArray(rawData.experiences)) {
    experiences = rawData.experiences;
  }

  let education = [];
  if (Array.isArray(rawData.education)) {
    education = rawData.education;
  } else if (Array.isArray(rawData.educations)) {
    education = rawData.educations;
  }

  let skills = [];
  if (Array.isArray(rawData.skills)) {
    skills = rawData.skills;
  } else if (Array.isArray(rawData.topSkills)) {
    skills = rawData.topSkills;
  }

  let posts = [];
  if (Array.isArray(rawData.posts)) {
    posts = rawData.posts;
  } else if (Array.isArray(rawData.activities)) {
    posts = rawData.activities;
  }

  const normalizedPosts = posts
    .map((post) => {
      if (typeof post === 'string') return post.trim();
      if (post && typeof post === 'object') {
        return String(post.text || post.content || post.caption || '').trim();
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 10);

  const currentPosition = rawData.currentPosition
    || rawData.position
    || rawData.jobTitle
    || experiences?.[0]?.title
    || null;

  const currentCompany = rawData.currentCompany
    || rawData.company
    || experiences?.[0]?.companyName
    || experiences?.[0]?.company
    || null;

  return {
    url: normalizeLinkedInProfileUrl(rawData.linkedinUrl || rawData.profileUrl || fallbackUrl),
    fullName: rawData.fullName || rawData.name || null,
    headline: rawData.headline || null,
    about: rawData.about || rawData.summary || rawData.bio || null,
    location: rawData.location || null,
    currentCompany,
    currentPosition,
    currentRole: currentPosition,
    experience: experiences,
    education,
    skills,
    profilePhoto: rawData.profilePhoto || rawData.profilePicUrl || rawData.photoUrl || null,
    recentPosts: normalizedPosts,
    source: 'apify',
    lastSyncedAt: new Date(),
  };
}

function extractPostText(postLikeItem) {
  if (!postLikeItem) return '';

  if (typeof postLikeItem === 'string') return postLikeItem.trim();

  if (typeof postLikeItem === 'object') {
    return String(
      postLikeItem.text
      || postLikeItem.content
      || postLikeItem.caption
      || postLikeItem.description
      || ''
    ).trim();
  }

  return '';
}

function mapLinkedInFromItems(items, fallbackUrl) {
  const safeItems = Array.isArray(items) ? items : [];
  const profileCandidate = safeItems.find((item) => item && typeof item === 'object' && (
    item.fullName
    || item.name
    || item.headline
    || item.currentPosition
    || item.currentCompany
    || item.profileUrl
  )) || safeItems[0];

  const mapped = mapProfileData(profileCandidate, fallbackUrl);
  if (!mapped) return null;

  const aggregatedPosts = safeItems
    .map(extractPostText)
    .filter(Boolean)
    .slice(0, 10);

  if (aggregatedPosts.length > 0) {
    mapped.recentPosts = aggregatedPosts;
  }

  return mapped;
}

async function enrichLinkedInProfileFromApify({ userId, linkedinUrl }) {
  const token = process.env.APIFY_TOKEN;
  const actorId = process.env.APIFY_ACTOR_ID;

  if (!token || !actorId) {
    const error = new Error('Apify is not configured. Set APIFY_TOKEN and APIFY_ACTOR_ID.');
    error.code = 'MISSING_APIFY_CONFIG';
    throw error;
  }

  const actorInput = buildActorInput(linkedinUrl);
  const actorPath = encodeURIComponent(actorId);

  let items = [];
  try {
    items = await runActorSyncGetItems(actorId, token, actorInput);
  } catch (syncError) {
    if (syncError.code === 'ACTOR_NOT_FOUND' || syncError.code === 'APIFY_UNAUTHORIZED') {
      throw syncError;
    }
  }

  if (!items.length) {
    let runStartResponse;
    try {
      runStartResponse = await axios.post(
        `${APIFY_BASE_URL}/acts/${actorPath}/runs`,
        actorInput,
        {
          params: { token },
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      throw mapApifyAxiosError(error, 'Failed to start Apify actor run', actorId);
    }

    const runId = runStartResponse?.data?.data?.id;
    if (!runId) {
      throw createServiceError('Failed to start Apify actor run', 'ACTOR_START_FAILED');
    }

    const completedRun = await waitForRunToFinish(runId, token);
    const datasetId = completedRun?.defaultDatasetId;

    if (!datasetId) {
      throw createServiceError('Actor finished but no dataset was generated', 'EMPTY_RESULTS');
    }

    let datasetResponse;
    try {
      datasetResponse = await axios.get(`${APIFY_BASE_URL}/datasets/${datasetId}/items`, {
        params: { token, clean: true, limit: 5, format: 'json' },
        timeout: 30000,
      });
    } catch (error) {
      throw mapApifyAxiosError(error, 'Failed fetching Apify dataset items', actorId);
    }

    items = Array.isArray(datasetResponse?.data) ? datasetResponse.data : [];
  }

  if (!items.length) {
    throw createServiceError(
      'No public LinkedIn data found for this URL. Try another public profile or a different actor.',
      'EMPTY_RESULTS'
    );
  }

  const mappedLinkedIn = mapLinkedInFromItems(items, linkedinUrl);
  if (!mappedLinkedIn) {
    throw createServiceError('Unable to map Apify data into LinkedIn profile fields', 'EMPTY_RESULTS');
  }

  const updatedUser = await UserModel.findByIdAndUpdate(
    userId,
    { $set: Object.entries(mappedLinkedIn).reduce((acc, [key, value]) => {
      acc[`linkedin.${key}`] = value;
      return acc;
    }, {}) },
    { new: true }
  );

  if (!updatedUser) {
    throw createServiceError('User not found', 'USER_NOT_FOUND');
  }

  return updatedUser.linkedin;
}

module.exports = {
  isValidLinkedInProfileUrl,
  normalizeLinkedInProfileUrl,
  enrichLinkedInProfileFromApify,
};
