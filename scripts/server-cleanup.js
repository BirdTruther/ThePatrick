#!/usr/bin/env node
// scripts/server-cleanup.js
// Tidies Bird's Nest through Patrick: one commands channel, fewer roles, simpler
// permissions, and Patrick's name on the rules and quick links.
//
//   node scripts/server-cleanup.js                              dry run: lists every change, changes nothing
//   node scripts/server-cleanup.js --apply --part 1             safe part: snapshot, new messages, permissions, Streamcord
//   node scripts/server-cleanup.js --apply --part 2 --confirm-delete
//                                                               deletes channels, roles and old messages, kicks two bots
//   node scripts/server-cleanup.js --preview                    DMs you the new messages so you can see them before anything is posted
//   node scripts/server-cleanup.js --refresh-showcase           edits the #thepatrick-bot messages to match today's commands
//   node scripts/server-cleanup.js --restore <snapshot.json>    shows what a restore would do (add --apply to run it)
//
// Every apply takes a snapshot first, in data/server-snapshots/ (not in git).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');
const lib = require('./cleanup-lib.js');
const content = require('./showcase.js');

const cfg = lib.BIRDS_NEST;
const G = cfg.guildId;
const SNAPSHOT_DIR = path.join(ROOT, 'data', 'server-snapshots');
const STATE_FILE = path.join(ROOT, 'data', 'cleanup-state.json');
const OWNER_ID = (process.env.DM_ALLOWLIST || '').split(',')[0].trim();

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => argv[argv.indexOf(flag) + 1];

const rest = new REST({ makeRequest: fetch, timeout: 30_000 }).setToken(process.env.DISCORD_TOKEN);
const say = (...args) => console.log(...args);

// ===== SAVED STATE =====

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(patch) {
    const next = { ...loadState(), ...patch };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
    return next;
}

function setBotSetting(key, value) {
    const db = new Database(path.join(ROOT, 'data', 'bot-logs.db'));
    try {
        db.pragma('busy_timeout = 5000');
        db.prepare('INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)').run(key, String(value));
    } finally {
        db.close();
    }
}

// ===== READING DISCORD =====

async function pageMessages(channelId, max = 5000) {
    const out = [];
    let before;
    while (out.length < max) {
        const query = new URLSearchParams({ limit: '100' });
        if (before) query.set('before', before);
        let batch;
        try {
            batch = await rest.get(Routes.channelMessages(channelId), { query });
        } catch (err) {
            if (err.status === 403 || err.status === 404) break;
            throw err;
        }
        if (!batch.length) break;
        out.push(...batch);
        before = batch.at(-1).id;
        if (batch.length < 100) break;
    }
    return out;
}

async function fetchState() {
    const me = await rest.get(Routes.user());
    const [roles, channels, webhooks, commands] = await Promise.all([
        rest.get(Routes.guildRoles(G)),
        rest.get(Routes.guildChannels(G)),
        rest.get(Routes.guildWebhooks(G)),
        rest.get(Routes.applicationCommands(me.id)),
    ]);
    const members = [];
    let after = '0';
    for (;;) {
        const batch = await rest.get(Routes.guildMembers(G), { query: new URLSearchParams({ limit: '1000', after }) });
        members.push(...batch);
        if (batch.length < 1000) break;
        after = batch.at(-1).user.id;
    }
    return {
        guildId: G,
        me,
        roles,
        channels,
        webhooks,
        commands,
        members: members.map((m) => ({ id: m.user.id, username: m.user.username, bot: Boolean(m.user.bot), roles: m.roles })),
    };
}

// ===== SNAPSHOT =====

async function takeSnapshot(state, label) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(SNAPSHOT_DIR, `${stamp}-${label}`);
    fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });

    const snapshot = {
        takenAt: new Date().toISOString(),
        guildId: G,
        roles: state.roles,
        channels: state.channels,
        members: state.members,
        webhooks: state.webhooks.map((w) => ({ name: w.name, channel_id: w.channel_id })),
    };
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));

    // A text copy of every channel that is being deleted or having messages removed.
    const names = Object.fromEntries(state.channels.map((c) => [c.id, c.name]));
    const wanted = [
        ...Object.keys(cfg.deleteChannels).filter((id) => !cfg.skipTranscripts.includes(id)),
        cfg.channels.rules,
        cfg.channels.quickLinks,
        cfg.channels.showcase,
    ];
    let total = 0;
    for (const id of wanted) {
        const messages = (await pageMessages(id)).reverse();
        total += messages.length;
        const lines = messages.map(lib.transcriptLine);
        fs.writeFileSync(path.join(dir, 'transcripts', `${names[id] || id}-${id}.txt`), lines.join('\n') + '\n');
    }
    say(`Snapshot saved: ${dir} (${state.channels.length} channels, ${state.roles.length} roles, ${total} messages in text copies)`);
    return path.join(dir, 'snapshot.json');
}

// ===== DRY RUN =====

async function countMessages(plan) {
    const counts = {};
    for (const id of cfg.makiCleanupChannels.concat([cfg.channels.quickLinks, cfg.channels.showcase])) {
        const messages = await pageMessages(id, 3000);
        counts[id] = lib.messagesToDelete(id, messages, cfg, OWNER_ID).length;
    }
    return counts;
}

function printPlan(state, plan, diffSummary, messageCounts) {
    const names = Object.fromEntries(state.channels.map((c) => [c.id, c.name]));
    const roleNames = Object.fromEntries(state.roles.map((r) => [r.id, r.name]));

    say('\n=== PROBLEMS (must be empty before applying) ===');
    say(plan.problems.length ? plan.problems.map((p) => ` ! ${p}`).join('\n') : ' none');
    if (plan.notes.length) say(plan.notes.map((n) => ` note: ${n}`).join('\n'));

    say('\n=== PART 1 (safe, can be put back) ===');
    say(' 1. Snapshot of every channel, role and permission, plus text copies of channels about to be deleted');
    say(` 2. Post the rules in #${names[cfg.channels.rules]} (same text as Maki's, from Patrick) with a 👍`);
    say(` 3. Post the new quick links in #${names[cfg.channels.quickLinks]}`);
    say(` 4. Post and pin the slash-commands note in #${names[cfg.channels.botCommands]}`);
    say(` 5. Rebuild the showcase in #${names[cfg.channels.showcase]}`);
    say(` 6. ${plan.overwriteEdits.length} permission edits:`);
    for (const e of plan.overwriteEdits) {
        const who = e.id === G ? '@everyone' : roleNames[e.id] || e.id;
        say(`      #${e.channelName}: ${who} — ${e.reason}${e.before ? '' : ' (new overwrite)'}`);
    }
    for (const e of plan.roleEdits) say(` 7. ${e.roleName} role loses Administrator and Manage Roles`);

    say('\n=== PART 2 (deletes things, needs --confirm-delete) ===');
    say(` 8. Delete ${plan.deleteChannelIds.length} channels: ${plan.deleteChannelIds.map((id) => '#' + names[id]).join(', ')}`);
    say(` 9. Delete ${plan.deleteCategoryIds.length} empty categories: ${plan.deleteCategoryIds.map((id) => names[id]).join(', ')}`);
    say(`10. Delete messages: ${Object.entries(messageCounts).map(([id, n]) => `${n} in #${names[id]}`).join(', ')}`);
    say(`11. Kick: ${plan.kickUserIds.map((id) => state.members.find((m) => m.id === id).username).join(', ')}`);
    say(`12. Delete ${plan.deleteRoleIds.length} roles: ${plan.deleteRoleIds.map((id) => roleNames[id]).join(', ')}`);
    const holders = (id) => state.members.filter((m) => !m.bot && m.roles.includes(id)).length;
    say(`    (members who hold them: ${plan.deleteRoleIds.map((id) => `${roleNames[id]} ${holders(id)}`).join(', ')})`);

    say('\n=== WHO GAINS OR LOSES ACCESS (every member, every channel that stays) ===');
    const unexpected = diffSummary.filter((g) => !g.expected);
    say(unexpected.length ? ` UNEXPECTED CHANGES: ${unexpected.length}` : ' No unexpected changes: only slash commands move, plus Streamcord\'s own permissions.');
    for (const g of unexpected) say(`   ! #${g.channel}: ${g.count} members ${g.change} ${g.bit}`);
    const slash = diffSummary.filter((g) => g.bit === 'UseApplicationCommands' && g.expected && g.channel !== undefined);
    const lose = slash.filter((g) => g.change === 'lose');
    const gain = slash.filter((g) => g.change === 'gain');
    say(` Slash commands: ${lose.length} channels and categories lose them for members (everything except #${names[cfg.channels.botCommands]} and Big Boy Stuff)`);
    if (gain.length) for (const g of gain) say(`   gain in #${g.channel}: ${g.count} members`);
    const streamRows = diffSummary.filter((g) => g.bit !== 'UseApplicationCommands' && g.expected);
    if (streamRows.length) {
        const bits = {};
        for (const g of streamRows) (bits[`${g.change} ${g.bit}`] = bits[`${g.change} ${g.bit}`] || []).push(g.channel);
        say(' Streamcord, without Administrator:');
        for (const [what, channels] of Object.entries(bits)) say(`   ${what} in ${channels.length} channels (${channels.slice(0, 4).join(', ')}${channels.length > 4 ? ', ...' : ''})`);
        say(`   It keeps full access to #${names[cfg.channels.streamAlerts]}, where its alerts post.`);
    }
    const sample = lose.find((g) => g.channel === 'general');
    if (sample) say(` e.g. #general: ${[...sample.roleSets.entries()].map(([set, n]) => `${set} (${n})`).join('; ')}`);
}

async function dryRun() {
    const state = await fetchState();
    const plan = lib.planChanges(state, cfg);
    const after = lib.applyPlan(state, plan);
    const summary = lib.summarizeDiff(lib.accessDiff(state, after, cfg), cfg);
    const counts = await countMessages(plan);
    printPlan(state, plan, summary, counts);
    say('\nNothing was changed.');
    return { state, plan, summary };
}

// ===== PART 1 =====

async function putMessage(channelId, body, existingId) {
    if (existingId) {
        try {
            return await rest.patch(Routes.channelMessage(channelId, existingId), { body });
        } catch (err) {
            if (err.status !== 404) throw err; // Deleted by hand, so post it again.
        }
    }
    return rest.post(Routes.channelMessages(channelId), { body });
}

async function pinMessage(channelId, messageId) {
    try {
        await rest.put(`/channels/${channelId}/messages/pins/${messageId}`);
    } catch {
        await rest.put(`/channels/${channelId}/pins/${messageId}`);
    }
}

async function postShowcase(state) {
    const me = state.me;
    const avatarUrl = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=256` : undefined;
    const twitch = content.parseTwitchCommands(fs.readFileSync(path.join(ROOT, 'services', 'twitch.js'), 'utf8'));
    const messages = content.buildShowcase({
        commands: state.commands,
        twitchNames: twitch,
        avatarUrl,
        botCommandsChannelId: cfg.channels.botCommands,
    });
    const saved = loadState().showcaseMessageIds || [];
    const ids = [];
    for (let i = 0; i < messages.length; i++) {
        const sent = await putMessage(cfg.channels.showcase, { ...messages[i], allowed_mentions: { parse: [] } }, saved[i]);
        ids.push(sent.id);
    }
    // Leftover messages from an earlier, longer showcase.
    for (const stale of saved.slice(messages.length)) {
        await rest.delete(Routes.channelMessage(cfg.channels.showcase, stale)).catch(() => {});
    }
    saveState({ showcaseMessageIds: ids });
    say(` Showcase: ${ids.length} messages in #thepatrick-bot`);
}

async function part1() {
    const state = await fetchState();
    const plan = lib.planChanges(state, cfg);
    if (plan.problems.length) throw new Error(`Stopping. The server doesn't match the plan:\n${plan.problems.join('\n')}`);
    const summary = lib.summarizeDiff(lib.accessDiff(state, lib.applyPlan(state, plan), cfg), cfg);
    if (summary.some((g) => !g.expected)) throw new Error('Stopping. The access check found unexpected changes. Run the dry run to see them.');

    await takeSnapshot(state, 'before-part-1');
    let saved = loadState();

    // Rules: Patrick posts the same text Maki did.
    if (!saved.rulesMessageId) {
        const original = await rest.get(Routes.channelMessage(cfg.channels.rules, cfg.makiRulesMessageId));
        if (!original.content) throw new Error('Maki\'s rules message has no text to copy.');
        const posted = await rest.post(Routes.channelMessages(cfg.channels.rules), { body: { content: original.content, allowed_mentions: { parse: [] } } });
        await rest.put(Routes.channelMessageOwnReaction(cfg.channels.rules, posted.id, encodeURIComponent('👍')));
        saved = saveState({ rulesMessageId: posted.id });
        setBotSetting(`rulesMessageId:${G}`, posted.id);
        say(` Rules posted: ${posted.id}`);
    } else {
        setBotSetting(`rulesMessageId:${G}`, saved.rulesMessageId);
        say(` Rules already posted: ${saved.rulesMessageId}`);
    }

    const links = await putMessage(cfg.channels.quickLinks, content.buildQuickLinks({ guildId: G, voiceLobbyId: cfg.channels.voiceLobby }), saved.quickLinksMessageId);
    saveState({ quickLinksMessageId: links.id });
    say(` Quick links: ${links.id}`);

    const note = await putMessage(cfg.channels.botCommands, content.buildCommandsNote(), saved.commandsNoteMessageId);
    await pinMessage(cfg.channels.botCommands, note.id);
    saveState({ commandsNoteMessageId: note.id });
    say(` Commands note pinned: ${note.id}`);

    await postShowcase(state);

    // Streamcord first, so its alerts never go without access.
    for (const edit of plan.overwriteEdits.filter((e) => e.id === cfg.roles.streamBot)) {
        await rest.put(Routes.channelPermission(edit.channelId, edit.id), { body: { type: edit.type, allow: edit.allow, deny: edit.deny }, reason: edit.reason });
    }
    for (const edit of plan.roleEdits) {
        await rest.patch(Routes.guildRole(G, edit.roleId), { body: { permissions: edit.permissions }, reason: 'Streamcord no longer needs Administrator' });
        say(` ${edit.roleName}: Administrator and Manage Roles removed`);
    }
    for (const edit of plan.overwriteEdits.filter((e) => e.id !== cfg.roles.streamBot)) {
        await rest.put(Routes.channelPermission(edit.channelId, edit.id), { body: { type: edit.type, allow: edit.allow, deny: edit.deny }, reason: edit.reason });
    }
    say(` ${plan.overwriteEdits.length} permission edits applied`);

    const check = await fetchState();
    const verify = lib.planChanges(check, cfg);
    const left = verify.overwriteEdits.filter((e) => e.id !== cfg.roles.streamBot || e.before === null);
    say(left.length ? ` Check: ${left.length} edits still pending (${left.map((e) => '#' + e.channelName).join(', ')})` : ' Check: every permission edit is in place');
    say('\nPart 1 done. Nothing was deleted.');
}

// ===== PART 2 =====

async function deleteWithProgress(label, items, remove) {
    let done = 0;
    for (const item of items) {
        try { await remove(item); } catch (err) { if (err.status !== 404) throw err; }
        done++;
        if (done % 50 === 0) say(`   ${label}: ${done}/${items.length}`);
    }
}

async function part2() {
    if (!has('--confirm-delete')) throw new Error('Part 2 deletes things. Add --confirm-delete to run it.');
    const saved = loadState();
    if (!saved.rulesMessageId || !saved.quickLinksMessageId || !(saved.showcaseMessageIds || []).length) {
        throw new Error('Part 1 has not finished. Run it first.');
    }
    const state = await fetchState();
    const plan = lib.planChanges(state, cfg);
    const stillPending = plan.overwriteEdits.filter((e) => e.id !== cfg.roles.streamBot);
    if (stillPending.length) throw new Error('Part 1\'s permission edits are not all in place.');
    await rest.get(Routes.channelMessage(cfg.channels.rules, saved.rulesMessageId)); // Throws if the new rules are gone.

    await takeSnapshot(state, 'before-part-2');
    const names = Object.fromEntries(state.channels.map((c) => [c.id, c.name]));

    // Message lists are read before anything is deleted.
    const doomed = {};
    for (const id of cfg.makiCleanupChannels.concat([cfg.channels.quickLinks, cfg.channels.showcase])) {
        const keep = new Set([saved.rulesMessageId, saved.quickLinksMessageId, saved.commandsNoteMessageId, ...(saved.showcaseMessageIds || [])]);
        doomed[id] = lib.messagesToDelete(id, await pageMessages(id, 5000), cfg, OWNER_ID).filter((m) => !keep.has(m.id));
    }

    say('Deleting channels...');
    for (const id of plan.deleteChannelIds) {
        await rest.delete(Routes.channel(id), { reason: 'Server cleanup' }).catch((e) => { if (e.status !== 404) throw e; });
        say(`   #${names[id]}`);
    }
    for (const id of plan.deleteCategoryIds) {
        await rest.delete(Routes.channel(id), { reason: 'Server cleanup' }).catch((e) => { if (e.status !== 404) throw e; });
        say(`   category ${names[id]}`);
    }

    say('Deleting old messages...');
    for (const [id, messages] of Object.entries(doomed)) {
        if (!messages.length) continue;
        say(`   #${names[id]}: ${messages.length}`);
        await deleteWithProgress(`#${names[id]}`, messages, (m) => rest.delete(Routes.channelMessage(id, m.id)));
    }

    say('Kicking bots...');
    for (const userId of plan.kickUserIds) {
        await rest.delete(Routes.guildMember(G, userId), { reason: 'Server cleanup' });
        say(`   ${state.members.find((m) => m.id === userId).username}`);
    }

    say('Deleting roles...');
    for (const roleId of plan.deleteRoleIds) {
        await rest.delete(Routes.guildRole(G, roleId), { reason: 'Server cleanup' }).catch((e) => { if (e.status !== 404) throw e; });
        say(`   ${state.roles.find((r) => r.id === roleId).name}`);
    }

    const after = await fetchState();
    const leftovers = [
        ...plan.deleteChannelIds.concat(plan.deleteCategoryIds).filter((id) => after.channels.some((c) => c.id === id)).map((id) => `channel ${names[id]}`),
        ...plan.deleteRoleIds.filter((id) => after.roles.some((r) => r.id === id)).map((id) => `role ${id}`),
        ...plan.kickUserIds.filter((id) => after.members.some((m) => m.id === id)).map((id) => `bot ${id}`),
    ];
    say(leftovers.length ? `\nStill there: ${leftovers.join(', ')}` : '\nCheck: everything planned is gone.');
    say(`Server now has ${after.channels.length} channels and ${after.roles.length} roles.`);
}

// ===== RESTORE =====

async function restore() {
    const file = valueOf('--restore');
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    const current = await fetchState();
    const plan = lib.buildRestorePlan(snapshot, current, G);

    say('Restore would:');
    say(` recreate ${plan.createRoles.length} roles: ${plan.createRoles.map((r) => r.name).join(', ') || 'none'}`);
    say(` recreate ${plan.createChannels.length} channels: ${plan.createChannels.map((c) => c.name).join(', ') || 'none'}`);
    say(` reset ${plan.overwriteSets.length} permission overwrites and remove ${plan.overwriteDeletes.length}`);
    say(` reset permissions on ${plan.rolePermissions.map((r) => r.roleName).join(', ') || 'no roles'}`);
    say(` give roles back to ${plan.memberRoles.length} members`);
    say('It cannot bring back deleted messages, kicked bots, webhooks or channel order.');
    if (!has('--apply')) return say('\nNothing was changed. Add --apply to restore.');

    const roleMap = new Map();
    const channelMap = new Map();
    for (const old of plan.createRoles) {
        const made = await rest.post(Routes.guildRoles(G), { body: { name: old.name, color: old.color, hoist: old.hoist, mentionable: old.mentionable, permissions: String(old.permissions) }, reason: 'Restore' });
        roleMap.set(old.id, made.id);
        say(` role ${old.name}`);
    }
    const mapId = (id) => roleMap.get(id) || channelMap.get(id) || id;
    const known = new Set([...current.roles.map((r) => r.id), ...current.members.map((m) => m.id), G, ...roleMap.keys()]);
    for (const old of plan.createChannels) {
        const made = await rest.post(Routes.guildChannels(G), {
            body: {
                name: old.name,
                type: old.type,
                topic: old.topic || undefined,
                nsfw: old.nsfw || undefined,
                bitrate: old.bitrate || undefined,
                user_limit: old.user_limit || undefined,
                parent_id: old.parent_id ? mapId(old.parent_id) : undefined,
                permission_overwrites: old.permission_overwrites.filter((o) => known.has(o.id)).map((o) => ({ id: mapId(o.id), type: o.type, allow: String(o.allow), deny: String(o.deny) })),
            },
            reason: 'Restore',
        });
        channelMap.set(old.id, made.id);
        say(` channel ${old.name}`);
    }
    for (const set of plan.overwriteSets) {
        await rest.put(Routes.channelPermission(set.channelId, mapId(set.overwrite.id)), { body: { type: set.overwrite.type, allow: String(set.overwrite.allow), deny: String(set.overwrite.deny) }, reason: 'Restore' });
    }
    for (const del of plan.overwriteDeletes) {
        await rest.delete(Routes.channelPermission(del.channelId, del.overwrite.id), { reason: 'Restore' }).catch(() => {});
    }
    for (const r of plan.rolePermissions) await rest.patch(Routes.guildRole(G, r.roleId), { body: { permissions: r.permissions }, reason: 'Restore' });
    for (const m of plan.memberRoles) {
        for (const roleId of m.roleIds) await rest.put(Routes.guildMemberRole(G, m.userId, mapId(roleId)), { reason: 'Restore' }).catch(() => {});
    }
    say('\nRestore done.');
}

// ===== PREVIEW =====

// Sends the new messages to the owner's DMs, so they can be seen (and Discord can reject anything
// malformed) before anything is posted in the server.
async function preview() {
    if (!OWNER_ID) throw new Error('DM_ALLOWLIST has no owner id to send the preview to.');
    const state = await fetchState();
    const dm = await rest.post(Routes.userChannels(), { body: { recipient_id: OWNER_ID } });
    const send = (body) => rest.post(Routes.channelMessages(dm.id), { body });
    const avatarUrl = state.me.avatar ? `https://cdn.discordapp.com/avatars/${state.me.id}/${state.me.avatar}.png?size=256` : undefined;
    const twitch = content.parseTwitchCommands(fs.readFileSync(path.join(ROOT, 'services', 'twitch.js'), 'utf8'));

    await send({ content: '**Preview 1: #quick-links**' });
    await send(content.buildQuickLinks({ guildId: G, voiceLobbyId: cfg.channels.voiceLobby }));
    await send({ content: '**Preview 2: pinned note in #bot-commands**' });
    await send(content.buildCommandsNote());
    await send({ content: '**Preview 3: #thepatrick-bot showcase**' });
    const messages = content.buildShowcase({ commands: state.commands, twitchNames: twitch, avatarUrl, botCommandsChannelId: cfg.channels.botCommands });
    for (const message of messages) await send({ ...message, allowed_mentions: { parse: [] } });
    say(`Preview sent to your DMs: 2 quick-link messages and ${messages.length} showcase messages. Nothing was posted in the server.`);
}

// ===== MAIN =====

async function main() {
    if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
    if (has('--restore')) return restore();
    if (has('--preview')) return preview();
    if (has('--refresh-showcase')) return postShowcase(await fetchState());
    if (!has('--apply')) return dryRun();
    const part = valueOf('--part');
    if (part === '1') return part1();
    if (part === '2') return part2();
    throw new Error('Use --part 1 or --part 2 with --apply.');
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err.message);
    process.exit(1);
});
