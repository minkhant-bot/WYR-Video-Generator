import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { insertQuestions, countReady } from './question-pool.js';
import { createJobStore } from './jobs.js';
import { runAutomaticPipeline } from './pipeline.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

// Fixed production policy: every generated video uses exactly 6 questions/scenes.
const SIX_DIVERSE = [
  { category: 'money', optionA: { text: 'Own a yacht', searchQuery: 'luxury yacht ocean' }, optionB: { text: 'Own a jet', searchQuery: 'private jet runway' } },
  { category: 'luxury', optionA: { text: 'Live in a mansion', searchQuery: 'mansion estate exterior' }, optionB: { text: 'Live in a penthouse', searchQuery: 'penthouse city skyline' } },
  { category: 'travel', optionA: { text: 'Backpack Europe', searchQuery: 'backpacker europe street' }, optionB: { text: 'Cruise the Caribbean', searchQuery: 'cruise ship caribbean' } },
  { category: 'food', optionA: { text: 'Eat at a fine restaurant', searchQuery: 'fine dining restaurant' }, optionB: { text: 'Cook with a chef', searchQuery: 'chef cooking kitchen' } },
  { category: 'adventure', optionA: { text: 'Skydive', searchQuery: 'skydiving parachute sky' }, optionB: { text: 'Scuba dive', searchQuery: 'scuba diving reef' } },
  { category: 'space', optionA: { text: 'Visit the ISS', searchQuery: 'international space station' }, optionB: { text: 'Visit the moon', searchQuery: 'moon surface astronaut' } },
];

const baseConfig = overrides => ({
  questionCount: 6, groqApiKey: '', groqModel: 'openai/gpt-oss-20b', timeoutMs: 500,
  poolTarget: 10, poolLowWaterMark: 100, poolEmergencyRefillMaxBatches: 1,
  secondsPerQuestion: 7, maximumSceneDuration: 7.25,
  pixabayApiKey: 'test-pixabay-key', pexelsApiKey: 'test-pexels-key', pexelsConcurrency: 4,
  imageSearchRetries: 2, imageRecoveryQueryRounds: 1, imageRecoveryMaxRequests: 4, imageRecoveryMaxMs: 1000,
  webImageFallbackEnabled: false, edgeVoice: 'en-US-AndrewNeural', edgeVoiceRate: '-10%',
  voicePaddingSeconds: 1.5, ttsTimeoutMs: 5000, ttsConcurrency: 2, sceneRenderConcurrency: 1, ffmpegThreads: 1,
  ...overrides,
});

// Real question selection (fake DB) -> real createImageSelection (mocked network returning zero
// candidates) -> the pipeline must fail BEFORE ever reaching TTS/render, with the reservation
// released, disposable temp artifacts cleaned up, and a correctly classified error code. This
// exercises the actual production runAutomaticPipeline code path fully offline (no live Groq, no
// live image provider, no live TTS -- the failure occurs before TTS would ever run).
test('offline E2E: DB-first selection succeeds, image selection is exhausted, job fails cleanly with reservation released and temp artifacts cleaned up', () => withFakeDb(async () => {
  await insertQuestions(SIX_DIVERSE);
  assert.equal(await countReady(), 6);

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

  // Reservation released: all 6 questions are ready again, none left stuck as 'reserved'.
  assert.equal(await countReady(), 6);

  // Disposable temp artifacts cleaned up; job.json (diagnostics) and plan.json are preserved.
  assert.equal(fs.existsSync(path.join(job.workspace, 'assets')), false);
  assert.equal(fs.existsSync(path.join(job.workspace, 'audio')), false);
  assert.equal(fs.existsSync(path.join(job.workspace, 'render')), false);
  assert.ok(fs.existsSync(path.join(job.workspace, 'job.json')), 'the job record itself must survive for diagnostics');
  assert.ok(fs.existsSync(path.join(job.workspace, 'plan.json')), 'the selected plan must survive for diagnostics');

  fs.rmSync(rootDir, { recursive: true, force: true });
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
