import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './src/wyr/config.js';
import { createJobStore } from './src/wyr/jobs.js';
import { runFixturePipeline, runPipeline } from './src/wyr/pipeline.js';
import { publicJob, log } from './src/wyr/utils.js';
import { PUBLIC_DIR } from './src/wyr/runtime.js';
import { CredentialInputError, getCredentialStatus, saveLocalCredentials } from './src/wyr/credentials.js';

const startupConfig = getConfig(); const store = createJobStore(startupConfig.rootDir); const publicDir = PUBLIC_DIR;
const json = (res, status, body) => { const payload = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' }); res.end(payload); };
const sendFile = (res, file, type, downloadName) => { if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'File not found.' }); const headers = { 'content-type': type, 'content-length': fs.statSync(file).size }; if (downloadName) headers['content-disposition'] = `attachment; filename="${downloadName}"`; res.writeHead(200, headers); fs.createReadStream(file).pipe(res); };
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, getCredentialStatus());
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const submitted = await readJsonBody(req);
      const status = saveLocalCredentials({ groqApiKey: submitted?.groqApiKey, pexelsApiKey: submitted?.pexelsApiKey });
      return json(res, 200, { saved: true, ...status });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const job = store.create(); const jobConfig = getConfig();
      log('job.queued', { jobId: job.id });
      const runner = process.env.WYR_FIXTURE_MODE === 'true' ? runFixturePipeline : runPipeline;
      setImmediate(() => void runner({ job, store, config: jobConfig }));
      return json(res, 202, publicJob(job));
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
    log('http.error', { message: error.message });
    return json(res, 500, { error: 'The request could not be completed.' });
  }
});
server.listen(startupConfig.port, '0.0.0.0', () => log('server.started', { port: startupConfig.port, rootDir: startupConfig.rootDir }));
