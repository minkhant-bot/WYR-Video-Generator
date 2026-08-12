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
