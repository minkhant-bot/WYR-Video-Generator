import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { countReady } from './question-pool.js';
import { maybeTriggerBackgroundRefill, refillPool, __resetBackgroundRefillForTests } from './refill.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); __resetBackgroundRefillForTests(); }
};

const validPlan = () => ({ questions: [
  { category: 'money', optionA: { text: 'Own a yacht', searchQuery: 'luxury yacht ocean' }, optionB: { text: 'Own a jet', searchQuery: 'private jet runway' } },
  { category: 'luxury', optionA: { text: 'Live in a mansion', searchQuery: 'mansion estate exterior' }, optionB: { text: 'Live in a penthouse', searchQuery: 'penthouse city skyline' } },
] });

test('refillPool inserts a small bounded batch and stops once the target is reached', () => withFakeDb(async fake => {
  let calls = 0;
  const provider = { async generatePlan() { calls += 1; return validPlan(); } };
  const originalRefillPool = refillPool;
  // Swap GroqContentProvider construction isn't needed here -- test the batching/target logic via
  // a real refillPool call, but intercept at the HTTP layer used by GroqContentProvider.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await refillPool({ apiKey: 'test-key', target: 2, batchSize: 2, maxBatches: 5 });
    assert.equal(result.stoppedReason, 'target_reached');
    assert.equal(result.finalReady, 2);
    assert.ok(result.batchesAttempted <= 1, 'should stop after a single batch once the target is met');
  } finally { globalThis.fetch = originalFetch; void provider; void calls; void originalRefillPool; }
}));

test('refillPool persists progress after every batch (partial progress survives even if a later batch fails)', () => withFakeDb(async fake => {
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: { message: 'Internal error', code: 'internal_error' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await refillPool({ apiKey: 'test-key', target: 100, batchSize: 2, maxBatches: 5 });
    assert.equal(result.stoppedReason, 'provider_error');
    assert.equal(result.inserted, 2);
    assert.equal(await countReady(), 2, 'the first successful batch must remain in the pool after a later failure');
  } finally { globalThis.fetch = originalFetch; }
}));

test('a 429 during refill does not destroy already-inserted inventory and stops cleanly instead of hammering the provider', () => withFakeDb(async fake => {
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '9999' } });
  };
  try {
    const result = await refillPool({ apiKey: 'test-key', target: 100, batchSize: 2, maxBatches: 3 });
    assert.equal(result.stoppedReason, 'rate_limited');
    assert.equal(await countReady(), 2, 'the batch inserted before the 429 must be preserved');
    assert.ok(call <= 3, `must not hammer the provider; made ${call} request(s)`);
  } finally { globalThis.fetch = originalFetch; }
}));

test('refillPool without a Groq API key throws immediately rather than silently doing nothing', () => withFakeDb(async () => {
  await assert.rejects(() => refillPool({ apiKey: '' }), /GROQ_API_KEY is required/);
}));

test('maybeTriggerBackgroundRefill is a no-op when the pool is already at/above the low-water mark', () => withFakeDb(async fake => {
  await fake.client.query('INSERT INTO wyr_questions (category, content_family, motif_key, motif_key_a, motif_key_b, option_a_text, option_a_search_query, option_b_text, option_b_search_query, dedupe_key, is_fantasy, hook_score, quality_score, visual_score, source_provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    ['money', 'wealth_and_luxury', null, null, null, 'Own a yacht', 'yacht ocean', 'Own a jet', 'jet runway', 'yacht|jet', false, 80, 90, 90, 'groq']);
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  try {
    maybeTriggerBackgroundRefill({ apiKey: 'test-key', target: 10, lowWaterMark: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fetchCalled, false);
  } finally { globalThis.fetch = originalFetch; }
}));

test('empty-pool emergency scenario: refillPool with maxBatches=1 makes exactly one bounded attempt', () => withFakeDb(async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const result = await refillPool({ apiKey: 'test-key', target: 100, batchSize: 2, maxBatches: 1 });
    assert.equal(calls, 1);
    assert.equal(result.stoppedReason, 'max_batches_reached');
  } finally { globalThis.fetch = originalFetch; }
}));
