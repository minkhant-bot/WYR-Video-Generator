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

test('canonical theme keys collapse near-duplicate presentation wording', () => {
  assert.equal(canonicalFoodThemeKey('Build Your Breakfast'), canonicalFoodThemeKey('Build Your Ultimate Breakfast'));
});

test('DB-first selection reserves seven questions from one stored theme and rotates after commit', () => withFakeDb(async () => {
  for (const theme of FOOD_THEME_SEEDS.slice(0, 2)) {
    const result = await insertFoodTheme(theme);
    assert.ok(result.inserted >= 9);
  }
  assert.equal((await insertFoodTheme({ ...FOOD_THEME_SEEDS[0], title: 'Build Your Ultimate Breakfast' })).skipped, true);
  const first = await selectPlanForJob({ jobId: 'theme-job-1', count: 7 });
  assert.equal(first.questions.length, 7);
  assert.equal(first.hook.themeKey, FOOD_THEME_SEEDS[0].themeKey);
  assert.equal(first.questions.every(question => question.category === 'food'), true);
  await commitPlanUsage({ jobId: 'theme-job-1', plan: first, duration: 45 });
  const second = await selectPlanForJob({ jobId: 'theme-job-2', count: 7 });
  assert.equal(second.questions.length, 7);
  assert.notEqual(second.hook.themeKey, first.hook.themeKey);
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

test('usage commit rejects anything other than exactly seven reserved questions before creating a completed video', () => withFakeDb(async fake => {
  await insertFoodTheme(FOOD_THEME_SEEDS[0]);
  const plan = await selectPlanForJob({ jobId: 'partial-commit', count: 7 });
  const missing = fake.state.questions.get(plan.questions[0].poolId);
  missing.status = 'ready'; missing.reserved_by_job = null;
  await assert.rejects(() => commitPlanUsage({ jobId: 'partial-commit', plan, duration: 45 }), /found 6 of 7 reserved questions/);
  assert.equal(fake.state.videos.size, 0);
  assert.equal([...fake.state.questions.values()].filter(row => row.status === 'used').length, 0);
}));

test('usage commit records the exact seven final questions after replacement', () => withFakeDb(async fake => {
  await insertFoodTheme(FOOD_THEME_SEEDS[0]);
  const plan = await selectPlanForJob({ jobId: 'replacement-commit', count: 7 });
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
  assert.equal(committedIds.size, 7);
  assert.equal(committedIds.has(rejected.poolId), false);
  assert.equal(committedIds.has(candidate.id), true);
  assert.equal(fake.state.questions.get(rejected.poolId).status, 'ready');
}));
