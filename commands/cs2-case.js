// commands/cs2-case.js
// /cs2case and /cs2leaderboard: reveal, buttons, autocomplete and the Twitch text version.

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown,
} = require('discord.js');
const { db } = require('../database.js');
const { logCommand, logSystemEvent } = require('../logger.js');
const { getCatalog, ensureCatalog, searchCases, findCase } = require('../services/cs2-catalog.js');
const { MAX_OPENS, TIERS, openCases, parseCaseArgs, createCaseStats } = require('../services/cs2-case.js');
const { generateCaseRoast } = require('../services/ai.js');

const FRAME_DELAY_MS = 1000;
const ROAST_COOLDOWN_MS = 30 * 60 * 1000;
const ROAST_LOSS_USD = 50;
const GOLD_COLOR = 0xe4ae39;
const BUTTON_PREFIX = 'cs2case:open:';

const stats = createCaseStats(db);
const openingNow = new Set();
const lastRoastAt = new Map();
const tierByKey = Object.fromEntries(TIERS.map((tier) => [tier.key, tier]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function money(amount) {
    return `$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(amount) {
    return `${amount < 0 ? '-' : '+'}${money(amount)}`;
}

function randomTierEmoji() {
    let roll = Math.random() * 1.4; // Rarer colors show up more than they really drop, for the look of it.
    for (const tier of [...TIERS].reverse()) {
        const weight = tier.key === 'blue' ? 0.6 : 0.2;
        if (roll < weight) return tier.emoji;
        roll -= weight;
    }
    return TIERS[0].emoji;
}

function reelLine(center) {
    const side = () => randomTierEmoji();
    return `${side()} ${side()} ▶ ${center} ◀ ${side()} ${side()}`;
}

function openingEmbed(caseData, count, center) {
    return new EmbedBuilder()
        .setTitle(`📦 Opening ${count > 1 ? `${count} × ` : ''}${caseData.name}...`)
        .setDescription(reelLine(center))
        .setThumbnail(caseData.image)
        .setColor(0x2b2d31);
}

function flavorFor(run) {
    if (run.counts.gold > 0) return '🎉 YOU HIT A KNIFE/GLOVES! Screenshot that NOW!';
    if (run.net > 0) return '📈 Actually in profit. Stop now. You won\'t.';
    if (run.counts.red > 0) return '🔥 A Covert drop?! That\'s actually solid.';
    if (run.counts.pink > 0) return '😤 A Classified. Not bad, not great.';
    return '💀 Rough run. The market is not your friend today.';
}

function dropTitle(drop) {
    return drop.phase ? `${drop.name} • ${drop.phase}` : drop.name;
}

function resultEmbed(caseData, run, username, totals, roast) {
    const { best } = run;
    const embed = new EmbedBuilder()
        .setImage(best.image)
        .setThumbnail(caseData.image)
        .setColor(best.tier === 'gold' ? GOLD_COLOR : (best.color || 0x4b69ff))
        .setFooter({
            text: `${username}: ${totals.opened.toLocaleString()} opened, ${signedMoney(totals.value - totals.spent)} all-time • `
                + `${totals.since_knife.toLocaleString()} since last knife • Steam prices`,
        });

    if (run.opened === 1) {
        embed.setTitle(`${tierByKey[best.tier].emoji} ${dropTitle(best)}`.slice(0, 256));
        embed.setDescription(`From **${caseData.name}**\n${flavorFor(run)}`);
        if (best.float !== null) embed.addFields({ name: 'Float', value: best.float.toFixed(6), inline: true });
        embed.addFields(
            { name: 'Worth', value: best.value === null ? 'No price' : money(best.value), inline: true },
            { name: 'Cost', value: money(run.spent), inline: true },
            { name: 'Profit/Loss', value: signedMoney(run.net), inline: true },
        );
    } else {
        const results = TIERS.filter((tier) => run.counts[tier.key] > 0)
            .map((tier) => `${tier.emoji} ${tier.label}: **${run.counts[tier.key]}**`)
            .join('\n');
        embed.setTitle(`📦 ${run.opened} × ${caseData.name}`.slice(0, 256));
        embed.setDescription(`${results}\n🎰 StatTrak: **${run.stattraks}**\n\n${flavorFor(run)}`);
        embed.addFields(
            {
                name: 'Best pull',
                value: `${dropTitle(best)}${best.value === null ? '' : ` (${money(best.value)})`}`.slice(0, 1024),
            },
            { name: 'Worth', value: money(run.value), inline: true },
            { name: 'Cost', value: money(run.spent), inline: true },
            { name: 'Profit/Loss', value: signedMoney(run.net), inline: true },
        );
    }
    if (roast) embed.addFields({ name: 'Patrick says', value: roast.slice(0, 1024) });
    return embed;
}

function buttons(caseId, count, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${BUTTON_PREFIX}${caseId}:${count}`)
            .setLabel(count > 1 ? `Open ${count} more` : 'Open another')
            .setEmoji('📦')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`${BUTTON_PREFIX}random:${count}`)
            .setLabel('Random case')
            .setEmoji('🎲')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
    );
}

function pickCase(cases, query) {
    if (!query || query === 'random') return cases[Math.floor(Math.random() * cases.length)];
    return findCase(cases, query);
}

// Roasts only big moments, with a cooldown, because each one spends the free AI allowance.
async function maybeRoast(guildId, username, caseData, run) {
    if (run.net > -ROAST_LOSS_USD && run.counts.gold === 0) return null;
    const scope = guildId || 'dm';
    if (Date.now() - (lastRoastAt.get(scope) || 0) < ROAST_COOLDOWN_MS) return null;
    lastRoastAt.set(scope, Date.now());
    return generateCaseRoast(username, {
        caseName: caseData.name,
        opened: run.opened,
        best: dropTitle(run.best),
        net: signedMoney(run.net),
    }, guildId);
}

async function playReveal(interaction, caseData, run) {
    const frames = run.opened === 1 ? 2 : 1;
    for (let i = 0; i < frames; i++) {
        await interaction.editReply({ content: '', embeds: [openingEmbed(caseData, run.opened, randomTierEmoji())], components: [] });
        await sleep(FRAME_DELAY_MS);
    }
    await interaction.editReply({
        embeds: [openingEmbed(caseData, run.opened, tierByKey[run.best.tier].emoji)],
        components: [],
    });
    await sleep(FRAME_DELAY_MS);
}

async function openForInteraction(interaction, query, count) {
    const { user } = interaction;
    const catalog = await ensureCatalog();
    const caseData = pickCase(catalog.cases, query);
    if (!caseData) {
        await interaction.editReply(`❌ No case matches **${escapeMarkdown(query)}**. Leave it blank for a random one.`);
        return;
    }

    const run = openCases(caseData, catalog.prices, count);
    const totals = stats.record(interaction.guildId || `dm:${user.id}`, user.id, user.username, run);

    try {
        await playReveal(interaction, caseData, run);
    } catch (err) {
        logSystemEvent('CS2_ERROR', 'WARNING', 'cs2', `Case reveal failed: ${err.message}`);
    }

    const row = buttons(caseData.id, run.opened);
    const final = { content: '', components: [row] };
    await interaction.editReply({ ...final, embeds: [resultEmbed(caseData, run, user.username, totals)] });
    logCommand('discord', user.username, '/cs2case', `${caseData.name} x${run.opened}`, `${run.best.name} ${signedMoney(run.net)}`);

    const roast = await maybeRoast(interaction.guildId, user.username, caseData, run);
    if (roast) await interaction.editReply({ ...final, embeds: [resultEmbed(caseData, run, user.username, totals, roast)] });
}

async function withOpeningGuard(interaction, respondBusy, work) {
    if (openingNow.has(interaction.user.id)) {
        await respondBusy();
        return;
    }
    openingNow.add(interaction.user.id);
    try {
        await work();
    } finally {
        openingNow.delete(interaction.user.id);
    }
}

async function handleAutocomplete(interaction) {
    const catalog = getCatalog();
    if (!catalog) {
        ensureCatalog().catch(() => {});
        await interaction.respond([]);
        return;
    }
    const matches = searchCases(catalog.cases, interaction.options.getFocused()).slice(0, 25);
    await interaction.respond(matches.map((item) => ({
        name: item.price === null ? item.name : `${item.name} (${money(item.price)} + key)`,
        value: item.id,
    })));
}

async function handleButton(interaction) {
    const [caseId, countText] = interaction.customId.slice(BUTTON_PREFIX.length).split(':');
    await withOpeningGuard(
        interaction,
        () => interaction.reply({ content: '⏳ Your last case is still opening.', ephemeral: true }),
        async () => {
            await interaction.deferReply();
            await openForInteraction(interaction, caseId, parseInt(countText, 10));
        },
    );
}

// Handles this feature's autocomplete and buttons. Returns true if it took the interaction.
async function handleCaseInteraction(interaction) {
    if (interaction.isAutocomplete() && interaction.commandName === 'cs2case') {
        await handleAutocomplete(interaction);
        return true;
    }
    if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX)) {
        try {
            await handleButton(interaction);
        } catch (err) {
            logSystemEvent('CS2_ERROR', 'ERROR', 'cs2', `Case button failed: ${err.message}`);
            try {
                const failed = { content: '❌ Could not open that case. Try again.' };
                if (interaction.deferred || interaction.replied) await interaction.editReply(failed);
                else await interaction.reply({ ...failed, ephemeral: true });
            } catch (_) {}
        }
        return true;
    }
    return false;
}

function leaderboardLines(rows, format) {
    if (!rows.length) return 'Nobody yet';
    return rows.map((row, index) => `**${index + 1}.** ${escapeMarkdown(row.username)}: ${format(row)}`).join('\n').slice(0, 1024);
}

const commands = {
    cs2case: {
        data: new SlashCommandBuilder()
            .setName('cs2case')
            .setDescription('Open a CS2 case with real skins, wear and Steam prices')
            .addStringOption((o) => o.setName('case').setDescription('Pick a case, or leave blank for a random one').setAutocomplete(true))
            .addIntegerOption((o) => o.setName('count').setDescription('How many to open (default 1)').setMinValue(1).setMaxValue(MAX_OPENS)),

        async execute(interaction) {
            const query = interaction.options.getString('case');
            const count = interaction.options.getInteger('count') || 1;
            await withOpeningGuard(
                interaction,
                () => interaction.editReply('⏳ Your last case is still opening.'),
                () => openForInteraction(interaction, query, count),
            );
        },
    },

    cs2leaderboard: {
        data: new SlashCommandBuilder()
            .setName('cs2leaderboard')
            .setDescription('See this server\'s CS2 case winners and losers'),

        async execute(interaction) {
            const board = stats.leaderboard(interaction.guildId || `dm:${interaction.user.id}`);
            const embed = new EmbedBuilder()
                .setTitle('📦 CS2 Case Leaderboard')
                .setColor(GOLD_COLOR)
                .addFields(
                    {
                        name: '🏆 Biggest pull',
                        value: leaderboardLines(board.biggestPull, (r) => `${r.best_name || 'Nothing'} (${money(r.best_value)})`),
                    },
                    { name: '📈 Most profit', value: leaderboardLines(board.mostProfit, (r) => signedMoney(r.value - r.spent)), inline: true },
                    { name: '💸 Most lost', value: leaderboardLines(board.mostLost, (r) => signedMoney(r.value - r.spent)), inline: true },
                    { name: '📦 Most opened', value: leaderboardLines(board.mostOpened, (r) => r.opened.toLocaleString()), inline: true },
                    { name: '💀 Longest knife drought', value: leaderboardLines(board.longestDrought, (r) => `${r.longest_drought.toLocaleString()} cases`) },
                );
            await interaction.editReply({ embeds: [embed] });
            logCommand('discord', interaction.user.username, '/cs2leaderboard', '', 'shown');
        },
    },
};

// Plain-text version for Twitch chat. These opens don't count toward a Discord server's totals.
async function openCaseAsText(args) {
    const { query, count } = parseCaseArgs(args);
    const catalog = await ensureCatalog();
    const caseData = pickCase(catalog.cases, query);
    if (!caseData) return `No case matches "${query}". Use !cs2case on its own for a random one.`;
    const run = openCases(caseData, catalog.prices, count);
    const worth = run.best.value === null ? '' : ` (${money(run.best.value)})`;
    return `📦 ${run.opened} × ${caseData.name}: best pull ${dropTitle(run.best)}${worth} | Cost ${money(run.spent)} | ${signedMoney(run.net)}`;
}

module.exports = { commands, handleCaseInteraction, openCaseAsText };
