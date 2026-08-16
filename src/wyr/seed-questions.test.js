import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_CATEGORIES } from './content.js';
import { assessQuestionQuality, canonicalDilemma } from './content-engine.js';
import { SEED_QUESTIONS } from './seed-questions.js';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { insertQuestions, countReady, selectPlanForJob } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;

test('the static seed bank contains at least 200 questions', () => {
  assert.ok(SEED_QUESTIONS.length >= 200, `expected >=200 seed questions, got ${SEED_QUESTIONS.length}`);
});

test('every seed question has the shape insertQuestions()/Groq output both use', () => {
  for (const [i, question] of SEED_QUESTIONS.entries()) {
    assert.equal(typeof question.category, 'string', `question ${i}: category must be a string`);
    assert.ok(question.category.length > 0, `question ${i}: category must not be empty`);
    for (const label of ['optionA', 'optionB']) {
      const option = question[label];
      assert.equal(typeof option?.text, 'string', `question ${i} ${label}: text must be a string`);
      assert.equal(typeof option?.searchQuery, 'string', `question ${i} ${label}: searchQuery must be a string`);
      assert.ok(option.text.length > 0, `question ${i} ${label}: text must not be empty`);
      assert.ok(option.searchQuery.length > 0, `question ${i} ${label}: searchQuery must not be empty`);
    }
  }
});

test('every seed question uses one of the production content categories', () => {
  for (const [i, question] of SEED_QUESTIONS.entries()) {
    assert.ok(CONTENT_CATEGORIES.includes(question.category), `question ${i}: category "${question.category}" is not a recognized production category`);
  }
});

test('every seed question is plain English/ASCII text (no stray unicode, emoji, or control characters)', () => {
  for (const [i, question] of SEED_QUESTIONS.entries()) {
    assert.match(question.optionA.text, ASCII_PRINTABLE, `question ${i} optionA.text is not plain ASCII`);
    assert.match(question.optionB.text, ASCII_PRINTABLE, `question ${i} optionB.text is not plain ASCII`);
    assert.match(question.optionA.searchQuery, ASCII_PRINTABLE, `question ${i} optionA.searchQuery is not plain ASCII`);
    assert.match(question.optionB.searchQuery, ASCII_PRINTABLE, `question ${i} optionB.searchQuery is not plain ASCII`);
  }
});

test('every seed question clears the same quality gate used for Groq-generated candidates', () => {
  const failures = SEED_QUESTIONS
    .map((question, i) => ({ i, question, result: assessQuestionQuality(question) }))
    .filter(entry => !entry.result.accepted);
  assert.deepEqual(failures.map(f => ({ i: f.i, reasons: f.result.reasons })), [], 'every seed question must pass assessQuestionQuality with no rejection reasons');
});

test('no two seed questions share a dedupe key (duplicate/near-duplicate prevention)', () => {
  const keys = SEED_QUESTIONS.map(canonicalDilemma);
  const seen = new Map();
  const collisions = [];
  keys.forEach((key, index) => {
    if (seen.has(key)) collisions.push({ key, first: seen.get(key), second: index });
    else seen.set(key, index);
  });
  assert.deepEqual(collisions, [], 'no two seed questions should reduce to the same dedupe key');
  assert.equal(new Set(keys).size, SEED_QUESTIONS.length);
});

test('inserting the full seed bank into the pool succeeds and reports zero rejections', () => withFakeDb(async () => {
  const { inserted, rejected } = await insertQuestions(SEED_QUESTIONS, { sourceProvider: 'seed' });
  assert.equal(rejected.length, 0, `expected zero rejections, got: ${JSON.stringify(rejected.slice(0, 5))}`);
  assert.equal(inserted.length, SEED_QUESTIONS.length);
  assert.equal(await countReady(), SEED_QUESTIONS.length);
}));

test('seeding is idempotent: inserting the same bank twice never creates duplicates and never deletes existing rows', () => withFakeDb(async () => {
  const first = await insertQuestions(SEED_QUESTIONS, { sourceProvider: 'seed' });
  assert.equal(first.inserted.length, SEED_QUESTIONS.length);
  const readyAfterFirst = await countReady();
  const second = await insertQuestions(SEED_QUESTIONS, { sourceProvider: 'seed' });
  assert.equal(second.inserted.length, 0, 're-running the seed must insert zero new rows');
  assert.equal(second.rejected.length, SEED_QUESTIONS.length, 're-running the seed must report every row as an already-present duplicate');
  assert.equal(await countReady(), readyAfterFirst, 're-running the seed must not change the ready count');
}));

test('seeding never deletes or displaces questions that were already in the pool', () => withFakeDb(async () => {
  const preExisting = { category: 'money', optionA: { text: 'Own a private jet', searchQuery: 'private jet runway view' }, optionB: { text: 'Own a luxury yacht', searchQuery: 'luxury yacht ocean deck' } };
  await insertQuestions([preExisting]);
  assert.equal(await countReady(), 1);
  await insertQuestions(SEED_QUESTIONS, { sourceProvider: 'seed' });
  assert.equal(await countReady(), SEED_QUESTIONS.length + 1, 'the pre-existing question must still be present alongside the seeded ones');
}));

test('with the static seed bank alone, normal DB-first video generation can select the fixed 6 diverse questions without any Groq call', () => withFakeDb(async () => {
  await insertQuestions(SEED_QUESTIONS, { sourceProvider: 'seed' });
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not call Groq'); };
  try {
    const plan = await selectPlanForJob({ jobId: 'job-seed-only' }); // production default count (6)
    assert.ok(plan, 'expected a plan to be selected from the seeded pool');
    assert.equal(plan.questions.length, 6);
    assert.equal(plan.source, 'database_pool');
    assert.equal(fetchCalled, false, 'selecting from a seeded pool must never make a network/Groq call');
  } finally { globalThis.fetch = originalFetch; }
}));
