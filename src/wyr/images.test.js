import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessImageCandidate, buildImageQueries, findAndDownloadImages } from './images.js';

const writeCandidate = (candidate, destination) => fs.writeFileSync(destination, Buffer.alloc(12000, [...String(candidate.id)].reduce((sum, character) => sum + character.charCodeAt(0), 1) % 255));

test('image selection retries weak searches and never reuses a photo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-images-')); const calls = [];
  const candidate = id => ({ id, width: 2400, height: 1400, alt: 'mountain beach travel', photographer: 'Fixture', photographerUrl: 'https://example.test/p', photoUrl: `https://example.test/${id}`, downloadUrl: `https://example.test/${id}.jpg`, position: 0 });
  const provider = { search: async query => { calls.push(query); if (calls.length === 1) return [candidate('one')]; if (calls.length === 2) return [candidate('one')]; return [candidate('two')]; }, downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); return destination; } };
  const plan = { questions: [{ index: 0, optionA: { text: 'Mountain cabin', searchQuery: 'snow mountain cabin' }, optionB: { text: 'Beach villa', searchQuery: 'tropical beach villa' } }] };
  try { const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 2 }); assert.equal(assets.length, 2); assert.equal(new Set(assets.map(asset => asset.id)).size, 2); assert.equal(assets[1].searchAttempts.length, 2); assert.ok(assets.every(asset => fs.existsSync(asset.localPath))); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Pexels search and download concurrency is bounded while output order stays deterministic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-images-concurrency-')); let activeSearches = 0; let maximumSearches = 0; let activeDownloads = 0; let maximumDownloads = 0;
  const candidate = id => ({ id, width: 2400, height: 1400, alt: id, photographer: 'Fixture', photographerUrl: 'https://example.test/p', photoUrl: `https://example.test/${id}`, downloadUrl: `https://example.test/${id}.jpg`, position: 0 });
  const provider = {
    search: async query => { activeSearches += 1; maximumSearches = Math.max(maximumSearches, activeSearches); await new Promise(resolve => setTimeout(resolve, 8)); activeSearches -= 1; return [candidate(query)]; },
    downloadAsset: async (selected, destination) => { activeDownloads += 1; maximumDownloads = Math.max(maximumDownloads, activeDownloads); await new Promise(resolve => setTimeout(resolve, 8)); writeCandidate(selected, destination); activeDownloads -= 1; return destination; },
  };
  const labels = ['zero', 'one'];
  const plan = { questions: Array.from({ length: 2 }, (_, questionIndex) => ({ index: questionIndex, optionA: { text: `Alpha concept ${labels[questionIndex]}`, searchQuery: `alpha concept ${labels[questionIndex]}` }, optionB: { text: `Beta vision ${labels[questionIndex]}`, searchQuery: `beta vision ${labels[questionIndex]}` } })) };
  try {
    const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.equal(maximumSearches, 2); assert.equal(maximumDownloads, 2);
    assert.deepEqual(assets.map(asset => `${asset.questionIndex}${asset.slot}`), ['0A', '0B', '1A', '1B']);
    assert.equal(new Set(assets.map(asset => asset.id)).size, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('image queries expand difficult concepts into several concise visual searches', () => {
  const queries = buildImageQueries({ text: 'Read Minds', searchQuery: 'telepathy mind reading' });
  assert.ok(queries.length >= 3); assert.ok(queries.includes('telepathy person reading thoughts')); assert.ok(queries.includes('two people psychic mind connection'));
  assert.equal(queries.every(query => query.split(' ').length <= 8), true);
});

test('weak generic Pexels visual fails the strong short-form quality gate', () => {
  const assessment = assessImageCandidate({ id: 'weak', width: 2400, height: 1400, alt: 'two people holding a brain model generic illustration', downloadUrl: 'https://images.test/brain.jpg' }, { text: 'Read Minds' });
  assert.equal(assessment.accepted, true);
  assert.equal(assessment.pexelsQualityPassed, false);
  assert.match(assessment.pexelsQualityReasons.join(' '), /generic|visual impact|visual quality/);

  const wallet = assessImageCandidate({ id: 'wallet', width: 2400, height: 1400, alt: 'generic wallet and bank card finance illustration', downloadUrl: 'https://images.test/wallet.jpg' }, { text: 'Double Bank Balance Instantly' });
  assert.equal(wallet.pexelsQualityPassed, false);
  assert.match(wallet.pexelsQualityReasons.join(' '), /generic|increasing|multiplying|abundance/);
  const abundance = assessImageCandidate({ id: 'abundance', width: 2400, height: 1400, alt: 'dramatic person surrounded by massive stacks of money and growing wealth', downloadUrl: 'https://images.test/wealth.jpg' }, { text: 'Double Bank Balance Instantly' });
  assert.equal(abundance.pexelsQualityPassed, true);
});

test('strong specific Pexels visual passes and a specific photograph is not rejected merely for being stock photography', () => {
  const assessment = assessImageCandidate({ id: 'strong', width: 2400, height: 1400, alt: 'dramatic photograph of a person stepping through a glowing teleportation portal', downloadUrl: 'https://images.test/portal.jpg' }, { text: 'Teleport Anywhere' });
  assert.equal(assessment.accepted, true);
  assert.equal(assessment.pexelsQualityPassed, true);
  assert.ok(assessment.qualityScore >= 72);
});

test('candidate relevance gate rejects weak, undersized, and watermarked results', () => {
  const option = { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' };
  const strong = assessImageCandidate({ id: 'strong', width: 2400, height: 1400, alt: 'person petting a friendly fantasy dragon creature', downloadUrl: 'https://images.test/dragon.jpg' }, option);
  assert.equal(strong.accepted, true);
  const weak = assessImageCandidate({ id: 'weak', width: 2400, height: 1400, alt: 'business meeting office', downloadUrl: 'https://images.test/office.jpg' }, option);
  assert.equal(weak.accepted, false); assert.match(weak.rejectionReasons.join(' '), /relevance score/);
  const small = assessImageCandidate({ id: 'small', width: 600, height: 400, alt: 'friendly dragon', downloadUrl: 'https://images.test/dragon.jpg' }, option);
  assert.match(small.rejectionReasons.join(' '), /too small/);
  const watermarked = assessImageCandidate({ id: 'marked', width: 2400, height: 1400, alt: 'friendly dragon Shutterstock', downloadUrl: 'https://images.test/dragon.jpg' }, option);
  assert.match(watermarked.rejectionReasons.join(' '), /watermark/);
  const stockPreview = assessImageCandidate({ id: 'stock', width: 2400, height: 1400, alt: 'person petting a friendly dragon', sourceDomain: 'stock.adobe.com', downloadUrl: 'https://cdn.test/dragon.jpg' }, option);
  assert.match(stockPreview.rejectionReasons.join(' '), /watermark/);
  const screenshot = assessImageCandidate({ id: 'ui', width: 2400, height: 1400, alt: 'person petting dragon mobile app screenshot', downloadUrl: 'https://images.test/dragon.jpg' }, option);
  assert.match(screenshot.rejectionReasons.join(' '), /screenshot/);
  const sexualized = assessImageCandidate({ id: 'adult', width: 2400, height: 1400, alt: 'sexy woman petting a dragon', downloadUrl: 'https://images.test/dragon.jpg' }, option);
  assert.match(sexualized.rejectionReasons.join(' '), /inappropriate/);
});

test('weak Pexels result invokes web fallback and preserves provenance and license metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-web-fallback-'));
  const weakPexels = id => ({ id: `p${id}`, provider: 'Pexels', width: 2400, height: 1400, alt: 'person near dragon generic illustration', sourcePageUrl: `https://pexels.com/photo/p${id}`, originalImageUrl: `https://images.pexels.com/p${id}.jpg`, downloadUrl: `https://images.pexels.com/p${id}.jpg`, position: id });
  const web = id => ({ id: `w${id}`, provider: 'DuckDuckGo Images', width: 3000, height: 1800, alt: 'person petting friendly fantasy dragon creature', sourcePageUrl: `https://example.test/photos/dragon-${id}`, sourceDomain: 'example.test', originalImageUrl: `https://images.example.test/dragon-${id}-original.jpg`, downloadUrl: `https://images.example.test/dragon-${id}.jpg`, license: 'unknown', usageRights: 'unknown — verify with the source owner before reuse', position: id });
  const provider = { search: async () => [weakPexels(1), weakPexels(2)], downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); } };
  const webProvider = { name: 'DuckDuckGo Images', search: async () => [web(1), web(2)], downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); } };
  const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' }, optionB: { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 2, concurrency: 2 });
    assert.equal(assets[0].provider, 'DuckDuckGo Images'); assert.equal(assets[0].webFallbackRequired, true); assert.equal(assets[0].pexelsPassed, false);
    assert.equal(assets[0].sourceDomain, 'example.test'); assert.equal(assets[0].license, 'unknown');
    assert.notEqual(assets[0].originalImageUrl, assets[1].originalImageUrl);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('strong specific Pexels result remains primary without invoking web fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-strong-pexels-')); let webCalls = 0;
  const strong = id => ({ id: `p${id}`, provider: 'Pexels', width: 2400, height: 1400, alt: 'dramatic cinematic person stepping through a glowing teleportation portal', originalImageUrl: `https://images.pexels.test/p${id}.jpg`, downloadUrl: `https://images.pexels.test/p${id}.jpg`, position: id });
  const weakFirst = { id: 'weak-first', provider: 'Pexels', width: 2400, height: 1400, alt: 'person beside glowing teleportation portal generic illustration', originalImageUrl: 'https://images.pexels.test/weak-first.jpg', downloadUrl: 'https://images.pexels.test/weak-first.jpg', position: 0 };
  const provider = { search: async () => [weakFirst, strong(1), strong(2)], downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); } };
  const webProvider = { name: 'DuckDuckGo Images', search: async () => { webCalls += 1; return []; }, downloadAsset: async () => {} };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' }, optionB: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 2, concurrency: 2 });
    assert.equal(assets.every(asset => asset.provider === 'Pexels'), true);
    assert.equal(assets.every(asset => asset.pexelsPassed), true);
    assert.equal(assets.some(asset => asset.id === 'weak-first'), false);
    assert.equal(webCalls, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('blocked web fallback uses best valid Pexels candidate and records the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-web-blocked-'));
  const weakPexels = id => ({ id: `p${id}`, provider: 'Pexels', width: 2400, height: 1400, alt: 'person beside glowing teleportation portal generic illustration', sourcePageUrl: `https://pexels.com/photo/p${id}`, originalImageUrl: `https://images.pexels.com/p${id}.jpg`, downloadUrl: `https://images.pexels.com/p${id}.jpg`, position: id });
  const provider = { search: async () => [weakPexels(1), weakPexels(2)], downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); } };
  const webProvider = { name: 'DuckDuckGo Images', search: async () => { throw new Error('HTTP 429 blocked'); }, downloadAsset: async () => {} };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' }, optionB: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 2, concurrency: 2 });
    assert.equal(assets[0].provider, 'Pexels'); assert.equal(assets[0].webFallbackRequired, true); assert.match(assets[0].fallbackReason, /429 blocked/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('selection rejects the same underlying image across provider IDs and URLs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-image-identity-'));
  const candidate = (id, url, alt) => ({ id, provider: 'Pexels', width: 2400, height: 1400, alt, originalImageUrl: url, downloadUrl: url, position: 0 });
  const sharedUrl = 'https://images.pexels.test/shared.jpg';
  const provider = {
    search: async query => query.includes('dragon')
      ? [candidate('dragon-one', sharedUrl, 'person with friendly fantasy dragon')]
      : [candidate('portal-same-photo', sharedUrl, 'fantasy portal doorway'), candidate('portal-unique', 'https://images.pexels.test/portal.jpg', 'fantasy portal doorway')],
    downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); },
  };
  const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' }, optionB: { text: 'Own a Portal Door', searchQuery: 'fantasy portal doorway' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.deepEqual(assets.map(asset => asset.id), ['dragon-one', 'portal-unique']);
    assert.equal(new Set(assets.map(asset => asset.originalImageUrl)).size, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('broken web candidates fall back to a downloadable valid Pexels image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-web-broken-'));
  const provider = { search: async query => [{ id: `pexels-${query}`, provider: 'Pexels', width: 2400, height: 1400, alt: query.includes('frozen') ? 'person holding a frozen clock generic illustration' : 'person beside glowing teleportation portal generic illustration', originalImageUrl: `https://images.pexels.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://images.pexels.test/${encodeURIComponent(query)}.jpg`, position: 0 }], downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); } };
  const webProvider = { name: 'DuckDuckGo Images', search: async query => [{ id: `web-${query}`, provider: 'DuckDuckGo Images', width: 3000, height: 1800, alt: `person entering ${query}`, originalImageUrl: `https://images.example.test/${encodeURIComponent(query)}-original.jpg`, downloadUrl: `https://images.example.test/${encodeURIComponent(query)}.jpg`, position: 0 }], downloadAsset: async () => { throw new Error('HTTP 404'); } };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' }, optionB: { text: 'Stop Time', searchQuery: 'frozen clock time' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.equal(assets[0].provider, 'Pexels');
    assert.match(assets[0].rejectionReasons.flatMap(rejection => rejection.reasons).join(' '), /broken or unreachable image: HTTP 404/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('web fallback searches progressively and honors the provider request cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-web-cap-')); let active = 0; let maximum = 0; let calls = 0;
  const provider = { search: async query => [{ id: `weak-${query}`, provider: 'Pexels', width: 2400, height: 1400, alt: 'generic office', originalImageUrl: `https://pexels.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://pexels.test/${encodeURIComponent(query)}.jpg` }], downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); } };
  const webProvider = {
    name: 'DuckDuckGo Images', maxConcurrency: 1,
    search: async query => { active += 1; maximum = Math.max(maximum, active); calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); active -= 1; return [{ id: `web-${query}`, provider: 'DuckDuckGo Images', width: 3000, height: 1800, alt: query.includes('dragon') ? `person ${query}` : query, originalImageUrl: `https://images.example.test/${encodeURIComponent(query)}-original.jpg`, downloadUrl: `https://images.example.test/${encodeURIComponent(query)}.jpg` }]; },
    downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); },
  };
  const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' }, optionB: { text: 'Own a Portal Door', searchQuery: 'fantasy portal doorway' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 2, concurrency: 4 });
    assert.equal(maximum, 1); assert.equal(calls, 4); assert.equal(assets.every(asset => asset.provider === 'DuckDuckGo Images'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a broken relevant Pexels result invokes web fallback after download validation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-broken-pexels-'));
  const pexelsProvider = { search: async query => [{ id: `p-${query}`, provider: 'Pexels', width: 2400, height: 1400, alt: query, originalImageUrl: `https://pexels.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://pexels.test/${encodeURIComponent(query)}.jpg` }], downloadAsset: async () => { throw new Error('connection reset'); } };
  const webProvider = { name: 'DuckDuckGo Images', maxConcurrency: 1, search: async query => [{ id: `w-${query}`, provider: 'DuckDuckGo Images', width: 2400, height: 1400, alt: query.includes('dragon') ? `person ${query}` : query, originalImageUrl: `https://images.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://images.test/${encodeURIComponent(query)}.jpg` }], downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); } };
  const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' }, optionB: { text: 'Own a Portal Door', searchQuery: 'fantasy portal doorway' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider: pexelsProvider, webProvider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.equal(assets.every(asset => asset.provider === 'DuckDuckGo Images'), true); assert.equal(assets.every(asset => asset.webFallbackRequired), true);
    assert.match(assets.flatMap(asset => asset.rejectionReasons.flatMap(rejection => rejection.reasons)).join(' '), /connection reset/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('byte-identical downloads from different IDs and URLs are never selected twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-content-hash-'));
  const provider = {
    search: async query => ['shared', 'unique'].map((kind, position) => ({ id: `${query}-${kind}`, provider: 'Pexels', width: 2400, height: 1400, alt: query, originalImageUrl: `https://images.test/${encodeURIComponent(query)}-${kind}.jpg`, downloadUrl: `https://images.test/${encodeURIComponent(query)}-${kind}.jpg`, position })),
    downloadAsset: async (selected, destination) => {
      if (selected.id.endsWith('-shared')) fs.writeFileSync(destination, Buffer.alloc(12000, 7));
      else { const bytes = Buffer.alloc(12000, 9); bytes.write(selected.id); fs.writeFileSync(destination, bytes); }
    },
  };
  const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' }, optionB: { text: 'Own a Portal Door', searchQuery: 'fantasy portal doorway' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.equal(new Set(assets.map(asset => asset.sha256)).size, 2);
    assert.match(assets.flatMap(asset => asset.rejectionReasons.flatMap(rejection => rejection.reasons)).join(' '), /duplicate an image already selected/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
