// Focused, DB-shaped tests for the 10-question pacing test's production selection path: a single
// theme practically never has 10 ready rows on its own (30 of the 31 seeded themes have 9, one has
// 10 -- see food-themes.js), so selectAndReservePlan must merge in a second theme to reach `count`.
// Uses the same insertFoodTheme()/fake-DB pattern as food-theme-reconciliation.test.js (the real
// themed insertion path), unlike question-pool.test.js's older plain insertQuestions() fixtures,
// which predate the food-theme architecture and no longer produce selectable rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { buildPlanFromPoolRows, canonicalFoodPairKey } from './pool-selection.js';
import { commitPlanUsage, insertFoodTheme, selectAndReservePlan, selectPlanForJob } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); } finally { __resetPoolForTests(); }
};

const foodQuestion = (optionA, optionB) => ({
  category: 'food',
  optionA: { text: optionA, searchQuery: `${optionA} food photo` },
  optionB: { text: optionB, searchQuery: `${optionB} food photo` },
});

// Two independent 9-question themes (mirroring the real seed shape: no theme has >=10 on its own
// except one outlier), with no shared/near-duplicate pairs between them.
const BREAKFAST_THEME = {
  themeKey: 'test-breakfast', title: 'Test Breakfast', hookTtsText: 'Test breakfast.',
  questions: [
    foodQuestion('Orange', 'Banana'), foodQuestion('Croissant', 'Bagel'), foodQuestion('Bacon', 'Sausage'),
    foodQuestion('Frittata', 'Omelette'), foodQuestion('Pancakes', 'French Toast'), foodQuestion('Waffles', 'Cinnamon Roll'),
    foodQuestion('Cereal', 'Granola'), foodQuestion('Coffee', 'Smoothie'), foodQuestion('Muffin', 'Danish'),
  ],
};
const DESSERT_THEME = {
  themeKey: 'test-dessert', title: 'Test Dessert', hookTtsText: 'Test dessert.',
  questions: [
    foodQuestion('Ice Cream', 'Gelato'), foodQuestion('Brownies', 'Cookies'), foodQuestion('Cheesecake', 'Cannoli'),
    foodQuestion('Tiramisu', 'Baklava'), foodQuestion('Cupcake', 'Donut'), foodQuestion('Apple Pie', 'Banana Bread'),
    foodQuestion('Pudding', 'Custard'), foodQuestion('Macarons', 'Churros'), foodQuestion('Cobbler', 'Parfait'),
  ],
};

test('selectAndReservePlan reaches exactly 10 questions by merging a second theme when the primary theme only has 9 ready rows', () => withFakeDb(async () => {
  await insertFoodTheme(BREAKFAST_THEME);
  await insertFoodTheme(DESSERT_THEME);
  const reservation = await selectAndReservePlan({ jobId: 'job-10q', count: 10, targetTotalSeconds: 999 });
  assert.ok(reservation, 'a 10-question plan must be reachable from two 9-question themes');
  assert.equal(reservation.selected.length, 10);
  const themeKeysUsed = new Set(reservation.selected.map(row => row.theme_key));
  assert.ok(themeKeysUsed.size >= 2, 'reaching 10 from two 9-question themes requires drawing from both');
}));

test('a 10-question plan never contains an exact or reversed duplicate canonical pair', () => withFakeDb(async () => {
  await insertFoodTheme(BREAKFAST_THEME);
  await insertFoodTheme(DESSERT_THEME);
  const plan = await selectPlanForJob({ jobId: 'job-dedupe', count: 10, targetTotalSeconds: 999 });
  assert.ok(plan);
  assert.equal(plan.questions.length, 10);
  const pairKeys = plan.questions.map(q => canonicalFoodPairKey({ option_a_text: q.optionA.text, option_b_text: q.optionB.text }));
  assert.equal(new Set(pairKeys).size, 10, 'all 10 questions must be distinct canonical pairs');
}));

test('a 10-question plan orders Q1 as the strongest hook_score row in the selected set, not raw theme_position', () => withFakeDb(async () => {
  await insertFoodTheme(BREAKFAST_THEME);
  await insertFoodTheme(DESSERT_THEME);
  const reservation = await selectAndReservePlan({ jobId: 'job-order', count: 10, targetTotalSeconds: 999 });
  assert.ok(reservation);
  const plan = buildPlanFromPoolRows(reservation.selected);
  const byId = new Map(reservation.selected.map(row => [row.id, row]));
  const maxHookScore = Math.max(...reservation.selected.map(row => Number(row.hook_score)));
  const q1Row = byId.get(plan.questions[0].poolId);
  assert.equal(Number(q1Row.hook_score), maxHookScore, 'Q1 must be the strongest hook_score row in the selected set, regardless of which theme/position it came from');
  assert.ok(['test-breakfast', 'test-dessert'].includes(plan.hook.themeKey), 'the hook theme must be derived from whichever row actually leads');
}));

test('used/history rows remain protected: a question already committed in a prior video is never reselected into a later 10-question plan', () => withFakeDb(async fake => {
  await insertFoodTheme(BREAKFAST_THEME);
  await insertFoodTheme(DESSERT_THEME);
  const firstPlan = await selectPlanForJob({ jobId: 'job-first', count: 10, targetTotalSeconds: 999 });
  assert.ok(firstPlan);
  await commitPlanUsage({ jobId: 'job-first', plan: firstPlan, duration: 44 });
  const usedIds = new Set(firstPlan.questions.map(q => q.poolId));
  for (const id of usedIds) assert.equal(fake.state.questions.get(id).status, 'used');

  // Only 8 ready rows remain (18 seeded - 10 committed) -- not enough for a second 10-question plan.
  // Per the pre-existing selectAndReservePlan contract (unchanged by this change), a themed pool
  // that has SOME but not enough ready rows throws DurationBudgetExceededError rather than
  // returning null (null is reserved for "no eligible themed rows at all") -- the important
  // guarantee under test here is that this failed attempt never reaches back into the already-'used'
  // rows to make up the count.
  await assert.rejects(() => selectAndReservePlan({ jobId: 'job-second', count: 10 }), { code: 'DURATION_BUDGET_EXCEEDED' });
  for (const id of usedIds) assert.equal(fake.state.questions.get(id).status, 'used', 'a used row must never revert to ready/reserved by a later selection attempt');
}));
