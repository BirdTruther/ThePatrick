// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { createChatClient, toOpenCodeRequest, hasImage, DENY_ALL } = require('../services/opencode-chat.js');

function fakeServer(replyFor) {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, init) => {
        const path = new URL(url).pathname;
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ path, method: init.method, body });
        let data = true;
        if (path === '/session' && init.method === 'POST') data = { id: 'ses_1' };
        if (path.endsWith('/message')) data = replyFor(body);
        return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    };
    return { calls, restore: () => { global.fetch = original; } };
}

test('converts messages into system text and parts', () => {
    const { system, parts } = toOpenCodeRequest({
        messages: [
            { role: 'system', content: 'be a pirate' },
            { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', image: Buffer.from('x'), mediaType: 'image/jpeg' }] },
        ],
    });
    assert.strictEqual(system, 'be a pirate');
    assert.deepStrictEqual(parts[0], { type: 'text', text: 'hi' });
    assert.deepStrictEqual(parts[1], { type: 'file', mime: 'image/jpeg', url: 'data:image/jpeg;base64,eA==' });
});

test('accepts the system + prompt form', () => {
    const { system, parts } = toOpenCodeRequest({ system: 's', prompt: 'p' });
    assert.strictEqual(system, 's');
    assert.deepStrictEqual(parts, [{ type: 'text', text: 'p' }]);
    assert.strictEqual(hasImage({ system: 's', prompt: 'p' }), false);
});

test('every session denies all tools and is deleted afterwards', async () => {
    const server = fakeServer(() => ({ info: {}, parts: [{ type: 'text', text: 'ahoy' }] }));
    try {
        const { text } = await createChatClient({ directory: '/x' }).generate('opencode-go/beam-free', { prompt: 'hi' });
        assert.strictEqual(text, 'ahoy');
        assert.deepStrictEqual(server.calls[0].body.permission, DENY_ALL);
        const send = server.calls.find(call => call.path.endsWith('/message'));
        assert.deepStrictEqual(send.body.model, { providerID: 'opencode-go', modelID: 'beam-free' });
        assert.ok(server.calls.some(call => call.method === 'DELETE' && call.path === '/session/ses_1'));
    } finally {
        server.restore();
    }
});

test('model errors and empty replies throw so the fallback can run', async () => {
    let server = fakeServer(() => ({ info: { error: { data: { message: 'limit reached' } } }, parts: [] }));
    try {
        await assert.rejects(createChatClient().generate('a/b', { prompt: 'hi' }), /limit reached/);
    } finally {
        server.restore();
    }
    server = fakeServer(() => ({ info: {}, parts: [] }));
    try {
        await assert.rejects(createChatClient().generate('a/b', { prompt: 'hi' }), /no text/);
    } finally {
        server.restore();
    }
});
