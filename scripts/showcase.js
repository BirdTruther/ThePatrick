// scripts/showcase.js
// The messages Patrick posts for the server cleanup: the rules, quick links, the
// commands note and the #thepatrick-bot showcase. The showcase is built from the
// commands Discord has registered, so it can't list one that doesn't exist.

const LINKS = {
    birdsServer: 'https://birdsserver.cfd/',
    romm: 'https://play.birdsserver.cfd/',
    dropZone: 'https://link.birdsserver.cfd',
    repo: 'https://github.com/BirdTruther/ThePatrick',
};

const COMMAND_SECTIONS = [
    { title: '🧠 AI & fun', color: 0x5865f2, names: ['ask', 'imagine', 'meme', 'persona', 'personas', 'code'] },
    { title: '🎯 Escape from Tarkov', color: 0xc8a951, names: ['price', 'bestammo', 'trader', 'map', 'player'] },
    {
        title: '🤧 Tarkov allergies',
        color: 0xe67e22,
        note: 'Roleplay allergies for the server. Log them, and see who shares yours.',
        names: ['addallergy', 'removeallergy', 'allergies', 'searchallergy', 'commonallergies'],
    },
    {
        title: '📦 CS2',
        color: 0xe4ae39,
        note: 'Open a real case, watch the reveal, see the skin, wear and Steam price, then hit **Open another**.',
        names: ['cs2case', 'cs2leaderboard', 'cs2stats'],
    },
    { title: '🎵 Music', color: 0x1abc9c, names: ['play', 'skip', 'stop', 'queue', 'pause', 'resume', 'nowplaying'] },
    { title: '🛠️ Server tools', color: 0x95a5a6, names: ['pickplayers', 'hate'] },
];

const SUBCOMMAND_COMMANDS = new Set(['hate']);

function commandLine(command) {
    const label = SUBCOMMAND_COMMANDS.has(command.name) ? `\`/${command.name}\`` : `</${command.name}:${command.id}>`;
    return `${label} — ${command.description}`;
}

function embedChars(embed) {
    return [embed.title, embed.description, embed.footer?.text, ...(embed.fields || []).flatMap((f) => [f.name, f.value])]
        .filter(Boolean)
        .join('').length;
}

function linkButtons(buttons) {
    return { type: 1, components: buttons.map(([label, url]) => ({ type: 2, style: 5, label, url })) };
}

function parseTwitchCommands(source) {
    const names = [];
    for (const match of source.matchAll(/(?:startsWith\(|===\s*)'!([a-z0-9]+)/g)) {
        if (!names.includes(match[1])) names.push(match[1]);
    }
    return names;
}

function buildShowcase({ commands, twitchNames, avatarUrl, botCommandsChannelId }) {
    const byName = new Map(commands.map((c) => [c.name, c]));
    const used = new Set();
    const embeds = [];

    embeds.push({
        title: '🤖 ThePatrick',
        description: [
            'Chaotic, opinionated, and surprisingly useful. Patrick lives in Bird\'s Nest, Twitch chat, and anywhere else he\'s invited.',
            '',
            `Slash commands work in <#${botCommandsChannelId}>. **@mention him or reply to him anywhere** and he\'ll answer.`,
        ].join('\n'),
        color: 0x57f287,
        thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
    });

    embeds.push({
        title: '💬 Just talk to him',
        description: [
            '• **@mention** Patrick or **reply** to one of his messages in any channel',
            '• Send him a **picture** and he\'ll tell you what he sees',
            '• He remembers names, mains and inside jokes across channels',
            '• Five moods with </persona:' + (byName.get('persona')?.id || '0') + '>: Aggressive, Sassy & Stupid, Nice & Smart, Paranoid Conspiracy, and Sleepy/High Patrick',
        ].join('\n'),
        color: 0xeb459e,
    });

    for (const section of COMMAND_SECTIONS) {
        const present = section.names.map((name) => byName.get(name)).filter(Boolean);
        if (!present.length) continue;
        present.forEach((c) => used.add(c.name));
        embeds.push({
            title: section.title,
            description: [section.note, ...present.map(commandLine)].filter(Boolean).join('\n'),
            color: section.color,
        });
    }

    const more = commands.filter((c) => !used.has(c.name) && !['persona'].includes(c.name));
    if (more.length) embeds.push({ title: '✨ More', description: more.map(commandLine).join('\n'), color: 0x95a5a6 });

    if (twitchNames.length) {
        embeds.push({
            title: '📺 On Twitch',
            description: `Patrick is in Twitch chat too: ${twitchNames.map((n) => `\`!${n}\``).join(' ')}`,
            color: 0x9146ff,
        });
    }

    embeds.push({
        title: '🏠 Want Patrick on your server?',
        description: 'Start at **birdsserver.cfd**. The source is public on GitHub, but running him live takes a license, so getting him onto your server starts with reaching out.',
        color: 0x3498db,
    });

    // Up to three embeds per message, kept well under Discord's size limit.
    const messages = [];
    let current = { embeds: [] };
    for (const embed of embeds) {
        const size = current.embeds.reduce((sum, e) => sum + embedChars(e), 0) + embedChars(embed);
        if (current.embeds.length >= 3 || size > 4500) {
            messages.push(current);
            current = { embeds: [] };
        }
        current.embeds.push(embed);
    }
    messages.push(current);
    messages[messages.length - 1].components = [linkButtons([['Get Patrick on your server', LINKS.birdsServer], ['Source on GitHub', LINKS.repo]])];
    return messages;
}

function buildQuickLinks({ guildId, voiceLobbyId }) {
    return {
        embeds: [{
            title: '🔗 Quick Links',
            description: 'Everything Birds Server, in one place.',
            color: 0x2ecc71,
            fields: [
                { name: '🌐 Birds Server', value: 'The home page for everything below.' },
                { name: '🎮 ROMM', value: 'A self-hosted library of legally acquired ROMs. It also plays flash and N64 games in a browser.' },
                { name: '📎 Drop Zone', value: 'A self-hosted web app for sharing links with friends.' },
                { name: '🔊 Your own voice channel', value: 'Join **Join this to get your own channel!** and Patrick makes one just for you.' },
            ],
        }],
        components: [linkButtons([
            ['Birds Server', LINKS.birdsServer],
            ['ROMM', LINKS.romm],
            ['Drop Zone', LINKS.dropZone],
            ['Make a voice channel', `https://discord.com/channels/${guildId}/${voiceLobbyId}`],
        ])],
    };
}

function buildCommandsNote() {
    return {
        content: '📌 **Slash commands live here.** Type `/` in this channel to see everything Patrick can do. In any other channel, **@mention him or reply to him** and he\'ll still answer.',
        allowed_mentions: { parse: [] },
    };
}

module.exports = { LINKS, buildShowcase, buildQuickLinks, buildCommandsNote, parseTwitchCommands, embedChars };
