import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { commitPlanUsage, countReady, getPoolStats, insertQuestions, releaseReservation, selectAndReservePlan, selectPlanForJob } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

const question = (category, a, b, aq, bq) => ({ category, optionA: { text: a, searchQuery: aq || `${a} scene` }, optionB: { text: b, searchQuery: bq || `${b} scene` } });

// A bulk pool fixture of 8 rows, used only to exercise selectAndReservePlan/selectPlanForJob's
// generic `count` parameter across a variety of sub-counts (3, 2, 5, ...) -- NOT a claim that
// production selects 8 questions. Production's fixed count (exactly 6, via config.questionCount)
// is covered separately below using these same functions' default `count`.
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

test('insertQuestions persists a valid batch and rejects a duplicate insert of the same pair', () => withFakeDb(async () => {
  const first = await insertQuestions(EIGHT_DIVERSE.slice(0, 2));
  assert.equal(first.inserted.length, 2);
  assert.equal(first.rejected.length, 0);
  const second = await insertQuestions([EIGHT_DIVERSE[0]]);
  assert.equal(second.inserted.length, 0);
  assert.equal(second.rejected.length, 1);
  assert.match(second.rejected[0].reasons[0], /duplicate/);
}));

test('insertQuestions rejects a malformed/blocked candidate without throwing and without inserting it', () => withFakeDb(async () => {
  const result = await insertQuestions([question('travel', 'Coffee', 'Tea'), EIGHT_DIVERSE[0]]);
  assert.equal(result.inserted.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(await countReady(), 1);
}));

test('a valid insert persists across a fresh countReady() call (persistence within the fake store)', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  assert.equal(await countReady(), EIGHT_DIVERSE.length);
}));

test('selectAndReservePlan reserves exactly 8 questions and moves them out of the ready count', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  const reservation = await selectAndReservePlan({ jobId: 'job-1', count: 8 });
  assert.ok(reservation);
  assert.equal(reservation.selected.length, 8);
  assert.equal(await countReady(), 0);
}));

test('selectAndReservePlan returns null (not a throw) when the pool cannot fill the required count', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE.slice(0, 3));
  const reservation = await selectAndReservePlan({ jobId: 'job-1', count: 8 });
  assert.equal(reservation, null);
  assert.equal(await countReady(), 3, 'a failed reservation attempt must not consume any questions');
}));

test('concurrent jobs never both reserve the same questions (sequential reservations do not overlap)', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  await insertQuestions([question('survival-lite', 'Survive a desert island', 'Survive an arctic winter'), question('friendship/social', 'Throw a huge party', 'Host a small gathering')]);
  const first = await selectAndReservePlan({ jobId: 'job-a', count: 8 });
  assert.ok(first);
  const second = await selectAndReservePlan({ jobId: 'job-b', count: 2 });
  assert.ok(second);
  const firstIds = new Set(first.selected.map(row => row.id));
  const overlap = second.selected.filter(row => firstIds.has(row.id));
  assert.equal(overlap.length, 0, 'job-b must not receive any question already reserved by job-a');
}));

test('a failed job releases its reservation back to ready', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  await selectAndReservePlan({ jobId: 'job-1', count: 8 });
  assert.equal(await countReady(), 0);
  await releaseReservation('job-1');
  assert.equal(await countReady(), 8);
}));

test('releaseReservation only releases rows reserved by the given job, not another job\'s reservation', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  await selectAndReservePlan({ jobId: 'job-a', count: 5 });
  await selectAndReservePlan({ jobId: 'job-b', count: 3 });
  await releaseReservation('job-a');
  assert.equal(await countReady(), 5, 'only job-a\'s 5 reservations should return to ready');
}));

test('a successful job commits usage: used_count increments and the question returns to ready', () => withFakeDb(async fake => {
  await insertQuestions(EIGHT_DIVERSE);
  const plan = await selectPlanForJob({ jobId: 'job-1', count: 8 });
  assert.ok(plan);
  await commitPlanUsage({ jobId: 'job-1', plan, duration: 57.2 });
  assert.equal(await countReady(), 8, 'committed questions return to ready for future reuse');
  const usedRow = [...fake.state.questions.values()][0];
  assert.equal(usedRow.used_count, 1);
  assert.ok(usedRow.last_used_at);
  assert.equal(fake.state.videoQuestions.length, 8);
}));

test('getPoolStats reports ready/reserved/used/total for the admin status endpoint', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  const reservation = await selectAndReservePlan({ jobId: 'job-1', count: 3 });
  assert.ok(reservation);
  const plan = await selectPlanForJob({ jobId: 'job-2', count: 2 });
  assert.ok(plan);
  await commitPlanUsage({ jobId: 'job-2', plan, duration: 57 });
  const stats = await getPoolStats();
  assert.equal(stats.reserved, 3, '3 questions remain reserved by job-1');
  assert.equal(stats.ready, 5, '8 - 3 reserved = 5 ready (job-2\'s 2 returned to ready after commit)');
  assert.equal(stats.used, 1, 'one video has been committed');
  assert.equal(stats.total, 8);
}));

test('getPoolStats never throws or exposes secrets when the pool is empty', () => withFakeDb(async () => {
  const stats = await getPoolStats();
  assert.deepEqual(stats, { ready: 0, reserved: 0, used: 0, total: 0 });
}));

test('a DB-selected plan is shaped for the automatic image/TTS/render path with no manual review fields', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  const plan = await selectPlanForJob({ jobId: 'job-1', count: 8 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.source, 'database_pool');
  assert.equal('selection' in plan, false);
  for (const q of plan.questions) { assert.equal(typeof q.optionA.text, 'string'); assert.equal(typeof q.optionA.searchQuery, 'string'); }
}));

// Fixed production policy: every generated video uses exactly 6 questions/scenes. These exercise
// selectAndReservePlan/selectPlanForJob/commitPlanUsage/releaseReservation via their DEFAULT count
// (no explicit override), proving the production default itself -- not just that the functions can
// be parametrized to 6 -- is exactly 6.
test('the production default reservation count (no explicit count passed) is exactly 6', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  const reservation = await selectAndReservePlan({ jobId: 'job-default-count' });
  assert.ok(reservation);
  assert.equal(reservation.selected.length, 6);
  assert.equal(await countReady(), 2, '8 seeded - 6 reserved by default = 2 still ready');
}));

test('a successful job using the production default count commits usage for exactly 6 questions', () => withFakeDb(async fake => {
  await insertQuestions(EIGHT_DIVERSE);
  const plan = await selectPlanForJob({ jobId: 'job-default-commit' });
  assert.ok(plan);
  assert.equal(plan.questions.length, 6);
  await commitPlanUsage({ jobId: 'job-default-commit', plan, duration: 44.1 });
  assert.equal(await countReady(), 8, 'all 6 committed questions return to ready; the other 2 were never touched');
  assert.equal(fake.state.videoQuestions.length, 6);
}));

test('a failed job using the production default count releases exactly 6 reservations', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  await selectAndReservePlan({ jobId: 'job-default-release' });
  assert.equal(await countReady(), 2);
  const released = await releaseReservation('job-default-release');
  assert.equal(released, 6);
  assert.equal(await countReady(), 8);
}));
