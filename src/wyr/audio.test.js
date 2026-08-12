import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNarration, buildSceneTimeline, generateVoiceovers } from './audio.js';

const plan = { questions: [{ optionA: { text: 'Own a mountain cabin' }, optionB: { text: 'Travel first class every month' } }] };
test('narration reads both choices but no percentages', () => { assert.equal(buildNarration(plan.questions[0]), 'Would you rather own a mountain cabin, or travel first class every month?'); });
test('voice generation writes one measured file per scene', async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-')); try { const voiceovers = await generateVoiceovers({ plan, audioDir: dir, voice: 'en-US-AriaNeural', rate: '+0%', timeoutMs: 1000, ttsFactory: () => ({ call: async () => ({ data: Buffer.alloc(1200, 1), subtitles: [] }) }), measureDuration: async () => 4.25 }); assert.equal(voiceovers.length, 1); assert.equal(voiceovers[0].duration, 4.25); assert.ok(fs.statSync(voiceovers[0].localPath).size > 0); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
test('timeline never truncates narration and delays reveal until speech ends', () => { const timeline = buildSceneTimeline({ voiceovers: [{ duration: 6.2 }], baseDuration: 7, voicePaddingSeconds: 1.5, maximumSceneDuration: 11 }); const scene = timeline.scenes[0]; assert.ok(scene.duration >= 7.7); assert.ok(scene.voiceStart + scene.voiceDuration < scene.duration); assert.ok(scene.revealTime >= scene.voiceStart + scene.voiceDuration); });
test('timeline rejects narration that would create an excessive scene', () => { assert.throws(() => buildSceneTimeline({ voiceovers: [{ duration: 12 }], baseDuration: 7, voicePaddingSeconds: 1.5, maximumSceneDuration: 11 }), /exceed/); });
