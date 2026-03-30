const express = require('express');
const router = express.Router();
const { enrichLinkedInProfile } = require('../controllers/linkedinEnrichController');

// POST /api/linkedin/enrich
// Body: { userId, linkedinUrl }
router.post('/enrich', enrichLinkedInProfile);

module.exports = router;
