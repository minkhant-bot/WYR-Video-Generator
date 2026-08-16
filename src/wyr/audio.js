import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EdgeTTS } from '@seepine/edge-tts';
import { mapWithConcurrency, retry, log } from './utils.js';
import { WYR_TEMPLATE } from './template.js';
import { PROJECT_ROOT, resolveFfmpegPath, resolveFfprobePath } from './runtime.js';
import { getAudioSpec, getCountdownSequenceDuration } from './audio-spec.js';
import { ensureSfxAssets } from './sfx-synth.js';

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

export const measureAudioDuration = async audioPath => {
  const output = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath], 'measure narration duration', true);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`FFprobe returned an invalid narration duration for ${path.basename(audioPath)}.`);
  return duration;
};

// A scene's total duration is voiceStart + narration + a fixed pause/countdown/reveal/transition tail.
// This constant mirrors that tail so voice generation can predict a scene's duration before buildSceneTimeline runs.
// Non-final-scene tail (the final scene's tail is shorter -- see FINAL_SCENE_REVEAL_HOLD_SECONDS and buildSceneTimeline).
const SCENE_TAIL_SECONDS = 0.3 + WYR_TEMPLATE.timing.countdownPauseAfterVoice + getCountdownSequenceDuration() + WYR_TEMPLATE.timing.revealHoldDuration + WYR_TEMPLATE.timing.transitionOutDuration;
export const RATE_COMPRESSION_LADDER = Object.freeze(['-10%', '-5%', '+0%', '+8%', '+15%', '+22%']);
const parseRatePercent = value => Number(String(value ?? '+0%').replace('%', '')) || 0;
const fasterRateSteps = baseRate => {
  const basePercent = parseRatePercent(baseRate);
  const steps = RATE_COMPRESSION_LADDER.filter(step => parseRatePercent(step) > basePercent);
  return steps.length ? steps : [baseRate];
};

// Thrown once a scene's narration cannot be produced (as valid, ffprobe-measurable audio) after
// its own bounded retries -- distinct from a duration-budget failure so the pipeline/UI can tell
// "TTS itself is broken" apart from "narration is simply too long to fit" (see pipeline.js).
export class TtsGenerationError extends Error {
  constructor(message, details = {}) { super(message); this.code = 'TTS_FAILED'; Object.assign(this, details); }
}

export const generateVoiceovers = async ({ plan, audioDir, voice, rate, timeoutMs, concurrency = 4, onProgress, ttsFactory = options => new EdgeTTS(options), measureDuration = measureAudioDuration, sceneDurationBudget = Infinity, maxCompressionAttempts = 5 }) => {
  fs.mkdirSync(audioDir, { recursive: true }); let completed = 0;
  return mapWithConcurrency(plan.questions, concurrency, async (question, index) => {
    const narration = buildNarration(question); const filename = `q${String(index + 1).padStart(2, '0')}-narration.mp3`; const localPath = path.join(audioDir, filename);
    // Synthesize AND measure inside the SAME bounded retry, writing to a private candidate path
    // first: a file that fails ffprobe measurement (truncated/corrupt audio that still passed the
    // byte-size check) is exactly as much a TTS failure as an empty response and must be retried
    // the same way -- and `localPath` (the file the rest of the pipeline reads) is only ever
    // replaced once a candidate is FULLY verified, so a later failed attempt (e.g. during optional
    // rate compression) can never leave `localPath` holding not-yet-verified/corrupt bytes.
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

    let usedRate = rate; let duration;
    try {
      duration = await synthesizeAndMeasure(rate);
    } catch (error) {
      fs.rmSync(localPath, { force: true });
      throw new TtsGenerationError(`Narration for scene ${index + 1} could not be generated after bounded retries: ${error.message}`, { sceneIndex: index, cause: error });
    }
    // Narration this long would push the scene past its duration budget; speed up speech (never
    // truncate audio) until it fits. A compression attempt failing (e.g. a transient hiccup on an
    // OPTIONAL speed-up call) never aborts the scene -- the already-valid `duration`/`localPath`
    // from the successful synthesis above remain a safe fallback.
    if (Number.isFinite(sceneDurationBudget) && SCENE_TAIL_SECONDS + duration > sceneDurationBudget) {
      for (const candidateRate of fasterRateSteps(rate).slice(0, maxCompressionAttempts)) {
        try {
          const candidateDuration = await synthesizeAndMeasure(candidateRate);
          if (candidateDuration < duration) { duration = candidateDuration; usedRate = candidateRate; }
          if (SCENE_TAIL_SECONDS + candidateDuration <= sceneDurationBudget) break;
        } catch (error) {
          log('tts.compression_attempt_failed', { sceneIndex: index, rate: candidateRate, message: error.message });
        }
      }
    }
    completed += 1; onProgress?.(completed, plan.questions.length);
    return { questionIndex: index, narration, filename, localPath, duration, voice, rate: usedRate };
  });
};

const frameCeil = seconds => Math.ceil(seconds * WYR_TEMPLATE.canvas.fps) / WYR_TEMPLATE.canvas.fps;
// tickCount/tickSpacingSeconds/revealGapAfterLastTickSeconds/finalSceneHoldSeconds all default from
// config/audio-spec.json (via getAudioSpec()) rather than being hardcoded -- pass explicit values
// only to override for a test or a one-off re-measurement.
export const buildSceneTimeline = ({ voiceovers, baseDuration = WYR_TEMPLATE.timing.defaultSceneDuration, voicePaddingSeconds = 1.5, maximumSceneDuration = 11, tickCount, tickSpacingSeconds, revealGapAfterLastTickSeconds, finalSceneHoldSeconds = FINAL_SCENE_REVEAL_HOLD_SECONDS } = {}) => {
  if (!Array.isArray(voiceovers) || voiceovers.length === 0) throw new Error('At least one measured narration is required to build the scene timeline.');
  const spec = getAudioSpec();
  const ticks = tickCount ?? spec.countdown.tickCount;
  const tickSpacing = tickSpacingSeconds ?? spec.countdown.tickSpacingSeconds;
  const revealGap = revealGapAfterLastTickSeconds ?? spec.reveal.gapAfterLastTickSeconds;
  const countdownSequenceDuration = (ticks - 1) * tickSpacing + revealGap;
  let cursor = 0;
  const scenes = voiceovers.map((voiceover, index) => {
    const isLastScene = index === voiceovers.length - 1;
    const voiceStart = 0.3;
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
    if (duration > maximumSceneDuration) throw new Error(`Scene ${index + 1} narration is ${voiceover.duration.toFixed(2)}s and would exceed the ${maximumSceneDuration}s scene limit. Regenerate shorter option text.`);
    // contentEnd === duration on the final scene (no transition-out tail to reserve), which also
    // means the outgoing slide motion in media.js (driven off contentEnd) never actually triggers
    // within the rendered frames, and the percentage overlay never fades out early.
    const contentEnd = isLastScene ? duration : duration - WYR_TEMPLATE.timing.transitionOutDuration;
    const countdown = Array.from({ length: ticks }, (_, tickIndex) => ({ tick: tickIndex + 1, time: countdownStart + tickIndex * tickSpacing }));
    const scene = { index, start: cursor, duration, end: cursor + duration, voiceStart, voiceDuration: voiceover.duration, narrationEnd, countdownStart, countdownGap, countdown, revealTime, contentEnd, isLastScene, transitionOutDuration: isLastScene ? 0 : WYR_TEMPLATE.timing.transitionOutDuration };
    cursor += duration; return scene;
  });
  return { version: 1, baseDuration, maximumSceneDuration, voicePaddingSeconds, tickCount: ticks, tickSpacingSeconds: tickSpacing, totalDuration: cursor, scenes };
};

// 'slide' fires at scene start (accompanies images sliding in), 'whoosh' fires at scene end
// (accompanies the outgoing slide) -- 'whoosh' is omitted on the final scene (see buildSfxSchedule).
export const SFX_EVENT_TYPES = Object.freeze(['slide', 'reveal', 'whoosh']);

export const assertCompleteCountdownSchedule = ({ timeline, events }) => {
  if (!Array.isArray(timeline?.scenes) || !Array.isArray(events)) throw new Error('Timeline and countdown events are required.');
  let expectedTotal = 0;
  for (let sceneIndex = 0; sceneIndex < timeline.scenes.length; sceneIndex += 1) {
    const scene = timeline.scenes[sceneIndex]; const sceneEvents = events.filter(event => event.sceneIndex === sceneIndex);
    const narrationEnd = scene.voiceStart + scene.voiceDuration;
    const countdownGap = scene.countdownStart - narrationEnd;
    if (!Number.isFinite(countdownGap) || countdownGap < 0 || countdownGap > WYR_TEMPLATE.timing.maximumNarrationCountdownGap) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} narration-to-countdown gap is ${Number.isFinite(countdownGap) ? `${countdownGap.toFixed(3)}s` : 'invalid'}; expected no more than ${WYR_TEMPLATE.timing.maximumNarrationCountdownGap.toFixed(2)}s.`);
    const expectedTickCount = scene.countdown.length;
    expectedTotal += expectedTickCount;
    if (sceneEvents.length !== expectedTickCount) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} must contain ${expectedTickCount} ticks; found ${sceneEvents.length} event(s).`);
    for (let tickIndex = 0; tickIndex < expectedTickCount; tickIndex += 1) {
      const tick = tickIndex + 1; const matching = sceneEvents.filter(event => event.tick === tick);
      if (matching.length !== 1) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} must contain exactly one tick ${tick}.`);
      const expected = scene.start + scene.countdown[tickIndex].time;
      if (!Number.isFinite(matching[0].timestamp) || Math.abs(matching[0].timestamp - expected) > 0.000001) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} tick ${tick} is mistimed.`);
    }
    const lastTick = sceneEvents.find(event => event.tick === expectedTickCount);
    const expectedReveal = scene.start + scene.countdown[expectedTickCount - 1].time;
    if (scene.start + scene.revealTime <= lastTick.timestamp) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} result does not reveal after the countdown ticks.`);
    void expectedReveal; // last-tick timestamp itself, kept for readability of the check above
  }
  if (events.length !== expectedTotal) throw new Error('Countdown validation failed: the schedule contains unexpected extra events.');
  return true;
};

export const buildCountdownSchedule = timeline => {
  if (!Array.isArray(timeline?.scenes) || timeline.scenes.length === 0) throw new Error('A scene timeline is required to schedule the countdown.');
  const events = timeline.scenes.flatMap((scene, sceneIndex) => scene.countdown.map(({ tick, time }) => ({ sceneIndex, tick, sceneTime: Number(time.toFixed(6)), timestamp: Number((scene.start + time).toFixed(6)) })));
  assertCompleteCountdownSchedule({ timeline, events });
  return { version: 1, ticksPerScene: timeline.tickCount ?? timeline.scenes[0]?.countdown.length, eventCount: events.length, events };
};

// Every scene gets 'slide' (entrance) and 'reveal'; only non-final scenes get 'whoosh' -- the final
// scene skips its outgoing transition entirely (see buildSceneTimeline's isLastScene handling).
export const buildSfxSchedule = timeline => {
  if (!Array.isArray(timeline?.scenes) || timeline.scenes.length === 0) throw new Error('A scene timeline is required to schedule SFX.');
  const events = timeline.scenes.flatMap((scene, sceneIndex) => {
    const sceneEvents = [
      { sceneIndex, type: 'slide', sceneTime: 0, timestamp: scene.start },
      { sceneIndex, type: 'reveal', sceneTime: scene.revealTime, timestamp: scene.start + scene.revealTime },
    ];
    if (!scene.isLastScene) sceneEvents.push({ sceneIndex, type: 'whoosh', sceneTime: scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead, timestamp: scene.start + scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead });
    return sceneEvents;
  }).map(event => ({ ...event, sceneTime: Number(event.sceneTime.toFixed(6)), timestamp: Number(event.timestamp.toFixed(6)) }));
  assertCompleteSfxSchedule({ timeline, events });
  return { version: 1, eventCount: events.length, events };
};

export const assertCompleteSfxSchedule = ({ timeline, events }) => {
  if (!Array.isArray(timeline?.scenes) || !Array.isArray(events)) throw new Error('Timeline and SFX events are required.');
  let expectedTotal = 0;
  for (let sceneIndex = 0; sceneIndex < timeline.scenes.length; sceneIndex += 1) {
    const scene = timeline.scenes[sceneIndex]; const sceneEvents = events.filter(event => event.sceneIndex === sceneIndex);
    const expectedTypes = scene.isLastScene ? SFX_EVENT_TYPES.filter(type => type !== 'whoosh') : SFX_EVENT_TYPES;
    expectedTotal += expectedTypes.length;
    if (sceneEvents.length !== expectedTypes.length) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} must contain ${expectedTypes.length} events; found ${sceneEvents.length}.`);
    for (const type of expectedTypes) {
      const matching = sceneEvents.filter(event => event.type === type);
      if (matching.length !== 1) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} must contain exactly one ${type} event.`);
      const expected = type === 'slide' ? scene.start : scene.start + (type === 'reveal' ? scene.revealTime : scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead);
      if (!Number.isFinite(matching[0].timestamp) || Math.abs(matching[0].timestamp - expected) > 0.000001) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} ${type} event is not at its intended timestamp.`);
    }
    if (scene.isLastScene && sceneEvents.some(event => event.type === 'whoosh')) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} is the final scene and must not schedule a whoosh.`);
  }
  if (events.length !== expectedTotal) throw new Error('SFX validation failed: the schedule contains unexpected extra events.');
  return true;
};

// Generic SFX synthesized purely from ffmpeg lavfi noise/sine sources (see sfx-synth.js) -- nothing
// sampled or extracted from any reference/third-party video, so there is no copyright exposure.
// Generated once and cached on disk (fingerprinted against config/audio-spec.json's sfx/mix
// sections); every job just copies the cached files into its own workspace.
export const createLocalSfx = async ({ audioDir, spec = getAudioSpec() }) => {
  const sfxDir = path.join(audioDir, 'sfx'); fs.mkdirSync(sfxDir, { recursive: true });
  const cacheDir = path.join(PROJECT_ROOT, 'assets', 'sfx', 'generated-cache');
  const { files, volumes } = ensureSfxAssets({ cacheDir, spec });
  const result = { provider: 'procedurally-generated' };
  for (const name of ['tick', 'reveal', 'whoosh', 'slide']) {
    const destination = path.join(sfxDir, `${name}.wav`);
    fs.copyFileSync(files[name], destination);
    result[name] = { filename: `${name}.wav`, localPath: destination, volume: volumes[name] };
  }
  return result;
};
