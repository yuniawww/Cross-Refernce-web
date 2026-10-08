const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractTrwProducts, parseZfCandidateGroups, findFirstZfMatch, waitForZfSearchOutcome } = require('../zf_scraper');

test('ZF accepts visible products for the current number when clicking leaves the page unchanged', async () => {
    const state = {
        url: 'https://aftermarket.zf.com/cn/catalog/',
        resultSignature: 'TRW GDB8301 A 000 420 71 03',
        resultCount: 1,
        noResults: false,
        loading: false
    };
    const page = {
        evaluate: async (fn, ...args) => {
            if (fn.name === 'readZfSearchState') return state;
            if (fn.name === 'extractTrwProducts') {
                assert.equal(args[0], 'A0004207103');
                return [{ partNumber: 'GDB8301', brand: 'TRW' }];
            }
            return true;
        }
    };
    const tracker = { getState: () => ({ started: 0, pending: 0, lastActivity: 0 }) };
    assert.equal(await waitForZfSearchOutcome(page, state, {}, tracker, 'A0004207103'), state);
});

test('ZF ignores a transient empty result while the current query is pending', async () => {
    const previous = { url: 'https://aftermarket.zf.com/zh/catalog/', resultSignature: '', resultCount: 0, noResults: false, loading: false };
    let reads = 0;
    const page = {
        evaluate: async fn => {
            if (fn.name === 'readZfSearchState') {
                reads++;
                return { ...previous, noResults: reads < 3, resultCount: reads < 3 ? 0 : 1, resultSignature: reads < 3 ? '' : 'TRW GDB8301' };
            }
            if (fn.name === 'extractTrwProducts') return reads < 3 ? [] : [{ partNumber: 'GDB8301', brand: 'TRW' }];
            return true;
        }
    };
    const tracker = { getState: () => ({ started: 1, pending: reads < 3 ? 1 : 0, lastActivity: 0 }) };
    const state = await waitForZfSearchOutcome(page, previous, {}, tracker, 'A0004207103');
    assert.equal(state.noResults, false);
    assert.equal(state.resultCount, 1);
});

test('ZF accepts a new visible no-results page when its request was not tracked', async () => {
    const previous = {
        url: 'https://aftermarket.zf.com/cn/catalog/?country=CN',
        resultSignature: '', resultCount: 0, noResults: false, loading: false
    };
    const empty = { ...previous, noResults: true };
    const page = {
        evaluate: async fn => fn.name === 'readZfSearchState' ? empty : true
    };
    const tracker = { getState: () => ({ started: 0, pending: 0, lastActivity: 0 }) };

    assert.equal(await waitForZfSearchOutcome(page, previous, {}, tracker, 'UNKNOWN123'), empty);
});

test('ZF keeps every TRW product whose found-via number matches the searched number', () => {
    const makeCard = (partNumber, foundVia) => {
        const card = {
            isConnected: true,
            getClientRects: () => [1],
            querySelectorAll: selector => selector === '[data-test="found-via__value"]'
                ? [{ textContent: foundVia }]
                : []
        };
        const brand = {
            textContent: 'TRW',
            isConnected: true,
            getClientRects: () => [1],
            closest: () => card
        };
        const details = {
            querySelectorAll: () => [brand, { textContent: partNumber }],
            parentElement: card
        };
        brand.parentElement = details;
        return brand;
    };
    const previousDocument = global.document;
    const previousGetComputedStyle = global.getComputedStyle;
    global.document = {
        querySelectorAll: () => [
            makeCard('GDB8301', 'A 000 420 71 03'),
            makeCard('GDB8302', 'A0004207103'),
            makeCard('GDB9999', 'A 000 420 71 04')
        ]
    };
    global.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    try {
        assert.deepEqual(extractTrwProducts('A0004207103'), [
            { partNumber: 'GDB8301', brand: 'TRW' },
            { partNumber: 'GDB8302', brand: 'TRW' }
        ]);
    } finally {
        global.document = previousDocument;
        global.getComputedStyle = previousGetComputedStyle;
    }
});

test('ZF cleans new-number notes and keeps each line as an ordered candidate group', () => {
    assert.deepEqual(parseZfCandidateGroups('A0004207600=A0004201706 (新号)\nB123；B456（新号）'), [
        { input: 'A0004207600; A0004201706', candidates: ['A0004207600', 'A0004201706'] },
        { input: 'B123; B456', candidates: ['B123', 'B456'] }
    ]);
});

test('ZF skips duplicate candidates within one line', () => {
    assert.deepEqual(parseZfCandidateGroups([' A0004207600 = a0004207600; A0004201706 ']), [
        { input: 'A0004207600; A0004201706', candidates: ['A0004207600', 'A0004201706'] }
    ]);
});

test('ZF stops after the first candidate with TRW products', async () => {
    const calls = [];
    const product = { partNumber: 'GDB1234' };
    const match = await findFirstZfMatch(['A0004207600', 'A0004201706'], async candidate => {
        calls.push(candidate);
        return [product];
    });

    assert.deepEqual(calls, ['A0004207600']);
    assert.equal(match.matchedPartNumber, 'A0004207600');
    assert.deepEqual(match.products, [product]);
});

test('ZF tries the next candidate only after an empty result', async () => {
    const calls = [];
    const match = await findFirstZfMatch(['A0004207600', 'A0004201706', 'A0004209999'], async candidate => {
        calls.push(candidate);
        return candidate === 'A0004201706' ? [{ partNumber: 'GDB5678' }] : [];
    });

    assert.deepEqual(calls, ['A0004207600', 'A0004201706']);
    assert.equal(match.matchedPartNumber, 'A0004201706');
    assert.deepEqual(match.attemptedPartNumbers, calls);
});
