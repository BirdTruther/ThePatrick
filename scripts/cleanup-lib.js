// scripts/cleanup-lib.js
// The thinking behind the Bird's Nest cleanup: permission math, the change plan,
// the before-and-after access check, which messages to delete, and the restore
// plan. Nothing here talks to Discord, so all of it can be tested.

const F = {
    Administrator: 1n << 3n,
    AddReactions: 1n << 6n,
    ViewChannel: 1n << 10n,
    SendMessages: 1n << 11n,
    EmbedLinks: 1n << 14n,
    ReadMessageHistory: 1n << 16n,
    MentionEveryone: 1n << 17n,
    Connect: 1n << 20n,
    ManageRoles: 1n << 28n,
    UseApplicationCommands: 1n << 31n,
};
const TRACKED = ['ViewChannel', 'SendMessages', 'AddReactions', 'Connect', 'MentionEveryone', 'UseApplicationCommands'];
const ALL_PERMISSIONS = (1n << 64n) - 1n;
const CATEGORY = 4;

// Bird's Nest, written down once so the dry run can check it against the live server.
const BIRDS_NEST = {
    guildId: '367470993045848065',
    makiUserId: '563434444321587202',
    makiRulesMessageId: '1446388699246887095',
    channels: {
        rules: '795560649596862475',
        quickLinks: '1366461113029627904',
        botCommands: '1359306607300968620',
        showcase: '1518357793801900213',
        welcome: '1243696602959315045',
        status: '1026876016083337236',
        streamAlerts: '1201936650733895680',
        voiceLobby: '1186505748423905361',
    },
    leaveAloneCategoryId: '754070051597975574', // Big Boy Stuff
    deleteChannels: {
        '1510710618674434239': 'cs2-commands',
        '1001340004259352678': 'eft-commands',
        '1452433223874511052': '7-days-to-die',
        '1517789614914666668': 'zomboid',
        '1510709409180029068': 'info',
        '1470911712256590019': 'info',
        '1447826502052745257': 'info',
        '753459637151334510': 'the-adventure',
        '762563249635590164': 'the-adventure-2',
        '758120005308383337': 'dungeon-loot-drops',
    },
    // The EPIC RPG channels are nearly all bot spam, so they get no text copy.
    skipTranscripts: ['753459637151334510', '762563249635590164', '758120005308383337'],
    deleteCategories: {
        '1510709064231817296': 'CS2',
        '1470911639774691529': 'Star Citizen',
        '1143323149648281650': 'Tarkov',
        '758120055853547520': 'EPIC RPG',
    },
    deleteRoles: {
        '1510709202224414821': 'CS2',
        '1470901468549742718': 'Escape From Tarkov',
        '1470900763269009459': 'Star Citizens',
        '1364292576269565963': '7 Days to Die',
        '1517789754823938138': 'Zomboid',
        '1470903122049237054': 'Epic RPG Players',
        '1536496312437182504': 'Rust',
        '1459380427063038140': 'Cultist',
    },
    kickBots: {
        '555955826880413696': { name: 'EPIC RPG', roleId: '753458484246216767' },
        '792842038332358656': { name: 'Discohook Utils', roleId: '1349406843050524674' },
    },
    roles: { access: '753089673550757938', mod: '719283034200866917', streamBot: '754521998226358354' },
    streamBotUserId: '375805687529209857',
    // Channels where Maki's own posts get deleted. Only #rules, where its old rules and role
    // messages are replaced. Its welcome, level-up and game posts elsewhere are left alone,
    // because they do no harm and deleting them is slow.
    makiCleanupChannels: ['795560649596862475'],
};

// ===== PERMISSION MATH =====

// Discord's own order: role permissions, then @everyone's overwrite, then role overwrites, then the member's.
function effectivePerms({ memberId, roleIds, rolePerms, everyoneId, overwrites }) {
    let perms = rolePerms[everyoneId] || 0n;
    for (const id of roleIds) perms |= rolePerms[id] || 0n;
    if (perms & F.Administrator) return ALL_PERMISSIONS;

    const own = (id, type) => overwrites.find((o) => o.id === id && o.type === type);
    const everyone = own(everyoneId, 0);
    if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);

    let allow = 0n;
    let deny = 0n;
    for (const id of roleIds) {
        const o = own(id, 0);
        if (o) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
    }
    perms = (perms & ~deny) | allow;

    const member = own(memberId, 1);
    if (member) perms = (perms & ~BigInt(member.deny)) | BigInt(member.allow);

    return perms & F.ViewChannel ? perms : 0n;
}

function rolePermsOf(state) {
    return Object.fromEntries(state.roles.map((role) => [role.id, BigInt(role.permissions)]));
}

// ===== THE CHANGE PLAN =====

function overwriteEdit(channel, id, type, before, next, reason) {
    return {
        channelId: channel.id,
        channelName: channel.name,
        id,
        type,
        allow: next.allow.toString(),
        deny: next.deny.toString(),
        before: before ? { allow: before.allow.toString(), deny: before.deny.toString() } : null,
        reason,
    };
}

function planChanges(state, cfg) {
    const problems = [];
    const notes = [];
    const channelById = new Map(state.channels.map((c) => [c.id, c]));
    const roleById = new Map(state.roles.map((r) => [r.id, r]));
    const memberById = new Map(state.members.map((m) => [m.id, m]));
    const findOverwrite = (channel, id, type = 0) => channel.permission_overwrites.find((o) => o.id === id && o.type === type);
    const bitsOf = (o) => (o ? { allow: BigInt(o.allow), deny: BigInt(o.deny) } : { allow: 0n, deny: 0n });

    const deleteChannelIds = [];
    for (const [id, name] of Object.entries(cfg.deleteChannels)) {
        const channel = channelById.get(id);
        if (!channel) problems.push(`Channel "${name}" (${id}) is gone or has a new id`);
        else if (channel.name !== name) problems.push(`Channel ${id} is called "${channel.name}", not "${name}"`);
        else deleteChannelIds.push(id);
    }

    const deleteCategoryIds = [];
    for (const [id, name] of Object.entries(cfg.deleteCategories)) {
        const category = channelById.get(id);
        if (!category) { problems.push(`Category "${name}" (${id}) is gone or has a new id`); continue; }
        if (category.name !== name) { problems.push(`Category ${id} is called "${category.name}", not "${name}"`); continue; }
        const staying = state.channels.filter((c) => c.parent_id === id && !(c.id in cfg.deleteChannels));
        if (staying.length) problems.push(`Category "${name}" would still hold: ${staying.map((c) => c.name).join(', ')}`);
        else deleteCategoryIds.push(id);
    }

    const deleteRoleIds = [];
    for (const [id, name] of Object.entries(cfg.deleteRoles)) {
        const role = roleById.get(id);
        if (!role) problems.push(`Role "${name}" (${id}) is gone or has a new id`);
        else if (role.name !== name) problems.push(`Role ${id} is called "${role.name}", not "${name}"`);
        else deleteRoleIds.push(id);
    }

    const kickUserIds = [];
    const botRoleIds = [];
    for (const [userId, bot] of Object.entries(cfg.kickBots)) {
        const member = memberById.get(userId);
        if (!member) notes.push(`${bot.name} is already out of the server`);
        else if (member.username !== bot.name) problems.push(`User ${userId} is "${member.username}", not "${bot.name}"`);
        else { kickUserIds.push(userId); botRoleIds.push(bot.roleId); }
    }

    for (const [label, id] of Object.entries(cfg.roles)) {
        if (!roleById.has(id)) problems.push(`The ${label} role (${id}) does not exist`);
    }

    // Slash commands only work in the commands channel.
    const UAC = F.UseApplicationCommands;
    const gone = new Set([...deleteChannelIds, ...deleteCategoryIds]);
    const overwriteEdits = [];
    for (const channel of state.channels) {
        if (gone.has(channel.id) || channel.id === cfg.channels.botCommands) continue;
        const top = channel.type === CATEGORY ? channel.id : channel.parent_id;
        if (top === cfg.leaveAloneCategoryId) continue;
        const existing = findOverwrite(channel, cfg.guildId);
        const before = bitsOf(existing);
        const next = { allow: before.allow & ~UAC, deny: before.deny | UAC };
        if (next.allow !== before.allow || next.deny !== before.deny) {
            overwriteEdits.push(overwriteEdit(channel, cfg.guildId, 0, existing ? before : null, next, 'Slash commands only in the commands channel'));
        }
    }

    const commandsChannel = channelById.get(cfg.channels.botCommands);
    if (!commandsChannel) {
        problems.push('The commands channel does not exist');
    } else {
        for (const roleId of [cfg.roles.access, cfg.roles.mod]) {
            const existing = findOverwrite(commandsChannel, roleId);
            if (!existing) { problems.push(`#${commandsChannel.name} has no overwrite for role ${roleId}`); continue; }
            const before = bitsOf(existing);
            const next = { allow: before.allow | UAC, deny: before.deny & ~UAC };
            if (next.allow !== before.allow || next.deny !== before.deny) {
                overwriteEdits.push(overwriteEdit(commandsChannel, roleId, 0, before, next, 'Slash commands allowed here'));
            }
        }
    }

    // Streamcord loses Administrator, so it needs its own access to post alerts.
    const alerts = channelById.get(cfg.channels.streamAlerts);
    const alertBits = F.ViewChannel | F.SendMessages | F.EmbedLinks | F.ReadMessageHistory;
    if (!alerts) {
        problems.push('The stream alerts channel does not exist');
    } else {
        const existing = findOverwrite(alerts, cfg.roles.streamBot);
        const before = bitsOf(existing);
        const next = { allow: before.allow | alertBits, deny: before.deny & ~alertBits };
        overwriteEdits.push(overwriteEdit(alerts, cfg.roles.streamBot, 0, existing ? before : null, next, 'Stream alerts keep working without Administrator'));
    }

    const roleEdits = [];
    const streamRole = roleById.get(cfg.roles.streamBot);
    if (streamRole) {
        const before = BigInt(streamRole.permissions);
        const next = before & ~(F.Administrator | F.ManageRoles);
        if (next !== before) roleEdits.push({ roleId: streamRole.id, roleName: streamRole.name, permissions: next.toString(), before: before.toString() });
    }

    const plan = { problems, notes, deleteChannelIds, deleteCategoryIds, deleteRoleIds, botRoleIds, kickUserIds, overwriteEdits, roleEdits };

    const after = applyPlan(state, plan);
    const afterAlerts = after.channels.find((c) => c.id === cfg.channels.streamAlerts);
    const streamMember = after.members.find((m) => m.id === cfg.streamBotUserId);
    if (afterAlerts && streamMember) {
        const perms = effectivePerms({
            memberId: streamMember.id,
            roleIds: streamMember.roles,
            rolePerms: rolePermsOf(after),
            everyoneId: cfg.guildId,
            overwrites: afterAlerts.permission_overwrites,
        });
        if ((perms & alertBits) !== alertBits) problems.push('Streamcord would lose access to the stream alerts channel');
    }
    return plan;
}

// What the server would look like once the plan has run.
function applyPlan(state, plan) {
    const gone = new Set([...plan.deleteChannelIds, ...plan.deleteCategoryIds]);
    const goneRoles = new Set([...plan.deleteRoleIds, ...plan.botRoleIds]);
    const kicked = new Set(plan.kickUserIds);
    const roleEdits = new Map(plan.roleEdits.map((e) => [e.roleId, e.permissions]));
    const editsByChannel = new Map();
    for (const edit of plan.overwriteEdits) {
        if (!editsByChannel.has(edit.channelId)) editsByChannel.set(edit.channelId, []);
        editsByChannel.get(edit.channelId).push(edit);
    }

    return {
        ...state,
        roles: state.roles
            .filter((r) => !goneRoles.has(r.id))
            .map((r) => (roleEdits.has(r.id) ? { ...r, permissions: roleEdits.get(r.id) } : r)),
        channels: state.channels
            .filter((c) => !gone.has(c.id))
            .map((c) => {
                let overwrites = c.permission_overwrites.filter((o) => !(o.type === 0 && goneRoles.has(o.id)));
                for (const edit of editsByChannel.get(c.id) || []) {
                    overwrites = overwrites.filter((o) => !(o.id === edit.id && o.type === edit.type));
                    overwrites.push({ id: edit.id, type: edit.type, allow: edit.allow, deny: edit.deny });
                }
                return { ...c, permission_overwrites: overwrites };
            }),
        members: state.members
            .filter((m) => !kicked.has(m.id))
            .map((m) => ({ ...m, roles: m.roles.filter((r) => !goneRoles.has(r)) })),
    };
}

// ===== ACCESS CHECK =====

function accessDiff(before, after, cfg) {
    const beforeChannels = new Map(before.channels.map((c) => [c.id, c]));
    const beforeMembers = new Map(before.members.map((m) => [m.id, m]));
    const beforeRolePerms = rolePermsOf(before);
    const afterRolePerms = rolePermsOf(after);
    const roleNames = Object.fromEntries(before.roles.map((r) => [r.id, r.name]));
    const rows = [];

    for (const channel of after.channels) {
        const old = beforeChannels.get(channel.id);
        for (const member of after.members) {
            const was = beforeMembers.get(member.id);
            if (!old || !was) continue;
            const had = effectivePerms({ memberId: member.id, roleIds: was.roles, rolePerms: beforeRolePerms, everyoneId: cfg.guildId, overwrites: old.permission_overwrites });
            const has = effectivePerms({ memberId: member.id, roleIds: member.roles, rolePerms: afterRolePerms, everyoneId: cfg.guildId, overwrites: channel.permission_overwrites });
            for (const bit of TRACKED) {
                const a = Boolean(had & F[bit]);
                const b = Boolean(has & F[bit]);
                if (a === b) continue;
                rows.push({
                    channelId: channel.id,
                    channelName: channel.name,
                    bit,
                    change: b ? 'gain' : 'lose',
                    memberId: member.id,
                    username: member.username,
                    bot: member.bot,
                    roles: was.roles.map((r) => roleNames[r]).filter(Boolean).sort(),
                });
            }
        }
    }
    return rows;
}

// Slash command changes and Streamcord's own change are expected. Anything else is flagged.
function summarizeDiff(rows, cfg) {
    const groups = new Map();
    for (const row of rows) {
        const expected = row.bit === 'UseApplicationCommands' || row.memberId === cfg.streamBotUserId;
        const key = `${row.channelName}|${row.bit}|${row.change}|${expected}`;
        if (!groups.has(key)) groups.set(key, { channel: row.channelName, bit: row.bit, change: row.change, expected, count: 0, roleSets: new Map(), sample: [] });
        const group = groups.get(key);
        group.count++;
        const set = row.roles.join(' + ') || 'no roles';
        group.roleSets.set(set, (group.roleSets.get(set) || 0) + 1);
        if (group.sample.length < 3) group.sample.push(row.username);
    }
    return [...groups.values()].sort((a, b) => a.expected - b.expected || a.channel.localeCompare(b.channel));
}

// ===== MESSAGES =====

function messagesToDelete(channelId, messages, cfg, ownerId) {
    return messages.filter((m) => {
        if (cfg.makiCleanupChannels.includes(channelId) && m.author.id === cfg.makiUserId) return true;
        if (channelId === cfg.channels.rules && m.author.id === ownerId) return /message from Maki|choose your role/i.test(m.content || '');
        if (channelId === cfg.channels.quickLinks && m.author.id === ownerId) return true;
        if (channelId === cfg.channels.showcase && m.author.id === ownerId) return true;
        return false;
    });
}

function transcriptLine(message) {
    const parts = [];
    if (message.content) parts.push(message.content);
    const walk = (component) => {
        if (component.content) parts.push(component.content);
        (component.components || []).forEach(walk);
    };
    (message.components || []).forEach(walk);
    for (const embed of message.embeds || []) {
        parts.push(`[embed] ${[embed.title, embed.description].filter(Boolean).join(' - ')}`);
    }
    for (const file of message.attachments || []) parts.push(`[file] ${file.filename} ${file.url}`);
    const who = message.author.bot ? `${message.author.username} (bot)` : message.author.username;
    return `[${message.timestamp}] ${who}: ${parts.join(' | ') || '(empty)'}`;
}

// ===== RESTORE =====

// Works out what to put back. Messages can't be restored, and neither can kicked bots.
function buildRestorePlan(snapshot, current, guildId) {
    const haveRoles = new Set(current.roles.map((r) => r.id));
    const haveChannels = new Map(current.channels.map((c) => [c.id, c]));
    const currentRoles = new Map(current.roles.map((r) => [r.id, r]));

    const createRoles = snapshot.roles.filter((r) => !haveRoles.has(r.id) && !r.managed && r.id !== guildId);
    const missing = snapshot.channels.filter((c) => !haveChannels.has(c.id));
    const createChannels = [...missing.filter((c) => c.type === CATEGORY), ...missing.filter((c) => c.type !== CATEGORY)];

    const sameOverwrite = (a, b) => a && b && String(a.allow) === String(b.allow) && String(a.deny) === String(b.deny);
    const overwriteSets = [];
    const overwriteDeletes = [];
    for (const old of snapshot.channels) {
        const now = haveChannels.get(old.id);
        if (!now) continue;
        for (const o of old.permission_overwrites) {
            const match = now.permission_overwrites.find((x) => x.id === o.id && x.type === o.type);
            if (!sameOverwrite(o, match)) overwriteSets.push({ channelId: old.id, channelName: old.name, overwrite: o });
        }
        for (const o of now.permission_overwrites) {
            if (!old.permission_overwrites.some((x) => x.id === o.id && x.type === o.type)) {
                overwriteDeletes.push({ channelId: old.id, channelName: old.name, overwrite: o });
            }
        }
    }

    const rolePermissions = snapshot.roles
        .filter((r) => currentRoles.has(r.id) && String(currentRoles.get(r.id).permissions) !== String(r.permissions))
        .map((r) => ({ roleId: r.id, roleName: r.name, permissions: String(r.permissions) }));

    const currentMembers = new Map(current.members.map((m) => [m.id, m]));
    const memberRoles = [];
    for (const old of snapshot.members) {
        const now = currentMembers.get(old.id);
        if (!now) continue;
        const lost = old.roles.filter((r) => !now.roles.includes(r));
        if (lost.length) memberRoles.push({ userId: old.id, username: old.username, roleIds: lost });
    }

    return { createRoles, createChannels, overwriteSets, overwriteDeletes, rolePermissions, memberRoles };
}

module.exports = {
    F,
    TRACKED,
    BIRDS_NEST,
    effectivePerms,
    rolePermsOf,
    planChanges,
    applyPlan,
    accessDiff,
    summarizeDiff,
    messagesToDelete,
    transcriptLine,
    buildRestorePlan,
};
