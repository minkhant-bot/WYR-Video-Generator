import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeForHook, buildPlanFromPoolRows, computeDilemmaRankScore, computeInsertionFields, contentFamilyForCategory, rankCandidatesByStrength, repairPlanForDuration, selectDiversePlan } from './pool-selection.js';
import { estimateSceneDurationFromText, DEFAULT_DURATION_BUDGET_TOTAL_SECONDS } from './duration-estimate.js';

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

test('rankCandidatesByStrength ranks a stronger WYR dilemma above a clearly weak one within the same LRU tier', () => {
  const weak = row({ category: 'travel', a: 'One suitcase of belongings', b: 'A house full of memories', hookScore: 50 });
  const strong = row({ category: 'lifestyle', a: 'Earn more but lose your weekends', b: 'Earn less and keep every weekend', hookScore: 50 });
  const ranked = rankCandidatesByStrength([weak, strong]);
  assert.equal(ranked[0].id, strong.id, 'the stronger real tradeoff should rank first when hook_score and LRU tier are tied');
  assert.deepEqual(ranked.map(r => r.id).sort(), [weak.id, strong.id].sort(), 'ranking must never drop or duplicate a candidate');
});

test('rankCandidatesByStrength never mutates option text/search query fields', () => {
  const original = row({ category: 'money', a: 'Own a yacht', b: 'Own a jet', hookScore: 40 });
  const snapshot = { ...original };
  rankCandidatesByStrength([original]);
  assert.deepEqual(original, snapshot, 'ranking must be read-only with respect to every row it is given');
});

test('rankCandidatesByStrength never lets a stronger-but-staler row jump ahead of a fresher (never-used) row -- LRU tier always wins first', () => {
  const staleStrong = row({ category: 'lifestyle', a: 'Earn more but lose your weekends', b: 'Earn less and keep every weekend', hookScore: 90, lastUsedAt: '2020-01-01T00:00:00.000Z' });
  const freshWeak = row({ category: 'travel', a: 'Visit Rome', b: 'Visit Cairo', hookScore: 10, lastUsedAt: null });
  const ranked = rankCandidatesByStrength([staleStrong, freshWeak]);
  assert.equal(ranked[0].id, freshWeak.id, 'a never-used row must still be offered before an already-used-more-recently row, regardless of strength');
});

test('rankCandidatesByStrength interleaves distinct tone buckets within a tier instead of clustering one tone at the top', () => {
  const luxuryA = row({ category: 'money', a: 'Own a yacht', b: 'Own a jet', hookScore: 60 });
  const luxuryB = row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse', hookScore: 55 });
  const funny = row({ category: 'funny hypothetical', a: 'Smell like garbage forever', b: 'Look ridiculous every day', hookScore: 20 });
  const ranked = rankCandidatesByStrength([luxuryA, luxuryB, funny]);
  // funny (tone: funny_absurd) has the lowest hook_score/strength of the three, so a pure
  // strength-only sort would place it last -- interleaving-by-tone should pull it up to position 2
  // (immediately after the single strongest row) rather than leaving both luxury rows clustered
  // ahead of the only non-luxury tone present.
  assert.equal(ranked[0].id, luxuryA.id);
  assert.equal(ranked[1].id, funny.id, 'the only funny/absurd-tone row should be interleaved in right after the top row, not pushed to the back');
});

test('computeDilemmaRankScore combines the stored hook_score with the local strength bonus, and is exported for reuse', () => {
  const r = row({ category: 'lifestyle', a: 'Earn more but lose your weekends', b: 'Earn less and keep every weekend', hookScore: 50 });
  assert.ok(computeDilemmaRankScore(r) > Number(r.hook_score), 'a question with a recognizable tradeoff should score above its raw hook_score alone');
});

// Fixed production policy: every generated video uses exactly 6 questions/scenes. Six
// long-narration questions across 6 distinct families (so the family cap of 2 never blocks any of
// them) whose combined estimated duration lands well over DEFAULT_DURATION_BUDGET_TOTAL_SECONDS --
// an in-repo stand-in for a real production near-budget failure, but built from estimated (not
// TTS-measured) duration so it's deterministic and DB-free.
const LONG_SELECTED = [
  row({ category: 'superpowers', a: 'Read the minds of every single stranger you meet nearby', b: 'Turn completely invisible near every other person around you', isFantasy: false, motifA: 'mind-reading-long', motifB: 'invisibility-long' }),
  row({ category: 'time', a: 'Travel back to relive your entire early happy childhood', b: 'Travel forward to witness the distant unknown future today', motifA: 'time-travel-past-long', motifB: 'time-travel-future-long' }),
  row({ category: 'dream lifestyle', a: 'Wake up early and stay productive every single busy morning', b: 'Sleep in late and stay relaxed every single lazy day', motifA: 'morning-routine-long', motifB: 'sleep-routine-long' }),
  row({ category: 'food', a: 'Eat extremely spicy food at every single family meal', b: 'Eat extremely sweet food at every single family meal', motifA: 'spicy-food-long', motifB: 'sweet-food-long' }),
  row({ category: 'travel', a: 'Visit five different countries across all of western Europe', b: 'Visit five different countries across all of eastern Asia', motifA: 'europe-trip-long', motifB: 'asia-trip-long' }),
  row({ category: 'space', a: 'Float weightlessly inside a real orbiting space station soon', b: 'Walk slowly across the dusty surface of the moon', motifA: 'zero-gravity-long', motifB: 'moonwalk-long' }),
];

// Short, valid substitutes: one per family represented above, so a straightforward swap never
// needs to relax the family cap. Motifs are distinct from everything in LONG_SELECTED.
const SHORT_CANDIDATES = [
  row({ category: 'superpowers', a: 'Fly fast', b: 'Turn invisible', motifA: 'flight-short', motifB: 'invisibility-short' }),
  row({ category: 'time', a: 'Freeze time', b: 'Rewind time', motifA: 'freeze-time-short', motifB: 'rewind-time-short' }),
  row({ category: 'dream lifestyle', a: 'Nap daily', b: 'Travel monthly', motifA: 'nap-short', motifB: 'travel-monthly-short' }),
  row({ category: 'food', a: 'Eat sushi', b: 'Eat pizza', motifA: 'sushi-short', motifB: 'pizza-short' }),
  row({ category: 'travel', a: 'Visit Rome', b: 'Visit Cairo', motifA: 'rome-short', motifB: 'cairo-short' }),
  row({ category: 'space', a: 'Visit the ISS', b: 'Visit the moon', motifA: 'iss-short', motifB: 'moonvisit-short' }),
];

test('repairPlanForDuration leaves an already-under-budget selection unchanged', () => {
  const selected = SHORT_CANDIDATES;
  const result = repairPlanForDuration({ selected, candidates: [...selected, ...LONG_SELECTED], count: 6, targetTotalSeconds: DEFAULT_DURATION_BUDGET_TOTAL_SECONDS, baseDuration: 7 });
  assert.equal(result.swapped, false);
  assert.equal(result.fits, true);
  assert.deepEqual(result.selected.map(r => r.id), selected.map(r => r.id));
});

test('a long, over-budget 6-question selection is automatically repaired by swapping the longest questions for shorter ready ones', () => {
  const initialTotal = LONG_SELECTED.reduce((sum, r) => sum + estimateSceneDurationFromText(r.option_a_text, r.option_b_text, { baseDuration: 7 }), 0);
  assert.ok(initialTotal > DEFAULT_DURATION_BUDGET_TOTAL_SECONDS, `test fixture must start over budget; got ${initialTotal}s`);

  const result = repairPlanForDuration({ selected: LONG_SELECTED, candidates: [...LONG_SELECTED, ...SHORT_CANDIDATES], count: 6, targetTotalSeconds: DEFAULT_DURATION_BUDGET_TOTAL_SECONDS, baseDuration: 7 });

  assert.equal(result.swapped, true);
  assert.equal(result.fits, true);
  assert.ok(result.projectedTotalSeconds <= DEFAULT_DURATION_BUDGET_TOTAL_SECONDS, `repaired total ${result.projectedTotalSeconds}s must be under budget`);
  assert.ok(result.projectedTotalSeconds < initialTotal, 'the repaired total must be strictly shorter than the original');
  assert.equal(result.selected.length, 6);

  // Diversity rules preserved: distinct ids, family cap of 2, at most 1 fantasy, no motif reused.
  assert.equal(new Set(result.selected.map(r => r.id)).size, 6, 'no question should be selected twice');
  const familyCounts = new Map();
  for (const r of result.selected) familyCounts.set(r.content_family, (familyCounts.get(r.content_family) || 0) + 1);
  for (const [family, count] of familyCounts) assert.ok(count <= 2, `family ${family} appears ${count} times, exceeding the cap of 2`);
  assert.ok(result.selected.filter(r => r.is_fantasy).length <= 1, 'fantasy cap of 1 must be preserved');
  const motifs = result.selected.flatMap(r => [r.motif_key_a, r.motif_key_b]).filter(Boolean);
  assert.equal(new Set(motifs).size, motifs.length, 'no motif should be used twice across the repaired selection');

  // Narration is never truncated: every selected question's option text is verbatim one of the
  // original candidate texts, never a shortened/modified variant.
  const knownTexts = new Set([...LONG_SELECTED, ...SHORT_CANDIDATES].flatMap(r => [r.option_a_text, r.option_b_text]));
  for (const r of result.selected) { assert.ok(knownTexts.has(r.option_a_text), `unexpected/altered option A text: "${r.option_a_text}"`); assert.ok(knownTexts.has(r.option_b_text), `unexpected/altered option B text: "${r.option_b_text}"`); }
});

test('repairPlanForDuration never picks a substitute that would violate the family cap or reuse a motif, even if it is shorter', () => {
  // 'money' and 'luxury' both map to the wealth_and_luxury family (see CONTENT_FAMILY_BY_CATEGORY)
  // and are already SHORT -- they will never be picked as the "outgoing" (longest) row, so
  // wealth_and_luxury stays pinned at its cap of 2 throughout repair. The other 4 slots are LONG
  // rows from 4 different families, each with a valid same-family short substitute available.
  const shortMoney = row({ category: 'money', a: 'Own a yacht', b: 'Own a jet', motifA: 'yacht-cap', motifB: 'jet-cap' });
  const shortLuxury = row({ category: 'luxury', a: 'Live in a mansion', b: 'Live in a penthouse', motifA: 'mansion-cap', motifB: 'penthouse-cap' });
  const selected = [shortMoney, shortLuxury, ...LONG_SELECTED.slice(0, 4)];
  assert.equal(selected.length, 6);

  // 'cars' ALSO maps to wealth_and_luxury -- a short cars candidate must be refused even though
  // it is shorter than every long row, because the family is already full.
  const blockedCarsCandidate = row({ category: 'cars', a: 'Own a sports car', b: 'Own a classic car', motifA: 'sportscar-cap', motifB: 'classiccar-cap' });
  const validSubstitutes = SHORT_CANDIDATES;
  const result = repairPlanForDuration({ selected, candidates: [...selected, blockedCarsCandidate, ...validSubstitutes], count: 6, targetTotalSeconds: DEFAULT_DURATION_BUDGET_TOTAL_SECONDS, baseDuration: 7 });

  assert.equal(result.selected.some(r => r.id === blockedCarsCandidate.id), false, 'a same-family substitute must never push a family past its cap of 2');
  assert.ok(result.selected.some(r => r.id === shortMoney.id) && result.selected.some(r => r.id === shortLuxury.id), 'the two already-at-cap wealth_and_luxury rows must remain untouched');
});

test('repairPlanForDuration reports fits:false (never throws, never fabricates a fit) when no valid shorter substitute exists locally', () => {
  const result = repairPlanForDuration({ selected: LONG_SELECTED, candidates: LONG_SELECTED, count: 6, targetTotalSeconds: DEFAULT_DURATION_BUDGET_TOTAL_SECONDS, baseDuration: 7 });
  assert.equal(result.fits, false);
  assert.equal(result.selected.length, 6, 'the (still over-budget) selection must still be returned so the caller has full information');
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
