// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { createDmHandler, parseAllowlist } = require('../dm-handler.js');

const OWNER = '111';
const STRANGER = '222';

function setup() {
    const calls = { replies: [], sends: [], runs: [], logs: [] };
    const status = { edit: async () => {} };
    const runner = {
        status: () => null,
        cancel: async () => false,
        reset: () => {},
        run: async (userId, text) => { calls.runs.push(text); return { text: 'ok', toolCount: 0 }; },
    };
    const handler = createDmHandler({
        allowed: parseAllowlist(OWNER),
        runner,
        summarize: async (text) => text,
        log: (...args) => calls.logs.push(args),
    });
    const dm = (authorId, content, extra = {}) => ({
        guildId: null,
        author: { id: authorId, bot: false },
        content,
        reply: async (text) => { calls.replies.push(text); return status; },
        channel: { send: async (text) => { calls.sends.push(text); } },
        ...extra,
    });
    return { handler, dm, calls };
}

function assertSilent(calls) {
    assert.deepStrictEqual(calls, { replies: [], sends: [], runs: [], logs: [] });
}

test('stranger DM is ignored completely', async () => {
    const { handler, dm, calls } = setup();
    await handler(dm(STRANGER, 'restart the server'));
    assertSilent(calls);
});

test('stranger cannot use control commands', async () => {
    const { handler, dm, calls } = setup();
    for (const command of ['!cancel', '!status', '!new']) await handler(dm(STRANGER, command));
    assertSilent(calls);
});

test('owner in a server channel does not reach the agent', async () => {
    const { handler, dm, calls } = setup();
    await handler(dm(OWNER, 'hello', { guildId: '999' }));
    assertSilent(calls);
});

test('bot authors are ignored even if allowlisted', async () => {
    const { handler, dm, calls } = setup();
    await handler(dm(OWNER, 'hello', { author: { id: OWNER, bot: true } }));
    assertSilent(calls);
});

test('owner DM acks, runs the raw message and delivers the result', async () => {
    const { handler, dm, calls } = setup();
    await handler(dm(OWNER, 'check disk'));
    assert.deepStrictEqual(calls.runs, ['check disk']);
    assert.match(calls.replies[0], /on it/);
    assert.deepStrictEqual(calls.sends, ['ok']);
});

test('empty allowlist allows nobody', () => {
    assert.strictEqual(parseAllowlist('').size, 0);
    assert.strictEqual(parseAllowlist(undefined).size, 0);
    assert.strictEqual(parseAllowlist(' , ').size, 0);
});
