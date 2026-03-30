const mongoose = require('mongoose');
const {
  isValidLinkedInProfileUrl,
  enrichLinkedInProfileFromApify,
} = require('../services/linkedinApifyService');

async function enrichLinkedInProfile(req, res) {
  try {
    const { userId, linkedinUrl } = req.body;

    if (!userId || !linkedinUrl) {
      return res.status(400).json({
        success: false,
        message: 'userId and linkedinUrl are required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid userId',
      });
    }

    if (!isValidLinkedInProfileUrl(linkedinUrl)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid LinkedIn URL. Must be a profile/company URL.',
      });
    }

    const linkedin = await enrichLinkedInProfileFromApify({
      userId: String(userId),
      linkedinUrl,
    });

    return res.status(200).json({
      success: true,
      message: 'LinkedIn profile enriched successfully from Apify',
      linkedin,
    });
  } catch (error) {
    const knownStatusMap = {
      USER_NOT_FOUND: 404,
      EMPTY_RESULTS: 404,
      ACTOR_FAILURE: 502,
      ACTOR_START_FAILED: 502,
      ACTOR_NOT_FOUND: 502,
      APIFY_UNAUTHORIZED: 401,
      APIFY_REQUEST_FAILED: 502,
      TIMEOUT: 504,
      APIFY_CONFIG_MISSING: 500,
      MISSING_APIFY_CONFIG: 500,
    };

    const statusCode = knownStatusMap[error.code] || 500;

    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to enrich LinkedIn profile',
      linkedin: null,
    });
  }
}

module.exports = {
  enrichLinkedInProfile,
};
