const jwt = require('jsonwebtoken');

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

module.exports = { verifyToken };