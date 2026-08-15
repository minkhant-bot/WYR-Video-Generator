import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { insertQuestions, selectAndReservePlan, selectPlanForJob, countReady, DurationBudgetExceededError } from './question-pool.js';
import { selectContentPlan } from './content-source.js';
import { estimateSceneDurationFromText, DEFAULT_DURATION_BUDGET_TOTAL_SECONDS } from './duration-estimate.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

const question = (category, a, aq, b, bq) => ({ category, optionA: { text: a, searchQuery: aq }, optionB: { text: b, searchQuery: bq } });

// Eight long-narration questions, one per distinct content family, whose combined ESTIMATED
// duration reproduces the production "61.933s" class of failure -- long enough to clear the
// budget target, short enough to still pass computeInsertionFields' own quality gate.
const LONG_QUESTIONS = [
  question('superpowers', 'Read the minds of every single stranger nearby', 'telepathy mind reading glow', 'Turn completely invisible near every other person', 'invisible person disappearing'),
  question('time', 'Travel back to relive your entire early childhood', 'child playing park sunny', 'Travel forward to witness the distant unknown future', 'futuristic city scene glowing'),
  question('dream lifestyle', 'Wake up early and productive every single morning', 'sunrise desk productive morning', 'Sleep in late and relaxed every single day', 'person sleeping bed morning'),
  question('food', 'Eat wildly spicy curry for every single meal', 'spicy curry bowl closeup', 'Bake sweet pastries for every big family gathering', 'sweet pastries bakery display'),
  question('travel', 'Backpack through five bustling cities across Europe', 'backpacker european street cobblestone', 'Sail through six remote tropical islands near Asia', 'tropical islands ocean boat'),
  question('space', 'Float weightlessly inside a real orbiting spacecraft', 'astronaut floating zero gravity', 'Walk slowly across the surface of the moon', 'moon surface astronaut walking'),
  question('survival-lite', 'Build a small shelter alone deep in a forest', 'wooden shelter forest survival', 'Start a warm fire alone without any matches', 'campfire sparks flint survival'),
  question('money', 'Own a small private island somewhere in the Pacific', 'private island aerial view', 'Own a tall penthouse somewhere in a big city', 'penthouse city skyline view'),
];

// A short, valid substitute for each family above.
const SHORT_QUESTIONS = [
  question('superpowers', 'Fly fast', 'person flying sky superhero', 'Turn invisible', 'invisible person disappearing'),
  question('time', 'Meet your future self', 'two people mirror reflection', 'Meet your past self', 'old photo young person'),
  question('dream lifestyle', 'Nap daily', 'person napping hammock outdoors', 'Travel monthly', 'suitcase airport terminal walking'),
  question('food', 'Eat sushi', 'sushi platter chopsticks closeup', 'Eat pizza', 'pizza slice cheese closeup'),
  question('travel', 'Visit Rome', 'rome colosseum ancient ruins', 'Visit Cairo', 'cairo pyramids desert view'),
  question('space', 'Visit the ISS', 'international space station interior', 'Visit the moon', 'moon surface astronaut footprint'),
  question('survival-lite', 'Start a fire', 'campfire sparks flint survival', 'Find fresh water', 'wild stream fresh water'),
  question('money', 'Own a yacht', 'luxury yacht ocean deck', 'Own a jet', 'private jet runway interior'),
];

// Forces the fake DB's LRU ordering (last_used_at ASC NULLS FIRST, used_count ASC, hook_score
// DESC, id ASC) to place `rows` before every other ready row, by giving them the lowest
// used_count -- exactly mirroring what a freshly-seeded, never-used batch looks like relative to
// slightly-more-rotated rows, without needing real timestamps.
const markFreshest = (fake, texts, usedCount) => {
  for (const row of fake.state.questions.values()) if (texts.has(row.option_a_text)) row.used_count = usedCount;
};

test('a long, over-budget 8-question DB selection is automatically repaired in place, stays under budget, and never calls Groq', () => withFakeDb(async fake => {
  await insertQuestions(LONG_QUESTIONS);
  await insertQuestions(SHORT_QUESTIONS);
  markFreshest(fake, new Set(LONG_QUESTIONS.map(q => q.optionA.text)), 0);
  markFreshest(fake, new Set(SHORT_QUESTIONS.map(q => q.optionA.text)), 1);

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('duration repair must never call Groq or any network API'); };
  try {
    const reservation = await selectAndReservePlan({ jobId: 'job-repair-1', count: 8 });
    assert.ok(reservation, 'expected a successful reservation after local duration repair');
    assert.equal(reservation.selected.length, 8);
    assert.equal(fetchCalled, false, 'no Groq/network call should ever occur during duration repair');

    const projectedTotal = reservation.selected.reduce((sum, row) => sum + estimateSceneDurationFromText(row.option_a_text, row.option_b_text), 0);
    assert.ok(projectedTotal <= DEFAULT_DURATION_BUDGET_TOTAL_SECONDS, `repaired total ${projectedTotal}s must be under the ${DEFAULT_DURATION_BUDGET_TOTAL_SECONDS}s budget`);

    // Diversity rules preserved.
    const familyCounts = new Map();
    for (const row of reservation.selected) familyCounts.set(row.content_family, (familyCounts.get(row.content_family) || 0) + 1);
    for (const [family, count] of familyCounts) assert.ok(count <= 2, `family ${family} appears ${count} times`);
    assert.ok(reservation.selected.filter(row => row.is_fantasy).length <= 1);
    const motifs = reservation.selected.flatMap(row => [row.motif_key_a, row.motif_key_b]).filter(Boolean);
    assert.equal(new Set(motifs).size, motifs.length, 'no motif should be reused across the repaired selection');

    // Narration is never truncated: every selected option's text is verbatim one of the known
    // long/short candidate texts -- never a shortened or altered string.
    const knownTexts = new Set([...LONG_QUESTIONS, ...SHORT_QUESTIONS].flatMap(q => [q.optionA.text, q.optionB.text]));
    for (const row of reservation.selected) { assert.ok(knownTexts.has(row.option_a_text)); assert.ok(knownTexts.has(row.option_b_text)); }
  } finally { globalThis.fetch = originalFetch; }
}));

test('Scene 1 is the strongest hook among the POST-repair 8, not whichever question happened to be selected first', () => withFakeDb(async fake => {
  await insertQuestions(LONG_QUESTIONS);
  await insertQuestions(SHORT_QUESTIONS);
  markFreshest(fake, new Set(LONG_QUESTIONS.map(q => q.optionA.text)), 0);
  markFreshest(fake, new Set(SHORT_QUESTIONS.map(q => q.optionA.text)), 1);

  const plan = await selectPlanForJob({ jobId: 'job-repair-hook', count: 8 });
  assert.ok(plan);
  assert.equal(plan.questions.length, 8);

  // Recover the real, DB-stored hook_score for every question actually in the final plan (i.e.
  // the post-repair set) and confirm Scene 1 (index 0) is the one with the highest hook_score
  // among THOSE 8 -- not merely the highest among the original pre-repair 8, which duration repair
  // may have partly swapped out.
  const byText = new Map([...fake.state.questions.values()].map(row => [row.option_a_text, row]));
  const finalRows = plan.questions.map(q => byText.get(q.optionA.text));
  assert.ok(finalRows.every(Boolean), 'every plan question must be traceable back to a real pool row');

  // At least one SHORT (post-repair, higher-hook-scoring) question must have made it into the
  // final plan -- otherwise this test would not actually be exercising post-repair re-ranking.
  const shortTexts = new Set(SHORT_QUESTIONS.map(q => q.optionA.text));
  assert.ok(finalRows.some(row => shortTexts.has(row.option_a_text)), 'expected duration repair to have swapped in at least one short question');

  const highestHookScore = Math.max(...finalRows.map(row => Number(row.hook_score)));
  const scene1Row = byText.get(plan.questions[0].optionA.text);
  assert.equal(Number(scene1Row.hook_score), highestHookScore, 'Scene 1 must carry the highest hook_score among the final, post-repair 8 questions');
}));

test('when no valid local substitute exists at all, selectAndReservePlan throws DurationBudgetExceededError (not CONTENT_POOL_EMPTY) and reserves nothing', () => withFakeDb(async fake => {
  await insertQuestions(LONG_QUESTIONS); // no short alternatives seeded at all
  markFreshest(fake, new Set(LONG_QUESTIONS.map(q => q.optionA.text)), 0);

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not call Groq'); };
  try {
    await assert.rejects(() => selectAndReservePlan({ jobId: 'job-repair-2', count: 8 }), error => {
      assert.ok(error instanceof DurationBudgetExceededError);
      assert.equal(error.code, 'DURATION_BUDGET_EXCEEDED');
      return true;
    });
    assert.equal(fetchCalled, false, 'a duration-budget failure must never trigger a Groq call');
    assert.equal(await countReady(), LONG_QUESTIONS.length, 'a failed duration repair must leave every question ready, none stuck reserved');
  } finally { globalThis.fetch = originalFetch; }
}));

test('selectContentPlan (the normal video-generation entry point) propagates a duration-budget failure without ever calling Groq, even when a Groq key is configured', () => withFakeDb(async fake => {
  await insertQuestions(LONG_QUESTIONS);
  markFreshest(fake, new Set(LONG_QUESTIONS.map(q => q.optionA.text)), 0);

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not call Groq'); };
  try {
    const config = { questionCount: 8, groqApiKey: 'test-key', groqModel: 'openai/gpt-oss-20b', timeoutMs: 1000, poolTarget: 10, poolLowWaterMark: 100, poolEmergencyRefillMaxBatches: 1, secondsPerQuestion: 7 };
    await assert.rejects(() => selectContentPlan({ job: { id: 'job-repair-3' }, config }), error => {
      assert.equal(error.code, 'DURATION_BUDGET_EXCEEDED');
      return true;
    });
    assert.equal(fetchCalled, false, 'a duration-budget failure must never fall back to the Groq emergency-refill path');
  } finally { globalThis.fetch = originalFetch; }
}));
