import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { FOOD_THEME_SEEDS, canonicalFoodThemeKey } from './food-themes.js';
import { questionMotifs } from './content-engine.js';
import { rowToQuestion } from './pool-selection.js';
import { commitPlanUsage, insertFoodTheme, insertQuestions, releaseQuestionReservation, reserveReplacementQuestion, selectPlanForJob } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb(); __setPoolForTests(fake.pool);
  try { await operation(fake); } finally { __resetPoolForTests(); }
};
const foodQuestion = (optionA, optionB) => ({
  category: 'food',
  optionA: { text: optionA, searchQuery: `${optionA} food photo` },
  optionB: { text: optionB, searchQuery: `${optionB} food photo` },
});

test('canonical theme keys collapse near-duplicate presentation wording', () => {
  assert.equal(canonicalFoodThemeKey('Build Your Breakfast'), canonicalFoodThemeKey('Build Your Ultimate Breakfast'));
});

test('DB-first selection reserves ten questions (merging themes when one theme is not enough) and rotates after commit', () => withFakeDb(async () => {
  // FOOD_THEME_SEEDS[0] ("Build Your Breakfast") is the one seeded theme with exactly 10
  // questions, so job 1 can be satisfied from that single theme alone; the other two seeded here
  // have 9 each, so job 2 (after breakfast is fully consumed) must merge across both of them to
  // reach 10 -- see question-pool.js's selectAndReservePlan cross-theme merge.
  for (const theme of FOOD_THEME_SEEDS.slice(0, 3)) {
    const result = await insertFoodTheme(theme);
    assert.ok(result.inserted >= 9);
  }
  assert.equal((await insertFoodTheme({ ...FOOD_THEME_SEEDS[0], title: 'Build Your Ultimate Breakfast' })).skipped, true);
  const first = await selectPlanForJob({ jobId: 'theme-job-1', count: 10, targetTotalSeconds: 999 });
  assert.equal(first.questions.length, 10);
  assert.equal(first.hook.themeKey, FOOD_THEME_SEEDS[0].themeKey, 'the single 10-question theme should satisfy the plan alone, needing no merge');
  assert.equal(first.questions.every(question => question.category === 'food'), true);
  await commitPlanUsage({ jobId: 'theme-job-1', plan: first, duration: 45 });
  const second = await selectPlanForJob({ jobId: 'theme-job-2', count: 10, targetTotalSeconds: 999 });
  assert.equal(second.questions.length, 10);
  assert.notEqual(second.hook.themeKey, first.hook.themeKey);
  assert.ok([FOOD_THEME_SEEDS[1].themeKey, FOOD_THEME_SEEDS[2].themeKey].includes(second.hook.themeKey), 'the second plan must merge from the two remaining 9-question themes');
}));

test('theme seeding reconciles unthemed duplicates and safely skips cross-theme collisions', () => withFakeDb(async fake => {
  const seed = FOOD_THEME_SEEDS[0];
  await insertQuestions([seed.questions[0]]);
  const preexisting = await insertFoodTheme(seed);
  assert.equal(preexisting.reconciled, 1);
  assert.ok(preexisting.inserted >= 6);
  const conflictTheme = { ...FOOD_THEME_SEEDS[1], title: 'Collision-safe dessert', questions: [seed.questions[0], ...FOOD_THEME_SEEDS[1].questions.slice(1)] };
  const result = await insertFoodTheme(conflictTheme);
  assert.ok(result.rejected.length >= 1);
  assert.ok(fake.state.themes.size >= 2);
}));

test('usage commit rejects anything other than exactly ten reserved questions before creating a completed video', () => withFakeDb(async fake => {
  await insertFoodTheme(FOOD_THEME_SEEDS[0]); // the one 10-question seeded theme
  const plan = await selectPlanForJob({ jobId: 'partial-commit', count: 10, targetTotalSeconds: 999 });
  const missing = fake.state.questions.get(plan.questions[0].poolId);
  missing.status = 'ready'; missing.reserved_by_job = null;
  await assert.rejects(() => commitPlanUsage({ jobId: 'partial-commit', plan, duration: 45 }), /found 9 of 10 reserved questions/);
  assert.equal(fake.state.videos.size, 0);
  assert.equal([...fake.state.questions.values()].filter(row => row.status === 'used').length, 0);
}));

test('usage commit records the exact ten final questions after replacement', () => withFakeDb(async fake => {
  // reserveReplacementQuestion is scoped to the SAME theme as the row it replaces (see
  // question-pool.js's same-theme-only WHERE clause), so this theme needs one spare ready row
  // beyond the 10 the plan itself reserves -- the seeded "Build Your Breakfast" theme has exactly
  // 10, so an extra synthetic 11th pair is appended here purely to give the replacement a same-theme
  // candidate to find, mirroring how a real theme with more than `count` ready rows behaves.
  const themeWithSpare = { ...FOOD_THEME_SEEDS[0], questions: [...FOOD_THEME_SEEDS[0].questions, foodQuestion('Hash Browns', 'Home Fries')] };
  await insertFoodTheme(themeWithSpare);
  const plan = await selectPlanForJob({ jobId: 'replacement-commit', count: 10, targetTotalSeconds: 999 });
  const rejected = plan.questions[0];
  await releaseQuestionReservation({ jobId: 'replacement-commit', poolId: rejected.poolId });
  const retained = plan.questions.slice(1);
  const { candidate } = await reserveReplacementQuestion({
    jobId: 'replacement-commit',
    themeKey: plan.hook.themeKey,
    excludeIds: plan.questions.map(question => question.poolId),
    inPlanMotifs: new Set(retained.flatMap(question => questionMotifs(question))),
  });
  assert.ok(candidate);
  const finalPlan = { ...plan, questions: [rowToQuestion(candidate, 0), ...retained.map((question, index) => ({ ...question, index: index + 1 }))] };
  await commitPlanUsage({ jobId: 'replacement-commit', plan: finalPlan, duration: 45 });

  const committedIds = new Set(fake.state.videoQuestions.map(row => row.question_id));
  assert.equal(committedIds.size, 10);
  assert.equal(committedIds.has(rejected.poolId), false);
  assert.equal(committedIds.has(candidate.id), true);
  assert.equal(fake.state.questions.get(rejected.poolId).status, 'ready');
}));
