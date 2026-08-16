import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { CredentialInputError, getCredentialStatus, readLocalCredentials, resolveApiKeys, saveLocalCredentials } from './credentials.js';

const withTemporaryCredentials = callback => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-credentials-'));
  const filePath = path.join(directory, 'secrets.json');
  try { return callback({ directory, filePath }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
};

test('saving credentials is atomic, restrictive, and status-only', () => withTemporaryCredentials(({ directory, filePath }) => {
  const groqApiKey = 'test-groq-local-secret'; const pexelsApiKey = 'test-pexels-local-secret';
  const status = saveLocalCredentials({ groqApiKey, pexelsApiKey }, { environment: {}, filePath });
  assert.deepEqual(status, { groqConfigured: true, pexelsConfigured: true });
  assert.deepEqual(readLocalCredentials({ environment: {}, filePath }), { groqApiKey, pexelsApiKey });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['secrets.json']);
  const serializedStatus = JSON.stringify(getCredentialStatus({ environment: {}, filePath }));
  assert.equal(serializedStatus.includes(groqApiKey), false);
  assert.equal(serializedStatus.includes(pexelsApiKey), false);
}));

test('saving rejects either empty submitted value without creating a file', () => withTemporaryCredentials(({ filePath }) => {
  assert.throws(() => saveLocalCredentials({ groqApiKey: ' ', pexelsApiKey: 'pexels' }, { environment: {}, filePath }), CredentialInputError);
  assert.throws(() => saveLocalCredentials({ groqApiKey: 'groq', pexelsApiKey: '' }, { environment: {}, filePath }), CredentialInputError);
  assert.equal(fs.existsSync(filePath), false);
}));

test('environment API keys override locally saved keys', () => withTemporaryCredentials(({ filePath }) => {
  saveLocalCredentials({ groqApiKey: 'local-groq', pexelsApiKey: 'local-pexels' }, { environment: {}, filePath });
  const resolved = resolveApiKeys({ environment: { GROQ_API_KEY: 'environment-groq', PEXELS_API_KEY: 'environment-pexels' }, filePath });
  assert.equal(resolved.groqApiKey, 'environment-groq');
  assert.equal(resolved.pexelsApiKey, 'environment-pexels');
  assert.equal(resolved.groqSource, 'environment');
  assert.equal(resolved.pexelsSource, 'environment');
}));

test('complete environment configuration does not depend on the local file', () => withTemporaryCredentials(({ filePath }) => {
  fs.writeFileSync(filePath, 'not json');
  const resolved = resolveApiKeys({ environment: { GROQ_API_KEY: 'environment-groq', PEXELS_API_KEY: 'environment-pexels' }, filePath });
  assert.equal(resolved.groqApiKey, 'environment-groq');
  assert.equal(resolved.pexelsApiKey, 'environment-pexels');
}));

test('pipeline configuration transparently uses saved keys and environment precedence', () => withTemporaryCredentials(({ filePath }) => {
  const names = ['WYR_SECRET_CONFIG_PATH', 'GROQ_API_KEY', 'PEXELS_API_KEY'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    saveLocalCredentials({ groqApiKey: 'local-groq', pexelsApiKey: 'local-pexels' }, { environment: {}, filePath });
    process.env.WYR_SECRET_CONFIG_PATH = filePath; delete process.env.GROQ_API_KEY; delete process.env.PEXELS_API_KEY;
    assert.equal(getConfig().groqApiKey, 'local-groq'); assert.equal(getConfig().pexelsApiKey, 'local-pexels');
    process.env.GROQ_API_KEY = 'environment-groq'; process.env.PEXELS_API_KEY = 'environment-pexels';
    assert.equal(getConfig().groqApiKey, 'environment-groq'); assert.equal(getConfig().pexelsApiKey, 'environment-pexels');
  } finally {
    for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name];
  }
}));

test('pipeline defaults to a natural English male Edge voice', () => {
  const original = process.env.WYR_EDGE_VOICE;
  try { delete process.env.WYR_EDGE_VOICE; assert.equal(getConfig().edgeVoice, 'en-US-AndrewNeural'); }
  finally { original === undefined ? delete process.env.WYR_EDGE_VOICE : process.env.WYR_EDGE_VOICE = original; }
});

test('pipeline defaults to a slower natural Edge speaking rate', () => {
  const original = process.env.WYR_EDGE_VOICE_RATE;
  try { delete process.env.WYR_EDGE_VOICE_RATE; assert.equal(getConfig().edgeVoiceRate, '-10%'); }
  finally { original === undefined ? delete process.env.WYR_EDGE_VOICE_RATE : process.env.WYR_EDGE_VOICE_RATE = original; }
});

test('pipeline caps scene growth tightly enough to keep the finished video under 60 seconds', () => {
  const original = process.env.WYR_MAX_SCENE_DURATION;
  try { delete process.env.WYR_MAX_SCENE_DURATION; assert.equal(getConfig().maximumSceneDuration, 7.25); }
  finally { original === undefined ? delete process.env.WYR_MAX_SCENE_DURATION : process.env.WYR_MAX_SCENE_DURATION = original; }
});

test('content history and bounded retry configuration support a persistent volume path', () => {
  const names = ['WYR_CONTENT_HISTORY_DIR', 'WYR_CONTENT_GENERATION_RETRIES'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.WYR_CONTENT_HISTORY_DIR = '/data/wyr-content-history'; process.env.WYR_CONTENT_GENERATION_RETRIES = '3';
    const config = getConfig();
    assert.equal(config.contentHistoryPath, '/data/wyr-content-history/history.json');
    assert.equal(config.contentGenerationRetries, 3);
  } finally {
    for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name];
  }
});

test('Groq rate-limit recovery has bounded production defaults', () => {
  const names = ['WYR_GROQ_RATE_LIMIT_RETRIES', 'WYR_GROQ_RATE_LIMIT_MAX_WAIT_MS'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const config = getConfig(); assert.equal(config.groqRateLimitRetries, 1); assert.equal(config.groqRateLimitMaxWaitMs, 30_000);
  } finally {
    for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name];
  }
});

test('image recovery has bounded production defaults and rejects unsafe bounds', () => {
  const names = ['WYR_IMAGE_RECOVERY_QUERY_ROUNDS', 'WYR_IMAGE_RECOVERY_MAX_REQUESTS', 'WYR_IMAGE_RECOVERY_MAX_MS'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const defaults = getConfig(); assert.deepEqual([defaults.imageRecoveryQueryRounds, defaults.imageRecoveryMaxRequests, defaults.imageRecoveryMaxMs], [3, 24, 45_000]);
    for (const [name, value] of [['WYR_IMAGE_RECOVERY_QUERY_ROUNDS', '4'], ['WYR_IMAGE_RECOVERY_MAX_REQUESTS', '0'], ['WYR_IMAGE_RECOVERY_MAX_MS', '999']]) {
      for (const resetName of names) delete process.env[resetName]; process.env[name] = value; assert.throws(() => getConfig(), new RegExp(`${name} must be`));
    }
  } finally {
    for (const [name, value] of Object.entries(original)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test('production concurrency controls have safe defaults and accept environment overrides', () => {
  const variables = { WYR_PEXELS_CONCURRENCY: 4, WYR_TTS_CONCURRENCY: 4, WYR_SCENE_RENDER_CONCURRENCY: 2, WYR_FFMPEG_THREADS: 4 };
  const original = Object.fromEntries(Object.keys(variables).map(name => [name, process.env[name]]));
  try {
    for (const name of Object.keys(variables)) delete process.env[name];
    const defaults = getConfig();
    assert.deepEqual([defaults.pexelsConcurrency, defaults.ttsConcurrency, defaults.sceneRenderConcurrency, defaults.ffmpegThreads], [4, 4, 2, 4]);
    process.env.WYR_PEXELS_CONCURRENCY = '7'; process.env.WYR_TTS_CONCURRENCY = '6'; process.env.WYR_SCENE_RENDER_CONCURRENCY = '3'; process.env.WYR_FFMPEG_THREADS = '5';
    const overridden = getConfig();
    assert.deepEqual([overridden.pexelsConcurrency, overridden.ttsConcurrency, overridden.sceneRenderConcurrency, overridden.ffmpegThreads], [7, 6, 3, 5]);
  } finally {
    for (const [name, value] of Object.entries(original)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test('production concurrency controls reject invalid, zero, and negative values', () => {
  const names = ['WYR_PEXELS_CONCURRENCY', 'WYR_TTS_CONCURRENCY', 'WYR_SCENE_RENDER_CONCURRENCY', 'WYR_FFMPEG_THREADS'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) {
      for (const value of ['0', '-1', '1.5', 'invalid']) {
        for (const resetName of names) delete process.env[resetName]; process.env[name] = value;
        assert.throws(() => getConfig(), new RegExp(`${name} must be a positive integer`));
      }
    }
  } finally {
    for (const [name, value] of Object.entries(original)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});

test('web image fallback defaults off and requires explicit opt-in', () => {
  const original = process.env.WYR_ALLOW_WEB_IMAGES;
  try {
    delete process.env.WYR_ALLOW_WEB_IMAGES; assert.equal(getConfig().webImageFallbackEnabled, false);
    process.env.WYR_ALLOW_WEB_IMAGES = 'true'; assert.equal(getConfig().webImageFallbackEnabled, true);
    process.env.WYR_ALLOW_WEB_IMAGES = 'invalid'; assert.throws(() => getConfig(), /WYR_ALLOW_WEB_IMAGES must be true or false/);
  } finally { original === undefined ? delete process.env.WYR_ALLOW_WEB_IMAGES : process.env.WYR_ALLOW_WEB_IMAGES = original; }
});
