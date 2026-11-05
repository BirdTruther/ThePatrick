# ThePatrick

![Version](https://img.shields.io/github/v/release/BirdTruther/ThePatrick)

Multi-platform Discord + Twitch bot with Escape from Tarkov integration, CS2 integration, Gemini AI, voice music, roleplay features, and a live web dashboard.

**[Commands →](COMMANDS.md)** | **[Self-Hosting & License →](SETUP.md)**

---

## Want Patrick on your server?

Head to **[birdsserver.cfd](https://birdsserver.cfd/)**. Discord and GitHub contact links are there. The source is public and readable, but running Patrick live, self-hosted or otherwise, requires a license under [BSL 1.1](LICENSE). Getting him onto your server starts with reaching out, not cloning the repo.

---

## What It Does

- **AI chat** — Mention the bot or reply to it. Supports text, image understanding, and image generation via Gemini.
- **Long-term memory** — The AI builds one durable server-wide "fact sheet" (names, mains, inside jokes) and references it across channels; also feeds roasts. Hourly, cost-bounded consolidation, with **pinned facts** that survive AI rewrites.
- **Tarkov** — Item prices, ammo rankings, trader timers, map/boss info, player stats.
- **Tarkov Allergies** — Roleplay allergy tracking; log and compare what members are allergic to.
- **Hate List** — Admin-managed roleplay roast list; the bot tags and roasts listed users with AI-generated lines, unless roast pings are toggled off. Any listed user can self-opt-out with `/hate remove-me`.
- **CS2** — Skin prices, float values, player stats, map callouts, case simulator.
- **Music** — YouTube voice playback via `yt-dlp` + `ffmpeg`. No API key required.
- **Twitch** — Connects to Twitch IRC and relays messages to Discord.
- **Dashboard** — Live web UI at `http://localhost:3001` for logs, persona switching, hate list (with a roast-pings toggle), long-term memory management (add/pin/edit/delete facts), and Cultist tracking.

---

## Stack

| Layer | What |
|---|---|
| Runtime | Node.js ≥ 20.18.1 |
| Discord | discord.js 14 + @discordjs/voice 0.19.2 |
| AI | Google Gemini via `@ai-sdk/google` (text model set by `AI_PRIMARY_MODEL`, default `gemini-3.1-flash-lite`; images `gemini-3.1-flash-image`) |
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
commands/
  utility.js                # /ask, /imagine, /meme, /code, /persona, /personas
  admin.js                  # /pickplayers
  cs2.js                    # All CS2 commands
  tarkov.js                 # All Tarkov commands
  allergies.js              # Tarkov roleplay allergy commands
  hate.js                   # /hate add|remove|remove-me|list|channel
services/
  ai.js                     # Text generation + vision, through opencode-chat.js
  opencode-chat.js          # Client for the no-tools OpenCode chat server
  image.js                  # Cloudflare Workers AI image generation + rate limiting
  twitch.js                 # Twitch IRC — self-initializing on require
public/
  dashboard.html            # Dashboard frontend
```

---

## Legal

[Terms of Service](TERMS_OF_SERVICE.md) · [Privacy Policy](PRIVACY_POLICY.md) · [License](LICENSE)

Developed by BirdTruther for the Birds Server community.
