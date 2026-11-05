// services/twitch.js
const tmi = require('tmi.js');
const { addToMemory } = require('../memory.js');
const { logCommand, logSystemEvent } = require('../logger.js');
const { getAIResponse, isWildRequest, getWildRequestResponse } = require('./ai.js');
const { getTarkovPrice, getBestAmmo, getTraderResets, getMapInfo, getPlayerStats } = require('../commands/tarkov.js');
const { getCS2PlayerStats, simulateCS2Case } = require('../commands/cs2.js');

// ===== CONFIG =====
const TWITCH_CHAR_LIMIT     = 490;
const TWITCH_DELAY_MS       = 1500;
const DUNGEON_AUTO_JOIN_DELAY = 3000;
const GITHUB_URL            = 'https://github.com/BirdTruther';

// ===== TWITCH UTILITIES =====

async function sendTwitchMessage(channel, text, delayMs = TWITCH_DELAY_MS) {
    return new Promise((resolve) => {
        twitchClient.say(channel, text);
        setTimeout(resolve, delayMs);
    });
}

async function sendTwitchChunked(channel, text) {
    if (text.length <= TWITCH_CHAR_LIMIT) {
        twitchClient.say(channel, text);
        return;
    }
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let currentChunk = '';
    for (const sentence of sentences) {
        if ((currentChunk + sentence).length > TWITCH_CHAR_LIMIT) {
            if (currentChunk) await sendTwitchMessage(channel, currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += sentence;
        }
    }
    if (currentChunk) await sendTwitchMessage(channel, currentChunk.trim());
}

// ===== CS2 CASE ARGUMENT PARSER =====
// Kept here because it's only used by the Twitch prefix command
// where args come in as a raw string (unlike slash commands)
function parseCS2CaseCommand(args) {
    const tokens = args.trim().split(/\s+/);
    if (tokens.length < 3) return null;
    const cost  = parseFloat(tokens[tokens.length - 1]);
    const count = parseInt(tokens[tokens.length - 2], 10);
    if (isNaN(count) || isNaN(cost)) return null;
    const caseName = tokens.slice(0, tokens.length - 2).join(' ') || 'Unknown Case';
    return { caseName, count, cost };
}

// ===== TWITCH CLIENT SETUP =====

const twitchClient = new tmi.Client({
    options: { debug: true },
    identity: {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_OAUTH_TOKEN,
    },
    channels: [process.env.TWITCH_CHANNEL],
});

twitchClient.connect().catch((error) => {
    console.error('[TWITCH CONNECTION ERROR]', error);
    logSystemEvent('CONNECTION', 'ERROR', 'twitch', 'Failed to connect to Twitch', error);
});

twitchClient.on('connected', (address, port) => {
    console.log(`✅ Connected to Twitch at ${address}:${port}`);
    logSystemEvent('CONNECTION', 'INFO', 'twitch', `✅ Connected to Twitch at ${address}:${port}`);
});

twitchClient.on('disconnected', (reason) => {
    console.log(`❌ Twitch disconnected: ${reason}`);
    logSystemEvent('CONNECTION', 'WARNING', 'twitch', `❌ Twitch disconnected: ${reason}`);
});

// ===== TWITCH MESSAGE HANDLER =====

twitchClient.on('message', async (channel, tags, message, self) => {
    if (self) return;

    console.log(`[TWITCH] ${tags.username}: ${message}`);
    addToMemory('twitch', channel, tags.username, message);

    const lowerMessage = message.toLowerCase();

    // --- !code / !github ---
    if (lowerMessage.includes('!code') || lowerMessage.includes('!github')) {
        const response = `Check out my code! 🤖 ${GITHUB_URL}`;
        twitchClient.say(channel, response);
        logCommand('twitch', tags.username, '!code', message, response);
        return;
    }

    // --- Tarkov commands ---
    if (lowerMessage.startsWith('!price ')) {
        const itemName = message.substring(7);
        const result = await getTarkovPrice(itemName);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!price', itemName, result);
        return;
    }
    if (lowerMessage.startsWith('!bestammo ')) {
        const searchCaliber = message.substring(10).trim();
        const result = await getBestAmmo(searchCaliber);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!bestammo', searchCaliber, result);
        return;
    }
    if (lowerMessage === '!trader') {
        const result = await getTraderResets();
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!trader', message, result);
        return;
    }
    if (lowerMessage.startsWith('!map ')) {
        const mapName = message.substring(5);
        const result = await getMapInfo(mapName);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!map', mapName, result);
        return;
    }
    if (lowerMessage.startsWith('!player ')) {
        const playerName = message.substring(8).trim();
        const result = await getPlayerStats(playerName);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!player', playerName, result);
        return;
    }

    // --- CS2 commands ---
    if (lowerMessage.startsWith('!cs2stats ')) {
        const steamInput = message.substring(10).trim();
        const result = await getCS2PlayerStats(steamInput);
        await sendTwitchChunked(channel, result);
        logCommand('twitch', tags.username, '!cs2stats', steamInput, result);
        return;
    }
    if (lowerMessage.startsWith('!cs2case ')) {
        const args   = message.substring(9).trim();
        const parsed = parseCS2CaseCommand(args);
        if (!parsed) {
            const usage = 'Usage: !cs2case <case name> <count> <case cost> — e.g. !cs2case Kilowatt 10 1.50';
            twitchClient.say(channel, usage);
            logCommand('twitch', tags.username, '!cs2case', args, usage, true);
        } else {
            const result = simulateCS2Case(parsed.caseName, parsed.count, parsed.cost);
            await sendTwitchChunked(channel, result);
            logCommand('twitch', tags.username, '!cs2case', args, result);
        }
        return;
    }

    // --- Tangia dungeon auto-join ---
    if (tags.username.toLowerCase() === 'tangiabot' &&
        (lowerMessage.includes('started a tangia dungeon') ||
         lowerMessage.includes('dungeon has started'))) {
        setTimeout(async () => {
            twitchClient.say(channel, '!join');
            logSystemEvent('INFO', 'INFO', 'tangia', 'Auto-joined Tangia dungeon');
        }, DUNGEON_AUTO_JOIN_DELAY);
        return;
    }

    // --- @mention / !ask / !ai → AI response ---
    if (
        lowerMessage.includes(`@${process.env.TWITCH_BOT_USERNAME?.toLowerCase()}`) ||
        lowerMessage.startsWith('!ask ')  ||
        lowerMessage.startsWith('!ai ')
    ) {
        let userMessage = message
            .replace(new RegExp(`@${process.env.TWITCH_BOT_USERNAME}`, 'gi'), '')
            .replace(/^!ask\s+/i, '')
            .replace(/^!ai\s+/i, '')
            .trim();

        if (!userMessage) return;

        addToMemory('twitch', channel, tags.username, userMessage);

        if (isWildRequest(userMessage)) {
            const roast = await getWildRequestResponse(userMessage, 'twitch', channel, tags.username);
            await sendTwitchChunked(channel, roast);
            logCommand('twitch', tags.username, '@mention (wild)', userMessage, roast);
            return;
        }

        const response = await getAIResponse(userMessage, 'twitch', channel, tags.username);
        await sendTwitchChunked(channel, response);
        logCommand('twitch', tags.username, '@mention', userMessage, response);
    }
});

// ===== EXPORTS =====
module.exports = {
    twitchClient,
    sendTwitchChunked,
    sendTwitchMessage,
};