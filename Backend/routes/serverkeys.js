'use strict';

const express = require('express');
const router  = express.Router();
const {
    serverApiKeys, apiKeyRegenCooldowns, liveServers,
    activeAdmins, commandsQueue, generateServerApiKey, pushAuditLog
} = require('../state');
const { verifyOwnerAccess, verifyRobloxToken } = require('../middleware/auth');

const REGEN_COOLDOWN = 15 * 60 * 1000; // 15 minutes

/** GET current key info (masked) — owner only, never shown to admins/mods */
router.get('/:serverCode', verifyOwnerAccess, (req, res) => {
    const { serverCode } = req.params;

    const keyInfo = serverApiKeys[serverCode];
    if (!keyInfo) {
        const newKey = generateServerApiKey();
        serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };
        return res.json({
            maskedKey: maskKey(newKey),
            fullKey: newKey,
            generatedAt: serverApiKeys[serverCode].generatedAt,
            cooldownUntil: null
        });
    }

    const cooldown = apiKeyRegenCooldowns[serverCode];
    res.json({
        maskedKey: maskKey(keyInfo.key),
        fullKey: keyInfo.key,
        generatedAt: keyInfo.generatedAt,
        cooldownUntil: cooldown && cooldown > Date.now() ? cooldown : null
    });
});

function maskKey(key) {
    const parts = key.split('-');
    if (parts.length < 3) return key.replace(/./g, '*');
    return parts.map((p, i) => (i === 0 || i === parts.length - 1) ? p : p.replace(/./g, '*')).join('-');
}

/** POST — regenerate key from the dashboard (owner only, 15min cooldown).
 *  This is purely the server-identification key used alongside every heartbeat/
 *  position packet — it is NOT what authenticates Roblox-to-API traffic (that's
 *  the fixed API_TOKEN, restored — see middleware/auth.js). Regenerating just
 *  means the old identifier stops being recognized as this server; the live
 *  Roblox server is notified immediately via a queued command so it can adopt
 *  the new one on its next heartbeat instead of getting rejected. */
router.post('/:serverCode/regenerate', verifyOwnerAccess, (req, res) => {
    const { serverCode } = req.params;
    const userId = req.adminId;

    const cooldown = apiKeyRegenCooldowns[serverCode];
    if (cooldown && cooldown > Date.now()) {
        const remaining = Math.ceil((cooldown - Date.now()) / 1000);
        return res.status(429).json({ error: `Cooldown active`, remainingSeconds: remaining });
    }

    const newKey = generateServerApiKey();
    serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };
    apiKeyRegenCooldowns[serverCode] = Date.now() + REGEN_COOLDOWN;

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'api_key_changed',
        newKey,
        issuedAt: Date.now()
    });

    const admin = activeAdmins[userId];
    pushAuditLog(serverCode, {
        type: 'api_key_regenerated',
        actorId: userId,
        actorUsername: admin?.username || 'Owner'
    });

    res.json({ success: true, cooldownUntil: apiKeyRegenCooldowns[serverCode] });
});

/** POST — Roblox module registers/rotates its own identification key.
 *  Protected by the fixed API_TOKEN (same as every other Roblox-origin call) —
 *  not by matching an old key, since the API_TOKEN is already the real proof
 *  this request comes from a legitimate Roblox server.
 *  body: { newKey } */
router.post('/:serverCode/rotate-key', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { newKey } = req.body;
    if (!newKey) return res.status(400).json({ error: 'newKey required' });

    const isFirstRegistration = !serverApiKeys[serverCode];
    serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };

    if (!isFirstRegistration) {
        pushAuditLog(serverCode, { type: 'api_key_rotated', source: 'roblox' });
    }

    res.json({ success: true, registered: isFirstRegistration });
});

module.exports = router;
