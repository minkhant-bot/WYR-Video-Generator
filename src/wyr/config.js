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

const positiveInteger = (name, fallback) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
};

const boolean = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
};
const webImages = () => { const value = process.env.WYR_ALLOW_WEB_IMAGES; if (value === undefined) return false; if (value === '1' || value === 'true') return true; if (value === '0' || value === 'false') return false; throw new Error('WYR_ALLOW_WEB_IMAGES must be true or false.'); };

export const getConfig = () => {
  const credentials = resolveApiKeys();
  const contentHistoryDir = process.env.WYR_CONTENT_HISTORY_DIR ? resolveProjectPath(process.env.WYR_CONTENT_HISTORY_DIR) : path.join(DEFAULT_DATA_DIR, 'content-history');
  return {
    port: integer('WYR_PORT', 3100, 1, 65535),
    rootDir: process.env.WYR_JOBS_DIR ? resolveProjectPath(process.env.WYR_JOBS_DIR) : path.join(DEFAULT_DATA_DIR, 'wyr-jobs'),
    questionCount: integer('WYR_QUESTION_COUNT', 8, 8, 8),
    contentGenerationRetries: integer('WYR_CONTENT_GENERATION_RETRIES', 4, 1, 8),
    groqRateLimitRetries: integer('WYR_GROQ_RATE_LIMIT_RETRIES', 4, 0, 8),
    groqRateLimitMaxWaitMs: integer('WYR_GROQ_RATE_LIMIT_MAX_WAIT_MS', 60_000, 1_000, 300_000),
    contentHistoryPath: path.join(contentHistoryDir, 'history.json'),
    secondsPerQuestion: integer('WYR_SECONDS_PER_QUESTION', 7, 4, 8),
    maximumSceneDuration: number('WYR_MAX_SCENE_DURATION', 15, 8, 15),
    voicePaddingSeconds: number('WYR_VOICE_PADDING_SECONDS', 1.5, 1, 3),
    imageSearchRetries: integer('WYR_MAX_IMAGE_SEARCH_RETRIES', 2, 0, 4),
    imageRecoveryQueryRounds: integer('WYR_IMAGE_RECOVERY_QUERY_ROUNDS', 3, 0, 3),
    imageRecoveryMaxRequests: integer('WYR_IMAGE_RECOVERY_MAX_REQUESTS', 24, 1, 32),
    imageRecoveryMaxMs: integer('WYR_IMAGE_RECOVERY_MAX_MS', 45_000, 1_000, 120_000),
    pexelsConcurrency: positiveInteger('WYR_PEXELS_CONCURRENCY', 4),
    webImageFallbackEnabled: webImages(),
    ttsConcurrency: positiveInteger('WYR_TTS_CONCURRENCY', 4),
    sceneRenderConcurrency: positiveInteger('WYR_SCENE_RENDER_CONCURRENCY', 2),
    ffmpegThreads: positiveInteger('WYR_FFMPEG_THREADS', 4),
    timeoutMs: integer('WYR_REQUEST_TIMEOUT_MS', 20_000, 1_000, 120_000),
    ttsTimeoutMs: integer('WYR_TTS_TIMEOUT_MS', 60_000, 5_000, 120_000),
    groqApiKey: credentials.groqApiKey,
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    pexelsApiKey: credentials.pexelsApiKey,
    pixabayApiKey: process.env.PIXABAY_API_KEY || '',
    edgeVoice: process.env.WYR_EDGE_VOICE || 'en-US-AndrewNeural',
    edgeVoiceRate: process.env.WYR_EDGE_VOICE_RATE || '-10%',
  };
};

export const assertProviderConfig = config => {
  const missing = [];
  if (!config.groqApiKey) missing.push('GROQ_API_KEY');
  if (!config.pexelsApiKey) missing.push('PEXELS_API_KEY');
  if (missing.length) throw new Error(`Missing required API key configuration: ${missing.join(', ')}`);
};
