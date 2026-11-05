// commands/cs2.js
// /cs2stats. Case opening lives in cs2-case.js.
const { SlashCommandBuilder } = require('discord.js');
const { logCommand, logSystemEvent } = require('../logger.js');

// ===== SERVICE FUNCTIONS =====

async function getCS2PlayerStats(steamInput) {
    const apiKey = process.env.STEAM_API_KEY;
    if (!apiKey) return 'CS2 stats lookup is not configured (missing STEAM_API_KEY).';
    try {
        let steamId = steamInput.trim();
        if (!/^\d{17}$/.test(steamId)) {
            const vanityRes  = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${apiKey}&vanityurl=${encodeURIComponent(steamId)}`);
            const vanityData = await vanityRes.json();
            if (vanityData?.response?.success === 1) {
                steamId = vanityData.response.steamid;
            } else {
                return `❌ Could not find a Steam account for **"${steamInput}"**.\nTry using your full SteamID64 (17-digit number from steamid.io).`;
            }
        }
        let displayName = steamId;
        try {
            const summaryRes  = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`);
            const summaryData = await summaryRes.json();
            const player      = summaryData?.response?.players?.[0];
            if (player?.personaname) displayName = player.personaname;
        } catch (_) {}
        const statsRes = await fetch(`https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${apiKey}&steamid=${steamId}`);
        if (!statsRes.ok) {
            if (statsRes.status === 403) return `❌ **${displayName}**'s stats are set to private.\nThey need to go to Steam → Edit Profile → Privacy Settings → set **Game Details** to Public.`;
            return `❌ Could not retrieve stats (Steam API error ${statsRes.status}).`;
        }
        const statsData = await statsRes.json();
        const stats     = statsData?.playerstats?.stats;
        if (!stats || stats.length === 0) return `❌ No CS2 stats found for **${displayName}**. Stats may be private or they haven't played CS2.`;
        const getStat = (name) => stats.find(s => s.name === name)?.value || 0;
        const kills         = getStat('total_kills');
        const deaths        = getStat('total_deaths');
        const hsKills       = getStat('total_kills_headshot');
        const wins          = getStat('total_wins');
        const roundsPlayed  = getStat('total_rounds_played');
        const matchesPlayed = getStat('total_matches_played');
        const mvps          = getStat('total_mvps');
        const shotsFired    = getStat('total_shots_fired');
        const shotsHit      = getStat('total_shots_hit');
        const timePlayed    = getStat('total_time_played');
        const bombsPlanted  = getStat('total_planted_bombs');
        const bombsDefused  = getStat('total_defused_bombs');
        const hoursPlayed   = (timePlayed / 3600).toFixed(0);
        const kd            = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
        const hsPercent     = kills > 0 ? ((hsKills / kills) * 100).toFixed(1) : '0.0';
        const accuracy      = shotsFired > 0 ? ((shotsHit / shotsFired) * 100).toFixed(1) : '0.0';
        const winRate       = roundsPlayed > 0 ? ((wins / roundsPlayed) * 100).toFixed(1) : '0.0';
        return [
            `🎮 **CS2 Stats — ${displayName}**`,
            `⚔️  K/D: ${kd} | Kills: ${kills.toLocaleString()} | Deaths: ${deaths.toLocaleString()}`,
            `🎯 Headshots: ${hsKills.toLocaleString()} (${hsPercent}%) | Accuracy: ${accuracy}%`,
            `🏆 Matches Played: ${matchesPlayed.toLocaleString()} | Round Win Rate: ${winRate}% | MVPs: ${mvps.toLocaleString()}`,
            `💣 Bombs Planted: ${bombsPlanted.toLocaleString()} | Defused: ${bombsDefused.toLocaleString()} | Hours: ${hoursPlayed}h`,
            `⚠️ *Stats are all-time totals (casual + competitive combined) via Steam API.*`,
        ].join('\n');
    } catch (error) {
        console.error('[CS2 Stats Error]', error);
        logSystemEvent('CS2_ERROR', 'WARNING', 'cs2', `cs2stats fetch failed for "${steamInput}": ${error.message}`);
        return `❌ Error fetching CS2 stats for "${steamInput}".`;
    }
}

const commands = {
    cs2stats: {
        data: new SlashCommandBuilder()
            .setName('cs2stats')
            .setDescription('Get CS2 player stats')
            .addStringOption(o => o.setName('steam').setDescription('Steam ID or username').setRequired(true)),

        async execute(interaction) {
            const steam = interaction.options.getString('steam');
            const result = await getCS2PlayerStats(steam);
            await interaction.editReply(result);
            logCommand('discord', interaction.user.username, '/cs2stats', steam, result);
        }
    },
};

// ===== EXPORTS =====
// Service functions exported separately so twitch.js can reuse them
module.exports = {
    commands,
    getCS2PlayerStats,
};