import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { insertQuestions } from './question-pool.js';
import { __resetBackgroundRefillForTests } from './refill.js';
import { selectContentPlan } from './content-source.js';
import { ContentPoolExhaustedError } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); __resetBackgroundRefillForTests(); }
};

const question = (category, a, b, aq, bq) => ({ category, optionA: { text: a, searchQuery: aq || `${a} scene` }, optionB: { text: b, searchQuery: bq || `${b} scene` } });
const EIGHT_DIVERSE = [
  question('money', 'Own a yacht', 'Own a jet'),
  question('luxury', 'Live in a mansion', 'Live in a penthouse'),
  question('travel', 'Backpack Europe', 'Cruise the Caribbean'),
  question('food', 'Eat at a 5-star restaurant', 'Cook with a chef', 'fine dining restaurant', 'chef cooking kitchen'),
  question('adventure', 'Skydive', 'Scuba dive'),
  question('space', 'Visit the ISS', 'Visit the moon'),
  question('ocean', 'Swim with sharks', 'Swim with whales'),
  question('fame', 'Be a movie star', 'Be a rock star'),
];
const job = () => ({ id: `job-${Math.random().toString(36).slice(2)}` });
const config = overrides => ({ questionCount: 8, groqApiKey: '', groqModel: 'openai/gpt-oss-20b', timeoutMs: 1000, poolTarget: 10, poolLowWaterMark: 100, poolEmergencyRefillMaxBatches: 1, ...overrides });

test('when the DB pool already has 8 valid questions, no live Groq request is made', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not call Groq'); };
  try {
    const plan = await selectContentPlan({ job: job(), config: config() });
    assert.equal(plan.questions.length, 8);
    assert.equal(fetchCalled, false);
  } finally { globalThis.fetch = originalFetch; }
}));

test('an empty pool with a configured Groq key attempts exactly one bounded emergency refill, then succeeds', () => withFakeDb(async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    const plan = { questions: EIGHT_DIVERSE };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const plan = await selectContentPlan({ job: job(), config: config({ groqApiKey: 'test-key' }) });
    assert.equal(plan.questions.length, 8);
    assert.equal(calls, 1, 'exactly one emergency refill batch should have been requested');
  } finally { globalThis.fetch = originalFetch; }
}));

test('an empty pool with no Groq key fails clearly with CONTENT_POOL_EMPTY instead of hanging or retrying', () => withFakeDb(async () => {
  await assert.rejects(
    () => selectContentPlan({ job: job(), config: config({ groqApiKey: '' }) }),
    error => { assert.ok(error instanceof ContentPoolExhaustedError); assert.equal(error.code, 'CONTENT_POOL_EMPTY'); return true; },
  );
}));

test('an empty pool where the emergency refill also fails still fails clearly with CONTENT_POOL_EMPTY, not a hang', () => withFakeDb(async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Internal error', code: 'internal_error' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(
      () => selectContentPlan({ job: job(), config: config({ groqApiKey: 'test-key' }) }),
      error => { assert.ok(error instanceof ContentPoolExhaustedError); return true; },
    );
  } finally { globalThis.fetch = originalFetch; }
}));

test('the DB-selected plan enters the automatic image/TTS/render path unchanged (same shape runPipeline already expects)', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  const plan = await selectContentPlan({ job: job(), config: config() });
  assert.equal(plan.percentages.mode, 'illustrative');
  for (const q of plan.questions) { assert.ok(Number.isFinite(q.optionA.percentage)); assert.ok(Number.isFinite(q.optionB.percentage)); assert.equal(q.optionA.percentage + q.optionB.percentage, 100); }
}));
