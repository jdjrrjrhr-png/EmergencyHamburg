--[[
    ShieldModule.lua — Emergency Hamburg API

    Place in ServerScriptService as a ModuleScript named "ShieldModule".

    LIFECYCLE: nothing runs automatically anymore. Your startup script must call
    Shield.Init() once the server is ready — this generates/loads this server's
    own API key, registers it with the backend, and starts heartbeat / batch-flush /
    position-streaming / player-event handling. Shield.Deinit() stops all of that
    and disconnects everything cleanly (e.g. call it from game:BindToClose or when
    you want to fully pause API activity without killing the server).

    All functions are non-blocking (task.spawn wrapped).
    Batching: events are queued and flushed every CONFIG.BatchInterval seconds,
    except heartbeat which runs on its own loop.
--]]

local HttpService       = game:GetService("HttpService")
local Players           = game:GetService("Players")
local RunService        = game:GetService("RunService")
local DataStoreService  = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

-- ============================================================
-- CONFIG
-- ============================================================
local CONFIG = {
    BASE_URL            = "https://api-production-59e1.up.railway.app",

    -- Fixed shared secret between this module and the API. This is the ONLY
    -- thing that authenticates Roblox->API traffic — never rotates on its own,
    -- never shown in the dashboard. Keep this in sync with the backend's .env
    -- ApiToken value.
    API_TOKEN           = "!@!@!SSD!VDK@DSo1",

    HeartbeatInterval   = 2,    -- seconds between heartbeats
    BatchInterval       = 3,    -- seconds between event batch flushes
    PositionInterval    = 1.3,  -- seconds between position packets (map)
    PositionMinStuds    = 7,    -- minimum movement to include in position packet
    MapMinPlayers       = 10,   -- min players before sending positions

    MaxRetries          = 2,    -- retry failed HTTP requests this many times
    RetryDelay          = 1,    -- seconds between retries
}

-- ============================================================
-- STATE
-- ============================================================
local serverCode        = ""
-- This server's own identification key — NOT a security credential (the
-- API_TOKEN above is). It just tells the backend *which* server a heartbeat/
-- position packet belongs to, and is what the owner sees (and can regenerate)
-- in the dashboard's Side Menu -> API Key.
local apiKey             = nil
local isInitialized      = false
local isShuttingDown    = false
local frozenPlayers     = {}   -- userId -> true
local playerJoinTimes   = {}
local playerLastPos     = {}   -- userId -> Vector3
local eventQueue        = {}   -- pending batched events
local banDS             = DataStoreService:GetDataStore("ServerBans_v2")
local apiKeyDS          = DataStoreService:GetDataStore("ShieldApiKey_v1")
local isPublicServer    = (game.PrivateServerId == "")
local dashboardWatching = false  -- set via heartbeat response
local serverName        = "Unknown Server"
local serverJoinCode    = ""
local serverOwnerId     = nil
local inventoryCache    = {}   -- userId -> inventory
local connections       = {}   -- event connections, disconnected on Deinit

-- Notification channel the client can hook into for warn / message / health toasts.
local notifyEvent = ReplicatedStorage:FindFirstChild("ShieldNotify")
if not notifyEvent then
    notifyEvent = Instance.new("RemoteEvent")
    notifyEvent.Name = "ShieldNotify"
    notifyEvent.Parent = ReplicatedStorage
end

-- ============================================================
-- UTILITIES
-- ============================================================
local function log(msg)
    print("[Shield] " .. msg)
end

-- Every request carries the fixed API_TOKEN — this is what proves to the
-- backend "this is really a Roblox server". The per-server apiKey (when
-- relevant, e.g. heartbeat/positions) travels as a body field instead, see
-- each call site below.
local function authHeaders()
    return {
        ["Content-Type"] = "application/json",
        ["Authorization"] = "Bearer " .. CONFIG.API_TOKEN
    }
end

local function httpPost(endpoint, payload, retries)
    retries = retries or CONFIG.MaxRetries
    local url = CONFIG.BASE_URL .. endpoint
    local body = HttpService:JSONEncode(payload)

    local success, result = pcall(function()
        return HttpService:PostAsync(url, body, Enum.HttpContentType.ApplicationJson, false, authHeaders())
    end)

    if success then
        local ok, data = pcall(function() return HttpService:JSONDecode(result) end)
        return ok and data or {}
    elseif retries > 0 then
        task.wait(CONFIG.RetryDelay)
        return httpPost(endpoint, payload, retries - 1)
    end
    return {}
end

local function httpDelete(endpoint)
    pcall(function()
        HttpService:RequestAsync({
            Url     = CONFIG.BASE_URL .. endpoint,
            Method  = "DELETE",
            Headers = authHeaders()
        })
    end)
end

local function generateServerCode()
    -- Attempt to get a persistent code from DataStore
    local ds = DataStoreService:GetDataStore("ShieldServerCode_v1")
    local ok, stored = pcall(function() return ds:GetAsync("code_" .. game.PlaceId) end)
    if ok and stored and type(stored) == "string" and #stored > 10 then
        return stored
    end
    local chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    local rng = Random.new()
    local function seg()
        local s = ""
        for _ = 1, 4 do
            s = s .. string.sub(chars, rng:NextInteger(1, #chars), rng:NextInteger(1, #chars))
        end
        return s
    end
    local code = seg().."-"..seg().."-"..seg().."-"..seg()
    pcall(function() ds:SetAsync("code_" .. game.PlaceId, code) end)
    return code
end

-- Complex key: 5 segments, each character randomly capital/small/digit/symbol.
local function generateApiKeyRaw()
    local pools = {
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        "abcdefghijklmnopqrstuvwxyz",
        "0123456789",
        "!@#$"
    }
    local rng = Random.new()
    local function randChar()
        local pool = pools[rng:NextInteger(1, #pools)]
        return string.sub(pool, rng:NextInteger(1, #pool), rng:NextInteger(1, #pool))
    end
    local function seg()
        local s = ""
        for _ = 1, 5 do s = s .. randChar() end
        return s
    end
    return seg().."-"..seg().."-"..seg().."-"..seg().."-"..seg()
end

-- Load this server's persisted key, or generate + persist a new one.
local function loadOrCreateApiKey()
    local ok, stored = pcall(function() return apiKeyDS:GetAsync("key_" .. game.PlaceId) end)
    if ok and stored and type(stored) == "string" and #stored > 10 then
        return stored
    end
    local newKey = generateApiKeyRaw()
    pcall(function() apiKeyDS:SetAsync("key_" .. game.PlaceId, newKey) end)
    return newKey
end

-- Idempotent registration/confirmation ping to the backend, authenticated with
-- the fixed API_TOKEN (that's the real proof this is a legitimate Roblox
-- server) — safe to call every Init() even if the key hasn't changed.
local function registerApiKey(newKey)
    local url = CONFIG.BASE_URL .. "/api/serverkeys/" .. serverCode .. "/rotate-key"
    local body = HttpService:JSONEncode({ newKey = newKey })
    pcall(function()
        HttpService:PostAsync(url, body, Enum.HttpContentType.ApplicationJson, false, authHeaders())
    end)
end

local function getBanTimeRemaining(unbanTime)
    if unbanTime == -1 then return "Permanent" end
    local remaining = unbanTime - os.time()
    if remaining <= 0 then return "Expired" end
    local d = math.floor(remaining / 86400)
    local h = math.floor((remaining % 86400) / 3600)
    local m = math.floor((remaining % 3600) / 60)
    local s = remaining % 60
    local str = ""
    if d > 0 then str = str .. d .. "d " end
    if h > 0 then str = str .. h .. "h " end
    if m > 0 then str = str .. m .. "m " end
    str = str .. s .. "s"
    return str
end

local function isInVehicle(player)
    local char = player.Character
    if not char then return false end
    local hum = char:FindFirstChildOfClass("Humanoid")
    return hum and hum.Sit == true
end

local function getPlayerPos(player)
    local char = player.Character
    if char then
        local hrp = char:FindFirstChild("HumanoidRootPart")
        if hrp then
            return hrp.Position.X, hrp.Position.Z
        end
    end
    return 0, 0
end

-- Resolve a command target robustly: prefer userId (immune to display-name /
-- username mismatches), fall back to exact username. This is what freeze/unfreeze
-- used to get wrong — it only ever tried Players:FindFirstChild(username).
local function resolvePlayer(targetName, targetId)
    local id = tonumber(targetId)
    if id then
        local p = Players:GetPlayerByUserId(id)
        if p then return p end
    end
    if targetName then
        local p = Players:FindFirstChild(targetName)
        if p and p:IsA("Player") then return p end
    end
    return nil
end

-- ============================================================
-- EVENT QUEUE (BATCH FLUSH)
-- ============================================================
local function queueEvent(eventType, endpoint, payload)
    table.insert(eventQueue, { type = eventType, endpoint = endpoint, payload = payload })
end

local function flushEvents()
    if #eventQueue == 0 then return end
    local toSend = eventQueue
    eventQueue = {}
    for _, ev in ipairs(toSend) do
        task.spawn(function()
            httpPost(ev.endpoint, ev.payload)
        end)
    end
end

-- ============================================================
-- COMMAND PROCESSING
-- ============================================================
local function buildPlayersList()
    local list = {}
    for _, player in ipairs(Players:GetPlayers()) do
        local posX, posZ = getPlayerPos(player)
        local joinTime = playerJoinTimes[player.UserId] or os.time()
        local teamName = player.Team and player.Team.Name or "Civilian"
        local health, maxHealth = nil, nil
        if player.Character then
            local hum = player.Character:FindFirstChildOfClass("Humanoid")
            if hum then
                health = math.floor(hum.Health)
                maxHealth = math.floor(hum.MaxHealth)
            end
        end
        table.insert(list, {
            name       = player.Name,
            displayName= player.DisplayName,
            userId     = player.UserId,
            team       = teamName,
            timeInGame = os.time() - joinTime,
            inVehicle  = isInVehicle(player),
            isFrozen   = frozenPlayers[player.UserId] ~= nil,
            pos        = { x = math.floor(posX), z = math.floor(posZ) },
            health     = health,
            maxHealth  = maxHealth,
            hasInventory = inventoryCache[player.UserId] ~= nil
        })
    end
    return list
end

local function applyHealth(player, newHealth, maxHealth)
    if not player.Character then return end
    local hum = player.Character:FindFirstChildOfClass("Humanoid")
    if not hum then return end
    if maxHealth ~= nil then
        hum.MaxHealth = maxHealth
    end
    if newHealth ~= nil then
        hum.Health = math.clamp(newHealth, 0, hum.MaxHealth)
    end
end

local function processCommands(commands)
    for _, cmd in ipairs(commands) do
        if cmd.action == "shutdown" then
            isShuttingDown = true
            for _, p in ipairs(Players:GetPlayers()) do
                p:Kick("\n[Remote Shutdown]\nInitiated by: " .. tostring(cmd.senderName or "Admin"))
            end
            break
        end

        if cmd.action == "api_key_changed" then
            -- Owner regenerated the key from the dashboard — adopt it immediately
            -- and persist it, so the NEXT heartbeat already uses the new key
            -- instead of relying only on the backend's temporary grace window.
            if cmd.newKey then
                apiKey = cmd.newKey
                pcall(function() apiKeyDS:SetAsync("key_" .. game.PlaceId, apiKey) end)
                log("API key updated remotely")
            end
        end

        if cmd.action == "lock_request" then
            log("[Lock Request] by " .. tostring(cmd.senderName) .. " (" .. tostring(cmd.senderId) .. ")")
            -- Actual lock logic goes here — this just surfaces the request per spec.

        elseif cmd.action == "unlock_request" then
            log("[Unlock Request] by " .. tostring(cmd.senderName) .. " (" .. tostring(cmd.senderId) .. ")")
            -- Actual unlock logic goes here — this just surfaces the request per spec.
        end

        local target = resolvePlayer(cmd.target, cmd.targetId)

        if cmd.action == "freeze" then
            local id = tonumber(cmd.targetId) or (target and target.UserId)
            if id then
                frozenPlayers[id] = true
                if target and target.Character then
                    local hrp = target.Character:FindFirstChild("HumanoidRootPart")
                    if hrp then hrp.Anchored = true end
                end
            end

        elseif cmd.action == "unfreeze" then
            local id = tonumber(cmd.targetId) or (target and target.UserId)
            if id then
                frozenPlayers[id] = nil
                if target and target.Character then
                    local hrp = target.Character:FindFirstChild("HumanoidRootPart")
                    if hrp then hrp.Anchored = false end
                end
            end

        elseif cmd.action == "kick" then
            if target then
                target:Kick("\n[Remote Kick]\nReason: " .. (cmd.reason or "Violations") .. "\nBy: " .. (cmd.senderName or "Admin"))
            end

        elseif cmd.action == "ban" then
            local dur = tonumber(cmd.duration) or -1
            local tId = tonumber(cmd.targetId)
            if not tId and target then tId = target.UserId end
            if tId then
                task.spawn(function()
                    pcall(function()
                        banDS:UpdateAsync(game.JobId, function(old)
                            old = old or {}
                            old[tostring(tId)] = {
                                reason    = cmd.reason or "Violations",
                                duration  = dur,
                                unbanTime = dur == -1 and -1 or (os.time() + dur)
                            }
                            return old
                        end)
                    end)
                end)
                if target then
                    local tm = dur == -1 and "Permanent" or getBanTimeRemaining(os.time() + dur)
                    target:Kick("\n[Server Ban]\nReason: " .. (cmd.reason or "Violations") .. "\nDuration: " .. tm)
                end
            end

        elseif cmd.action == "bring" then
            local adminId = tonumber(cmd.senderId)
            if adminId and target and target.Character then
                local adminPlayer = Players:GetPlayerByUserId(adminId)
                if adminPlayer and adminPlayer.Character and adminPlayer.Character:FindFirstChild("HumanoidRootPart") then
                    local hum = target.Character:FindFirstChildOfClass("Humanoid")
                    if hum then hum.Sit = false end
                    task.wait(0.1)
                    if target.Character and adminPlayer.Character:FindFirstChild("HumanoidRootPart") then
                        target.Character:PivotTo(adminPlayer.Character.HumanoidRootPart.CFrame * CFrame.new(0, 0, -4))
                    end
                end
            end

        elseif cmd.action == "to" then
            local adminId = tonumber(cmd.senderId)
            if adminId and target and target.Character and target.Character:FindFirstChild("HumanoidRootPart") then
                local adminPlayer = Players:GetPlayerByUserId(adminId)
                if adminPlayer and adminPlayer.Character then
                    local hum = adminPlayer.Character:FindFirstChildOfClass("Humanoid")
                    if hum then hum.Sit = false end
                    task.wait(0.1)
                    if adminPlayer.Character and target.Character:FindFirstChild("HumanoidRootPart") then
                        adminPlayer.Character:PivotTo(target.Character.HumanoidRootPart.CFrame * CFrame.new(0, 0, 4))
                    end
                end
            end

        elseif cmd.action == "warn" then
            if target then
                notifyEvent:FireClient(target, {
                    type      = "warn",
                    reason    = cmd.reason or "Misconduct",
                    caseId    = cmd.caseId or "N/A",
                    by        = cmd.senderName or "Admin"
                })
                log("WARN issued to " .. tostring(cmd.target or target.Name) .. ": " .. (cmd.reason or "Misconduct") .. " | Case: " .. tostring(cmd.caseId or "N/A"))
            end

        elseif cmd.action == "message" then
            local msgText = cmd.reason or ""
            if cmd.target == "@everyone" then
                for _, p in ipairs(Players:GetPlayers()) do
                    notifyEvent:FireClient(p, { type = "message", text = msgText, by = cmd.senderName })
                end
            elseif cmd.target == "@me" then
                local sender = Players:GetPlayerByUserId(tonumber(cmd.senderId) or 0)
                if sender then
                    notifyEvent:FireClient(sender, { type = "message", text = msgText, by = cmd.senderName })
                end
            elseif target then
                notifyEvent:FireClient(target, { type = "message", text = msgText, by = cmd.senderName })
            end

        elseif cmd.action == "health" then
            local newHealth = cmd.newHealth -- may be nil (json null) -> leave Health unchanged
            local maxHealth = cmd.maxHealth -- may be nil -> leave MaxHealth unchanged
            if cmd.target == "@everyone" then
                for _, p in ipairs(Players:GetPlayers()) do
                    applyHealth(p, newHealth, maxHealth)
                end
            elseif cmd.target == "@me" then
                local sender = Players:GetPlayerByUserId(tonumber(cmd.senderId) or 0)
                if sender then applyHealth(sender, newHealth, maxHealth) end
            elseif target then
                applyHealth(target, newHealth, maxHealth)
            end
            if target then
                notifyEvent:FireClient(target, { type = "health", newHealth = newHealth, maxHealth = maxHealth, by = cmd.senderName })
            end
        end
    end
end

-- ============================================================
-- LIFECYCLE LOOPS (only run between Init() and Deinit())
-- ============================================================
local function heartbeatLoop()
    while isInitialized and not isShuttingDown do
        local players = buildPlayersList()
        local payload = {
            playersList = players,
            serverName  = serverName,
            joinCode    = serverJoinCode,
            apiKey      = apiKey -- identifies WHICH server this heartbeat is for
        }

        local response = httpPost("/api/servers/" .. serverCode .. "/heartbeat", payload)

        if response and response.commands then
            processCommands(response.commands)
        end

        if response and response.dashboardWatching ~= nil then
            dashboardWatching = response.dashboardWatching
        end

        task.wait(CONFIG.HeartbeatInterval)
    end
end

local function batchFlushLoop()
    while isInitialized and not isShuttingDown do
        task.wait(CONFIG.BatchInterval)
        flushEvents()
    end
end

local function shouldStreamPositions()
    if isPublicServer then return false end
    if #Players:GetPlayers() < CONFIG.MapMinPlayers then return false end
    return dashboardWatching
end

local function positionStreamLoop()
    while isInitialized and not isShuttingDown do
        task.wait(CONFIG.PositionInterval)
        if not shouldStreamPositions() then continue end

        local positions = {}
        for _, player in ipairs(Players:GetPlayers()) do
            local posX, posZ = getPlayerPos(player)
            local lastPos = playerLastPos[player.UserId]

            local moved = true
            if lastPos then
                local dx = posX - lastPos.x
                local dz = posZ - lastPos.z
                moved = math.sqrt(dx*dx + dz*dz) >= CONFIG.PositionMinStuds
            end

            if moved then
                playerLastPos[player.UserId] = { x = posX, z = posZ }
                local teamColor = "#ffffff"
                if player.Team then
                    local c = player.Team.TeamColor.Color
                    teamColor = string.format("#%02X%02X%02X",
                        math.floor(c.R * 255), math.floor(c.G * 255), math.floor(c.B * 255))
                end
                table.insert(positions, {
                    name      = player.Name,
                    userId    = player.UserId,
                    team      = player.Team and player.Team.Name or "Civilian",
                    teamColor = teamColor,
                    x         = math.floor(posX),
                    z         = math.floor(posZ)
                })
            end
        end

        if #positions > 0 then
            task.spawn(function()
                httpPost("/api/servers/" .. serverCode .. "/positions", { positions = positions, apiKey = apiKey })
            end)
        end
    end
end

local function keepFrozenAnchoredLoop()
    return RunService.Heartbeat:Connect(function()
        if isPublicServer or not isInitialized then return end
        for userId in pairs(frozenPlayers) do
            local p = Players:GetPlayerByUserId(userId)
            if p and p.Character then
                local hrp = p.Character:FindFirstChild("HumanoidRootPart")
                if hrp and not hrp.Anchored then
                    hrp.Anchored = true
                end
            end
        end
    end)
end

local function onPlayerAdded(player)
    log("Player joined: " .. player.Name .. " (" .. player.UserId .. ")")

    local banOk, bans = pcall(function() return banDS:GetAsync(game.JobId) end)
    if banOk and bans and bans[tostring(player.UserId)] then
        local b = bans[tostring(player.UserId)]
        if b.duration == -1 or os.time() < b.unbanTime then
            local tm = b.duration == -1 and "Permanent" or ("Unban in: " .. getBanTimeRemaining(b.unbanTime))
            player:Kick("Banned from this server\nReason: " .. (b.reason or "Violations") .. "\n" .. tm)
            return
        end
    end

    playerJoinTimes[player.UserId] = os.time()
    playerLastPos[player.UserId] = nil

    queueEvent("player_added", "/api/tracking/join", {
        userId     = player.UserId,
        username   = player.Name,
        serverCode = serverCode,
        jobId      = game.JobId
    })

    if frozenPlayers[player.UserId] then
        player.CharacterAdded:Connect(function(char)
            local hrp = char:WaitForChild("HumanoidRootPart", 5)
            if hrp then hrp.Anchored = true end
        end)
    end

    -- Try reading server name from TeleportData (first player only, non-public servers)
    if not isPublicServer then
        local ok, joinData = pcall(function() return player:GetJoinData() end)
        if ok and joinData and joinData.TeleportData then
            local td = joinData.TeleportData
            if td.ServerName and serverName == "Unknown Server" then
                serverName = td.ServerName
            end
            if td.CustomCode and serverJoinCode == "" then
                serverJoinCode = td.CustomCode
            end
        end
    end
end

local function onPlayerRemoving(player)
    local joinTime = playerJoinTimes[player.UserId]
    playerJoinTimes[player.UserId] = nil
    playerLastPos[player.UserId] = nil

    queueEvent("player_left", "/api/tracking/leave", {
        userId     = player.UserId,
        username   = player.Name,
        serverCode = serverCode,
        duration   = joinTime and (os.time() - joinTime) or 0
    })
end

local metaSent = false
local function sendMetaOnce()
    if metaSent then return end
    metaSent = true
    task.wait(2) -- wait for TeleportData
    httpPost("/api/servers/" .. serverCode .. "/meta", {
        name     = serverName,
        joinCode = serverJoinCode,
        ownerId  = serverOwnerId
    })
end

-- ============================================================
-- PUBLIC MODULE API
-- ============================================================
local Shield = {}

-- ── LIFECYCLE ─────────────────────────────────────────────────

-- Starts the API connection: generates/loads this server's own API key, registers
-- it with the backend, and starts heartbeat / batching / position-streaming / all
-- player-event tracking. Call this once from your startup script.
function Shield.Init()
    if isInitialized then
        log("Init() called but already initialized — ignoring")
        return
    end
    if isPublicServer then
        log("Public server — Init() is a no-op (tracking only)")
        return
    end

    isShuttingDown = false
    serverCode = generateServerCode()
    apiKey = loadOrCreateApiKey()

    log("==============================================")
    log("Shield System | Server Code: " .. serverCode)
    log("==============================================")

    registerApiKey(apiKey) -- idempotent: registers on first run, confirms otherwise

    isInitialized = true

    connections.playerAdded   = Players.PlayerAdded:Connect(onPlayerAdded)
    connections.playerRemoving = Players.PlayerRemoving:Connect(onPlayerRemoving)
    connections.frozenAnchor  = keepFrozenAnchoredLoop()

    -- Handle players already in the server if Init() is called late
    for _, p in ipairs(Players:GetPlayers()) do
        task.spawn(onPlayerAdded, p)
    end

    task.spawn(heartbeatLoop)
    task.spawn(batchFlushLoop)
    task.spawn(positionStreamLoop)
    task.spawn(sendMetaOnce)
end

-- Stops all API connections and heartbeats without shutting the server down.
function Shield.Deinit()
    if not isInitialized then return end
    isInitialized = false
    flushEvents()
    httpDelete("/api/servers/" .. serverCode)

    for _, conn in pairs(connections) do
        if conn and conn.Connected then conn:Disconnect() end
    end
    connections = {}

    log("Shield API deinitialized — all connections stopped")
end

-- Manually change this server's identification key (e.g. you want to force a
-- rotation from Studio). Authenticated with the fixed API_TOKEN, same as
-- every other call — no old-key matching needed since that's not the real
-- security boundary here.
function Shield.SetApiKey(newCode)
    if not newCode then return end
    task.spawn(function()
        local url = CONFIG.BASE_URL .. "/api/serverkeys/" .. serverCode .. "/rotate-key"
        local body = HttpService:JSONEncode({ newKey = newCode })
        local ok = pcall(function()
            HttpService:PostAsync(url, body, Enum.HttpContentType.ApplicationJson, false, authHeaders())
        end)
        if ok then
            apiKey = newCode
            pcall(function() apiKeyDS:SetAsync("key_" .. game.PlaceId, apiKey) end)
            log("API key rotated manually")
        end
    end)
end

-- Shutdown cleanup — call from game:BindToClose (kept separate from Deinit since
-- a real server shutdown should also kick/notify players; Deinit alone does not).
game:BindToClose(function()
    if not isInitialized then return end
    isShuttingDown = true
    Shield.Deinit()
    task.wait(1)
end)

-- ── REPORTING (Roblox-only) ──────────────────────────────────

function Shield.ShotsFired(shooterName, shooterUserId, targetName, targetUserId, weapon, posX, posZ)
    queueEvent("shots_fired", "/api/tracking/shots", {
        serverCode   = serverCode,
        shooterName  = shooterName,
        shooterUserId= shooterUserId,
        targetName   = targetName,
        targetUserId = targetUserId,
        weapon       = weapon,
        posX         = posX,
        posZ         = posZ
    })
end

function Shield.SetRobbery(suspects, robberyName, robberyType, startedAt, posX, posZ)
    queueEvent("robbery", "/api/tracking/robbery", {
        serverCode  = serverCode,
        suspects    = suspects,
        robberyName = robberyName,
        robberyType = robberyType,
        startedAt   = startedAt or os.time(),
        posX        = posX,
        posZ        = posZ
    })
end

function Shield.SetWanted(playerName, playerUserId, stars, reason, crimes)
    queueEvent("set_wanted", "/api/tracking/wanted", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        stars        = stars,
        reason       = reason,
        crimes       = crimes
    })
end

function Shield.PlayerTeamChanged(playerName, playerUserId, oldTeam, newTeam, xpGiven)
    queueEvent("team_changed", "/api/tracking/teamchange", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        oldTeam      = oldTeam,
        newTeam      = newTeam,
        xpGiven      = xpGiven or 0
    })
end

function Shield.PhoneCall(playerName, playerUserId, posX, posZ, forTeam, message)
    queueEvent("phone_call", "/api/tracking/phonecall", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        posX         = posX,
        posZ         = posZ,
        forTeam      = forTeam,
        message      = message
    })
end

function Shield.PlayerDown(playerName, playerUserId, playerTeam, killerName, killerId, weaponName, posX, posZ)
    queueEvent("player_down", "/api/tracking/playerdown", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        playerTeam   = playerTeam,
        killerName   = killerName,
        killerId     = killerId,
        weaponName   = weaponName,
        posX         = posX,
        posZ         = posZ
    })
end

-- ── PUNISHMENTS (log + command) ──────────────────────────────

function Shield.Ban(bannedName, bannedUserId, responsibleName, responsibleId, duration, reason)
    task.spawn(function()
        httpPost("/api/punishments/ban", {
            serverCode          = serverCode,
            bannedUserName      = bannedName,
            bannedUserId        = bannedUserId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName,
            duration            = duration or -1,
            reason              = reason or "No reason provided"
        })
    end)
end

function Shield.Unban(userId, responsibleName, responsibleId, reason)
    task.spawn(function()
        httpPost("/api/punishments/unban", {
            userId              = userId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName,
            reason              = reason or "No reason provided"
        })
    end)
end

function Shield.Kick(targetName, targetId, responsibleName, responsibleId, reason)
    task.spawn(function()
        httpPost("/api/punishments/kick", {
            serverCode          = serverCode,
            target              = targetName,
            targetId            = targetId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName,
            reason              = reason or "No reason provided"
        })
    end)
end

function Shield.Warn(targetName, targetId, responsibleName, responsibleId, reason, expireSeconds)
    task.spawn(function()
        httpPost("/api/punishments/warn", {
            serverCode          = serverCode,
            toWho               = targetName,
            toWhoId             = targetId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName,
            reason              = reason or "No reason provided",
            time                = expireSeconds or -1
        })
    end)
end

function Shield.Unwarn(targetName, targetId, caseId)
    task.spawn(function()
        httpPost("/api/punishments/unwarn", {
            serverCode = serverCode,
            who        = targetName,
            whoId      = targetId,
            caseId     = caseId
        })
    end)
end

function Shield.Warns(targetName, targetId)
    -- Synchronous fetch (use in task.spawn to avoid blocking)
    local url = CONFIG.BASE_URL .. "/api/punishments/warns/" .. tostring(targetId)
    local ok, result = pcall(function()
        return HttpService:GetAsync(url, false, authHeaders())
    end)
    if ok then
        local parsed = pcall(function() return HttpService:JSONDecode(result) end)
        return parsed or {}
    end
    return {}
end

function Shield.FreezeToggle(targetName, targetId, responsibleName, responsibleId)
    task.spawn(function()
        httpPost("/api/punishments/freeze", {
            serverCode          = serverCode,
            targetUsername      = targetName,
            targetId            = targetId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName
        })
    end)
end

function Shield.Bring(targetName, targetId, responsibleName, responsibleId)
    local adminPlayer = Players:GetPlayerByUserId(responsibleId)
    local targetPlayer = resolvePlayer(targetName, targetId)
    if adminPlayer and targetPlayer and adminPlayer.Character and targetPlayer.Character then
        local hum = targetPlayer.Character:FindFirstChildOfClass("Humanoid")
        if hum then hum.Sit = false end
        task.wait(0.1)
        if adminPlayer.Character:FindFirstChild("HumanoidRootPart") and targetPlayer.Character then
            targetPlayer.Character:PivotTo(adminPlayer.Character.HumanoidRootPart.CFrame * CFrame.new(0,0,-4))
        end
    end
    queueEvent("bring", "/api/punishments/log", {
        serverCode   = serverCode,
        type         = "bring",
        targetUsername = targetName,
        targetId     = targetId,
        actorUsername= responsibleName,
        actorId      = responsibleId
    })
end

function Shield.To(targetName, targetId, responsibleName, responsibleId)
    local adminPlayer = Players:GetPlayerByUserId(responsibleId)
    local targetPlayer = resolvePlayer(targetName, targetId)
    if adminPlayer and targetPlayer and targetPlayer.Character and targetPlayer.Character:FindFirstChild("HumanoidRootPart") then
        local hum = adminPlayer.Character and adminPlayer.Character:FindFirstChildOfClass("Humanoid")
        if hum then hum.Sit = false end
        task.wait(0.1)
        if adminPlayer.Character and targetPlayer.Character:FindFirstChild("HumanoidRootPart") then
            adminPlayer.Character:PivotTo(targetPlayer.Character.HumanoidRootPart.CFrame * CFrame.new(0,0,4))
        end
    end
    queueEvent("to", "/api/punishments/log", {
        serverCode   = serverCode,
        type         = "to",
        targetUsername = targetName,
        targetId     = targetId,
        actorUsername= responsibleName,
        actorId      = responsibleId
    })
end

-- ── SIDE COMMANDS ────────────────────────────────────────────

function Shield.ServerShutdown(responsibleName, responsibleId)
    -- Notify API that shutdown is happening (does NOT execute it — let game:BindToClose handle that)
    queueEvent("shutdown_notify", "/api/punishments/log", {
        serverCode   = serverCode,
        type         = "server_shutdown",
        actorUsername= responsibleName,
        actorId      = responsibleId
    })
end

function Shield.PlayerSetInventory(playerName, playerUserId, inventory)
    inventoryCache[playerUserId] = inventory
    queueEvent("inventory", "/api/tracking/inventory", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        inventory    = inventory
    })
end

-- adminIds -> global admin access (any server). modIds -> access scoped to THIS server.
function Shield.UpdateAdmins(adminIds, modIds)
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/admins", {
            admins = adminIds or {},
            mods   = modIds or {}
        })
    end)
end

function Shield.SetOwner(userId)
    serverOwnerId = userId
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/owner", { ownerId = userId })
    end)
end

-- Kept for backward compatibility — prefer Shield.SetOwner going forward.
function Shield.SetServerOwner(userId)
    Shield.SetOwner(userId)
end

function Shield.ServerSetName(newName)
    serverName = newName
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/meta", { name = newName })
    end)
end

function Shield.ServerSetJoinCode(newCode)
    serverJoinCode = newCode
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/meta", { joinCode = newCode })
    end)
end

function Shield.Addlocation(locationName, positionsArray, text)
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/addlocation", {
            locationName     = locationName,
            LocationPosition = positionsArray,
            Text             = text
        })
    end)
end

function Shield.Message(toWho, message)
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/commands", {
            action   = "message",
            target   = toWho,
            reason   = message,
            senderId = serverOwnerId or 0
        })
    end)
end

function Shield.GetServerCode()
    return serverCode
end

return Shield
