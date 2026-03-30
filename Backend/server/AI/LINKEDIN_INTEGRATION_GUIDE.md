# LinkedIn Profile Integration - Implementation Guide

## Overview

This guide explains how to integrate LinkedIn profile detection and enrichment into your candidate management system.

**Phase 1 (Current)**: Manual LinkedIn URL entry and enrichment  
**Phase 2 (Future)**: Automatic LinkedIn profile detection  
**Phase 3 (Future)**: OAuth official integration  

---

## Database Schema Changes

### Candidate Model Update

Add a `linkedin` field to your candidate schema:

```javascript
// Backend/server/models/candidat.js (or equivalent)

const candidateSchema = new Schema({
  // ... existing fields ...
  
  linkedin: {
    url: {
      type: String,
      default: null,
      match: /https?:\/\/(www\.)?linkedin\.com\/(in|pub)\//
    },
    status: {
      type: String,
      enum: ['not_found', 'suggested', 'confirmed', 'connected'],
      default: 'not_found'
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    source: {
      type: String,
      enum: ['cv', 'search', 'candidate_manual', 'oauth'],
      default: 'candidate_manual'
    },
    verifiedByCandidate: {
      type: Boolean,
      default: false
    },
    enrichedData: {
      headline: String,           // "Full Stack Developer at ABC Corp"
      currentCompany: String,     // "ABC Corporation"
      currentTitle: String,       // "Senior Full Stack Developer"
      location: String,          // "San Francisco, CA"
      profileSummary: String,    // About/bio text (max 500 chars)
      skills: [String],          // Array of skills from LinkedIn
    },
    lastCheckedAt: Date,
    lastEnrichedAt: Date,
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  
  // ... rest of schema ...
});
```

### Audit Log Collection

Create a new collection to track LinkedIn profile changes:

```javascript
// Backend/server/models/LinkedInAuditLog.js

const auditLogSchema = new Schema({
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  candidateId: {
    type: Schema.Types.ObjectId,
    ref: 'Candidate',
    required: true,
    index: true
  },
  action: {
    type: String,
    enum: [
      'linkedin_url_added',
      'linkedin_url_verified',
      'linkedin_data_extracted',
      'linkedin_profile_enriched',
      'linkedin_url_removed',
      'linkedin_recheck'
    ],
    required: true
  },
  linkedinUrl: String,
  metadata: Schema.Types.Mixed,  // Flexible field for action-specific data
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  }
});

module.exports = mongoose.model('LinkedInAuditLog', auditLogSchema);
```

---

## Backend Implementation

### 1. Update iA4.py (CV Extraction Service)

The CV extraction already works. Now integrate LinkedIn detection from CV text:

```python
# In iA4.py, add to process_resume() function:

from linkedin_matcher import LinkedInMatcher

def process_resume(file_path):
    # ... existing CV extraction code ...
    
    parsed = {
        "name": extract_name(text),
        "email": extract_email(text),
        "phone": extract_phone(text),
        # ... other fields ...
    }
    
    # NEW: Check if CV contains LinkedIn URL
    linkedin_url = LinkedInMatcher.extract_linkedin_url_from_text(text)
    if linkedin_url:
        parsed["linkedinUrlFromCV"] = linkedin_url
        parsed["linkedinStatus"] = "suggested"  # Found in CV, not verified yet
    
    return parsed
```

### 2. Add LinkedIn Routes to Express Backend

Create a new file: `Backend/server/routes/linkedinRoute.js`

```javascript
const express = require('express');
const router = express.Router();
const Candidate = require('../models/candidat');
const LinkedInAuditLog = require('../models/LinkedInAuditLog');
const auth = require('../middleware/auth');

/**
 * POST /api/linkedin/attach
 * Attach LinkedIn profile to candidate
 */
router.post('/attach', auth, async (req, res) => {
  try {
    const { candidateId, linkedinUrl, extractData } = req.body;
    
    if (!candidateId || !linkedinUrl) {
      return res.status(400).json({ error: 'candidateId and linkedinUrl required' });
    }
    
    // Validate URL format
    const urlRegex = /https?:\/\/(www\.)?linkedin\.com\/(in|pub)\//i;
    if (!urlRegex.test(linkedinUrl)) {
      return res.status(400).json({ error: 'Invalid LinkedIn URL format' });
    }
    
    // Update candidate
    const candidate = await Candidate.findByIdAndUpdate(
      candidateId,
      {
        linkedin: {
          url: linkedinUrl,
          status: 'confirmed',
          confidence: 100,
          source: 'candidate_manual',
          verifiedByCandidate: true,
          createdAt: new Date()
        }
      },
      { new: true }
    );
    
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    
    // Log the action
    await LinkedInAuditLog.create({
      candidateId,
      action: 'linkedin_url_verified',
      linkedinUrl,
      userId: req.user._id,
      metadata: { extractData }
    });
    
    res.json({
      status: 'success',
      candidateId,
      linkedinUrl,
      message: 'LinkedIn profile attached successfully'
    });
    
  } catch (error) {
    console.error('Error attaching LinkedIn profile:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/linkedin/:candidateId
 * Get LinkedIn profile info for candidate
 */
router.get('/:candidateId', auth, async (req, res) => {
  try {
    const candidate = await Candidate.findById(req.params.candidateId);
    
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    
    res.json({
      candidateId: candidate._id,
      linkedin: candidate.linkedin || null,
      message: candidate.linkedin ? 'LinkedIn profile found' : 'No LinkedIn profile attached'
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/linkedin/:candidateId
 * Remove LinkedIn profile from candidate
 */
router.delete('/:candidateId', auth, async (req, res) => {
  try {
    const candidate = await Candidate.findByIdAndUpdate(
      req.params.candidateId,
      { linkedin: null },
      { new: true }
    );
    
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    
    // Log removal
    await LinkedInAuditLog.create({
      candidateId: req.params.candidateId,
      action: 'linkedin_url_removed',
      userId: req.user._id
    });
    
    res.json({
      status: 'success',
      message: 'LinkedIn profile removed'
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

Add to main `Backend/server/index.js`:

```javascript
// Add with other route imports
const linkedinRoute = require('./routes/linkedinRoute');

// Register route
app.use('/api/linkedin', linkedinRoute);
```

---

## Frontend Implementation

### 1. Create LinkedIn Profile Section Component

Create: `Frontend/src/components/LinkedInProfileSection.jsx`

```jsx
import React, { useState } from 'react';
import { FaLinkedinIn, FaCheck, FaTimes, FaSpinner } from 'react-icons/fa';
import './LinkedInProfileSection.css';

export function LinkedInProfileSection({ candidateId, linkedinData, onUpdate }) {
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState(linkedinData?.url || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      const response = await fetch('/api/linkedin/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId,
          linkedinUrl: url,
          extractData: true
        })
      });

      if (!response.ok) throw new Error('Failed to attach LinkedIn profile');

      const data = await response.json();
      setSuccess('LinkedIn profile added successfully! ✅');
      setShowForm(false);
      onUpdate(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    if (!window.confirm('Remove LinkedIn profile?')) return;

    setLoading(true);
    try {
      await fetch(`/api/linkedin/${candidateId}`, { method: 'DELETE' });
      setSuccess('LinkedIn profile removed');
      onUpdate(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="linkedin-section">
      <div className="section-header">
        <FaLinkedinIn className="linkedin-icon" />
        <h3>Professional Profile</h3>
      </div>

      {linkedinData?.url ? (
        <div className="linkedin-profile-display">
          <div className="profile-url">
            <a href={linkedinData.url} target="_blank" rel="noopener noreferrer">
              {linkedinData.url}
            </a>
          </div>

          {linkedinData.enrichedData && (
            <div className="enriched-data">
              {linkedinData.enrichedData.headline && (
                <p><strong>Headline:</strong> {linkedinData.enrichedData.headline}</p>
              )}
              {linkedinData.enrichedData.currentCompany && (
                <p><strong>Company:</strong> {linkedinData.enrichedData.currentCompany}</p>
              )}
              {linkedinData.enrichedData.currentTitle && (
                <p><strong>Title:</strong> {linkedinData.enrichedData.currentTitle}</p>
              )}
              {linkedinData.enrichedData.location && (
                <p><strong>Location:</strong> {linkedinData.enrichedData.location}</p>
              )}
            </div>
          )}

          <div className="profile-status">
            <span className={`status-badge ${linkedinData.status}`}>
              {linkedinData.status === 'confirmed' && <FaCheck />}
              {linkedinData.status}
            </span>
            <span className="verified">
              {linkedinData.verifiedByCandidate && '✓ Verified by candidate'}
            </span>
          </div>

          <button onClick={() => setShowForm(true)} className="btn-edit">
            Update Profile
          </button>
          <button onClick={handleRemove} className="btn-remove">
            Remove
          </button>
        </div>
      ) : (
        <div className="no-profile">
          <p>Add your LinkedIn profile to enhance your profile</p>
          <button onClick={() => setShowForm(true)} className="btn-add">
            Add LinkedIn Profile
          </button>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="linkedin-form">
          <div className="form-group">
            <label>LinkedIn Profile URL</label>
            <input
              type="url"
              placeholder="https://www.linkedin.com/in/your-profile"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <small>Links to /in/ or /pub/ profiles</small>
          </div>

          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          <div className="form-actions">
            <button type="submit" disabled={loading}>
              {loading ? <FaSpinner className="spinner" /> : 'Save Profile'}
            </button>
            <button type="button" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
```

### 2. Add to Candidate Profile Page

In `Frontend/src/pages/Candidate/CandidateProfile.jsx`:

```jsx
import { LinkedInProfileSection } from '../../components/LinkedInProfileSection';

export function CandidateProfile() {
  // ... existing code ...

  return (
    <div className="candidate-profile">
      {/* ... existing profile sections ... */}
      
      <section className="section">
        <LinkedInProfileSection 
          candidateId={candidate._id}
          linkedinData={candidate.linkedin}
          onUpdate={handleLinkedInUpdate}
        />
      </section>
      
      {/* ... rest of profile ... */}
    </div>
  );
}
```

---

## CSS Styling

Create: `Frontend/src/components/LinkedInProfileSection.css`

```css
.linkedin-section {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 20px;
  background: #f9f9f9;
  margin: 20px 0;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
}

.linkedin-icon {
  color: #0077b5;
  font-size: 24px;
}

.linkedin-profile-display {
  background: white;
  padding: 15px;
  border-radius: 6px;
  margin-bottom: 15px;
}

.profile-url a {
  color: #0077b5;
  text-decoration: none;
  font-weight: 500;
}

.profile-url a:hover {
  text-decoration: underline;
}

.enriched-data {
  margin-top: 15px;
  padding-top: 15px;
  border-top: 1px solid #eee;
}

.enriched-data p {
  margin: 8px 0;
  font-size: 14px;
}

.profile-status {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 15px 0;
  font-size: 12px;
}

.status-badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.status-badge.confirmed {
  background: #e8f5e9;
  color: #2e7d32;
}

.status-badge.suggested {
  background: #fff3e0;
  color: #e65100;
}

.verified {
  color: #4caf50;
  font-weight: 500;
}

.linkedin-form {
  background: white;
  padding: 15px;
  border-radius: 6px;
  margin-top: 15px;
}

.form-group {
  margin-bottom: 15px;
}

.form-group label {
  display: block;
  font-weight: 600;
  margin-bottom: 5px;
}

.form-group input {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

.form-group small {
  display: block;
  color: #999;
  margin-top: 5px;
}

.error-message {
  color: #c62828;
  background: #ffebee;
  padding: 10px;
  border-radius: 4px;
  margin-bottom: 10px;
}

.success-message {
  color: #2e7d32;
  background: #e8f5e9;
  padding: 10px;
  border-radius: 4px;
  margin-bottom: 10px;
}

.form-actions {
  display: flex;
  gap: 10px;
}

.form-actions button {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}

.form-actions button[type="submit"] {
  background: #0077b5;
  color: white;
}

.form-actions button[type="submit"]:hover {
  background: #005885;
}

.form-actions button[type="button"] {
  background: #eee;
  color: #333;
}

.form-actions button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.btn-add, .btn-edit, .btn-remove {
  padding: 8px 15px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  margin-right: 10px;
}

.btn-add {
  background: #0077b5;
  color: white;
}

.btn-edit {
  background: #2196f3;
  color: white;
}

.btn-remove {
  background: #f44336;
  color: white;
}

.no-profile {
  text-align: center;
  color: #666;
  padding: 40px 20px;
}
```

---

## Testing the Implementation

### 1. Test Backend LinkedIn Validation

```bash
curl -X POST http://localhost:3001/api/linkedin/validate \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.linkedin.com/in/john-doe-123"
  }'
```

### 2. Test LinkedIn Attachment

```bash
curl -X POST http://localhost:3001/api/linkedin/attach \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "candidateId": "candidate123",
    "linkedinUrl": "https://www.linkedin.com/in/john-doe-123",
    "extractData": true
  }'
```

### 3. Retrieve LinkedIn Profile

```bash
curl http://localhost:3001/api/linkedin/candidate123 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Next Steps (Phase 2)

When ready for auto-detection:

1. Integrate web search API (SerpAPI or Bing)
2. Use `LinkedInMatcher.build_search_query()` to generate search
3. Score results using `LinkedInMatcher.score_result()`
4. Show top 3 candidates to user for confirmation
5. Store only confirmed matches

---

## Important Notes

✅ **Manual entry first** - Respects user consent
✅ **CV as source of truth** - Preserve extracted data
✅ **Audit logging** - Track all LinkedIn additions
✅ **No scraping** - Use official API or approved third-party service
✅ **User verification** - Always let candidate confirm
✅ **Data privacy** - Don't auto-enrich without permission

---

## Files Created

- `Backend/server/AI/linkedin_matcher.py` - LinkedIn matching logic
- `Backend/server/AI/profile_enrichment.py` - Profile enrichment logic  
- `Backend/server/AI/linkedin_routes.py` - Flask routes
- `Backend/server/routes/linkedinRoute.js` - Express routes
- `Frontend/src/components/LinkedInProfileSection.jsx` - React component
- `Frontend/src/components/LinkedInProfileSection.css` - Component styles
- `Backend/server/models/LinkedInAuditLog.js` - Audit logging model

---

**Status**: Phase 1 (Manual entry) - Ready for implementation  
**Last Updated**: March 2026
