import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildStillImageInputArgs, renderSceneSegments } from './media.js';
import { resolveFfmpegPath } from './runtime.js';

test('scene rendering enforces concurrency and preserves concat order', async () => {
  const plan = { questions: Array.from({ length: 6 }, (_, index) => ({ index })) };
  let active = 0; let maximumActive = 0; const threadValues = []; const renderDirectories = [];
  const segments = await renderSceneSegments({ plan, assets: [], duration: 7, renderDir: '/tmp/wyr-render-test', sceneConcurrency: 2, ffmpegThreads: 3, renderScene: async ({ index, ffmpegThreads, renderDir }) => {
    active += 1; maximumActive = Math.max(maximumActive, active); threadValues.push(ffmpegThreads); renderDirectories.push(renderDir);
    await new Promise(resolve => setTimeout(resolve, (6 - index) * 2)); active -= 1; return `segment-${index}.mp4`;
  } });
  assert.equal(maximumActive, 2);
  assert.deepEqual(segments, ['segment-0.mp4', 'segment-1.mp4', 'segment-2.mp4', 'segment-3.mp4', 'segment-4.mp4', 'segment-5.mp4']);
  assert.deepEqual(threadValues, [3, 3, 3, 3, 3, 3]); assert.equal(new Set(renderDirectories).size, 1);
});

test('still-image argv is provider-independent and cannot orphan demuxer loop options', () => {
  const pexels = '/tmp/q01-a-pexels.jpg'; const web = '/tmp/q01-b-web.jpg';
  assert.deepEqual(buildStillImageInputArgs(pexels, 30), ['-i', pexels]);
  assert.deepEqual(buildStillImageInputArgs(web, 30), ['-i', web]);
  const combined = [pexels, web].flatMap(localPath => buildStillImageInputArgs(localPath, 30));
  assert.deepEqual(combined, ['-i', pexels, '-i', web]);
  assert.equal(combined.some(value => value === '-loop' || value === 'loop' || value === '-stream_loop'), false);
});

test('production scene renderer accepts every Pexels/web still-image ordering', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-mixed-stills-')); const ffmpeg = resolveFfmpegPath();
  const pexelsPath = path.join(root, 'q01-a-pexels.jpg'); const webPath = path.join(root, 'q01-b-web.jpg');
  const makeJpeg = (destination, color) => {
    const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=900x600`, '-frames:v', '1', destination], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    makeJpeg(pexelsPath, 'red'); makeJpeg(webPath, 'blue');
    const combinations = [['Pexels', 'Pexels'], ['DuckDuckGo Images', 'DuckDuckGo Images'], ['Pexels', 'DuckDuckGo Images'], ['DuckDuckGo Images', 'Pexels']];
    for (const [providerA, providerB] of combinations) {
      const renderDir = path.join(root, `${providerA.startsWith('Pexels') ? 'p' : 'w'}-${providerB.startsWith('Pexels') ? 'p' : 'w'}`); fs.mkdirSync(renderDir);
      const assets = [
        { questionIndex: 0, slot: 'A', provider: providerA, localPath: providerA === 'Pexels' ? pexelsPath : webPath },
        { questionIndex: 0, slot: 'B', provider: providerB, localPath: providerB === 'Pexels' ? pexelsPath : webPath },
      ];
      const [segment] = await renderSceneSegments({ plan: { questions: [{ index: 0, optionA: { text: 'Explore Space', percentage: 55 }, optionB: { text: 'Explore Oceans', percentage: 45 } }] }, assets, duration: 1, renderDir, sceneConcurrency: 1, ffmpegThreads: 1 });
      assert.ok(fs.statSync(segment).size > 0, `${providerA}/${providerB} render is empty`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
