import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAndDownloadImages } from './images.js';

test('image selection retries weak searches and never reuses a photo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-images-')); const calls = [];
  const candidate = id => ({ id, width: 2400, height: 1400, alt: 'mountain beach travel', photographer: 'Fixture', photographerUrl: 'https://example.test/p', photoUrl: `https://example.test/${id}`, downloadUrl: `https://example.test/${id}.jpg`, position: 0 });
  const provider = { search: async query => { calls.push(query); if (calls.length === 1) return [candidate('one')]; if (calls.length === 2) return [candidate('one')]; return [candidate('two')]; }, downloadAsset: async (_, destination) => { fs.writeFileSync(destination, Buffer.alloc(12000)); return destination; } };
  const plan = { questions: [{ index: 0, optionA: { text: 'Mountain cabin', searchQuery: 'snow mountain cabin' }, optionB: { text: 'Beach villa', searchQuery: 'tropical beach villa' } }] };
  try { const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 2 }); assert.equal(assets.length, 2); assert.equal(new Set(assets.map(asset => asset.id)).size, 2); assert.equal(assets[1].searchAttempts.length, 2); assert.ok(assets.every(asset => fs.existsSync(asset.localPath))); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Pexels search and download concurrency is bounded while output order stays deterministic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-images-concurrency-')); let activeSearches = 0; let maximumSearches = 0; let activeDownloads = 0; let maximumDownloads = 0;
  const candidate = id => ({ id, width: 2400, height: 1400, alt: id, photographer: 'Fixture', photographerUrl: 'https://example.test/p', photoUrl: `https://example.test/${id}`, downloadUrl: `https://example.test/${id}.jpg`, position: 0 });
  const provider = {
    search: async query => { activeSearches += 1; maximumSearches = Math.max(maximumSearches, activeSearches); await new Promise(resolve => setTimeout(resolve, 8)); activeSearches -= 1; return [candidate(query)]; },
    downloadAsset: async (selected, destination) => { activeDownloads += 1; maximumDownloads = Math.max(maximumDownloads, activeDownloads); await new Promise(resolve => setTimeout(resolve, 8)); fs.writeFileSync(destination, Buffer.alloc(12000, Number(selected.id.at(-1)))); activeDownloads -= 1; return destination; },
  };
  const plan = { questions: Array.from({ length: 2 }, (_, questionIndex) => ({ index: questionIndex, optionA: { text: `Alpha ${questionIndex}`, searchQuery: `query-a-${questionIndex}` }, optionB: { text: `Beta ${questionIndex}`, searchQuery: `query-b-${questionIndex}` } })) };
  try {
    const assets = await findAndDownloadImages({ plan, provider, assetsDir: dir, maxRetries: 0, concurrency: 2 });
    assert.equal(maximumSearches, 2); assert.equal(maximumDownloads, 2);
    assert.deepEqual(assets.map(asset => `${asset.questionIndex}${asset.slot}`), ['0A', '0B', '1A', '1B']);
    assert.equal(new Set(assets.map(asset => asset.id)).size, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
