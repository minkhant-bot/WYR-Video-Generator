import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EdgeTTS } from '@seepine/edge-tts';
import { retry } from './utils.js';
import { WYR_TEMPLATE } from './template.js';
import { PROJECT_ROOT, resolveFfmpegPath, resolveFfprobePath } from './runtime.js';

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

export const generateVoiceovers = async ({ plan, audioDir, voice, rate, timeoutMs, onProgress, ttsFactory = options => new EdgeTTS(options), measureDuration = measureAudioDuration }) => {
  fs.mkdirSync(audioDir, { recursive: true }); const voiceovers = [];
  const client = ttsFactory({ voice, lang: 'en-US', outputFormat: 'audio-24khz-96kbitrate-mono-mp3', rate, pitch: '+0Hz', volume: '+0%', timeout: timeoutMs });
  for (let index = 0; index < plan.questions.length; index += 1) {
    const narration = buildNarration(plan.questions[index]); const filename = `q${String(index + 1).padStart(2, '0')}-narration.mp3`; const localPath = path.join(audioDir, filename);
    await retry(async () => {
      let result;
      try { result = await client.call(narration); } catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
      if (!Buffer.isBuffer(result?.data) || result.data.length < 1000) throw new Error(`Edge TTS returned empty or invalid audio for scene ${index + 1}.`);
      fs.writeFileSync(localPath, result.data);
    }, { attempts: 2, label: `Edge TTS scene ${index + 1}` });
    const duration = await measureDuration(localPath);
    voiceovers.push({ questionIndex: index, narration, filename, localPath, duration, voice, rate }); onProgress?.(index + 1, plan.questions.length);
  }
  return voiceovers;
};

const frameCeil = seconds => Math.ceil(seconds * WYR_TEMPLATE.canvas.fps) / WYR_TEMPLATE.canvas.fps;
export const buildSceneTimeline = ({ voiceovers, baseDuration = WYR_TEMPLATE.timing.defaultSceneDuration, voicePaddingSeconds = 1.5, maximumSceneDuration = 11 }) => {
  if (!Array.isArray(voiceovers) || voiceovers.length === 0) throw new Error('At least one measured narration is required to build the scene timeline.');
  let cursor = 0;
  const scenes = voiceovers.map((voiceover, index) => {
    const voiceStart = 0.3;
    const narrationEnd = voiceStart + voiceover.duration;
    const countdownStart = narrationEnd + WYR_TEMPLATE.timing.countdownPauseAfterVoice;
    const countdownGap = countdownStart - narrationEnd;
    if (countdownGap < 0 || countdownGap > WYR_TEMPLATE.timing.maximumNarrationCountdownGap) throw new Error(`Scene ${index + 1} narration-to-countdown gap is ${countdownGap.toFixed(3)}s; expected no more than ${WYR_TEMPLATE.timing.maximumNarrationCountdownGap.toFixed(2)}s.`);
    const revealTime = countdownStart + WYR_TEMPLATE.timing.countdownSequenceDuration;
    const requiredDuration = revealTime + WYR_TEMPLATE.timing.revealHoldDuration + WYR_TEMPLATE.timing.transitionOutDuration;
    const duration = frameCeil(Math.max(baseDuration, voiceover.duration + voicePaddingSeconds, requiredDuration));
    if (duration > maximumSceneDuration) throw new Error(`Scene ${index + 1} narration is ${voiceover.duration.toFixed(2)}s and would exceed the ${maximumSceneDuration}s scene limit. Regenerate shorter option text.`);
    const contentEnd = duration - WYR_TEMPLATE.timing.transitionOutDuration;
    const countdown = [3, 2, 1].map((number, countdownIndex) => ({ number, time: countdownStart + WYR_TEMPLATE.timing.countdownCueOffsets[countdownIndex] }));
    const scene = { index, start: cursor, duration, end: cursor + duration, voiceStart, voiceDuration: voiceover.duration, narrationEnd, countdownStart, countdownGap, countdown, revealTime, contentEnd, transitionOutDuration: WYR_TEMPLATE.timing.transitionOutDuration };
    cursor += duration; return scene;
  });
  return { version: 1, baseDuration, maximumSceneDuration, voicePaddingSeconds, totalDuration: cursor, scenes };
};

export const SFX_EVENT_TYPES = Object.freeze(['entrance', 'reveal', 'transition']);
export const COUNTDOWN_NUMBERS = Object.freeze([3, 2, 1]);

export const assertCompleteCountdownSchedule = ({ timeline, events }) => {
  if (!Array.isArray(timeline?.scenes) || !Array.isArray(events)) throw new Error('Timeline and countdown events are required.');
  for (let sceneIndex = 0; sceneIndex < timeline.scenes.length; sceneIndex += 1) {
    const scene = timeline.scenes[sceneIndex]; const sceneEvents = events.filter(event => event.sceneIndex === sceneIndex);
    const narrationEnd = scene.voiceStart + scene.voiceDuration;
    const countdownGap = scene.countdownStart - narrationEnd;
    if (!Number.isFinite(countdownGap) || countdownGap < 0 || countdownGap > WYR_TEMPLATE.timing.maximumNarrationCountdownGap) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} narration-to-countdown gap is ${Number.isFinite(countdownGap) ? `${countdownGap.toFixed(3)}s` : 'invalid'}; expected no more than ${WYR_TEMPLATE.timing.maximumNarrationCountdownGap.toFixed(2)}s.`);
    if (sceneEvents.length !== COUNTDOWN_NUMBERS.length) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} must contain 3, 2, and 1; found ${sceneEvents.length} event(s).`);
    for (let countdownIndex = 0; countdownIndex < COUNTDOWN_NUMBERS.length; countdownIndex += 1) {
      const number = COUNTDOWN_NUMBERS[countdownIndex]; const matching = sceneEvents.filter(event => event.number === number);
      if (matching.length !== 1) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} must contain exactly one ${number}.`);
      const expected = scene.start + scene.countdownStart + WYR_TEMPLATE.timing.countdownCueOffsets[countdownIndex];
      if (!Number.isFinite(matching[0].timestamp) || Math.abs(matching[0].timestamp - expected) > 0.000001) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} number ${number} is mistimed.`);
    }
    const one = sceneEvents.find(event => event.number === 1);
    const expectedReveal = scene.start + scene.countdownStart + WYR_TEMPLATE.timing.countdownSequenceDuration;
    if (Math.abs(scene.start + scene.revealTime - expectedReveal) > 0.000001 || scene.start + scene.revealTime <= one.timestamp) throw new Error(`Countdown validation failed: scene ${sceneIndex + 1} result does not reveal immediately after the countdown sequence.`);
  }
  if (events.length !== timeline.scenes.length * COUNTDOWN_NUMBERS.length) throw new Error('Countdown validation failed: the schedule contains unexpected extra events.');
  return true;
};

export const buildCountdownSchedule = timeline => {
  if (!Array.isArray(timeline?.scenes) || timeline.scenes.length === 0) throw new Error('A scene timeline is required to schedule the countdown.');
  const events = timeline.scenes.flatMap((scene, sceneIndex) => scene.countdown.map(({ number, time }) => ({ sceneIndex, number, sceneTime: Number(time.toFixed(6)), timestamp: Number((scene.start + time).toFixed(6)) })));
  assertCompleteCountdownSchedule({ timeline, events });
  return { version: 1, numbersPerScene: COUNTDOWN_NUMBERS.length, eventCount: events.length, events };
};

export const buildSfxSchedule = timeline => {
  if (!Array.isArray(timeline?.scenes) || timeline.scenes.length === 0) throw new Error('A scene timeline is required to schedule SFX.');
  const events = timeline.scenes.flatMap((scene, sceneIndex) => [
    { sceneIndex, type: 'entrance', sceneTime: 0, timestamp: scene.start },
    { sceneIndex, type: 'reveal', sceneTime: scene.revealTime, timestamp: scene.start + scene.revealTime },
    { sceneIndex, type: 'transition', sceneTime: scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead, timestamp: scene.start + scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead },
  ]).map(event => ({ ...event, sceneTime: Number(event.sceneTime.toFixed(6)), timestamp: Number(event.timestamp.toFixed(6)) }));
  assertCompleteSfxSchedule({ timeline, events });
  return { version: 1, eventsPerScene: SFX_EVENT_TYPES.length, eventCount: events.length, events };
};

export const assertCompleteSfxSchedule = ({ timeline, events }) => {
  if (!Array.isArray(timeline?.scenes) || !Array.isArray(events)) throw new Error('Timeline and SFX events are required.');
  for (let sceneIndex = 0; sceneIndex < timeline.scenes.length; sceneIndex += 1) {
    const scene = timeline.scenes[sceneIndex]; const sceneEvents = events.filter(event => event.sceneIndex === sceneIndex);
    if (sceneEvents.length !== SFX_EVENT_TYPES.length) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} must contain ${SFX_EVENT_TYPES.length} events; found ${sceneEvents.length}.`);
    for (const type of SFX_EVENT_TYPES) {
      const matching = sceneEvents.filter(event => event.type === type);
      if (matching.length !== 1) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} must contain exactly one ${type} event.`);
      const expected = type === 'entrance' ? scene.start : scene.start + (type === 'reveal' ? scene.revealTime : scene.contentEnd - WYR_TEMPLATE.timing.transitionSfxLead);
      if (!Number.isFinite(matching[0].timestamp) || Math.abs(matching[0].timestamp - expected) > 0.000001) throw new Error(`SFX validation failed: scene ${sceneIndex + 1} ${type} event is not at its intended timestamp.`);
    }
  }
  if (events.length !== timeline.scenes.length * SFX_EVENT_TYPES.length) throw new Error('SFX validation failed: the schedule contains unexpected extra events.');
  return true;
};

export const createLocalSfx = async ({ audioDir }) => {
  const sfxDir = path.join(audioDir, 'sfx'); fs.mkdirSync(sfxDir, { recursive: true });
  const entrancePath = path.join(sfxDir, 'entrance.wav'); const transitionPath = path.join(sfxDir, 'transition.wav'); const revealPath = path.join(sfxDir, 'reveal.wav');
  const countdownSequencePath = path.join(sfxDir, 'countdown-sequence.wav');
  const sources = {
    entrance: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-scene-entrance-impact.wav'),
    reveal: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-result-reveal-sting.wav'),
    transition: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-scene-transition-whoosh.wav'),
    countdownSequence: path.join(PROJECT_ROOT, 'assets', 'sfx', 'reference-countdown-sequence.wav'),
  };
  for (const source of [sources.entrance, sources.reveal, sources.transition, sources.countdownSequence]) if (!fs.existsSync(source) || fs.statSync(source).size <= 44) throw new Error(`Reusable reference SFX asset is missing: ${source}`);
  fs.copyFileSync(sources.entrance, entrancePath); fs.copyFileSync(sources.reveal, revealPath); fs.copyFileSync(sources.transition, transitionPath);
  fs.copyFileSync(sources.countdownSequence, countdownSequencePath);
  return {
    provider: 'licensed-reference-extract',
    entrance: { filename: path.basename(sources.entrance), localPath: entrancePath, volume: 0.16 },
    reveal: { filename: path.basename(sources.reveal), localPath: revealPath, volume: 0.21 },
    transition: { filename: path.basename(sources.transition), localPath: transitionPath, volume: 0.125 },
    countdownSequence: { filename: path.basename(sources.countdownSequence), localPath: countdownSequencePath, volume: 0.17, duration: WYR_TEMPLATE.timing.countdownSequenceDuration },
  };
};
