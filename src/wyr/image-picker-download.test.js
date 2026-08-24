import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { downloadSelectedCandidates, selectedCandidates, ImageSelectionExhaustedError } from './image-picker.js';
import { resolveFfmpegPath } from './runtime.js';

const fixtureFfmpeg = resolveFfmpegPath();
const renderLavfiJpeg = source => {
  const tmp = path.join(os.tmpdir(), `wyr-fixture-${randomUUID()}.jpg`);
  const result = spawnSync(fixtureFfmpeg, ['-y', '-f', 'lavfi', '-i', source, '-frames:v', '1', tmp]);
  if (result.status !== 0) throw new Error(`Could not create fixture image: ${result.stderr}`);
  const bytes = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); return bytes;
};
// `testsrc2`/`color=...` are fully deterministic lavfi sources -- every render produces
// byte-identical output, and rendering is a real (slow) ffmpeg spawn -- so each base image is
// rendered exactly ONCE (memoized) and every "unique" instance is just that base plus a random
// marker appended after the JPEG EOI (ignored by decoders, same trick images.test.js's
// writeCandidate uses), which is what actually gives each fixture distinct bytes/sha256 so the
// pipeline's own cross-slot duplicate-image detection doesn't collide unrelated test fixtures.
let cachedValidBase = null; let cachedBlankBase = null;
// A real, decodable, detailed (non-blank) JPEG >10KB -- passes both the provider size floor and
// inspectDownloadedImage's decode + blank/low-detail checks.
const validImageBytes = () => {
  cachedValidBase ??= renderLavfiJpeg('testsrc2=size=800x480:rate=1');
  return Buffer.concat([cachedValidBase, Buffer.from(randomUUID())]);
};
// A real, decodable but BLANK JPEG, padded past the 10KB size floor -- passes decode, fails
// inspectDownloadedImage's blank/near-uniform detection.
const blankImageBytes = () => {
  cachedBlankBase ??= renderLavfiJpeg('color=c=white:size=800x480:rate=1');
  return Buffer.concat([cachedBlankBase, Buffer.from(randomUUID()), Buffer.alloc(10_000, 0)]);
};
// Correct size, correct content-type, but not valid image data at all -- fails ffmpeg decode.
const corruptImageBytes = () => Buffer.concat([Buffer.from(randomUUID()), Buffer.alloc(15_000, 65)]);

const jpegResponse = bytes => ({ ok: true, status: 200, headers: { get: name => name === 'content-type' ? 'image/jpeg' : null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), text: async () => '' });
const notFoundResponse = () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found', arrayBuffer: async () => new ArrayBuffer(0) });
const emptySearchResponse = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ hits: [] }) });

// Builds a minimal candidate for a given provider, downloadUrl, and a fixed image-byte payload
// registered in `fetchHandlers` (a Map from URL string to a fetch-response-returning function).
let nextId = 1;
const makeCandidate = (provider, fetchHandlers, respond) => {
  const id = String(nextId++);
  const url = `https://fixture.test/${provider.toLowerCase()}/${id}.jpg`;
  fetchHandlers.set(url, respond);
  return { provider, id, candidateKey: `${provider}:${id}|${url}`, downloadUrl: url, originalImageUrl: url, width: 1600, height: 900, queryUsed: 'fixture query' };
};

// 16 total slots are required by downloadSelectedCandidates. `focusSlots` supplies the ones under
// test; the rest are trivial always-succeeds filler slots so the test only has to reason about the
// scenario(s) actually being exercised.
// Full fetchPoolForSlot()-compatible shape (queries/seen/pages/queryIndex/providerIndex) so that
// IF a slot's initial candidate(s) unexpectedly fail and downloadSelectedCandidates falls through
// to its "widen the search" step, that reuses the real fetchPoolForSlot -- it never crashes on a
// test fixture missing fields a real selection state would always have.
const emptyPoolState = () => ({ queries: [], seen: [], pages: {}, queryIndex: 0, providerIndex: 0 });

const buildSelection = (focusSlots, fetchHandlers) => {
  const slots = {};
  for (const slot of focusSlots) slots[slot.key] = { ...emptyPoolState(), ...slot };
  let fillerIndex = 0;
  while (Object.keys(slots).length < 16) {
    const key = `QF${fillerIndex}`;
    const candidate = makeCandidate('Pixabay', fetchHandlers, () => jpegResponse(validImageBytes()));
    slots[key] = { ...emptyPoolState(), key, questionIndex: 100 + fillerIndex, slot: 'A', optionText: 'filler', candidates: [candidate], selectedId: candidate.candidateKey };
    fillerIndex += 1;
  }
  return { slots, total: Object.keys(slots).length };
};

const withMockedFetch = async (fetchHandlers, operation) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const handler = fetchHandlers.get(String(url));
    if (!handler) throw new Error(`Unexpected fetch to unregistered URL: ${url}`);
    return handler();
  };
  try { return await operation(); } finally { globalThis.fetch = originalFetch; }
};

// Filler slots each involve a real ffmpeg render + ffprobe inspection; run them concurrently to
// keep the suite fast. Only the byte-duplicate test below needs sequential (concurrency:1)
// processing for deterministic ordering between its two specific slots.
const config = { pixabayApiKey: 'test-pixabay-key', pexelsApiKey: 'test-pexels-key', timeoutMs: 2000, pexelsConcurrency: 3 };

test('candidate 1 invalid (too small), candidate 2 succeeds', () => {
  const handlers = new Map();
  const bad = makeCandidate('Pixabay', handlers, () => jpegResponse(Buffer.alloc(500)));
  const good = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', candidates: [bad, good], selectedId: bad.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.id, good.id);
  });
});

test('multiple Pixabay candidates fail, a later Pixabay candidate succeeds', () => {
  const handlers = new Map();
  const bad1 = makeCandidate('Pixabay', handlers, () => notFoundResponse());
  const bad2 = makeCandidate('Pixabay', handlers, () => jpegResponse(corruptImageBytes()));
  const good = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', candidates: [bad1, bad2, good], selectedId: bad1.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.id, good.id);
  });
});

test('Pixabay candidates exhausted, Pexels candidate succeeds', () => {
  const handlers = new Map();
  const badPixabay = makeCandidate('Pixabay', handlers, () => notFoundResponse());
  const goodPexels = makeCandidate('Pexels', handlers, () => jpegResponse(validImageBytes()));
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', candidates: [badPixabay, goodPexels], selectedId: badPixabay.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.selectedProvider, 'Pexels');
  });
});

test('a download timeout/network rejection on candidate 1 falls back to candidate 2', () => {
  const handlers = new Map();
  const timesOut = makeCandidate('Pixabay', handlers, () => { throw new Error('Request timed out after 2000ms: https://fixture.test/pixabay/timeout.jpg'); });
  const good = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', candidates: [timesOut, good], selectedId: timesOut.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.id, good.id);
  });
});

test('a corrupt (undecodable) image on candidate 1 falls back to candidate 2', () => {
  const handlers = new Map();
  const corrupt = makeCandidate('Pixabay', handlers, () => jpegResponse(corruptImageBytes()));
  const good = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', candidates: [corrupt, good], selectedId: corrupt.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.id, good.id);
  });
});

test('a blank/low-detail image on candidate 1 falls back to candidate 2', () => {
  const handlers = new Map();
  const blank = makeCandidate('Pixabay', handlers, () => jpegResponse(blankImageBytes()));
  const good = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', candidates: [blank, good], selectedId: blank.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.id, good.id);
  });
});

test('a candidate whose bytes duplicate an image already used by another slot is skipped in favor of the next candidate', () => {
  const handlers = new Map();
  const sharedBytes = validImageBytes();
  const firstSlotCandidate = makeCandidate('Pixabay', handlers, () => jpegResponse(sharedBytes));
  const duplicateCandidate = makeCandidate('Pixabay', handlers, () => jpegResponse(sharedBytes));
  const distinctFallback = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const slotA = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'first', candidates: [firstSlotCandidate], selectedId: firstSlotCandidate.candidateKey };
  const slotB = { key: 'QT1', questionIndex: 1, slot: 'A', optionText: 'second', candidates: [duplicateCandidate, distinctFallback], selectedId: duplicateCandidate.candidateKey };
  const selection = buildSelection([slotA, slotB], handlers);
  return withMockedFetch(handlers, async () => {
    // concurrency:1 makes slot processing sequential, so slot A deterministically claims the
    // shared hash before slot B is attempted.
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config: { ...config, pexelsConcurrency: 1 } });
    const first = assets.find(asset => asset.questionIndex === 0);
    const second = assets.find(asset => asset.questionIndex === 1);
    assert.equal(first.id, firstSlotCandidate.id);
    assert.equal(second.id, distinctFallback.id, 'the second slot must skip the byte-duplicate candidate and use its own fallback');
    assert.notEqual(first.sha256, undefined);
    assert.notEqual(second.sha256, first.sha256);
  });
});

test('every candidate exhausted (including a widened search) fails that slot clearly with ImageSelectionExhaustedError', () => {
  const handlers = new Map();
  const bad1 = makeCandidate('Pixabay', handlers, () => notFoundResponse());
  const bad2 = makeCandidate('Pixabay', handlers, () => notFoundResponse());
  // Any widened search (fetchPoolForSlot expansion) also comes back empty.
  handlers.set('https://pixabay.com/api/?key=test-pixabay-key&q=test&page=1&per_page=40&safesearch=true&orientation=horizontal&image_type=all', emptySearchResponse);
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', queries: ['test'], queryIndex: 0, providerIndex: 0, pages: {}, seen: [], candidates: [bad1, bad2], selectedId: bad1.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  return withMockedFetch(handlers, async () => {
    await assert.rejects(
      () => downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config: { ...config, pexelsApiKey: '' } }),
      error => { assert.ok(error instanceof ImageSelectionExhaustedError); assert.equal(error.code, 'IMAGE_SELECTION_EXHAUSTED'); assert.equal(error.slot, 'QT0'); return true; },
    );
  });
});

// This is the REAL production download path (runAutomaticPipeline always supplies a selectionState,
// so pipeline.js's runPipeline always calls downloadSelectedCandidates, never images.js's
// findAndDownloadImages) -- so the framing safety gate has to be wired in HERE, not just in
// images.js, or production images never get subject-aware framing at all.
test('a candidate whose crop cannot be made safely is rejected for framing reasons and download falls back to the next candidate', () => {
  const handlers = new Map();
  const unsafe = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const safe = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', candidates: [unsafe, safe], selectedId: unsafe.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  const rejectedIds = [];
  const computeCrop = async ({ localPath }) => {
    if (localPath.includes(`-pixabay-${unsafe.id}`)) { rejectedIds.push(unsafe.id); return { safe: false, reason: 'framing rejected: synthetic test rejection' }; }
    return { safe: true, x: 1, y: 2, coverWidth: 900, coverHeight: 450 };
  };
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config, computeCrop });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.id, safe.id, 'the framing-unsafe candidate must be skipped in favor of the safe one');
    assert.deepEqual(result.framing, { x: 1, y: 2, coverWidth: 900, coverHeight: 450 });
    assert.equal(rejectedIds.length, 1, 'the framing check must have run against the rejected candidate before falling back');
  });
});

test('a framing-safe candidate carries its computed crop offset onto the final asset', () => {
  const handlers = new Map();
  const candidate = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'test', candidates: [candidate], selectedId: candidate.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  const computeCrop = async () => ({ safe: true, x: 12, y: 34, coverWidth: 800, coverHeight: 480 });
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config, computeCrop });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.deepEqual(result.framing, { x: 12, y: 34, coverWidth: 800, coverHeight: 480 });
  });
});

// ---------------------------------------------------------------------------------------------
// Download-stage Tier 3/4 continuation: previously, once a slot's whole known pool AND one widened
// search (same query list, deeper pages) were both exhausted, the slot failed immediately. Now one
// more bounded round of dominant-subject-preserving broadened queries (image-picker.js's
// broadenedSubjectQueries -- the SAME helper the selection-stage gap-fill uses) is tried before
// finally giving up, so a slot doesn't fail just because every candidate the ORIGINAL query
// phrasing turned up happened to break at the download/framing stage.
// ---------------------------------------------------------------------------------------------
const pixabayUrl = (q, page = 1) => `https://pixabay.com/api/?key=test-pixabay-key&q=${encodeURIComponent(q).replace(/%20/g, '+')}&page=${page}&per_page=40&safesearch=true&orientation=horizontal&image_type=photo&min_width=1280`;
const searchResponse = hits => () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ hits }) });

test('download failures exhaust the known pool AND the first widened search -- a Tier 3 subject-preserving broadened query still succeeds', () => {
  const handlers = new Map();
  const bad = makeCandidate('Pixabay', handlers, () => notFoundResponse());
  const broadenedUrl = 'https://fixture.test/pixabay/broadened-download.jpg';
  handlers.set(broadenedUrl, () => jpegResponse(validImageBytes()));
  // The first widen (fetchPoolForSlot, same "test" query) comes back empty; the bare broadened
  // subject query "treehouse" also comes back empty; only "treehouse photo" -- still anchored to
  // the option's dominant subject "treehouse" -- returns a usable candidate.
  handlers.set(pixabayUrl('test'), emptySearchResponse);
  handlers.set(pixabayUrl('treehouse'), emptySearchResponse);
  handlers.set(pixabayUrl('treehouse photo'), searchResponse([{ id: 777, imageWidth: 1600, imageHeight: 900, tags: 'treehouse forest wooden ladder', pageURL: 'https://pixabay.com/images/id-777/', largeImageURL: broadenedUrl }]));
  handlers.set(pixabayUrl('treehouse real photo'), emptySearchResponse);

  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'Live in a treehouse', queries: ['test'], queryIndex: 0, providerIndex: 0, pages: {}, seen: [], candidates: [bad], selectedId: bad.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config: { ...config, pexelsApiKey: '' } });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.id, '777', 'the Tier 3 broadened-query candidate must be found and downloaded after the known pool and first widen are exhausted');
  });
});

test('framing rejections exhaust the known pool AND the first widened search -- a Tier 3 subject-preserving broadened query still succeeds', () => {
  const handlers = new Map();
  const unsafeKnown = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const widenedUrl = 'https://fixture.test/pixabay/widened-unsafe.jpg';
  handlers.set(widenedUrl, () => jpegResponse(validImageBytes()));
  const broadenedUrl = 'https://fixture.test/pixabay/broadened-safe.jpg';
  handlers.set(broadenedUrl, () => jpegResponse(validImageBytes()));

  handlers.set(pixabayUrl('test'), searchResponse([{ id: 501, imageWidth: 1600, imageHeight: 900, tags: 'treehouse forest wooden ladder', pageURL: 'https://pixabay.com/images/id-501/', largeImageURL: widenedUrl }]));
  handlers.set(pixabayUrl('treehouse'), emptySearchResponse);
  handlers.set(pixabayUrl('treehouse photo'), searchResponse([{ id: 502, imageWidth: 1600, imageHeight: 900, tags: 'treehouse forest wooden ladder', pageURL: 'https://pixabay.com/images/id-502/', largeImageURL: broadenedUrl }]));
  handlers.set(pixabayUrl('treehouse real photo'), emptySearchResponse);

  const testSlot = { key: 'QT0', questionIndex: 0, slot: 'A', optionText: 'Live in a treehouse', queries: ['test'], queryIndex: 0, providerIndex: 0, pages: {}, seen: [], candidates: [unsafeKnown], selectedId: unsafeKnown.candidateKey };
  const selection = buildSelection([testSlot], handlers);
  // Both the known-pool candidate and the widened-search candidate (id 501) are framing-unsafe;
  // only the Tier 3 broadened-query candidate (id 502) gets a safe crop.
  const computeCrop = async ({ localPath }) => {
    if (localPath.includes(`-pixabay-${unsafeKnown.id}`) || localPath.includes('-pixabay-501')) return { safe: false, reason: 'framing rejected: synthetic test rejection' };
    return { safe: true, x: 1, y: 2, coverWidth: 900, coverHeight: 450 };
  };
  return withMockedFetch(handlers, async () => {
    const assets = await downloadSelectedCandidates({ selection, assetsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-dl-')), config: { ...config, pexelsApiKey: '' }, computeCrop });
    const result = assets.find(asset => asset.questionIndex === 0);
    assert.equal(result.id, '502', 'the Tier 3 broadened-query candidate must be found once every framing-unsafe candidate from the known pool and first widen is exhausted');
  });
});

test('selectedCandidates only returns slots that actually have a selection', () => {
  const handlers = new Map();
  const candidate = makeCandidate('Pixabay', handlers, () => jpegResponse(validImageBytes()));
  const selection = { slots: { Q1A: { key: 'Q1A', candidates: [candidate], selectedId: candidate.candidateKey }, Q1B: { key: 'Q1B', candidates: [], selectedId: null } } };
  const chosen = selectedCandidates(selection);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].key, 'Q1A');
});
