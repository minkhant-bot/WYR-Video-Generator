import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCompleteCountdownSchedule, assertCompleteSfxSchedule, buildCountdownSchedule, buildNarration, buildSceneTimeline, buildSfxSchedule, createLocalSfx, generateVoiceovers, TtsGenerationError } from './audio.js';
import { WYR_TEMPLATE } from './template.js';
import { assertProductionAudioInputs } from './media.js';
import { getAudioSpec, getCountdownSequenceDuration } from './audio-spec.js';

const plan = { questions: [{ optionA: { text: 'Own a mountain cabin' }, optionB: { text: 'Travel first class every month' } }] };
test('narration reads only both choices, with no prompt prefix or percentages', () => {
  const narration = buildNarration(plan.questions[0]);
  assert.equal(narration, 'Own a mountain cabin, or travel first class every month?');
  assert.doesNotMatch(narration, /would you rather/i);
  assert.equal(buildNarration({ optionA: { text: 'Would you rather stay in a luxury hotel' }, optionB: { text: 'Would you rather camp in the wilderness?' } }), 'Stay in a luxury hotel, or camp in the wilderness?');
});
test('voice generation writes one measured file per scene', async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-')); try { const voiceovers = await generateVoiceovers({ plan, audioDir: dir, voice: 'en-US-AriaNeural', rate: '+0%', timeoutMs: 1000, ttsFactory: () => ({ call: async () => ({ data: Buffer.alloc(1200, 1), subtitles: [] }) }), measureDuration: async () => 4.25 }); assert.equal(voiceovers.length, 1); assert.equal(voiceovers[0].duration, 4.25); assert.ok(fs.statSync(voiceovers[0].localPath).size > 0); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
test('narration wording is never altered, truncated, or regenerated no matter how long the real measured duration is, and only scene 1 gets the small opening rate bump', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-voice-wording-'));
  try {
    const spokenTexts = [];
    const voiceovers = await generateVoiceovers({
      plan, audioDir: dir, voice: 'en-US-AndrewNeural', rate: '-10%', timeoutMs: 1000,
      ttsFactory: options => { assert.equal(options.rate, '-4%', 'scene 1 (the opening) must use the base rate plus the small deterministic opening bump'); return { call: async narration => { spokenTexts.push(narration); return { data: Buffer.alloc(1200, 1), subtitles: [] }; } }; },
      measureDuration: async () => 12.7, // deliberately long; must not trigger any rewording/speedup
    });
    const expectedNarration = buildNarration(plan.questions[0]);
    assert.deepEqual(spokenTexts, [expectedNarration], 'the exact text sent to TTS must be unchanged regardless of duration');
    assert.equal(voiceovers[0].narration, expectedNarration);
    assert.equal(voiceovers[0].duration, 12.7);
    assert.equal(voiceovers[0].rate, '-4%');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
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
test('a transient TTS failure on attempt 1 is retried and succeeds on attempt 2', async () => {
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

const SCENE_TAIL_SECONDS = 0.3 + WYR_TEMPLATE.timing.countdownPauseAfterVoice + getCountdownSequenceDuration() + WYR_TEMPLATE.timing.revealHoldDuration + WYR_TEMPLATE.timing.transitionOutDuration;

test('a 4.13s narration scene succeeds (and is not truncated/sped up) as long as the 6-scene total stays under the safe production ceiling', () => {
  // This is the exact narration length from the reported Railway failure. With the old fixed
  // per-scene budget (7.25-8s), SCENE_TAIL_SECONDS (~4.0s) + 4.13s alone already exceeded it. There
  // is no per-scene cap anymore -- only the whole-video total (checked in pipeline.js) matters.
  const voiceovers = [1.5, 2.0, 1.8, 2.2, 4.13, 1.6].map((duration, index) => ({ questionIndex: index, duration }));
  const timeline = buildSceneTimeline({ voiceovers, baseDuration: 7, voicePaddingSeconds: 1.5 });
  assert.equal(timeline.scenes.length, 6);
  const scene5 = timeline.scenes[4];
  assert.equal(scene5.voiceDuration, 4.13);
  assert.ok(scene5.duration >= 4.13 + SCENE_TAIL_SECONDS - 0.01, `scene 5 must be allowed to grow to fit its real 4.13s narration, got duration=${scene5.duration}`);
  assert.ok(timeline.totalDuration < 58.5, `expected the 6-scene total to stay safely under the 58.5s ceiling, got ${timeline.totalDuration}`);
});

test('different scenes are allowed different durations -- a long-narration scene borrows time instead of forcing every scene to the same size', () => {
  const voiceovers = [1.5, 4.13, 2.0, 6.0, 1.8, 2.2].map((duration, index) => ({ questionIndex: index, duration }));
  const timeline = buildSceneTimeline({ voiceovers, baseDuration: 7, voicePaddingSeconds: 1.5 });
  const durations = timeline.scenes.map(scene => scene.duration);
  assert.ok(new Set(durations).size > 1, `expected scenes to have different durations, got ${JSON.stringify(durations)}`);
  // The 6s-narration scene (index 3) must be the longest -- its extra time isn't spread evenly.
  assert.equal(durations.indexOf(Math.max(...durations)), 3);
});

test('timeline never truncates narration and begins countdown 0.10s after measured speech ends', () => { const timeline = buildSceneTimeline({ voiceovers: [{ duration: 6.2 }], baseDuration: 7, voicePaddingSeconds: 1.5 }); const scene = timeline.scenes[0]; assert.ok(scene.duration >= 7.7); assert.ok(scene.voiceStart + scene.voiceDuration < scene.duration); assert.equal(Number(scene.narrationEnd.toFixed(6)), Number((scene.voiceStart + 6.2).toFixed(6))); assert.equal(Number(scene.countdownGap.toFixed(6)), 0.1); assert.equal(Number((scene.countdownStart - scene.narrationEnd).toFixed(6)), 0.1); assert.ok(scene.revealTime >= scene.voiceStart + scene.voiceDuration); });
test('buildSceneTimeline never hard-fails an individual scene for being long -- there is no per-scene duration cap anymore', () => {
  // A single pathologically long 20s narration must NOT throw in isolation; whether the resulting
  // WHOLE-VIDEO total is safe is a separate, global decision made by pipeline.js.
  const timeline = buildSceneTimeline({ voiceovers: [{ duration: 20 }], baseDuration: 7, voicePaddingSeconds: 1.5 });
  assert.equal(timeline.scenes.length, 1);
  assert.ok(timeline.scenes[0].duration > 20);
});

// ---------------------------------------------------------------------------------------------
// Inter-scene blank gap (Fix 4): config/audio-spec.json's transitions.blankDurationSeconds was
// measured from the reference video but never wired into the timeline -- scenes ran back-to-back
// with no gap at all. buildSceneTimeline now inserts it BETWEEN scenes only.
// ---------------------------------------------------------------------------------------------
test('buildSceneTimeline inserts a frame-aligned blank gap (config/audio-spec.json transitions.blankDurationSeconds) between every pair of scenes, never before the first or after the last', () => {
  const spec = getAudioSpec();
  const expectedGap = Math.ceil(spec.transitions.blankDurationSeconds * WYR_TEMPLATE.canvas.fps) / WYR_TEMPLATE.canvas.fps;
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 6 }, () => ({ duration: 2 })), baseDuration: 7, voicePaddingSeconds: 1.5 });
  assert.equal(timeline.blankGapSeconds, expectedGap);
  assert.ok(expectedGap > 0.4 && expectedGap < 0.55, `expected approximately 0.5s, got ${expectedGap}s`);
  for (let index = 0; index < timeline.scenes.length; index += 1) {
    const scene = timeline.scenes[index];
    const isLast = index === timeline.scenes.length - 1;
    assert.equal(scene.gapAfter, isLast ? 0 : expectedGap, `scene ${index + 1} gapAfter mismatch`);
    if (!isLast) {
      const nextScene = timeline.scenes[index + 1];
      assert.equal(Number((nextScene.start - scene.end).toFixed(6)), Number(expectedGap.toFixed(6)), `expected exactly the blank gap between scene ${index + 1} and scene ${index + 2}`);
    }
  }
  // No trailing blank after the final scene's reveal hold, and totalDuration accounts for every gap.
  const lastScene = timeline.scenes[timeline.scenes.length - 1];
  assert.equal(lastScene.end, timeline.totalDuration, 'the last scene must reach exactly the total duration -- no unaccounted-for trailing gap');
  const sumOfSceneDurations = timeline.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  assert.equal(Number(timeline.totalDuration.toFixed(6)), Number((sumOfSceneDurations + expectedGap * 5).toFixed(6)), 'total duration must equal every scene duration plus exactly 5 inter-scene gaps for 6 scenes');
});
test('SFX schedule keeps visuals unchanged while separating reveal and transition sounds', () => {
  const spec = getAudioSpec();
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 8 }, () => ({ duration: 4 })), baseDuration: 7 });
  const schedule = buildSfxSchedule(timeline);
  assert.equal(schedule.eventCount, 8 * 3 - 1); // every scene gets slide+reveal+whoosh, except the last (no whoosh)
  for (const scene of timeline.scenes) {
    const events = schedule.events.filter(event => event.sceneIndex === scene.index);
    const expectedTypes = scene.isLastScene ? ['slide', 'reveal'] : ['slide', 'reveal', 'whoosh'];
    assert.deepEqual(events.map(event => event.type), expectedTypes);
    const expectedSlide = scene.index === 0
      ? scene.start
      : timeline.scenes[scene.index - 1].start + timeline.scenes[scene.index - 1].contentEnd + WYR_TEMPLATE.timing.transitionSlideDuration;
    const expectedTimestamps = [expectedSlide, scene.start + scene.revealTime + spec.reveal.sfxDelaySeconds];
    if (!scene.isLastScene) expectedTimestamps.push(scene.start + scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead);
    assert.deepEqual(events.map(event => event.timestamp), expectedTimestamps.map(value => Number(value.toFixed(6))));

    const lastTick = buildCountdownSchedule(timeline).events.filter(event => event.sceneIndex === scene.index).at(-1);
    const reveal = events.find(event => event.type === 'reveal');
    assert.ok(reveal.timestamp - lastTick.timestamp >= spec.sfx.tick.durationSeconds + spec.reveal.sfxDelaySeconds - 0.000001);

    if (scene.index > 0) {
      const previousWhoosh = schedule.events.find(event => event.sceneIndex === scene.index - 1 && event.type === 'whoosh');
      const slide = events.find(event => event.type === 'slide');
      assert.ok(slide.timestamp - previousWhoosh.timestamp >= spec.sfx.whoosh.durationSeconds, 'the whoosh must finish before the slide impact starts');
    }
  }
});
test('SFX validation fails if any scene silently loses an expected event', () => {
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 8 }, () => ({ duration: 4 })), baseDuration: 7 });
  const events = buildSfxSchedule(timeline).events.filter(event => !(event.sceneIndex === 6 && event.type === 'reveal'));
  assert.throws(() => assertCompleteSfxSchedule({ timeline, events }), /scene 7 must contain 3 events; found 2/);
});
test('SFX validation rejects duplicate and mistimed events', () => {
  const timeline = buildSceneTimeline({ voiceovers: [{ duration: 4 }, { duration: 4 }], baseDuration: 7 }); const schedule = buildSfxSchedule(timeline);
  assert.throws(() => assertCompleteSfxSchedule({ timeline, events: [...schedule.events, schedule.events[0]] }), /scene 1 must contain 3 events; found 4/);
  const mistimed = schedule.events.map(event => event.type === 'reveal' ? { ...event, timestamp: event.timestamp + 0.1 } : event);
  assert.throws(() => assertCompleteSfxSchedule({ timeline, events: mistimed }), /reveal event is not at its intended timestamp/);
});
test('the final scene never schedules a whoosh', () => {
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 3 }, () => ({ duration: 4 })), baseDuration: 7 });
  const schedule = buildSfxSchedule(timeline);
  assert.equal(schedule.events.filter(event => event.sceneIndex === 2 && event.type === 'whoosh').length, 0);
  assert.equal(schedule.events.filter(event => event.sceneIndex === 0 && event.type === 'whoosh').length, 1);
});
test('countdown schedules a tick train per scene, spaced per config/audio-spec.json, and reveals after the last tick', () => {
  const spec = getAudioSpec();
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 8 }, (_, index) => ({ duration: 4 + index * 0.25 })), baseDuration: 7 });
  const schedule = buildCountdownSchedule(timeline); assert.equal(schedule.eventCount, 8 * spec.countdown.tickCount);
  assert.equal(schedule.ticksPerScene, spec.countdown.tickCount);
  for (const scene of timeline.scenes) {
    const events = schedule.events.filter(event => event.sceneIndex === scene.index);
    assert.deepEqual(events.map(event => event.tick), Array.from({ length: spec.countdown.tickCount }, (_, index) => index + 1));
    assert.ok(events[0].sceneTime > scene.voiceStart + scene.voiceDuration);
    events.forEach((event, index) => assert.ok(Math.abs((event.sceneTime - scene.countdownStart) - index * spec.countdown.tickSpacingSeconds) < 0.000001));
    assert.equal(Number((scene.countdownStart + getCountdownSequenceDuration()).toFixed(6)), Number(scene.revealTime.toFixed(6)));
  }
});
test('countdown validation fails when any scene is missing a tick', () => {
  const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: 8 }, () => ({ duration: 4 })), baseDuration: 7 });
  const events = buildCountdownSchedule(timeline).events.filter(event => !(event.sceneIndex === 4 && event.tick === 1));
  assert.throws(() => assertCompleteCountdownSchedule({ timeline, events }), /scene 5 must contain \d+ ticks/);
});
test('countdown validation rejects a narration-to-countdown gap over 0.20s', () => {
  const timeline = buildSceneTimeline({ voiceovers: [{ duration: 4 }], baseDuration: 7 });
  const schedule = buildCountdownSchedule(timeline);
  const invalidTimeline = { ...timeline, scenes: timeline.scenes.map(scene => ({ ...scene, countdownStart: scene.countdownStart + 0.11 })) };
  assert.throws(() => assertCompleteCountdownSchedule({ timeline: invalidTimeline, events: schedule.events }), /narration-to-countdown gap is 0\.210s/);
});
test('local SFX installs the exact, cache-backed reference tick/reveal/whoosh/slide assets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-sfx-'));
  try {
    const sfx = await createLocalSfx({ audioDir: dir });
    assert.equal(sfx.provider, 'licensed-reference-extract');
    for (const name of ['tick', 'reveal', 'whoosh', 'slide']) {
      assert.equal(sfx[name].filename, `${name}.wav`);
      assert.ok(fs.statSync(sfx[name].localPath).size > 44, `${name} SFX must be a real, non-empty wav`);
      assert.ok(Number.isFinite(sfx[name].volume) && sfx[name].volume > 0, `${name} SFX must carry a computed positive volume multiplier`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('reference SFX assets never leak embedded platform/video-ID metadata into shipped WAV files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-sfx-provenance-'));
  try {
    const sfx = await createLocalSfx({ audioDir: dir });
    for (const name of ['tick', 'reveal', 'whoosh', 'slide']) {
      const bytes = fs.readFileSync(sfx[name].localPath);
      // A prior asset set embedded a short-form-video platform ID in its WAV metadata comment,
      // proving that particular WAV set had been extracted from someone else's video container.
      // That is the only thing the embedded tag is evidence of -- it does NOT establish that
      // those SFX were the cause of a real prior YouTube copyright takedown on this channel; per
      // the project owner, that takedown was actually triggered by background music, unrelated to
      // these sound effects. Regardless of that takedown's real cause, shipping WAV bytes that
      // still carry a third-party platform's own container metadata (video IDs, uploader handles,
      // etc.) is bad hygiene on its own merits, so this guard stays: shipped assets are cut from
      // raw PCM samples with container metadata stripped (see sfx-synth.js), never copied verbatim
      // from a source container, so this should always pass; it exists to catch a future regression.
      assert.doesNotMatch(bytes.toString('latin1'), /\bvid:[a-z0-9]{10,}/i, `${name} SFX contains a suspicious embedded video-ID tag`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('production and fixture audio validation cannot silently omit any of the four SFX assets', () => {
  const timeline = buildSceneTimeline({ voiceovers: [{ duration: 2.5 }], baseDuration: 7 });
  const base = { slide: { localPath: 'slide.wav' }, reveal: { localPath: 'reveal.wav' }, whoosh: { localPath: 'whoosh.wav' } }; // missing 'tick'
  assert.throws(() => assertProductionAudioInputs({ plan, timeline, sfx: base }), /all local SFX files/);
});

test('assertProductionAudioInputs verifies every SFX/voiceover file actually exists and is non-empty before render starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-audio-input-check-'));
  try {
    const timeline = buildSceneTimeline({ voiceovers: [{ duration: 2.5 }], baseDuration: 7 });
    const validSfx = await createLocalSfx({ audioDir: dir });
    // All real, non-empty, on-disk files: passes.
    assert.equal(assertProductionAudioInputs({ plan, timeline, sfx: validSfx }), true);

    // A missing file (deleted/never-written) is caught with a clear message.
    const missing = { ...validSfx, whoosh: { localPath: path.join(dir, 'does-not-exist.wav') } };
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
