import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { commitPlanUsage, countReady, getPoolStats, insertQuestions, releaseReservation, releaseStaleReservations, reserveReplacementQuestion, selectAndReservePlan, selectPlanForJob } from './question-pool.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
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

// 16 distinct, non-fantasy questions across 8 distinct content families (2 categories each, at the
// family cap), so two SEPARATE 6-question selections can each be drawn diversely from whatever is
// still 'ready' after the other has consumed its 6 -- used only for the cross-job non-reuse test.
const SIXTEEN_DIVERSE = [
  question('money', 'Own a yacht', 'Own a jet'),
  question('luxury', 'Live in a mansion', 'Live in a penthouse'),
  question('travel', 'Backpack Europe', 'Cruise the Caribbean'),
  question('adventure', 'Skydive', 'Scuba dive'),
  question('food', 'Eat at a 5-star restaurant', 'Cook with a chef', 'fine dining restaurant', 'chef cooking kitchen'),
  question('friendship/social', 'Throw a huge party', 'Host a small gathering'),
  question('space', 'Visit the ISS', 'Visit the moon'),
  question('ocean', 'Swim with sharks', 'Swim with whales'),
  question('dream lifestyle', 'Wake up at sunrise daily', 'Sleep in until noon daily'),
  question('fame', 'Be a movie star', 'Be a rock star'),
  question('time', 'Plan every day in detail', 'Live spontaneously each day'),
  question('future technology', 'Own a self-driving car', 'Own a robot butler'),
  question('survival-lite', 'Survive a desert island', 'Survive an arctic winter'),
  question('survival-lite', 'Build a raft to escape', 'Build a shelter and wait'),
  question('sports', 'Win an olympic gold medal', 'Win a world championship title'),
  question('music', 'Headline a huge festival', 'Record a platinum album'),
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
  const reservation = await selectAndReservePlan({ jobId: 'job-1', count: 8, targetTotalSeconds: 999 });
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
  const first = await selectAndReservePlan({ jobId: 'job-a', count: 8, targetTotalSeconds: 999 });
  assert.ok(first);
  const second = await selectAndReservePlan({ jobId: 'job-b', count: 2 });
  assert.ok(second);
  const firstIds = new Set(first.selected.map(row => row.id));
  const overlap = second.selected.filter(row => firstIds.has(row.id));
  assert.equal(overlap.length, 0, 'job-b must not receive any question already reserved by job-a');
}));

test('a failed job releases its reservation back to ready', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  await selectAndReservePlan({ jobId: 'job-1', count: 8, targetTotalSeconds: 999 });
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

// The job store is in-memory only and never reloaded on restart (see jobs.js), so a process
// restart mid-job orphans its reservation forever unless something eventually reclaims it. This is
// that reclaim path, run once at server boot (see wyr-server.js).
test('releaseStaleReservations reclaims a reservation older than the threshold, but leaves a fresh one (and other jobs\' rows) alone', () => withFakeDb(async fake => {
  await insertQuestions(EIGHT_DIVERSE);
  await selectAndReservePlan({ jobId: 'orphaned-job', count: 3 });
  await selectAndReservePlan({ jobId: 'fresh-job', count: 2 });
  assert.equal(await countReady(), 3);

  // Simulate the orphaned job's reservation having been made 30 minutes ago (e.g. the process
  // restarted before it could ever finish/release), while the fresh one was just made.
  for (const row of fake.state.questions.values()) {
    if (row.reserved_by_job === 'orphaned-job') row.reserved_at = new Date(Date.now() - 30 * 60 * 1000);
  }

  const released = await releaseStaleReservations(20 * 60 * 1000);
  assert.equal(released, 3, 'only the 3 stale rows should be released');
  assert.equal(await countReady(), 6, '3 originally-ready + 3 reclaimed from the orphaned job');

  const stillReserved = [...fake.state.questions.values()].filter(row => row.status === 'reserved');
  assert.equal(stillReserved.length, 2);
  assert.ok(stillReserved.every(row => row.reserved_by_job === 'fresh-job'), 'the fresh (non-stale) reservation must be untouched');
}));

test('releaseStaleReservations is a no-op when nothing is stale', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  await selectAndReservePlan({ jobId: 'active-job', count: 4 });
  const released = await releaseStaleReservations(20 * 60 * 1000);
  assert.equal(released, 0);
  assert.equal(await countReady(), 4);
}));

test('a successful job commits usage: used_count increments and the question is retired to \'used\', never returning to ready', () => withFakeDb(async fake => {
  await insertQuestions(EIGHT_DIVERSE);
  const plan = await selectPlanForJob({ jobId: 'job-1', count: 8, targetTotalSeconds: 999 });
  assert.ok(plan);
  await commitPlanUsage({ jobId: 'job-1', plan, duration: 57.2 });
  assert.equal(await countReady(), 0, 'a consumed question must never be selectable again -- it does not return to ready');
  const usedRow = [...fake.state.questions.values()][0];
  assert.equal(usedRow.status, 'used');
  assert.equal(usedRow.used_count, 1);
  assert.ok(usedRow.last_used_at);
  assert.equal(fake.state.videoQuestions.length, 8);
}));

test('getPoolStats reports ready/reserved/used/total for the admin status endpoint, where used counts consumed QUESTION ROWS not completed videos', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  const reservation = await selectAndReservePlan({ jobId: 'job-1', count: 3 });
  assert.ok(reservation);
  const plan = await selectPlanForJob({ jobId: 'job-2', count: 2 });
  assert.ok(plan);
  await commitPlanUsage({ jobId: 'job-2', plan, duration: 57 });
  const stats = await getPoolStats();
  assert.equal(stats.reserved, 3, '3 questions remain reserved by job-1');
  assert.equal(stats.used, 2, 'job-2\'s 2 questions are permanently consumed');
  assert.equal(stats.ready, 3, '8 - 3 reserved - 2 used = 3 still ready');
  assert.equal(stats.total, 8);
}));

test('getPoolStats never throws or exposes secrets when the pool is empty', () => withFakeDb(async () => {
  const stats = await getPoolStats();
  assert.deepEqual(stats, { ready: 0, reserved: 0, used: 0, total: 0 });
}));

test('a DB-selected plan is shaped for the automatic image/TTS/render path with no manual review fields', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  const plan = await selectPlanForJob({ jobId: 'job-1', count: 8, targetTotalSeconds: 999 });
  assert.equal(plan.questions.length, 8);
  assert.equal(plan.source, 'database_pool');
  assert.equal('selection' in plan, false);
  for (const q of plan.questions) { assert.equal(typeof q.optionA.text, 'string'); assert.equal(typeof q.optionA.searchQuery, 'string'); }
}));
// Fixed production policy: every generated video uses exactly 8 questions/scenes. These exercise
// selectAndReservePlan/selectPlanForJob/commitPlanUsage/releaseReservation via their DEFAULT count
// (no explicit override), proving the production default itself -- not just that the functions can
// be parametrized to 8 -- is exactly 8.
test('the production default reservation count (no explicit count passed) is exactly 8', () => withFakeDb(async () => {
  await insertQuestions(SIXTEEN_DIVERSE);
  const reservation = await selectAndReservePlan({ jobId: 'job-default-count' });
  assert.ok(reservation);
  assert.equal(reservation.selected.length, 8);
  assert.equal(await countReady(), 8, '16 seeded - 8 reserved by default = 8 still ready');
}));

test('a successful job using the production default count commits usage for exactly 8 questions, permanently removing them from ready', () => withFakeDb(async fake => {
  await insertQuestions(SIXTEEN_DIVERSE);
  const plan = await selectPlanForJob({ jobId: 'job-default-commit' });
  assert.ok(plan);
  assert.equal(plan.questions.length, 8);
  await commitPlanUsage({ jobId: 'job-default-commit', plan, duration: 57.2 });
  assert.equal(await countReady(), 8, 'the 8 committed questions are consumed for good; only the other 8 (never selected) remain ready');
  assert.equal(fake.state.videoQuestions.length, 8);
}));

test('a failed job using the production default count releases exactly 8 reservations', () => withFakeDb(async () => {
  await insertQuestions(SIXTEEN_DIVERSE);
  await selectAndReservePlan({ jobId: 'job-default-release' });
  assert.equal(await countReady(), 8);
  const released = await releaseReservation('job-default-release');
  assert.equal(released, 8);
  assert.equal(await countReady(), 16);
}));

// The pool is a ONE-WAY, consume-once pool: a question successfully used in a completed video is
// retired to status='used' (see commitPlanUsage's own doc comment) and can never be selected again
// -- it does NOT rotate back to 'ready'. So "ready" after a successful 8-question job stays 8 lower
// than before the job ever started; only a FAILED job's reservation dip is transient. used_count is
// still incremented for historical/debugging purposes, but functionally a used question is retired
// the moment it's committed. Total (all rows, any status) never changes across the whole lifecycle.
test('a successful 8-question job (16-row pool): Ready 16->8 (permanently), Reserved 0->8->0, Used 0->8, Total stays 16', () => withFakeDb(async fake => {
  await insertQuestions(SIXTEEN_DIVERSE);
  const before = await getPoolStats();
  assert.equal(before.ready, 16); assert.equal(before.reserved, 0); assert.equal(before.used, 0); assert.equal(before.total, 16);

  const plan = await selectPlanForJob({ jobId: 'job-lifecycle' }); // production default count (8)
  assert.equal(plan.questions.length, 8);
  const midFlight = await getPoolStats();
  assert.equal(midFlight.ready, 8, 'ready dips by exactly 8 while the job holds its reservation');
  assert.equal(midFlight.reserved, 8);
  assert.equal(midFlight.total, 16, 'total never changes across the job lifecycle');

  await commitPlanUsage({ jobId: 'job-lifecycle', plan, duration: 57.2 });
  const after = await getPoolStats();
  assert.equal(after.ready, 8, 'ready stays at 8 -- the 8 committed questions are consumed for good, not rotated back');
  assert.equal(after.reserved, 0);
  assert.equal(after.used, 8, 'used counts the 8 consumed QUESTION ROWS, not 1 completed video');
  assert.equal(after.total, 16, 'total still unchanged after commit');

  const committedIds = new Set(plan.questions.map(q => q.poolId));
  for (const row of fake.state.questions.values()) {
    if (committedIds.has(row.id)) { assert.equal(row.status, 'used'); assert.equal(row.used_count, 1, `question ${row.id} used_count must be exactly 1`); assert.ok(row.last_used_at); }
    else { assert.equal(row.status, 'ready'); assert.equal(row.used_count, 0, `question ${row.id} was never selected and must be untouched`); }
  }
}));

test('a failed 8-question job: reservation is released, Ready/Total are restored, Used remains 0 (failed-video questions were never actually consumed)', () => withFakeDb(async fake => {
  await insertQuestions(SIXTEEN_DIVERSE);
  await selectAndReservePlan({ jobId: 'job-lifecycle-failed' }); // production default count (8)
  const midFlight = await getPoolStats();
  assert.equal(midFlight.ready, 8); assert.equal(midFlight.reserved, 8);

  await releaseReservation('job-lifecycle-failed');
  const after = await getPoolStats();
  assert.equal(after.ready, 16, 'a failed job\'s reservation dip is only ever transient -- ready returns to its original value');
  assert.equal(after.reserved, 0); assert.equal(after.total, 16); assert.equal(after.used, 0, 'a failed job must never consume/mark used any question');
  for (const row of fake.state.questions.values()) { assert.equal(row.status, 'ready'); assert.equal(row.used_count, 0, 'a failed job must never increment used_count'); }
}));

test('a consumed (used) question can never be selected again, even when it would otherwise be the ideal candidate', () => withFakeDb(async fake => {
  await insertQuestions(SIXTEEN_DIVERSE);
  const firstPlan = await selectPlanForJob({ jobId: 'job-consume-first' }); // production default count (8)
  await commitPlanUsage({ jobId: 'job-consume-first', plan: firstPlan, duration: 57.2 });
  const consumedIds = new Set(firstPlan.questions.map(q => q.poolId));
  assert.equal(consumedIds.size, 8);

  // Only 8 ready rows remain -- asking for those 8 must succeed and never reach back into the 8
  // already-used rows to make up the count.
  const secondReservation = await selectAndReservePlan({ jobId: 'job-consume-second', count: 8 });
  assert.ok(secondReservation);
  for (const row of secondReservation.selected) assert.equal(consumedIds.has(row.id), false, `consumed question ${row.id} must never be reselected`);
}));

test('commitPlanUsage is idempotent: calling it twice for the same completed job never double-commits (used_count/ready count unaffected by the repeat)', () => withFakeDb(async fake => {
  await insertQuestions(SIXTEEN_DIVERSE);
  const plan = await selectPlanForJob({ jobId: 'job-double-commit' }); // production default count (8)

  await commitPlanUsage({ jobId: 'job-double-commit', plan, duration: 57.2 });
  const afterFirst = await getPoolStats();
  assert.equal(afterFirst.used, 8); assert.equal(afterFirst.ready, 8);
  const usedCountsAfterFirst = new Map([...fake.state.questions.values()].map(row => [row.id, row.used_count]));

  // Simulates a duplicated completion callback for the SAME job -- must be a safe no-op, not a
  // second commit.
  await commitPlanUsage({ jobId: 'job-double-commit', plan, duration: 57.2 });
  const afterSecond = await getPoolStats();
  assert.equal(afterSecond.used, 8, 'the repeat must not consume anything further');
  assert.equal(afterSecond.ready, 8); assert.equal(afterSecond.total, 16);
  assert.equal(fake.state.videoQuestions.length, 8, 'no duplicate video/question links should be created');
  for (const [id, count] of usedCountsAfterFirst) assert.equal(fake.state.questions.get(id).used_count, count, `question ${id} used_count must not double-increment on a repeated commit`);
}));

test('reserveReplacementQuestion reserves exactly one ready question, excludes already-in-plan ids and motifs, and prefers a stronger eligible dilemma among ties', () => withFakeDb(async () => {
  await insertQuestions([
    question('travel', 'Own a small suitcase', 'Own a large suitcase'), // deliberately weak/low-stakes
    question('lifestyle', 'Keep every weekend off', 'Earn a much bigger salary', 'weekend off calendar', 'salary money stack'), // real tradeoff
  ]);
  const excludeIds = [];
  const result = await reserveReplacementQuestion({ jobId: 'job-replace-1', excludeIds, inPlanMotifs: new Set() });
  assert.ok(result.candidate, 'expected a replacement candidate to be found');
  assert.equal(result.candidate.option_a_text, 'Keep every weekend off', 'the stronger eligible dilemma should be preferred as the replacement');
  assert.equal(await countReady(), 1, 'exactly one question must move out of ready');
}));

test('reserveReplacementQuestion excludes ids already in the plan and returns null when nothing eligible remains', () => withFakeDb(async () => {
  const inserted = await insertQuestions([question('travel', 'Visit Rome', 'Visit Cairo')]);
  const result = await reserveReplacementQuestion({ jobId: 'job-replace-2', excludeIds: inserted.inserted, inPlanMotifs: new Set() });
  assert.equal(result.candidate, null);
  assert.equal(await countReady(), 1, 'an excluded/no-match outcome must never reserve anything');
}));
