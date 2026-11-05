// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { ChannelType } = require('discord.js');
const { createGuildAutomation } = require('../guild-automation.js');

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const config = {
    g1: { accessRoleId: 'beaky', rulesMessageId: 'rules', welcomeChannelId: 'welcome', voiceLobbyId: 'lobby', voiceCategoryId: 'voice',
        reactionRoles: { games: { '🔫': 'tarkov', '☠': 'sevendays' }, cultist: { '👍': 'cultist' } } },
};

function setup({ maki = false, recentJoin = true } = {}) {
    const sent = [];
    const channels = new Map();
    const memberCache = new Map();
    let nextId = 1;
    const saved = { g1: [] };

    const guild = {
        id: 'g1',
        members: {
            cache: memberCache,
            fetch: async (id) => (id ? memberCache.get(id) : memberCache),
        },
        channels: {
            cache: channels,
            create: async (options) => {
                const channel = fakeChannel(`temp${nextId++}`, options.name, options.parent);
                channel.options = options;
                channels.set(channel.id, channel);
                return channel;
            },
        },
    };

    function fakeChannel(id, name, parentId) {
        return {
            id, name, parentId, guild, type: ChannelType.GuildVoice, members: new Map(), deleted: false,
            permissionOverwrites: { cache: new Map([['everyone', { id: 'everyone', type: 0, allow: 0n, deny: 1024n }]]) },
            async delete() { this.deleted = true; channels.delete(id); },
            async send(message) { sent.push(message); },
        };
    }

    function fakeMember(id, extra = {}) {
        const roles = new Set(extra.roles || []);
        const member = {
            id,
            guild,
            displayName: extra.displayName || id,
            pending: extra.pending || false,
            partial: false,
            joinedTimestamp: recentJoin ? NOW - DAY : NOW - 30 * DAY,
            user: { id, username: id, bot: extra.bot || false },
            roles: { cache: { has: (role) => roles.has(role) }, add: async (role) => { roles.add(role); }, remove: async (role) => { roles.delete(role); } },
            voice: { setChannel: extra.setChannel || (async (channel) => { member.movedTo = channel; }) },
            hasRole: (role) => roles.has(role),
        };
        memberCache.set(id, member);
        return member;
    }

    channels.set('welcome', fakeChannel('welcome', 'welcome-channel', null));
    channels.set('voice', fakeChannel('voice', 'Voice Channels', null));
    channels.set('lobby', fakeChannel('lobby', 'Join this', 'voice'));
    if (maki) fakeMember('maki', { bot: true });

    const automation = createGuildAutomation({
        config,
        now: () => NOW,
        makiUserId: 'maki',
        store: { read: (id) => saved[id], write: (id, ids) => { saved[id] = ids; } },
    });
    return { automation, guild, sent, channels, saved, fakeChannel, fakeMember };
}

const voiceState = (guild, channel, member) => ({
    guild, member, channelId: channel?.id || null, channel: channel || null,
});

test('accepting the rules gives the access role', async () => {
    const { automation, guild, fakeMember } = setup();
    await automation.onReady([guild]);
    const member = fakeMember('new');
    await automation.onMemberUpdate({ pending: true, partial: false }, member);
    assert.ok(member.hasRole('beaky'));
});

test('no access role while the rules are still pending', async () => {
    const { automation, guild, fakeMember } = setup();
    await automation.onReady([guild]);
    const member = fakeMember('new', { pending: true });
    await automation.onMemberAdd(member);
    await automation.onMemberUpdate({ pending: true, partial: false }, member);
    assert.strictEqual(member.hasRole('beaky'), false);
});

test('ordinary updates never hand access to established members without it', async () => {
    const { automation, fakeMember } = setup({ recentJoin: false });
    const member = fakeMember('oldtimer');
    await automation.onMemberUpdate({ pending: false, partial: false }, member);
    await automation.onMemberUpdate({ pending: null, partial: true }, member);
    assert.strictEqual(member.hasRole('beaky'), false);
});

test('a restart catches up on recent joiners but leaves everyone else alone', async () => {
    const recent = setup();
    const missed = recent.fakeMember('missed');
    const stillPending = recent.fakeMember('pending', { pending: true });
    const bot = recent.fakeMember('somebot', { bot: true });
    await recent.automation.onReady([recent.guild]);
    assert.ok(missed.hasRole('beaky'));
    assert.strictEqual(stillPending.hasRole('beaky'), false);
    assert.strictEqual(bot.hasRole('beaky'), false);

    const old = setup({ recentJoin: false });
    const oldtimer = old.fakeMember('oldtimer');
    await old.automation.onReady([old.guild]);
    assert.strictEqual(oldtimer.hasRole('beaky'), false);
});

test('the access role still works while Maki is in the server', async () => {
    const { automation, guild, fakeMember } = setup({ maki: true });
    await automation.onReady([guild]);
    const member = fakeMember('new');
    await automation.onMemberUpdate({ pending: true, partial: false }, member);
    assert.ok(member.hasRole('beaky'));
});

test('only a thumbs up on the rules message gives access', async () => {
    const { automation, guild, fakeMember } = setup({ recentJoin: false });
    const member = fakeMember('someone');
    const user = member.user;
    await automation.onReactionAdd({ message: { id: 'other', guild }, emoji: { name: '👍' } }, user);
    await automation.onReactionAdd({ message: { id: 'rules', guild }, emoji: { name: '🔥' } }, user);
    assert.strictEqual(member.hasRole('beaky'), false);
    await automation.onReactionAdd({ message: { id: 'rules', guild }, emoji: { name: '👍' } }, user);
    assert.ok(member.hasRole('beaky'));
});

test('reactions add and remove their own role only', async () => {
    const { automation, guild, fakeMember } = setup({ recentJoin: false });
    const member = fakeMember('someone');
    const react = (id, name) => ({ message: { id, guild }, emoji: { name } });

    await automation.onReactionAdd(react('games', '🔫'), member.user);
    assert.ok(member.hasRole('tarkov'));
    assert.strictEqual(member.hasRole('beaky'), false);

    await automation.onReactionAdd(react('games', '☠️'), member.user); // Skull with its style character
    assert.ok(member.hasRole('sevendays'));

    await automation.onReactionAdd(react('cultist', '👍'), member.user);
    assert.ok(member.hasRole('cultist'));

    await automation.onReactionRemove(react('games', '🔫'), member.user);
    assert.strictEqual(member.hasRole('tarkov'), false);
    assert.ok(member.hasRole('sevendays'));
});

test('unmapped reactions, bots and members who left change nothing', async () => {
    const { automation, guild, fakeMember } = setup({ recentJoin: false });
    const member = fakeMember('someone', { roles: ['tarkov'] });
    const react = (id, name) => ({ message: { id, guild }, emoji: { name } });

    await automation.onReactionAdd(react('games', '6️⃣'), member.user);
    await automation.onReactionRemove(react('other', '🔫'), member.user);
    assert.ok(member.hasRole('tarkov'));

    const bot = fakeMember('somebot', { bot: true });
    await automation.onReactionAdd(react('games', '☠️'), bot.user);
    assert.strictEqual(bot.hasRole('sevendays'), false);

    guild.members.fetch = async () => { throw new Error('Unknown Member'); };
    await automation.onReactionRemove(react('games', '🔫'), { id: 'gone', bot: false });
});

test('the rules thumbs up stays add-only, and a restart gives no reaction roles', async () => {
    const { automation, guild, fakeMember } = setup();
    const member = fakeMember('someone', { roles: ['beaky'] });
    await automation.onReactionRemove({ message: { id: 'rules', guild }, emoji: { name: '👍' } }, member.user);
    assert.ok(member.hasRole('beaky'));

    await automation.onReady([guild]);
    assert.strictEqual(member.hasRole('tarkov'), false);
    assert.strictEqual(member.hasRole('cultist'), false);
});

test('welcome and leave messages stay quiet until Maki is gone', async () => {
    const withMaki = setup({ maki: true });
    await withMaki.automation.onReady([withMaki.guild]);
    await withMaki.automation.onMemberAdd(withMaki.fakeMember('a'));
    await withMaki.automation.onMemberRemove(withMaki.fakeMember('b'));
    assert.strictEqual(withMaki.sent.length, 0);

    const { automation, guild, sent, fakeMember } = setup();
    await automation.onReady([guild]);
    await automation.onMemberAdd(fakeMember('a'));
    await automation.onMemberRemove(fakeMember('b'));
    await automation.onMemberAdd(fakeMember('c', { bot: true }));
    assert.strictEqual(sent[0].content, 'Welcome <@a>!');
    assert.deepStrictEqual(sent[0].allowedMentions, { users: ['a'] });
    assert.strictEqual(sent[1].content, '<@b> has left! I wonder why?');
    assert.deepStrictEqual(sent[1].allowedMentions, { parse: [] });
    assert.strictEqual(sent.length, 2);
});

test('nothing posts before the member list has loaded', async () => {
    const { automation, sent, fakeMember } = setup();
    await automation.onMemberAdd(fakeMember('a'));
    assert.strictEqual(sent.length, 0);
});

test('joining the lobby makes a channel, and leaving it empty deletes it', async () => {
    const { automation, guild, channels, saved, fakeMember } = setup();
    await automation.onReady([guild]);
    const member = fakeMember('owner', { displayName: 'Alex' });
    const lobby = channels.get('lobby');
    await automation.onVoiceStateUpdate(voiceState(guild, null, member), voiceState(guild, lobby, member));

    const channel = member.movedTo;
    assert.strictEqual(channel.name, "Alex's Channel");
    assert.strictEqual(channel.options.userLimit, 5);
    assert.strictEqual(channel.options.bitrate, 64000);
    assert.strictEqual(channel.options.parent, 'voice');
    assert.strictEqual(channel.options.permissionOverwrites[0].id, 'everyone');
    assert.deepStrictEqual(channel.options.permissionOverwrites[1], { id: 'owner', allow: 285212688n });
    assert.deepStrictEqual(saved.g1, [channel.id]);

    channel.members.set('friend', {});
    await automation.onVoiceStateUpdate(voiceState(guild, channel, member), voiceState(guild, null, member));
    assert.strictEqual(channel.deleted, false);

    channel.members.clear();
    await automation.onVoiceStateUpdate(voiceState(guild, channel, member), voiceState(guild, null, member));
    assert.strictEqual(channel.deleted, true);
    assert.deepStrictEqual(saved.g1, []);
});

test('temp voice leaves everything to Maki while it is in the server', async () => {
    const { automation, guild, channels, fakeChannel, fakeMember } = setup({ maki: true });
    await automation.onReady([guild]);
    const member = fakeMember('owner');
    await automation.onVoiceStateUpdate(voiceState(guild, null, member), voiceState(guild, channels.get('lobby'), member));
    assert.strictEqual(member.movedTo, undefined);

    const makiChannel = fakeChannel('m1', "Sam's Channel", 'voice');
    channels.set('m1', makiChannel);
    await automation.onVoiceStateUpdate(voiceState(guild, makiChannel, member), voiceState(guild, null, member));
    assert.strictEqual(makiChannel.deleted, false);
});

test('a restart clears empty temp channels, including ones Maki left, but no others', async () => {
    const { automation, guild, channels, fakeChannel } = setup();
    const leftover = fakeChannel('m1', "Sam's Channel", 'voice');
    const inUse = fakeChannel('m2', "Kim's Channel", 'voice');
    inUse.members.set('kim', {});
    const normal = fakeChannel('n1', 'Dumpster Fire', 'voice');
    const elsewhere = fakeChannel('e1', "Admin's Channel", 'admin');
    for (const channel of [leftover, inUse, normal, elsewhere]) channels.set(channel.id, channel);

    await automation.onReady([guild]);
    assert.strictEqual(leftover.deleted, true);
    assert.strictEqual(inUse.deleted, false);
    assert.strictEqual(normal.deleted, false);
    assert.strictEqual(elsewhere.deleted, false);
    assert.strictEqual(channels.get('lobby').deleted, false);
});

test('a failed move removes the new channel, and hopping back in is rate limited', async () => {
    const { automation, guild, channels, fakeMember } = setup();
    await automation.onReady([guild]);
    const member = fakeMember('gone', { setChannel: async () => { throw new Error('left voice'); } });
    const lobby = channels.get('lobby');
    await assert.rejects(
        automation.onVoiceStateUpdate(voiceState(guild, null, member), voiceState(guild, lobby, member)),
        /left voice/,
    );
    assert.strictEqual([...channels.keys()].some((id) => id.startsWith('temp')), false);

    await automation.onVoiceStateUpdate(voiceState(guild, null, member), voiceState(guild, lobby, member));
    assert.strictEqual([...channels.keys()].some((id) => id.startsWith('temp')), false);
});

test('other servers are ignored', async () => {
    const automation = createGuildAutomation({ config, store: { read: () => [], write: () => {} } });
    const added = [];
    const member = {
        guild: { id: 'other' },
        pending: false,
        user: { bot: false },
        roles: { cache: { has: () => false }, add: async (role) => added.push(role) },
    };
    await automation.onMemberAdd(member);
    await automation.onMemberUpdate({ pending: true }, member);
    assert.strictEqual(added.length, 0);
});
