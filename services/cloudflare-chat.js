// services/cloudflare-chat.js
// Text and vision generation through Cloudflare Workers AI.

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 2048; // Workers AI's default is short enough to cut off memory JSON

// Converts { messages } or { system, prompt } into Workers AI's chat format.
function toWorkersMessages({ messages, system, prompt }) {
    const output = [];
    if (system) output.push({ role: 'system', content: system });
    if (prompt) output.push({ role: 'user', content: prompt });

    for (const message of messages || []) {
        if (typeof message.content === 'string') {
            output.push({ role: message.role, content: message.content });
            continue;
        }
        output.push({
            role: message.role,
            content: message.content.map((item) => {
                if (item.type !== 'image') return { type: 'text', text: item.text };
                const mime = item.mediaType || 'image/png';
                const data = Buffer.from(item.image).toString('base64');
                return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
            }),
        });
    }
    return output;
}

// Workers AI sometimes parses a JSON reply into an object, so callers that expect
// a string (like memory consolidation) need it turned back.
function readReply(result) {
    const reply = result?.response ?? result?.choices?.[0]?.message?.content;
    if (reply === undefined || reply === null) return '';
    return typeof reply === 'string' ? reply.trim() : JSON.stringify(reply);
}

function createChatClient({
    accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken = process.env.CLOUDFLARE_API_TOKEN,
    timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
    async function generate(model, options) {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
            body: JSON.stringify({ messages: toWorkersMessages(options), max_tokens: MAX_OUTPUT_TOKENS }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await res.text();
        if (!res.ok) throw new Error(`Workers AI returned ${res.status}: ${raw.slice(0, 200)}`);
        const text = readReply(JSON.parse(raw).result);
        if (!text) throw new Error('model returned no text');
        return { text };
    }

    return { generate };
}

module.exports = { createChatClient, toWorkersMessages, readReply };
