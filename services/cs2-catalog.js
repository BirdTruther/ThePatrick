// services/cs2-catalog.js
// Keeps the list of CS2 cases, their skins and Steam prices up to date, so new
// cases show up by themselves. The last good copy is saved to disk, and a failed
// refresh keeps it.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Loaded on use, because logger.js opens the bot's database and keeps its timers running.
const logEvent = (...args) => require('../logger.js').logSystemEvent(...args);

const CRATES_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json';
const SKINS_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json';
const PRICES_URL = 'https://prices.csgotrader.app/latest/steam.json';

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'cs2-catalog.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 90_000;

const RARITY_TO_TIER = {
    'Mil-Spec Grade': 'blue',
    Restricted: 'purple',
    Classified: 'pink',
    Covert: 'red',
};

let catalog = null;
let refreshing = null;

function marketName(itemName, wear, stattrak) {
    let name = itemName;
    if (stattrak) {
        name = itemName.startsWith('★ ') ? `★ StatTrak™ ${itemName.slice(2)}` : `StatTrak™ ${itemName}`;
    }
    return wear ? `${name} (${wear})` : name;
}

function latestPrice(entry) {
    return entry?.last_24h ?? entry?.last_7d ?? entry?.last_30d ?? entry?.last_90d ?? null;
}

function buildCatalog({ crates, skins, prices }) {
    const skinById = new Map(skins.map((skin) => [skin.id, skin]));
    const keptPrices = {};

    function keepPrice(name) {
        const price = latestPrice(prices[name]);
        if (price !== null) keptPrices[name] = price;
    }

    function toItem(raw) {
        const skin = skinById.get(raw.id) || {};
        const wears = (skin.wears || []).map((wear) => wear.name);
        const stattrak = Boolean(skin.stattrak);
        for (const wear of wears.length ? wears : [null]) {
            keepPrice(marketName(raw.name, wear, false));
            if (stattrak) keepPrice(marketName(raw.name, wear, true));
        }
        return {
            name: raw.name,
            phase: raw.phase || null,
            image: raw.image,
            color: raw.rarity?.color || null,
            stattrak,
            hasWear: wears.length > 0,
            minFloat: skin.min_float ?? 0,
            maxFloat: skin.max_float ?? 1,
        };
    }

    const cases = crates
        .filter((crate) => crate.type === 'Case' && crate.contains?.length)
        .map((crate) => {
            const tiers = { blue: [], purple: [], pink: [], red: [], gold: [] };
            for (const raw of crate.contains) {
                const tier = RARITY_TO_TIER[raw.rarity?.name];
                if (tier) tiers[tier].push(toItem(raw));
            }
            tiers.gold = (crate.contains_rare || []).map(toItem);
            return {
                id: crate.id,
                name: crate.name,
                image: crate.image,
                price: latestPrice(prices[crate.market_hash_name]),
                tiers,
            };
        });

    if (cases.length < 10) throw new Error(`only ${cases.length} cases in the download`);
    if (Object.keys(keptPrices).length < 1000) throw new Error('price download looks incomplete');

    return { updatedAt: Date.now(), cases, prices: keptPrices };
}

async function fetchJson(url, fetchImpl) {
    const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'ThePatrick-bot' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    // The price host sends gzip files without saying they're compressed.
    const isGzip = body[0] === 0x1f && body[1] === 0x8b;
    return JSON.parse((isGzip ? zlib.gunzipSync(body) : body).toString('utf8'));
}

function loadFromDisk() {
    try {
        return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function saveToDisk(data) {
    const temp = `${CATALOG_PATH}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data));
    fs.renameSync(temp, CATALOG_PATH);
}

function refreshCatalog(fetchImpl = fetch) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
        const [crates, skins, prices] = await Promise.all(
            [CRATES_URL, SKINS_URL, PRICES_URL].map((url) => fetchJson(url, fetchImpl))
        );
        catalog = buildCatalog({ crates, skins, prices });
        saveToDisk(catalog);
        logEvent('CS2_CATALOG', 'INFO', 'cs2', `Catalog updated: ${catalog.cases.length} cases`);
        return catalog;
    })().finally(() => { refreshing = null; });
    return refreshing;
}

// Returns the catalog already in memory, without waiting on anything.
function getCatalog() {
    if (!catalog) catalog = loadFromDisk();
    return catalog;
}

// Returns the catalog, downloading it first if this box has never had one.
async function ensureCatalog() {
    return getCatalog() || refreshCatalog();
}

function refreshIfStale() {
    const current = getCatalog();
    if (current && Date.now() - current.updatedAt < MAX_AGE_MS) return;
    refreshCatalog().catch((err) => {
        logEvent('CS2_CATALOG', 'WARNING', 'cs2', `Catalog update failed: ${err.message}`);
    });
}

function startCatalogRefresh() {
    refreshIfStale();
    setInterval(refreshIfStale, CHECK_EVERY_MS).unref();
}

function normalize(text) {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Finds cases by name, newest first.
function searchCases(cases, query = '') {
    const wanted = normalize(query);
    return [...cases].reverse().filter((item) => normalize(item.name).includes(wanted));
}

function findCase(cases, query) {
    const wanted = normalize(query);
    return cases.find((item) => item.id === query)
        || cases.find((item) => normalize(item.name) === wanted)
        || searchCases(cases, query)[0]
        || null;
}

module.exports = {
    buildCatalog,
    marketName,
    getCatalog,
    ensureCatalog,
    refreshCatalog,
    startCatalogRefresh,
    searchCases,
    findCase,
};
