import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { insertQuestions } from './question-pool.js';
import { selectContentPlan } from './content-source.js';
import { ContentPoolExhaustedError } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

const question = (category, a, b, aq, bq) => ({ category, optionA: { text: a, searchQuery: aq || `${a} scene` }, optionB: { text: b, searchQuery: bq || `${b} scene` } });
const SIX_FOOD = [
  question('food', 'Cheeseburger', 'Fried Chicken'),
  question('food', 'Pizza', 'Sushi'),
  question('food', 'Pancakes', 'Waffles'),
  question('food', 'Cheesecake', 'Tiramisu'),
  question('food', 'Onion Rings', 'Mozzarella Sticks'),
  question('food', 'Chicken Wings', 'Nachos'),
];
const NON_FOOD = [
  question('money', 'Own a yacht', 'Own a jet'),
  question('travel', 'Backpack Europe', 'Cruise the Caribbean'),
];
const job = () => ({ id: `job-${Math.random().toString(36).slice(2)}` });
const config = overrides => ({ questionCount: 6, secondsPerQuestion: 7, groqApiKey: '', ...overrides });

test('production selects six existing food questions and ignores ready non-food rows without calling Groq', () => withFakeDb(async () => {
  await insertQuestions([...NON_FOOD, ...SIX_FOOD]);
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not call Groq'); };
  try {
    const plan = await selectContentPlan({ job: job(), config: config() });
    assert.equal(plan.questions.length, 6);
    assert.equal(plan.questions.every(item => item.category === 'food'), true);
    assert.equal(fetchCalled, false);
  } finally { globalThis.fetch = originalFetch; }
}));

test('fewer than six food questions fails clearly and never generates a fallback even when Groq is configured', () => withFakeDb(async () => {
  await insertQuestions([...NON_FOOD, ...SIX_FOOD.slice(0, 5)]);
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('food-only selection must not call Groq'); };
  try {
    await assert.rejects(
      () => selectContentPlan({ job: job(), config: config({ groqApiKey: 'configured-but-unused' }) }),
      error => {
        assert.ok(error instanceof ContentPoolExhaustedError);
        assert.equal(error.code, 'CONTENT_POOL_EMPTY');
        assert.equal(error.readyFood, 5);
        assert.equal(error.required, 6);
        assert.equal(error.category, 'food');
        assert.match(error.message, /automatic generation are disabled/i);
        return true;
      },
    );
    assert.equal(fetchCalled, false);
  } finally { globalThis.fetch = originalFetch; }
}));

test('an empty food pool fails clearly even when general-category rows are ready', () => withFakeDb(async () => {
  await insertQuestions(NON_FOOD);
  await assert.rejects(
    () => selectContentPlan({ job: job(), config: config() }),
    error => { assert.ok(error instanceof ContentPoolExhaustedError); assert.equal(error.readyFood, 0); return true; },
  );
}));

test('the DB-selected plan enters the automatic image/TTS/render path unchanged (same shape runPipeline already expects)', () => withFakeDb(async () => {
  await insertQuestions(SIX_FOOD);
  const plan = await selectContentPlan({ job: job(), config: config() });
  assert.equal(plan.questions.length, 6);
  assert.equal(plan.percentages.mode, 'illustrative');
  for (const q of plan.questions) { assert.ok(Number.isFinite(q.optionA.percentage)); assert.ok(Number.isFinite(q.optionB.percentage)); assert.equal(q.optionA.percentage + q.optionB.percentage, 100); }
}));
