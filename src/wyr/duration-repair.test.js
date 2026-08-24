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

// Eight long-narration food questions whose combined ESTIMATED
// duration reproduces the production "61.933s" class of failure -- long enough to clear the
// budget target, short enough to still pass computeInsertionFields' own quality gate.
const LONG_QUESTIONS = [
  question('food', 'Dark Chocolate Fudge Nut Cream Layer Cake', 'chocolate layer cake photo', 'Salted Caramel Peanut Butter Fudge Chip Brownies', 'caramel fudge brownies photo'),
  question('food', 'Crispy Garlic Herb Parmesan Fried Chicken Wings', 'garlic parmesan wings photo', 'Smoky BBQ Bacon Cheddar Pulled Chicken Sandwich', 'pulled chicken sandwich photo'),
  question('food', 'Berry Cream Cheese Stuffed Brioche French Toast', 'stuffed french toast photo', 'Lemon Ricotta Berry Maple Syrup Stack Pancakes', 'lemon ricotta pancakes photo'),
  question('food', 'Tomato Basil Mozzarella Pepperoni Deep Dish Pizza', 'deep dish pizza photo', 'Tuna Avocado Tempura Shrimp Dragon Sushi Rolls', 'dragon sushi rolls photo'),
  question('food', 'Dark Chocolate Raspberry Vanilla Cream Layer Cake', 'raspberry layer cake photo', 'Caramel Pecan Cinnamon Chocolate Swirl Cream Cheesecake', 'caramel pecan cheesecake photo'),
  question('food', 'Black Truffle Wild Mushroom Garlic Parmesan Risotto', 'mushroom parmesan risotto photo', 'Roasted Garlic Butter Lobster Spinach Cheese Ravioli', 'lobster spinach ravioli photo'),
  question('food', 'Loaded Bacon Cheddar Jalapeno Sour Cream Fries', 'loaded bacon fries photo', 'Crispy Buffalo Chicken Cheese Guacamole Tray Nachos', 'buffalo chicken nachos photo'),
  question('food', 'Peanut Butter Dark Chocolate Chip Oatmeal Cookies', 'chocolate oatmeal cookies photo', 'Salted Caramel Fudge Brownie Vanilla Ice Cream', 'caramel brownie ice cream'),
];

// A short, valid food substitute for each long row above.
const SHORT_QUESTIONS = [
  question('food', 'Pizza', 'pizza food photo', 'Sushi', 'sushi food photo'),
  question('food', 'Pancakes', 'pancakes food photo', 'Waffles', 'waffles food photo'),
  question('food', 'Cheesecake', 'cheesecake food photo', 'Tiramisu', 'tiramisu food photo'),
  question('food', 'Onion Rings', 'onion rings photo', 'Mozzarella Sticks', 'mozzarella sticks photo'),
  question('food', 'French Toast', 'french toast photo', 'Cinnamon Roll', 'cinnamon roll photo'),
  question('food', 'Chicken Wings', 'chicken wings photo', 'Nachos', 'nachos food photo'),
  question('food', 'Ice Cream', 'ice cream photo', 'Brownies', 'brownies food photo'),
  question('food', 'Tacos', 'tacos food photo', 'Burritos', 'burritos food photo'),
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

    // Food-only selection still preserves the hard motif/fantasy rules. The existing selector's
    // soft family cap necessarily relaxes because every food row has the same content family.
    assert.equal(reservation.selected.every(row => row.category === 'food'), true);
    assert.deepEqual([...new Set(reservation.selected.map(row => row.content_family))], ['food_and_social']);
    assert.ok(reservation.selected.filter(row => row.is_fantasy).length <= 1);
    const motifs = reservation.selected.flatMap(row => [row.motif_key_a, row.motif_key_b]).filter(Boolean);
    assert.equal(new Set(motifs).size, motifs.length, 'no motif should be reused across the repaired selection');

    // Narration is never truncated: every selected option's text is verbatim one of the known
    // long/short candidate texts -- never a shortened or altered string.
    const knownTexts = new Set([...LONG_QUESTIONS, ...SHORT_QUESTIONS].flatMap(q => [q.optionA.text, q.optionB.text]));
    for (const row of reservation.selected) { assert.ok(knownTexts.has(row.option_a_text)); assert.ok(knownTexts.has(row.option_b_text)); }
  } finally { globalThis.fetch = originalFetch; }
}));

test('Scene 1 is the highest raw hook_score food matchup among the POST-repair 8', () => withFakeDb(async fake => {
  await insertQuestions(LONG_QUESTIONS);
  await insertQuestions(SHORT_QUESTIONS);
  markFreshest(fake, new Set(LONG_QUESTIONS.map(q => q.optionA.text)), 0);
  markFreshest(fake, new Set(SHORT_QUESTIONS.map(q => q.optionA.text)), 1);

  const plan = await selectPlanForJob({ jobId: 'job-repair-hook', count: 8 });
  assert.ok(plan);
  assert.equal(plan.questions.length, 8);

  // Recover the real DB rows for the final, post-repair set. arrangeForHook deliberately uses raw
  // hook_score for the strongest food opener; candidate-window ranking remains unchanged.
  const byText = new Map([...fake.state.questions.values()].map(row => [row.option_a_text, row]));
  const finalRows = plan.questions.map(q => byText.get(q.optionA.text));
  assert.ok(finalRows.every(Boolean), 'every plan question must be traceable back to a real pool row');

  // At least one SHORT (post-repair, higher-hook-scoring) question must have made it into the
  // final plan -- otherwise this test would not actually be exercising post-repair re-ranking.
  const shortTexts = new Set(SHORT_QUESTIONS.map(q => q.optionA.text));
  assert.ok(finalRows.some(row => shortTexts.has(row.option_a_text)), 'expected duration repair to have swapped in at least one short question');

  const highestHookScore = Math.max(...finalRows.map(row => Number(row.hook_score)));
  const scene1Row = byText.get(plan.questions[0].optionA.text);
  assert.equal(Number(scene1Row.hook_score), highestHookScore);
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
