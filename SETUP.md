# Setup & Deployment

> **Before you clone this:** ThePatrick is licensed under [BSL 1.1](LICENSE). The code is public to read, study, and modify. Running it as a live Discord or Twitch bot ("Production Use") requires a license from the developer, whether self-hosted or not. This guide covers permitted non-production setup: local testing, development, evaluation. If you want Patrick actually running on your server, don't start here. Reach out via **[birdsserver.cfd](https://birdsserver.cfd/)** or open a [GitHub issue](https://github.com/BirdTruther/ThePatrick/issues) instead.

---

## Prerequisites

- Node.js ≥ 20.18.1
- `yt-dlp` and `ffmpeg` system binaries (for music)
- A Discord application with a bot token
- A Twitch account for the bot user + OAuth token

---

## Installation

### 1. Clone

```bash
git clone https://github.com/BirdTruther/ThePatrick.git
cd ThePatrick
```

### 2. Install npm dependencies

```bash
npm ci
```

### 3. Install system dependencies

```bash
# yt-dlp
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# ffmpeg
sudo apt install ffmpeg
```

### 4. Create `.env`

```bash
cp .env.example .env
```

Then fill in your values:

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | [Developer Portal](https://discord.com/developers/applications) → Bot → Token |
| `DISCORD_CLIENT_ID` | ✅ | Developer Portal → General Information → Application ID |
| `GOOGLE_GENERATIVE_AI_API_KEY` | ✅ | [aistudio.google.com](https://aistudio.google.com) |
| `TWITCH_BOT_USERNAME` | ✅ | Your Twitch bot account username |
| `TWITCH_OAUTH_TOKEN` | ✅ | [twitchapps.com/tmi](https://twitchapps.com/tmi) |
| `TWITCH_CHANNEL` | ✅ | Your Twitch channel name (no `#`) |
| `EFT_API_KEY` | Optional | [eft-api.tech](https://eft-api.tech) — required for `/player` |
| `STEAM_API_KEY` | Optional | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) — required for `/cs2stats` |

### 5. Start

```bash
# Bot
node index.js

# Dashboard (separate terminal)
node dashboard-server.js
# → http://localhost:3001
```

### Multi-server behavior

The bot registers slash commands globally and can be invited to multiple
Discord servers while running as one process. Persona and long-term facts are
shared globally. Hate lists, roast channels, and the dashboard's Roast Pings
toggle are isolated per Discord server.

The dashboard's hate controls include a server selector. Configure `/hate
channel` separately in each server where proactive roasts should run.

### Per-server features

The dashboard's "Managing server" picker (top of the page) scopes everything
server-specific. It only lists servers where you have Owner / Manage Server /
Administrator and the bot is present.

| Feature | Scope |
|---|---|
| Persona | per server (Twitch/DMs use the global default) |
| Hate list, roast channel, Roast Pings | per server |
| Cultist alerts (channel + optional role ping) | per server |
| Server facts | per server; admins manage their own |
| Shared memory facts | global — recalled on every server, superadmin-curated |
| Command logs | per server (superadmin can view all) |
| System logs | superadmin only |

- **Cultist alerts:** set the alert channel ID and optional role ID per server in
  the Cultist card, then enable the toggle. The bot posts when the Tarkov night
  window opens/closes.
- **Shared memory:** open Bot Memory, tick "Shared memory (all servers)" (bot
  owner only) to curate the global pool, or press "Share" on a server fact to
  promote it so Patrick recalls it everywhere.
- Command logs written before this change have no server tag and appear only in
  the superadmin "All servers" view.

### Dashboard login (Discord OAuth)

The dashboard is protected by Discord OAuth login and binds to `127.0.0.1` by
default. To expose it publicly, put a reverse proxy in front of it and set:

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_CLIENT_SECRET` | ✅ | Developer Portal → OAuth2 → Client Secret |
| `DASHBOARD_OAUTH_REDIRECT_URI` | ✅* | Public callback URL, e.g. `https://dash.example.com/auth/callback` |
| `DASHBOARD_ALLOWED_USER_IDS` | ✅* | Comma-separated Discord user IDs allowed to log in |
| `DASHBOARD_ALLOW_GUILD_ADMINS` | Optional | `true` lets users with Manage Server/Admin in a shared server log in |
| `DASHBOARD_HOST` | Optional | Defaults to `127.0.0.1`; set `0.0.0.0` only for trusted LAN access |

\* Set at least one of `DASHBOARD_ALLOWED_USER_IDS` or
`DASHBOARD_ALLOW_GUILD_ADMINS=true`, or nobody can log in.

Setup steps:

1. Developer Portal → your app → **OAuth2 → Redirects**: add the exact callback
   URL (for example `https://dash.example.com/auth/callback`).
2. Set the variables above in `.env`.
3. Point your reverse proxy at `http://127.0.0.1:3001`.
4. Start (or restart) the process.

To find your Discord user ID: enable Developer Mode, then right-click your
avatar → Copy User ID.

For quick local testing only, `DASHBOARD_AUTH_DISABLED=true` turns the login
off (never use it on a publicly reachable instance).

---

## Discord Bot Invite Scopes

Include both when generating your bot invite URL:
- `bot`
- `applications.commands`

---

## systemd Service (Linux)

Create `/etc/systemd/system/discordbot.service`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable discordbot
sudo systemctl start discordbot

# Live logs
sudo journalctl -u discordbot -f
```

---

## Updating

Use `update_bot.sh` to pull and redeploy cleanly:

```bash
bash /home/birds/birds-server-ai-bot/update_bot.sh
```

The script: hard-resets local changes → pulls from GitHub → runs `npm ci` → rebuilds native modules → restarts the service → tails logs.

> ⚠️ **Never edit files directly on the server.** All changes must go through GitHub. The update script enforces this with `git reset --hard`.

---

## Music Troubleshooting

If the bot won't join voice and you see:

```
[VOICE WS CLOSE] code=4017 reason=E2EE/DAVE protocol required
```

Run:

```bash
npm install @discordjs/voice@0.19.2
sudo systemctl restart discordbot
```

---

## Configuration Reference

| Setting | Default | Location |
|---|---|---|
| Dashboard port | `3001` | `dashboard-server.js` |
| Twitch message limit | 490 chars | `services/twitch.js` |
| Twitch message delay | 1.5s | `services/twitch.js` |
| Cultist status interval | 30s | `index.js` |
| Image rate limit | 3 per user / 60s | `services/image.js` |
| Long-term fact max | 25 facts | `memory.js` → `FACT_MAX` |
| Long-term fact max length | 140 chars | `memory.js` → `FACT_MAX_LEN` |
| Recent context messages | 8 | `memory.js` → `CONFIG.MAX_CONTEXT_MESSAGES` |
| Hate ping window | 4 per 10 min, min 45s gap | `hate-manager.js` → `RATE_WINDOW_MS` / `MAX_PINGS_PER_WINDOW` / `MIN_GAP_MS` |
| CS2 case key cost | $2.49 | `commands/cs2.js` → `CONFIG.CS2_KEY_COST_USD` |
| CS2 case max opens | 100 | `commands/cs2.js` → `CONFIG.CS2_CASE_MAX_OPENS` |
| Presence rotation interval | 5 min | `index.js` → `CONFIG.PRESENCE_ROTATE_MS` |

### Tarkov Time
- 7× real-time ratio, Russia timezone (+3h)
- Cultist spawn window: **22:00–07:00** in-game time

---

## `/pickplayers`

`/pickplayers` randomly selects members from the server (optionally voice-only or role-filtered) — handy for building CS2 lobbies. It runs entirely in-process and requires no special permissions, so there's nothing to configure. If you don't want it, delete `commands/admin.js` and remove the `admin` import + command registration from `index.js`.

---

## Dashboard API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/bot/status` | Uptime and system stats |
| `GET` | `/api/bot/logs` | Command log history |
| `POST` | `/api/bot/logs/clear` | Clear command logs |
| `GET` | `/api/bot/system-logs` | System/event log history |
| `POST` | `/api/bot/system-logs/clear` | Clear system logs |
| `GET` | `/api/persona/current` | Current persona |
| `POST` | `/api/persona/set` | Set persona `{ "persona": "key" }` |
| `GET` | `/api/cultist/status` | Cultist tracker state |
| `POST` | `/api/cultist/toggle` | Enable/disable Cultist notifications |
| `GET` | `/api/hate/list` | Current hate list (user IDs) |
| `POST` | `/api/hate/add` | Add to hate list `{ "userId": "..." }` |
| `POST` | `/api/hate/remove` | Remove from hate list `{ "userId": "..." }` |
| `GET` | `/api/hate/pings/status` | Roast-pings toggle state |
| `POST` | `/api/hate/pings/toggle` | Enable/disable roast pings `{ "enabled": bool }` |
| `GET` | `/api/memory/facts` | Current server-wide long-term memory fact sheet |
| `POST` | `/api/memory/facts/add` | Add a fact (auto-pinned) `{ "fact": "...", "topics": "..." }` |
| `POST` | `/api/memory/facts/edit` | Edit a fact `{ "oldFact": "...", "fact": "...", "topics": "..." }` |
| `POST` | `/api/memory/facts/delete` | Delete a fact `{ "fact": "..." }` |
| `POST` | `/api/memory/facts/pin` | Pin/unpin a fact `{ "fact": "..." }` |
| `POST` | `/api/memory/facts/rebuild` | Force-rebuild the server-wide fact sheet |
| `POST` | `/api/export/start` | Start a memorial-message export |
| `GET` | `/api/export/status/:jobId` | Export job status |
| `GET` | `/api/export/download/:jobId` | Download completed export |

## DM control channel (optional)

Lets allowlisted Discord users DM Patrick to drive an OpenCode agent on the server. **The agent has full shell access as the service user**, so `DM_ALLOWLIST` is the only thing between a Discord account and the server. Use 2FA on any allowlisted account.

1. Set `DM_ALLOWLIST`, `OPENCODE_SERVER_PASSWORD` and the other `DM_*` values in `.env` (see `.env.example`).
2. Run `opencode serve --hostname 127.0.0.1 --port 4096` as a service with the same password in its environment. Never bind it beyond localhost.
3. Point OpenCode at the read-only tools with an `OPENCODE_CONFIG` file containing:
   ```json
   { "mcp": { "patrick-ops": { "type": "local", "command": ["node", "/path/to/mcp/patrick-ops.js"], "enabled": true } } }
   ```

DM commands: `!cancel` stops the run, `!status` shows what is running, `!new` starts a fresh session. Anything else goes to the agent, continuing the last session. Runs stop after `DM_AGENT_TIMEOUT_MS` (10 minutes by default).

Tests: `node --test test/`

## AI backend

Chat, photo understanding and `/imagine` all run on Cloudflare Workers AI. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `.env`, with a token limited to Workers AI. The free plan's daily allowance is shared across all of them and resets at midnight UTC. Paid-only models fail on a free account.
