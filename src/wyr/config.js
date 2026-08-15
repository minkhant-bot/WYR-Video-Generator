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
    // Lightweight flow: 1 initial batched request + at most 1 repair request for whatever's still
    // missing. Do not raise this back toward an unbounded retry-everything loop.
    contentGenerationRetries: integer('WYR_CONTENT_GENERATION_RETRIES', 2, 1, 4),
    // A single bounded retry after a 429: wait for Groq's reported reset, retry once, then fail
    // clearly. The lightweight prompt/schema is what's meant to prevent 429s recurring at all —
    // this is not meant to ride out a sustained outage by hammering Groq repeatedly.
    groqRateLimitRetries: integer('WYR_GROQ_RATE_LIMIT_RETRIES', 1, 0, 3),
    groqRateLimitMaxWaitMs: integer('WYR_GROQ_RATE_LIMIT_MAX_WAIT_MS', 30_000, 1_000, 60_000),
    contentHistoryPath: path.join(contentHistoryDir, 'history.json'),
    secondsPerQuestion: integer('WYR_SECONDS_PER_QUESTION', 7, 4, 8),
    // 8 scenes * 7.25s keeps the finished video at ~56-58s, safely under the 60s short-form limit.
    // The upper bound (7.4) is deliberately tight: 8 * 7.4 = 59.2s, so no environment-variable
    // override can push a single misconfigured value past the hard 60s Shorts ceiling.
    maximumSceneDuration: number('WYR_MAX_SCENE_DURATION', 7.25, 6, 7.4),
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
    // The PostgreSQL question pool is now the primary content source; Groq (via GROQ_API_KEY) only
    // ever refills it in the background or during a bounded emergency top-up, never per-video.
    databaseUrl: process.env.DATABASE_URL || '',
    poolTarget: integer('WYR_POOL_TARGET', 500, 8, 5000),
    poolLowWaterMark: integer('WYR_POOL_LOW_WATER_MARK', 100, 8, 5000),
    // Emergency top-up (triggered mid-request when the pool can't fill a video) is capped far
    // lower than a normal CLI refill run -- a user pressing "Create WYR" must never wait minutes.
    poolEmergencyRefillMaxBatches: integer('WYR_POOL_EMERGENCY_REFILL_MAX_BATCHES', 1, 1, 3),
    poolRefillMaxBatchesPerRun: integer('WYR_POOL_REFILL_MAX_BATCHES_PER_RUN', 10, 1, 100),
    // Gates the /api/admin/content-pool/* routes (see admin-auth.js). Left unset, those routes
    // refuse every request instead of falling open -- there is no default admin token.
    adminToken: process.env.WYR_ADMIN_TOKEN || '',
    pexelsApiKey: credentials.pexelsApiKey,
    pixabayApiKey: process.env.PIXABAY_API_KEY || '',
    edgeVoice: process.env.WYR_EDGE_VOICE || 'en-US-AndrewNeural',
    edgeVoiceRate: process.env.WYR_EDGE_VOICE_RATE || '-10%',
  };
};

// GROQ_API_KEY is intentionally NOT required here: normal video generation is served from the
// PostgreSQL question pool and must keep working even with no Groq key configured at all (Groq is
// only needed to refill the pool). Callers that are about to make a live Groq call (pool refill,
// or the manual/debug live-generation endpoints) check config.groqApiKey themselves.
export const assertProviderConfig = config => {
  const missing = [];
  if (!config.pixabayApiKey && !config.pexelsApiKey) missing.push('PIXABAY_API_KEY or PEXELS_API_KEY');
  if (missing.length) throw new Error(`Missing required API key configuration: ${missing.join(', ')}`);
};
