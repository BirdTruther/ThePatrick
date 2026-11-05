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

test('long output falls back to raw text when the summary fails', async () => {
    const calls = { replies: [], sends: [] };
    const handler = createDmHandler({
        allowed: parseAllowlist(OWNER),
        runner: {
            status: () => null,
            run: async () => ({ text: 'z'.repeat(4000), toolCount: 1 }),
        },
        summarize: async () => { throw new Error('credits depleted'); },
    });
    await handler({
        guildId: null,
        author: { id: OWNER, bot: false },
        content: 'long job',
        reply: async () => ({ edit: async () => {} }),
        channel: { send: async (text) => { calls.sends.push(text); } },
    });
    assert.ok(calls.sends.length >= 2);
    assert.ok(calls.sends.every(text => typeof text === 'string' && text.length <= 2000));
    assert.strictEqual(calls.sends.slice(0, -1).join(''), 'z'.repeat(4000));
    assert.match(calls.sends.at(-1), /summary unavailable/);
});

test('empty allowlist allows nobody', () => {
    assert.strictEqual(parseAllowlist('').size, 0);
    assert.strictEqual(parseAllowlist(undefined).size, 0);
    assert.strictEqual(parseAllowlist(' , ').size, 0);
});
