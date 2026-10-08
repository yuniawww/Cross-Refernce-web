const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    findFirstBendixMatch,
    isBendixEmptyResultText,
    keepFirstBendixProduct,
    parseBendixCandidateGroups
} = require('../bendix_scraper');

test('Bendix keeps only the first highest-relevance product card', () => {
    const db1772 = { partNumber: 'DB1772', width: '145.5 mm' };
    const db2525 = { partNumber: 'DB2525', width: '169.8 mm' };
    assert.deepEqual(keepFirstBendixProduct([db1772, db2525]), [db1772]);
    assert.deepEqual(keepFirstBendixProduct([]), []);
});

test('Bendix recognizes the exact no-match result message', () => {
    assert.equal(isBendixEmptyResultText("We couldn’t find an exact match for ‘04465 26421’. Clear all", '04465 26421'), true);
    assert.equal(isBendixEmptyResultText("We couldn't find an exact match for '04465 26421'.", '04465 26421'), true);
    assert.equal(isBendixEmptyResultText("We couldn’t find an exact match for ‘04465 26421’. Clear all", '04465 26420'), false);
    assert.equal(isBendixEmptyResultText('1 result found'), false);
});

test('Bendix input treats each line as one ordered candidate group', () => {
    const groups = parseBendixCandidateGroups(`
        04465  35250; 04491 35290
        04466-60010; 04465-60010; 04466-60020; 04466-60050; 04492-60010
        04465 42160；04465 02220
        04465 26421; 04465 26420
    `);

    assert.deepEqual(groups, [
        {
            input: '04465 35250; 04491 35290',
            candidates: ['04465 35250', '04491 35290']
        },
        {
            input: '04466-60010; 04465-60010; 04466-60020; 04466-60050; 04492-60010',
            candidates: ['04466-60010', '04465-60010', '04466-60020', '04466-60050', '04492-60010']
        },
        {
            input: '04465 42160; 04465 02220',
            candidates: ['04465 42160', '04465 02220']
        },
        {
            input: '04465 26421; 04465 26420',
            candidates: ['04465 26421', '04465 26420']
        }
    ]);
});

test('Bendix input ignores pasted table separator lines and duplicate candidates', () => {
    const groups = parseBendixCandidateGroups([
        '|   |',
        '| - |',
        ' 04465 35250 ; 04465   35250 ; 04491 35290 '
    ]);

    assert.deepEqual(groups, [{
        input: '04465 35250; 04491 35290',
        candidates: ['04465 35250', '04491 35290']
    }]);
});

test('Bendix stops immediately when the first candidate has products', async () => {
    const calls = [];
    const product = { partNumber: 'DB1482' };
    const match = await findFirstBendixMatch(['04465 35250', '04491 35290'], async candidate => {
        calls.push(candidate);
        return [product];
    });

    assert.deepEqual(calls, ['04465 35250']);
    assert.equal(match.matchedPartNumber, '04465 35250');
    assert.deepEqual(match.attemptedPartNumbers, ['04465 35250']);
    assert.deepEqual(match.products, [product]);
});

test('Bendix tries the next candidate only after an empty result', async () => {
    const calls = [];
    const product = { partNumber: 'DB9999' };
    const match = await findFirstBendixMatch(['11111 11111', '22222-22222', '33333'], async candidate => {
        calls.push(candidate);
        return candidate === '22222-22222' ? [product] : [];
    });

    assert.deepEqual(calls, ['11111 11111', '22222-22222']);
    assert.equal(match.matchedPartNumber, '22222-22222');
    assert.deepEqual(match.attemptedPartNumbers, calls);
    assert.deepEqual(match.products, [product]);
});

test('Bendix reports every attempted candidate when none has products', async () => {
    const candidates = ['11111', '22222', '33333'];
    const calls = [];
    const match = await findFirstBendixMatch(candidates, async candidate => {
        calls.push(candidate);
        return [];
    });

    assert.deepEqual(calls, candidates);
    assert.equal(match.matchedPartNumber, '');
    assert.deepEqual(match.attemptedPartNumbers, candidates);
    assert.deepEqual(match.products, []);
});
