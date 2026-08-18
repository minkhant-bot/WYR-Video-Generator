import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessImageCandidate, buildAlternateImageQueries, buildImageQueries, classifyImageStats, compareImageCandidates, createImageReviewArtifacts, findAndDownloadImages, lockSelectedImageAssets } from './images.js';
import { resolveFfmpegPath } from './runtime.js';
import { buildNarration } from './audio.js';

const fixtureFfmpeg = resolveFfmpegPath();
const writeCandidate = (candidate, destination) => {
  const result = spawnSync(fixtureFfmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=800x480:rate=1', '-frames:v', '1', destination], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not create fixture image: ${result.stderr}`);
  fs.appendFileSync(destination, Buffer.from(String(candidate.id)));
};
const writeBlankCandidate = (destination) => {
  const result = spawnSync(fixtureFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=white:size=800x480:rate=1', '-frames:v', '1', destination], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not create blank fixture image: ${result.stderr}`);
};

test('image selection retries weak searches and never reuses a photo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-images-')); const calls = [];
  const candidate = id => ({ id, width: 2400, height: 1400, alt: 'mountain beach travel', photographer: 'Fixture', photographerUrl: 'https://example.test/p', photoUrl: `https://example.test/${id}`, downloadUrl: `https://example.test/${id}.jpg`, position: 0 });
  const provider = { search: async query => { calls.push(query); if (calls.length === 1) return [candidate('one')]; if (calls.length === 2) return [candidate('one')]; return [candidate('two')]; }, downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); return destination; } };
  const plan = { questions: [{ index: 0, optionA: { text: 'Mountain cabin', searchQuery: 'snow mountain cabin' }, optionB: { text: 'Beach villa', searchQuery: 'tropical beach villa' } }] };
  try { const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 2 }); assert.equal(assets.length, 2); assert.equal(new Set(assets.map(asset => asset.id)).size, 2); assert.ok(assets[1].searchAttempts.length >= 2); assert.ok(assets.every(asset => fs.existsSync(asset.localPath))); }
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

test('a fantasy illustration is accepted and not penalized merely for being illustration or AI-generated', () => {
  const option = { text: 'Befriend a Dragon' };
  const illustration = assessImageCandidate({ id: 'dragon-art', width: 2400, height: 1400, alt: 'digital fantasy art illustration of a person petting a friendly dragon', downloadUrl: 'https://images.test/dragon-art.jpg' }, option);
  assert.equal(illustration.accepted, true);
  assert.equal(illustration.pexelsQualityPassed, true);
});

test('a visually relevant illustration outranks a generic diagram/icon result for the same concept', () => {
  const option = { text: 'Befriend a Dragon' };
  const relevant = assessImageCandidate({ id: 'dragon-art', width: 2400, height: 1400, alt: 'digital fantasy art illustration of a person petting a friendly dragon', downloadUrl: 'https://images.test/dragon-art.jpg' }, option);
  const generic = assessImageCandidate({ id: 'dragon-diagram', width: 2400, height: 1400, alt: 'simple diagram of a person and a dragon symbol icon', downloadUrl: 'https://images.test/dragon-diagram.jpg' }, option);
  assert.ok(relevant.finalScore > generic.finalScore);
  assert.equal(relevant.accepted, true);
  assert.equal(compareImageCandidates({ ...relevant, provider: 'Pixabay', id: 'dragon-art' }, { ...generic, provider: 'Pixabay', id: 'dragon-diagram' }) < 0, true);
});

test('a scene-based photograph outranks a generic tech abstraction/icon result even when both are acceptable candidates', () => {
  const option = { text: 'Upload Your Consciousness' };
  const cloud = assessImageCandidate({ id: 'cloud', width: 2000, height: 1200, alt: 'abstract technology cloud icon upload icon digital network background', downloadUrl: 'https://images.test/cloud.jpg' }, option);
  const scene = assessImageCandidate({ id: 'scene', width: 2000, height: 1200, alt: 'dramatic photo of a person connected to glowing brain scanning machine consciousness transfer', downloadUrl: 'https://images.test/brain-scan.jpg' }, option);
  assert.ok(scene.finalScore > cloud.finalScore);
  assert.equal(compareImageCandidates({ ...scene, provider: 'Pixabay', id: 'scene' }, { ...cloud, provider: 'Pixabay', id: 'cloud' }) < 0, true);
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

test('final image filter rejects memes, infographics, screenshots, and generic corporate finance art', () => {
  const option = { text: 'Read Minds at Will' };
  for (const alt of ['read minds meme quote poster', 'mind reading infographic diagram chart', 'read minds mobile app screenshot UI dashboard']) {
    const result = assessImageCandidate({ id: alt, width: 2400, height: 1400, alt, downloadUrl: `https://images.test/${encodeURIComponent(alt)}.jpg` }, option);
    assert.equal(result.accepted, false); assert.match(result.rejectionReasons.join(' '), /meme|infographic|screenshot/);
  }
  const corporate = assessImageCandidate({ id: 'corporate', width: 2400, height: 1400, alt: 'generic corporate finance illustration businessman at desk', downloadUrl: 'https://images.test/corporate.jpg' }, { text: 'Lifetime of Wealth No Effort' });
  assert.equal(corporate.accepted, false); assert.equal(corporate.pexelsQualityPassed, false); assert.match(corporate.pexelsQualityReasons.join(' '), /corporate|quality/);
});

test('final image filter accepts cinematic fantasy and rejects blank image statistics', () => {
  const fantasy = assessImageCandidate({ id: 'fantasy', width: 2400, height: 1400, alt: 'cinematic person riding a dragon flying through glowing storm clouds fantasy action', downloadUrl: 'https://images.test/dragon-rider.jpg' }, { text: 'Dragon Rider' });
  assert.equal(fantasy.accepted, true); assert.equal(fantasy.pexelsQualityPassed, true);
  const blank = classifyImageStats({ width: 800, height: 480, yMin: 255, yMax: 255, yAvg: 255, edgeYAvg: 0, stdev: 0 });
  assert.equal(blank.valid, false); assert.match(blank.reasons.join(' '), /blank|uniform|placeholder/);
  const detailed = classifyImageStats({ width: 800, height: 480, yMin: 0, yMax: 255, yAvg: 60, edgeYAvg: 3, stdev: 50 });
  assert.equal(detailed.valid, true);
});

test('hard format and risky-source rules reject the observed Railway image failures before scores can rescue them', () => {
  const cases = [
    ['Read everyone\'s mind', 'eww.etsy.com', 'telepathy person reading thoughts text-heavy graphic poster'],
    ['$1M monthly forever', 'scale.jobs', 'million dollars monthly wealth promotional article thumbnail'],
    ['Save the world, lose memories', 'auctions.yahoo.co.jp', 'save the world memory auction listing image'],
    ['Wear neural interface to erase past', '01net.com', 'neural interface product UI article screenshot'],
    ['Be a unicorn that grants wishes', 'cbs8.com', 'unicorn wishes news video thumbnail screenshot'],
  ];
  for (const [text, sourceDomain, alt] of cases) {
    const result = assessImageCandidate({ id: sourceDomain, width: 2400, height: 1400, alt, title: alt, sourceDomain, sourcePageUrl: `https://${sourceDomain}/article`, downloadUrl: `https://cdn.example.test/${sourceDomain}.jpg` }, { text });
    assert.equal(result.accepted, false); assert.equal(result.hardRejected, true); assert.match(result.hardRejectionReasons.join(' '), /hard-rejected/);
  }
});

test('hard format rules preserve strong cinematic production visuals', () => {
  const strong = [
    ['Teleport instantly anywhere', 'person stepping through a glowing teleportation portal cinematic', 'images.example.test'],
    ['Own a private jet', 'cinematic private jet flying above clouds at sunset', 'images.example.test'],
    ['Own a private yacht', 'luxury private yacht sailing open ocean dramatic cinematic', 'images.example.test'],
    ['Live in a treehouse village', 'lush cinematic treehouse village in a forest canopy', 'images.example.test'],
    ['Fly to Mars', 'astronaut walking on dramatic red Mars landscape', 'images.example.test'],
    ['Explore the deepest ocean trench', 'deep ocean trench submarine cinematic underwater landscape', 'images.example.test'],
  ];
  for (const [text, alt, sourceDomain] of strong) {
    const result = assessImageCandidate({ id: text, width: 2400, height: 1400, alt, title: alt, sourceDomain, downloadUrl: `https://cdn.example.test/${encodeURIComponent(text)}.jpg` }, { text });
    assert.equal(result.hardRejected, false); assert.equal(result.accepted, true);
  }
});

test('pixel layout heuristics reject dense banner-like and text-foreground images', () => {
  const banner = classifyImageStats({ width: 2400, height: 900, yMin: 5, yMax: 250, yAvg: 120, edgeYAvg: 22, stdev: 40 });
  assert.equal(banner.valid, false); assert.match(banner.reasons.join(' '), /banner|text/);
  const textForeground = classifyImageStats({ width: 1200, height: 800, yMin: 20, yMax: 230, yAvg: 110, edgeYAvg: 12, stdev: 12 });
  assert.equal(textForeground.valid, false); assert.match(textForeground.reasons.join(' '), /text-like/);
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

test('strong Pexels result is used only after DuckDuckGo is exhausted', async () => {
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
    assert.ok(webCalls > 0); assert.equal(assets[0].selectedProvider, 'Pexels'); assert.deepEqual(assets[0].providerAttemptOrder, ['DuckDuckGo Images', 'Pexels']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('blocked web fallback uses best valid Pexels candidate and records the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-web-blocked-'));
  const weakPexels = id => ({ id: `p${id}`, provider: 'Pexels', width: 2400, height: 1400, alt: 'dramatic cinematic person stepping through a glowing teleportation portal', sourcePageUrl: `https://pexels.com/photo/p${id}`, originalImageUrl: `https://images.pexels.com/p${id}.jpg`, downloadUrl: `https://images.pexels.com/p${id}.jpg`, position: id });
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

test('bad DuckDuckGo download advances to the next bounded candidate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-web-bad-first-'));
  const pexels = { id: 'weak-pexels', provider: 'Pexels', width: 2400, height: 1400, alt: 'person beside glowing teleportation portal generic illustration', originalImageUrl: 'https://pexels.test/weak.jpg', downloadUrl: 'https://pexels.test/weak.jpg' };
  const webCandidate = (id, query) => ({ id: `${query}-${id}`, provider: 'DuckDuckGo Images', width: 2400, height: 1400, alt: 'dramatic cinematic person stepping through a glowing teleportation portal', originalImageUrl: `https://images.test/${query}-${id}.jpg`, downloadUrl: `https://images.test/${query}-${id}.jpg`, position: id === 'bad' ? 0 : 1 });
  let webSearches = 0;
  let pexelsSearches = 0; const provider = { search: async () => { pexelsSearches += 1; return [pexels]; }, downloadAsset: async () => {} };
  const webProvider = { name: 'DuckDuckGo Images', search: async query => { webSearches += 1; return [webCandidate('bad', `${query}-${webSearches}`), webCandidate('good', `${query}-${webSearches}`)]; }, downloadAsset: async (selected, destination) => selected.id.includes('-bad') ? writeBlankCandidate(destination) : writeCandidate(selected, destination) };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' }, optionB: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.equal(assets.every(asset => asset.id.endsWith('-good')), true); assert.equal(pexelsSearches, 0); assert.match(assets[0].rejectionReasons.flatMap(item => item.reasons).join(' '), /downloaded image rejected/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('all blank candidates fail image selection clearly after bounded fallback attempts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-all-blank-'));
  const pexels = { id: 'weak-pexels', provider: 'Pexels', width: 2400, height: 1400, alt: 'person beside glowing teleportation portal generic illustration', originalImageUrl: 'https://pexels.test/weak.jpg', downloadUrl: 'https://pexels.test/weak.jpg' };
  const web = id => ({ id, provider: 'DuckDuckGo Images', width: 2400, height: 1400, alt: 'dramatic cinematic person stepping through a glowing teleportation portal', originalImageUrl: `https://images.test/${id}.jpg`, downloadUrl: `https://images.test/${id}.jpg`, position: id });
  const provider = { search: async () => [pexels], downloadAsset: async (_selected, destination) => writeBlankCandidate(destination) };
  const webProvider = { name: 'DuckDuckGo Images', search: async () => [web(0), web(1)], downloadAsset: async (_selected, destination) => writeBlankCandidate(destination) };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' }, optionB: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' } }] };
  try { await assert.rejects(findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 0, concurrency: 2 }), /No downloadable relevant image found/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a broken DuckDuckGo result invokes Pexels fallback after download validation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-broken-pexels-'));
  const pexelsProvider = { search: async query => [{ id: `p-${query}`, provider: 'Pexels', width: 2400, height: 1400, alt: query.includes('dragon') ? 'person petting friendly fantasy dragon creature' : 'person beside a fantasy portal doorway opening into another world', originalImageUrl: `https://pexels.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://pexels.test/${encodeURIComponent(query)}.jpg` }], downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); } };
  const webProvider = { name: 'DuckDuckGo Images', maxConcurrency: 1, search: async query => [{ id: `w-${query}`, provider: 'DuckDuckGo Images', width: 3000, height: 1800, alt: query.includes('dragon') ? 'person petting friendly fantasy dragon creature' : 'person beside a fantasy portal doorway opening into another world', originalImageUrl: `https://images.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://images.test/${encodeURIComponent(query)}.jpg` }], downloadAsset: async () => { throw new Error('connection reset'); } };
  const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' }, optionB: { text: 'Own a Portal Door', searchQuery: 'fantasy portal doorway' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider: pexelsProvider, webProvider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.equal(assets.every(asset => asset.provider === 'Pexels'), true); assert.equal(assets.every(asset => asset.webFallbackRequired), true);
    assert.match(assets.flatMap(asset => asset.rejectionReasons.flatMap(rejection => rejection.reasons)).join(' '), /connection reset/); assert.match(assets[0].fallbackReason, /connection reset/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a candidate whose crop cannot be made safely is rejected for framing reasons and the pipeline falls back to the next ranked candidate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-framing-fallback-'));
  const portalCandidate = (id, position) => ({ id, width: 2400, height: 1400, alt: 'dramatic photograph of a person stepping through a glowing teleportation portal', photographer: 'Fixture', photographerUrl: 'https://example.test/p', photoUrl: `https://example.test/${id}`, downloadUrl: `https://example.test/${id}.jpg`, position });
  const otherCandidate = { id: 'other', width: 2400, height: 1400, alt: 'dramatic photograph of frozen time in a busy city street', photographer: 'Fixture', photographerUrl: 'https://example.test/p', photoUrl: 'https://example.test/other', downloadUrl: 'https://example.test/other.jpg', position: 0 };
  const provider = {
    search: async query => query.includes('teleport') ? [portalCandidate('first', 0), portalCandidate('second', 1)] : [otherCandidate],
    downloadAsset: async (selected, destination) => { writeCandidate(selected, destination); return destination; },
  };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere', searchQuery: 'teleportation portal' }, optionB: { text: 'Freeze Time For A Day', searchQuery: 'frozen clock city dramatic' } }] };
  // Simulates framing.js rejecting exactly one candidate's crop as unsafe -- proves the rejection
  // routes through the same pool/fallback machinery as a broken download, without ever touching
  // relevance scoring, provider order, or dedupe.
  const rejectedPaths = []; const computeCrop = async ({ localPath }) => {
    if (localPath.includes('-first')) { rejectedPaths.push(localPath); return { safe: false, reason: 'framing rejected: synthetic test rejection' }; }
    return { safe: true, x: 3, y: 5, coverWidth: 900, coverHeight: 450 };
  };
  try {
    const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 2, computeCrop });
    assert.equal(assets.length, 2);
    const teleportAsset = assets.find(asset => asset.slot === 'A');
    assert.equal(teleportAsset.id, 'second', `expected the framing-unsafe "first" candidate to be skipped in favor of "second"; got ${teleportAsset.id}`);
    assert.deepEqual(teleportAsset.framing, { x: 3, y: 5, coverWidth: 900, coverHeight: 450 });
    assert.equal(rejectedPaths.length, 1, 'expected the framing check to run exactly once against the rejected candidate before falling back');
    assert.ok(teleportAsset.rejectionReasons.some(rejection => rejection.id === 'first' && rejection.reasons.some(reason => reason.includes('framing rejected'))));
    assert.ok(fs.existsSync(teleportAsset.localPath));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('byte-identical downloads from different IDs and URLs are never selected twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-content-hash-'));
  const provider = {
    search: async query => ['shared', 'unique'].map((kind, position) => ({ id: `${query}-${kind}`, provider: 'Pexels', width: 2400, height: 1400, alt: query, originalImageUrl: `https://images.test/${encodeURIComponent(query)}-${kind}.jpg`, downloadUrl: `https://images.test/${encodeURIComponent(query)}-${kind}.jpg`, position })),
    downloadAsset: async (selected, destination) => {
      writeCandidate({ id: selected.id.endsWith('-shared') ? 'shared' : selected.id }, destination);
    },
  };
  const plan = { questions: [{ index: 0, optionA: { text: 'Befriend a Dragon', searchQuery: 'friendly fantasy dragon' }, optionB: { text: 'Own a Portal Door', searchQuery: 'fantasy portal doorway' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.equal(new Set(assets.map(asset => asset.sha256)).size, 2);
    assert.match(assets.flatMap(asset => asset.rejectionReasons.flatMap(rejection => rejection.reasons)).join(' '), /duplicate an image already selected/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('image candidate ranking is deterministic with explicit tie breakers', () => {
  const base = { qualityScore: 80, relevanceScore: 70, width: 1600, height: 900 };
  const candidates = [
    { ...base, provider: 'DuckDuckGo Images', id: 'z', originalImageUrl: 'https://z.test/image.jpg' },
    { ...base, provider: 'Pexels', id: 'b', originalImageUrl: 'https://b.test/image.jpg' },
    { ...base, provider: 'Pexels', id: 'a', originalImageUrl: 'https://a.test/image.jpg' },
  ];
  const first = [...candidates].sort(compareImageCandidates).map(candidate => candidate.id);
  const second = [...candidates].reverse().sort(compareImageCandidates).map(candidate => candidate.id);
  assert.deepEqual(first, ['z', 'a', 'b']); assert.deepEqual(second, first);
});

test('selection ranks the full accepted pool instead of taking the first acceptable candidate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-ranked-pool-'));
  const candidate = (id, alt, position) => ({ id, provider: 'Pexels', width: 2400, height: 1400, alt, originalImageUrl: `https://images.test/${id}.jpg`, downloadUrl: `https://images.test/${id}.jpg`, position });
  const provider = { search: async () => [candidate('weak', 'person near a glowing portal doorway', 0), candidate('strong', 'dramatic cinematic person stepping through a glowing teleportation portal', 1)], downloadAsset: async (selected, destination) => writeCandidate(selected, destination) };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere' }, optionB: { text: 'Teleport Anywhere' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 0, concurrency: 1 });
    assert.equal(assets[0].id, 'strong');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('query variants are stable and selected metadata records exact order and candidate counts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-deterministic-queries-')); const queries = [];
  const provider = { search: async query => { queries.push(query); return [{ id: `p-${query}`, provider: 'Pexels', width: 2400, height: 1400, alt: 'person entering glowing teleportation portal', originalImageUrl: `https://images.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://images.test/${encodeURIComponent(query)}.jpg` }]; }, downloadAsset: async (selected, destination) => writeCandidate(selected, destination) };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere' }, optionB: { text: 'Teleport Anywhere' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 2, concurrency: 1 });
    assert.deepEqual(assets[0].queryOrder, ['person entering glowing teleportation portal', 'person stepping through portal cinematic', 'teleportation gateway person dramatic', 'teleport']);
    assert.equal(assets[0].candidateCount, 4); assert.deepEqual(queries, assets.flatMap(asset => asset.queryOrder));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('selected image files are hash-locked and review contact sheet uses the locked copies', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-image-lock-')); const sourceDir = path.join(workspace, 'assets'); fs.mkdirSync(sourceDir, { recursive: true });
  const sourceA = path.join(sourceDir, 'a.jpg'); const sourceB = path.join(sourceDir, 'b.jpg'); writeCandidate({ id: 'a' }, sourceA); writeCandidate({ id: 'b' }, sourceB);
  const crypto = await import('node:crypto'); const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const assets = [{ questionIndex: 0, slot: 'A', text: 'Teleport Anywhere', provider: 'Pexels', id: 'a', queryUsed: 'portal', sourceDomain: 'pexels.com', localPath: sourceA, sha256: hash(sourceA) }, { questionIndex: 0, slot: 'B', text: 'Stop Time', provider: 'DuckDuckGo Images', id: 'b', queryUsed: 'frozen time', sourceDomain: 'example.test', localPath: sourceB, sha256: hash(sourceB) }];
  try {
    const locked = lockSelectedImageAssets({ assets, workspace }); assert.equal(locked.every(asset => asset.locked), true); assert.ok(locked.every(asset => fs.existsSync(asset.localPath)));
    const review = await createImageReviewArtifacts({ assets: locked, workspace }); assert.ok(fs.statSync(review.contactSheetPath).size > 0); assert.equal(path.basename(review.selectedImagesDir), 'selected-images');
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'review', 'selected-images.json'))); assert.deepEqual(manifest.map(asset => asset.sha256), locked.map(asset => asset.sha256));
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('normal image failure recovers one slot with bounded alternate visual queries and preserves accepted slots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-image-recovery-alt-')); const downloads = []; const searches = [];
  const good = (id, alt) => ({ id, provider: 'Pexels', width: 2400, height: 1400, alt, originalImageUrl: `https://images.test/${id}.jpg`, downloadUrl: `https://images.test/${id}.jpg` });
  const provider = {
    search: async query => { searches.push(query); if (query.includes('levitating')) return [good('gravity-recovered', 'person controlling gravity objects levitating cinematic')]; if (query.includes('teleport')) return [good('teleport-original', 'dramatic cinematic person stepping through a glowing teleportation portal')]; return [{ id: `weak-${query}`, provider: 'Pexels', width: 2400, height: 1400, alt: 'generic office stock', originalImageUrl: `https://images.test/weak-${encodeURIComponent(query)}.jpg`, downloadUrl: `https://images.test/weak-${encodeURIComponent(query)}.jpg` }]; },
    downloadAsset: async (selected, destination) => { downloads.push(selected.id); writeCandidate(selected, destination); },
  };
  const webProvider = { name: 'DuckDuckGo Images', search: async () => [], downloadAsset: async () => {} };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere' }, optionB: { text: 'Control Gravity' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 0, concurrency: 1, recovery: { alternateQueryRounds: 3, maxProviderRequests: 20, maxWallClockMs: 5000 } });
    assert.equal(assets[0].id, 'teleport-original'); assert.equal(assets[0].text, 'Teleport Anywhere'); assert.equal(assets[1].id, 'gravity-recovered'); assert.equal(assets[1].text, 'Control Gravity');
    assert.equal(downloads.filter(id => id === 'teleport-original').length, 1); assert.ok(searches.some(query => query.includes('levitating')));
    assert.deepEqual(buildAlternateImageQueries({ text: 'Control Gravity' }).length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('alternate exhaustion invokes Groq visual reformulation once and recovers with DuckDuckGo first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-image-recovery-groq-')); let groqCalls = 0; const queries = []; const searchOrder = [];
  const candidate = (id, alt) => ({ id, provider: 'Pexels', width: 2400, height: 1400, alt, originalImageUrl: `https://images.test/${id}.jpg`, downloadUrl: `https://images.test/${id}.jpg` });
  const provider = { search: async query => { queries.push(query); searchOrder.push(`Pexels:${query}`); if (query.includes('human controlling gravity')) return [candidate('groq-recovered', 'human controlling gravity objects levitating cinematic')]; if (query.includes('lightning')) return [candidate('lightning-original', 'person controlling lightning dramatic cinematic electricity')]; return [candidate(`weak-${queries.length}`, 'generic office stock')]; }, downloadAsset: async (selected, destination) => writeCandidate(selected, destination) };
  const visualQueryProvider = { generateVisualQueries: async ({ optionText, attemptedQueries }) => { groqCalls += 1; assert.equal(optionText, 'Control Gravity'); assert.ok(attemptedQueries.length >= 2); return ['human controlling gravity objects levitating cinematic']; } };
  const webProvider = { name: 'DuckDuckGo Images', search: async query => { searchOrder.push(`DuckDuckGo Images:${query}`); return []; }, downloadAsset: async () => {} };
  const plan = { questions: [{ index: 0, optionA: { text: 'Control Gravity' }, optionB: { text: 'Control Lightning' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, visualQueryProvider, assetsDir: dir, maxRetries: 0, concurrency: 1, recovery: { alternateQueryRounds: 1, maxProviderRequests: 24, maxWallClockMs: 5000 } });
    assert.equal(groqCalls, 1); assert.equal(assets[0].text, 'Control Gravity'); assert.equal(assets[0].narration, undefined); assert.equal(assets[0].queryUsed, 'human controlling gravity objects levitating cinematic');
    assert.equal(buildNarration(plan.questions[0]), 'Control Gravity, or control Lightning?');
    const groqIndex = searchOrder.findIndex(entry => entry.endsWith('human controlling gravity objects levitating cinematic'));
    assert.deepEqual(searchOrder.slice(groqIndex, groqIndex + 2).map(entry => entry.split(':')[0]), ['DuckDuckGo Images', 'Pexels']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recovery keeps the strict downloaded-image quality gate and reports bounded exhaustion details', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-image-recovery-bounded-')); let calls = 0;
  const blankCandidate = query => ({ id: `blank-${calls}`, provider: 'Pexels', width: 2400, height: 1400, alt: query.includes('gravity') ? 'person controlling gravity objects levitating cinematic' : 'generic office stock', originalImageUrl: `https://images.test/blank-${calls}.jpg`, downloadUrl: `https://images.test/blank-${calls}.jpg` });
  const provider = { search: async query => { calls += 1; return query.includes('lightning') ? [{ id: 'keep-lightning', provider: 'Pexels', width: 2400, height: 1400, alt: 'person controlling lightning dramatic cinematic electricity', originalImageUrl: 'https://images.test/keep-lightning.jpg', downloadUrl: 'https://images.test/keep-lightning.jpg' }] : [blankCandidate(query)]; }, downloadAsset: async (selected, destination) => selected.id === 'keep-lightning' ? writeCandidate(selected, destination) : writeBlankCandidate(destination) };
  const visualQueryProvider = { generateVisualQueries: async () => { calls += 1; throw Object.assign(new Error('HTTP 429 blocked'), { status: 429, code: 'rate_limit_exceeded' }); } };
  const plan = { questions: [{ index: 0, optionA: { text: 'Control Gravity' }, optionB: { text: 'Control Lightning' } }] };
  try {
    await assert.rejects(() => findAndDownloadImages({ plan, provider, visualQueryProvider, assetsDir: dir, maxRetries: 0, concurrency: 1, recovery: { alternateQueryRounds: 1, maxProviderRequests: 4, maxWallClockMs: 5000 } }), error => {
      assert.match(error.message, /question 1, option A \(Control Gravity\)/); assert.match(error.message, /Queries attempted:/); assert.match(error.message, /Provider attempts:/); assert.match(error.message, /downloaded image rejected/); assert.match(error.message, /Request count:/); assert.match(error.message, /Recovery elapsed:/); return true;
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('strong DuckDuckGo candidates are primary and never call Pexels', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-web-primary-')); let pexelsSearches = 0; let pexelsDownloads = 0;
  const provider = { search: async () => { pexelsSearches += 1; throw new Error('Pexels must remain untouched when DuckDuckGo succeeds'); }, downloadAsset: async () => { pexelsDownloads += 1; } };
  const webProvider = { name: 'DuckDuckGo Images', search: async query => [{ id: `web-${query}`, provider: 'DuckDuckGo Images', width: 3000, height: 1800, alt: query.includes('dragon') ? 'person petting friendly fantasy dragon creature' : 'dramatic cinematic person stepping through a glowing teleportation portal', originalImageUrl: `https://images.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://images.test/${encodeURIComponent(query)}.jpg`, sourceDomain: 'example.test' }], downloadAsset: async (selected, destination) => writeCandidate(selected, destination) };
  const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere' }, optionB: { text: 'Befriend a Dragon' } }] };
  try {
    const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 0, concurrency: 1 });
    assert.equal(pexelsSearches, 0); assert.equal(pexelsDownloads, 0); assert.equal(assets.every(asset => asset.selectedProvider === 'DuckDuckGo Images'), true);
    assert.deepEqual(assets[0].providerAttemptOrder, ['DuckDuckGo Images', 'Pexels']); assert.equal(assets[0].fallbackReason, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DuckDuckGo exhaustion or timeout falls back to strict Pexels candidates with provenance', async () => {
  for (const failure of ['no acceptable candidate', 'Request timed out after 12000ms']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-web-to-pexels-')); let pexelsSearches = 0;
    const provider = { search: async query => { pexelsSearches += 1; const alt = query.includes('frozen') || query.includes('time') ? 'person walking through frozen time city scene' : 'dramatic cinematic person stepping through a glowing teleportation portal'; return [{ id: `pexels-${query}`, provider: 'Pexels', width: 2400, height: 1400, alt, originalImageUrl: `https://pexels.test/${encodeURIComponent(query)}.jpg`, downloadUrl: `https://pexels.test/${encodeURIComponent(query)}.jpg` }]; }, downloadAsset: async (selected, destination) => writeCandidate(selected, destination) };
    const webProvider = { name: 'DuckDuckGo Images', search: async () => { if (failure.includes('timed out')) throw new Error(failure); return []; }, downloadAsset: async () => {} };
    const plan = { questions: [{ index: 0, optionA: { text: 'Teleport Anywhere' }, optionB: { text: 'Stop Time' } }] };
    try {
      const assets = await findAndDownloadImages({ plan, provider, webProvider, assetsDir: dir, maxRetries: 0, concurrency: 1 });
      assert.ok(pexelsSearches > 0); assert.equal(assets[0].selectedProvider, 'Pexels'); assert.match(assets[0].fallbackReason, failure.includes('timed out') ? /timed out/ : /no acceptable/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
