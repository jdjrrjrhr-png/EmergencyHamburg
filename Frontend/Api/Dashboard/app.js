// App State
const AppState = {
    user: null, // { id, username }
    servers: [],
    currentServer: null,
    config: { mapMinPlayers: 10, refreshCooldownSeconds: 10 },
    pollingInterval: null,
    mapPollingInterval: null,
    route: window.location.hash || '#/',
};

// Icon map for nav / audit entries
const NAV_ICONS = {
    overview: 'layout-dashboard',
    players: 'users',
    map: 'map',
    audit: 'history',
    chat: 'message-square',
    punishments: 'gavel',
    staff: 'shield-check',
    apikey: 'key-round',
    teams: 'users-round',
};

const AUDIT_ICONS = {
    ban: 'hammer',
    freeze: 'snowflake',
    join: 'log-in',
};

// API Wrapper
async function api(method, endpoint, body) {
    const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    try {
        const res = await fetch(endpoint, opts);
        if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
        return await res.json();
    } catch (e) {
        showToast(e.message, 'error');
        throw e;
    }
}

// Router & Init
async function initApp() {
    window.addEventListener('hashchange', () => {
        AppState.route = window.location.hash || '#/';
        closeSidebarDrawer();
        renderApp();
    });

    // Mock user for testing, in real app would fetch /api/auth/me
    AppState.user = { id: 1, username: 'TestUser' };

    // Setup global event delegation
    document.addEventListener('click', handleGlobalClick);
    window.addEventListener('resize', () => {
        if (window.innerWidth > 900) closeSidebarDrawer();
    });

    renderApp();
}

// Global Event Handler
function handleGlobalClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const payload = target.dataset.payload;

    switch (action) {
        case 'nav':
            window.location.hash = payload;
            break;
        case 'toggle-menu':
            const menu = document.getElementById(payload);
            if (menu) menu.classList.toggle('active');
            break;
        case 'toggle-sidebar':
            toggleSidebarDrawer();
            break;
        case 'close-sidebar':
            closeSidebarDrawer();
            break;
        case 'open-modal':
            openModal(payload);
            break;
        case 'close-modal':
            closeModal();
            break;
        case 'player-action':
            handlePlayerAction(payload, target.dataset.userId);
            break;
        case 'server-action':
            handleServerAction(payload);
            break;
    }
}

// UI Utilities
function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const icons = { success: 'circle-check', error: 'circle-alert', info: 'info', warning: 'triangle-alert' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i data-lucide="${icons[type] || 'info'}" style="width:16px;height:16px;flex-shrink:0;"></i><span>${message}</span>`;
    container.appendChild(toast);
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function openModal(modalId) {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
}

function closeModal() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
}

function toggleSidebarDrawer() {
    document.querySelector('.sidebar')?.classList.toggle('open');
    document.querySelector('.sidebar-overlay')?.classList.toggle('open');
}

function closeSidebarDrawer() {
    document.querySelector('.sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-overlay')?.classList.remove('open');
}

function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
}

// Data fetching
async function fetchServers() {
    // Mock data for UI presentation
    AppState.servers = [
        { code: 'SV123', name: 'Main Server', players: Array(15).fill({}), isPublic: false, dashboardWatching: true, ownerId: 1, admins: [2] },
        { code: 'SV456', name: 'Private Event', players: Array(5).fill({}), isPublic: false, dashboardWatching: true, ownerId: 2, admins: [1] }
    ];
    if (AppState.route.startsWith('#/server/')) {
        const code = AppState.route.split('/')[2];
        AppState.currentServer = AppState.servers.find(s => s.code === code);
    }
}

// Rendering System
async function renderApp() {
    const app = document.getElementById('app');

    if (!AppState.user) {
        app.innerHTML = renderLogin();
        refreshIcons();
        return;
    }

    await fetchServers();

    if (AppState.route === '#/') {
        app.innerHTML = renderTopbar(false) + renderServerList();
        stopPolling();
    } else if (AppState.route.startsWith('#/server/')) {
        app.innerHTML = renderTopbar(true) + renderServerView();
        startPolling();
    } else {
        app.innerHTML = renderTopbar(false) + `<div class="empty-state"><i data-lucide="ghost" class="empty-icon"></i><h2>404 Not Found</h2></div>`;
    }
    refreshIcons();
}

// Topbar (shared shell across authenticated views)
function renderTopbar(showMenuToggle) {
    return `
        <div class="topbar">
            <div class="topbar-left">
                ${showMenuToggle ? `<button class="btn btn-icon mobile-toggle" data-action="toggle-sidebar"><i data-lucide="menu"></i></button>` : ''}
                <div class="brand" data-action="nav" data-payload="#/" style="cursor:pointer;">
                    <span class="brand-mark"><i data-lucide="shield-half"></i></span>
                    <span class="brand-text">Emergency Hamburg</span>
                </div>
            </div>
            <div class="topbar-right">
                <div class="user-chip">
                    <img class="avatar avatar-sm" src="https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${AppState.user.id}&size=48x48&format=Png">
                    <span>${AppState.user.username}</span>
                </div>
            </div>
        </div>
    `;
}

// Polling System
function startPolling() {
    if (!AppState.pollingInterval) {
        AppState.pollingInterval = setInterval(async () => {
            await fetchServers();
            // Re-render current page safely if needed, or update DOM directly
            // For simplicity in this demo, we re-render the view
            const content = document.querySelector('.layout-content');
            if (content) {
                content.innerHTML = getServerPageContent();
                refreshIcons();
            }
        }, AppState.config.refreshCooldownSeconds * 1000);
    }

    // Map polling logic
    const server = AppState.currentServer;
    const isMapPage = AppState.route.endsWith('/map');

    if (isMapPage && shouldMapBeActive(server)) {
        if (!AppState.mapPollingInterval) {
            AppState.mapPollingInterval = setInterval(() => {
                // Fetch map positions
                console.log('Fetching map positions...');
            }, 5000);
        }
    } else {
        if (AppState.mapPollingInterval) {
            clearInterval(AppState.mapPollingInterval);
            AppState.mapPollingInterval = null;
        }
    }
}

function stopPolling() {
    if (AppState.pollingInterval) {
        clearInterval(AppState.pollingInterval);
        AppState.pollingInterval = null;
    }
    if (AppState.mapPollingInterval) {
        clearInterval(AppState.mapPollingInterval);
        AppState.mapPollingInterval = null;
    }
}

// Logic Helpers
function shouldMapBeActive(server) {
    if (!server) return false;
    const minPlayers = AppState.config.mapMinPlayers || 10;
    if (server.isPublic) return false;
    if ((server.players?.length || 0) < minPlayers) return false;
    if (!server.dashboardWatching) return false;
    return true;
}

function getMapDisabledReason(server) {
    if (!server) return "Server offline";
    const minPlayers = AppState.config.mapMinPlayers || 10;
    if (server.isPublic) return "Private servers only";
    if ((server.players?.length || 0) < minPlayers) return `Requires ${minPlayers}+ players`;
    if (!server.dashboardWatching) return "Dashboard not connected";
    return "";
}

function getMemberTag(userId, server) {
    if (server.ownerId == userId) return { label: 'Owner', class: 'badge-owner' };
    if (server.admins?.includes(userId)) return { label: 'Admin', class: 'badge-admin' };
    return null;
}

// Pages
function renderLogin() {
    return `
        <div class="layout-main" style="justify-content: center; align-items: center; min-height: 100vh;">
            <div class="card" style="text-align: center; max-width: 380px; width: 100%;">
                <span class="brand-mark" style="width:44px;height:44px;border-radius:12px;margin:0 auto 20px;"><i data-lucide="shield-half" style="width:22px;height:22px;"></i></span>
                <h2>Emergency Hamburg</h2>
                <p class="text-secondary" style="margin-bottom: 24px;">Sign in to manage your servers</p>
                <button class="btn btn-primary" style="width: 100%; padding: 12px;" onclick="AppState.user={id:1,username:'TestUser'};renderApp()">
                    <i data-lucide="log-in"></i> Sign in with Roblox
                </button>
            </div>
        </div>
    `;
}

function renderServerList() {
    const cards = AppState.servers.map(s => `
        <div class="server-card" data-action="nav" data-payload="#/server/${s.code}">
            <div class="server-card-header">
                <h3 class="server-name">${s.name}</h3>
                <span class="server-code">${s.code}</span>
            </div>
            <div class="text-secondary">
                <span class="status-dot online"></span> ${s.players?.length || 0} players online
            </div>
        </div>
    `).join('');

    return `
        <div class="layout-main">
            <div class="layout-content">
                <div class="page-header">
                    <h1 class="page-title">Your Servers</h1>
                </div>
                <div class="grid grid-cols-3">
                    ${cards}
                </div>
            </div>
        </div>
    `;
}

function renderServerView() {
    const server = AppState.currentServer;
    if (!server) return `<div class="empty-state"><i data-lucide="server-crash" class="empty-icon"></i>Server not found</div>`;

    const code = server.code;
    const page = AppState.route.split('/')[3] || 'overview';
    const isOwner = server.ownerId === AppState.user.id;

    return `
        <div class="layout-main">
            <div class="sidebar-overlay" data-action="close-sidebar"></div>
            <div class="sidebar">
                <div class="sidebar-header">
                    <h3>${server.name}</h3>
                    <div class="dropdown" id="server-menu-dropdown">
                        <button class="btn btn-icon" data-action="toggle-menu" data-payload="server-menu-dropdown"><i data-lucide="more-vertical"></i></button>
                        <div class="dropdown-menu">
                            <a class="dropdown-item" data-action="nav" data-payload="#/server/${code}/teams"><i data-lucide="users-round"></i> Teams</a>
                            <a class="dropdown-item" data-action="server-action" data-payload="schedule-shutdown"><i data-lucide="power"></i> Schedule Shutdown</a>
                            <a class="dropdown-item" data-action="open-modal" data-payload="modal-info"><i data-lucide="info"></i> Server Info</a>
                        </div>
                    </div>
                </div>
                <div class="sidebar-nav">
                    ${navItem('Overview', `#/server/${code}`, page === 'overview', NAV_ICONS.overview)}
                    ${navItem('Players', `#/server/${code}/players`, page === 'players', NAV_ICONS.players)}
                    ${navItem('Map', `#/server/${code}/map`, page === 'map', NAV_ICONS.map)}
                    ${navItem('Audit Log', `#/server/${code}/audit`, page === 'audit', NAV_ICONS.audit)}
                    ${navItem('Chat', `#/server/${code}/chat`, page === 'chat', NAV_ICONS.chat)}
                    ${navItem('Punishments', `#/server/${code}/punishments`, page === 'punishments', NAV_ICONS.punishments)}
                    ${navItem('Staff', `#/server/${code}/staff`, page === 'staff', NAV_ICONS.staff)}
                    ${isOwner ? navItem('API Key', `#/server/${code}/apikey`, page === 'apikey', NAV_ICONS.apikey) : ''}
                </div>
                <div class="sidebar-footer">
                    <button class="btn btn-ghost" style="width: 100%" data-action="nav" data-payload="#/"><i data-lucide="arrow-left"></i> Back to List</button>
                </div>
            </div>
            <div class="layout-content">
                ${getServerPageContent()}
            </div>
        </div>
        ${renderModals()}
    `;
}

function navItem(label, href, isActive, icon) {
    return `<a href="${href}" class="sidebar-item ${isActive ? 'active' : ''}"><i data-lucide="${icon}"></i><span>${label}</span></a>`;
}

function getServerPageContent() {
    const page = AppState.route.split('/')[3] || 'overview';
    switch (page) {
        case 'overview': return renderOverview();
        case 'players': return renderPlayers();
        case 'map': return renderMap();
        case 'audit': return renderAudit();
        case 'chat': return renderChat();
        case 'punishments': return renderPunishments();
        case 'staff': return renderStaff();
        case 'apikey': return renderApiKey();
        case 'teams': return renderTeams();
        default: return `<div class="empty-state"><i data-lucide="file-question" class="empty-icon"></i>Page not found</div>`;
    }
}

// Individual Server Pages
function renderOverview() {
    const server = AppState.currentServer;
    return `
        <div class="page-header">
            <h1 class="page-title">Overview</h1>
        </div>
        <div class="grid grid-cols-3" style="margin-bottom: 32px;">
            <div class="stat-card">
                <span class="stat-title"><i data-lucide="users"></i> Players Online</span>
                <span class="stat-value">${server.players?.length || 0}</span>
            </div>
            <div class="stat-card">
                <span class="stat-title"><i data-lucide="car"></i> Vehicles</span>
                <span class="stat-value">12</span>
            </div>
            <div class="stat-card">
                <span class="stat-title"><i data-lucide="activity"></i> Status</span>
                <span class="stat-value" style="color: var(--success)">Active</span>
            </div>
        </div>

        <h3>Recent Activity</h3>
        <div class="card" style="padding: 0;">
            <div class="audit-entry">
                <div class="audit-icon"><i data-lucide="log-in"></i></div>
                <div class="audit-content">
                    <div class="audit-title">Player Joined</div>
                    <div class="audit-details">TestUser joined the server</div>
                </div>
                <div class="audit-time">2 mins ago</div>
            </div>
        </div>
    `;
}

function renderPlayers() {
    const server = AppState.currentServer;
    // Mock player list
    const players = [
        { id: 1, name: 'OwnerPlayer', avatar: 'https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=1&size=48x48&format=Png', team: 'Police', health: 100 },
        { id: 2, name: 'AdminPlayer', avatar: 'https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=2&size=48x48&format=Png', team: 'Civilian', health: 80 },
        { id: 3, name: 'RegularPlayer', avatar: 'https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=3&size=48x48&format=Png', team: 'Criminal', health: 50 }
    ];

    const list = players.map(p => {
        const tag = getMemberTag(p.id, server);
        return `
            <div class="player-card" data-action="open-modal" data-payload="modal-player" data-user-id="${p.id}">
                <img src="${p.avatar}" class="avatar">
                <div class="player-info">
                    <div class="player-name">
                        ${p.name}
                        ${tag ? `<span class="badge ${tag.class}" style="margin-left: 8px;">${tag.label}</span>` : ''}
                    </div>
                    <div class="player-meta">
                        <span>${p.team}</span> &bull;
                        <span>45m played</span>
                    </div>
                    <div class="health-bar-container">
                        <div class="health-bar" style="width: ${p.health}%"></div>
                    </div>
                </div>
                <button class="btn btn-ghost">Manage</button>
            </div>
        `;
    }).join('');

    return `
        <div class="page-header">
            <h1 class="page-title">Players</h1>
            <div class="input" style="width: 250px;">Search...</div>
        </div>
        <div class="grid grid-cols-2">
            ${list}
        </div>
    `;
}

function renderMap() {
    const server = AppState.currentServer;
    const active = shouldMapBeActive(server);
    const reason = getMapDisabledReason(server);

    return `
        <div class="page-header">
            <h1 class="page-title">Map</h1>
        </div>
        <div class="map-container ${!active ? 'map-disabled' : ''}">
            <img src="https://via.placeholder.com/800x600/141414/333333?text=Map+Image" class="map-image">
            ${!active ? `
                <div class="map-overlay">
                    <div class="map-overlay-content">
                        <i data-lucide="map-pin-off"></i>
                        <h3>Map Disabled</h3>
                        <p class="text-secondary">${reason}</p>
                    </div>
                </div>
            ` : `
                <div class="map-dot" style="left: 50%; top: 50%; background-color: #3498db;"></div>
                <div class="map-dot" style="left: 60%; top: 40%; background-color: #e74c3c;"></div>
            `}
        </div>
    `;
}

function renderAudit() {
    return `
        <div class="page-header">
            <h1 class="page-title">Audit Log</h1>
        </div>
        <div class="card" style="padding: 0;">
            <div class="audit-entry">
                <div class="audit-icon"><i data-lucide="hammer"></i></div>
                <div class="audit-content">
                    <div class="audit-title">Player Banned</div>
                    <div class="audit-details">AdminPlayer banned Hacker123 for "Exploiting"</div>
                </div>
                <div class="audit-time">1 hour ago</div>
            </div>
            <div class="audit-entry">
                <div class="audit-icon"><i data-lucide="snowflake"></i></div>
                <div class="audit-content">
                    <div class="audit-title">Player Frozen</div>
                    <div class="audit-details">OwnerPlayer frozen RegularPlayer</div>
                </div>
                <div class="audit-time">2 hours ago</div>
            </div>
        </div>
    `;
}

function renderChat() {
    return `
        <div class="page-header">
            <h1 class="page-title">Server Chat</h1>
        </div>
        <div class="chat-container">
            <div class="chat-messages">
                <div class="chat-bubble">
                    <img src="https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=2&size=48x48&format=Png" class="avatar avatar-sm">
                    <div>
                        <div class="chat-meta">AdminPlayer &bull; 12:05 PM</div>
                        <div class="chat-content">Please follow the rules everyone.</div>
                    </div>
                </div>
                <div class="chat-bubble chat-bubble-self">
                    <img src="https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=1&size=48x48&format=Png" class="avatar avatar-sm">
                    <div>
                        <div class="chat-meta">OwnerPlayer &bull; 12:06 PM</div>
                        <div class="chat-content">Agreed.</div>
                    </div>
                </div>
            </div>
            <div class="chat-input-area">
                <input type="text" class="input" placeholder="Type a message...">
                <button class="btn btn-primary" onclick="showToast('Message sent', 'success')"><i data-lucide="send"></i></button>
            </div>
        </div>
    `;
}

function renderPunishments() {
    return `
        <div class="page-header">
            <h1 class="page-title">Punishments</h1>
        </div>
        <div class="tabs">
            <div class="tab tab-active">Bans</div>
            <div class="tab">Warns</div>
        </div>
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th>Player</th>
                        <th>Reason</th>
                        <th>Moderator</th>
                        <th>Expires</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>Hacker123</td>
                        <td>Exploiting</td>
                        <td>AdminPlayer</td>
                        <td>Never</td>
                        <td><button class="btn btn-ghost" onclick="showToast('Player unbanned', 'success')">Unban</button></td>
                    </tr>
                </tbody>
            </table>
        </div>
    `;
}

function renderStaff() {
    return `
        <div class="page-header">
            <h1 class="page-title">Staff Activity</h1>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="btn btn-primary" onclick="showToast('On duty', 'success')"><i data-lucide="play"></i> Start Duty</button>
                <button class="btn btn-warning" onclick="showToast('On break', 'info')"><i data-lucide="coffee"></i> Take Break</button>
                <button class="btn btn-danger" onclick="showToast('Off duty', 'info')"><i data-lucide="square"></i> Stop Duty</button>
            </div>
        </div>
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th>Staff Member</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Time on Duty</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>OwnerPlayer</td>
                        <td><span class="badge badge-owner">Owner</span></td>
                        <td><span class="status-dot online"></span> On Duty</td>
                        <td>2h 15m</td>
                    </tr>
                    <tr>
                        <td>AdminPlayer</td>
                        <td><span class="badge badge-admin">Admin</span></td>
                        <td><span class="status-dot offline"></span> Off Duty</td>
                        <td>-</td>
                    </tr>
                </tbody>
            </table>
        </div>
    `;
}

function renderApiKey() {
    return `
        <div class="page-header">
            <h1 class="page-title">API Key</h1>
        </div>
        <div class="card">
            <h3>Dashboard API Access</h3>
            <p class="text-secondary" style="margin-bottom: 24px;">Use this key to authenticate with the dashboard API. Keep it secret.</p>

            <div class="form-group">
                <label class="form-label">Secret Key</label>
                <div style="display:flex; gap:12px; flex-wrap:wrap;">
                    <input type="password" class="input" value="eh_sk_1234567890abcdef" readonly id="api-key-input" style="flex:1; min-width:180px;">
                    <button class="btn btn-ghost" onclick="document.getElementById('api-key-input').type='text'"><i data-lucide="eye"></i> Reveal</button>
                    <button class="btn btn-primary" onclick="showToast('Copied to clipboard', 'success')"><i data-lucide="copy"></i> Copy</button>
                </div>
            </div>

            <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--border);">
                <button class="btn btn-danger" onclick="showToast('API Key regenerated', 'success')"><i data-lucide="refresh-cw"></i> Regenerate Key</button>
                <p class="text-secondary" style="margin-top: 8px; font-size: 12px;">Can be regenerated once every 15 minutes.</p>
            </div>
        </div>
    `;
}

function renderTeams() {
    return `
        <div class="page-header">
            <h1 class="page-title">Teams Overview</h1>
        </div>
        <div class="grid grid-cols-3">
            <div class="card" style="border-top: 2px solid #3498db;">
                <h3>Police</h3>
                <p class="text-secondary">4 Players</p>
            </div>
            <div class="card" style="border-top: 2px solid #e74c3c;">
                <h3>Criminal</h3>
                <p class="text-secondary">6 Players</p>
            </div>
            <div class="card" style="border-top: 2px solid #95a5a6;">
                <h3>Civilian</h3>
                <p class="text-secondary">10 Players</p>
            </div>
        </div>
    `;
}

// Modals
function renderModals() {
    return `
        <div class="modal-overlay" id="modal-info">
            <div class="modal">
                <div class="modal-header">
                    <h2 class="modal-title">Server Information</h2>
                    <span class="modal-close" data-action="close-modal"><i data-lucide="x"></i></span>
                </div>
                <div style="display:flex; flex-direction:column; gap:10px; font-size:13.5px;">
                    <p><strong>Server Name:</strong> ${AppState.currentServer?.name}</p>
                    <p><strong>Join Code:</strong> ${AppState.currentServer?.code}</p>
                    <p><strong>Region:</strong> US East</p>
                    <p><strong>Version:</strong> v8.0</p>
                </div>
            </div>
        </div>

        <div class="modal-overlay" id="modal-player">
            <div class="modal">
                <div class="modal-header">
                    <h2 class="modal-title">Player Actions</h2>
                    <span class="modal-close" data-action="close-modal"><i data-lucide="x"></i></span>
                </div>
                <div class="grid grid-cols-2" style="gap: 10px;">
                    <button class="btn btn-ghost" onclick="showToast('Teleporting...', 'success')"><i data-lucide="move"></i> Bring</button>
                    <button class="btn btn-ghost" onclick="showToast('Teleporting...', 'success')"><i data-lucide="navigation"></i> To</button>
                    <button class="btn btn-warning" onclick="showToast('Player warned', 'success')"><i data-lucide="triangle-alert"></i> Warn</button>
                    <button class="btn btn-ghost" onclick="showToast('Player frozen', 'success')"><i data-lucide="snowflake"></i> Freeze</button>
                    <button class="btn btn-danger" onclick="showToast('Player kicked', 'success')"><i data-lucide="log-out"></i> Kick</button>
                    <button class="btn btn-danger" onclick="showToast('Player banned', 'success')"><i data-lucide="hammer"></i> Ban</button>
                </div>
            </div>
        </div>
    `;
}

// Actions
function handleServerAction(action) {
    if (action === 'schedule-shutdown') {
        showToast('Shutdown scheduled in 5 minutes', 'warning');
    }
}

// Init
initApp();
