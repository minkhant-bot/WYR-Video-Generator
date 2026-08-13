import fs from 'node:fs';
import path from 'node:path';

export const log = (event, details = {}) => console.info(JSON.stringify({ time: new Date().toISOString(), component: 'wyr-generator', event, ...details }));
export const writeJsonAtomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
};
export const fetchWithTimeout = async (url, options = {}, timeoutMs = 20_000) => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) { if (error.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`); throw error; }
  finally { clearTimeout(timer); }
};
export const retry = async (operation, { attempts, label }) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) { lastError = error; log('retry.failed', { label, attempt, attempts, message: error.message }); if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 300 * attempt)); }
  }
  throw new Error(`${label} failed after ${attempts} attempt(s): ${lastError?.message}`, { cause: lastError });
};
export const mapWithConcurrency = async (items, concurrency, operation) => {
  if (!Array.isArray(items)) throw new TypeError('Concurrent work items must be an array.');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('Concurrency must be a positive integer.');
  if (typeof operation !== 'function') throw new TypeError('Concurrent operation must be a function.');
  const results = new Array(items.length); let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex; nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
};
export const publicJob = job => ({ id: job.id, status: job.status, stage: job.stage, progress: job.progress, error: job.error, topic: job.topic, createdAt: job.createdAt, updatedAt: job.updatedAt, verification: job.verification, outputUrl: job.status === 'completed' ? `/api/jobs/${job.id}/video` : null, downloadUrl: job.status === 'completed' ? `/api/jobs/${job.id}/download` : null, creditsUrl: job.status === 'completed' ? `/api/jobs/${job.id}/credits` : null });
