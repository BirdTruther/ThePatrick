// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { buildCatalog, marketName, searchCases, findCase } = require('../services/cs2-catalog.js');
const { wearName, rollFloat, openCases, parseCaseArgs, createCaseStats } = require('../services/cs2-case.js');

function item(name, tier, extra = {}) {
    return {
        name, tier, phase: null, image: 'img', color: '#fff', stattrak: false,
        hasWear: true, minFloat: 0, maxFloat: 1, ...extra,
    };
}

const fakeCase = {
    id: 'crate-1',
    name: 'Fever Case',
    image: 'case-img',
    price: 1,
    tiers: {
        blue: [item('Blue Gun', 'blue')],
        purple: [item('Purple Gun', 'purple')],
        pink: [],
        red: [],
        gold: [item('★ Knife', 'gold', { hasWear: false })],
    },
};

function buildFixture(caseCount = 10) {
    const crates = [];
    for (let i = 0; i < caseCount; i++) {
        crates.push({
            id: `crate-${i}`,
            name: `Case ${i}`,
            type: 'Case',
            image: 'img',
            market_hash_name: `Case ${i}`,
            contains: [{ id: 'skin-1', name: 'AK-47 | Test', image: 'a', rarity: { name: 'Covert', color: '#f00' } }],
            contains_rare: [{ id: 'skin-2', name: '★ Knife | Doppler', phase: 'Ruby', image: 'b', rarity: { name: 'Covert', color: '#f00' } }],
        });
    }
    crates.push({ id: 'capsule', name: 'Sticker Capsule', type: 'Sticker Capsule', contains: [] });
    const skins = [
        { id: 'skin-1', min_float: 0.1, max_float: 0.5, stattrak: true, wears: [{ name: 'Field-Tested' }] },
        { id: 'skin-2', min_float: 0, max_float: 0.08, stattrak: true, wears: [{ name: 'Factory New' }] },
    ];
    const prices = { 'Case 0': { last_24h: null, last_7d: 0.5 } };
    for (let i = 0; i < 1000; i++) prices[`AK-47 | Test (Field-Tested)`] = { last_24h: 10 };
    return { crates, skins, prices };
}

test('market names match Steam, including StatTrak on knives', () => {
    assert.strictEqual(marketName('AK-47 | Test', 'Field-Tested', false), 'AK-47 | Test (Field-Tested)');
    assert.strictEqual(marketName('AK-47 | Test', 'Field-Tested', true), 'StatTrak™ AK-47 | Test (Field-Tested)');
    assert.strictEqual(marketName('★ Knife', null, true), '★ StatTrak™ Knife');
});

test('the catalog keeps only real cases and falls back to an older price', () => {
    const fixture = buildFixture();
    for (let i = 0; i < 1000; i++) fixture.prices[`Case ${i}`] = fixture.prices[`Case ${i}`] || { last_24h: 1 };
    for (let i = 0; i < 1000; i++) {
        fixture.crates[0].contains.push({ id: `extra-${i}`, name: `Gun ${i}`, rarity: { name: 'Restricted' } });
        fixture.prices[`Gun ${i}`] = { last_24h: 1 };
    }
    const catalog = buildCatalog(fixture);
    assert.strictEqual(catalog.cases.length, 10);
    assert.strictEqual(catalog.cases[0].price, 0.5);
    assert.strictEqual(catalog.cases[0].tiers.red[0].minFloat, 0.1);
    assert.strictEqual(catalog.cases[0].tiers.gold[0].phase, 'Ruby');
});

test('a bad download is rejected so the old catalog stays', () => {
    assert.throws(() => buildCatalog(buildFixture(3)), /only 3 cases/);
    assert.throws(() => buildCatalog(buildFixture(10)), /incomplete/);
});

test('case search handles partial names, ids and misses', () => {
    const cases = [{ id: 'a', name: 'Chroma Case' }, { id: 'b', name: 'Chroma 2 Case' }, { id: 'c', name: 'Fever Case' }];
    assert.strictEqual(findCase(cases, 'c').name, 'Fever Case');
    assert.strictEqual(findCase(cases, 'chroma case').id, 'a');
    assert.strictEqual(findCase(cases, 'fever').id, 'c');
    assert.strictEqual(findCase(cases, 'nothing'), null);
    assert.strictEqual(searchCases(cases)[0].id, 'c');
});

test('wear names follow the float ranges', () => {
    assert.strictEqual(wearName(0.069), 'Factory New');
    assert.strictEqual(wearName(0.07), 'Minimal Wear');
    assert.strictEqual(wearName(0.15), 'Field-Tested');
    assert.strictEqual(wearName(0.38), 'Well-Worn');
    assert.strictEqual(wearName(0.45), 'Battle-Scarred');
});

test('floats stay inside a skin\'s own range', () => {
    const skin = item('Gun', 'blue', { minFloat: 0.1, maxFloat: 0.26 });
    for (let i = 0; i < 2000; i++) {
        const float = rollFloat(skin, Math.random);
        assert.ok(float >= 0.1 && float <= 0.26);
    }
});

test('odds stay close to the real rates and missing tiers are skipped', () => {
    const prices = { '★ Knife': 500 };
    const run = openCases({ ...fakeCase }, prices, 100);
    assert.strictEqual(run.counts.pink + run.counts.red, 0);
    const counts = { blue: 0, purple: 0, gold: 0 };
    for (let i = 0; i < 2000; i++) {
        const result = openCases(fakeCase, prices, 50);
        for (const key of Object.keys(counts)) counts[key] += result.counts[key];
    }
    const total = counts.blue + counts.purple + counts.gold;
    assert.ok(Math.abs(counts.blue / total - 0.8295) < 0.01);
    assert.ok(Math.abs(counts.gold / total - 0.0027) < 0.001);
});

test('money adds up and the count is capped', () => {
    const prices = { '★ Knife': 500 };
    const run = openCases(fakeCase, prices, 500);
    assert.strictEqual(run.opened, 100);
    assert.ok(Math.abs(run.spent - 349) < 0.001);
    assert.ok(Math.abs(run.net - (run.value - run.spent)) < 0.001);
});

test('a knife outranks a pricier gun as the best pull', () => {
    let calls = 0;
    // Blue gun uses 4 rolls (tier, skin, float band, float). The knife uses 2 (tier, skin).
    const rolls = [0, 0, 0.5, 0.5, 0.9999, 0];
    const rng = () => rolls[calls++ % rolls.length];
    const prices = { '★ Knife': 5, 'Blue Gun (Field-Tested)': 100 };
    const run = openCases(fakeCase, prices, 2, rng);
    assert.strictEqual(run.best.tier, 'gold');
});

test('Twitch arguments parse with and without a count', () => {
    assert.deepStrictEqual(parseCaseArgs(''), { query: '', count: 1 });
    assert.deepStrictEqual(parseCaseArgs('Kilowatt'), { query: 'Kilowatt', count: 1 });
    assert.deepStrictEqual(parseCaseArgs('Kilowatt 10'), { query: 'Kilowatt', count: 10 });
    assert.deepStrictEqual(parseCaseArgs('Kilowatt 10 1.50'), { query: 'Kilowatt', count: 10 });
    assert.deepStrictEqual(parseCaseArgs('Chroma 2 Case'), { query: 'Chroma 2 Case', count: 1 });
});

test('totals, droughts and leaderboards are kept per server', () => {
    const stats = createCaseStats(new Database(':memory:'));
    const drop = (tier, value, name = 'Gun') => ({ tier, value, name });
    const run = (drops, spent) => ({
        opened: drops.length, spent, value: drops.reduce((sum, d) => sum + (d.value ?? 0), 0), drops,
    });

    stats.record('g1', 'u1', 'alex', run([drop('blue', 1), drop('blue', null), drop('blue', 1)], 12));
    const totals = stats.record('g1', 'u1', 'alex', run([drop('gold', 500, 'Knife'), drop('blue', 1)], 8));
    assert.strictEqual(totals.opened, 5);
    assert.strictEqual(totals.knives, 1);
    assert.strictEqual(totals.since_knife, 1);
    assert.strictEqual(totals.longest_drought, 3);
    assert.strictEqual(totals.best_name, 'Knife');

    stats.record('g1', 'u2', 'sam', run([drop('blue', 1)], 100));
    stats.record('g2', 'u3', 'other', run([drop('blue', 1)], 1));
    const board = stats.leaderboard('g1');
    assert.strictEqual(board.mostLost[0].username, 'sam');
    assert.strictEqual(board.mostProfit[0].username, 'alex');
    assert.strictEqual(board.mostOpened.length, 2);
});
