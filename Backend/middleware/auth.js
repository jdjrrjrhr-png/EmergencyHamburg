'use strict';

const { adminRoster, serverStaff, activeAdmins, liveServers, serverApiKeys } = require('../state');

/**
 * Fixed shared secret between the Roblox module and this API — restored per
 * spec. This is the ONLY thing that authenticates a request as genuinely
 * coming from a Roblox server: events, UpdateAdmins, SetOwner, heartbeat,
 * tracking, etc. It never changes on its own and is never shown in the
 * dashboard — it lives only in .env and inside ShieldModule.lua's CONFIG.
 */
function verifyRobloxToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${process.env.ApiToken}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

/**
 * Per-server "API Key" — NOT a security boundary (verifyRobloxToken already
 * is one), just an identifying argument so the backend knows *which* server
 * a heartbeat/position packet belongs to, independent of the game.JobId or
 * the human-facing serverCode. Only shown to that server's owner in the
 * dashboard (Side Menu → API Key). Chain this AFTER verifyRobloxToken.
 *
 * - First contact for a serverCode with no stored key yet -> bootstraps.
 * - Mismatch is rejected (this is what makes "regenerate" from the dashboard
 *   actually mean something — the old key stops identifying that server).
 */
function verifyServerApiKey(req, res, next) {
    const serverCode = req.params.serverCode || req.body?.serverCode;
    const presented  = req.body?.apiKey;
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });
    if (!presented)  return res.status(400).json({ error: 'apiKey required' });

    const stored = serverApiKeys[serverCode];
    if (!stored) {
        serverApiKeys[serverCode] = { key: presented, generatedAt: Date.now() };
        return next();
    }
    if (presented !== stored.key) {
        return res.status(401).json({ error: 'apiKey does not match this server — it may have been regenerated from the dashboard' });
    }
    next();
}

/** Verify that the caller is a known admin via userId in body/query (dashboard calls) */
function verifyAdminAccess(req, res, next) {
    const userId = parseInt(
        req.body?.senderId || req.body?.userId ||
        req.query?.senderId || req.query?.userId
    );
    if (!userId || isNaN(userId)) {
        return res.status(403).json({ error: 'Admin ID required' });
    }

    const isGlobalAdmin = adminRoster.globalAdmins.has(userId);
    const isAnyOwner = Object.values(serverStaff).some(s => s.ownerId === userId);
    const isAnyMod   = Object.values(serverStaff).some(s => s.mods.has(userId));

    if (!isGlobalAdmin && !isAnyOwner && !isAnyMod) {
        return res.status(403).json({ error: 'Unauthorized access' });
    }
    req.adminId = userId;
    next();
}

/**
 * Punishment-style routes are called from TWO different places that both need
 * to work: the dashboard (a logged-in admin clicking Ban/Kick/Warn) AND the
 * Roblox module directly (Shield.Ban/Kick/Warn/FreezeToggle, e.g. from an
 * in-game admin command). Accept either: a valid API_TOKEN means "trust the
 * responsible/actor fields the Roblox module is sending"; otherwise fall back
 * to normal dashboard admin verification.
 */
function verifyAdminOrRoblox(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader === `Bearer ${process.env.ApiToken}`) {
        req.isRobloxCall = true;
        req.adminId = parseInt(req.body?.responsibleId || req.body?.senderId || req.body?.userId) || null;
        return next();
    }
    return verifyAdminAccess(req, res, next);
}

/** Verify server owner only — scoped to the serverCode in the request */
function verifyOwnerAccess(req, res, next) {
    const serverCode = req.params.serverCode || req.body?.serverCode;
    const userId = parseInt(
        req.body?.senderId || req.body?.userId ||
        req.query?.senderId || req.query?.userId
    );
    const staff = serverCode ? serverStaff[serverCode] : null;
    if (!userId || !staff || staff.ownerId !== userId) {
        return res.status(403).json({ error: 'Owner access required' });
    }
    req.adminId = userId;
    next();
}

/** Verify the admin is on duty in the target server */
function verifyOnDuty(req, res, next) {
    const serverCode = req.params.serverCode || req.body?.serverCode;
    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }
    next();
}

/** Rate limiter: 45 requests per 10 seconds per IP */
const rateLimits = {};
function smartRateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const now = Date.now();
    if (!rateLimits[ip]) rateLimits[ip] = [];
    rateLimits[ip] = rateLimits[ip].filter(t => now - t < 10000);
    if (rateLimits[ip].length > 45) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    rateLimits[ip].push(now);
    next();
}

/** Clean up rate limit entries older than 30s */
setInterval(() => {
    const now = Date.now();
    Object.keys(rateLimits).forEach(ip => {
        rateLimits[ip] = rateLimits[ip].filter(t => now - t < 30000);
        if (rateLimits[ip].length === 0) delete rateLimits[ip];
    });
}, 30000);

/** Determine role for a userId. Pass serverCode to resolve server-scoped owner/mod correctly. */
function getUserRole(userId, serverCode) {
    const id = parseInt(userId);

    if (serverCode) {
        const staff = serverStaff[serverCode];
        if (staff && staff.ownerId === id) return 'owner';
        if (staff && staff.mods.has(id)) return 'mod';
    }

    if (Object.values(serverStaff).some(s => s.ownerId === id)) return 'owner';
    if (adminRoster.globalAdmins.has(id)) return 'admin';
    if (Object.values(serverStaff).some(s => s.mods.has(id))) return 'mod';
    return 'user';
}

module.exports = {
    verifyRobloxToken,
    verifyServerApiKey,
    verifyAdminAccess,
    verifyAdminOrRoblox,
    verifyOwnerAccess,
    verifyOnDuty,
    smartRateLimiter,
    getUserRole
};
