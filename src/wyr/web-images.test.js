import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDuckGoImageProvider } from './web-images.js';

const tokenHtml = '<html><script>window.test={vqd="4-123456789"}</script></html>';
const imageResult = { image_token: 'image-42', title: 'Person walking through a glowing time portal', image: 'https://images.example.test/time-portal.jpg', url: 'https://example.test/story/time-travel', width: 2400, height: 1400, source: 'Bing', encoding_format: 'jpeg' };

test('DuckDuckGo provider preserves web-wide provenance and marks rights unknown', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(String(url));
    return calls.length === 1
      ? new Response(tokenHtml, { status: 200, headers: { 'content-type': 'text/html' } })
      : new Response(JSON.stringify({ results: [imageResult] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const candidates = await new DuckDuckGoImageProvider({ fetcher }).search('person walking through time portal');
  assert.equal(calls.length, 2); assert.match(calls[0], /duckduckgo\.com.*q=/); assert.match(calls[1], /duckduckgo\.com\/i\.js/);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].provider, 'DuckDuckGo Images'); assert.equal(candidates[0].providerSource, 'Bing');
  assert.equal(candidates[0].sourceDomain, 'example.test'); assert.equal(candidates[0].sourcePageUrl, imageResult.url);
  assert.equal(candidates[0].originalImageUrl, imageResult.image); assert.equal(candidates[0].width, 2400); assert.equal(candidates[0].height, 1400);
  assert.equal(candidates[0].license, 'unknown'); assert.match(candidates[0].usageRights, /verify with the source owner/);
});

test('food-photo searches prefer literal full-resolution Wikimedia Commons files without weakening web fallback', async () => {
  let duckRequests = 0;
  const pages = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [index + 1, {
    title: `File:Fried chicken plate ${index + 1}.jpg`,
    imageinfo: [{ width: 2400, height: 1600, mime: 'image/jpeg', url: `https://upload.wikimedia.org/chicken-${index + 1}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:Chicken-${index + 1}.jpg`, extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' } } }],
  }]));
  const provider = new DuckDuckGoImageProvider({ fetcher: async url => {
    if (String(url).startsWith('https://commons.wikimedia.org/')) return new Response(JSON.stringify({ query: { pages } }), { status: 200, headers: { 'content-type': 'application/json' } });
    duckRequests += 1; throw new Error('DuckDuckGo must not be needed when Commons has enough literal food photos');
  } });
  const candidates = await provider.search('fried chicken plated dish close up no people');
  assert.equal(candidates.length, 5);
  assert.equal(candidates.every(candidate => candidate.providerSource === 'Wikimedia Commons'), true);
  assert.equal(candidates.every(candidate => candidate.width === 2400 && candidate.sourceDomain === 'commons.wikimedia.org'), true);
  assert.equal(duckRequests, 0);
});

test('isolated FOOD searches ask Commons for the literal subject on a white background', async () => {
  let requestUrl = '';
  const pages = { 1: { title: 'File:Croissant white background.jpg', imageinfo: [{ width: 2000, height: 1200, mime: 'image/jpeg', url: 'https://upload.wikimedia.org/croissant.jpg' }] } };
  const provider = new DuckDuckGoImageProvider({ fetcher: async url => {
    requestUrl = String(url);
    return new Response(JSON.stringify({ query: { pages } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const candidates = await provider.search('croissant isolated white background product photo no people');
  assert.match(decodeURIComponent(requestUrl), /gsrsearch=croissant\+white\+background/);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerSource, 'Wikimedia Commons');
});

test('DuckDuckGo provider detects CAPTCHA and HTTP blocking without retrying', async () => {
  let calls = 0;
  const captcha = new DuckDuckGoImageProvider({ fetcher: async () => { calls += 1; return new Response('Verify you are human CAPTCHA', { status: 200 }); } });
  await assert.rejects(captcha.search('dragon'), /CAPTCHA or blocking page/); assert.equal(calls, 1);
  const blocked = new DuckDuckGoImageProvider({ fetcher: async () => new Response('rate limited', { status: 429 }) });
  await assert.rejects(blocked.search('portal'), /blocked with HTTP 429/);
});

test('DuckDuckGo provider enforces a hard bounded search request cap', async () => {
  let calls = 0;
  const provider = new DuckDuckGoImageProvider({ maxSearchRequests: 1, fetcher: async () => { calls += 1; return new Response(tokenHtml, { status: 200 }); } });
  await assert.rejects(provider.search('dragon'), /request limit of 1/); assert.equal(calls, 1);
});

test('DuckDuckGo image downloads validate status, content type, and minimum bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-ddg-download-')); const destination = path.join(dir, 'image.jpg');
  try {
    const candidate = { downloadUrl: 'https://images.example.test/image.jpg', sourcePageUrl: 'https://example.test/page' };
    const provider = new DuckDuckGoImageProvider({ fetcher: async () => new Response(Buffer.alloc(12_000, 3), { status: 200, headers: { 'content-type': 'image/jpeg' } }) });
    await provider.downloadAsset(candidate, destination); assert.equal(fs.statSync(destination).size, 12_000);
    const broken = new DuckDuckGoImageProvider({ fetcher: async () => new Response('not found', { status: 404 }) });
    await assert.rejects(broken.downloadAsset(candidate, destination), /HTTP 404/);
    const html = new DuckDuckGoImageProvider({ fetcher: async () => new Response(Buffer.alloc(12_000), { status: 200, headers: { 'content-type': 'text/html' } }) });
    await assert.rejects(html.downloadAsset(candidate, destination), /Unexpected web image content type/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
