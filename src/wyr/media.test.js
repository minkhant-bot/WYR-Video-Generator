import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSceneSegments } from './media.js';

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
