import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './src/wyr/config.js';
import { createJobStore } from './src/wyr/jobs.js';
import { runAutomaticPipeline, runFixturePipeline, runPipeline } from './src/wyr/pipeline.js';
import { expandImageSelection, replaceImageSelection, selectImageCandidate } from './src/wyr/image-picker.js';
import { publicJob, log } from './src/wyr/utils.js';
import { PUBLIC_DIR } from './src/wyr/runtime.js';
import { CredentialInputError, getCredentialStatus, saveLocalCredentials } from './src/wyr/credentials.js';
import { runStartupMigrations } from './src/wyr/startup.js';
import { isAdminRequestAuthorized } from './src/wyr/admin-auth.js';
import { getPoolStats, releaseStaleReservations } from './src/wyr/question-pool.js';
import { getRefillStatus, triggerAdminRefill } from './src/wyr/refill.js';
import { seedStaticPool } from './src/wyr/seed.js';
import { importQuestionPack, PackFormatError } from './src/wyr/pack-import.js';

const startupConfig = getConfig(); const store = createJobStore(startupConfig.rootDir); const publicDir = PUBLIC_DIR;
const json = (res, status, body) => { const payload = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' }); res.end(payload); };
// A read stream with no 'error' listener throws an UNCAUGHT exception on any read failure (a
// transient disk I/O error, the file vanishing between the existsSync check and the actual read,
// etc.) -- Node's default handling for that is to crash the whole process, taking down every other
// in-flight request, not just this one. The listener below turns that into a single failed request.
const sendFile = (res, file, type, downloadName) => { if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'File not found.' }); const headers = { 'content-type': type, 'content-length': fs.statSync(file).size }; if (downloadName) headers['content-disposition'] = `attachment; filename="${downloadName}"`; res.writeHead(200, headers); const stream = fs.createReadStream(file); stream.on('error', error => { log('http.file_stream_failed', { file, message: error.message }); res.destroy(error); }); stream.pipe(res); };
const readJsonBody = req => new Promise((resolve, reject) => {
  const chunks = []; let size = 0; let tooLarge = false;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > 16_384) tooLarge = true;
    else chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) { reject(new CredentialInputError('Settings request is too large.')); return; }
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { reject(new CredentialInputError('Settings must be valid JSON.')); }
  });
  req.on('error', () => reject(new Error('Could not read settings request.')));
});
// JSON question pack import needs a much larger (but still bounded) body limit than the small
// settings/candidate-selection bodies above -- up to MAX_QUESTIONS_PER_PACK questions of plain
// text, no images/binary data. 1MB comfortably covers that with room to spare while staying a
// firm, reasonable ceiling (never an arbitrary/unbounded read).
const MAX_IMPORT_BODY_BYTES = 1_000_000;
const readImportBody = req => new Promise((resolve, reject) => {
  const chunks = []; let size = 0; let tooLarge = false;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_IMPORT_BODY_BYTES) tooLarge = true;
    else chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) { reject(new CredentialInputError(`Import file exceeds the ${MAX_IMPORT_BODY_BYTES} byte limit.`)); return; }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { reject(new PackFormatError('Import file must be valid JSON.')); return; }
    resolve(payload);
  });
  req.on('error', () => reject(new Error('Could not read import request.')));
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, getCredentialStatus());
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const submitted = await readJsonBody(req);
      const status = saveLocalCredentials({ groqApiKey: submitted?.groqApiKey, pexelsApiKey: submitted?.pexelsApiKey });
      return json(res, 200, { saved: true, ...status });
    }
    if (url.pathname === '/api/admin/content-pool/status' || url.pathname === '/api/admin/content-pool/refill' || url.pathname === '/api/admin/content-pool/seed-static' || url.pathname === '/api/admin/content-pool/import-json') {
      const adminConfig = getConfig();
      if (!isAdminRequestAuthorized(req.headers, adminConfig)) return json(res, adminConfig.adminToken ? 401 : 503, { error: adminConfig.adminToken ? 'Unauthorized.' : 'Admin endpoints are not configured.' });
      if (req.method === 'GET' && url.pathname === '/api/admin/content-pool/status') {
        const stats = await getPoolStats();
        return json(res, 200, { ...stats, ...getRefillStatus() });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/content-pool/refill') {
        if (!adminConfig.groqApiKey) return json(res, 503, { error: 'GROQ_API_KEY is not configured; cannot refill the question pool.' });
        let body = {};
        try { body = await readJsonBody(req); } catch { body = {}; }
        const requestedTarget = Number(body?.target);
        const target = Number.isInteger(requestedTarget) && requestedTarget >= 8 && requestedTarget <= 5000 ? requestedTarget : adminConfig.poolTarget;
        const outcome = triggerAdminRefill({ apiKey: adminConfig.groqApiKey, model: adminConfig.groqModel, timeoutMs: adminConfig.timeoutMs, target, batchSize: adminConfig.questionCount, maxBatches: adminConfig.poolRefillMaxBatchesPerRun });
        const stats = await getPoolStats();
        return json(res, outcome.started ? 202 : 200, { started: outcome.started, ...stats, ...outcome.status });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/content-pool/seed-static') {
        return json(res, 200, await seedStaticPool());
      }
      // JSON question pack import: canonical { packVersion: 1, questions: [...] } or a plain
      // array of the same question objects (see pack-import.js). Goes through the SAME
      // insertQuestions()/quality-gate pipeline as seed/refill; never deletes or overwrites
      // anything already in the pool; never calls Groq; idempotent on re-upload.
      if (req.method === 'POST' && url.pathname === '/api/admin/content-pool/import-json') {
        const payload = await readImportBody(req);
        return json(res, 200, await importQuestionPack(payload));
      }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const job = store.create(); const jobConfig = getConfig();
      log('job.queued', { jobId: job.id });
      const runner = process.env.WYR_FIXTURE_MODE === 'true' ? runFixturePipeline : runAutomaticPipeline;
      setImmediate(() => void runner({ job, store, config: jobConfig }));
      return json(res, 202, publicJob(job));
    }
    const slotGetMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/images\/(Q[1-8][AB])$/i);
    if (req.method === 'GET' && slotGetMatch) {
      const job = store.get(slotGetMatch[1]); if (!job) return json(res, 404, { error: 'Job not found.' }); const slot = job.selection?.slots?.[slotGetMatch[2].toUpperCase()]; if (!slot) return json(res, 404, { error: 'Image slot not found.' }); return json(res, 200, slot);
    }
    const selectionGetMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/selection$/i);
    if (req.method === 'GET' && selectionGetMatch) { const job = store.get(selectionGetMatch[1]); if (!job) return json(res, 404, { error: 'Job not found.' }); return json(res, 200, publicJob(job).selection); }
    const moreMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/images\/(Q[1-8][AB])\/more$/i);
    if (req.method === 'POST' && moreMatch) {
      const job = store.get(moreMatch[1]); if (!job) return json(res, 404, { error: 'Job not found.' });
      if (job.status !== 'selecting_images' || !job.selection) return json(res, 409, { error: 'Image selection is not available for this job.' });
      const selection = await expandImageSelection({ selection: job.selection, slotKey: moreMatch[2].toUpperCase(), config: getConfig() }); store.update(job.id, { selection }); return json(res, 200, publicJob(store.get(job.id)));
    }
    const replaceMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/images\/(Q[1-8][AB])\/replace$/i);
    if (req.method === 'POST' && replaceMatch) {
      const job = store.get(replaceMatch[1]);
      if (!job) return json(res, 404, { error: 'Job not found.' });
      if (!['reviewing_images', 'selecting_images'].includes(job.status) || !job.selection) {
        return json(res, 409, { error: 'Image review is not available for this job.' });
      }
      try {
        const selection = await replaceImageSelection({
          selection: job.selection,
          slotKey: replaceMatch[2].toUpperCase(),
          config: getConfig(),
        });
        store.update(job.id, { selection });
        return json(res, 200, publicJob(store.get(job.id)));
      } catch (error) {
        store.update(job.id, { selection: job.selection });
        return json(res, 422, { error: error.message || 'No replacement image was found.' });
      }
    }
    const selectMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/images\/(Q[1-8][AB])\/select$/i);
    if (req.method === 'POST' && selectMatch) {
      const job = store.get(selectMatch[1]); if (!job) return json(res, 404, { error: 'Job not found.' });
      if (job.status !== 'selecting_images' || !job.selection) return json(res, 409, { error: 'Image selection is not available for this job.' });
      const body = await readJsonBody(req); const selection = selectImageCandidate(job.selection, selectMatch[2].toUpperCase(), body?.candidateKey); store.update(job.id, { selection }); return json(res, 200, publicJob(store.get(job.id)));
    }
    const generateMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})\/generate$/i);
    if (req.method === 'POST' && generateMatch) {
      const job = store.get(generateMatch[1]); if (!job) return json(res, 404, { error: 'Job not found.' });
      if (!['reviewing_images', 'selecting_images'].includes(job.status) || !job.selection || job.selection.selectedCount !== job.selection.total) return json(res, 409, { error: `All ${job.selection?.total ?? 0} images must be ready before generation; ready ${job.selection?.selectedCount || 0}/${job.selection?.total ?? 0}.` });
      const plan = JSON.parse(fs.readFileSync(path.join(job.workspace, 'plan.json'), 'utf8')); const config = getConfig(); store.update(job.id, { status: 'generating', stage: 'generating', progress: 40 }); setImmediate(() => void runPipeline({ job, store, config, preparedPlan: plan, selectionState: job.selection })); return json(res, 202, publicJob(store.get(job.id)));
    }
    const match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(video|download|credits))?$/i);
    if (req.method === 'GET' && match) {
      const job = store.get(match[1]); if (!job) return json(res, 404, { error: 'Job not found.' });
      if (!match[2]) return json(res, 200, publicJob(job));
      if (match[2] === 'credits') return sendFile(res, path.join(job.workspace, 'credits.json'), 'application/json');
      if (job.status !== 'completed' || !job.outputPath) return json(res, 404, { error: 'Completed video not found.' });
      return sendFile(res, job.outputPath, 'video/mp4', match[2] === 'download' ? `would-you-rather-${job.id}.mp4` : null);
    }
    if (req.method === 'GET') { const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const file = path.resolve(publicDir, relative); if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, 'index.html')) return json(res, 403, { error: 'Forbidden.' }); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }; return sendFile(res, file, types[path.extname(file)] || 'application/octet-stream'); }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (error instanceof CredentialInputError) return json(res, 400, { error: error.message });
    if (error instanceof PackFormatError) return json(res, 400, { error: error.message });
    log('http.error', { message: error.message });
    return json(res, 500, { error: 'The request could not be completed.' });
  }
});
// Migrations must fully apply before the server accepts a single request -- run them here,
// synchronously blocking listen(), rather than lazily on first DB access from a request handler.
// No seed/refill runs here; that stays a separate, manually-triggered step.
try {
  await runStartupMigrations();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
// The job store is in-memory only (see jobs.js) and never reloaded from disk, so a process restart
// (Railway redeploy, crash, OOM) mid-job orphans its DB reservation forever -- nothing else ever
// revisits a 'reserved' row. Best-effort and non-fatal: the pool having a few stale reservations
// briefly is far less bad than refusing to start the server over it.
try {
  const released = await releaseStaleReservations();
  if (released) log('startup.stale_reservations_released', { count: released });
} catch (error) {
  log('startup.stale_reservation_release_failed', { message: error.message });
}

server.listen(startupConfig.port, '0.0.0.0', () => log('server.started', { port: startupConfig.port, rootDir: startupConfig.rootDir, pexelsConcurrency: startupConfig.pexelsConcurrency, ttsConcurrency: startupConfig.ttsConcurrency, sceneRenderConcurrency: startupConfig.sceneRenderConcurrency, ffmpegThreads: startupConfig.ffmpegThreads }));
