const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const jwtSecret = (() => {
    if (process.env.JWT_SECRET && String(process.env.JWT_SECRET).trim()) {
        return String(process.env.JWT_SECRET).trim();
    }

    // Fallback: derive a deterministic secret from DATABASE_URL so tokens remain valid across restarts
    // even if the hosting platform doesn't set JWT_SECRET.
    if (process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()) {
        return crypto.createHash('sha256').update(String(process.env.DATABASE_URL)).digest('hex');
    }

    // Last resort (dev only): random secret.
    return crypto.randomBytes(32).toString('hex');
})();
const accessTtlSeconds = Number.parseInt(process.env.JWT_ACCESS_TTL_SECONDS || '86400', 10); // 24h

function looksLikeBcryptHash(value) {
    return typeof value === 'string' && value.startsWith('$2');
}

async function hashPassword(plainText) {
    const password = String(plainText || '');
    if (!password) throw new Error('Password is required');
    return bcrypt.hash(password, 10);
}

async function verifyPassword(storedPassword, candidatePassword) {
    const stored = storedPassword === null || storedPassword === undefined ? '' : String(storedPassword);
    const candidate = candidatePassword === null || candidatePassword === undefined ? '' : String(candidatePassword);

    if (!stored || !candidate) return false;

    if (looksLikeBcryptHash(stored)) {
        return bcrypt.compare(candidate, stored);
    }

    return stored === candidate;
}

function signAccessToken(claims) {
    if (!claims || !claims.sub) {
        throw new Error('JWT claims must include sub');
    }

    return jwt.sign(claims, jwtSecret, {
        algorithm: 'HS256',
        expiresIn: accessTtlSeconds
    });
}

function verifyAccessToken(token) {
    const raw = token === null || token === undefined ? '' : String(token).trim();
    if (!raw) {
        throw new Error('Missing token');
    }
    return jwt.verify(raw, jwtSecret);
}

function getBearerToken(req) {
    const header = req.headers?.authorization || req.headers?.Authorization;
    if (!header) return null;
    const value = String(header).trim();
    if (!value.toLowerCase().startsWith('bearer ')) return null;
    return value.slice(7).trim() || null;
}

function authMiddleware(req, res, next) {
    const token = getBearerToken(req);
    if (!token) {
        req.auth = null;
        return next();
    }

    try {
        const payload = jwt.verify(token, jwtSecret);
        req.auth = payload;
        return next();
    } catch (err) {
        req.auth = null;
        return next();
    }
}

function requireAuth(req, res, next) {
    if (!req.auth) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    return next();
}

function requireRole(...roles) {
    const allowed = new Set((roles || []).flat().map(r => String(r).toLowerCase()));

    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        const role = String(req.auth.role || '').toLowerCase();
        if (!allowed.has(role)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        return next();
    };
}

module.exports = {
    looksLikeBcryptHash,
    hashPassword,
    verifyPassword,
    signAccessToken,
    verifyAccessToken,
    authMiddleware,
    requireAuth,
    requireRole
};
