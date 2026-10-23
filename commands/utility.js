// commands/utility.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const https = require('https');
const { addToMemory } = require('../memory.js');
const { logCommand, logSystemEvent } = require('../logger.js');
const { getCurrentPersona, getPersonaErrorMessage, setPersona, getAvailablePersonas } = require('../persona-manager.js');
const { getAIResponse, isWildRequest, getWildRequestResponse } = require('../services/ai.js');
const { generateImage, detectImageRequest, sanitizeImagePrompt } = require('../services/image.js');

// ===== CONFIG =====
const GITHUB_URL = 'https://github.com/BirdTruther';

// ===== PERSONA HELPERS =====

function buildPersonaList(guildId = null) {
    const keys    = getAvailablePersonas();
    const current = getCurrentPersona(guildId);
    return keys
        .map(key => key === current.name ? `**${key}** (active)` : key)
        .join(', ');
}

function applyPersona(name, guildId = null) {
    const success = setPersona(name, guildId);
    if (success) return `✅ Persona switched to **${name}**.`;
    const available = getAvailablePersonas().join(', ');
    return `❌ Unknown persona "${name}". Available: ${available}`;
}

// ===== MEME FETCHER =====

async function fetchMeme() {
    try {
        const response = await fetch('https://meme-api.com/gimme');
        const data = await response.json();
        if (data?.url && !data.nsfw) return { title: data.title, url: data.url };
        return null;
    } catch (error) {
        console.error('[Meme Fetch Error]', error);
        logSystemEvent('MEME_ERROR', 'WARNING', 'meme', 'Meme fetch failed', error);
        return null;
    }
}

// ===== IMAGE PROMPT EXTRACTOR =====

const IMAGE_PROMPT_TRIGGERS = [
    'generate image of', 'create image of', 'make image of',
    'generate a image of', 'create a image of', 'make a image of',
    'generate an image of', 'create an image of', 'make an image of',
    'generate picture of', 'create picture of', 'make picture of',
    'show me a picture of', 'show me an image of',
    'draw me a', 'draw me an', 'paint me a', 'paint me an',
    'generate image', 'create image', 'make image',
    'image of', 'picture of', 'photo of',
    'imagine what', 'imagine',
];

function extractImagePrompt(messageContent) {
    let prompt = messageContent.replace(/<@[!&]?\d+>/g, '').trim();

    const prefixes = ['!image', '!img', '!generate', '!draw', '!art'];
    for (const prefix of prefixes) {
        if (prompt.toLowerCase().startsWith(prefix)) {
            prompt = prompt.substring(prefix.length).trim();
            break;
        }
    }

    const lower = prompt.toLowerCase();
    for (const trigger of IMAGE_PROMPT_TRIGGERS) {
        if (lower.startsWith(trigger)) {
            prompt = prompt.substring(trigger.length).trim();
            break;
        }
    }

    return prompt || 'a cool image';
}

// ===== IMAGE ATTACHMENT UTILITIES =====

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

function mimeToExt(mimeType) {
    if (!mimeType) return 'png';
    const sub = mimeType.split('/')[1] || 'png';
    return sub === 'jpeg' ? 'jpg' : sub;
}

function attachmentIsImage(att) {
    return att.contentType?.startsWith('image/') ||
        /\.(jpg|jpeg|png|gif|webp)$/i.test(att.name || '');
}

function hasImageAttachment(message) {
    // Real file uploads live in message.attachments.
    if (message.attachments?.size) {
        for (const [, att] of message.attachments) {
            if (attachmentIsImage(att)) return true;
        }
    }
    // Discord delivers pasted/linked media (Tenor, Giphy, Klipy, Imgur…) as
    // auto-embeds, NOT attachments. Without counting those, Patrick goes
    // blind on every GIF link in the server.
    if (message.embeds?.some(e => e.type === 'image' && e.image?.url)) return true;
    // Last resort: direct image links that were NOT auto-embedded.
    return /\.(jpe?g|png|webp|gif)(\?[^ ]*)?(\s|$)/i.test(message.content || '');
}

function imageUrlsToFetch(message) {
    const queue   = [];
    const seen    = new Set();
    const pushUrl = (url, label) => {
        if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
            seen.add(url);
            queue.push({ url, label });
        }
    };
    for (const [, attachment] of message.attachments) {
        if (attachmentIsImage(attachment)) pushUrl(attachment.url, attachment.name);
    }
    for (const embed of message.embeds || []) {
        if (embed.type === 'image') pushUrl(embed.image?.url, embed.provider?.name || 'image embed');
    }
    // Tenor/giphy links sometimes skip auto-embedding entirely.
    for (const raw of (message.content || '').match(/https?:\/\/[^\s<>"']+/gi) || []) {
        if (/\.(jpe?g|png|webp|gif)(\?[^ ]*)?$/i.test(raw)) pushUrl(raw, 'content link');
    }
    return queue;
}

function inferImageContentType(url, fallback) {
    if (fallback && fallback.startsWith('image/')) return fallback;
    if (/\.jpe?g(\?|$)/i.test(url)) return 'image/jpeg';
    if (/\.png(\?|$)/i.test(url))  return 'image/png';
    if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
    return 'image/gif';
}

async function fetchImageFromUrl(url, label) {
    const headRes = await fetch(url, { method: 'HEAD' });
    const contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_IMAGE_BYTES) {
        console.warn(`[IMAGE] "${label}" is ${(contentLength / 1024 / 1024).toFixed(1)}MB — over limit, skipping.`);
        logSystemEvent('IMAGE_SKIP', 'WARNING', 'image',
            `Image "${label}" skipped: ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds limit`);
        return null;
    }
    const response    = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return {
        buffer: Buffer.from(arrayBuffer),
        contentType: inferImageContentType(url, response.headers.get('content-type')),
        name: label,
    };
}

async function getImageAttachments(message) {
    const images = [];
    for (const { url, label } of imageUrlsToFetch(message)) {
        try {
            const image = await fetchImageFromUrl(url, label);
            if (image) images.push(image);
        } catch (err) {
            console.error('[IMAGE] Failed to fetch attachment:', err.message);
            logSystemEvent('IMAGE_ERROR', 'WARNING', 'image', `Failed to fetch "${label}": ${err.message}`, err);
        }
    }
    return images;
}

// ===== NATIVE HTTPS MULTIPART UPLOAD =====
// Posts a file buffer directly to a Discord webhook URL using Node's built-in
// https module. This completely bypasses undici and its connection pool, which
// is the root cause of UND_ERR_SOCKET on large file uploads after a long-lived
// keep-alive connection is half-closed by Discord's CDN.

function postImageViaWebhook(webhookUrl, imageBuffer, filename, mimeType) {
    return new Promise((resolve, reject) => {
        const CRLF    = '\r\n';
        const boundary = `boundary${Date.now()}${Math.random().toString(36).slice(2)}`;

        const preamble = Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="files[0]"; filename="${filename}"${CRLF}` +
            `Content-Type: ${mimeType}${CRLF}${CRLF}`
        );
        const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
        const body     = Buffer.concat([preamble, imageBuffer, epilogue]);

        const url    = new URL(webhookUrl);
        const options = {
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers:  {
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
            },
            // Force a new socket — never reuse a pooled connection.
            agent: new https.Agent({ keepAlive: false }),
        };

        const req = https.request(options, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(text);
                } else {
                    reject(new Error(`Discord webhook returned ${res.statusCode}: ${text.substring(0, 200)}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ===== DISCORD SAFE SEND UTILITIES =====

// Keeps the "ThePatrick is typing..." indicator alive while awaiting slow AI
// work. A single sendTyping() only lasts ~10s, but image generation and long
// chat completions run well past that, so it refreshes every 8s until the
// wrapped task settles (success or error) and always cleans up.
async function withTyping(channel, task) {
    if (!channel || typeof channel.sendTyping !== 'function') return task();
    const typist = () => { channel.sendTyping().catch(() => {}); };
    typist();
    const keepAlive = setInterval(typist, 8000);
    try {
        return await task();
    } finally {
        clearInterval(keepAlive);
    }
}

async function safeDiscordReply(message, content) {
    try {
        if (content.length <= 2000) {
            await message.reply(content);
        } else {
            const chunks = content.match(/.{1,2000}/gs) || [content];
            for (const chunk of chunks) await message.channel.send(chunk);
        }
    } catch (error) {
        console.error('[DISCORD REPLY ERROR]', error);
        logSystemEvent('DISCORD_ERROR', 'WARNING', 'discord', 'Safe reply failed', error);
    }
}

async function safeDiscordSend(channel, content) {
    try {
        if (content.length <= 2000) {
            await channel.send(content);
        } else {
            const chunks = content.match(/.{1,2000}/gs) || [content];
            for (const chunk of chunks) await channel.send(chunk);
        }
    } catch (error) {
        console.error('[DISCORD SEND ERROR]', error);
        logSystemEvent('DISCORD_ERROR', 'WARNING', 'discord', 'Safe send failed', error);
    }
}

// ===== SLASH COMMAND DEFINITIONS =====

const commands = {
    meme: {
        data: new SlashCommandBuilder()
            .setName('meme')
            .setDescription('Get a random meme'),

        async execute(interaction) {
            const meme   = await fetchMeme();
            const result = meme
                ? `**${meme.title}**\n${meme.url}`
                : "Couldn't fetch a meme right now. Try again!";
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/meme', '', result);
        }
    },

    code: {
        data: new SlashCommandBuilder()
            .setName('code')
            .setDescription('Get the GitHub link'),

        async execute(interaction) {
            const result = `Check out my code! 🤖 ${GITHUB_URL}`;
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/code', '', result);
        }
    },

    persona: {
        data: new SlashCommandBuilder()
            .setName('persona')
            .setDescription('Switch the bot persona')
            .addStringOption(o =>
                o.setName('name').setDescription('Persona name').setRequired(true)
            ),

        async execute(interaction) {
            const name   = interaction.options.getString('name');
            const result = applyPersona(name, interaction.guildId);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/persona', name, result);
        }
    },

    personas: {
        data: new SlashCommandBuilder()
            .setName('personas')
            .setDescription('List all available personas'),

        async execute(interaction) {
            const result = `Available personas: ${buildPersonaList(interaction.guildId)}`;
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/personas', '', result);
        }
    },

    ask: {
        data: new SlashCommandBuilder()
            .setName('ask')
            .setDescription('Ask the AI a question')
            .addStringOption(o =>
                o.setName('question').setDescription('Your question').setRequired(true)
            ),

        async execute(interaction) {
            const question  = interaction.options.getString('question');
            const username  = interaction.user.username;
            const channelId = interaction.channelId;

            addToMemory('discord', channelId, username, question);

            if (isWildRequest(question)) {
                const roast = await getWildRequestResponse(question, 'discord', channelId, username, interaction.guildId);
                await interaction.editReply(roast);
                logCommand('discord', username, '/ask (wild)', question, roast);
                return;
            }

            const response = await getAIResponse(question, 'discord', channelId, username, [], interaction.guildId);
            await interaction.editReply(response);
            logCommand('discord', username, '/ask', question, response);
        }
    },

    imagine: {
        data: new SlashCommandBuilder()
            .setName('imagine')
            .setDescription('Generate an image with AI')
            .addStringOption(o =>
                o.setName('prompt').setDescription('Image description').setRequired(true)
            ),

        async execute(interaction) {
            const prompt   = interaction.options.getString('prompt');
            const username = interaction.user.username;

            const cleanPrompt = sanitizeImagePrompt(extractImagePrompt(prompt));

            logCommand('discord', username, '/imagine', cleanPrompt, '[generating...]');

            const result = await generateImage(cleanPrompt, interaction.user.id, {
                enhance:  true,
                platform: 'discord',
            });

            if (!result.success) {
                await interaction.editReply(result.error);
                logCommand('discord', username, '/imagine', cleanPrompt, `[failed: ${result.error}]`);
                return;
            }

            const ext      = mimeToExt(result.mimeType);
            const filename = `generated.${ext}`;

            // Acknowledge the interaction immediately via Discord.js (text only).
            // This must happen before the file upload or Discord shows
            // "interaction failed" after 3 seconds.
            await interaction.editReply(`🎨 **Prompt:** ${result.finalPrompt.substring(0, 200)}`);

            // Build the interaction followUp webhook URL and POST the image
            // using Node's native https module. This completely bypasses undici
            // and its connection pool. The root cause of all previous failures
            // (UND_ERR_SOCKET / AbortError) is undici reusing a keep-alive
            // TLS socket that Discord's CDN has already half-closed. A native
            // https.request with keepAlive:false opens a fresh OS-level socket
            // that has zero connection affinity with the bot's REST client.
            const webhookUrl = `https://discord.com/api/v10/webhooks/${interaction.applicationId}/${interaction.token}`;

            try {
                await postImageViaWebhook(webhookUrl, result.buffer, filename, result.mimeType);
                console.log(`[Image] Upload complete — ${result.buffer.length} bytes via native https`);
            } catch (uploadErr) {
                console.error('[Image] Native https upload failed:', uploadErr.message);
                logSystemEvent('IMAGE_UPLOAD_ERROR', 'ERROR', 'image',
                    `Native upload failed for ${username}: ${uploadErr.message}`, uploadErr);
                // Best-effort: try to tell the user something went wrong.
                await interaction.followUp('❌ Image was generated but failed to upload. Please try again.').catch(() => {});
                return;
            }

            logCommand('discord', username, '/imagine', cleanPrompt, `[image uploaded — ${result.buffer.length} bytes, ${result.mimeType}]`);
        }
    },
};

// ===== EXPORTS =====
module.exports = {
    commands,
    // Discord message handler helpers
    hasImageAttachment,
    getImageAttachments,
    extractImagePrompt,
    safeDiscordReply,
    safeDiscordSend,
    withTyping,
};
