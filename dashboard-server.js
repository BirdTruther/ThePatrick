require('dotenv').config();
const express = require('express');
const path = require('path');
const { getLogs, getLogCount, clearLogs, getSystemLogs, getSystemLogCount, clearSystemLogs, logCommand: dbLogCommand, logSystem, getSetting, setSetting } = require('./database.js');
const { getCurrentPersona, setPersona, getAvailablePersonas } = require('./persona-manager.js');
const { getHatedUserIds, addToHateList, removeFromHateList, getHateChannelId, setHateChannelId } = require('./hate-manager.js');
const { getLongTermFacts, saveFacts, replaceFacts, getLastConsolidatedId } = require('./memory.js');
const { consolidateChannelFacts } = require('./services/ai.js');

// Cultist spawn alerts are per-server; the Tarkov clock is global. The actual
// posting lives in services/cultist.js (run by index.js); here we only expose
// the clock for the dashboard display and per-guild config endpoints.
const cultist = require('./services/cultist.js');
let cultistState = {
  server1Time: '--:--',
  server2Time: '--:--',
  server1Active: false,
  server2Active: false
};
console.log('[DASHBOARD] Cultist monitor loaded (per-server config)');

// Roast-ping toggle — gates the proactive hate timer + random callouts so the
// bot stops pinging hated users unprompted. Each Discord server has its own
// setting; the old global key remains the fallback for legacy single-server data.
const HATE_PINGS_KEY = 'hatePingsEnabled';
function hatePingsKey(guildId) {
  return guildId ? `${HATE_PINGS_KEY}:${guildId}` : HATE_PINGS_KEY;
}
function getHatePingsEnabled(guildId = null) {
  const value = guildId
    ? getSetting(hatePingsKey(guildId), null) ?? getSetting(HATE_PINGS_KEY, 'true')
    : getSetting(HATE_PINGS_KEY, 'true');
  return value !== 'false';
}
console.log('[DASHBOARD] Roast pings loaded with per-server settings');
global.getHatePingsEnabled = getHatePingsEnabled;

// Command logs storage (in-memory cache for real-time updates, max 500 entries)
const MAX_LOGS = 500;
let commandLogs = [];

// Load existing logs from database on startup
function loadLogsFromDatabase() {
  try {
    const dbLogs = getLogs('all', MAX_LOGS);
    commandLogs = dbLogs.map(log => ({
      platform: log.platform,
      username: log.username,
      command: log.command,
      message: log.message,
      response: log.response,
      image_url: log.image_url,
      error: log.error === 1,
      timestamp: log.timestamp,
      id: log.id
    })).reverse();
    console.log(`[DASHBOARD] Loaded ${commandLogs.length} logs from database`);
  } catch (error) {
    console.error('[DASHBOARD] Error loading logs from database:', error);
  }
}

loadLogsFromDatabase();

function addLog(entry) {
  commandLogs.push({
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
    id: entry.id || Date.now() + Math.random()
  });
  if (commandLogs.length > MAX_LOGS) {
    commandLogs = commandLogs.slice(-MAX_LOGS);
  }
}

global.dashboardLogCommand = addLog;

// Refresh the shared Tarkov clock shown on the dashboard (source of truth is
// services/cultist.js, so the display and the alerts never disagree).
setInterval(() => {
  const snap = cultist.snapshot();
  cultistState.server1Time = snap.server1Time;
  cultistState.server2Time = snap.server2Time;
  cultistState.server1Active = snap.server1Active;
  cultistState.server2Active = snap.server2Active;
}, 30000);
cultistState = { ...cultistState, ...cultist.snapshot() };

function formatUptime(seconds) {
  const totalSecs = Math.floor(seconds);
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (d > 0) {
    return `${d}d ${hh}h ${mm}m ${ss}s`;
  }
  return `${hh}h ${mm}m ${ss}s`;
}

const app = express();
const PORT = 3001;
// Bind to loopback by default. Put a reverse proxy (Caddy/nginx/Cloudflare)
// in front for remote access; set DASHBOARD_HOST=0.0.0.0 to expose on the LAN.
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';

app.set('trust proxy', 1);
app.use(express.json());

// Dashboard authentication (Discord OAuth). Routes under /auth/* and
// /api/auth/me must be registered before the global gate below.
const dashboardAuth = require('./dashboard-auth.js');
dashboardAuth.attachRoutes(app, { getDiscordClient });

// Brand assets are referenced by the unauthenticated sign-in page, so serve
// them before the dashboard gate. Everything else in /public stays protected.
for (const file of ['logo.png', 'favicon.png', 'apple-touch-icon.png', 'readme-banner.png']) {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}
app.use(dashboardAuth.requireAuth);

// Guard server-scoped endpoints: the logged-in user must actually manage the
// requested guild (allowlisted users may manage all of the bot's servers).
function ensureGuildAccess(req, res, guildId) {
  if (!guildId) {
    res.status(400).json({ success: false, error: 'guildId is required' });
    return false;
  }
  if (!dashboardAuth.canAccessGuild(req.user, guildId)) {
    res.status(403).json({ success: false, error: 'forbidden' });
    return false;
  }
  return true;
}

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/cultist/status', (req, res) => { res.json(cultistState); });

// Per-server cultist alert config: enable + channel (+ optional role to ping).
app.get('/api/cultist/config', (req, res) => {
  const { guildId } = req.query;
  if (!ensureGuildAccess(req, res, guildId)) return;
  res.json({
    success: true,
    guildId,
    enabled: cultist.isCultistEnabled(guildId),
    channelId: cultist.getCultistChannelId(guildId),
    roleId: cultist.getCultistRoleId(guildId)
  });
});

app.post('/api/cultist/config', (req, res) => {
  const { guildId, enabled, channelId, roleId } = req.body;
  if (!ensureGuildAccess(req, res, guildId)) return;
  if (enabled !== undefined) cultist.setCultistEnabled(guildId, !!enabled);
  if (channelId !== undefined) cultist.setCultistChannelId(guildId, channelId);
  if (roleId !== undefined) cultist.setCultistRoleId(guildId, roleId);
  console.log(`[API] Cultist config for guild ${guildId}: enabled=${cultist.isCultistEnabled(guildId)} channel=${cultist.getCultistChannelId(guildId)} role=${cultist.getCultistRoleId(guildId)}`);
  res.json({
    success: true,
    guildId,
    enabled: cultist.isCultistEnabled(guildId),
    channelId: cultist.getCultistChannelId(guildId),
    roleId: cultist.getCultistRoleId(guildId)
  });
});

app.get('/api/hate/pings/status', (req, res) => {
  const { guildId } = req.query;
  if (!ensureGuildAccess(req, res, guildId)) return;
  res.json({ success: true, enabled: getHatePingsEnabled(guildId) });
});

app.post('/api/hate/pings/toggle', (req, res) => {
  const { enabled, guildId } = req.body;
  if (!ensureGuildAccess(req, res, guildId)) return;
  const value = !!enabled;
  setSetting(hatePingsKey(guildId), value);
  console.log(`[API] Roast pings ${value ? 'ENABLED' : 'DISABLED'} for guild ${guildId}`);
  res.json({ success: true, enabled: value, guildId });
});

app.get('/api/bot/status', (req, res) => {
  const uptimeSeconds = process.uptime();
  const uptimeStr = formatUptime(uptimeSeconds);
  res.json({ status: 'ONLINE', uptime: uptimeStr, lastCheck: new Date().toLocaleTimeString(), memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(1) + ' MB' });
});

// Persona endpoints — per Discord server, shared via the database so both
// index.js (bot process) and dashboard-server.js (Express process) stay in sync.
app.get('/api/persona/current', (req, res) => {
  const { guildId } = req.query;
  if (!ensureGuildAccess(req, res, guildId)) return;
  const persona = getCurrentPersona(guildId); // now includes .key
  res.json({ success: true, persona: persona.key, guildId });
});

app.post('/api/persona/set', (req, res) => {
  const { persona, guildId } = req.body;
  if (!ensureGuildAccess(req, res, guildId)) return;
  const valid = getAvailablePersonas();
  if (!valid.includes(persona)) {
    return res.status(400).json({ success: false, error: 'Invalid persona. Valid options: ' + valid.join(', ') });
  }
  const success = setPersona(persona, guildId);
  if (!success) return res.status(400).json({ success: false, error: 'Persona switch failed' });
  console.log(`[API] Persona changed to: ${persona} for guild ${guildId}`);
  res.json({ success: true, persona, guildId });
});

// ===== HATE LIST ENDPOINTS =====

// Announce a newly-added hate-list victim into the configured roast channel.
function announceHateAdd(userId, guildId) {
  const client = getDiscordClient();
  if (!client) return;
  const channelId = getHateChannelId(guildId);
  if (!channelId) return;
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;
  channel.send(`📢 Heads up, everyone — <@${userId}> just made the hate list. Get rekt.`).catch(err =>
    console.error('[HATE] Announce send failed:', err.message)
  );
}

async function describeHatedUsers(ids, guildId) {
  const client = getDiscordClient();
  const guild = client?.guilds?.cache?.get(guildId);
  return Promise.all(ids.map(async id => {
    let member = guild?.members?.cache?.get(id);
    if (!member && guild) member = await guild.members.fetch(id).catch(() => null);
    return {
      id,
      name: member?.displayName || member?.user?.globalName || member?.user?.username || `Discord user ${id}`
    };
  }));
}

app.get('/api/hate/list', async (req, res) => {
  const { guildId } = req.query;
  if (!ensureGuildAccess(req, res, guildId)) return;
  const list = getHatedUserIds(guildId);
  res.json({ success: true, list, users: await describeHatedUsers(list, guildId), guildId });
});

app.get('/api/hate/config', (req, res) => {
  const { guildId } = req.query;
  if (!ensureGuildAccess(req, res, guildId)) return;
  res.json({ success: true, guildId, channelId: getHateChannelId(guildId) });
});

app.post('/api/hate/config', (req, res) => {
  const { guildId, channelId } = req.body;
  if (!ensureGuildAccess(req, res, guildId)) return;
  setHateChannelId(channelId || '', guildId);
  res.json({ success: true, guildId, channelId: getHateChannelId(guildId) });
});

app.get('/api/hate/all', async (req, res) => {
  if (!dashboardAuth.isSuperAdmin(req)) return res.status(403).json({ success: false, error: 'superadmin only' });
  const client = getDiscordClient();
  const groups = client
    ? await Promise.all([...client.guilds.cache.values()].map(async guild => {
        const list = getHatedUserIds(guild.id);
        return {
          guildId: guild.id,
          guildName: guild.name,
          users: await describeHatedUsers(list, guild.id)
        };
      }))
    : [];
  res.json({ success: true, groups: groups.filter(group => group.users.length > 0) });
});

app.post('/api/hate/add', (req, res) => {
  const { userId, guildId } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
  if (!ensureGuildAccess(req, res, guildId)) return;
  const result = addToHateList(userId, guildId);
  console.log(`[API] Hate list add: ${userId} in ${guildId} — ${result.message}`);
  if (result.ok) announceHateAdd(userId, guildId);
  res.json(result);
});

app.post('/api/hate/remove', (req, res) => {
  const { userId, guildId } = req.body;
  if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });
  if (!ensureGuildAccess(req, res, guildId)) return;
  const result = removeFromHateList(userId, guildId);
  console.log(`[API] Hate list remove: ${userId} in ${guildId} — ${result.message}`);
  res.json(result);
});

// ===== MEMORY FACTS ENDPOINTS =====
// Facts live in scopes: 'shared' (the global pool, superadmin-managed, recalled
// on every server) or a guild id (per-server, managed by that server's admins).
function resolveMemoryScope(req, res) {
  const scope = (req.body && req.body.scope) || req.query.scope;
  if (!scope) { res.status(400).json({ success: false, error: 'scope is required' }); return null; }
  if (scope === 'shared') {
    if (!dashboardAuth.isSuperAdmin(req)) { res.status(403).json({ success: false, error: 'superadmin only' }); return null; }
    return 'shared';
  }
  if (!dashboardAuth.canAccessGuild(req.user, scope)) { res.status(403).json({ success: false, error: 'forbidden' }); return null; }
  return scope;
}

app.get('/api/memory/facts', (req, res) => {
  const scope = resolveMemoryScope(req, res);
  if (!scope) return;
  res.json({
    success: true,
    scope,
    facts: getLongTermFacts('discord', 'global', undefined, scope),
    lastId: getLastConsolidatedId(scope),
  });
});

app.post('/api/memory/facts/add', (req, res) => {
  const scope = resolveMemoryScope(req, res);
  if (!scope) return;
  const fact = String((req.body && req.body.fact) || '').trim();
  const topics = Array.isArray(req.body && req.body.topics)
    ? req.body.topics
    : String((req.body && req.body.topics) || '').split(',');

  if (!fact) return res.status(400).json({ success: false, error: 'fact is required' });

  const facts = getLongTermFacts('discord', 'global', undefined, scope);
  if (facts.some(existing => existing.fact.toLowerCase() === fact.toLowerCase())) {
    return res.status(409).json({ success: false, error: 'That fact already exists' });
  }

  const updated = saveFacts('discord', 'global', [
    ...facts,
    { fact, pinned: true, topics: topics.map(topic => String(topic).trim().toLowerCase()).filter(Boolean) },
  ], scope);
  const added = updated.some(existing => existing.fact.toLowerCase() === fact.toLowerCase());
  if (!added) return res.status(400).json({ success: false, error: 'Fact could not be saved' });
  console.log(`[API] Memory fact added (${scope}): ${fact}`);
  res.json({ success: true, facts: updated });
});

app.post('/api/memory/facts/rebuild', async (req, res) => {
  const scope = resolveMemoryScope(req, res);
  if (!scope) return;
  if (scope === 'shared') {
    return res.status(400).json({ success: false, error: 'Shared memory is curated manually; rebuild runs per server.' });
  }
  try {
    const client = getDiscordClient();
    const guild = client && client.guilds.cache.get(scope);
    const channelIds = guild ? [...guild.channels.cache.keys()] : [];
    const result = channelIds.length
      ? await consolidateChannelFacts('discord', channelIds, true, scope)
      : { skipped: true, reason: 'no channels found for this server' };
    res.json({ success: true, ...result, facts: getLongTermFacts('discord', 'global', undefined, scope) });
  } catch (err) {
    console.error('[API] Memory rebuild error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to rebuild memory: ' + err.message });
  }
});

// Superadmin: copy a fact (usually from a server sheet) into the shared pool so
// Patrick recalls it on every server.
app.post('/api/memory/facts/promote', (req, res) => {
  if (!dashboardAuth.isSuperAdmin(req)) return res.status(403).json({ success: false, error: 'superadmin only' });
  const fact = String((req.body && req.body.fact) || '').trim();
  if (!fact) return res.status(400).json({ success: false, error: 'fact is required' });
  const topics = Array.isArray(req.body && req.body.topics)
    ? req.body.topics.map(t => String(t).trim().toLowerCase()).filter(Boolean)
    : [];
  const shared = getLongTermFacts('discord', 'global', undefined, 'shared');
  if (shared.some(f => f.fact.toLowerCase() === fact.toLowerCase())) {
    return res.status(409).json({ success: false, error: 'Already in shared memory' });
  }
  const saved = saveFacts('discord', 'global', [...shared, { fact, pinned: true, topics }], 'shared');
  console.log(`[API] Fact promoted to shared memory: ${fact}`);
  res.json({ success: true, facts: saved });
});

// Edit an existing fact (replace text/topics). Pinned status is preserved
// unless an explicit pinned toggle is passed.
app.post('/api/memory/facts/edit', (req, res) => {
  const scope = resolveMemoryScope(req, res);
  if (!scope) return;
  const target = String((req.body && req.body.oldFact) || '').trim();
  const newFact = String((req.body && req.body.fact) || '').trim();
  const topics = Array.isArray(req.body && req.body.topics)
    ? req.body.topics
    : String((req.body && req.body.topics) || '').split(',');

  if (!target || !newFact) {
    return res.status(400).json({ success: false, error: 'oldFact and fact are required' });
  }

  const facts = getLongTermFacts('discord', 'global', undefined, scope);
  const idx = facts.findIndex(f => f.fact.toLowerCase() === target.toLowerCase());
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Fact not found' });
  }

  if (newFact.toLowerCase() !== target.toLowerCase() &&
      facts.some(f => f.fact.toLowerCase() === newFact.toLowerCase())) {
    return res.status(409).json({ success: false, error: 'A fact with that text already exists' });
  }

  const hasPinOverride = Object.prototype.hasOwnProperty.call(req.body || {}, 'pinned');
  const updatedFact = {
    fact: newFact,
    topics: topics.map(topic => String(topic).trim().toLowerCase()).filter(Boolean),
    pinned: hasPinOverride ? !!req.body.pinned : !!facts[idx].pinned,
  };
  const updatedArr = facts.slice();
  updatedArr[idx] = updatedFact;

  const saved = replaceFacts('discord', 'global', updatedArr, scope);
  console.log(`[API] Memory fact edited (${scope}): ${target} -> ${newFact}`);
  res.json({ success: true, facts: saved, fact: saved.find(f => f.fact.toLowerCase() === newFact.toLowerCase()) });
});

// Delete a fact by text.
app.post('/api/memory/facts/delete', (req, res) => {
  const scope = resolveMemoryScope(req, res);
  if (!scope) return;
  const target = String((req.body && req.body.fact) || '').trim();
  if (!target) return res.status(400).json({ success: false, error: 'fact is required' });

  const facts = getLongTermFacts('discord', 'global', undefined, scope);
  const filtered = facts.filter(f => f.fact.toLowerCase() !== target.toLowerCase());
  if (filtered.length === facts.length) {
    return res.status(404).json({ success: false, error: 'Fact not found' });
  }

  const saved = replaceFacts('discord', 'global', filtered, scope);
  console.log(`[API] Memory fact deleted (${scope}): ${target}`);
  res.json({ success: true, facts: saved });
});

// Pin/unpin a fact by text.
app.post('/api/memory/facts/pin', (req, res) => {
  const scope = resolveMemoryScope(req, res);
  if (!scope) return;
  const target = String((req.body && req.body.fact) || '').trim();
  if (!target) return res.status(400).json({ success: false, error: 'fact is required' });

  const facts = getLongTermFacts('discord', 'global', undefined, scope);
  const idx = facts.findIndex(f => f.fact.toLowerCase() === target.toLowerCase());
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Fact not found' });
  }

  const pinned = !facts[idx].pinned;
  const updatedFact = { ...facts[idx], pinned };
  const updatedArr = facts.slice();
  updatedArr[idx] = updatedFact;

  const saved = replaceFacts('discord', 'global', updatedArr, scope);
  console.log(`[API] Memory fact ${pinned ? 'pinned' : 'unpinned'} (${scope}): ${target}`);
  res.json({ success: true, pinned, facts: saved });
});

app.get('/api/bot/logs', (req, res) => {
  const { platform, limit, guildId, all } = req.query;
  const maxResults = Math.min(parseInt(limit) || 100, 1000);
  // Command logs are per-server. "all" (every server) is superadmin-only.
  let filterGuildId = null;
  if (all === 'true') {
    if (!dashboardAuth.isSuperAdmin(req)) return res.status(403).json({ success: false, error: 'superadmin only' });
  } else {
    if (!ensureGuildAccess(req, res, guildId)) return;
    filterGuildId = guildId;
  }
  try {
    const dbLogs = getLogs(platform || 'all', maxResults, filterGuildId);
    const totalCount = getLogCount();
    const formattedLogs = dbLogs.reverse().map(log => ({
      platform: log.platform, username: log.username, command: log.command,
      message: log.message, response: log.response, image_url: log.image_url,
      error: log.error === 1, timestamp: log.timestamp, id: log.id, guildId: log.guild_id || null
    }));
    res.json({ success: true, count: formattedLogs.length, total: totalCount, logs: formattedLogs });
  } catch (error) {
    console.error('[API] Error fetching logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
});

app.get('/api/bot/system-logs', dashboardAuth.requireSuperAdmin, (req, res) => {
  const { log_type, severity, component, limit } = req.query;
  try {
    const filters = { log_type: log_type || 'all', severity: severity || 'all', component: component || 'all', limit: Math.min(parseInt(limit) || 100, 1000) };
    const systemLogs = getSystemLogs(filters);
    const totalCount = getSystemLogCount();
    const formattedLogs = systemLogs.map(log => ({
      id: log.id, timestamp: log.timestamp, log_type: log.log_type, severity: log.severity,
      component: log.component, message: log.message, stack_trace: log.stack_trace,
      metadata: log.metadata ? JSON.parse(log.metadata) : null
    }));
    res.json({ success: true, count: formattedLogs.length, total: totalCount, logs: formattedLogs });
  } catch (error) {
    console.error('[API] Error fetching system logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch system logs' }); }
});

app.post('/api/bot/logs/clear', dashboardAuth.requireSuperAdmin, (req, res) => {
  try {
    const success = clearLogs();
    if (success) { commandLogs = []; res.json({ success: true, message: 'Logs cleared' }); }
    else res.status(500).json({ success: false, error: 'Failed to clear logs' });
  } catch (error) { res.status(500).json({ success: false, error: 'Failed to clear logs' }); }
});

app.post('/api/bot/system-logs/clear', dashboardAuth.requireSuperAdmin, (req, res) => {
  try {
    const success = clearSystemLogs();
    if (success) res.json({ success: true, message: 'System logs cleared' });
    else res.status(500).json({ success: false, error: 'Failed to clear system logs' });
  } catch (error) { res.status(500).json({ success: false, error: 'Failed to clear system logs' }); }
});

// ===== MEMORIAL MESSAGE EXPORT =====
let discordClientRef = null;
global.setDiscordClientForExport = (client) => {
  discordClientRef = client;
  logSystem({
    log_type: 'EXPORT',
    severity: 'INFO',
    component: 'export',
    message: 'Discord client registered for memorial message export — bot is online and ready to export'
  });
  console.log('[EXPORT] Discord client registered for memorial message export');
};

// Shared getter so hate-list announcements (and anything else) can reach Discord.
function getDiscordClient() {
  return discordClientRef;
}

const exportJobs = {};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

async function runMessageExport(userId, jobId, guildId = null) {
  const job = exportJobs[jobId];

  if (!discordClientRef) {
    const errMsg = 'Discord client not available — make sure the bot is online and index.js calls setDiscordClientForExport(client)';
    job.status = 'error';
    job.error = errMsg;
    logSystem({
      log_type: 'EXPORT',
      severity: 'ERROR',
      component: 'export',
      message: `Export job ${jobId} failed to start: ${errMsg}`,
      metadata: { jobId, userId }
    });
    console.error('[EXPORT]', errMsg);
    return;
  }

  job.status = 'running';
  const messages = [];

  logSystem({
    log_type: 'EXPORT',
    severity: 'INFO',
    component: 'export',
    message: `Export job ${jobId} started for user ${userId}`,
    metadata: { jobId, userId }
  });

  try {
    // Scope to a single server unless this is a superadmin-wide export.
    const guildList = guildId
      ? [discordClientRef.guilds.cache.get(guildId)].filter(Boolean)
      : [...discordClientRef.guilds.cache.values()];
    for (const guild of guildList) {
      job.progress = `Scanning: ${guild.name}`;
      logSystem({
        log_type: 'EXPORT',
        severity: 'INFO',
        component: 'export',
        message: `Job ${jobId} — scanning guild: ${guild.name} (${guild.id})`,
        metadata: { jobId, guildId: guild.id, guildName: guild.name }
      });

      let channels;
      if (guild.channels.cache.size > 0) {
        channels = guild.channels.cache;
        logSystem({
          log_type: 'EXPORT',
          severity: 'INFO',
          component: 'export',
          message: `Job ${jobId} — using cached channels for ${guild.name} (${channels.size} channels)`,
          metadata: { jobId, guildId: guild.id, channelCount: channels.size }
        });
      } else {
        try {
          channels = await withTimeout(
            guild.channels.fetch(),
            10000,
            `guild.channels.fetch() for ${guild.name}`
          );
          logSystem({
            log_type: 'EXPORT',
            severity: 'INFO',
            component: 'export',
            message: `Job ${jobId} — fetched channels for ${guild.name} (${channels.size} channels)`,
            metadata: { jobId, guildId: guild.id, channelCount: channels.size }
          });
        } catch (e) {
          logSystem({
            log_type: 'EXPORT',
            severity: 'WARNING',
            component: 'export',
            message: `Job ${jobId} — could not fetch channels for guild ${guild.name}: ${e.message}`,
            stack_trace: e.stack,
            metadata: { jobId, guildId: guild.id }
          });
          continue;
        }
      }

      let channelCount = 0;
      let scannedCount = 0;

      for (const [, channel] of channels) {
        if (!channel || channel.type !== 0) continue;
        channelCount++;

        let perms;
        try { perms = channel.permissionsFor(guild.members.me); } catch (e) { continue; }
        if (!perms || !perms.has('ViewChannel') || !perms.has('ReadMessageHistory')) continue;

        scannedCount++;
        job.progress = `Scanning: ${guild.name} — #${channel.name} (${messages.length} found so far)`;

        logSystem({
          log_type: 'EXPORT',
          severity: 'INFO',
          component: 'export',
          message: `Job ${jobId} — scanning #${channel.name} in ${guild.name}`,
          metadata: { jobId, channelId: channel.id, channelName: channel.name, guildName: guild.name }
        });

        let lastId = null;
        let fetched;
        do {
          try {
            const opts = { limit: 100 };
            if (lastId) opts.before = lastId;
            fetched = await withTimeout(
              channel.messages.fetch(opts),
              15000,
              `messages.fetch() in #${channel.name}`
            );
          } catch (e) {
            logSystem({
              log_type: 'EXPORT',
              severity: 'WARNING',
              component: 'export',
              message: `Job ${jobId} — error reading #${channel.name} in ${guild.name}: ${e.message}`,
              stack_trace: e.stack,
              metadata: { jobId, channelId: channel.id, channelName: channel.name, guildName: guild.name }
            });
            break;
          }

          for (const [, msg] of fetched) {
            if (msg.author.id === userId) {
              messages.push({
                id: msg.id,
                timestamp: msg.createdAt.toISOString(),
                guild: guild.name,
                channel: channel.name,
                channel_id: channel.id,
                content: msg.content,
                attachments: msg.attachments.map(a => a.url),
                jump_url: `https://discord.com/channels/${guild.id}/${channel.id}/${msg.id}`
              });
            }
          }
          lastId = fetched.size === 100 ? fetched.last().id : null;
        } while (fetched.size === 100);
      }

      logSystem({
        log_type: 'EXPORT',
        severity: 'INFO',
        component: 'export',
        message: `Job ${jobId} — finished guild ${guild.name}: scanned ${scannedCount}/${channelCount} text channels, ${messages.length} messages found so far`,
        metadata: { jobId, guildId: guild.id, scannedCount, channelCount, runningTotal: messages.length }
      });
    }

    job.status = 'done';
    job.progress = `Complete \u2014 ${messages.length} messages found`;
    job.messages = messages;
    job.count = messages.length;
    job.completedAt = new Date().toISOString();

    logSystem({
      log_type: 'EXPORT',
      severity: 'INFO',
      component: 'export',
      message: `Export job ${jobId} completed successfully \u2014 ${messages.length} messages found for user ${userId}`,
      metadata: { jobId, userId, messageCount: messages.length }
    });
    console.log(`[EXPORT] Job ${jobId} complete: ${messages.length} messages for user ${userId}`);

  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    logSystem({
      log_type: 'EXPORT',
      severity: 'ERROR',
      component: 'export',
      message: `Export job ${jobId} threw an unexpected error: ${err.message}`,
      stack_trace: err.stack,
      metadata: { jobId, userId }
    });
    console.error(`[EXPORT] Job ${jobId} failed:`, err.message);
  }
}

app.post('/api/export/start', (req, res) => {
  const { userId, guildId } = req.body;
  if (!userId || !/^\d{17,20}$/.test(userId)) {
    return res.status(400).json({ success: false, error: 'Invalid Discord user ID \u2014 must be 17-20 digits' });
  }
  // Server admins can export only their own server; a bot-wide export is
  // superadmin-only.
  if (guildId) {
    if (!ensureGuildAccess(req, res, guildId)) return;
  } else if (!dashboardAuth.isSuperAdmin(req)) {
    return res.status(403).json({ success: false, error: 'A server must be selected (or superadmin required for a full export)' });
  }
  const jobId = Date.now().toString();
  exportJobs[jobId] = { status: 'queued', userId, guildId: guildId || null, progress: 'Starting...', startedAt: new Date().toISOString() };
  logSystem({
    log_type: 'EXPORT',
    severity: 'INFO',
    component: 'export',
    message: `Export job ${jobId} queued for user ID ${userId}${guildId ? ` in guild ${guildId}` : ' (all servers)'}`,
    metadata: { jobId, userId, guildId: guildId || null }
  });
  runMessageExport(userId, jobId, guildId || null);
  res.json({ success: true, jobId });
});

// Status/download share the same access rule: a job tied to a guild requires
// access to that guild, otherwise superadmin.
function canReachExportJob(req, res, job) {
  if (job.guildId) {
    if (!dashboardAuth.canAccessGuild(req.user, job.guildId)) {
      res.status(403).json({ success: false, error: 'forbidden' });
      return false;
    }
    return true;
  }
  if (!dashboardAuth.isSuperAdmin(req)) {
    res.status(403).json({ success: false, error: 'superadmin only' });
    return false;
  }
  return true;
}

app.get('/api/export/status/:jobId', (req, res) => {
  const job = exportJobs[req.params.jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  if (!canReachExportJob(req, res, job)) return;
  res.json({ success: true, jobId: req.params.jobId, userId: job.userId, status: job.status, progress: job.progress, count: job.count || 0, error: job.error || null, startedAt: job.startedAt || null, completedAt: job.completedAt || null });
});

app.get('/api/export/download/:jobId', (req, res) => {
  const job = exportJobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Export not ready or job not found' });
  if (!canReachExportJob(req, res, job)) return;
  const format = req.query.format || 'json';
  logSystem({
    log_type: 'EXPORT',
    severity: 'INFO',
    component: 'export',
    message: `Export job ${req.params.jobId} downloaded as ${format.toUpperCase()} (${job.count} messages)`,
    metadata: { jobId: req.params.jobId, format, messageCount: job.count }
  });
  if (format === 'csv') {
    const header = 'id,timestamp,guild,channel,content,attachments,jump_url\n';
    const rows = job.messages.map(m =>
      [m.id, m.timestamp, `"${m.guild}"`, `"${m.channel}"`,
       `"${(m.content || '').replace(/"/g, "'")}"`,
       `"${m.attachments.join('|')}"`,
       m.jump_url].join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="export-${job.userId}.csv"`);
    res.send(header + rows);
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="export-${job.userId}.json"`);
    res.send(JSON.stringify(job.messages, null, 2));
  }
});

app.listen(PORT, HOST, () => {
  logSystem({
    log_type: 'STARTUP',
    severity: 'INFO',
    component: 'dashboard',
    message: `Dashboard server started on ${HOST}:${PORT}`
  });
  console.log(`Dashboard on http://${HOST}:${PORT}/`);
  console.log(`Current persona: ${getCurrentPersona().name}`);
});
