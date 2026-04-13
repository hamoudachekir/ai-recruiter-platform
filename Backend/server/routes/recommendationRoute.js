const jwt = require('jsonwebtoken');
const axios = require('axios');
const express = require('express');
const router = express.Router();
const { UserModel } = require('../models/user');

const RECOMMENDATION_SERVICE_URL = 'http://127.0.0.1:5001/recommend';
const RECOMMENDATION_TIMEOUT_MS = Number(process.env.RECOMMENDATION_TIMEOUT_MS || 3000);
const RECOMMENDATION_DOWN_COOLDOWN_MS = Number(process.env.RECOMMENDATION_DOWN_COOLDOWN_MS || 15000);
const RECOMMENDATION_ERROR_LOG_THROTTLE_MS = Number(process.env.RECOMMENDATION_ERROR_LOG_THROTTLE_MS || 10000);

let recommendationDownUntil = 0;
let lastRecommendationErrorLogAt = 0;

const markRecommendationServiceDown = () => {
    recommendationDownUntil = Date.now() + RECOMMENDATION_DOWN_COOLDOWN_MS;
};

const shouldSkipRecommendationCall = () => Date.now() < recommendationDownUntil;

const shouldLogRecommendationError = () => {
    const now = Date.now();
    if (now - lastRecommendationErrorLogAt < RECOMMENDATION_ERROR_LOG_THROTTLE_MS) {
        return false;
    }
    lastRecommendationErrorLogAt = now;
    return true;
};

const isTransientRecommendationFailure = (error) => {
    const code = String(error?.code || '').toUpperCase();
    return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH'].includes(code);
};

router.get('/for-user', async(req, res) => {
    try {
        // 1. Verify JWT Token
        const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
        if (!token) {
            return res.status(401).json({ error: 'Authorization token required' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        // 2. Get recommendations from Python service with lower threshold
        if (shouldSkipRecommendationCall()) {
            return res.status(200).json([]);
        }

        let response;
        try {
            response = await axios.post(RECOMMENDATION_SERVICE_URL, {
                candidate_id: decoded.id,
                top_k: 10,
                threshold: 0.2  // Lowered from 0.3 to show more matches
            }, {
                timeout: RECOMMENDATION_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (err) {
            if (isTransientRecommendationFailure(err)) {
                markRecommendationServiceDown();
            }

            if (shouldLogRecommendationError()) {
                console.error('Recommendation service error:', err.response ? err.response.data : err.message);
            }
            return res.status(200).json([]);
        }

        // 3. Process recommendations
        const responseData = response.data;
        const recommendations = responseData.recommendations || responseData;

        if (!Array.isArray(recommendations)) {
            return res.status(200).json([]);
        }

        // 4. Collect unique enterprise IDs and fetch their data in one query
        const enterpriseIds = [...new Set(
            recommendations.map(j => j.entrepriseId).filter(Boolean)
        )];

        const enterprises = await UserModel.find(
            { _id: { $in: enterpriseIds } },
            { name: 1, picture: 1, enterprise: 1 }
        ).lean();

        const enterpriseMap = {};
        enterprises.forEach(e => { enterpriseMap[e._id.toString()] = e; });

        // 5. Transform data — attach populated enterprise object so the frontend
        //    can read job.entrepriseId.enterprise.name instead of "Unknown Company"
        const formattedRecs = recommendations.map(job => {
            const enterpriseData = enterpriseMap[job.entrepriseId?.toString()] || null;
            return {
                _id: job._id,
                title: job.title,
                description: job.description,
                location: job.location,
                salary: job.salary,
                skills: job.skills || [],
                languages: job.languages || [],
                entrepriseId: enterpriseData || job.entrepriseId || null,
                match_score: job.match_score,
                createdAt: job.createdAt
            };
        });

        res.json(formattedRecs);

    } catch (error) {
        console.error('Recommendation error:', error.message);
        res.status(200).json([]);
    }
});

// Force refresh the AI job index
router.post('/refresh-index', async(req, res) => {
    try {
        const response = await axios.post('http://127.0.0.1:5001/refresh-index', {}, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });

        res.json({
            success: true,
            message: response.data.message || 'Job index refreshed successfully'
        });
    } catch (error) {
        console.error('Refresh index error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to refresh job index',
            details: error.message
        });
    }
});

module.exports = router;
