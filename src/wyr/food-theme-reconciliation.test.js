import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { FOOD_THEME_SEEDS } from './food-themes.js';
import { reconcileStaticFoodThemes } from './food-theme-reconciliation.js';
import { insertFoodTheme, insertQuestions, selectPlanForJob } from './question-pool.js';
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
const oldBreakfast = ({ twoChanged = false } = {}) => ({
  ...FOOD_THEME_SEEDS[0],
  questions: [foodQuestion('Apple', 'Banana'), ...(twoChanged ? [foodQuestion('Muffin', 'Toast'), ...FOOD_THEME_SEEDS[0].questions.slice(2)] : FOOD_THEME_SEEDS[0].questions.slice(1))],
});
const rowAt = (fake, position) => [...fake.state.questions.values()].find(row => row.theme_position === position && row.theme_id != null);
const rowsForPair = (fake, optionA, optionB) => [...fake.state.questions.values()].filter(row => row.option_a_text === optionA && row.option_b_text === optionB);

test('one-time FOOD reconciliation updates an old READY slot in place', () => withFakeDb(async fake => {
  await insertFoodTheme(oldBreakfast());
  const oldRow = rowAt(fake, 1); const oldId = oldRow.id;
  const result = await reconcileStaticFoodThemes({ themes: [FOOD_THEME_SEEDS[0]], revision: 'test-ready-replacement' });
  const reconciled = rowAt(fake, 1);
  assert.equal(result.updatedReady, 1);
  assert.equal(reconciled.id, oldId);
  assert.equal(reconciled.status, 'ready');
  assert.deepEqual([reconciled.option_a_text, reconciled.option_b_text], ['Orange', 'Banana']);
  assert.equal(rowsForPair(fake, 'Orange', 'Banana').length, 1);
}));

test('USED old row and completed-video history are preserved while replacement uses a free position', () => withFakeDb(async fake => {
  await insertFoodTheme(oldBreakfast());
  const used = rowAt(fake, 1);
  Object.assign(used, { status: 'used', used_count: 1, last_used_at: new Date('2026-08-01T00:00:00Z') });
  fake.state.videoQuestions.push({ video_id: 77, question_id: used.id, position: 1 });
  const before = { ...used };
  const result = await reconcileStaticFoodThemes({ themes: [FOOD_THEME_SEEDS[0]], revision: 'test-used-preserved' });
  const preserved = fake.state.questions.get(used.id);
  assert.deepEqual(preserved, before, 'reconciliation must not mutate any field on a USED row');
  assert.deepEqual(fake.state.videoQuestions, [{ video_id: 77, question_id: used.id, position: 1 }]);
  const replacements = rowsForPair(fake, 'Orange', 'Banana');
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].status, 'ready');
  assert.ok(replacements[0].theme_position > 10);
  assert.equal(result.preservedUsed, 1);
  assert.equal([...fake.state.questions.values()].some(row => row.id === used.id && row.status === 'ready'), false);
  const ordinarySeed = await insertFoodTheme(FOOD_THEME_SEEDS[0]);
  assert.equal(ordinarySeed.rejected.length, 1, 'the USED historical position is reported, not thrown as a fatal unique-position error');
}));

test('completed-video reference protects an anomalous READY row from being rewritten', () => withFakeDb(async fake => {
  await insertFoodTheme(oldBreakfast());
  const historical = rowAt(fake, 1); const before = { ...historical };
  fake.state.videoQuestions.push({ video_id: 88, question_id: historical.id, position: 1 });
  await reconcileStaticFoodThemes({ themes: [FOOD_THEME_SEEDS[0]], revision: 'test-history-guard' });
  assert.deepEqual(fake.state.questions.get(historical.id), before);
  assert.deepEqual(fake.state.videoQuestions, [{ video_id: 88, question_id: historical.id, position: 1 }]);
  const replacement = rowsForPair(fake, 'Orange', 'Banana');
  assert.equal(replacement.length, 1);
  assert.notEqual(replacement[0].id, historical.id);
  assert.equal(replacement[0].status, 'ready');
}));

test('existing unthemed READY dedupe conflict is attached without creating a duplicate row', () => withFakeDb(async fake => {
  const desired = FOOD_THEME_SEEDS[0].questions[0];
  const inserted = await insertQuestions([desired], { sourceProvider: 'seed' });
  const existingId = inserted.inserted[0];
  await insertFoodTheme(oldBreakfast());
  const obsoleteId = rowAt(fake, 1).id;
  const result = await reconcileStaticFoodThemes({ themes: [FOOD_THEME_SEEDS[0]], revision: 'test-dedupe-attach' });
  const desiredRows = rowsForPair(fake, 'Orange', 'Banana');
  assert.equal(result.attached, 1);
  assert.equal(desiredRows.length, 1);
  assert.equal(desiredRows[0].id, existingId);
  assert.equal(desiredRows[0].theme_position, 1);
  assert.equal(fake.state.questions.has(obsoleteId), false);
  assert.equal(new Set([...fake.state.questions.values()].map(row => row.dedupe_key)).size, fake.state.questions.size);
}));

test('USED dedupe conflict stays terminal and the old READY slot is preserved without duplication', () => withFakeDb(async fake => {
  const desired = FOOD_THEME_SEEDS[0].questions[0];
  const inserted = await insertQuestions([desired], { sourceProvider: 'seed' });
  const usedDuplicate = fake.state.questions.get(inserted.inserted[0]);
  Object.assign(usedDuplicate, { status: 'used', used_count: 1, last_used_at: new Date('2026-08-03T00:00:00Z') });
  await insertFoodTheme(oldBreakfast());
  const oldReady = rowAt(fake, 1); const before = { ...usedDuplicate };
  const result = await reconcileStaticFoodThemes({ themes: [FOOD_THEME_SEEDS[0]], revision: 'test-used-dedupe-conflict' });
  assert.deepEqual(fake.state.questions.get(usedDuplicate.id), before);
  assert.equal(fake.state.questions.get(oldReady.id).status, 'ready');
  assert.deepEqual([fake.state.questions.get(oldReady.id).option_a_text, fake.state.questions.get(oldReady.id).option_b_text], ['Apple', 'Banana']);
  assert.equal(rowsForPair(fake, 'Orange', 'Banana').length, 1);
  assert.equal(rowsForPair(fake, 'Orange', 'Banana')[0].status, 'used');
  assert.equal(result.conflicts.length, 1);
  assert.equal(new Set([...fake.state.questions.values()].map(row => row.dedupe_key)).size, fake.state.questions.size);
}));

test('reconciled theme remains selectable with seven READY questions and USED rows stay terminal', () => withFakeDb(async fake => {
  await insertFoodTheme(oldBreakfast({ twoChanged: true }));
  const usedRows = [rowAt(fake, 1), rowAt(fake, 2)];
  for (const row of usedRows) Object.assign(row, { status: 'used', used_count: 1, last_used_at: new Date('2026-08-02T00:00:00Z') });
  await reconcileStaticFoodThemes({ themes: [FOOD_THEME_SEEDS[0]], revision: 'test-selectable' });
  const plan = await selectPlanForJob({ jobId: 'reconciled-theme-job', count: 7 });
  assert.equal(plan.questions.length, 7);
  assert.equal(plan.hook.themeKey, FOOD_THEME_SEEDS[0].themeKey);
  assert.equal(plan.questions.some(question => usedRows.some(row => row.id === question.poolId)), false);
  for (const row of usedRows) assert.equal(fake.state.questions.get(row.id).status, 'used');
}));

test('completed reconciliation revision is idempotent', () => withFakeDb(async fake => {
  await insertFoodTheme(oldBreakfast());
  const first = await reconcileStaticFoodThemes({ themes: [FOOD_THEME_SEEDS[0]], revision: 'test-idempotent' });
  const sizeAfterFirst = fake.state.questions.size;
  const second = await reconcileStaticFoodThemes({ themes: [FOOD_THEME_SEEDS[0]], revision: 'test-idempotent' });
  assert.equal(first.applied, true);
  assert.equal(second.alreadyApplied, true);
  assert.equal(fake.state.questions.size, sizeAfterFirst);
}));
