// services/opencode-chat.js
// Text generation through a local, locked-down `opencode serve`.
//
// Anyone in a server can reach this with their chat messages, so it must never
// be pointed at the DM agent's server. The chat server's own config denies every
// tool, and each session here denies them again.

const CHAT_AGENT = 'patrick-chat';
const DENY_ALL = [{ permission: '*', pattern: '*', action: 'deny' }];
const REQUEST_TIMEOUT_MS = 45_000;

function parseModel(value) {
    const [providerID, ...rest] = String(value).split('/');
    return { providerID, modelID: rest.join('/') };
}

// Converts { messages } or { system, prompt } into OpenCode's system + parts.
function toOpenCodeRequest({ messages, system, prompt }) {
    const systemText = [];
    const parts = [];
    if (system) systemText.push(system);
    if (prompt) parts.push({ type: 'text', text: prompt });

    for (const message of messages || []) {
        if (message.role === 'system') {
            systemText.push(message.content);
            continue;
        }
        const content = typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content;
        for (const item of content) {
            if (item.type === 'image') {
                const mime = item.mediaType || 'image/png';
                parts.push({
                    type: 'file',
                    mime,
                    url: `data:${mime};base64,${Buffer.from(item.image).toString('base64')}`,
                });
            } else {
                parts.push({ type: 'text', text: item.text });
            }
        }
    }
    return { system: systemText.join('\n\n'), parts };
}

function hasImage(options) {
    return toOpenCodeRequest(options).parts.some(part => part.type === 'file');
}

function createChatClient({
    baseUrl = process.env.OPENCODE_CHAT_URL || 'http://127.0.0.1:4097',
    password = process.env.OPENCODE_CHAT_PASSWORD || '',
    directory = process.env.OPENCODE_CHAT_DIR || '',
    timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
    async function api(path, { method = 'GET', body, timeout = 10_000 } = {}) {
        const res = await fetch(`${baseUrl}${path}?directory=${encodeURIComponent(directory)}`, {
            method,
            headers: {
                'content-type': 'application/json',
                authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeout),
        });
        const raw = await res.text();
        if (!res.ok) throw new Error(`OpenCode chat ${method} ${path} returned ${res.status}: ${raw.slice(0, 200)}`);
        return raw ? JSON.parse(raw) : null;
    }

    // One throwaway session per call, so nothing carries over between people.
    async function generate(model, options) {
        const { system, parts } = toOpenCodeRequest(options);
        const session = await api('/session', {
            method: 'POST',
            body: { title: 'Patrick chat', permission: DENY_ALL },
        });
        const path = `/session/${session.id}`;
        try {
            // OpenCode retries some provider errors forever, so the timeout is
            // what lets a stuck model fall through to the next one.
            const reply = await api(`${path}/message`, {
                method: 'POST',
                body: { agent: CHAT_AGENT, model: parseModel(model), system, parts },
                timeout: timeoutMs,
            });
            if (reply.info?.error) {
                throw new Error(reply.info.error.data?.message || reply.info.error.name || 'model error');
            }
            const text = reply.parts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
            if (!text) throw new Error('model returned no text');
            return { text };
        } finally {
            await api(`${path}/abort`, { method: 'POST' }).catch(() => {});
            await api(path, { method: 'DELETE' }).catch(() => {});
        }
    }

    return { generate };
}

module.exports = { createChatClient, toOpenCodeRequest, hasImage, DENY_ALL };
