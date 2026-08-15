import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { importQuestionPack, normalizeImportedQuestion, PackFormatError, MAX_QUESTIONS_PER_PACK } from './pack-import.js';
import { insertQuestions, countReady } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

const canonicalPack = (questions) => ({ packVersion: 1, questions });

const validQuestions = () => [
  { category: 'food', optionA: 'Eat pizza forever', optionB: 'Eat sushi forever' },
  { category: 'travel', optionA: 'Backpack across Europe', optionB: 'Cruise the Caribbean' },
  { category: 'money', optionA: 'Own a private jet', optionB: 'Own a luxury yacht' },
];

test('a valid canonical pack imports successfully and reports inserted/skipped/rejected/total', () => withFakeDb(async () => {
  const result = await importQuestionPack(canonicalPack(validQuestions()));
  assert.equal(result.inserted, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.total, 3);
  assert.equal(await countReady(), 3);
}));

test('a plain JSON array of the same question objects is accepted and normalized identically', () => withFakeDb(async () => {
  const result = await importQuestionPack(validQuestions());
  assert.equal(result.inserted, 3);
  assert.equal(result.total, 3);
}));

test('imported questions get a deterministic, non-empty searchQuery derived from option text (no Groq call, no searchQuery field supplied)', () => withFakeDb(async fake => {
  await importQuestionPack(canonicalPack([{ category: 'dream homes', optionA: 'Live in a treehouse', optionB: 'Live in a houseboat' }]));
  const row = [...fake.state.questions.values()][0];
  assert.equal(row.option_a_search_query.includes('treehouse'), true);
  assert.ok(row.option_a_search_query.split(' ').length >= 2);
}));

test('malformed/invalid entries are rejected individually without discarding the rest of the pack', () => withFakeDb(async () => {
  const pack = canonicalPack([
    { category: 'food', optionA: 'Eat pizza forever', optionB: 'Eat sushi forever' },
    { category: 'food', optionA: '', optionB: 'Missing option A' },
    { category: 'food', optionA: 'Missing option B', optionB: null },
    { category: 'food', optionA: 123, optionB: 'optionA is not a string' },
    'not even an object',
  ]);
  const result = await importQuestionPack(pack);
  assert.equal(result.inserted, 1);
  assert.equal(result.rejected, 4);
  assert.equal(result.total, 1);
}));

test('an unrecognized category is rejected with a clear reason, not silently accepted', () => {
  const result = normalizeImportedQuestion({ category: 'not-a-real-category', optionA: 'Eat pizza forever', optionB: 'Never eat pizza again' });
  assert.equal(result.accepted, false);
  assert.match(result.reasons.join(' '), /not a recognized category/);
});

test('the production quality gate (assessQuestionQuality) still applies to imported questions -- a boring/blocked pair is rejected', () => withFakeDb(async () => {
  const result = await importQuestionPack(canonicalPack([{ category: 'food', optionA: 'Coffee', optionB: 'Tea' }]));
  assert.equal(result.inserted, 0);
  assert.equal(result.rejected, 1);
}));

test('exact duplicates within the SAME uploaded file are inserted once and the rest reported as skipped', () => withFakeDb(async () => {
  const pack = canonicalPack([
    { category: 'food', optionA: 'Eat pizza forever', optionB: 'Eat sushi forever' },
    { category: 'food', optionA: 'Eat pizza forever', optionB: 'Eat sushi forever' },
    { category: 'food', optionA: 'Eat sushi forever', optionB: 'Eat pizza forever' }, // reversed order, same dedupe key
  ]);
  const result = await importQuestionPack(pack);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.rejected, 0);
  assert.equal(await countReady(), 1);
}));

test('a question already present in the DB (from seed/refill/an earlier import) is skipped as a duplicate, never re-inserted', () => withFakeDb(async () => {
  await insertQuestions([{ category: 'food', optionA: { text: 'Eat pizza forever', searchQuery: 'pizza slice cheese' }, optionB: { text: 'Eat sushi forever', searchQuery: 'sushi platter chopsticks' } }]);
  assert.equal(await countReady(), 1);
  const result = await importQuestionPack(canonicalPack(validQuestions()));
  assert.equal(result.inserted, 2, 'only the two genuinely new questions should be inserted');
  assert.equal(result.skipped, 1, 'the already-present question must be reported as skipped');
  assert.equal(result.total, 3);
}));

test('importing the exact same pack twice is idempotent: the second run inserts nothing new', () => withFakeDb(async () => {
  const pack = canonicalPack(validQuestions());
  const first = await importQuestionPack(pack);
  assert.equal(first.inserted, 3);
  const second = await importQuestionPack(pack);
  assert.equal(second.inserted, 0, 're-importing the identical pack must insert zero new rows');
  assert.equal(second.skipped, 3);
  assert.equal(await countReady(), 3, 'the ready count must not change on a repeat import');
}));

test('existing questions already in the pool are never deleted or altered by an import', () => withFakeDb(async fake => {
  await insertQuestions([{ category: 'space', optionA: { text: 'Visit the ISS', searchQuery: 'international space station' }, optionB: { text: 'Visit the moon', searchQuery: 'moon surface astronaut' } }]);
  const preExistingId = [...fake.state.questions.keys()][0];
  await importQuestionPack(canonicalPack(validQuestions()));
  assert.ok(fake.state.questions.has(preExistingId));
  assert.equal(fake.state.questions.get(preExistingId).option_a_text, 'Visit the ISS');
  assert.equal(await countReady(), 1 + 3);
}));

test('an unrecognized top-level shape is rejected as a clear format error, not silently accepted or crashed on', () => withFakeDb(async () => {
  await assert.rejects(() => importQuestionPack({ notAPack: true }), PackFormatError);
  await assert.rejects(() => importQuestionPack('just a string'), PackFormatError);
  await assert.rejects(() => importQuestionPack(null), PackFormatError);
  await assert.rejects(() => importQuestionPack(42), PackFormatError);
}));

test('an unsupported packVersion is rejected clearly', () => withFakeDb(async () => {
  await assert.rejects(() => importQuestionPack({ packVersion: 2, questions: validQuestions() }), PackFormatError);
}));

test('an empty questions array is rejected clearly', () => withFakeDb(async () => {
  await assert.rejects(() => importQuestionPack(canonicalPack([])), PackFormatError);
}));

test('a pack exceeding the maximum question count is rejected clearly instead of silently truncated', () => withFakeDb(async () => {
  const tooMany = Array.from({ length: MAX_QUESTIONS_PER_PACK + 1 }, (_, i) => ({ category: 'food', optionA: `Eat snack variant ${i}`, optionB: `Skip snack variant ${i}` }));
  await assert.rejects(() => importQuestionPack(canonicalPack(tooMany)), PackFormatError);
}));

test('the import result is a safe numeric-only summary with no secrets, connection strings, or raw question content', () => withFakeDb(async () => {
  const result = await importQuestionPack(canonicalPack(validQuestions()));
  assert.deepEqual(Object.keys(result).sort(), ['inserted', 'rejected', 'skipped', 'total']);
  for (const key of Object.keys(result)) assert.equal(typeof result[key], 'number');
  const serialized = JSON.stringify(result);
  assert.equal(/postgres(ql)?:\/\//i.test(serialized), false);
  assert.equal(/gsk_|bearer/i.test(serialized), false);
  assert.equal(serialized.includes('Own a private jet'), false);
}));

test('importing a pack never issues a network/Groq call', () => withFakeDb(async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('pack import must never touch the network'); };
  try {
    await importQuestionPack(canonicalPack(validQuestions()));
    assert.equal(fetchCalled, false);
  } finally { globalThis.fetch = originalFetch; }
}));
