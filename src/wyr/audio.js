import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EdgeTTS } from '@seepine/edge-tts';
import { mapWithConcurrency, retry } from './utils.js';
import { WYR_TEMPLATE } from './template.js';
import { PROJECT_ROOT, resolveFfmpegPath, resolveFfprobePath } from './runtime.js';
import { getAudioSpec, getCountdownSequenceDuration } from './audio-spec.js';

// Fixed product decision (not a measured reference value): on the final scene, skip the outgoing
// whoosh/slide-out and simply hold the revealed percentages before the video ends.
export const FINAL_SCENE_REVEAL_HOLD_SECONDS = 2;

const ffmpegPath = resolveFfmpegPath();
const ffprobePath = resolveFfprobePath();
const run = (binary, args, label, captureStdout = false) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] }); let stdout = ''; let stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8000); }); child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${label} exited with code ${code}: ${stderr.slice(-3000)}`)));
});

const narrationPart = (text, lowercaseFirst = false) => {
  const cleaned = String(text).replace(/\bwould you rather\b/gi, '').replace(/\s+/g, ' ').replace(/[?.!,;:]+$/g, '').trim();
  return cleaned.replace(/^./, character => lowercaseFirst ? character.toLowerCase() : character.toUpperCase());
};
export const buildNarration = question => `${narrationPart(question.optionA.text)}, or ${narrationPart(question.optionB.text, true)}?`;

// Scene 1 gets a small, opening-only delivery nudge -- WHY: real platform analytics show retention
// dropping hardest right at the open (Shorts: ~38% stayed, drop concentrated near the start), and
// the same flat base rate that reads fine by scene 2-6 can feel a beat too deliberate exactly where
// a viewer decides whether to keep watching. Scenes 2-6 keep the existing, already-approved base
// rate untouched -- only the very first narration line gets synthesized slightly faster/tighter.
// Kept small on purpose (still normally intelligible, never "unnaturally fast") and additive to
// whatever base rate is configured, so a future base-rate retune still carries through unchanged.
export const OPENING_TTS_RATE_BUMP_PERCENT = 6;
export const bumpTtsRate = (rate, deltaPercent) => {
  const match = /^([+-]?\d+(?:\.\d+)?)%$/.exec(String(rate ?? '').trim());
  if (!match) return rate; // unrecognized rate format -- leave untouched rather than guess
  const bumped = Number(match[1]) + deltaPercent;
  return `${bumped >= 0 ? '+' : ''}${bumped}%`;
};

export const measureAudioDuration = async audioPath => {
  const output = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath], 'measure narration duration', true);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`FFprobe returned an invalid narration duration for ${path.basename(audioPath)}.`);
  return duration;
};

// Thrown once a scene's narration cannot be produced (as valid, ffprobe-measurable audio) after
// its own bounded retries -- distinct from a duration-budget failure so the pipeline/UI can tell
// "TTS itself is broken" apart from "narration is simply too long to fit" (see pipeline.js).
export class TtsGenerationError extends Error {
  constructor(message, details = {}) { super(message); this.code = 'TTS_FAILED'; Object.assign(this, details); }
}

// Narration is always synthesized at the configured rate and never sped up or truncated to fit a
// box -- each scene's real measured duration is authoritative, and buildSceneTimeline lets the
// scene grow to fit it. (See pipeline.js for the global, whole-video ceiling this feeds into.)
export const generateVoiceovers = async ({ plan, audioDir, voice, rate, timeoutMs, concurrency = 4, onProgress, ttsFactory = options => new EdgeTTS(options), measureDuration = measureAudioDuration }) => {
  fs.mkdirSync(audioDir, { recursive: true }); let completed = 0;
  return mapWithConcurrency(plan.questions, concurrency, async (question, index) => {
    const narration = buildNarration(question); const filename = `q${String(index + 1).padStart(2, '0')}-narration.mp3`; const localPath = path.join(audioDir, filename);
    // Synthesize AND measure inside the SAME bounded retry, writing to a private candidate path
    // first: a file that fails ffprobe measurement (truncated/corrupt audio that still passed the
    // byte-size check) is exactly as much a TTS failure as an empty response and must be retried
    // the same way -- and `localPath` (the file the rest of the pipeline reads) is only ever
    // replaced once a candidate is FULLY verified.
    const sceneRate = index === 0 ? bumpTtsRate(rate, OPENING_TTS_RATE_BUMP_PERCENT) : rate;
    const synthesizeAndMeasure = rateValue => retry(async attempt => {
      const client = ttsFactory({ voice, lang: 'en-US', outputFormat: 'audio-24khz-96kbitrate-mono-mp3', rate: rateValue, pitch: '+0Hz', volume: '+0%', timeout: timeoutMs });
      let result;
      try { result = await client.call(narration); } catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
      if (!Buffer.isBuffer(result?.data) || result.data.length < 1000) throw new Error(`Edge TTS returned empty or invalid audio for scene ${index + 1}.`);
      const candidatePath = `${localPath}.candidate-${attempt}`;
      fs.writeFileSync(candidatePath, result.data);
      let measured;
      try { measured = await measureDuration(candidatePath); }
      catch (error) { fs.rmSync(candidatePath, { force: true }); throw error; }
      if (!Number.isFinite(measured) || measured <= 0) { fs.rmSync(candidatePath, { force: true }); throw new Error(`Edge TTS produced unreadable or zero-duration audio for scene ${index + 1}.`); }
      fs.renameSync(candidatePath, localPath);
      return measured;
    }, { attempts: 2, label: `Edge TTS scene ${index + 1}` });

    let duration;
    try {
      duration = await synthesizeAndMeasure(sceneRate);
    } catch (error) {
      fs.rmSync(localPath, { force: true });
      throw new TtsGenerationError(`Narration for scene ${index + 1} could not be generated after bounded retries: ${error.message}`, { sceneIndex: index, cause: error });
    }
    completed += 1; onProgress?.(completed, plan.questions.length);
    return { questionIndex: index, narration, filename, localPath, duration, voice, rate: sceneRate };
  });
};

const frameCeil = seconds => Math.ceil(seconds * WYR_TEMPLATE.canvas.fps) / WYR_TEMPLATE.canvas.fps;
// Scene 1's narration starts almost immediately; every other scene keeps the existing, already-
// approved 0.3s pre-narration pause. WHY: analytics show retention dropping hardest right at the
// open, and images/option text are already visible essentially at t=0 (see media.js's
// optionEntranceStart/initialEntranceDuration, unchanged) -- the only remaining "dead air" before
// Option A is heard was this fixed pause, so only the opening scene's pause shrinks.
const STANDARD_VOICE_START_SECONDS = 0.3;
const OPENING_VOICE_START_SECONDS = 0.08;
export const buildSceneTimeline = ({ voiceovers, baseDuration = WYR_TEMPLATE.timing.defaultSceneDuration, voicePaddingSeconds = 1.5, finalSceneHoldSeconds = FINAL_SCENE_REVEAL_HOLD_SECONDS, blankGapSeconds } = {}) => {
  if (!Array.isArray(voiceovers) || voiceovers.length === 0) throw new Error('At least one measured narration is required to build the scene timeline.');
  const spec = getAudioSpec();
  const countdownSequenceDuration = getCountdownSequenceDuration(spec);
  // Restores the reference design's measured inter-scene blank (config/audio-spec.json's
  // transitions.blankDurationSeconds, ~0.45s -- "approximately 0.5s"), frame-ceiled so the gap
  // segment renders a whole number of frames. Only BETWEEN scenes: the last scene's gapAfter stays
  // 0, so totalDuration/lastScene.end never grows a trailing blank past the final reveal hold.
  const gap = frameCeil(blankGapSeconds ?? spec.transitions.blankDurationSeconds);
  let cursor = 0;
  const scenes = voiceovers.map((voiceover, index) => {
    const isLastScene = index === voiceovers.length - 1;
    const voiceStart = index === 0 ? OPENING_VOICE_START_SECONDS : STANDARD_VOICE_START_SECONDS;
    const narrationEnd = voiceStart + voiceover.duration;
    const countdownStart = narrationEnd + WYR_TEMPLATE.timing.countdownPauseAfterVoice;
    const countdownGap = countdownStart - narrationEnd;
    if (countdownGap < 0 || countdownGap > WYR_TEMPLATE.timing.maximumNarrationCountdownGap) throw new Error(`Scene ${index + 1} narration-to-countdown gap is ${countdownGap.toFixed(3)}s; expected no more than ${WYR_TEMPLATE.timing.maximumNarrationCountdownGap.toFixed(2)}s.`);
    const revealTime = countdownStart + countdownSequenceDuration;
    // The final scene skips the outgoing whoosh/slide-out entirely: no transitionOutDuration tail,
    // just a fixed hold on the reveal before the video ends (see FINAL_SCENE_REVEAL_HOLD_SECONDS).
    const requiredDuration = isLastScene ? revealTime + finalSceneHoldSeconds : revealTime + WYR_TEMPLATE.timing.revealHoldDuration + WYR_TEMPLATE.timing.transitionOutDuration;
    // The final scene is never padded out to baseDuration: every other scene's padding is masked
    // by its outgoing whoosh (anchored to contentEnd, so it just floats later), but the final scene
    // has no outgoing cue at all -- padding it would only add unmasked dead air after the hold.
    const duration = isLastScene
      ? frameCeil(Math.max(voiceover.duration + voicePaddingSeconds, requiredDuration))
      : frameCeil(Math.max(baseDuration, voiceover.duration + voicePaddingSeconds, requiredDuration));
    // No per-scene cap here: a scene's duration is derived purely from its own real narration +
    // fixed tail. Whether the resulting WHOLE-VIDEO total is safe to render is a separate, global
    // check made by the caller after all scenes are built (see pipeline.js's
    // assertWithinProductionDurationCeiling) -- one long scene must never fail in isolation when
    // shorter scenes elsewhere leave plenty of room in the total budget.
    // contentEnd === duration on the final scene (no transition-out tail to reserve), which also
    // means the outgoing slide motion in media.js (driven off contentEnd) never actually triggers
    // within the rendered frames, and the percentage overlay never fades out early.
    const contentEnd = isLastScene ? duration : duration - WYR_TEMPLATE.timing.transitionOutDuration;
    const countdown = spec.countdown.cueNumbers.map((number, cueIndex) => ({ number, time: countdownStart + spec.countdown.cueOffsetsSeconds[cueIndex] }));
    const gapAfter = isLastScene ? 0 : gap;
    const scene = { index, start: cursor, duration, end: cursor + duration, voiceStart, voiceDuration: voiceover.duration, narrationEnd, countdownStart, countdownGap, countdown, revealTime, contentEnd, isLastScene, transitionOutDuration: isLastScene ? 0 : WYR_TEMPLATE.timing.transitionOutDuration, gapAfter };
    cursor += duration + gapAfter; return scene;
  });
  return { version: 1, baseDuration, voicePaddingSeconds, countdownSequenceDuration, blankGapSeconds: gap, totalDuration: cursor, scenes };
};

export const SFX_EVENT_TYPES = Object.freeze(['reveal', 'transition']);

export const assertCompleteCountdownSchedule = ({ timeline, events }) => {
  if (!Array.isArray(timeline?.scenes) || !Array.isArray(events)) throw new Error('Timeline and countdown events are required.');
  let expectedTotal = 0;
  for (let sceneIndex = 0; sceneIndex < timeline.scenes.length; sceneIndex += 1) {
    const scene = timeline.scenes[sceneIndex]; const sceneEvents = events.filter(event => event.sceneIndex === sceneIndex);
    const narrationEnd = scene.voiceStart + scene.voiceDuration;
    const countdownGap = scene.countdownStart - narrationEnd;
    if (!Number.isFinite(countdownGap) || countdownGap < 0 || countdownGap > WYR_TEMPLATE.timing.maximumNarrationCountdownGap) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} narration-to-countdown gap is ${Number.isFinite(countdownGap) ? `${countdownGap.toFixed(3)}s` : 'invalid'}; expected no more than ${WYR_TEMPLATE.timing.maximumNarrationCountdownGap.toFixed(2)}s.`);
    const expectedCueCount = scene.countdown.length;
    expectedTotal += expectedCueCount;
    if (sceneEvents.length !== expectedCueCount) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} must contain ${expectedCueCount} cues; found ${sceneEvents.length} event(s).`);
    for (let cueIndex = 0; cueIndex < expectedCueCount; cueIndex += 1) {
      const number = scene.countdown[cueIndex].number; const matching = sceneEvents.filter(event => event.number === number);
      if (matching.length !== 1) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} must contain exactly one ${number}.`);
      const expected = scene.start + scene.countdown[cueIndex].time;
      if (!Number.isFinite(matching[0].timestamp) || Math.abs(matching[0].timestamp - expected) > 0.000001) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} number ${number} is mistimed.`);
    }
    const one = sceneEvents.find(event => event.number === 1);
    if (scene.start + scene.revealTime <= one.timestamp) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} result does not reveal after the countdown sequence.`);
  }
  if (events.length !== expectedTotal) throw new Error('Countdown validation failed: the schedule contains unexpected extra events.');
  return true;
};

export const buildCountdownSchedule = timeline => {
  if (!Array.isArray(timeline?.scenes) || timeline.scenes.length === 0) throw new Error('A scene timeline is required to schedule the countdown.');
  const events = timeline.scenes.flatMap((scene, sceneIndex) => scene.countdown.map(({ number, time }) => ({ sceneIndex, number, sceneTime: Number(time.toFixed(6)), timestamp: Number((scene.start + time).toFixed(6)) })));
  assertCompleteCountdownSchedule({ timeline, events });
  return { version: 1, numbersPerScene: timeline.scenes[0]?.countdown.length, eventCount: events.length, events };
};

export const buildSfxSchedule = timeline => {
  if (!Array.isArray(timeline?.scenes) || timeline.scenes.length === 0) throw new Error('A scene timeline is required to schedule SFX.');
  const events = timeline.scenes.flatMap((scene, sceneIndex) => [
    { sceneIndex, type: 'reveal', sceneTime: scene.revealTime, timestamp: scene.start + scene.revealTime },
    ...(sceneIndex < timeline.scenes.length - 1 ? [{ sceneIndex, type: 'transition', sceneTime: scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead, timestamp: scene.start + scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead }] : []),
  ]).map(event => ({ ...event, sceneTime: Number(event.sceneTime.toFixed(6)), timestamp: Number(event.timestamp.toFixed(6)) }));
  assertCompleteSfxSchedule({ timeline, events });
  return { version: 1, eventsPerScene: SFX_EVENT_TYPES.length, eventCount: events.length, events };
};

export const assertCompleteSfxSchedule = ({ timeline, events }) => {
  if (!Array.isArray(timeline?.scenes) || !Array.isArray(events)) throw new Error('Timeline and SFX events are required.');
  for (let sceneIndex = 0; sceneIndex < timeline.scenes.length; sceneIndex += 1) {
    const scene = timeline.scenes[sceneIndex]; const sceneEvents = events.filter(event => event.sceneIndex === sceneIndex);
    const expectedTypes = sceneIndex < timeline.scenes.length - 1 ? SFX_EVENT_TYPES : SFX_EVENT_TYPES.filter(type => type !== 'transition');
    if (sceneEvents.length !== expectedTypes.length) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} must contain ${expectedTypes.length} events; found ${sceneEvents.length}.`);
    for (const type of expectedTypes) {
      const matching = sceneEvents.filter(event => event.type === type);
      if (matching.length !== 1) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} must contain exactly one ${type} event.`);
      const expected = scene.start + (type === 'reveal' ? scene.revealTime : scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead);
      if (!Number.isFinite(matching[0].timestamp) || Math.abs(matching[0].timestamp - expected) > 0.000001) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} ${type} event is not at its intended timestamp.`);
    }
  }
  if (events.length !== timeline.scenes.length * SFX_EVENT_TYPES.length - 1) throw new Error('SFX validation failed: the schedule contains unexpected extra events.');
  return true;
};

export const createLocalSfx = async ({ audioDir }) => {
  const sfxDir = path.join(audioDir, 'sfx'); fs.mkdirSync(sfxDir, { recursive: true });
  const transitionPath = path.join(sfxDir, 'transition.wav'); const revealPath = path.join(sfxDir, 'reveal.wav');
  const countdownSequencePath = path.join(sfxDir, 'countdown-sequence.wav');
  const sources = {
    reveal: path.join(PROJECT_ROOT, 'assets', 'sfx', 'cue-09.wav'),
    transition: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-scene-transition-whoosh.wav'),
    countdownSequence: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-countdown-sequence.wav'),
  };
  for (const source of Object.values(sources)) if (!fs.existsSync(source) || fs.statSync(source).size <= 44) throw new Error(`Reusable reference SFX asset is missing: ${source}`);
  fs.copyFileSync(sources.reveal, revealPath); fs.copyFileSync(sources.transition, transitionPath); fs.copyFileSync(sources.countdownSequence, countdownSequencePath);
  return {
    provider: 'licensed-reference-extract',
    reveal: { filename: path.basename(sources.reveal), localPath: revealPath, volume: 0.21 },
    transition: { filename: path.basename(sources.transition), localPath: transitionPath, volume: 0.125 },
    countdownSequence: { filename: path.basename(sources.countdownSequence), localPath: countdownSequencePath, volume: 0.17, duration: getCountdownSequenceDuration() },
  };
};
