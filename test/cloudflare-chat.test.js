// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { createChatClient, toWorkersMessages, readReply } = require('../services/cloudflare-chat.js');

function fakeFetch(status, data) {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
        return { ok: status < 400, status, text: async () => JSON.stringify(data) };
    };
    return { calls, restore: () => { global.fetch = original; } };
}

test('converts images into data URLs and keeps roles', () => {
    const messages = toWorkersMessages({
        messages: [
            { role: 'system', content: 'be a pirate' },
            { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', image: Buffer.from('x'), mediaType: 'image/jpeg' }] },
        ],
    });
    assert.deepStrictEqual(messages[0], { role: 'system', content: 'be a pirate' });
    assert.deepStrictEqual(messages[1].content[0], { type: 'text', text: 'hi' });
    assert.strictEqual(messages[1].content[1].image_url.url, 'data:image/jpeg;base64,eA==');
});

test('accepts the system + prompt form', () => {
    assert.deepStrictEqual(toWorkersMessages({ system: 's', prompt: 'p' }), [
        { role: 'system', content: 's' },
        { role: 'user', content: 'p' },
    ]);
});

test('a JSON reply parsed into an object comes back as a string', () => {
    assert.strictEqual(readReply({ response: { facts: ['a'] } }), '{"facts":["a"]}');
    assert.strictEqual(readReply({ response: ' hello ' }), 'hello');
    assert.strictEqual(readReply({}), '');
});

test('sends the model, token and output cap', async () => {
    const server = fakeFetch(200, { result: { response: 'ahoy' } });
    try {
        const { text } = await createChatClient({ accountId: 'acct', apiToken: 'tok' }).generate('@cf/x/y', { prompt: 'hi' });
        assert.strictEqual(text, 'ahoy');
        assert.match(server.calls[0].url, /accounts\/acct\/ai\/run\/@cf\/x\/y$/);
        assert.strictEqual(server.calls[0].auth, 'Bearer tok');
        assert.ok(server.calls[0].body.max_tokens >= 1024);
    } finally {
        server.restore();
    }
});

test('API errors and empty replies throw so the fallback can run', async () => {
    let server = fakeFetch(429, { errors: [{ message: 'daily allocation used' }] });
    try {
        await assert.rejects(createChatClient({ accountId: 'a', apiToken: 't' }).generate('m', { prompt: 'hi' }), /429/);
    } finally {
        server.restore();
    }
    server = fakeFetch(200, { result: { response: '' } });
    try {
        await assert.rejects(createChatClient({ accountId: 'a', apiToken: 't' }).generate('m', { prompt: 'hi' }), /no text/);
    } finally {
        server.restore();
    }
});
