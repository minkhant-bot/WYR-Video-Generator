import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCompleteCountdownSchedule, assertCompleteSfxSchedule, buildCountdownSchedule, buildNarration, buildSceneTimeline, buildSfxSchedule, createLocalSfx, generateVoiceovers, RATE_COMPRESSION_LADDER, TtsGenerationError } from './audio.js';
import { WYR_TEMPLATE } from './template.js';
import { assertProductionAudioInputs } from './media.js';

const plan = { questions: [{ optionA: { text: 'Own a mountain cabin' }, optionB: { text: 'Travel first class every month' } }] };
test('narration reads only both choices, with no prompt prefix or percentages', () => {
  const narration = buildNarration(plan.questions[0]);
  assert.equal(narration, 'Own a mountain cabin, or travel first class every month?');
  assert.doesNotMatch(narration, /would you rather/i);
  assert.equal(buildNarration({ optionA: { text: 'Would you rather stay in a luxury hotel' }, optionB: { text: 'Would you rather camp in the wilderness?' } }), 'Stay in a luxury hotel, or camp in the wilderness?');
});
test('voice generation writes one measured file per scene', async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-')); try { const voiceovers = await generateVoiceovers({ plan, audioDir: dir, voice: 'en-US-AriaNeural', rate: '+0%', timeoutMs: 1000, ttsFactory: () => ({ call: async () => ({ data: Buffer.alloc(1200, 1), subtitles: [] }) }), measureDuration: async () => 4.25 }); assert.equal(voiceovers.length, 1); assert.equal(voiceovers[0].duration, 4.25); assert.ok(fs.statSync(voiceovers[0].localPath).size > 0); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
test('voice generation enforces concurrency, uses independent clients, and preserves narration order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-concurrency-')); let active = 0; let maximumActive = 0; let clients = 0;
  const concurrentPlan = { questions: Array.from({ length: 6 }, (_, index) => ({ optionA: { text: `Choice A ${index}` }, optionB: { text: `Choice B ${index}` } })) };
  try {
    const voiceovers = await generateVoiceovers({ plan: concurrentPlan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000, concurrency: 2, ttsFactory: () => {
      clients += 1; let calls = 0;
      return { call: async narration => { calls += 1; assert.equal(calls, 1); active += 1; maximumActive = Math.max(maximumActive, active); const index = Number(narration.match(/A (\d+)/)[1]); await new Promise(resolve => setTimeout(resolve, (6 - index) * 2)); active -= 1; return { data: Buffer.alloc(1200, index + 1), subtitles: [] }; } };
    }, measureDuration: async localPath => Number(path.basename(localPath).slice(1, 3)) });
    assert.equal(maximumActive, 2); assert.equal(clients, 6);
    assert.deepEqual(voiceovers.map(voiceover => voiceover.questionIndex), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(voiceovers.map(voiceover => voiceover.duration), [1, 2, 3, 4, 5, 6]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const SCENE_TAIL_SECONDS = 0.3 + WYR_TEMPLATE.timing.countdownPauseAfterVoice + WYR_TEMPLATE.timing.countdownSequenceDuration + WYR_TEMPLATE.timing.revealHoldDuration + WYR_TEMPLATE.timing.transitionOutDuration;
const rateCompressionHarness = durationsByRate => {
  const calls = [];
  return {
    calls,
    ttsFactory: options => ({ call: async () => { calls.push(options.rate); return { data: Buffer.alloc(1200, 1), subtitles: [] }; } }),
    measureDuration: async () => durationsByRate[calls.at(-1)],
  };
};

test('narration that would blow the scene duration budget is compressed with faster (but still natural) TTS rates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-compress-'));
  try {
    const harness = rateCompressionHarness({ '-10%': 5.5, '-5%': 5.0, '+0%': 4.4, '+8%': 3.6, '+15%': 3.0, '+22%': 2.4 });
    const voiceovers = await generateVoiceovers({ plan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000, ttsFactory: harness.ttsFactory, measureDuration: harness.measureDuration, sceneDurationBudget: 7.25 });
    assert.deepEqual(harness.calls, ['-10%', '-5%', '+0%', '+8%', '+15%']);
    assert.equal(voiceovers[0].rate, '+15%');
    assert.equal(voiceovers[0].duration, 3.0);
    assert.ok(SCENE_TAIL_SECONDS + voiceovers[0].duration <= 7.25);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('narration that already fits the scene duration budget is not regenerated or sped up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-no-compress-'));
  try {
    const harness = rateCompressionHarness({ '-10%': 2.0 });
    const voiceovers = await generateVoiceovers({ plan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000, ttsFactory: harness.ttsFactory, measureDuration: harness.measureDuration, sceneDurationBudget: 7.25 });
    assert.deepEqual(harness.calls, ['-10%']);
    assert.equal(voiceovers[0].rate, '-10%');
    assert.equal(voiceovers[0].duration, 2.0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compression keeps the shortest achievable narration and never abandons or truncates audio even if the tight budget is unreachable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-compress-floor-'));
  try {
    const harness = rateCompressionHarness({ '-10%': 5.5, '-5%': 5.0, '+0%': 4.4, '+8%': 3.6, '+15%': 3.0, '+22%': 2.4 });
    const voiceovers = await generateVoiceovers({ plan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000, ttsFactory: harness.ttsFactory, measureDuration: harness.measureDuration, sceneDurationBudget: 5.0 });
    assert.deepEqual(harness.calls, ['-10%', '-5%', '+0%', '+8%', '+15%', '+22%']);
    assert.equal(voiceovers[0].rate, '+22%');
    assert.equal(voiceovers[0].duration, 2.4);
    assert.ok(fs.statSync(voiceovers[0].localPath).size > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a transient TTS failure on attempt 1 is retried and succeeds on attempt 2, without touching the duration budget path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-transient-'));
  try {
    let calls = 0;
    const voiceovers = await generateVoiceovers({
      plan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000,
      ttsFactory: () => ({ call: async () => { calls += 1; if (calls === 1) throw new Error('transient network blip'); return { data: Buffer.alloc(1200, 1), subtitles: [] }; } }),
      measureDuration: async () => 3.0,
    });
    assert.equal(calls, 2, 'the transient failure must be retried exactly once more, not abandoned');
    assert.equal(voiceovers[0].duration, 3.0);
    assert.ok(fs.statSync(voiceovers[0].localPath).size > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audio that fails ffprobe measurement (corrupt/truncated despite passing the byte-size check) is retried, and the on-disk file is never left holding the unverified bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-unmeasurable-'));
  try {
    let calls = 0;
    const voiceovers = await generateVoiceovers({
      plan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000,
      ttsFactory: () => ({ call: async () => { calls += 1; return { data: Buffer.alloc(1200, calls), subtitles: [] }; } }),
      measureDuration: async candidatePath => { if (calls === 1) throw new Error('FFprobe returned an invalid narration duration'); return 2.75; },
    });
    assert.equal(calls, 2, 'an unmeasurable candidate must be retried, not accepted as-is');
    assert.equal(voiceovers[0].duration, 2.75);
    const finalBytes = fs.readFileSync(voiceovers[0].localPath);
    assert.equal(finalBytes.equals(Buffer.alloc(1200, 2)), true, 'localPath must hold the SECOND (verified) attempt, never the first unmeasurable one');
    assert.equal(fs.readdirSync(dir).filter(name => name.includes('.candidate-')).length, 0, 'no stray unverified candidate file should be left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a scene whose narration cannot be produced after bounded retries throws TtsGenerationError and leaves no partial file behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-final-failure-'));
  try {
    await assert.rejects(
      () => generateVoiceovers({
        plan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000,
        ttsFactory: () => ({ call: async () => { throw new Error('Edge TTS service unavailable'); } }),
        measureDuration: async () => 3.0,
      }),
      error => { assert.ok(error instanceof TtsGenerationError); assert.equal(error.code, 'TTS_FAILED'); assert.match(error.message, /scene 1/); return true; },
    );
    const expectedPath = path.join(dir, 'q01-narration.mp3');
    assert.equal(fs.existsSync(expectedPath), false, 'a scene that never succeeded must never leave a partial/invalid file at its localPath');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a compression-attempt failure never aborts the scene -- the earlier successful synthesis is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-compress-fail-'));
  try {
    let compressionAttempted = false;
    const voiceovers = await generateVoiceovers({
      plan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000,
      ttsFactory: options => ({ call: async () => { if (options.rate !== '-10%') { compressionAttempted = true; throw new Error('compression attempt network blip'); } return { data: Buffer.alloc(1200, 9), subtitles: [] }; } }),
      measureDuration: async () => 6.0, sceneDurationBudget: 5.0,
    });
    assert.equal(compressionAttempted, true, 'a compression attempt must actually have been tried');
    assert.equal(voiceovers[0].rate, '-10%', 'the original (successful) rate must be kept when every compression attempt fails');
    assert.equal(voiceovers[0].duration, 6.0);
    assert.ok(fs.statSync(voiceovers[0].localPath).size > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RATE_COMPRESSION_LADDER only ever speeds narration up relative to the configured base rate', () => {
  assert.ok(RATE_COMPRESSION_LADDER.includes('-10%'));
  const sorted = [...RATE_COMPRESSION_LADDER].map(value => Number(value.replace('%', '')));
  assert.deepEqual(sorted, [...sorted].sort((left, right) => left - right));
});

// Fixed production policy: every generated video uses exactly 6 questions/scenes.
test('six scenes at the production duration budget keep the finished video comfortably under 60 seconds', () => {
  const maximumSceneDuration = 7.25;
  const voiceDuration = maximumSceneDuration - SCENE_TAIL_SECONDS - 0.05;
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 6 }, () => ({ duration: voiceDuration })), baseDuration: 7, maximumSceneDuration });
  assert.equal(timeline.scenes.length, 6);
  assert.ok(timeline.totalDuration < 60, `expected < 60s, got ${timeline.totalDuration}`);
  assert.ok(timeline.totalDuration <= 44, `expected comfortable headroom (<=44s) with only 6 scenes, got ${timeline.totalDuration}`);
  assert.ok(timeline.totalDuration >= 40);
});

test('timeline never truncates narration and begins countdown 0.10s after measured speech ends', () => { const timeline = buildSceneTimeline({ voiceovers: [{ duration: 6.2 }], baseDuration: 7, voicePaddingSeconds: 1.5, maximumSceneDuration: 11 }); const scene = timeline.scenes[0]; assert.ok(scene.duration >= 7.7); assert.ok(scene.voiceStart + scene.voiceDuration < scene.duration); assert.equal(Number(scene.narrationEnd.toFixed(6)), 6.5); assert.equal(Number(scene.countdownGap.toFixed(6)), 0.1); assert.equal(Number((scene.countdownStart - scene.narrationEnd).toFixed(6)), 0.1); assert.ok(scene.revealTime >= scene.voiceStart + scene.voiceDuration); });
test('timeline rejects narration that would create an excessive scene', () => { assert.throws(() => buildSceneTimeline({ voiceovers: [{ duration: 12 }], baseDuration: 7, voicePaddingSeconds: 1.5, maximumSceneDuration: 11 }), /exceed/); });
test('SFX schedule contains entrance, reveal, and transition at the visual timestamps in every scene', () => {
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 8 }, () => ({ duration: 4 })), baseDuration: 7 });
  const schedule = buildSfxSchedule(timeline);
  assert.equal(schedule.eventCount, 24); assert.equal(schedule.eventsPerScene, 3);
  for (const scene of timeline.scenes) {
    const events = schedule.events.filter(event => event.sceneIndex === scene.index);
    assert.deepEqual(events.map(event => event.type), ['entrance', 'reveal', 'transition']);
    assert.deepEqual(events.map(event => event.timestamp), [scene.start, scene.start + scene.revealTime, scene.start + scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead].map(value => Number(value.toFixed(6))));
  }
});
test('SFX validation fails if any scene silently loses an expected event', () => {
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 8 }, () => ({ duration: 4 })), baseDuration: 7 });
  const events = buildSfxSchedule(timeline).events.filter(event => !(event.sceneIndex === 6 && event.type === 'reveal'));
  assert.throws(() => assertCompleteSfxSchedule({ timeline, events }), /scene 7 must contain 3 events; found 2/);
});
test('SFX validation rejects duplicate and mistimed events', () => {
  const timeline = buildSceneTimeline({ voiceovers: [{ duration: 4 }], baseDuration: 7 }); const schedule = buildSfxSchedule(timeline);
  assert.throws(() => assertCompleteSfxSchedule({ timeline, events: [...schedule.events, schedule.events[0]] }), /scene 1 must contain 3 events; found 4/);
  const mistimed = schedule.events.map(event => event.type === 'reveal' ? { ...event, timestamp: event.timestamp + 0.1 } : event);
  assert.throws(() => assertCompleteSfxSchedule({ timeline, events: mistimed }), /reveal event is not at its intended timestamp/);
});
test('countdown schedules the three source cue onsets and reveals when the sequence ends in all eight scenes', () => {
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 8 }, (_, index) => ({ duration: 4 + index * 0.25 })), baseDuration: 7, maximumSceneDuration: 11 });
  const schedule = buildCountdownSchedule(timeline); assert.equal(schedule.eventCount, 24);
  for (const scene of timeline.scenes) {
    const events = schedule.events.filter(event => event.sceneIndex === scene.index);
    assert.deepEqual(events.map(event => event.number), [3, 2, 1]);
    assert.ok(events[0].sceneTime > scene.voiceStart + scene.voiceDuration);
    events.forEach((event, index) => assert.ok(Math.abs((event.sceneTime - scene.countdownStart) - WYR_TEMPLATE.timing.countdownCueOffsets[index]) < 0.000001));
    assert.equal(Number((scene.countdownStart + WYR_TEMPLATE.timing.countdownSequenceDuration).toFixed(6)), Number(scene.revealTime.toFixed(6)));
  }
});
test('countdown validation fails when any scene is missing 3, 2, or 1', () => {
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 8 }, () => ({ duration: 4 })), baseDuration: 7 });
  for (const number of [3, 2, 1]) {
    const events = buildCountdownSchedule(timeline).events.filter(event => !(event.sceneIndex === 4 && event.number === number));
    assert.throws(() => assertCompleteCountdownSchedule({ timeline, events }), /scene 5 must contain 3, 2, and 1/);
  }
});
test('countdown validation rejects a narration-to-countdown gap over 0.20s', () => {
  const timeline = buildSceneTimeline({ voiceovers: [{ duration: 4 }], baseDuration: 7 });
  const schedule = buildCountdownSchedule(timeline);
  const invalidTimeline = { ...timeline, scenes: timeline.scenes.map(scene => ({ ...scene, countdownStart: scene.countdownStart + 0.11 })) };
  assert.throws(() => assertCompleteCountdownSchedule({ timeline: invalidTimeline, events: schedule.events }), /narration-to-countdown gap is 0\.210s/);
});
test('local SFX always installs the production countdown sequence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-sfx-'));
  try {
    const sfx = await createLocalSfx({ audioDir: dir });
    assert.equal(sfx.provider, 'procedurally-generated');
    assert.equal(sfx.countdownSequence.filename, 'generated-countdown-sequence.wav');
    assert.equal(sfx.countdownSequence.duration, WYR_TEMPLATE.timing.countdownSequenceDuration);
    assert.deepEqual(fs.readFileSync(sfx.countdownSequence.localPath), fs.readFileSync(path.resolve('assets/sfx/generated-countdown-sequence.wav')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('bundled SFX assets carry no reference-video/third-party provenance and no copyrighted background music is used', () => {
  const sfxDir = path.resolve('assets/sfx');
  const files = fs.readdirSync(sfxDir).filter(name => name.endsWith('.wav'));
  assert.ok(files.length > 0);
  for (const name of files) {
    assert.doesNotMatch(name, /^reference-/, `${name} is named like an asset extracted from a reference video`);
    const bytes = fs.readFileSync(path.join(sfxDir, name));
    // A prior asset set embedded a short-form-video platform ID in its WAV metadata comment,
    // proving it was extracted from someone else's video rather than generated in-house — the
    // root cause of a real copyright takedown. Guard against that ever happening again.
    assert.doesNotMatch(bytes.toString('latin1'), /\bvid:[a-z0-9]{10,}/i, `${name} contains a suspicious embedded video-ID tag`);
  }
});
test('production and fixture audio validation cannot silently omit the countdown sequence', () => {
  const timeline = buildSceneTimeline({ voiceovers: [{ duration: 2.5 }], baseDuration: 7 });
  const base = { entrance: { localPath: 'entrance.wav' }, reveal: { localPath: 'reveal.wav' }, transition: { localPath: 'transition.wav' } };
  assert.throws(() => assertProductionAudioInputs({ plan, timeline, sfx: base }), /all local SFX files/);
});

test('assertProductionAudioInputs verifies every SFX/voiceover file actually exists and is non-empty before render starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-audio-input-check-'));
  try {
    const timeline = buildSceneTimeline({ voiceovers: [{ duration: 2.5 }], baseDuration: 7 });
    const realSfxPath = name => path.resolve('assets/sfx', name);
    const validSfx = {
      entrance: { localPath: realSfxPath('generated-scene-entrance-impact.wav') },
      reveal: { localPath: realSfxPath('generated-result-reveal-sting.wav') },
      transition: { localPath: realSfxPath('generated-scene-transition-whoosh.wav') },
      countdownSequence: { localPath: realSfxPath('generated-countdown-sequence.wav') },
    };
    // All real, non-empty, on-disk files: passes.
    assert.equal(assertProductionAudioInputs({ plan, timeline, sfx: validSfx }), true);

    // A missing file (deleted/never-written) is caught with a clear message.
    const missing = { ...validSfx, transition: { localPath: path.join(dir, 'does-not-exist.wav') } };
    assert.throws(() => assertProductionAudioInputs({ plan, timeline, sfx: missing }), /Required render input is missing/);

    // A zero-byte file (write interrupted/corrupt) is also caught, not just a missing one.
    const emptyPath = path.join(dir, 'empty.wav'); fs.writeFileSync(emptyPath, Buffer.alloc(0));
    const empty = { ...validSfx, reveal: { localPath: emptyPath } };
    assert.throws(() => assertProductionAudioInputs({ plan, timeline, sfx: empty }), /empty or unreadable/);

    // A missing voiceover file is caught the same way, before the expensive FFmpeg mix runs.
    const missingVoiceoverPath = path.join(dir, 'missing-voice.mp3');
    assert.throws(() => assertProductionAudioInputs({ plan, voiceovers: [{ questionIndex: 0, localPath: missingVoiceoverPath }], timeline, sfx: validSfx }), /Required render input is missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
