import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSceneTimeline } from './audio.js';
import { hookAssets, prependHookToTimeline } from './hook.js';
import { buildAudioMixPlan } from './media.js';

test('hook prefix shifts only absolute question boundaries and starts Q1 on the next frame', () => {
  const original = buildSceneTimeline({ voiceovers: Array.from({ length: 7 }, () => ({ duration: 2 })), baseDuration: 0 });
  const timeline = prependHookToTimeline(original, { duration: 1.401 });
  assert.equal(timeline.hook.duration, 1.4333333333333333);
  assert.equal(timeline.scenes[0].start, timeline.hook.end);
  assert.equal(timeline.scenes[0].voiceStart, original.scenes[0].voiceStart);
  assert.equal(timeline.scenes[0].revealTime, original.scenes[0].revealTime);
  assert.equal(timeline.scenes[1].start - timeline.scenes[0].start, original.scenes[1].start - original.scenes[0].start);
});

test('hook voice occupies its own prefix input while question audio keeps its shifted scene timing', () => {
  const original = buildSceneTimeline({ voiceovers: Array.from({ length: 7 }, () => ({ duration: 2 })), baseDuration: 0 });
  const timeline = prependHookToTimeline(original, { duration: 1.776 });
  const schedule = { events: timeline.scenes.flatMap((scene, index) => [{ type: 'reveal', timestamp: scene.start + scene.revealTime }, ...(index < 6 ? [{ type: 'transition', timestamp: scene.start + scene.contentEnd - 0.145 }] : [])]) };
  const countdown = { events: [] };
  const mix = buildAudioMixPlan({ voiceoverCount: 7, timeline, totalDuration: timeline.totalDuration, hookVoiceover: { duration: 1.776 }, sfx: { reveal: { volume: 1 }, transition: { volume: 1 }, countdownSequence: { volume: 1 } }, schedule, countdown });
  assert.deepEqual(mix.inputOrder.slice(0, 3), ['video', 'hookVoiceover', 'voiceover0']);
  assert.ok(mix.filters.some(filter => filter.includes('[2:a]') && filter.includes(`delays=${Math.round((timeline.scenes[0].start + timeline.scenes[0].voiceStart) * 1000)}`)));
});

test('hook collage excludes both Q1 options and samples four later theme questions', () => {
  const assets = Array.from({ length: 7 }, (_, questionIndex) => ['A', 'B'].map(slot => ({ questionIndex, slot, id: `q${questionIndex}${slot}` }))).flat();
  const selected = hookAssets(assets);
  assert.deepEqual(selected.map(asset => asset.id), ['q1A', 'q2A', 'q4A', 'q5A']);
  assert.equal(selected.some(asset => asset.questionIndex === 0), false);
});
