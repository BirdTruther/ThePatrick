// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../scripts/cleanup-lib.js');
const showcase = require('../scripts/showcase.js');

const { F } = lib;
const G = 'g';

const cfg = {
    guildId: G,
    makiUserId: 'maki',
    channels: { rules: 'rules', quickLinks: 'quick', botCommands: 'cmds', showcase: 'show', welcome: 'welcome', status: 'status', streamAlerts: 'alerts', voiceLobby: 'lobby' },
    leaveAloneCategoryId: 'big',
    deleteChannels: { oldchan: 'cs2-commands' },
    deleteCategories: { oldcat: 'CS2' },
    deleteRoles: { dr: 'CS2' },
    kickBots: { epicbot: { name: 'EPIC RPG', roleId: 'epicrole' } },
    roles: { access: 'bb', mod: 'fl', streamBot: 'sc' },
    streamBotUserId: 'scuser',
    makiCleanupChannels: ['welcome', 'cmds', 'rules'],
};

const ow = (id, allow = 0n, deny = 0n, type = 0) => ({ id, type, allow: allow.toString(), deny: deny.toString() });
const role = (id, name, perms = 0n, extra = {}) => ({ id, name, permissions: perms.toString(), managed: false, ...extra });
const channel = (id, name, type, parent, overwrites = []) => ({ id, name, type, parent_id: parent || null, permission_overwrites: overwrites });

function guild() {
    const base = F.ViewChannel | F.SendMessages | F.UseApplicationCommands;
    return {
        guildId: G,
        roles: [
            role(G, '@everyone'),
            role('bb', 'Beaky Buddy', base),
            role('fl', 'Feather Lieutenant', base),
            role('sc', 'Streamcord', F.Administrator | F.ManageRoles | F.ViewChannel, { managed: true }),
            role('dr', 'CS2'),
            role('epicrole', 'EPIC RPG', 0n, { managed: true }),
        ],
        channels: [
            channel('top', 'TOP', 4),
            channel('gen', 'General', 4),
            channel('big', 'Big Boy Stuff', 4),
            channel('oldcat', 'CS2', 4),
            channel('rules', 'rules', 0, 'top', [ow(G, F.ViewChannel, F.SendMessages)]),
            channel('cmds', 'bot-commands', 0, 'gen', [ow('bb', F.ViewChannel | F.SendMessages), ow('fl', F.ViewChannel), ow(G, 0n, F.ViewChannel)]),
            channel('general', 'general', 0, 'gen', [ow(G, 0n, F.MentionEveryone)]),
            channel('alerts', 'yt-twitch-links', 0, 'top', [ow('bb', F.ViewChannel), ow(G, 0n, F.ViewChannel)]),
            channel('plex', 'plex', 0, 'big', [ow(G, 0n, F.ViewChannel)]),
            channel('oldchan', 'cs2-commands', 0, 'oldcat', [ow('dr', F.ViewChannel), ow(G, 0n, F.ViewChannel)]),
        ],
        members: [
            { id: 'owner', username: 'owner', bot: false, roles: ['bb'] },
            { id: 'plain', username: 'plain', bot: false, roles: ['bb', 'dr'] },
            { id: 'mod', username: 'mod', bot: false, roles: ['bb', 'fl'] },
            { id: 'scuser', username: 'Streamcord', bot: true, roles: ['sc'] },
            { id: 'epicbot', username: 'EPIC RPG', bot: true, roles: ['epicrole'] },
        ],
    };
}

const perms = (state, memberId, channelId) => {
    const member = state.members.find((m) => m.id === memberId);
    return lib.effectivePerms({
        memberId,
        roleIds: member.roles,
        rolePerms: lib.rolePermsOf(state),
        everyoneId: G,
        overwrites: state.channels.find((c) => c.id === channelId).permission_overwrites,
    });
};

test('permissions follow Discord\'s order, and no view means no access', () => {
    const rolePerms = { [G]: 0n, a: F.ViewChannel | F.SendMessages, admin: F.Administrator };
    const run = (roleIds, overwrites, memberId = 'm') => lib.effectivePerms({ memberId, roleIds, rolePerms, everyoneId: G, overwrites });

    assert.ok(run(['admin'], [ow(G, 0n, F.ViewChannel)]) & F.ViewChannel);
    assert.strictEqual(run(['a'], [ow(G, 0n, F.ViewChannel)]), 0n);
    assert.ok(run(['a'], [ow(G, 0n, F.SendMessages)]) & F.ViewChannel);
    assert.strictEqual(run(['a'], [ow(G, 0n, F.SendMessages)]) & F.SendMessages, 0n);
    assert.ok(run(['a'], [ow(G, 0n, F.SendMessages), ow('a', F.SendMessages)]) & F.SendMessages);
    assert.strictEqual(run(['a'], [ow('m', 0n, F.ViewChannel, 1)]), 0n);
});

test('the plan limits slash commands to the commands channel and leaves Big Boy Stuff alone', () => {
    const state = guild();
    const plan = lib.planChanges(state, cfg);
    assert.deepStrictEqual(plan.problems, []);

    const touched = new Set(plan.overwriteEdits.filter((e) => e.id === G).map((e) => e.channelId));
    assert.deepStrictEqual([...touched].sort(), ['alerts', 'gen', 'general', 'rules', 'top']);
    assert.ok(!touched.has('cmds') && !touched.has('plex') && !touched.has('big'));

    const after = lib.applyPlan(state, plan);
    assert.strictEqual(perms(after, 'owner', 'general') & F.UseApplicationCommands, 0n);
    assert.ok(perms(after, 'owner', 'general') & F.SendMessages);
    assert.ok(perms(after, 'owner', 'cmds') & F.UseApplicationCommands);
    assert.ok(perms(after, 'mod', 'cmds') & F.UseApplicationCommands);
    assert.strictEqual(perms(after, 'owner', 'rules') & F.UseApplicationCommands, 0n);
});

test('the plan lists what gets deleted and kicked', () => {
    const plan = lib.planChanges(guild(), cfg);
    assert.deepStrictEqual(plan.deleteChannelIds, ['oldchan']);
    assert.deepStrictEqual(plan.deleteCategoryIds, ['oldcat']);
    assert.deepStrictEqual(plan.deleteRoleIds, ['dr']);
    assert.deepStrictEqual(plan.kickUserIds, ['epicbot']);
    assert.deepStrictEqual(plan.botRoleIds, ['epicrole']);

    const after = lib.applyPlan(guild(), plan);
    assert.ok(!after.channels.some((c) => c.id === 'oldchan' || c.id === 'oldcat'));
    assert.ok(!after.members.some((m) => m.id === 'epicbot'));
    assert.deepStrictEqual(after.members.find((m) => m.id === 'plain').roles, ['bb']);
});

test('Streamcord loses Administrator but keeps posting its alerts', () => {
    const state = guild();
    const plan = lib.planChanges(state, cfg);
    assert.strictEqual(plan.roleEdits.length, 1);
    const after = lib.applyPlan(state, plan);
    const streamRole = after.roles.find((r) => r.id === 'sc');
    assert.strictEqual(BigInt(streamRole.permissions) & (F.Administrator | F.ManageRoles), 0n);

    const need = F.ViewChannel | F.SendMessages | F.EmbedLinks | F.ReadMessageHistory;
    assert.strictEqual(perms(after, 'scuser', 'alerts') & need, need);
    assert.strictEqual(perms(after, 'scuser', 'plex'), 0n); // Hidden channels stay hidden from it.
});

test('the access check sees only expected changes for this plan', () => {
    const state = guild();
    const plan = lib.planChanges(state, cfg);
    const summary = lib.summarizeDiff(lib.accessDiff(state, lib.applyPlan(state, plan), cfg), cfg);
    assert.ok(summary.length > 0);
    assert.deepStrictEqual(summary.filter((g) => !g.expected), []);
    assert.ok(summary.some((g) => g.channel === 'general' && g.bit === 'UseApplicationCommands' && g.change === 'lose'));
});

test('the access check flags a change that takes access away', () => {
    const state = guild();
    const plan = lib.planChanges(state, cfg);
    plan.overwriteEdits.push({ channelId: 'general', channelName: 'general', id: 'bb', type: 0, allow: '0', deny: F.ViewChannel.toString(), before: null });
    const summary = lib.summarizeDiff(lib.accessDiff(state, lib.applyPlan(state, plan), cfg), cfg);
    const flagged = summary.filter((g) => !g.expected);
    assert.ok(flagged.some((g) => g.channel === 'general' && g.bit === 'ViewChannel' && g.change === 'lose'));
});

test('the plan refuses to run against a server that has changed', () => {
    const renamed = guild();
    renamed.channels.find((c) => c.id === 'oldchan').name = 'something-new';
    assert.match(lib.planChanges(renamed, cfg).problems.join('\n'), /something-new/);

    const crowded = guild();
    crowded.channels.push(channel('keep', 'keep-me', 0, 'oldcat'));
    assert.match(lib.planChanges(crowded, cfg).problems.join('\n'), /still hold: keep-me/);

    const missing = guild();
    missing.roles = missing.roles.filter((r) => r.id !== 'dr');
    assert.match(lib.planChanges(missing, cfg).problems.join('\n'), /Role "CS2"/);

    const noOverwrite = guild();
    noOverwrite.channels.find((c) => c.id === 'cmds').permission_overwrites = [];
    assert.match(lib.planChanges(noOverwrite, cfg).problems.join('\n'), /no overwrite for role/);
});

test('only Maki\'s posts and the old notes are chosen for deletion', () => {
    const message = (id, authorId, content = '') => ({ id, author: { id: authorId }, content });
    const ids = (channelId, messages) => lib.messagesToDelete(channelId, messages, cfg, 'owner').map((m) => m.id);

    assert.deepStrictEqual(ids('welcome', [message('1', 'maki'), message('2', 'patrick'), message('3', 'owner')]), ['1']);
    assert.deepStrictEqual(ids('rules', [
        message('1', 'maki'),
        message('2', 'owner', 'please react to the above message from Maki.'),
        message('3', 'owner', 'Please choose your role above!'),
        message('4', 'owner', 'a normal message'),
        message('5', 'patrick', 'the new rules'),
    ]), ['1', '2', '3']);
    assert.deepStrictEqual(ids('quick', [message('1', 'owner'), message('2', 'ticket'), message('3', 'patrick')]), ['1']);
    assert.deepStrictEqual(ids('show', [message('1', 'owner'), message('2', 'patrick')]), ['1']);
    assert.deepStrictEqual(ids('general', [message('1', 'maki'), message('2', 'owner')]), []);
});

test('transcripts keep text, embeds, components and files', () => {
    const line = lib.transcriptLine({
        timestamp: '2026-01-01T00:00:00.000Z',
        author: { username: 'Maki', bot: true },
        content: 'hello',
        embeds: [{ title: 'T', description: 'D' }],
        components: [{ components: [{ content: 'inside' }] }],
        attachments: [{ filename: 'a.png', url: 'https://x/a.png' }],
    });
    assert.match(line, /Maki \(bot\): hello \| inside \| \[embed\] T - D \| \[file\] a\.png/);
});

test('the restore plan puts back deleted roles, channels, permissions and role holders', () => {
    const state = guild();
    const plan = lib.planChanges(state, cfg);
    const current = lib.applyPlan(state, plan);
    const restore = lib.buildRestorePlan(state, current, G);

    assert.deepStrictEqual(restore.createRoles.map((r) => r.id), ['dr']);
    assert.deepStrictEqual(restore.createChannels.map((c) => c.id), ['oldcat', 'oldchan']);
    assert.ok(restore.overwriteSets.some((s) => s.channelId === 'rules' && s.overwrite.id === G));
    assert.ok(restore.overwriteDeletes.some((d) => d.channelId === 'alerts' && d.overwrite.id === 'sc'));
    assert.deepStrictEqual(restore.rolePermissions.map((r) => r.roleId), ['sc']);
    assert.deepStrictEqual(restore.memberRoles, [{ userId: 'plain', username: 'plain', roleIds: ['dr'] }]);
});

test('restoring a server that already matches changes nothing', () => {
    const state = guild();
    const restore = lib.buildRestorePlan(state, state, G);
    for (const key of Object.keys(restore)) assert.deepStrictEqual(restore[key], [], key);
});

// ===== SHOWCASE =====

const registered = [
    ['ask', 'Ask the AI a question'], ['imagine', 'Generate an AI image'], ['meme', 'A random meme'], ['persona', 'Switch personality'],
    ['personas', 'List personalities'], ['code', 'The GitHub link'], ['price', 'Tarkov prices'], ['bestammo', 'Best ammo'],
    ['cs2case', 'Open a case'], ['cs2leaderboard', 'The board'], ['cs2stats', 'Player stats'], ['play', 'Play music'],
    ['hate', 'Manage the list'], ['brandnew', 'Something added later'],
].map(([name, description], i) => ({ name, description, id: String(100 + i) }));

test('the showcase lists exactly the registered commands and nothing else', () => {
    const messages = showcase.buildShowcase({ commands: registered, twitchNames: ['ask', 'cs2case'], avatarUrl: 'https://x/a.png', botCommandsChannelId: '555' });
    const text = JSON.stringify(messages);

    for (const command of registered) {
        if (command.name === 'hate') assert.ok(text.includes('`/hate`'));
        else assert.ok(text.includes(`</${command.name}:${command.id}>`), command.name);
    }
    for (const gone of ['cs2price', 'cs2float', 'cs2map', '/image', 'clearmemory']) assert.ok(!text.includes(gone), gone);
    assert.ok(text.includes('Something added later'));
    assert.ok(text.includes('<#555>'));
    assert.ok(!/DM control|shell/i.test(text));
});

test('showcase messages stay inside Discord\'s limits', () => {
    const messages = showcase.buildShowcase({ commands: registered, twitchNames: ['ask'], avatarUrl: 'https://x/a.png', botCommandsChannelId: '555' });
    for (const message of messages) {
        assert.ok(message.embeds.length >= 1 && message.embeds.length <= 10);
        assert.ok(message.embeds.reduce((sum, e) => sum + showcase.embedChars(e), 0) <= 6000);
        for (const embed of message.embeds) {
            assert.ok((embed.title || '').length <= 256);
            assert.ok((embed.description || '').length <= 4096);
        }
    }
    const buttons = messages.at(-1).components[0].components;
    assert.ok(buttons.length <= 5 && buttons.every((b) => b.label.length <= 80 && b.url.startsWith('https://')));
});

test('quick links and the commands note are valid messages', () => {
    const links = showcase.buildQuickLinks({ guildId: 'g1', voiceLobbyId: 'v1' });
    assert.ok(links.embeds[0].fields.every((f) => f.name.length <= 256 && f.value.length <= 1024));
    const urls = links.components[0].components.map((b) => b.url);
    assert.ok(urls.includes('https://discord.com/channels/g1/v1'));
    assert.ok(urls.every((u) => /^https:\/\//.test(u)));
    assert.deepStrictEqual(showcase.buildCommandsNote().allowed_mentions, { parse: [] });
});

test('Twitch command names are read from the source', () => {
    const source = "if (lowerMessage.startsWith('!price ')) {}\nif (lowerMessage === '!cs2case' || lowerMessage.startsWith('!cs2case ')) {}\nif (lowerMessage.startsWith('!ask ')) {}";
    assert.deepStrictEqual(showcase.parseTwitchCommands(source), ['price', 'cs2case', 'ask']);
});
