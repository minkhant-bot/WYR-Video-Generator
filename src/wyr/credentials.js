import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, resolveProjectPath } from './runtime.js';

export const DEFAULT_CREDENTIALS_PATH = path.join(PROJECT_ROOT, '.wyr-secrets.json');

export class CredentialInputError extends Error {}

const credentialsPath = environment => environment.WYR_SECRET_CONFIG_PATH
  ? resolveProjectPath(environment.WYR_SECRET_CONFIG_PATH)
  : DEFAULT_CREDENTIALS_PATH;

const normalizeStoredValue = value => typeof value === 'string' ? value.trim() : '';

export const readLocalCredentials = ({ environment = process.env, filePath = credentialsPath(environment) } = {}) => {
  if (!fs.existsSync(filePath)) return { groqApiKey: '', pexelsApiKey: '' };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new Error('The local API key configuration could not be read.'); }
  return {
    groqApiKey: normalizeStoredValue(parsed?.groqApiKey),
    pexelsApiKey: normalizeStoredValue(parsed?.pexelsApiKey),
  };
};

export const resolveApiKeys = ({ environment = process.env, filePath = credentialsPath(environment) } = {}) => {
  const groqEnvironmentValue = normalizeStoredValue(environment.GROQ_API_KEY);
  const pexelsEnvironmentValue = normalizeStoredValue(environment.PEXELS_API_KEY);
  const local = groqEnvironmentValue && pexelsEnvironmentValue
    ? { groqApiKey: '', pexelsApiKey: '' }
    : readLocalCredentials({ environment, filePath });
  return {
    groqApiKey: groqEnvironmentValue || local.groqApiKey,
    pexelsApiKey: pexelsEnvironmentValue || local.pexelsApiKey,
    groqSource: groqEnvironmentValue ? 'environment' : local.groqApiKey ? 'local' : null,
    pexelsSource: pexelsEnvironmentValue ? 'environment' : local.pexelsApiKey ? 'local' : null,
  };
};

export const getCredentialStatus = options => {
  const resolved = resolveApiKeys(options);
  return {
    groqConfigured: Boolean(resolved.groqApiKey),
    pexelsConfigured: Boolean(resolved.pexelsApiKey),
  };
};

export const saveLocalCredentials = ({ groqApiKey, pexelsApiKey }, { environment = process.env, filePath = credentialsPath(environment) } = {}) => {
  const normalized = {
    groqApiKey: normalizeStoredValue(groqApiKey),
    pexelsApiKey: normalizeStoredValue(pexelsApiKey),
  };
  if (!normalized.groqApiKey || !normalized.pexelsApiKey) throw new CredentialInputError('Both API keys are required.');

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw new Error('The local API key configuration could not be saved.');
  }
  return getCredentialStatus({ environment, filePath });
};
