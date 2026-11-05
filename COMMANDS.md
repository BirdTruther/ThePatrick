# Commands

All commands are Discord slash commands. Type `/` in any channel — Discord autocomplete shows them instantly.

Commands are registered **globally** on startup, so one bot instance can serve
multiple Discord servers. Global command changes can take up to an hour to
appear everywhere.

---

## Tarkov

| Command | Description | Args |
|---|---|---|
| `/price` | Flea market & trader prices | `item` |
| `/bestammo` | Best ammo by caliber, ranked by penetration | `caliber` |
| `/trader` | Trader reset times (EST) | — |
| `/map` | Map info and boss spawns | `map` |
| `/player` | Player stats via EFT API | `name` |

---

## CS2

| Command | Description | Args |
|---|---|---|
| `/cs2stats` | All-time player stats (public profile required) | `steam` |
| `/cs2case` | Case opening simulator with real Valve odds | `case`, `count`, `cost` |

> `/cs2stats` requires `STEAM_API_KEY`.

---

## Music

| Command | Description |
|---|---|
| `/play` | Search YouTube and play in your voice channel |
| `/skip` | Skip the current track |
| `/stop` | Stop playback, clear queue, leave channel |
| `/queue` | Show the current queue |
| `/pause` | Pause playback |
| `/resume` | Resume a paused track |
| `/nowplaying` | Show the currently playing track |

Music uses `yt-dlp` + `ffmpeg` — no API key required.

---

## AI & General

| Command | Description | Args |
|---|---|---|
| `/ask` | Ask the AI a question | `question` |
| `/imagine` | Generate an AI image with Gemini | `prompt` |
| `/persona` | Switch the bot's personality | `name` |
| `/personas` | List all available personas | — |
| `/meme` | Fetch a random meme | — |
| `/code` | Get the GitHub repo link | — |

You can also **mention** the bot or **reply** to a bot message to chat with it directly. Attach an image to have it analyzed.

---

## Tarkov Allergies

Roleplay allergies for the server. Track and "react" to what members are allergic to.

| Command | Description | Args |
|---|---|---|
| `/addallergy` | Add an allergy to a user (defaults to you) | `allergy`, `user`* |
| `/removeallergy` | Remove an allergy | `allergy` |
| `/allergies` | List a user's allergies (defaults to you) | `user`* |
| `/searchallergy` | Find which users share an allergy | `allergy` |
| `/commonallergies` | Show the most common allergies server-wide | — |

---

## Hate List

Admin-managed roleplay "hate list". Admins add users, and the bot roasts them: chat reactions tag hated users, and roughly once per hour the bot has a chance to fire an AI-generated roast into the configured channel.

| Command | Description | Args |
|---|---|---|
| `/hate add` | Add a user to the hate list | `user` |
| `/hate remove` | Remove a user from the hate list | `user` |
| `/hate remove-me` | Remove **yourself** from the hate list (self-service, always available) | — |
| `/hate list` | Show all hated users | — |
| `/hate channel` | Set the channel where roasts fire | `channel` |

> `add`, `remove`, `list`, and `channel` are gated by Discord-native slash-command permissions — only admins you grant them to can use those. `/hate remove-me` is intentionally open so any listed player can opt out anytime.
>
> The hate list, roast channel, and "Roast Pings" toggle are separate for each Discord server. Proactive roast pings (the hourly AI timer and random chat callouts) can be disabled from the dashboard; on-demand roasts and reply-based attacks stay active.

---

## Admin

| Command | Description | Args |
|---|---|---|
| `/pickplayers` | Randomly pick players (for CS2 lobbies, etc.) | `count`*, `voice_only`*, `role`* |

---

## AI Personas

Switch via `/persona` or the web dashboard.

| Persona | Style |
|---|---|
| Aggressive/Mean | Toxic gamer energy with heavy sarcasm |
| Sassy & Stupid | Confidently wrong about everything |
| Nice & Smart | Actually helpful with accurate info |
| Paranoid Conspiracy | Everything is a hidden agenda |
| Sleepy/High Patrick | Forgetful, rambling, eventually correct |
