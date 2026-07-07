const jwt = require('jsonwebtoken');
const { UserModel } = require('../models/user');

const JWT_SECRET = process.env.JWT_SECRET_KEY || process.env.JWT_SECRET;

const verifyToken = (req, res, next) => {
    try {
        if (!JWT_SECRET) {
            return res.status(500).json({ message: 'JWT secret is not configured' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Authorization token required' });
        }

        const token = authHeader.split(' ')[1];
        if (!token || typeof token !== 'string') {
            return res.status(401).json({ message: 'Invalid authorization token' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
            _id: decoded.id || decoded._id,
            role: decoded.role,
            email: decoded.email,
        };

        if (!req.user._id) {
            return res.status(401).json({ message: 'Invalid token payload' });
        }

        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
};

/**
 * Require the caller to have role = 'ENTERPRISE'.
 *
 * The legacy jwt.sign calls in this codebase signed { id, email } only — no
 * role field — so older tokens (and any token issued before the role-in-JWT
 * change) won't have req.user.role set. We fall back to a DB lookup in that
 * case so existing sessions keep working without forcing a re-login.
 *
 * Must run after verifyToken so req.user._id is populated.
 */
const requireEnterprise = async (req, res, next) => {
    try {
        // Fast path — new tokens carry role directly.
        if (req.user?.role === 'ENTERPRISE') {
            return next();
        }
        if (!req.user?._id) {
            return res.status(403).json({ message: 'Enterprise role required' });
        }
        // Fallback for older tokens missing role.
        const user = await UserModel.findById(req.user._id).select('role').lean();
        if (!user || user.role !== 'ENTERPRISE') {
            return res.status(403).json({ message: 'Enterprise role required' });
        }
        // Cache so downstream middleware/handlers don't re-query.
        req.user.role = user.role;
        return next();
    } catch (err) {
        console.error('requireEnterprise lookup failed:', err);
        return res.status(500).json({ message: 'Server error' });
    }
};

/**
 * Require the caller to have role = 'CANDIDATE'.
 *
 * Mirrors requireEnterprise: falls back to a DB lookup for legacy tokens
 * that don't carry a role claim, so existing candidate sessions keep
 * working without forcing a re-login.
 *
 * Must run after verifyToken so req.user._id is populated.
 */
const requireCandidate = async (req, res, next) => {
    try {
        if (req.user?.role === 'CANDIDATE') return next();
        if (!req.user?._id) return res.status(403).json({ message: 'Candidate role required' });
        const user = await UserModel.findById(req.user._id).select('role').lean();
        if (!user || user.role !== 'CANDIDATE') {
            return res.status(403).json({ message: 'Candidate role required' });
        }
        req.user.role = user.role;
        return next();
    } catch (err) {
        console.error('requireCandidate lookup failed:', err);
        return res.status(500).json({ message: 'Server error' });
    }
};

module.exports = { verifyToken, requireEnterprise, requireCandidate };