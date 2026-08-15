import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { insertQuestions, countReady } from './question-pool.js';
import { seedStaticPool } from './seed.js';
import { SEED_QUESTIONS } from './seed-questions.js';
import { isAdminRequestAuthorized } from './admin-auth.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

// POST /api/admin/content-pool/seed-static (wyr-server.js) gates every admin content-pool route
// with this exact call before dispatching to seedStaticPool() -- proving isAdminRequestAuthorized
// rejects unauthenticated/misauthenticated requests here documents that guard for this endpoint,
// on top of its own dedicated coverage in admin-auth.test.js.
test('auth is required: an unconfigured or mismatched admin token is refused before any seeding logic runs', () => {
  assert.equal(isAdminRequestAuthorized({}, { adminToken: '' }), false, 'no admin token configured must never fall open');
  assert.equal(isAdminRequestAuthorized({ authorization: 'Bearer wrong' }, { adminToken: 'railway-secret' }), false);
  assert.equal(isAdminRequestAuthorized({ authorization: 'Bearer railway-secret' }, { adminToken: 'railway-secret' }), true);
});

test('the first seed run inserts all 220 curated questions with zero skips or rejections', () => withFakeDb(async () => {
  const result = await seedStaticPool();
  assert.equal(result.inserted, SEED_QUESTIONS.length);
  assert.equal(result.skipped, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.ready, SEED_QUESTIONS.length);
  assert.equal(result.total, SEED_QUESTIONS.length);
}));

test('a second seed run is idempotent: zero new inserts, every row reported as skipped, counts unchanged', () => withFakeDb(async () => {
  const first = await seedStaticPool();
  assert.equal(first.inserted, SEED_QUESTIONS.length);
  const second = await seedStaticPool();
  assert.equal(second.inserted, 0, 're-running the seed must insert zero new rows');
  assert.equal(second.skipped, SEED_QUESTIONS.length, 'every row must come back as an already-seeded duplicate');
  assert.equal(second.rejected, 0);
  assert.equal(second.ready, SEED_QUESTIONS.length, 'ready count must not change on a repeat run');
  assert.equal(second.total, SEED_QUESTIONS.length, 'total count must not change on a repeat run');
}));

test('seeding never deletes or displaces a question that was already in the pool before seeding', () => withFakeDb(async fake => {
  const preExisting = { category: 'money', optionA: { text: 'Own a private jet', searchQuery: 'private jet runway view' }, optionB: { text: 'Own a luxury yacht', searchQuery: 'luxury yacht ocean deck' } };
  await insertQuestions([preExisting]);
  const preExistingId = [...fake.state.questions.keys()][0];
  const result = await seedStaticPool();
  assert.equal(result.total, SEED_QUESTIONS.length + 1);
  assert.equal(result.ready, SEED_QUESTIONS.length + 1);
  assert.ok(fake.state.questions.has(preExistingId), 'the pre-existing row must still exist, untouched');
  assert.equal(fake.state.questions.get(preExistingId).option_a_text, 'Own a private jet');
  assert.equal(await countReady(), SEED_QUESTIONS.length + 1);
}));

test('seeding never calls Groq or any other network API', () => withFakeDb(async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('seeding must never touch the network'); };
  try {
    await seedStaticPool();
    await seedStaticPool(); // idempotent re-run, still must never touch the network
    assert.equal(fetchCalled, false);
  } finally { globalThis.fetch = originalFetch; }
}));

test('the seed-static response is a safe numeric-only summary with no secrets, connection strings, or raw question content', () => withFakeDb(async () => {
  const result = await seedStaticPool();
  assert.deepEqual(Object.keys(result).sort(), ['inserted', 'ready', 'rejected', 'skipped', 'total']);
  for (const key of Object.keys(result)) assert.equal(typeof result[key], 'number', `${key} must be a plain number`);
  const serialized = JSON.stringify(result);
  assert.equal(/postgres(ql)?:\/\//i.test(serialized), false);
  assert.equal(/gsk_/i.test(serialized), false);
  assert.equal(/bearer/i.test(serialized), false);
  assert.equal(serialized.includes('Own a private jet'), false);
}));
