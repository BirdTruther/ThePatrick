// dm-handler.js
// Private control channel: allowlisted users DM Patrick, Patrick drives an
// OpenCode agent on the server. Deliberately separate from the channel logic in
// index.js. Anyone not on the allowlist gets total silence, so the bot never
// advertises that this exists.

const fs = require('fs');
const path = require('path');
const { Events } = require('discord.js');

const PROGRESS_EDIT_MS = 5000;
const VERBATIM_LIMIT = 1500; // short answers are sent as written, not summarized
const RAW_SUMMARY_LIMIT = 40000;
const RAW_CHUNK_LIMIT = 3;
const OUTPUT_DIR = path.join(__dirname, 'data', 'dm-output'); // gitignored

function parseAllowlist(raw) {
    return new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean));
}

// Keeps only the latest long output per user, so this can't grow without bound.
function saveOutput(userId, text) {
    try {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
        const file = path.join(OUTPUT_DIR, `last-${userId}.txt`);
        fs.writeFileSync(file, text, { mode: 0o600 });
        return file;
    } catch (err) {
        console.error('[DM HANDLER] Could not save output:', err.message);
        return null;
    }
}

function formatElapsed(ms) {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderProgress(startedAt, steps) {
    const recent = steps.slice(-4).map(s => `• ${s.replace(/`/g, "'").slice(0, 120)}`).join('\n');
    return `on it 🔨 · ${formatElapsed(Date.now() - startedAt)}${recent ? `\n${recent}` : ''}`;
}

// Builds the MessageCreate handler. Dependencies are injected so the allowlist
// gate can be tested without Discord, the database or a running agent.
function createDmHandler({ allowed, runner, summarize, log = () => {} }) {
    async function deliver(message, result) {
        const text = result.text || '(the agent finished without any text)';
        if (text.length <= VERBATIM_LIMIT) {
            await message.channel.send(text);
            return;
        }
        const savedTo = saveOutput(message.author.id, text);
        const pointer = savedTo ? `Full output on the server: \`${savedTo}\`` : 'Full output could not be saved.';
        try {
            const summary = await summarize(text.slice(0, RAW_SUMMARY_LIMIT));
            await message.channel.send(`${summary.slice(0, 1800)}\n\n${pointer}`);
            return;
        } catch (err) {
            log('DM_SUMMARY_ERROR', 'WARNING', `Summary failed: ${err.message}`);
        }
        // No summary available, so send the raw text rather than nothing.
        const chunks = text.match(/[\s\S]{1,1900}/g).slice(0, RAW_CHUNK_LIMIT);
        for (const chunk of chunks) await message.channel.send(chunk);
        await message.channel.send(`(summary unavailable, sent raw output) ${pointer}`);
    }

    async function dispatch(message, text) {
        const userId = message.author.id;
        const startedAt = Date.now();
        const steps = [];
        const status = await message.reply(renderProgress(startedAt, steps));

        let lastEdit = 0;
        let editing = false;
        const refresh = async () => {
            if (editing || Date.now() - lastEdit < PROGRESS_EDIT_MS) return;
            editing = true;
            lastEdit = Date.now();
            try { await status.edit(renderProgress(startedAt, steps)); } catch (_) {}
            editing = false;
        };

        log('DM_AGENT_START', 'INFO', `Agent prompt: ${text.slice(0, 500)}`);
        let result;
        try {
            result = await runner.run(userId, text, {
                onProgress: (latest) => { steps.length = 0; steps.push(...latest); refresh(); },
            });
        } catch (err) {
            log('DM_AGENT_ERROR', 'ERROR', err.message);
            await status.edit(`failed ❌ · couldn't reach the agent`).catch(() => {});
            await message.channel.send(`Couldn't reach the agent: ${err.message}`.slice(0, 2000));
            return;
        }
        try {
            const elapsed = formatElapsed(Date.now() - startedAt);
            if (result.cancelled) {
                await status.edit(`cancelled 🛑 · ${elapsed}`);
            } else if (result.timedOut) {
                await status.edit(`timed out ⏱️ · ${elapsed} (agent stopped)`);
            } else if (result.error) {
                await status.edit(`failed ❌ · ${elapsed}`);
                await message.channel.send(`Agent error: ${result.error}`.slice(0, 2000));
            } else {
                await status.edit(`done ✅ · ${elapsed} · ${result.toolCount} tool call(s)`);
                await deliver(message, result);
            }
            log('DM_AGENT_END', result.error ? 'ERROR' : 'INFO',
                `cancelled=${!!result.cancelled} timedOut=${!!result.timedOut} tools=${result.toolCount} error=${result.error || 'none'}`);
        } catch (err) {
            log('DM_DELIVERY_ERROR', 'ERROR', err.message);
            await message.channel.send(`The agent finished, but sending the result failed: ${err.message}`.slice(0, 2000));
        }
    }

    return async function handleDm(message) {
        if (message.guildId) return;
        if (message.author.bot) return;
        if (!allowed.has(message.author.id)) return; // silent: no reply, no log of content

        const text = (message.content || '').trim();
        if (!text) return;
        const userId = message.author.id;

        try {
            const command = text.toLowerCase();
            if (command === '!cancel') {
                const cancelled = await runner.cancel(userId);
                if (!cancelled) await message.reply('Nothing running.');
                return; // the running job reports its own cancelled state
            }
            if (command === '!status') {
                const job = runner.status(userId);
                await message.reply(job
                    ? `Running for ${formatElapsed(Date.now() - job.startedAt)}: ${job.prompt.slice(0, 200)}`
                    : 'Idle.');
                return;
            }
            if (command === '!new') {
                if (runner.status(userId)) {
                    await message.reply('Still working. `!cancel` first.');
                    return;
                }
                runner.reset(userId);
                await message.reply('Fresh session. Next message starts clean.');
                return;
            }
            if (runner.status(userId)) {
                await message.reply('Still on the last one. `!status` or `!cancel`.');
                return;
            }
            await dispatch(message, text);
        } catch (err) {
            console.error('[DM HANDLER ERROR]', err);
            log('DM_HANDLER_ERROR', 'ERROR', err.message);
        }
    };
}

// Fails closed: without DM_ALLOWLIST the handler is never attached.
function registerDmHandler(client) {
    const allowed = parseAllowlist(process.env.DM_ALLOWLIST);
    const { logSystemEvent } = require('./logger.js');
    if (allowed.size === 0) {
        logSystemEvent('DM_CONTROL', 'INFO', 'discord', 'DM_ALLOWLIST is empty; DM control disabled');
        return false;
    }

    const { getSetting, setSetting } = require('./database.js');
    const { generateTextWithFallback } = require('./services/ai.js');
    const { createRunner } = require('./dm-runner.js');

    const handler = createDmHandler({
        allowed,
        runner: createRunner({ getSetting, setSetting }),
        log: (event, level, text) => logSystemEvent(event, level, 'discord', text),
        summarize: async (text) => {
            const { text: summary } = await generateTextWithFallback({
                system: 'Summarize this server-admin agent output for its owner reading on a phone. '
                    + 'Plain and factual, under 1500 characters. Keep exact names, numbers, paths and errors. '
                    + 'Say plainly if something failed. No persona, no jokes.',
                prompt: text,
            });
            return summary;
        },
    });
    client.on(Events.MessageCreate, handler);
    logSystemEvent('DM_CONTROL', 'INFO', 'discord', `DM control enabled for ${allowed.size} user(s)`);
    return true;
}

module.exports = { registerDmHandler, createDmHandler, parseAllowlist };
