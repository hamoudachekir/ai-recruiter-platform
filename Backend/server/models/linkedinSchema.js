/**
 * LinkedIn Profile Schema Extension
 * Add this field to your existing Candidate model
 */

const linkedInSchema = {
  linkedin: {
    url: {
      type: String,
      default: null,
      validate: {
        validator: function(v) {
          if (!v) return true; // Optional field
          return /^https?:\/\/(www\.)?linkedin\.com\/(in|company)\/[\w-]+\/?$/.test(v);
        },
        message: 'Invalid LinkedIn URL format'
      }
    },
    vanityName: {
      type: String,
      default: null,
      // Extracted from URL, e.g., "john-doe" from "/in/john-doe"
    },
    status: {
      type: String,
      enum: ['not_linked', 'url_added', 'connected', 'synced'],
      default: 'not_linked'
    },
    isConnected: {
      type: Boolean,
      default: false
      // True only after successful OAuth handshake
    },
    isVerified: {
      type: Boolean,
      default: false
      // LinkedIn OAuth connection confirmed
    },
    source: {
      type: String,
      enum: ['manual_url', 'oauth', 'apify'],
      default: 'manual_url'
    },
    fullName: {
      type: String,
      default: null
    },
    about: {
      type: String,
      default: null
    },
    location: {
      type: String,
      default: null
    },
    // OAuth fields (populated only after Connect LinkedIn)
    oauthToken: {
      type: String,
      default: null
      // Encrypted access token from OAuth (never expose to client)
    },
    memberId: {
      type: String,
      default: null
      // LinkedIn person/member identifier used for activity sync
    },
    grantedScopes: {
      type: [String],
      default: []
    },
    canReadPosts: {
      type: Boolean,
      default: false
    },
    
    // Profile data (populated from OAuth sync)
    headline: {
      type: String,
      default: null
      // "Full Stack Developer at ABC Tech"
    },
    currentRole: {
      type: String,
      default: null
      // Job title
    },
    currentPosition: {
      type: String,
      default: null
    },
    currentCompany: {
      type: String,
      default: null
    },
    experience: {
      type: Array,
      default: []
    },
    education: {
      type: Array,
      default: []
    },
    skills: {
      type: Array,
      default: []
    },
    profilePhoto: {
      type: String,
      default: null
      // LinkedIn profile photo URL
    },
    
    // Future fields (nullable for forward compatibility)
    followersCount: {
      type: Number,
      default: null
    },
    connectionsCount: {
      type: Number,
      default: null
    },
    recentPosts: {
      type: Array,
      default: null
    },
    licensesCertifications: {
      type: [String],
      default: []
    },
    activitySource: {
      type: String,
      default: null
    },
    activityWarningCode: {
      type: String,
      default: null
    },
    
    // Metadata
    lastSyncedAt: {
      type: Date,
      default: null
    },
    addedAt: {
      type: Date,
      default: Date.now
    },
    connectedAt: {
      type: Date,
      default: null
    }
  }
};

// Example: How to add to your existing Candidate schema
// const candidateSchema = new Schema({
//   // ... existing fields ...
//   ...linkedInSchema,
//   // ... rest of schema ...
// });

module.exports = linkedInSchema;
