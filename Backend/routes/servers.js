'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const router  = express.Router();
const {
    liveServers, commandsQueue, scheduledShutdowns,
    activeAdmins, serverMeta, auditLogs, sessionChat,
    serverLocations, getOrInitServer, pushAuditLog,
    adminRoster, serverStaff, getServerStaff, dutyCooldowns,
    hourlyServerStats, MAX_HOURLY_ENTRIES, shiftHistory, pushShiftHistory
} = require('../state');
const { verifyRobloxToken, verifyServerApiKey, verifyAdminAccess, verifyOnDuty, smartRateLimiter, getUserRole } = require('../middleware/auth');

const DUTY_COOLDOWN_MS = 2000; // anti-spam on start/break/stop shift buttons
const RANGE_MS = { '24h': 24 * 3600000, '3d': 3 * 24 * 3600000, 'week': 7 * 24 * 3600000 };

/* ============================================================
   STATIC-PATH ROUTES FIRST.
   IMPORTANT: these must be registered BEFORE any "/:serverCode"
   pattern route below — Express matches routes in registration
   order, and "/:serverCode" happily matches literal paths like
   "/staff" or "/list" too (with serverCode = "staff"). Previously
   /staff and /staff-activity were declared AFTER /:serverCode,
   so they were completely unreachable (every request to them was
   silently swallowed by the detail route returning 404). Keep
   every new static route up here, not mixed in further down.
============================================================ */

/** ─── SERVER LIST (dashboard: online servers I can moderate) ─── */
router.get('/list', verifyAdminAccess, (req, res) => {
    const userId = req.adminId;
    const now = Date.now();

    const list = Object.values(liveServers)
        .filter(s => {
            const role = getUserRole(userId, s.serverCode);
            if (adminRoster.globalAdmins.has(userId)) return true;
            if (role === 'owner' || role === 'mod') return true;
            return false;
        })
        .map(s => ({
            serverCode: s.serverCode,
            serverName: serverMeta[s.serverCode]?.name || s.serverName || 'Unnamed Server',
            joinCode: serverMeta[s.serverCode]?.joinCode || s.joinCode || '',
            totalPlayers: s.totalPlayers,
            startTime: s.startTime,
            uptime: Math.floor((now - s.startTime) / 1000)
        }));

    res.json({ servers: list });
});

/** ─── DUTY MANAGEMENT ─── */
router.post('/duty', verifyAdminAccess, (req, res) => {
    const { username, action, serverCode } = req.body;
    const userId = req.adminId;
    const now    = Date.now();

    const lastAction = dutyCooldowns[userId] || 0;
    if (now - lastAction < DUTY_COOLDOWN_MS) {
        return res.status(429).json({
            error: 'Please wait before doing that again',
            remainingMs: DUTY_COOLDOWN_MS - (now - lastAction)
        });
    }

    const role = getUserRole(userId, serverCode);

    if (!activeAdmins[userId]) {
        activeAdmins[userId] = {
            userId, username, role,
            status: 'Online', serverCode: null,
            updatedAt: new Date().toISOString(),
            lastSeen: now,
            breakAccumulated: 0,
            punishmentsThisShift: 0
        };
    }
    const admin = activeAdmins[userId];
    admin.lastSeen = now;
    admin.username = username || admin.username;
    admin.role = role;

    if (action === 'start') {
        if (!serverCode) return res.status(400).json({ error: 'Server code required' });
        if (!liveServers[serverCode]) return res.status(404).json({ error: 'Server is offline' });

        const server = liveServers[serverCode];
        const isInServer = server.players.some(p => p.userId === userId);
        if (!isInServer) {
            return res.status(403).json({ error: 'You must be inside the server to start a shift' });
        }

        // Resuming from a break: fold the break duration into the running total
        // instead of losing it, so shift history reports accurate break time.
        if (admin.status === 'break' && admin.breakStart) {
            admin.breakAccumulated = (admin.breakAccumulated || 0) + Math.floor((now - admin.breakStart) / 1000);
            admin.breakStart = null;
        }

        dutyCooldowns[userId] = now;
        admin.status     = 'on_duty';
        admin.serverCode = serverCode;
        admin.updatedAt  = new Date().toISOString();
        if (!admin.shiftStart) {
            admin.shiftStart = now;
            admin.breakAccumulated = 0;
            admin.punishmentsThisShift = 0;
        }
        return res.json({ success: true, status: 'on_duty' });
    }

    if (action === 'break') {
        if (admin.status !== 'on_duty') {
            return res.status(400).json({ error: 'You must be on duty to take a break' });
        }
        dutyCooldowns[userId] = now;
        admin.status    = 'break';
        admin.updatedAt = new Date().toISOString();
        admin.breakStart = now;
        return res.json({ success: true, status: 'break' });
    }

    if (action === 'stop') {
        let breakSeconds = admin.breakAccumulated || 0;
        if (admin.status === 'break' && admin.breakStart) {
            breakSeconds += Math.floor((now - admin.breakStart) / 1000);
        }
        const totalShiftSeconds = admin.shiftStart ? Math.floor((now - admin.shiftStart) / 1000) : 0;
        const onDutySeconds = Math.max(0, totalShiftSeconds - breakSeconds);

        if (admin.shiftStart) {
            pushShiftHistory({
                userId, username: admin.username, role: admin.role,
                serverCode: admin.serverCode,
                shiftStart: admin.shiftStart,
                shiftEnd: now,
                onDutySeconds,
                breakSeconds,
                punishments: admin.punishmentsThisShift || 0
            });
        }

        dutyCooldowns[userId] = now;
        admin.status     = 'Online';
        admin.serverCode = null;
        admin.updatedAt  = new Date().toISOString();
        admin.shiftStart = null;
        admin.breakStart = null;
        admin.breakAccumulated = 0;
        admin.punishmentsThisShift = 0;
        admin.lastShiftEnd = now;
        return res.json({ success: true, status: 'Online', shiftDuration: onDutySeconds });
    }

    res.status(400).json({ error: 'Unknown action' });
});

/** ─── STAFF LIST (current online/on-duty staff — "Staff Status") ─── */
router.get('/staff', verifyAdminAccess, (req, res) => {
    const userId   = req.adminId;
    const now      = Date.now();

    if (activeAdmins[userId]) {
        activeAdmins[userId].lastSeen = now;
    }

    Object.values(activeAdmins).forEach(a => {
        if (now - a.lastSeen > 15000 && a.status !== 'Offline') {
            a.status    = 'Offline';
            a.updatedAt = new Date().toISOString();
        }
    });

    const order = { on_duty: 0, break: 1, Online: 2, Offline: 3 };
    const staff = Object.values(activeAdmins).sort((a, b) => {
        const oa = order[a.status] ?? 4;
        const ob = order[b.status] ?? 4;
        if (oa !== ob) return oa - ob;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    res.json({ staff });
});

/** ─── STAFF ACTIVITY (historical — under the Stats side-menu view) ─── */
router.get('/staff-activity', verifyAdminAccess, (req, res) => {
    const range = req.query.range || 'week';
    const cutoff = Date.now() - (RANGE_MS[range] || RANGE_MS.week);
    const now = Date.now();

    const byUser = {};

    shiftHistory.filter(s => s.shiftEnd >= cutoff).forEach(s => {
        if (!byUser[s.userId]) {
            byUser[s.userId] = { userId: s.userId, username: s.username, role: s.role, onDutySeconds: 0, breakSeconds: 0, punishments: 0, status: 'Offline', lastActive: 0 };
        }
        const u = byUser[s.userId];
        u.onDutySeconds += s.onDutySeconds;
        u.breakSeconds  += s.breakSeconds;
        u.punishments   += s.punishments;
        u.username = s.username;
        u.lastActive = Math.max(u.lastActive, s.shiftEnd);
    });

    // Fold in any shift currently in progress so live activity counts too.
    Object.values(activeAdmins).forEach(a => {
        if (!a.shiftStart) return;
        if (!byUser[a.userId]) {
            byUser[a.userId] = { userId: a.userId, username: a.username, role: a.role, onDutySeconds: 0, breakSeconds: 0, punishments: 0, status: a.status, lastActive: now };
        }
        const liveBreak = (a.breakAccumulated || 0) + (a.status === 'break' && a.breakStart ? Math.floor((now - a.breakStart) / 1000) : 0);
        const liveTotal = Math.floor((now - a.shiftStart) / 1000);
        const u = byUser[a.userId];
        u.onDutySeconds += Math.max(0, liveTotal - liveBreak);
        u.breakSeconds  += liveBreak;
        u.punishments   += (a.punishmentsThisShift || 0);
        u.status = a.status;
        u.role = a.role;
        u.lastActive = now;
    });

    const list = Object.values(byUser).sort((a, b) =>
        (b.onDutySeconds + b.punishments * 60) - (a.onDutySeconds + a.punishments * 60)
    );

    res.json({ staff: list, range });
});

/* ============================================================
   DYNAMIC "/:serverCode" ROUTES BELOW THIS LINE ONLY.
============================================================ */

/** ─── HEARTBEAT (from Roblox server) ─── */
router.post('/:serverCode/heartbeat', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { playersList, serverName, joinCode } = req.body;

    const server = getOrInitServer(serverCode);

    if (serverName && serverName !== server.serverName) {
        server.serverName = serverName;
        if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
        serverMeta[serverCode].name = serverName;
    }
    if (joinCode && joinCode !== server.joinCode) {
        server.joinCode = joinCode;
        if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
        serverMeta[serverCode].joinCode = joinCode;
    }

    let teamsCounter = {};
    if (Array.isArray(playersList)) {
        playersList.forEach(p => {
            teamsCounter[p.team] = (teamsCounter[p.team] || 0) + 1;
        });
    }

    const playerCount = Array.isArray(playersList) ? playersList.length : 0;

    let emptySince = server.emptySince || null;
    if (playerCount === 0) {
        if (!emptySince) emptySince = Date.now();
    } else {
        emptySince = null;
    }

    liveServers[serverCode] = {
        ...server,
        totalPlayers: playerCount,
        teamsSummary: teamsCounter,
        players: playersList || [],
        lastUpdated: Date.now(),
        emptySince,
        autoShutdownQueued: playerCount === 0 ? server.autoShutdownQueued : false
    };

    const pending = commandsQueue[serverCode] || [];
    commandsQueue[serverCode] = [];

    const sched = scheduledShutdowns[serverCode] || null;

    res.json({
        success: true,
        commands: pending,
        scheduledShutdown: sched ? {
            executeAt: sched.executeAt,
            formattedTime: sched.formattedTime
        } : null
    });
});

/** ─── MAP POSITION STREAMING (from Roblox) ─── */
router.post('/:serverCode/positions', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { positions } = req.body;

    if (!liveServers[serverCode]) return res.status(404).json({ error: 'Server not found' });

    if (Array.isArray(positions)) {
        positions.forEach(pos => {
            const player = liveServers[serverCode].players.find(p => p.userId === pos.userId);
            if (player) {
                player.pos = { x: pos.x, z: pos.z };
                player.teamColor = pos.teamColor;
                player.posUpdatedAt = Date.now();
            }
        });
    }

    if (typeof global.broadcastPositions === 'function') {
        global.broadcastPositions(serverCode, liveServers[serverCode].players);
    }

    res.json({ success: true });
});

/** ─── ADD LOCATION MARKER (from Roblox) ─── */
router.post('/:serverCode/addlocation', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { locationName, LocationPosition, Text } = req.body;

    if (!locationName) return res.status(400).json({ error: 'locationName required' });

    const imgDir = path.join(__dirname, '..', '..', 'img');
    const iconFile = `${locationName}.png`;
    const hasIcon = fs.existsSync(path.join(imgDir, iconFile));

    if (!serverLocations[serverCode]) serverLocations[serverCode] = [];
    serverLocations[serverCode].push({
        name: locationName,
        positions: LocationPosition,
        text: Text || null,
        hasIcon,
        iconUrl: hasIcon ? `/img/${iconFile}` : null,
        addedAt: Date.now()
    });

    res.json({ success: true, hasIcon });
});

/** ─── GET LOCATIONS ─── */
router.get('/:serverCode/locations', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    res.json({ locations: serverLocations[serverCode] || [] });
});

/** ─── SERVER DETAIL ─── */
router.get('/:serverCode', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found or offline' });

    const sched = scheduledShutdowns[serverCode] || null;
    res.json({
        ...server,
        serverName: serverMeta[serverCode]?.name || server.serverName || 'Unnamed Server',
        joinCode: serverMeta[serverCode]?.joinCode || server.joinCode || '',
        uptime: Math.floor((Date.now() - server.startTime) / 1000),
        scheduledShutdown: sched ? { timestamp: sched.executeAt, formattedTime: sched.formattedTime } : null
    });
});

/** ─── PLAYER LIST ─── */
router.get('/:serverCode/players', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const playersWithRole = server.players.map(p => ({
        ...p,
        role: getUserRole(p.userId, serverCode)
    }));

    res.json({
        players: playersWithRole,
        totalPlayers: server.totalPlayers,
        serverName: serverMeta[serverCode]?.name || server.serverName || 'Unnamed Server',
        joinCode: serverMeta[serverCode]?.joinCode || server.joinCode || '',
        startTime: server.startTime,
        uptime: Math.floor((Date.now() - server.startTime) / 1000),
        teamsSummary: server.teamsSummary,
        scheduledShutdown: scheduledShutdowns[serverCode]
            ? { timestamp: scheduledShutdowns[serverCode].executeAt } : null,
        locations: serverLocations[serverCode] || []
    });
});

/** ─── SINGLE PLAYER ─── */
router.get('/:serverCode/players/:playerId', verifyAdminAccess, (req, res) => {
    const { serverCode, playerId } = req.params;
    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const player = server.players.find(
        p => String(p.userId) === String(playerId) || p.name === playerId
    );
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json(player);
});

/** ─── SERVER STATS (busiest days / peak hours — under the Stats side-menu view) ─── */
router.get('/:serverCode/stats', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const range = req.query.range || 'week';
    const cutoff = Date.now() - (RANGE_MS[range] || RANGE_MS.week);

    const hourly = (hourlyServerStats[serverCode] || []).filter(h => h.hourStart >= cutoff);

    const summarize = (points) => {
        if (!points.length) return { busiest: null, peakOverall: 0 };
        const busiest = points.reduce((a, b) => (b.avgPlayers > a.avgPlayers ? b : a));
        const peakOverall = Math.max(...points.map(p => p.peakPlayers));
        return { busiest: busiest.label, peakOverall };
    };

    if (range === '24h') {
        const points = hourly.map(h => ({
            label: h.hourStart,
            avgPlayers: h.playerSampleCount ? +(h.playerSampleSum / h.playerSampleCount).toFixed(1) : 0,
            peakPlayers: h.peakPlayers
        }));
        return res.json({ granularity: 'hour', points, ...summarize(points) });
    }

    const byDate = {};
    hourly.forEach(h => {
        const dateKey = new Date(h.hourStart).toISOString().slice(0, 10);
        if (!byDate[dateKey]) byDate[dateKey] = { sum: 0, count: 0, peak: 0 };
        byDate[dateKey].sum += h.playerSampleSum;
        byDate[dateKey].count += h.playerSampleCount;
        byDate[dateKey].peak = Math.max(byDate[dateKey].peak, h.peakPlayers);
    });
    const points = Object.entries(byDate)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, v]) => ({
            label: date,
            avgPlayers: v.count ? +(v.sum / v.count).toFixed(1) : 0,
            peakPlayers: v.peak
        }));

    res.json({ granularity: 'day', points, ...summarize(points) });
});

/** ─── SCHEDULE SHUTDOWN ─── */
router.post('/:serverCode/schedule-shutdown', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const { targetTimestamp } = req.body;

    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    const ts = parseInt(targetTimestamp);
    if (!ts || ts <= Date.now()) {
        return res.status(400).json({ error: 'Please select a valid future time' });
    }

    const d = new Date(ts);
    const formattedTime = d.toISOString();

    scheduledShutdowns[serverCode] = {
        executeAt: ts,
        formattedTime,
        senderId: req.adminId,
        senderName: admin.username
    };

    pushAuditLog(serverCode, {
        type: 'scheduled_shutdown',
        actorId: req.adminId,
        actorUsername: admin.username,
        executeAt: ts,
        formattedTime
    });

    res.json({ success: true, executeAt: ts, formattedTime });
});

/** ─── CANCEL SCHEDULED SHUTDOWN ─── */
router.delete('/:serverCode/schedule-shutdown', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    if (!scheduledShutdowns[serverCode]) {
        return res.status(404).json({ error: 'No scheduled shutdown found' });
    }
    delete scheduledShutdowns[serverCode];
    res.json({ success: true });
});

/** ─── LOCK / UNLOCK SERVER ─── */
router.post('/:serverCode/lock', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'lock_request',
        senderId: req.adminId,
        senderName: admin.username,
        issuedAt: Date.now()
    });

    pushAuditLog(serverCode, { type: 'server_lock', actorId: req.adminId, actorUsername: admin.username });
    res.json({ success: true });
});

router.post('/:serverCode/unlock', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'unlock_request',
        senderId: req.adminId,
        senderName: admin.username,
        issuedAt: Date.now()
    });

    pushAuditLog(serverCode, { type: 'server_unlock', actorId: req.adminId, actorUsername: admin.username });
    res.json({ success: true });
});

/** ─── DELETE SERVER (server shutdown signal from Roblox) ─── */
router.delete('/:serverCode', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    delete liveServers[serverCode];
    delete commandsQueue[serverCode];
    delete scheduledShutdowns[serverCode];
    delete sessionChat[serverCode];
    delete serverLocations[serverCode];

    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode === serverCode) {
            admin.status = 'Online';
            admin.serverCode = null;
            admin.updatedAt = new Date().toISOString();
        }
    });

    res.json({ success: true });
});

/** ─── UPDATE SERVER NAME / JOIN CODE (from Roblox module) ─── */
router.post('/:serverCode/meta', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { name, joinCode, ownerId } = req.body;
    if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
    if (name)     serverMeta[serverCode].name     = name;
    if (joinCode) serverMeta[serverCode].joinCode  = joinCode;
    if (ownerId) {
        serverMeta[serverCode].ownerId = ownerId;
        getServerStaff(serverCode).ownerId = parseInt(ownerId);
    }
    if (liveServers[serverCode]) {
        if (name)     liveServers[serverCode].serverName = name;
        if (joinCode) liveServers[serverCode].joinCode   = joinCode;
    }
    res.json({ success: true });
});

/** ─── SEND COMMAND (from dashboard) ─── */
router.post('/:serverCode/commands', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    let { action, target, targetId, targetUsername, reason, duration, newHealth, maxHealth } = req.body;
    const admin = activeAdmins[req.adminId];

    if (!action) return res.status(400).json({ error: 'Action required' });

    const dutyOnly = ['kick', 'ban', 'freeze', 'unfreeze', 'bring', 'to', 'shutdown', 'warn', 'message', 'health', 'lock', 'unlock'];
    if (dutyOnly.includes(action) && (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode)) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    if (action === 'message' || action === 'health') {
        if (!target) target = '@everyone';
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    const cmd = {
        action, target, targetId, targetUsername,
        reason, duration,
        senderId: req.adminId,
        senderName: admin?.username || 'Unknown',
        issuedAt: Date.now()
    };

    if (action === 'health') {
        cmd.newHealth = (newHealth === undefined || newHealth === null || newHealth === '') ? null : Number(newHealth);
        cmd.maxHealth = (maxHealth === undefined || maxHealth === null || maxHealth === '') ? null : Number(maxHealth);
    }

    commandsQueue[serverCode].push(cmd);

    const punishmentCmds = ['kick', 'ban', 'freeze', 'unfreeze', 'warn', 'unwarn'];
    if (punishmentCmds.includes(action) && admin) {
        const { pushSessionChat } = require('../state');
        pushSessionChat(serverCode, {
            type: 'system',
            text: `${admin.username} executed ${action} on ${target || targetUsername || 'target'}`,
            senderId: req.adminId,
            senderName: admin.username,
            timestamp: Date.now(),
            commandRef: action
        });
    }

    res.json({ success: true });
});

/** ─── SESSION CHAT ─── */
router.get('/:serverCode/chat', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    res.json({ messages: sessionChat[serverCode] || [] });
});

router.post('/:serverCode/chat', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const { message } = req.body;
    const admin = activeAdmins[req.adminId];

    if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: 'Empty message' });
    }
    if (message.trim().length > 300) {
        return res.status(400).json({ error: 'Message too long' });
    }

    const { pushSessionChat } = require('../state');
    const msg = {
        type: 'message',
        text: message.trim(),
        senderId: req.adminId,
        senderName: admin?.username || 'Unknown',
        senderRole: getUserRole(req.adminId, serverCode),
        timestamp: Date.now()
    };
    pushSessionChat(serverCode, msg);
    res.json({ success: true, message: msg });
});

/** ─── UPDATE ADMINS (UpdateAdmins — from Roblox module) ─── */
router.post('/:serverCode/admins', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { admins, mods, adminIds } = req.body;

    const newAdmins = Array.isArray(admins) ? admins.map(Number) : null;
    const newMods   = Array.isArray(mods) ? mods.map(Number)
                     : Array.isArray(adminIds) ? adminIds.map(Number)
                     : null;

    if (newAdmins) adminRoster.globalAdmins = new Set(newAdmins);
    if (newMods)   getServerStaff(serverCode).mods = new Set(newMods);

    const staff = getServerStaff(serverCode);
    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode !== serverCode) return;
        const stillAuthorized = adminRoster.globalAdmins.has(admin.userId)
            || staff.mods.has(admin.userId)
            || staff.ownerId === admin.userId;
        if (!stillAuthorized) {
            admin.status     = 'Online';
            admin.serverCode = null;
            admin.updatedAt  = new Date().toISOString();
            admin.permissionsRevoked = true;
            admin.permissionsRevokedAt = Date.now();
        }
    });

    res.json({ success: true });
});

/** ─── SET OWNER (SetOwner — from Roblox module) ─── */
router.post('/:serverCode/owner', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { ownerId } = req.body;
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

    getServerStaff(serverCode).ownerId = parseInt(ownerId);
    if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
    serverMeta[serverCode].ownerId = parseInt(ownerId);

    res.json({ success: true });
});

// ─── SAMPLER: record hourly player-count snapshots for Server Stats ───
setInterval(() => {
    const now = Date.now();
    const hourStart = Math.floor(now / 3600000) * 3600000;
    Object.keys(liveServers).forEach(serverCode => {
        const server = liveServers[serverCode];
        if (!hourlyServerStats[serverCode]) hourlyServerStats[serverCode] = [];
        const arr = hourlyServerStats[serverCode];
        let bucket = arr[arr.length - 1];
        if (!bucket || bucket.hourStart !== hourStart) {
            bucket = { hourStart, playerSampleSum: 0, playerSampleCount: 0, peakPlayers: 0 };
            arr.push(bucket);
            if (arr.length > MAX_HOURLY_ENTRIES) arr.shift();
        }
        bucket.playerSampleSum += server.totalPlayers;
        bucket.playerSampleCount += 1;
        bucket.peakPlayers = Math.max(bucket.peakPlayers, server.totalPlayers);
    });
}, 60000);

// ─── CLEANUP: remove stale servers, finalize empty-server auto-shutdown, fire scheduled shutdowns ───
setInterval(() => {
    const now = Date.now();
    Object.keys(liveServers).forEach(serverCode => {
        const server = liveServers[serverCode];

        if (now - server.lastUpdated > 7000) {
            delete liveServers[serverCode];
            delete commandsQueue[serverCode];
            delete scheduledShutdowns[serverCode];
            delete sessionChat[serverCode];
            delete serverLocations[serverCode];

            Object.values(activeAdmins).forEach(admin => {
                if (admin.serverCode === serverCode) {
                    admin.status = 'Online';
                    admin.serverCode = null;
                    admin.updatedAt = new Date().toISOString();
                    admin.serverWentOffline = true;
                    admin.serverWentOfflineAt = Date.now();
                }
            });
            return;
        }

        if (server.totalPlayers === 0 && server.emptySince && !server.autoShutdownQueued
            && (now - server.emptySince >= 5000)) {
            if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
            commandsQueue[serverCode].push({
                action: 'shutdown',
                reason: 'Empty server auto-shutdown',
                senderId: null,
                senderName: 'System',
                issuedAt: now
            });
            server.autoShutdownQueued = true;
        }

        if (scheduledShutdowns[serverCode] && now >= scheduledShutdowns[serverCode].executeAt) {
            if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
            commandsQueue[serverCode].push({
                action: 'shutdown',
                reason: 'Scheduled shutdown',
                senderId: scheduledShutdowns[serverCode].senderId,
                senderName: activeAdmins[scheduledShutdowns[serverCode].senderId]?.username || scheduledShutdowns[serverCode].senderName || 'System',
                issuedAt: now
            });
            delete scheduledShutdowns[serverCode];
        }
    });
}, 3000);

module.exports = router;
