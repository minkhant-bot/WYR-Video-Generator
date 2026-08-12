import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EdgeTTS } from '@seepine/edge-tts';
import { retry } from './utils.js';
import { WYR_TEMPLATE } from './template.js';
import { resolveFfmpegPath, resolveFfprobePath } from './runtime.js';

const ffmpegPath = resolveFfmpegPath();
const ffprobePath = resolveFfprobePath();
const run = (binary, args, label, captureStdout = false) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] }); let stdout = ''; let stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8000); }); child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${label} exited with code ${code}: ${stderr.slice(-3000)}`)));
});

const narrationPart = text => String(text).replace(/[?.!,;:]+$/g, '').trim().replace(/^./, character => character.toLowerCase());
export const buildNarration = question => `Would you rather ${narrationPart(question.optionA.text)}, or ${narrationPart(question.optionB.text)}?`;

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
    const voiceStart = 0.3; const duration = frameCeil(Math.max(baseDuration, voiceover.duration + voicePaddingSeconds));
    if (duration > maximumSceneDuration) throw new Error(`Scene ${index + 1} narration is ${voiceover.duration.toFixed(2)}s and would exceed the ${maximumSceneDuration}s scene limit. Regenerate shorter option text.`);
    const referenceTail = WYR_TEMPLATE.timing.defaultSceneDuration - WYR_TEMPLATE.timing.transitionOutStart;
    const contentEnd = duration - referenceTail;
    const revealTime = Math.min(contentEnd - 0.24, Math.max(WYR_TEMPLATE.timing.percentageReveal, voiceStart + voiceover.duration + 0.15));
    const scene = { index, start: cursor, duration, end: cursor + duration, voiceStart, voiceDuration: voiceover.duration, revealTime, contentEnd, transitionOutDuration: WYR_TEMPLATE.timing.transitionOutDuration };
    cursor += duration; return scene;
  });
  return { version: 1, baseDuration, maximumSceneDuration, voicePaddingSeconds, totalDuration: cursor, scenes };
};

export const createLocalSfx = async ({ audioDir }) => {
  const sfxDir = path.join(audioDir, 'sfx'); fs.mkdirSync(sfxDir, { recursive: true });
  const transitionPath = path.join(sfxDir, 'transition.wav'); const revealPath = path.join(sfxDir, 'reveal.wav');
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', "aevalsrc=0.12*sin(2*PI*(240+1050*t)*t)*exp(-8*t):s=48000:d=0.34", '-af', 'highpass=f=180,lowpass=f=3600,afade=t=out:st=0.08:d=0.26', '-ac', '2', '-c:a', 'pcm_s16le', transitionPath], 'create transition SFX');
  await run(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'aevalsrc=0.09*sin(2*PI*660*t)+0.065*sin(2*PI*880*t):s=48000:d=0.44', '-af', 'afade=t=in:st=0:d=0.015,afade=t=out:st=0.09:d=0.35', '-ac', '2', '-c:a', 'pcm_s16le', revealPath], 'create reveal SFX');
  return { provider: 'local-generated', transition: { filename: path.basename(transitionPath), localPath: transitionPath, volume: 0.2 }, reveal: { filename: path.basename(revealPath), localPath: revealPath, volume: 0.24 } };
};
