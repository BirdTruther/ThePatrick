// guild-automation.js
// Replaces Maki's server jobs: the access role, reaction roles, temporary voice
// channels, and welcome and leave messages. While Maki is still in a server, Patrick leaves its
// voice channels and messages alone so nothing happens twice, then takes over as
// soon as Maki is removed. Roles are safe to set twice, so those always run.

const { ChannelType, Events, OverwriteType, Partials } = require('discord.js');

const MAKI_USER_ID = '563434444321587202';
const RECENT_JOIN_MS = 7 * 24 * 60 * 60 * 1000;
const VOICE_COOLDOWN_MS = 15_000;
const TEMP_VOICE_SUFFIX = "'s Channel";
const TEMP_VOICE_LIMIT = 5;
const TEMP_VOICE_BITRATE = 64_000;
// Manage Channels, Move Members and Manage Permissions, the same as Maki gave owners.
const TEMP_VOICE_OWNER_ALLOW = 285212688n;

const GUILD_CONFIG = {
    // Bird's Nest
    '367470993045848065': {
        accessRoleId: '753089673550757938', // Beaky Buddy
        rulesMessageId: '1446388699246887095',
        welcomeChannelId: '1243696602959315045',
        voiceLobbyId: '1186505748423905361',
        voiceCategoryId: '367470993871994882',
        // Each role changes only when someone adds or removes that reaction.
        reactionRoles: {
            '1470902576261238969': {
                '🚀': '1470900763269009459', // Star Citizens
                '🔫': '1470901468549742718', // Escape From Tarkov
                '☠': '1364292576269565963', // 7 Days to Die
                '🐟': '1470903122049237054', // Epic RPG Players
                '🔪': '1510709202224414821', // CS2
                '🐼': '1517789754823938138', // Zomboid
                '🐒': '1536496312437182504', // Rust
            },
            '1459388003725082664': {
                '👍': '1459380427063038140', // Cultist
            },
        },
    },
};

// Discord can send an emoji with or without its invisible style character.
function emojiKey(name) {
    return (name || '').replace(/\uFE0F/g, '');
}

function createGuildAutomation({ config = GUILD_CONFIG, store, log = () => {}, now = Date.now, makiUserId = MAKI_USER_ID }) {
    const loadedGuilds = new Set();
    const lastVoiceCreate = new Map();

    // Until the member list has loaded, assume Maki is here so nothing happens twice.
    function makiIsPresent(guild) {
        return !loadedGuilds.has(guild.id) || guild.members.cache.has(makiUserId);
    }

    async function giveAccessRole(member, settings, reason) {
        if (member.user?.bot || member.roles.cache.has(settings.accessRoleId)) return false;
        await member.roles.add(settings.accessRoleId, reason);
        log('ACCESS_ROLE', 'INFO', `Gave access role to ${member.user?.username || member.id}: ${reason}`);
        return true;
    }

    function joinedRecently(member) {
        return Boolean(member.joinedTimestamp) && now() - member.joinedTimestamp < RECENT_JOIN_MS;
    }

    async function onMemberAdd(member) {
        const settings = config[member.guild.id];
        if (!settings) return;
        // Servers without a rules screen never mark a member pending.
        if (!member.pending) await giveAccessRole(member, settings, 'Joined the server');
        if (member.user.bot || makiIsPresent(member.guild)) return;
        const channel = member.guild.channels.cache.get(settings.welcomeChannelId);
        await channel?.send({ content: `Welcome <@${member.id}>!`, allowedMentions: { users: [member.id] } });
    }

    async function onMemberUpdate(oldMember, newMember) {
        const settings = config[newMember.guild.id];
        if (!settings || newMember.pending) return;
        // An uncached member has no earlier state, so a recent join stands in for "just accepted".
        const justAccepted = oldMember.pending === true || (oldMember.partial && joinedRecently(newMember));
        if (justAccepted) await giveAccessRole(newMember, settings, 'Accepted the server rules');
    }

    async function onMemberRemove(member) {
        const settings = config[member.guild.id];
        if (!settings || member.user?.bot || makiIsPresent(member.guild)) return;
        const channel = member.guild.channels.cache.get(settings.welcomeChannelId);
        await channel?.send({ content: `<@${member.id}> has left! I wonder why?`, allowedMentions: { parse: [] } });
    }

    function reactionRoleFor(reaction, settings) {
        return settings.reactionRoles?.[reaction.message.id]?.[emojiKey(reaction.emoji.name)] || null;
    }

    async function onReactionAdd(reaction, user) {
        const { guild } = reaction.message;
        const settings = guild && config[guild.id];
        if (!settings || user.bot) return;

        // A 👍 on the rules is the backup way in. Taking it back doesn't remove access.
        const isRulesThumb = reaction.message.id === settings.rulesMessageId && reaction.emoji.name === '👍';
        const roleId = reactionRoleFor(reaction, settings);
        if (!isRulesThumb && !roleId) return;

        const member = await guild.members.fetch(user.id);
        if (isRulesThumb) await giveAccessRole(member, settings, 'Reacted to the server rules');
        if (roleId) {
            await member.roles.add(roleId, 'Reaction role');
            log('REACTION_ROLE', 'INFO', `Reaction add: ${member.user?.username || member.id} -> ${roleId}`);
        }
    }

    async function onReactionRemove(reaction, user) {
        const { guild } = reaction.message;
        const settings = guild && config[guild.id];
        if (!settings || user.bot) return;
        const roleId = reactionRoleFor(reaction, settings);
        if (!roleId) return;

        const member = await guild.members.fetch(user.id).catch(() => null); // They may have left the server.
        if (!member) return;
        await member.roles.remove(roleId, 'Reaction role removed');
        log('REACTION_ROLE', 'INFO', `Reaction remove: ${member.user?.username || member.id} -> ${roleId}`);
    }

    function trackedVoiceChannels(guildId) {
        return new Set(store.read(guildId));
    }

    function saveVoiceChannels(guildId, ids) {
        store.write(guildId, [...ids]);
    }

    // The name check also covers channels Maki left behind.
    function isTempVoice(channel, settings) {
        if (!channel || channel.id === settings.voiceLobbyId || channel.parentId !== settings.voiceCategoryId) return false;
        return trackedVoiceChannels(channel.guild.id).has(channel.id) || channel.name.endsWith(TEMP_VOICE_SUFFIX);
    }

    async function deleteTempVoice(channel) {
        const tracked = trackedVoiceChannels(channel.guild.id);
        tracked.delete(channel.id);
        saveVoiceChannels(channel.guild.id, tracked);
        await channel.delete('Temporary voice channel is empty');
    }

    async function createTempVoice(member, settings) {
        const { guild } = member;
        const last = lastVoiceCreate.get(member.id) || 0;
        if (now() - last < VOICE_COOLDOWN_MS) return;
        lastVoiceCreate.set(member.id, now());

        const parent = guild.channels.cache.get(settings.voiceCategoryId);
        const inherited = [...(parent?.permissionOverwrites?.cache?.values() || [])].map((overwrite) => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow,
            deny: overwrite.deny,
        }));
        const channel = await guild.channels.create({
            name: `${member.displayName}${TEMP_VOICE_SUFFIX}`.slice(0, 100),
            type: ChannelType.GuildVoice,
            parent: settings.voiceCategoryId,
            bitrate: TEMP_VOICE_BITRATE,
            userLimit: TEMP_VOICE_LIMIT,
            permissionOverwrites: [...inherited, { id: member.id, type: OverwriteType.Member, allow: TEMP_VOICE_OWNER_ALLOW }],
            reason: 'Temporary voice channel',
        });
        const tracked = trackedVoiceChannels(guild.id);
        tracked.add(channel.id);
        saveVoiceChannels(guild.id, tracked);

        try {
            await member.voice.setChannel(channel, 'Moved to their temporary voice channel');
        } catch (err) {
            await deleteTempVoice(channel); // They left before the move finished.
            throw err;
        }
    }

    async function onVoiceStateUpdate(oldState, newState) {
        const { guild } = newState;
        const settings = config[guild.id];
        if (!settings || makiIsPresent(guild) || oldState.channelId === newState.channelId) return;

        const left = oldState.channel;
        if (isTempVoice(left, settings) && left.members.size === 0) await deleteTempVoice(left);

        if (newState.channelId === settings.voiceLobbyId && newState.member && !newState.member.user.bot) {
            await createTempVoice(newState.member, settings);
        }
    }

    // Catches up on anything missed while the bot was down, so downtime only delays access.
    async function onReady(guilds) {
        for (const guild of guilds) {
            const settings = config[guild.id];
            if (!settings) continue;
            const members = await guild.members.fetch();
            loadedGuilds.add(guild.id);

            for (const member of members.values()) {
                if (!member.pending && joinedRecently(member)) {
                    await giveAccessRole(member, settings, 'Joined while the bot was offline');
                }
            }

            if (makiIsPresent(guild)) continue;
            for (const channel of guild.channels.cache.values()) {
                if (channel.type === ChannelType.GuildVoice && isTempVoice(channel, settings) && channel.members.size === 0) {
                    await deleteTempVoice(channel);
                }
            }
        }
    }

    return { makiIsPresent, onMemberAdd, onMemberUpdate, onMemberRemove, onReactionAdd, onReactionRemove, onVoiceStateUpdate, onReady };
}

function registerGuildAutomation(client) {
    const { getSetting, setSetting } = require('./database.js');
    const { logSystemEvent } = require('./logger.js');
    const log = (event, level, message) => logSystemEvent(event, level, 'discord', message);

    const store = {
        read(guildId) {
            try {
                return JSON.parse(getSetting(`tempVoiceChannels:${guildId}`, '[]'));
            } catch {
                return [];
            }
        },
        write(guildId, ids) {
            setSetting(`tempVoiceChannels:${guildId}`, JSON.stringify(ids));
        },
    };
    const automation = createGuildAutomation({ store, log });

    const guarded = (name, handler) => async (...args) => {
        try {
            await handler(...args);
        } catch (err) {
            log('GUILD_AUTOMATION_ERROR', 'ERROR', `${name} failed: ${err.message}`);
        }
    };

    client.once(Events.ClientReady, guarded('ready', () => automation.onReady([...client.guilds.cache.values()])));
    client.on(Events.GuildMemberAdd, guarded('member add', automation.onMemberAdd));
    client.on(Events.GuildMemberUpdate, guarded('member update', automation.onMemberUpdate));
    client.on(Events.GuildMemberRemove, guarded('member remove', automation.onMemberRemove));
    client.on(Events.MessageReactionAdd, guarded('reaction add', automation.onReactionAdd));
    client.on(Events.MessageReactionRemove, guarded('reaction remove', automation.onReactionRemove));
    client.on(Events.VoiceStateUpdate, guarded('voice', automation.onVoiceStateUpdate));
}

const GUILD_AUTOMATION_PARTIALS = [Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User];

module.exports = { createGuildAutomation, registerGuildAutomation, GUILD_AUTOMATION_PARTIALS };
