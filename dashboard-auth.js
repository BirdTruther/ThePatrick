// dashboard-auth.js
// Discord OAuth2 login + session gating for the web dashboard.
//
// Security model:
//  - The dashboard is served same-origin, so no cross-origin CORS is needed.
//  - Every route except /auth/* (and /api/auth/me) requires a valid session.
//  - A session is only issued to users who are either explicitly allowlisted
//    (DASHBOARD_ALLOWED_USER_IDS) or, when DASHBOARD_ALLOW_GUILD_ADMINS=true,
//    hold Manage Server / Administrator in a Discord server the bot is in.
//
// Required env: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
// Optional env: DASHBOARD_OAUTH_REDIRECT_URI, DASHBOARD_ALLOWED_USER_IDS,
//               DASHBOARD_ALLOW_GUILD_ADMINS, DASHBOARD_HOST
// Dev escape hatch: DASHBOARD_AUTH_DISABLED=true (logs a loud warning)

const crypto = require('crypto');
const { getSetting, setSetting, db } = require('./database.js');

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'patrick_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_PREFIX = 'dashboard_session:';

// Discord permission bits (value is a bitfield string from the API)
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_GUILD = 1n << 5n;

const pendingStates = new Map(); // state -> expiresAt

function config() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    disabled: String(process.env.DASHBOARD_AUTH_DISABLED || '') === 'true',
    allowGuildAdmins: String(process.env.DASHBOARD_ALLOW_GUILD_ADMINS || 'false') === 'true',
    allowedIds: (process.env.DASHBOARD_ALLOWED_USER_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  };
}

function warnIfMisconfigured() {
  const c = config();
  if (c.disabled) {
    console.warn('[AUTH] ⚠️  DASHBOARD_AUTH_DISABLED=true — the dashboard is OPEN to anyone who can reach it. Do not expose it publicly.');
    return;
  }
  if (!c.clientId || !c.clientSecret) {
    console.warn('[AUTH] ⚠️  Discord OAuth is not configured (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET missing). All dashboard pages will return an error until it is set.');
  }
  if (c.allowedIds.length === 0 && !c.allowGuildAdmins) {
    console.warn('[AUTH] ⚠️  No DASHBOARD_ALLOWED_USER_IDS set and DASHBOARD_ALLOW_GUILD_ADMINS is false — nobody will be able to log in.');
  }
}

// ===== COOKIE HELPERS =====
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function setSessionCookie(req, res, id, maxAgeMs) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ===== SESSION STORE (persisted in bot_settings so deploys don't sign everyone out) =====
function createSession(user, verdict = {}) {
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    id,
    userId: user.id,
    username: user.username,
    globalName: user.global_name || null,
    avatar: user.avatar || null,
    superAdmin: Boolean(verdict.superAdmin),
    adminGuildIds: Array.isArray(verdict.adminGuildIds) ? verdict.adminGuildIds.map(String) : [],
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  setSetting(SESSION_PREFIX + id, JSON.stringify(session));
  return session;
}

function getSession(id) {
  if (!id) return null;
  const raw = getSetting(SESSION_PREFIX + id, null);
  if (!raw) return null;
  let session;
  try { session = JSON.parse(raw); } catch { return null; }
  if (!session || !session.expiresAt || session.expiresAt < Date.now()) {
    setSetting(SESSION_PREFIX + id, '');
    return null;
  }
  // Reconcile the role on every request so changing the allowlist takes effect
  // without requiring users to manually clear an otherwise-valid session.
  const shouldBeSuperAdmin = config().allowedIds.includes(String(session.userId));
  if (Boolean(session.superAdmin) !== shouldBeSuperAdmin) {
    session.superAdmin = shouldBeSuperAdmin;
    setSetting(SESSION_PREFIX + id, JSON.stringify(session));
  }
  return session;
}

function destroySession(id) {
  if (id) setSetting(SESSION_PREFIX + id, '');
}

function currentSession(req) {
  return getSession(parseCookies(req)[SESSION_COOKIE]);
}

// ===== OAUTH HELPERS =====
function redirectUri(req) {
  if (process.env.DASHBOARD_OAUTH_REDIRECT_URI) return process.env.DASHBOARD_OAUTH_REDIRECT_URI;
  return `${req.protocol}://${req.get('host')}/auth/callback`;
}

function makeState() {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state) {
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(exp) && exp > Date.now();
}

async function exchangeCode(code, redirect) {
  const c = config();
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
  });
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  return res.json();
}

async function discordGet(path, token) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Discord GET ${path} failed (${res.status})`);
  return res.json();
}

function evaluateAccess(user, userGuilds, getDiscordClient, c) {
  const superAdmin = c.allowedIds.includes(String(user.id));

  // Guilds where this user has owner / admin / manage-server.
  const adminGuildIds = [];
  for (const g of userGuilds || []) {
    let perms = 0n;
    try { perms = BigInt(g.permissions || 0); } catch { perms = 0n; }
    if (g.owner || (perms & PERM_ADMINISTRATOR) || (perms & PERM_MANAGE_GUILD)) {
      adminGuildIds.push(g.id);
    }
  }

  if (superAdmin) {
    return { ok: true, reason: 'allowlisted', superAdmin, adminGuildIds };
  }
  if (!c.allowGuildAdmins) {
    return { ok: false, reason: 'not on the allowlist', superAdmin, adminGuildIds };
  }

  const client = typeof getDiscordClient === 'function' ? getDiscordClient() : null;
  const shared = new Set(client ? [...client.guilds.cache.keys()] : []);
  if (adminGuildIds.some(id => shared.has(id))) {
    return { ok: true, reason: 'guild admin', superAdmin, adminGuildIds };
  }
  return { ok: false, reason: 'no admin access in a shared server', superAdmin, adminGuildIds };
}

// True if the session may view/manage a specific guild's settings.
function canAccessGuild(session, guildId) {
  if (config().disabled) return true;
  if (!session || !guildId) return false;
  if (session.superAdmin) return true;
  return Array.isArray(session.adminGuildIds) && session.adminGuildIds.includes(String(guildId));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function authErrorPage(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>ThePatrick // Dashboard</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:radial-gradient(900px 480px at 50% -10%,rgba(92,186,160,.10) 0,rgba(92,186,160,0) 60%),#181714;color:#f1ede4;line-height:1.55}
.card{width:100%;max-width:460px;padding:28px;background:#211f1b;border:1px solid #35322b;border-radius:16px;box-shadow:0 30px 70px -30px rgba(0,0,0,.95);text-align:center}
.mark{width:44px;height:44px;margin:0 auto 16px;display:grid;place-items:center;border-radius:13px;background:#14131a;border:1px solid #35322b}
.mark img{width:32px;height:32px;display:block}
h1{margin:0 0 8px;font-size:1.2rem;letter-spacing:-.02em}
p{margin:0 0 18px;color:#a49d8f;font-size:.92rem}
a{display:inline-flex;padding:9px 16px;border-radius:10px;background:#5cbaa0;color:#0d1a16;text-decoration:none;font-weight:700;font-size:.88rem}
a:hover{background:#74cdb4}
</style></head>
<body><div class="card">
<div class="mark"><img src="/logo.png" alt="" width="32" height="32" decoding="async"></div>
<h1>ThePatrick Dashboard</h1>
<p>${escapeHtml(message)}</p>
<a href="/auth/login">Try again</a>
</div></body></html>`;
}

function authLandingPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>ThePatrick // Dashboard</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;padding:28px 20px 40px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:radial-gradient(1100px 520px at 15% -12%,rgba(92,186,160,.10) 0,rgba(92,186,160,0) 62%),radial-gradient(900px 480px at 100% 0,rgba(230,180,95,.07) 0,rgba(230,180,95,0) 55%),#181714;color:#f1ede4;line-height:1.55}
.shell{width:min(960px,100%);margin:0 auto}
.banner{display:block;width:100%;height:auto}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.hero{padding:36px 0 30px;max-width:660px}
.hero p{margin:0 0 22px;color:#a49d8f;font-size:1rem;max-width:560px}
.status{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:#1b3024;border:1px solid #2e4b3a;color:#8ad9ab;font-size:.76rem;font-weight:600}
.status i{width:6px;height:6px;border-radius:50%;background:#6ecf98}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}
.login,.site{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:11px;text-decoration:none;font-weight:600;font-size:.9rem}
.login{background:#5cbaa0;color:#0d1a16}
.login:hover{background:#74cdb4}
.site{background:#211f1b;border:1px solid #4b473d;color:#d8d2c6}
.site:hover{background:#292620}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:34px}
.card{padding:18px;background:#211f1b;border:1px solid #35322b;border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.45)}
.card h2{margin:0 0 6px;font-size:.92rem;letter-spacing:-.01em}
.card p{margin:0;color:#a49d8f;font-size:.84rem}
.tag{display:inline-block;margin-bottom:10px;padding:3px 8px;border-radius:999px;background:#1d322c;color:#a6e2d2;font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid #35322b;color:#847e71;font-size:.76rem;text-align:center}
@media(max-width:600px){body{padding:20px 14px 32px}.hero{padding:40px 0 24px}}
</style></head>
<body><main class="shell">
<img class="banner" src="/readme-banner.png" width="1280" height="360" alt="ThePatrick — Discord and Twitch bot for the Birds Server">
<section class="hero">
<h1 class="sr-only">ThePatrick Dashboard</h1>
<p>Sign in with Discord to choose how Patrick talks — aggressive, sassy, nice, paranoid, or half asleep — and manage the roast list, Cultist alerts, and memory for the servers you administer.</p>
<div class="status"><i></i>Discord sign-in required</div>
<div class="actions"><a class="login" href="/auth/login?start=1">Sign in with Discord</a><a class="site" href="https://birdsserver.cfd/" target="_blank" rel="noopener">Visit the Birds Server</a></div>
</section>
<section class="grid">
<article class="card"><span class="tag">Persona</span><h2>Five Patricks, one bot</h2><p>Aggressive, sassy, nice, conspiracy-minded, or half asleep. Each server keeps its own pick, and you can preview the voice before applying it.</p></article>
<article class="card"><span class="tag">Per server</span><h2>One console, every server</h2><p>Pick a server you manage and change only that server's settings.</p></article>
<article class="card"><span class="tag">Memory</span><h2>Local facts, shared recall</h2><p>Admins manage their own facts; the owner can promote the good ones everywhere.</p></article>

</section>
<footer class="footer">ThePatrick // Birds Server bot // Authorized operators only</footer>
</main></body></html>`;
}

// ===== ROUTES =====
function attachRoutes(app, options = {}) {
  const getDiscordClient = options.getDiscordClient;

  app.get('/auth/login', (req, res) => {
    const c = config();
    if (c.disabled) return res.redirect('/');
    if (!c.clientId || !c.clientSecret) {
      return res.status(500).send(authErrorPage('Dashboard login is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.'));
    }
    // Show a branded landing page before explicitly starting OAuth.
    if (req.query.start !== '1') return res.send(authLandingPage());
    const redirect = redirectUri(req);
    const state = makeState();
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', c.clientId);
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.get('/auth/callback', async (req, res) => {
    const c = config();
    if (c.disabled) return res.redirect('/');
    const { code, state } = req.query;
    if (!code || !state || !consumeState(String(state))) {
      return res.status(400).send(authErrorPage('Invalid or expired login attempt. Please try again.'));
    }
    try {
      const redirect = redirectUri(req);
      const token = await exchangeCode(String(code), redirect);
      const user = await discordGet('/users/@me', token.access_token);
      let userGuilds = [];
      try {
        userGuilds = await discordGet('/users/@me/guilds', token.access_token);
      } catch (guildErr) {
        console.warn('[AUTH] Could not fetch user guilds:', guildErr.message);
      }
      const verdict = evaluateAccess(user, userGuilds, getDiscordClient, c);
      if (!verdict.ok) {
        console.warn(`[AUTH] Denied login for ${user.username} (${user.id}): ${verdict.reason}`);
        return res.status(403).send(authErrorPage(`Access denied: ${verdict.reason}.`));
      }
      const session = createSession(user, verdict);
      setSessionCookie(req, res, session.id, SESSION_TTL_MS);
      console.log(`[AUTH] Login: ${user.username} (${user.id}) — ${verdict.reason}`);
      res.redirect('/');
    } catch (err) {
      console.error('[AUTH] OAuth callback failed:', err.message);
      res.status(500).send(authErrorPage('Login failed. Check the server logs and try again.'));
    }
  });

  app.get('/auth/logout', (req, res) => {
    destroySession(parseCookies(req)[SESSION_COOKIE]);
    clearSessionCookie(req, res);
    res.redirect('/auth/login');
  });

  app.get('/api/auth/me', (req, res) => {
    const session = currentSession(req);
    if (!session) return res.json({ success: true, authenticated: false });
    res.json({
      success: true,
      authenticated: true,
      user: {
        id: session.userId,
        username: session.username,
        globalName: session.globalName,
        avatar: session.avatar,
        superAdmin: Boolean(session.superAdmin),
      },
    });
  });

  // Servers the logged-in user may manage (bot is present AND user is admin).
  app.get('/api/auth/guilds', (req, res) => {
    const c = config();
    const session = currentSession(req);
    if (!c.disabled && !session) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    const client = typeof getDiscordClient === 'function' ? getDiscordClient() : null;
    const all = client ? [...client.guilds.cache.values()] : [];
    const guilds = all
      .filter(g => c.disabled || session.superAdmin || (session.adminGuildIds || []).includes(g.id))
      .map(g => ({ id: g.id, name: g.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, guilds });
  });
}

// ===== GATE =====
function requireAuth(req, res, next) {
  const c = config();
  if (c.disabled) return next();
  const session = currentSession(req);
  if (session) {
    req.user = session;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  return res.redirect('/auth/login');
}

// ===== SUPERADMIN GATE =====
// Superadmins are the allowlisted owners. When auth is disabled (local dev)
// everything is treated as superadmin.
function isSuperAdmin(req) {
  if (config().disabled) return true;
  return Boolean(req.user && req.user.superAdmin);
}

function requireSuperAdmin(req, res, next) {
  if (isSuperAdmin(req)) return next();
  res.status(403).json({ success: false, error: 'superadmin only' });
}

// Periodic cleanup of expired sessions + states
setInterval(() => {
  try {
    const rows = db.prepare('SELECT key, value FROM bot_settings WHERE key LIKE ?').all(`${SESSION_PREFIX}%`);
    const now = Date.now();
    for (const row of rows) {
      let s = null;
      try { s = JSON.parse(row.value); } catch { s = null; }
      if (!s || !s.expiresAt || s.expiresAt < now) setSetting(row.key, '');
    }
  } catch (err) {
    console.error('[AUTH] session sweep failed:', err.message);
  }
  const now = Date.now();
  for (const [state, exp] of pendingStates) {
    if (exp < now) pendingStates.delete(state);
  }
}, 30 * 60 * 1000);

warnIfMisconfigured();

module.exports = { attachRoutes, requireAuth, canAccessGuild, requireSuperAdmin, isSuperAdmin };
