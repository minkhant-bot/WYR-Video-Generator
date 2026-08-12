import path from 'node:path';
import { DEFAULT_DATA_DIR, resolveProjectPath } from './runtime.js';
import { resolveApiKeys } from './credentials.js';

const integer = (name, fallback, min, max) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
};

const number = (name, fallback, min, max) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
  return value;
};

export const getConfig = () => {
  const credentials = resolveApiKeys();
  return {
    port: integer('WYR_PORT', 3100, 1, 65535),
    rootDir: process.env.WYR_JOBS_DIR ? resolveProjectPath(process.env.WYR_JOBS_DIR) : path.join(DEFAULT_DATA_DIR, 'wyr-jobs'),
    questionCount: integer('WYR_QUESTION_COUNT', 8, 8, 8),
    secondsPerQuestion: integer('WYR_SECONDS_PER_QUESTION', 7, 4, 8),
    maximumSceneDuration: number('WYR_MAX_SCENE_DURATION', 11, 8, 15),
    voicePaddingSeconds: number('WYR_VOICE_PADDING_SECONDS', 1.5, 1, 3),
    imageSearchRetries: integer('WYR_MAX_IMAGE_SEARCH_RETRIES', 2, 0, 4),
    timeoutMs: integer('WYR_REQUEST_TIMEOUT_MS', 20_000, 1_000, 120_000),
    ttsTimeoutMs: integer('WYR_TTS_TIMEOUT_MS', 60_000, 5_000, 120_000),
    groqApiKey: credentials.groqApiKey,
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    pexelsApiKey: credentials.pexelsApiKey,
    edgeVoice: process.env.WYR_EDGE_VOICE || 'en-US-AriaNeural',
    edgeVoiceRate: process.env.WYR_EDGE_VOICE_RATE || '+0%',
  };
};

export const assertProviderConfig = config => {
  const missing = [];
  if (!config.groqApiKey) missing.push('GROQ_API_KEY');
  if (!config.pexelsApiKey) missing.push('PEXELS_API_KEY');
  if (missing.length) throw new Error(`Missing required API key configuration: ${missing.join(', ')}`);
};
