// services/cs2-case.js
// Rolls case openings and keeps each server's running totals. No Discord code here.

const { marketName } = require('./cs2-catalog.js');

const KEY_COST_USD = 2.49;
const MAX_OPENS = 100;
const STATTRAK_CHANCE = 0.10;

const TIERS = [
    { key: 'blue', label: 'Mil-Spec', emoji: '🟦', chance: 0.7992 },
    { key: 'purple', label: 'Restricted', emoji: '🟪', chance: 0.1598 },
    { key: 'pink', label: 'Classified', emoji: '🩷', chance: 0.0320 },
    { key: 'red', label: 'Covert', emoji: '🟥', chance: 0.0064 },
    { key: 'gold', label: 'Knife/Gloves', emoji: '🟨', chance: 0.0026 },
];
const TIER_RANK = Object.fromEntries(TIERS.map((tier, index) => [tier.key, index]));

// Community-documented wear bands: how often a skin lands in each float range,
// before the float is scaled to that skin's own minimum and maximum.
const FLOAT_BANDS = [
    { chance: 0.03, low: 0, high: 0.07 },
    { chance: 0.24, low: 0.07, high: 0.15 },
    { chance: 0.33, low: 0.15, high: 0.38 },
    { chance: 0.24, low: 0.38, high: 0.45 },
    { chance: 0.16, low: 0.45, high: 1 },
];

function wearName(float) {
    if (float < 0.07) return 'Factory New';
    if (float < 0.15) return 'Minimal Wear';
    if (float < 0.38) return 'Field-Tested';
    if (float < 0.45) return 'Well-Worn';
    return 'Battle-Scarred';
}

function rollFloat(item, rng) {
    let roll = rng();
    let band = FLOAT_BANDS[FLOAT_BANDS.length - 1];
    for (const candidate of FLOAT_BANDS) {
        if (roll < candidate.chance) { band = candidate; break; }
        roll -= candidate.chance;
    }
    const base = band.low + rng() * (band.high - band.low);
    return item.minFloat + base * (item.maxFloat - item.minFloat);
}

// Older cases can lack a tier, so its odds are shared across the tiers they have.
function rollTier(caseData, rng) {
    const available = TIERS.filter((tier) => caseData.tiers[tier.key].length > 0);
    const total = available.reduce((sum, tier) => sum + tier.chance, 0);
    let roll = rng() * total;
    for (const tier of available) {
        if (roll < tier.chance) return tier;
        roll -= tier.chance;
    }
    return available[available.length - 1];
}

function openOne(caseData, prices, rng = Math.random) {
    const tier = rollTier(caseData, rng);
    const pool = caseData.tiers[tier.key];
    const item = pool[Math.floor(rng() * pool.length)];
    const float = item.hasWear ? rollFloat(item, rng) : null;
    const wear = float === null ? null : wearName(float);
    const stattrak = item.stattrak && rng() < STATTRAK_CHANCE;
    const fullName = marketName(item.name, wear, stattrak);
    return {
        tier: tier.key,
        name: fullName,
        phase: item.phase,
        image: item.image,
        color: item.color,
        float,
        wear,
        stattrak,
        value: prices[fullName] ?? null,
    };
}

function isBetter(drop, best) {
    if (!best) return true;
    if (TIER_RANK[drop.tier] !== TIER_RANK[best.tier]) return TIER_RANK[drop.tier] > TIER_RANK[best.tier];
    return (drop.value ?? 0) > (best.value ?? 0);
}

function openCases(caseData, prices, count = 1, rng = Math.random) {
    const opened = Math.min(Math.max(Math.floor(count) || 1, 1), MAX_OPENS);
    const costEach = (caseData.price ?? 0) + KEY_COST_USD;
    const counts = { blue: 0, purple: 0, pink: 0, red: 0, gold: 0 };
    const drops = [];
    let best = null;
    let value = 0;
    let stattraks = 0;
    for (let i = 0; i < opened; i++) {
        const drop = openOne(caseData, prices, rng);
        drops.push(drop);
        counts[drop.tier]++;
        value += drop.value ?? 0;
        if (drop.stattrak) stattraks++;
        if (isBetter(drop, best)) best = drop;
    }
    const spent = costEach * opened;
    return { opened, costEach, spent, value, net: value - spent, counts, stattraks, drops, best };
}

// "Kilowatt 10" or the older "Kilowatt 10 1.50", whose price is now ignored.
function parseCaseArgs(args = '') {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const isNumber = (token) => /^\d+(\.\d+)?$/.test(token || '');
    if (isNumber(tokens[tokens.length - 1]) && isNumber(tokens[tokens.length - 2])) tokens.pop();
    const count = isNumber(tokens[tokens.length - 1]) ? parseInt(tokens.pop(), 10) : 1;
    return { query: tokens.join(' '), count };
}

function createCaseStats(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS cs2_case_stats (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            opened INTEGER NOT NULL DEFAULT 0,
            spent REAL NOT NULL DEFAULT 0,
            value REAL NOT NULL DEFAULT 0,
            best_name TEXT,
            best_value REAL NOT NULL DEFAULT 0,
            knives INTEGER NOT NULL DEFAULT 0,
            since_knife INTEGER NOT NULL DEFAULT 0,
            longest_drought INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        )
    `);
    const read = db.prepare('SELECT * FROM cs2_case_stats WHERE guild_id = ? AND user_id = ?');
    const write = db.prepare(`
        INSERT INTO cs2_case_stats
            (guild_id, user_id, username, opened, spent, value, best_name, best_value, knives, since_knife, longest_drought)
        VALUES (@guild_id, @user_id, @username, @opened, @spent, @value, @best_name, @best_value, @knives, @since_knife, @longest_drought)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET
            username = @username, opened = @opened, spent = @spent, value = @value, best_name = @best_name,
            best_value = @best_value, knives = @knives, since_knife = @since_knife, longest_drought = @longest_drought
    `);

    const record = db.transaction((guildId, userId, username, run) => {
        const row = read.get(guildId, userId) || {
            guild_id: guildId, user_id: userId, opened: 0, spent: 0, value: 0, best_name: null,
            best_value: 0, knives: 0, since_knife: 0, longest_drought: 0,
        };
        const next = {
            ...row,
            username,
            opened: row.opened + run.opened,
            spent: row.spent + run.spent,
            value: row.value + run.value,
        };
        for (const drop of run.drops) {
            if ((drop.value ?? 0) > next.best_value) {
                next.best_value = drop.value;
                next.best_name = drop.name;
            }
            if (drop.tier === 'gold') {
                next.knives++;
                next.since_knife = 0;
            } else {
                next.since_knife++;
                next.longest_drought = Math.max(next.longest_drought, next.since_knife);
            }
        }
        write.run(next);
        return next;
    });

    const LEADERBOARDS = {
        biggestPull: 'best_value DESC',
        mostLost: '(value - spent) ASC',
        mostProfit: '(value - spent) DESC',
        mostOpened: 'opened DESC',
        longestDrought: 'longest_drought DESC',
    };

    function leaderboard(guildId, limit = 5) {
        const result = {};
        for (const [name, order] of Object.entries(LEADERBOARDS)) {
            result[name] = db
                .prepare(`SELECT * FROM cs2_case_stats WHERE guild_id = ? ORDER BY ${order} LIMIT ?`)
                .all(guildId, limit);
        }
        return result;
    }

    return { record, leaderboard };
}

module.exports = {
    KEY_COST_USD,
    MAX_OPENS,
    TIERS,
    wearName,
    rollFloat,
    openCases,
    parseCaseArgs,
    createCaseStats,
};
