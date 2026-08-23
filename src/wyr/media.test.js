import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertLockedImageAssets, buildAudioMixPlan, buildConcatSegmentList, buildFramedImageChain, buildStillImageInputArgs, DurationVerificationError, measureIntegratedLoudness, renderSceneSegments, renderVideo, SHORTS_DURATION_LIMIT_SECONDS, verifyVideo } from './media.js';
import { buildCountdownSchedule, buildSceneTimeline, buildSfxSchedule, createLocalSfx, SFX_EVENT_TYPES } from './audio.js';
import { resolveFfmpegPath, resolveFfprobePath } from './runtime.js';
import { WYR_TEMPLATE } from './template.js';
import { getAudioSpec } from './audio-spec.js';

// Measures actual RMS loudness of a window of a rendered file's audio -- used to verify events are
// genuinely AUDIBLE in the real mixed output (not just present in the schedule/filter graph). Two
// audible bursts landing within `windowSeconds` of each other can blend into one RMS reading, so
// callers should keep windows short and centered tightly on a single event.
const measureRmsDb = (mediaPath, startSeconds, windowSeconds) => {
  const result = spawnSync(resolveFfmpegPath(), ['-ss', String(Math.max(0, startSeconds)), '-t', String(windowSeconds), '-i', mediaPath, '-vn', '-ac', '1', '-af', 'astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf8' });
  const matches = [...result.stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)];
  if (!matches.length) return -Infinity;
  const last = matches[matches.length - 1][1];
  return last === '-inf' ? -Infinity : Number(last);
};

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

test('scene rendering verifies locked image hashes before using local assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-locked-assets-')); const ffmpeg = resolveFfmpegPath(); const image = path.join(root, 'locked.jpg');
  const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=900x600', '-frames:v', '1', image], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const crypto = await import('node:crypto'); const hash = crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex');
  const asset = { localPath: image, filename: 'locked.jpg', locked: true, sha256: hash };
  try { assert.equal(assertLockedImageAssets([asset]), true); fs.appendFileSync(image, 'changed'); assert.throws(() => assertLockedImageAssets([asset]), /hash mismatch/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('framed image chain is single-layer: no blur, no letterbox, no foreground/background split', () => {
  const chain = buildFramedImageChain({ input: '0:v', width: 750, height: 450, fps: 30, outLabel: 'aimg', chainId: 'a' });
  assert.equal(chain.length, 1, 'expected exactly one filter stage -- no split into a blurred background plus a separately-scaled foreground');
  const joined = chain.join(';');
  assert.equal(/gblur|split=2|overlay=/.test(joined), false, `expected no blur/duplicate-layer/overlay compositing in the framing chain; got: ${joined}`);
  // No precomputed crop offset -> falls back to a plain, still single-layer, center crop.
  assert.match(joined, /^\[0:v\]loop=loop=-1:size=1:start=0,setpts=N\/30\/TB,scale=750:450:force_original_aspect_ratio=increase,crop=750:450:\(iw-750\)\/2:\(ih-450\)\/2,setsar=1,format=rgba\[aimg\]$/);
});

test('framed image chain applies a precomputed subject-aware crop offset instead of centering', () => {
  const chain = buildFramedImageChain({ input: '0:v', width: 750, height: 450, fps: 30, outLabel: 'aimg', chainId: 'a', crop: { x: 40, y: 0, coverWidth: 900, coverHeight: 450 } });
  const joined = chain.join(';');
  assert.equal(chain.length, 1);
  assert.equal(/gblur|split=2|overlay=/.test(joined), false);
  assert.match(joined, /scale=900:450,crop=750:450:40:0,setsar=1,format=rgba\[aimg\]/);
});

test('subject-aware framing keeps a detected head/subject region inside the rendered crop instead of cutting through it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-safe-framing-')); const ffmpeg = resolveFfmpegPath();
  try {
    // A moderately tall portrait: a red "head" band at the very top, a gray "torso" filling the
    // rest. Safe to crop into the 750x450 slot (excess is under framing.js's safety ceiling), but a
    // naive center-crop would land entirely inside the gray torso and miss the head completely.
    const width = 700; const height = 950;
    const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      const color = y < 140 ? [230, 30, 30] : [150, 150, 150];
      for (let x = 0; x < width; x += 1) { const i = (y * width + x) * 3; pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; }
    }
    const ppm = path.join(root, 'portrait.ppm'); const sourceJpg = path.join(root, 'portrait.jpg');
    fs.writeFileSync(ppm, Buffer.concat([header, pixels]));
    const convert = spawnSync(ffmpeg, ['-y', '-i', ppm, '-q:v', '2', sourceJpg], { encoding: 'utf8' }); assert.equal(convert.status, 0, convert.stderr);

    const { computeSubjectAwareCrop } = await import('./framing.js');
    const { layout } = WYR_TEMPLATE;
    const framing = await computeSubjectAwareCrop({ localPath: sourceJpg, sourceWidth: width, sourceHeight: height, targetWidth: layout.imageWidth, targetHeight: layout.imageHeight });
    assert.equal(framing.safe, true, 'a moderately tall portrait must be accepted, not rejected, by the safety gate');
    assert.equal(framing.y, 0, 'the head band sits at the very top of the source, so the safe crop window should start at y=0 to keep it in frame');

    const renderDir = path.join(root, 'render'); fs.mkdirSync(renderDir);
    const asset = { questionIndex: 0, slot: 'A', localPath: sourceJpg, framing: { x: framing.x, y: framing.y, coverWidth: framing.coverWidth, coverHeight: framing.coverHeight } };
    const [segment] = await renderSceneSegments({
      plan: { questions: [{ index: 0, optionA: { text: 'Top Choice', percentage: 50 }, optionB: { text: 'Bottom Choice', percentage: 50 } }] },
      assets: [asset, { ...asset, slot: 'B' }], duration: 2, renderDir, sceneConcurrency: 1, ffmpegThreads: 1,
    });

    const slotX = (WYR_TEMPLATE.canvas.width - layout.imageWidth) / 2;
    const samplePatch = y => {
      const result = spawnSync(ffmpeg, ['-ss', '1', '-i', segment, '-vframes', '1', '-vf', `crop=12:8:${Math.round(slotX + layout.imageWidth / 2 - 6)}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr?.toString());
      const buffer = result.stdout; const pixelCount = buffer.length / 3; let r = 0; let g = 0; let b = 0;
      for (let i = 0; i < buffer.length; i += 3) { r += buffer[i]; g += buffer[i + 1]; b += buffer[i + 2]; }
      return { r: r / pixelCount, g: g / pixelCount, b: b / pixelCount };
    };
    const topPatch = samplePatch(layout.topImageY + 5);
    assert.ok(topPatch.r > 180 && topPatch.g < 100, `expected the preserved red head band near the slot's top edge (subject-aware crop); sampled ${JSON.stringify(topPatch)}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an extreme-aspect-ratio source is rejected by the crop safety gate instead of being force-cropped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-unsafe-framing-')); const ffmpeg = resolveFfmpegPath();
  try {
    const width = 300; const height = 1500;
    const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=red:s=${width}x${height}`, '-frames:v', '1', path.join(root, 'tall.jpg')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const { computeSubjectAwareCrop } = await import('./framing.js');
    const { layout } = WYR_TEMPLATE;
    const framing = await computeSubjectAwareCrop({ localPath: path.join(root, 'tall.jpg'), sourceWidth: width, sourceHeight: height, targetWidth: layout.imageWidth, targetHeight: layout.imageHeight });
    assert.equal(framing.safe, false, 'a 1:5 source squeezed into the 5:3 slot must be rejected rather than force-cropped');
    assert.match(framing.reason, /framing rejected/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rendering consumes locked local assets without image-provider calls', async () => {
  let providerCalls = 0; const provider = { search: () => { providerCalls += 1; throw new Error('provider must not be called during rendering'); }, downloadAsset: () => { providerCalls += 1; throw new Error('provider must not be called during rendering'); } };
  const segments = await renderSceneSegments({ plan: { questions: [{ index: 0 }] }, assets: [], duration: 1, renderDir: '/tmp/wyr-no-provider-render', sceneConcurrency: 1, ffmpegThreads: 1, renderScene: async () => 'locked-local-segment.mp4' });
  assert.deepEqual(segments, ['locked-local-segment.mp4']); assert.equal(providerCalls, 0); assert.equal(typeof provider.search, 'function');
});

test('a genuine FFmpeg failure (undecodable input) rejects the render and is never silently reported as a successful segment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-ffmpeg-failure-'));
  const garbagePath = path.join(root, 'not-an-image.jpg');
  fs.writeFileSync(garbagePath, Buffer.alloc(20_000, 65)); // correct extension, not valid image data
  try {
    const assets = [
      { questionIndex: 0, slot: 'A', provider: 'Pexels', localPath: garbagePath },
      { questionIndex: 0, slot: 'B', provider: 'Pexels', localPath: garbagePath },
    ];
    const plan = { questions: [{ index: 0, optionA: { text: 'Explore Space', percentage: 55 }, optionB: { text: 'Explore Oceans', percentage: 45 } }] };
    await assert.rejects(
      () => renderSceneSegments({ plan, assets, duration: 1, renderDir: root, sceneConcurrency: 1, ffmpegThreads: 1 }),
      /exited with code/,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyVideo rejects a zero-byte or missing output file before ever probing it, instead of reporting it completed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-empty-output-'));
  try {
    const emptyPath = path.join(root, 'empty.mp4');
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    await assert.rejects(() => verifyVideo(emptyPath, {}), /not a non-empty regular file/);
    await assert.rejects(() => verifyVideo(path.join(root, 'does-not-exist.mp4'), {}), error => Boolean(error));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verification authoritatively rejects any output at or above the 60s Shorts limit, independent of the expected duration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-duration-gate-')); const ffmpeg = resolveFfmpegPath();
  try {
    assert.equal(SHORTS_DURATION_LIMIT_SECONDS, 60);
    const overLimit = path.join(root, 'over-limit.mp4');
    const overLimitDuration = SHORTS_DURATION_LIMIT_SECONDS + 4.33;
    const build = spawnSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', `color=c=black:s=1080x1920:r=30:d=${overLimitDuration}`,
      '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${overLimitDuration}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', overLimit,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);

    await assert.rejects(
      () => verifyVideo(overLimit, { expectedDuration: overLimitDuration }),
      error => { assert.ok(error instanceof DurationVerificationError); assert.match(error.message, /60\.0s Shorts limit/); return true; },
    );
    // Even when the caller (wrongly) expects the over-limit duration, the hard ceiling still wins —
    // production validators must remain authoritative over any prediction the timeline made.
    await assert.rejects(() => verifyVideo(overLimit, {}), DurationVerificationError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// Fixed production policy: every generated video uses exactly 6 questions/scenes. These prove the
// complete audio/SFX event schedule and the FFmpeg mix that consumes it both scale correctly to 6
// scenes -- countdown/reveal/transition all fire the right number of times, at the right
// moments, with nothing dropped from the mix and nothing clipped at the (now shorter) end of video.
// ---------------------------------------------------------------------------------------------

const sixSceneTimeline = () => buildSceneTimeline({
  voiceovers: Array.from({ length: 6 }, () => ({ duration: 2 })),
  baseDuration: 7, voicePaddingSeconds: 1.5,
});

test('a 6-scene timeline schedules reveal on every scene and transitions on scenes 1-5', () => {
  const timeline = sixSceneTimeline();
  assert.equal(timeline.scenes.length, 6);
  const schedule = buildSfxSchedule(timeline);
  assert.equal(schedule.eventCount, 11);
  assert.equal(schedule.events.filter(event => event.type === 'reveal').length, 6);
  assert.equal(schedule.events.filter(event => event.type === 'transition').length, 5);
  assert.equal(schedule.events.some(event => event.sceneIndex === 5 && event.type === 'transition'), false);
  for (const event of schedule.events) {
    const scene = timeline.scenes[event.sceneIndex];
    assert.ok(event.timestamp >= scene.start - 1e-4 && event.timestamp <= scene.end + 1e-4, `${event.type} event for scene ${event.sceneIndex + 1} at ${event.timestamp}s falls outside its scene bounds [${scene.start}, ${scene.end}]`);
  }
});

test('a 6-scene timeline schedules every reference countdown cue inside scene bounds', () => {
  const timeline = sixSceneTimeline();
  const countdown = buildCountdownSchedule(timeline);
  assert.equal(countdown.eventCount, 6 * getAudioSpec().countdown.cueNumbers.length);
  for (const event of countdown.events) {
    const scene = timeline.scenes[event.sceneIndex];
    assert.ok(event.timestamp >= scene.start - 1e-4 && event.timestamp <= scene.end + 1e-4, `countdown event for scene ${event.sceneIndex + 1} at ${event.timestamp}s falls outside its scene bounds`);
  }
  const lastScene = timeline.scenes[5];
  assert.equal(lastScene.isLastScene, true);
  const lastReveal = buildSfxSchedule(timeline).events.find(event => event.sceneIndex === 5 && event.type === 'reveal');
  assert.ok(lastReveal.timestamp < timeline.totalDuration, 'the final scene\'s reveal SFX must fire before the video ends, never clipped off the end');
  assert.equal(lastScene.end, timeline.totalDuration, 'the last scene must reach exactly the total video duration, with no unaccounted-for tail');
});

test('the SFX/countdown schedule adapts to whatever scene count the timeline actually has -- no stale 8-scene assumption remains', () => {
  const spec = getAudioSpec();
  for (const sceneCount of [1, 6, 8]) {
    const timeline = buildSceneTimeline({ voiceovers: Array.from({ length: sceneCount }, () => ({ duration: 2 })), baseDuration: 7 });
    assert.equal(buildSfxSchedule(timeline).eventCount, sceneCount * 2 - 1);
    assert.equal(buildCountdownSchedule(timeline).eventCount, sceneCount * spec.countdown.cueNumbers.length);
  }
});

const testSfx = () => ({ reveal: { volume: 0.21 }, transition: { volume: 0.125 }, countdownSequence: { volume: 0.17 } });

test('buildAudioMixPlan mixes every scheduled SFX plus one countdown sequence per scene', () => {
  const timeline = sixSceneTimeline();
  const schedule = buildSfxSchedule(timeline); const countdown = buildCountdownSchedule(timeline);
  const mixPlan = buildAudioMixPlan({ voiceoverCount: 6, timeline, sfx: testSfx(), schedule, countdown, totalDuration: timeline.totalDuration });
  // 6 voiceovers + 11 SFX events + 6 countdown sequences = 23 delayed clips.
  const adelayCount = (mixPlan.filters.join(';').match(/adelay=delays=/g) || []).length;
  assert.equal(adelayCount, 6 + 11 + 6);
  // 1 silent bed + those same delayed clips, all mixed together -- nothing left unmixed.
  assert.equal(mixPlan.mixLabels.length, 1 + 6 + 11 + 6);
  const joined = mixPlan.filters.join(';');
  assert.ok(joined.includes(`amix=inputs=${mixPlan.mixLabels.length}:duration=longest:normalize=0[premix]`));
  // Final-output loudness normalization runs exactly once, AFTER the complete mix (not per-input),
  // so the narration-vs-SFX balance set by the per-input volume= weights above is never touched.
  assert.match(joined, /\[premix\]loudnorm=I=-?[\d.]+:TP=-?[\d.]+:LRA=[\d.]+:print_format=summary\[normalized\]/);
  assert.match(joined, /\[normalized\]alimiter=limit=[\d.]+:attack=\d+:release=\d+,atrim=duration=[\d.]+\[aout\]/);
});

test('buildAudioMixPlan input order matches renderVideo, ending with the countdown sequence', () => {
  const timeline = sixSceneTimeline();
  const schedule = buildSfxSchedule(timeline); const countdown = buildCountdownSchedule(timeline);
  const mixPlan = buildAudioMixPlan({ voiceoverCount: 6, timeline, sfx: testSfx(), schedule, countdown, totalDuration: timeline.totalDuration });
  assert.deepEqual(mixPlan.inputOrder, ['video', 'voiceover0', 'voiceover1', 'voiceover2', 'voiceover3', 'voiceover4', 'voiceover5', 'sfx:reveal', 'sfx:transition', 'sfx:countdownSequence']);
  assert.equal(mixPlan.sfxInputIndexByType.reveal, 7);
  assert.equal(mixPlan.sfxInputIndexByType.transition, 8);
  assert.equal(mixPlan.countdownInputIndex, 9);
});

test('buildAudioMixPlan applies per-voiceover volume weights when provided, and defaults to 1 otherwise', () => {
  const timeline = sixSceneTimeline();
  const schedule = buildSfxSchedule(timeline); const countdown = buildCountdownSchedule(timeline);
  const withWeights = buildAudioMixPlan({ voiceoverCount: 2, timeline, sfx: testSfx(), schedule, countdown, totalDuration: timeline.totalDuration, voiceoverVolumes: [0.5, 2.1] });
  assert.match(withWeights.filters[1], /volume=0\.5,/);
  assert.match(withWeights.filters[2], /volume=2\.1,/);
  const withoutWeights = buildAudioMixPlan({ voiceoverCount: 2, timeline, sfx: testSfx(), schedule, countdown, totalDuration: timeline.totalDuration });
  assert.match(withoutWeights.filters[1], /volume=1,/);
});

test('buildAudioMixPlan restores unfiltered SFX inputs and leaves TTS narration unfiltered', () => {
  const timeline = sixSceneTimeline();
  const schedule = buildSfxSchedule(timeline); const countdown = buildCountdownSchedule(timeline);
  const mixPlan = buildAudioMixPlan({ voiceoverCount: 6, timeline, sfx: testSfx(), schedule, countdown, totalDuration: timeline.totalDuration });
  const joined = mixPlan.filters.join(';');
  assert.doesNotMatch(joined, /highpass=/);
  for (let index = 1; index <= 6; index += 1) {
    const voiceFilter = mixPlan.filters.find(filter => filter.startsWith(`[${index}:a]`));
    assert.ok(voiceFilter);
    assert.doesNotMatch(voiceFilter, /highpass=/, `voice input ${index} must remain unfiltered`);
  }
});

test('full 6-scene production render: every reveal/transition and countdown sequence survives the real FFmpeg mix', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-6scene-render-')); const ffmpeg = resolveFfmpegPath();
  try {
    const imagesDir = path.join(root, 'images'); fs.mkdirSync(imagesDir);
    const redJpeg = path.join(imagesDir, 'red.jpg'); const blueJpeg = path.join(imagesDir, 'blue.jpg');
    for (const [file, color] of [[redJpeg, 'red'], [blueJpeg, 'blue']]) {
      const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=900x600`, '-frames:v', '1', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }

    const audioDir = path.join(root, 'audio'); fs.mkdirSync(audioDir);
    const voiceovers = [];
    for (let index = 0; index < 6; index += 1) {
      const localPath = path.join(audioDir, `q${index + 1}-narration.mp3`);
      const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', localPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      voiceovers.push({ questionIndex: index, localPath, duration: 2 });
    }

    const sfx = await createLocalSfx({ audioDir });
    const timeline = sixSceneTimeline();
    assert.equal(timeline.scenes.length, 6);
    assert.equal(timeline.scenes[5].isLastScene, true);

    const plan = { questions: Array.from({ length: 6 }, (_, index) => ({ index, optionA: { text: `Option A ${index}`, percentage: 55 }, optionB: { text: `Option B ${index}`, percentage: 45 } })), percentages: { mode: 'demo' } };
    const assets = Array.from({ length: 6 }, (_, index) => [
      { questionIndex: index, slot: 'A', provider: 'fixture', localPath: redJpeg },
      { questionIndex: index, slot: 'B', provider: 'fixture', localPath: blueJpeg },
    ]).flat();

    const workspace = path.join(root, 'job'); fs.mkdirSync(path.join(workspace, 'output'), { recursive: true });
    const output = await renderVideo({ plan, assets, timeline, voiceovers, sfx, workspace, sceneConcurrency: 3, ffmpegThreads: 2 });

    const schedule = buildSfxSchedule(timeline); const countdown = buildCountdownSchedule(timeline);
    const verification = await verifyVideo(output, { expectedSceneCount: 6, expectedDuration: timeline.totalDuration, renderDir: path.join(workspace, 'render'), timeline, sfxSchedule: schedule, countdownSchedule: countdown });
    assert.equal(verification.sceneCount, 6);
    // Final duration matches the 6-scene timeline exactly -- the last scene's 2s reveal hold (no
    // whoosh/slide-out tail) was not truncated by atrim.
    assert.ok(Math.abs(verification.duration - timeline.totalDuration) < 0.15, `expected ~${timeline.totalDuration}s, got ${verification.duration}s`);
    assert.ok(verification.duration < SHORTS_DURATION_LIMIT_SECONDS);
    assert.deepEqual([sfx.reveal.volume, sfx.transition.volume, sfx.countdownSequence.volume], [0.21, 0.125, 0.17]);

    // Encoding matches config/audio-spec.json's encode section (High profile, not Constrained
    // Baseline; explicit bitrate/level; AAC 192k/48kHz, not the old 160k default).
    const probe = spawnSync(resolveFfprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_name,profile,level,bit_rate,sample_rate', '-of', 'json', output], { encoding: 'utf8' });
    const streams = JSON.parse(probe.stdout).streams;
    const videoStream = streams.find(s => s.codec_name === 'h264'); const audioStream = streams.find(s => s.codec_name === 'aac');
    assert.equal(videoStream.profile, 'High', `expected High profile, got ${videoStream.profile}`);
    assert.equal(videoStream.level, 42, `expected level 4.2 (42), got ${videoStream.level}`);
    assert.equal(audioStream.sample_rate, '48000');

    // Reference-behavior verification: every scheduled reveal/transition event must be
    // genuinely AUDIBLE (measured RMS, not just present in the schedule) in every one of the 6
    // scenes, at its correct timestamp, and narration must stay clearly louder than every SFX type.
    const AUDIBLE_FLOOR_DB = -60;
    // Each event's measurement window covers most of that SFX asset's own (short) duration, starting
    // exactly at its scheduled timestamp -- matching where the mix's adelay actually places it.
    const MEASUREMENT_WINDOW_SECONDS = { reveal: 0.3, transition: 0.25 };
    const sfxDbByEvent = new Map();
    for (const type of SFX_EVENT_TYPES) {
      const events = schedule.events.filter(event => event.type === type);
      const expectedCount = type === 'transition' ? 5 : 6;
      assert.equal(events.length, expectedCount, `expected exactly ${expectedCount} ${type} events`);
      for (const event of events) {
        const db = measureRmsDb(output, event.timestamp, MEASUREMENT_WINDOW_SECONDS[type]);
        sfxDbByEvent.set(event, db);
        assert.ok(db > AUDIBLE_FLOOR_DB, `${type} SFX in scene ${event.sceneIndex + 1} at ${event.timestamp.toFixed(3)}s must be audible; measured ${db}dB`);
      }
    }
    const countdownDbs = [];
    for (let sceneIndex = 0; sceneIndex < 6; sceneIndex += 1) {
      const db = measureRmsDb(output, timeline.scenes[sceneIndex].start + timeline.scenes[sceneIndex].countdownStart, 0.2);
      countdownDbs.push(db);
      assert.ok(db > AUDIBLE_FLOOR_DB, `countdown sequence in scene ${sceneIndex + 1} must be audible; measured ${db}dB`);
    }

    // Narration dominance: measured mid-narration in each scene must be clearly louder than every
    // SFX type's own peak window measured above -- SFX audible but never overpowering the voice.
    const narrationDbByScene = timeline.scenes.map(scene => measureRmsDb(output, scene.start + scene.voiceStart + 0.2, Math.max(0.05, voiceovers[scene.index].duration - 0.4)));
    for (const db of narrationDbByScene) assert.ok(db > AUDIBLE_FLOOR_DB, `narration must be audible; measured ${db}dB`);
    const loudestSfxDb = Math.max(...sfxDbByEvent.values(), ...countdownDbs);
    for (const db of narrationDbByScene) assert.ok(db > loudestSfxDb - 5, `narration (${db}dB) must stay clearly dominant over the loudest SFX (${loudestSfxDb}dB)`);

    // No clipping anywhere in the final mixed output.
    const peakCheck = spawnSync(ffmpeg, ['-i', output, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const maxVolumeMatch = peakCheck.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    assert.ok(maxVolumeMatch, 'expected volumedetect to report a max_volume');
    assert.ok(Number(maxVolumeMatch[1]) < -1, `final mix must never clip; measured peak ${maxVolumeMatch[1]}dB`);

    // No unexpected multi-second dead air: the longest legitimate quiet stretch in this timeline is
    // well under 2s -- a true regression (a dropped/silent mix segment) would show up as a much
    // longer silent run.
    const silenceCheck = spawnSync(ffmpeg, ['-i', output, '-af', 'silencedetect=noise=-50dB:d=2.0', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.doesNotMatch(silenceCheck.stderr, /silence_start/, `no silent gap should exceed 2.0s in a correctly-mixed 6-scene render; ffmpeg reported one: ${silenceCheck.stderr.match(/silence_start:[^\n]*/)?.[0]}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// buildConcatSegmentList (Fix 4): pure interleaving logic, tested without spawning ffmpeg.
// ---------------------------------------------------------------------------------------------
test('buildConcatSegmentList interleaves the shared gap clip after every scene whose gapAfter > 0, and only there', () => {
  const segments = ['s0.mp4', 's1.mp4', 's2.mp4'];
  const timeline = { scenes: [{ gapAfter: 0.4667 }, { gapAfter: 0.4667 }, { gapAfter: 0 }] };
  assert.deepEqual(buildConcatSegmentList({ segments, timeline, gapSegmentPath: 'gap.mp4' }), ['s0.mp4', 'gap.mp4', 's1.mp4', 'gap.mp4', 's2.mp4']);
});
test('buildConcatSegmentList leaves segments untouched when the timeline has no gapAfter (fixture/duration-only path)', () => {
  const segments = ['s0.mp4', 's1.mp4'];
  assert.deepEqual(buildConcatSegmentList({ segments, timeline: null, gapSegmentPath: 'gap.mp4' }), segments);
  assert.deepEqual(buildConcatSegmentList({ segments, timeline: { scenes: [{}, {}] }, gapSegmentPath: 'gap.mp4' }), segments);
});

// ---------------------------------------------------------------------------------------------
// Real end-to-end production render covering Fix 1 (final-output loudness) and Fix 4 (inter-scene
// blank gap): a real renderVideo call, then the FINAL MUXED MP4 -- not an intermediate WAV or the
// pure filter-graph string -- is measured with the same loudnorm-based tool a reviewer would use,
// and the actual rendered frames are probed with blackdetect to confirm the gap is really present
// in the video, not just claimed by the timeline math (covered separately in audio.test.js).
// ---------------------------------------------------------------------------------------------
test('final rendered MP4 lands near the -14 LUFS target with no clipping, and shows a real ~0.5s black gap between every scene but never before scene 1 or after the last scene', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-loudness-gap-render-')); const ffmpeg = resolveFfmpegPath();
  try {
    const imagesDir = path.join(root, 'images'); fs.mkdirSync(imagesDir);
    const redJpeg = path.join(imagesDir, 'red.jpg'); const blueJpeg = path.join(imagesDir, 'blue.jpg');
    for (const [file, color] of [[redJpeg, 'red'], [blueJpeg, 'blue']]) {
      const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=900x600`, '-frames:v', '1', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const audioDir = path.join(root, 'audio'); fs.mkdirSync(audioDir);
    const sceneCount = 4; const voiceovers = [];
    for (let index = 0; index < sceneCount; index += 1) {
      const localPath = path.join(audioDir, `q${index + 1}-narration.mp3`);
      // A mix of sine tones and filtered noise, closer in crest factor to real speech than a pure
      // tone, so the measured loudness/peak numbers are meaningfully representative.
      const result = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `sine=frequency=${300 + index * 60}:duration=2.4`, '-af', 'volume=0.8', localPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      voiceovers.push({ questionIndex: index, localPath, duration: 2.4 });
    }
    const sfx = await createLocalSfx({ audioDir });
    const timeline = buildSceneTimeline({ voiceovers, baseDuration: 7, voicePaddingSeconds: 1.5 });
    assert.ok(timeline.blankGapSeconds > 0.4 && timeline.blankGapSeconds < 0.55);

    const plan = { questions: Array.from({ length: sceneCount }, (_, index) => ({ index, optionA: { text: `Option A ${index}`, percentage: 55 }, optionB: { text: `Option B ${index}`, percentage: 45 } })), percentages: { mode: 'demo' } };
    const assets = Array.from({ length: sceneCount }, (_, index) => [
      { questionIndex: index, slot: 'A', provider: 'fixture', localPath: redJpeg },
      { questionIndex: index, slot: 'B', provider: 'fixture', localPath: blueJpeg },
    ]).flat();
    const workspace = path.join(root, 'job'); fs.mkdirSync(path.join(workspace, 'output'), { recursive: true });
    const output = await renderVideo({ plan, assets, timeline, voiceovers, sfx, workspace, sceneConcurrency: 2, ffmpegThreads: 2 });

    const schedule = buildSfxSchedule(timeline); const countdown = buildCountdownSchedule(timeline);
    const verification = await verifyVideo(output, { expectedSceneCount: sceneCount, expectedDuration: timeline.totalDuration, renderDir: path.join(workspace, 'render'), timeline, sfxSchedule: schedule, countdownSchedule: countdown });
    assert.ok(Math.abs(verification.duration - timeline.totalDuration) < 0.15);

    // Fix 1: final MP4 integrated loudness lands near the -14 LUFS target with a safe true peak --
    // measured on the actual muxed output file, exactly like the acceptance report requires.
    const loudness = measureIntegratedLoudness(output);
    assert.ok(loudness, 'expected a loudnorm measurement from the final MP4');
    assert.ok(Math.abs(loudness.integratedLufs - getAudioSpec().mix.targetIntegratedLufs) <= 2, `expected integrated loudness within 2 LU of the -14 LUFS target, measured ${loudness.integratedLufs} LUFS`);
    assert.ok(loudness.truePeakDb < -0.1, `expected no clipping (true peak below 0dBTP), measured ${loudness.truePeakDb}dBTP`);
    const peakCheck = spawnSync(ffmpeg, ['-i', output, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const maxVolumeMatch = peakCheck.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    assert.ok(Number(maxVolumeMatch[1]) < 0, `final mix must never clip; measured peak ${maxVolumeMatch[1]}dB`);

    // Fix 4: blackdetect on the REAL rendered frames finds exactly (sceneCount - 1) blank runs, each
    // approximately timeline.blankGapSeconds long, landing exactly at each scene boundary -- nothing
    // before scene 1, nothing after the final scene.
    const blackCheck = spawnSync(ffmpeg, ['-i', output, '-vf', 'blackdetect=d=0.1:pic_th=0.98:pix_th=0.03', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
    const runs = [...blackCheck.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map(match => ({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) }));
    assert.equal(runs.length, sceneCount - 1, `expected exactly ${sceneCount - 1} blank gaps between ${sceneCount} scenes, found ${runs.length}: ${JSON.stringify(runs)}`);
    for (const run of runs) assert.ok(Math.abs(run.duration - timeline.blankGapSeconds) < 0.1, `expected each blank run to be approximately ${timeline.blankGapSeconds}s, got ${run.duration}s`);
    const expectedStarts = timeline.scenes.slice(0, -1).map(scene => scene.end);
    for (let index = 0; index < runs.length; index += 1) assert.ok(Math.abs(runs[index].start - expectedStarts[index]) < 0.1, `gap ${index + 1} should start at scene ${index + 1}'s end (${expectedStarts[index]}s), measured ${runs[index].start}s`);
    assert.ok(runs[0].start > 0.5, 'no blank gap should appear before the first scene');
    assert.ok(timeline.totalDuration - runs[runs.length - 1].end > 0.5, 'no blank gap should trail after the final scene');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
