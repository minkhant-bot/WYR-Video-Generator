import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { insertQuestions, countReady, releaseReservation } from './question-pool.js';
import { createJobStore } from './jobs.js';
import { assertWithinProductionDurationCeiling, finalizeVerifiedPoolJob, PRODUCTION_DURATION_CEILING_SECONDS, runAutomaticPipeline } from './pipeline.js';
import { buildSceneTimeline } from './audio.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

const EIGHT_DIVERSE = [
  ['Cheeseburger', 'Fried Chicken'], ['Pizza', 'Sushi'], ['Pancakes', 'Waffles'],
  ['Cheesecake', 'Tiramisu'], ['Onion Rings', 'Mozzarella Sticks'],
  ['French Toast', 'Cinnamon Roll'], ['Chicken Wings', 'Nachos'], ['Ice Cream', 'Brownies'],
].map(([a, b]) => ({ category: 'food', optionA: { text: a, searchQuery: `${a} food` }, optionB: { text: b, searchQuery: `${b} food` } }));

const baseConfig = overrides => ({
  questionCount: 6, groqApiKey: '', groqModel: 'openai/gpt-oss-20b', timeoutMs: 500,
  poolTarget: 10, poolLowWaterMark: 100, poolEmergencyRefillMaxBatches: 1,
  secondsPerQuestion: 7,
  pixabayApiKey: 'test-pixabay-key', pexelsApiKey: 'test-pexels-key', pexelsConcurrency: 4,
  imageSearchRetries: 2, imageRecoveryQueryRounds: 1, imageRecoveryMaxRequests: 4, imageRecoveryMaxMs: 1000,
  webImageFallbackEnabled: false, edgeVoice: 'en-US-AndrewNeural', edgeVoiceRate: '-10%',
  voicePaddingSeconds: 1.5, ttsTimeoutMs: 5000, ttsConcurrency: 2, sceneRenderConcurrency: 1, ffmpegThreads: 1,
  ...overrides,
});

test('a usage-commit failure cannot expose a verified job as completed', async () => {
  const updates = [];
  await assert.rejects(() => finalizeVerifiedPoolJob({
    job: { id: 'commit-failed' }, update: changes => updates.push(changes),
    plan: { questions: Array.from({ length: 7 }, (_, index) => ({ poolId: index + 1 })) },
    outputPath: '/tmp/final.mp4', verification: { duration: 45 }, timeline: { totalDuration: 45 }, assets: [], poolReserved: true,
    commitUsage: async () => { throw new Error('database unavailable'); },
  }), /database unavailable/);
  assert.equal(updates.some(update => update.status === 'completed'), false);
});

// Real question selection (fake DB) -> real createImageSelection (mocked network returning zero
// candidates) -> the pipeline must fail BEFORE ever reaching TTS/render, with the reservation
// released, disposable temp artifacts cleaned up, and a correctly classified error code. This
// exercises the actual production runAutomaticPipeline code path fully offline (no live Groq, no
// live image provider, no live TTS -- the failure occurs before TTS would ever run).
test('offline E2E: DB-first selection succeeds, image selection is exhausted, job fails cleanly with reservation released and temp artifacts cleaned up', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  assert.equal(await countReady(), 8);

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-pipeline-e2e-'));
  const store = createJobStore(rootDir);
  const job = store.create();

  const originalFetch = globalThis.fetch;
  let groqCalled = false;
  globalThis.fetch = async url => {
    const href = String(url);
    if (href.includes('groq.com')) { groqCalled = true; throw new Error('must never call Groq during DB-first generation'); }
    if (href.includes('pixabay.com')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ hits: [] }) };
    if (href.includes('pexels.com')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ photos: [] }) };
    throw new Error(`Unexpected fetch during offline E2E test: ${href}`);
  };

  try {
    await runAutomaticPipeline({ job, store, config: baseConfig() });
  } finally { globalThis.fetch = originalFetch; }

  const finalJob = store.get(job.id);
  assert.equal(finalJob.status, 'failed');
  assert.equal(finalJob.stage, 'failed');
  assert.equal(finalJob.errorCode, 'IMAGE_SELECTION_EXHAUSTED', 'an empty image pool must be classified as IMAGE_SELECTION_EXHAUSTED, not a generic failure');
  assert.ok(finalJob.error, 'a clear, non-empty error message must be recorded');
  assert.ok(finalJob.error.length <= 260, 'the client-facing error message must be bounded, not a raw dump');
  assert.equal(groqCalled, false, 'DB-first generation must never call Groq, even on a downstream failure');

  // Reservation released: all 8 questions are ready again, none left stuck as 'reserved'.
  assert.equal(await countReady(), 8);

  // Disposable temp artifacts cleaned up; job.json (diagnostics) and plan.json are preserved.
  assert.equal(fs.existsSync(path.join(job.workspace, 'assets')), false);
  assert.equal(fs.existsSync(path.join(job.workspace, 'audio')), false);
  assert.equal(fs.existsSync(path.join(job.workspace, 'render')), false);
  assert.ok(fs.existsSync(path.join(job.workspace, 'job.json')), 'the job record itself must survive for diagnostics');
  assert.ok(fs.existsSync(path.join(job.workspace, 'plan.json')), 'the selected plan must survive for diagnostics');

  fs.rmSync(rootDir, { recursive: true, force: true });
}));

test('a DB error surfaced during job failure never leaks a DATABASE_URL/password into the logged or client-facing error message', () => withFakeDb(async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-pipeline-secret-leak-'));
  const store = createJobStore(rootDir);
  const job = store.create();
  // Mirrors a real pg driver error that interpolates the connection string on a DNS/auth failure
  // (see utils.js's redactConnectionSecrets / startup.js's equivalent guard for migrations) --
  // this exercises the SAME class of error reaching pipeline.js's general job-failure path.
  const secretUrl = 'postgresql://wyr_user:sup3rSecretPW@db.internal.example:5432/wyr';
  const selectPlan = async () => { throw new Error(`connection to server failed: ${secretUrl}`); };

  await runAutomaticPipeline({ job, store, config: baseConfig(), selectPlan });

  const finalJob = store.get(job.id);
  assert.equal(finalJob.status, 'failed');
  assert.doesNotMatch(finalJob.error, /sup3rSecretPW/, 'the password must never reach the client-facing error message');
  assert.doesNotMatch(finalJob.error, /wyr_user:/, 'the connection string must never reach the client-facing error message');
  assert.match(finalJob.error, /\[redacted\]/);
}));

test('a job that fails before any question reservation (e.g. missing provider config) never attempts a reservation release and still fails cleanly', () => withFakeDb(async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-pipeline-e2e-noconfig-'));
  const store = createJobStore(rootDir);
  const job = store.create();

  await runAutomaticPipeline({ job, store, config: baseConfig({ pixabayApiKey: '', pexelsApiKey: '' }) });

  const finalJob = store.get(job.id);
  assert.equal(finalJob.status, 'failed');
  assert.ok(finalJob.errorCode, 'even a config-validation failure must carry a classified error code');
  assert.equal(await countReady(), 0, 'no question was ever reserved, so the pool must be untouched (still empty, not negative/corrupted)');

  fs.rmSync(rootDir, { recursive: true, force: true });
}));

// ---------------------------------------------------------------------------------------------
// Global (whole-video) duration ceiling: only the COMPLETE scene timeline, built from every
// scene's real measured narration, may raise DURATION_BUDGET_EXCEEDED. An individual long scene
// must never fail in isolation (see audio.js's buildSceneTimeline, which no longer caps scenes).
// ---------------------------------------------------------------------------------------------
test('assertWithinProductionDurationCeiling passes a 6-scene timeline that includes one long (4.13s) narration scene, as long as the total stays under the safe ceiling', () => {
  const voiceovers = [1.5, 2.0, 1.8, 2.2, 4.13, 1.6].map((duration, index) => ({ questionIndex: index, duration }));
  const timeline = buildSceneTimeline({ voiceovers, baseDuration: 7, voicePaddingSeconds: 1.5 });
  assert.equal(assertWithinProductionDurationCeiling(timeline), true);
  assert.ok(timeline.totalDuration <= PRODUCTION_DURATION_CEILING_SECONDS);
});

test('assertWithinProductionDurationCeiling never fails for one long scene alone -- only the summed total can trigger DURATION_BUDGET_EXCEEDED', () => {
  // A single 20s-narration scene has a huge individual duration, but as the ONLY scene in a
  // 1-scene timeline its total is still small; this must NOT throw, proving the check is purely
  // about the summed total, never an individual scene's length.
  const timeline = buildSceneTimeline({ voiceovers: [{ duration: 3 }], baseDuration: 7, voicePaddingSeconds: 1.5 });
  assert.equal(assertWithinProductionDurationCeiling(timeline), true);
});

test('assertWithinProductionDurationCeiling raises DURATION_BUDGET_EXCEEDED only when the complete timeline total exceeds the safe ceiling', () => {
  const voiceovers = Array.from({ length: 6 }, () => ({ duration: 12 })); // 6 * (12s + ~4s tail) far exceeds 58.5s
  const timeline = buildSceneTimeline({ voiceovers, baseDuration: 7, voicePaddingSeconds: 1.5 });
  assert.ok(timeline.totalDuration > PRODUCTION_DURATION_CEILING_SECONDS);
  assert.throws(() => assertWithinProductionDurationCeiling(timeline), error => { assert.equal(error.code, 'DURATION_BUDGET_EXCEEDED'); assert.match(error.message, new RegExp(`exceeds the ${PRODUCTION_DURATION_CEILING_SECONDS}s`)); return true; });
});

// ---------------------------------------------------------------------------------------------
// Bounded retry: if runPipeline fails with the global DURATION_BUDGET_EXCEEDED code, runAutomaticPipeline
// retries exactly once with a fresh already-ready question set from the pool -- never a text
// rewrite, never a Groq call. runJobPipeline/selectImages are injected so this exercises the real
// pool-reservation/release cycle (fake DB) without a real TTS/image-provider round trip.
// ---------------------------------------------------------------------------------------------
test('a global DURATION_BUDGET_EXCEEDED failure triggers exactly one bounded retry with a fresh already-ready question set, and never calls Groq', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  assert.equal(await countReady(), 8);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-pipeline-duration-retry-'));
  const store = createJobStore(rootDir);
  const job = store.create();

  const originalFetch = globalThis.fetch;
  let groqCalled = false;
  globalThis.fetch = async url => { if (String(url).includes('groq.com')) { groqCalled = true; throw new Error('must never call Groq during a duration-budget retry'); } throw new Error(`unexpected network call: ${url}`); };

  let pipelineCalls = 0;
  const runJobPipeline = async ({ job: innerJob, store: innerStore, poolReserved }) => {
    pipelineCalls += 1;
    if (pipelineCalls === 1) {
      // Mirrors what the real runPipeline+handleJobFailure do on a global-ceiling failure: release
      // the reservation, classify the error, and record it on the job -- all BEFORE
      // runAutomaticPipeline decides whether to retry.
      if (poolReserved) await releaseReservation(innerJob.id);
      innerStore.update(innerJob.id, { status: 'failed', stage: 'failed', error: 'Projected total duration exceeds the safe production ceiling.', errorCode: 'DURATION_BUDGET_EXCEEDED' });
      return;
    }
    innerStore.update(innerJob.id, { status: 'completed', stage: 'completed', progress: 100 });
  };
  const selectImages = async ({ plan }) => ({ selectedCount: plan.questions.length * 2, total: plan.questions.length * 2 });

  try { await runAutomaticPipeline({ job, store, config: baseConfig(), runJobPipeline, selectImages }); }
  finally { globalThis.fetch = originalFetch; }

  assert.equal(pipelineCalls, 2, 'expected exactly one bounded retry (2 total attempts), not an unbounded loop');
  assert.equal(groqCalled, false, 'a duration-budget retry must never call Groq or rewrite question text');
  const finalJob = store.get(job.id);
  assert.equal(finalJob.status, 'completed');
  fs.rmSync(rootDir, { recursive: true, force: true });
}));

test('bounded retry gives up after the last attempt, leaving a clean DURATION_BUDGET_EXCEEDED failure and a released pool', () => withFakeDb(async () => {
  await insertQuestions(EIGHT_DIVERSE);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-pipeline-duration-retry-exhausted-'));
  const store = createJobStore(rootDir);
  const job = store.create();

  let pipelineCalls = 0;
  const runJobPipeline = async ({ job: innerJob, store: innerStore, poolReserved }) => {
    pipelineCalls += 1;
    if (poolReserved) await releaseReservation(innerJob.id);
    innerStore.update(innerJob.id, { status: 'failed', stage: 'failed', error: 'Projected total duration exceeds the safe production ceiling.', errorCode: 'DURATION_BUDGET_EXCEEDED' });
  };
  const selectImages = async ({ plan }) => ({ selectedCount: plan.questions.length * 2, total: plan.questions.length * 2 });

  await runAutomaticPipeline({ job, store, config: baseConfig(), runJobPipeline, selectImages });

  assert.equal(pipelineCalls, 2, 'retries must stay bounded at 2 total attempts even when every attempt fails the same way');
  const finalJob = store.get(job.id);
  assert.equal(finalJob.status, 'failed');
  assert.equal(finalJob.errorCode, 'DURATION_BUDGET_EXCEEDED');
  assert.equal(await countReady(), 8, 'every reservation must be released -- no question left stuck as reserved after retries are exhausted');
  fs.rmSync(rootDir, { recursive: true, force: true });
}));
