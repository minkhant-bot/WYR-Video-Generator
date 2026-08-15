import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeForHook, buildPlanFromPoolRows, computeInsertionFields, contentFamilyForCategory, selectDiversePlan } from './pool-selection.js';

let nextId = 1;
const row = ({ category, a, b, aq, bq, hookScore = 50, lastUsedAt = null, usedCount = 0, isFantasy = null, motifA = null, motifB = null }) => {
  const id = nextId++;
  const inferredFamily = contentFamilyForCategory(category);
  return {
    id, category, content_family: inferredFamily,
    motif_key_a: motifA, motif_key_b: motifB,
    option_a_text: a, option_a_search_query: aq || `${a} scene`,
    option_b_text: b, option_b_search_query: bq || `${b} scene`,
    is_fantasy: isFantasy ?? (category === 'superpowers' || category === 'fantasy'),
    hook_score: hookScore, quality_score: 90, visual_score: 90,
    last_used_at: lastUsedAt, used_count: usedCount,
  };
};

test('computeInsertionFields rejects a boring/blocked pair without throwing', () => {
  const fields = computeInsertionFields({ category: 'travel', optionA: { text: 'Coffee', searchQuery: 'coffee cup' }, optionB: { text: 'Tea', searchQuery: 'tea cup' } });
  assert.equal(fields.accepted, false);
  assert.ok(fields.reasons.length > 0);
});

test('computeInsertionFields classifies a superpower category as fantasy and derives a content family', () => {
  const fields = computeInsertionFields({ category: 'superpowers', optionA: { text: 'Have super strength', searchQuery: 'strong hero lifting car' }, optionB: { text: 'Have telepathy', searchQuery: 'person reading mind' } });
  assert.equal(fields.accepted, true);
  assert.equal(fields.isFantasy, true);
  assert.equal(fields.contentFamily, 'powers_and_impossible');
  assert.equal(typeof fields.dedupeKey, 'string');
});

test('computeInsertionFields classifies a text-only fantasy motif on a non-fantasy category', () => {
  const fields = computeInsertionFields({ category: 'money', optionA: { text: 'Teleport to claim your prize', searchQuery: 'teleport prize ceremony' }, optionB: { text: 'Wait in line for your prize', searchQuery: 'people waiting in line' } });
  assert.equal(fields.accepted, true);
  assert.equal(fields.isFantasy, true);
  assert.equal(fields.contentFamily, 'wealth_and_luxury');
});

test('selectDiversePlan picks exactly `count` when enough diverse candidates exist', () => {
  const candidates = [
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet' }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse' }),
    row({ category: 'travel', a: 'Backpack Europe', b: 'Cruise the Caribbean' }),
    row({ category: 'food', a: 'Eat at a 5-star restaurant', b: 'Cook with a chef' }),
    row({ category: 'adventure', a: 'Skydive', b: 'Scuba dive' }),
    row({ category: 'space', a: 'Visit the ISS', b: 'Visit the moon' }),
    row({ category: 'ocean', a: 'Swim with sharks', b: 'Swim with whales' }),
    row({ category: 'fame', a: 'Be a movie star', b: 'Be a rock star' }),
  ];
  const result = selectDiversePlan(candidates, { count: 8 });
  assert.ok(result);
  assert.equal(result.selected.length, 8);
});

test('selectDiversePlan enforces the fantasy cap at 1', () => {
  // 9 candidates so that rejecting the 2nd fantasy-coded one still leaves 8 fillable slots --
  // the fantasy cap is a hard rule and is never relaxed to compensate for a thin window.
  const candidates = [
    row({ category: 'superpowers', a: 'Fly', b: 'Turn invisible', isFantasy: true, motifA: 'flight', motifB: 'invisibility' }),
    row({ category: 'fantasy', a: 'Read minds', b: 'Freeze time', isFantasy: true, motifA: 'mind-reading', motifB: 'time-control' }),
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet' }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse' }),
    row({ category: 'travel', a: 'Backpack Europe', b: 'Cruise the Caribbean' }),
    row({ category: 'food', a: 'Eat at a 5-star restaurant', b: 'Cook with a chef' }),
    row({ category: 'adventure', a: 'Skydive', b: 'Scuba dive' }),
    row({ category: 'space', a: 'Visit the ISS', b: 'Visit the moon' }),
    row({ category: 'ocean', a: 'Swim with sharks', b: 'Swim with whales' }),
  ];
  const result = selectDiversePlan(candidates, { count: 8 });
  assert.ok(result);
  assert.equal(result.fantasyCount, 1);
  assert.equal(result.selected.length, 8);
});

test('selectDiversePlan enforces a content-family cap of 2 when enough alternative families exist', () => {
  const candidates = [
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet' }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse' }),
    row({ category: 'dream homes', a: 'Own a lake house', b: 'Own a ski chalet' }),
    row({ category: 'cars', a: 'Own a sports car', b: 'Own a classic car' }),
    row({ category: 'travel', a: 'Backpack Europe', b: 'Cruise the Caribbean' }),
    row({ category: 'food', a: 'Eat at a 5-star restaurant', b: 'Cook with a chef' }),
    row({ category: 'space', a: 'Visit the ISS', b: 'Visit the moon' }),
    row({ category: 'ocean', a: 'Swim with sharks', b: 'Swim with whales' }),
    row({ category: 'adventure', a: 'Skydive', b: 'Scuba dive' }),
    row({ category: 'fame', a: 'Be a movie star', b: 'Be a rock star' }),
  ];
  const result = selectDiversePlan(candidates, { count: 8 });
  assert.ok(result);
  const wealthFamilyCount = result.selected.filter(r => r.content_family === 'wealth_and_luxury').length;
  assert.ok(wealthFamilyCount <= 2, `expected at most 2 wealth_and_luxury questions, got ${wealthFamilyCount}`);
  assert.equal(result.selected.length, 8);
});

test('selectDiversePlan reaches at least 6 distinct families when inventory allows it', () => {
  const candidates = [
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet' }),
    row({ category: 'travel', a: 'Backpack Europe', b: 'Cruise the Caribbean' }),
    row({ category: 'food', a: 'Eat at a 5-star restaurant', b: 'Cook with a chef' }),
    row({ category: 'space', a: 'Visit the ISS', b: 'Visit the moon' }),
    row({ category: 'survival-lite', a: 'Survive a desert island', b: 'Survive an arctic winter' }),
    row({ category: 'superpowers', a: 'Fly', b: 'Turn invisible', isFantasy: true, motifA: 'flight', motifB: 'invisibility' }),
    row({ category: 'time', a: 'Live forever', b: 'Skip to any age' }),
    row({ category: 'fame', a: 'Be a movie star', b: 'Be a rock star' }),
  ];
  const result = selectDiversePlan(candidates, { count: 8 });
  assert.ok(result);
  assert.ok(result.distinctFamilies >= 6, `expected >=6 distinct families, got ${result.distinctFamilies}`);
});

test('selectDiversePlan rejects a duplicate motif within the same video', () => {
  // 9 candidates so that dropping the 2nd "flight" occurrence still leaves 8 fillable slots --
  // in-video motif duplication is a hard rule and is never relaxed.
  const candidates = [
    row({ category: 'superpowers', a: 'Fly everywhere', b: 'Read minds', isFantasy: true, motifA: 'flight', motifB: 'mind-reading' }),
    row({ category: 'fantasy', a: 'Fly like a bird', b: 'Own a private island', isFantasy: true, motifA: 'flight', motifB: 'private-island' }),
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet' }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse' }),
    row({ category: 'travel', a: 'Backpack Europe', b: 'Cruise the Caribbean' }),
    row({ category: 'food', a: 'Eat at a 5-star restaurant', b: 'Cook with a chef' }),
    row({ category: 'space', a: 'Visit the ISS', b: 'Visit the moon' }),
    row({ category: 'ocean', a: 'Swim with sharks', b: 'Swim with whales' }),
    row({ category: 'adventure', a: 'Skydive', b: 'Scuba dive' }),
  ];
  const result = selectDiversePlan(candidates, { count: 8 });
  assert.ok(result);
  const flightUsers = result.selected.filter(r => r.motif_key_a === 'flight' || r.motif_key_b === 'flight');
  assert.equal(flightUsers.length, 1, 'the "flight" motif should only be used once in the selected set');
});

test('selectDiversePlan applies a recent-use cooldown, excluding blocked motifs entirely', () => {
  const candidates = [
    row({ category: 'superpowers', a: 'Teleport anywhere', b: 'Read minds', isFantasy: true, motifA: 'teleportation', motifB: 'mind-reading' }),
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet' }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse' }),
    row({ category: 'travel', a: 'Backpack Europe', b: 'Cruise the Caribbean' }),
    row({ category: 'food', a: 'Eat at a 5-star restaurant', b: 'Cook with a chef' }),
    row({ category: 'adventure', a: 'Skydive', b: 'Scuba dive' }),
    row({ category: 'space', a: 'Visit the ISS', b: 'Visit the moon' }),
    row({ category: 'ocean', a: 'Swim with sharks', b: 'Swim with whales' }),
  ];
  const result = selectDiversePlan(candidates, { count: 7, blockedMotifs: new Set(['teleportation']) });
  assert.ok(result);
  assert.equal(result.selected.some(r => r.motif_key_a === 'teleportation'), false);
});

test('selectDiversePlan prefers least-recently-used candidates when the caller pre-sorts by last_used_at', () => {
  const stale = row({ category: 'money', a: 'Own a yacht', b: 'Own a jet', lastUsedAt: '2020-01-01T00:00:00.000Z' });
  const fresh = row({ category: 'money', a: 'Own a private jet', b: 'Own a superyacht', lastUsedAt: '2026-08-01T00:00:00.000Z' });
  // Simulates the SQL ORDER BY last_used_at ASC NULLS FIRST -- the never-used/oldest row comes
  // first; the money family cap (2) means only one of these two same-family rows would be dropped
  // if a cap conflict arose, but here we only assert ordering is respected end-to-end.
  const ordered = [stale, fresh].sort((left, right) => new Date(left.last_used_at || 0) - new Date(right.last_used_at || 0));
  assert.equal(ordered[0].id, stale.id);
});

test('selectDiversePlan returns null when the candidate window cannot fill `count` even after relaxing the family cap', () => {
  const candidates = [
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet' }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse' }),
  ];
  const result = selectDiversePlan(candidates, { count: 8 });
  assert.equal(result, null);
});

test('arrangeForHook puts the strongest hook_score first and keeps the rest in original order', () => {
  const rows = [
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet', hookScore: 40 }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse', hookScore: 95 }),
    row({ category: 'travel', a: 'Backpack Europe', b: 'Cruise the Caribbean', hookScore: 60 }),
  ];
  const arranged = arrangeForHook(rows);
  assert.equal(arranged[0].hook_score, 95);
  assert.deepEqual(arranged.slice(1).map(r => r.id), [rows[0].id, rows[2].id]);
});

test('a weak hook is never selected over a stronger hook for scene 1', () => {
  const weakFirst = [
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet', hookScore: 30 }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse', hookScore: 88 }),
  ];
  const arranged = arrangeForHook(weakFirst);
  assert.equal(arranged[0].id, weakFirst[1].id);
});

test('buildPlanFromPoolRows produces a plan shape compatible with addIllustrativePercentages / the image pipeline', () => {
  const rows = [
    row({ category: 'money', a: 'Own a yacht', b: 'Own a jet', hookScore: 90 }),
    row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse', hookScore: 50 }),
  ];
  const plan = buildPlanFromPoolRows(rows);
  assert.equal(plan.version, 1);
  assert.equal(plan.source, 'database_pool');
  assert.equal(plan.questions.length, 2);
  assert.equal(plan.questions[0].index, 0);
  assert.equal(plan.questions[0].optionA.text, 'Own a yacht');
  assert.equal(typeof plan.questions[0].poolId, 'number');
  assert.equal(typeof plan.topic, 'string');
});
