# ThePatrick

![Version](https://img.shields.io/github/v/release/BirdTruther/ThePatrick)

Multi-platform Discord + Twitch bot with Escape from Tarkov integration, CS2 integration, AI chat, voice music, roleplay features, and a live web dashboard.

**[Commands →](COMMANDS.md)** | **[Self-Hosting & License →](SETUP.md)**

---

## Want Patrick on your server?

Head to **[birdsserver.cfd](https://birdsserver.cfd/)**. Discord and GitHub contact links are there. The source is public and readable, but running Patrick live, self-hosted or otherwise, requires a license under [BSL 1.1](LICENSE). Getting him onto your server starts with reaching out, not cloning the repo.

---

## What It Does

- **AI chat** — Mention the bot or reply to it. Supports text, image understanding, and image generation via Cloudflare Workers AI, using its free daily allowance.
- **DM control** — Allowlisted users can DM Patrick to run an OpenCode agent on the server, with progress updates, a summary of the result, and `!cancel`, `!status` and `!new`. Everyone else is silently ignored. See [Self-Hosting](SETUP.md).
- **Server status tools** — The DM agent gets a read-only MCP server for system, disk, log, bot, Docker, backup and re-encode status.
- **Long-term memory** — The AI builds one durable server-wide "fact sheet" (names, mains, inside jokes) and references it across channels; also feeds roasts. Hourly, cost-bounded consolidation, with **pinned facts** that survive AI rewrites.
- **Tarkov** — Item prices, ammo rankings, trader timers, map/boss info, player stats.
- **Tarkov Allergies** — Roleplay allergy tracking; log and compare what members are allergic to.
- **Hate List** — Admin-managed roleplay roast list; the bot tags and roasts listed users with AI-generated lines, unless roast pings are toggled off. Any listed user can self-opt-out with `/hate remove-me`.
- **CS2** — Player stats and a case simulator with real cases, skin pictures, wear, Steam prices and a server leaderboard. The case list and prices update themselves daily.
- **Music** — YouTube voice playback via `yt-dlp` + `ffmpeg`. No API key required.
- **Twitch** — Connects to Twitch IRC and relays messages to Discord.
- **Dashboard** — Live web UI at `http://localhost:3001` for logs, persona switching, hate list (with a roast-pings toggle), long-term memory management (add/pin/edit/delete facts), and Cultist tracking.

---

## Stack

| Layer | What |
|---|---|
| Runtime | Node.js ≥ 20.18.1 |
| Discord | discord.js 14 + @discordjs/voice 0.19.2 |
| AI | Cloudflare Workers AI: Llama 4 Scout for chat and photos, Gemma 4 as fallback, FLUX schnell for images |
| DM agent | `opencode serve` on localhost, with DeepSeek V4.1 Flash through OpenCode Go |
| Database | SQLite via `better-sqlite3` |
| Dashboard | Express + vanilla HTML |
| Music | `yt-dlp` + `ffmpeg` (system binaries) |
| Twitch | `tmi.js` |

---

## Module Layout

```
index.js                    # Entry point — Discord client, slash registration, event routing
dashboard-server.js         # Express API + dashboard frontend
music.js                    # Music slash command handler (ACTIVE)
music-player.js             # Voice engine — yt-dlp, ffmpeg, DAVE E2EE (ACTIVE)
music-player.deprecated.js  # Previous rewrite — reference only, not loaded at runtime
memory.js                   # SQLite conversation context + long-term fact sheet
database.js                 # SQLite schema, log tables
logger.js                   # Structured logging to console + dashboard stream
personas.js                 # AI personality definitions
persona-manager.js          # Persona state and switching logic
hate-manager.js             # Hate list storage, roast pools, ping cooldowns
dm-handler.js               # DM routing, allowlist, !cancel/!status/!new, result delivery
dm-runner.js                # OpenCode server client — sessions, permissions, progress, timeout
mcp/
  patrick-ops.js            # Read-only MCP server for the DM agent
test/                       # Unit tests — run with: node --test test/
commands/
  utility.js                # /ask, /imagine, /meme, /code, /persona, /personas
  admin.js                  # /pickplayers
  cs2.js                    # /cs2stats
  cs2-case.js               # /cs2case and /cs2leaderboard
  tarkov.js                 # All Tarkov commands
  allergies.js              # Tarkov roleplay allergy commands
  hate.js                   # /hate add|remove|remove-me|list|channel
services/
  ai.js                     # Text generation + vision, through cloudflare-chat.js
  cloudflare-chat.js        # Workers AI chat client
  cs2-catalog.js            # Daily case, skin and price data
  cs2-case.js               # Case rolls and per-server totals
  image.js                  # Cloudflare Workers AI image generation + rate limiting
  twitch.js                 # Twitch IRC — self-initializing on require
public/
  dashboard.html            # Dashboard frontend
```

---

## Free AI Limits

Chat, photos, memory updates and `/imagine` share Cloudflare's free allowance of 10,000 neurons a day, which resets at 00:00 UTC. Rough estimates for what that buys, if all of it goes to one thing:

| Use | Cost | Per day |
|---|---|---|
| Chat message | About 80 neurons, measured on 6 test messages | About 125 |
| 1024×1024 image | Calculated, not measured | About 170 |

A longer conversation context costs more per message.

---

## Recent Changes

**November 2026**

- **DM control channel** — Added DM routing with an allowlist, the OpenCode agent with continuing sessions, and the read-only MCP server. Long results arrive as a summary plus `agent-output.txt`. Discord DMs also needed `Partials.Channel` turned on, and the server message handlers now skip DMs.
- **Moved off Gemini** — Chat, photos and image generation now run on Cloudflare Workers AI, so Gemini prepay isn't needed.
- **Fixed file uploads** — Attachments hung because of a `FormData` mismatch between discord.js's `undici` and Node 20. The REST client now uses Node's global `fetch`.

---

## Legal

[Terms of Service](TERMS_OF_SERVICE.md) · [Privacy Policy](PRIVACY_POLICY.md) · [License](LICENSE)

Developed by BirdTruther for the Birds Server community.
