import fs from 'node:fs';
import path from 'node:path';
import { EdgeTTS } from '@seepine/edge-tts';
import { measureAudioDuration, TtsGenerationError } from './audio.js';
import { retry } from './utils.js';
import { WYR_TEMPLATE } from './template.js';

const frameCeil = seconds => Math.ceil(seconds * WYR_TEMPLATE.canvas.fps) / WYR_TEMPLATE.canvas.fps;

export const generateHookVoiceover = async ({ hook, audioDir, voice, rate, timeoutMs, ttsFactory = options => new EdgeTTS(options), measureDuration = measureAudioDuration }) => {
  if (!hook?.ttsText) throw new TtsGenerationError('Hook TTS text is missing.');
  fs.mkdirSync(audioDir, { recursive: true });
  const localPath = path.join(audioDir, 'hook-narration.mp3');
  try {
    const duration = await retry(async attempt => {
      const client = ttsFactory({ voice, lang: 'en-US', outputFormat: 'audio-24khz-96kbitrate-mono-mp3', rate, pitch: '+0Hz', volume: '+0%', timeout: timeoutMs });
      const result = await client.call(hook.ttsText);
      if (!Buffer.isBuffer(result?.data) || result.data.length < 1000) throw new Error('Edge TTS returned empty or invalid hook audio.');
      const candidatePath = `${localPath}.candidate-${attempt}`; fs.writeFileSync(candidatePath, result.data);
      let measured;
      try { measured = await measureDuration(candidatePath); } catch (error) { fs.rmSync(candidatePath, { force: true }); throw error; }
      fs.renameSync(candidatePath, localPath); return measured;
    }, { attempts: 2, label: 'Edge TTS hook' });
    return { narration: hook.ttsText, filename: path.basename(localPath), localPath, duration, voice, rate };
  } catch (error) {
    fs.rmSync(localPath, { force: true });
    throw new TtsGenerationError(`Hook narration could not be generated after bounded retries: ${error.message}`, { cause: error });
  }
};

// Question-local values (voiceStart, countdown, reveal, contentEnd, duration) are not modified.
// Only their absolute starts move by the hook's frame-aligned duration.
export const prependHookToTimeline = (questionTimeline, hookVoiceover) => {
  const duration = frameCeil(hookVoiceover.duration);
  const scenes = questionTimeline.scenes.map(scene => ({ ...scene, start: scene.start + duration, end: scene.end + duration }));
  return {
    ...questionTimeline,
    totalDuration: questionTimeline.totalDuration + duration,
    hook: { start: 0, duration, end: duration, voiceStart: 0, voiceDuration: hookVoiceover.duration, questionStart: duration },
    scenes,
  };
};

export const hookAssets = (assets, maximum = 4) => {
  const ordered = [...assets].sort((a, b) => a.questionIndex - b.questionIndex || String(a.slot).localeCompare(String(b.slot)));
  const q1Index = ordered[0]?.questionIndex;
  const laterGroups = new Map();
  for (const asset of ordered) {
    if (asset.questionIndex === q1Index) continue;
    if (!laterGroups.has(asset.questionIndex)) laterGroups.set(asset.questionIndex, []);
    laterGroups.get(asset.questionIndex).push(asset);
  }
  const representatives = [...laterGroups.values()].map(group => group.find(asset => asset.slot === 'A') || group[0]);
  if (representatives.length <= maximum) return representatives;
  // Evenly sample later questions without reaching back into Q1. For six later questions and a
  // four-image hook this chooses Q2, Q3, Q5 and Q6: a broad theme overview, not four adjacent
  // alternatives that could read like another question.
  return Array.from({ length: maximum }, (_, index) => representatives[Math.floor(index * representatives.length / maximum)]);
};
