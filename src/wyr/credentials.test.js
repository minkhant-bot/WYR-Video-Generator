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

test('pipeline allows scenes to grow for slower narration and countdown pacing', () => {
  const original = process.env.WYR_MAX_SCENE_DURATION;
  try { delete process.env.WYR_MAX_SCENE_DURATION; assert.equal(getConfig().maximumSceneDuration, 15); }
  finally { original === undefined ? delete process.env.WYR_MAX_SCENE_DURATION : process.env.WYR_MAX_SCENE_DURATION = original; }
});

test('content history and bounded retry configuration support a persistent volume path', () => {
  const names = ['WYR_CONTENT_HISTORY_DIR', 'WYR_CONTENT_GENERATION_RETRIES'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.WYR_CONTENT_HISTORY_DIR = '/data/wyr-content-history'; process.env.WYR_CONTENT_GENERATION_RETRIES = '6';
    const config = getConfig();
    assert.equal(config.contentHistoryPath, '/data/wyr-content-history/history.json');
    assert.equal(config.contentGenerationRetries, 6);
  } finally {
    for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name];
  }
});
