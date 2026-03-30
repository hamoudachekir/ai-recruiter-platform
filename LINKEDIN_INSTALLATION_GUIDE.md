/**
 * LINKEDIN INTEGRATION INSTALLATION GUIDE
 * 
 * This guide explains how to integrate all LinkedIn components
 * into your existing project.
 */

# LinkedIn Integration - Installation & Setup

## ✅ COMPLETED COMPONENTS

### 1. Frontend React Components
- **File**: `Frontend/src/components/LinkedInSection.jsx` ✅ Created
- **File**: `Frontend/src/components/LinkedInSection.css` ✅ Created
- **Integrated into**: `Frontend/src/profileFront/EditProfile.jsx` ✅ Updated
  - Import added
  - LinkedinData state added
  - Component rendered in the form

### 2. Backend Python Modules
- **File**: `Backend/server/AI/linkedin_matcher.py` ✅ Created
- **File**: `Backend/server/AI/profile_enrichment.py` ✅ Created
- **File**: `Backend/server/AI/linkedin_routes.py` ✅ Created

### 3. Backend Express Routes
- **File**: `Backend/server/routes/linkedinRoute.js` ✅ Created (400+ lines)
- Routes implemented:
  - `POST /api/linkedin/save-url` - Save LinkedIn URL (Phase 1)
  - `GET /auth/linkedin/start` - Start OAuth flow
  - `GET /auth/linkedin/callback` - OAuth callback
  - `POST /api/linkedin/sync` - Sync profile data
  - `GET /api/linkedin/candidate/:candidateId` - Get LinkedIn data
  - `DELETE /api/linkedin/candidate/:candidateId` - Remove LinkedIn link

### 4. MongoDB Schema
- **File**: `Backend/server/models/linkedinSchema.js` ✅ Created
- Schema fields: url, vanityName, status, isConnected, isVerified, etc.

---

## 📋 NEXT STEPS - INTEGRATION REQUIRED

### Step 1: Update Candidate Model With LinkedIn Schema
**File**: `Backend/server/models/candidat.js`

Add this at the end of the file, before `module.exports`:

```javascript
// Add LinkedIn profile support
const linkedinSchema = require('./linkedinSchema');
CandidateSchema.add(linkedinSchema);

module.exports = mongoose.model('Candidate', CandidateSchema);
```

### Step 2: Register LinkedIn Routes in Express App
**File**: `Backend/server/index.js`

Add these lines after other route registrations (around line 50-60):

```javascript
// LinkedIn Integration Routes
const linkedinRoute = require('./routes/linkedinRoute');
app.use('/api/linkedin', linkedinRoute);
app.use('/auth/linkedin', linkedinRoute);
```

### Step 3: Set Up Environment Variables
**File**: `.env` (Root of project)

Add these:

```bash
# LinkedIn OAuth 2.0 Credentials
LINKEDIN_CLIENT_ID=your_app_id_here
LINKEDIN_CLIENT_SECRET=your_app_secret_here
LINKEDIN_REDIRECT_URI=http://localhost:3001/auth/linkedin/callback

# For production, use:
# LINKEDIN_REDIRECT_URI=https://yourappname.com/auth/linkedin/callback
```

### Step 4: Get LinkedIn OAuth Credentials
Follow these steps:

1. Go to: https://www.linkedin.com/developers/apps
2. Click "Create app"
3. Fill in details:
   - App name: "AI Recruiter Platform" (or your app name)
   - LinkedIn Page: (select or create)
   - App logo: (upload)
   - App type: "Integrated recruiting solution"
4. Accept terms and create app
5. Go to "Auth" tab:
   - Copy `Client ID` → Paste in `.env` as `LINKEDIN_CLIENT_ID`
   - Copy `Client Secret` → Paste in `.env` as `LINKEDIN_CLIENT_SECRET`
6. Add Authorized redirect URLs:
   - `http://localhost:3001/auth/linkedin/callback` (development)
   - `https://yourdomain.com/auth/linkedin/callback` (production)
7. Request access to scopes:
   - `r_liteprofile`
   - `r_basicprofile`
   - `openid`
   - `profile`
   - `email`

### Step 5: Install LinkedIn API Client (Optional - For Phase 2)
When ready for OAuth implementation:

```bash
cd Backend/server
npm install axios dotenv
```

---

## 🧪 TESTING PHASE 1 - URL STORAGE

### Test Save URL endpoint:
```bash
curl -X POST http://localhost:3001/api/linkedin/save-url \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "candidateId": "user_id_here",
    "linkedinUrl": "https://www.linkedin.com/in/john-doe"
  }'
```

### Expected Response:
```json
{
  "success": true,
  "linkedin": {
    "url": "https://www.linkedin.com/in/john-doe",
    "vanityName": "john-doe",
    "status": "url_added",
    "isConnected": false,
    "isVerified": false,
    "source": "manual_url",
    "addedAt": "2025-01-20T12:00:00Z"
  }
}
```

### Test Get LinkedIn Data:
```bash
curl -X GET http://localhost:3001/api/linkedin/candidate/user_id_here \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 🔐 SECURITY CHECKLIST

- [ ] `.env` is added to `.gitignore` (never commit secrets)
- [ ] LinkedIn credentials stored in `.env` only
- [ ] OAuth tokens will be encrypted before storage (implement in Phase 2)
- [ ] HTTPS required for production redirect URIs
- [ ] Only store minimal LinkedIn data (not full profile scrape)
- [ ] Clear data retention policy for OAuth tokens

---

## 📊 PHASE BREAKDOWN

### Phase 1: Manual URL Storage ✅ READY TO DEPLOY
- User pastes LinkedIn URL
- System validates format
- Extracts vanity name
- Stores in database
- UI displays URL with status

**Status**: Frontend component ready, backend routes ready, no OAuth needed

### Phase 2: OAuth Connection 🔲 READY FOR IMPLEMENTATION
- User clicks "Connect LinkedIn"
- Redirects to LinkedIn OAuth
- System exchanges code for token
- Fetches basic profile data
- Stores token + profile fields
- Syncs on demand

**Implementation**: Modify `linkedinRoute.js` callback to fetch LinkedIn API data

### Phase 3: Analytics & Insights 🔲 FUTURE
- Track followers count
- Recent posts analysis
- Connection quality scoring
- Profile completeness insights

**Implementation**: Add fields, implement scraping service

---

## 🗂️ FILE STRUCTURE

```
Backend/
├── server/
│   ├── models/
│   │   ├── candidat.js (UPDATE: Add linkedinSchema)
│   │   └── linkedinSchema.js (NEW ✅)
│   ├── routes/
│   │   └── linkedinRoute.js (NEW ✅)
│   ├── AI/
│   │   ├── linkedin_matcher.py (NEW ✅)
│   │   ├── profile_enrichment.py (NEW ✅)
│   │   └── linkedin_routes.py (NEW ✅)
│   └── index.js (UPDATE: Register routes)
│
Frontend/
├── src/
│   ├── components/
│   │   ├── LinkedInSection.jsx (NEW ✅)
│   │   └── LinkedInSection.css (NEW ✅)
│   └── profileFront/
│       └── EditProfile.jsx (UPDATE: Import & integrate ✅)
│
└── .env (CREATE: Add LinkedIn credentials)
```

---

## 🚀 DEPLOYMENT CHECKLIST

### Before Going Live:
- [ ] All `.env` variables configured
- [ ] LinkedIn OAuth app created & credentials saved
- [ ] MongoDB candidates collection has linkedin field
- [ ] Express app registered LinkedIn routes
- [ ] Frontend imports working without errors
- [ ] Phase 1 testing completed successfully
- [ ] HTTPS certificate ready for production
- [ ] Database backups created

### Frontend Testing:
```bash
cd Frontend
npm install react-icons # Already included in imports
npm run dev
# Navigate to profile/edit and verify LinkedIn section appears
```

### Backend Testing:
```bash
cd Backend/server
npm start
# Server should start on port 3001
# Routes available at /api/linkedin/* and /auth/linkedin/*
```

---

## 🐛 TROUBLESHOOTING

### Issue: "Module not found: LinkedInSection"
**Solution**: Check that `LinkedInSection.jsx` and `.css` are in `Frontend/src/components/`

### Issue: "LinkedIn routes not found"
**Solution**: Verify routes registered in `index.js`:
```javascript
const linkedinRoute = require('./routes/linkedinRoute');
app.use('/api/linkedin', linkedinRoute);
app.use('/auth/linkedin', linkedinRoute);
```

### Issue: "ENOENT: linkedinSchema"
**Solution**: Ensure `linkedinSchema.js` exists and is properly required in `candidat.js`

### Issue: OAuth callback returns 404
**Solution**: 
1. Check redirect URI in LinkedIn app settings matches `.env`
2. Verify route is registered in Express app
3. Check for typos in environment variables

---

## 📞 SUPPORT

For questions about implementation:
1. Review the schema in `linkedinSchema.js` for data structure
2. Check route documentation in `linkedinRoute.js` comments
3. Review component props in `LinkedInSection.jsx` comments
4. Consult LinkedIn API docs: https://docs.microsoft.com/en-us/linkedin/

---

## ✨ WHAT'S NEXT

After Phase 1 is working:

1. **Phase 2 Planning**: Update `linkedinRoute.js` callback to:
   - Exchange code for access token
   - Call LinkedIn API v2 `/me` endpoint
   - Extract: headline, role, company, photo
   - Store encrypted token

2. **Frontend Enhancement**: Add UI for OAuth connection button

3. **Testing**: Full end-to-end OAuth flow testing

4. **Phase 3 Planning**: Plan analytics features

---

**Created**: 2025-01-20
**Status**: Phase 1 Ready for Integration
**Next Review**: After Phase 1 deployment
