import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './src/wyr/config.js';
import { createJobStore } from './src/wyr/jobs.js';
import { runFixturePipeline, runPipeline } from './src/wyr/pipeline.js';
import { publicJob, log } from './src/wyr/utils.js';
import { PUBLIC_DIR } from './src/wyr/runtime.js';

const config = getConfig(); const store = createJobStore(config.rootDir); const publicDir = PUBLIC_DIR;
const json = (res, status, body) => { const payload = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' }); res.end(payload); };
const sendFile = (res, file, type, downloadName) => { if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'File not found.' }); const headers = { 'content-type': type, 'content-length': fs.statSync(file).size }; if (downloadName) headers['content-disposition'] = `attachment; filename="${downloadName}"`; res.writeHead(200, headers); fs.createReadStream(file).pipe(res); };
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/jobs') { const job = store.create(); log('job.queued', { jobId: job.id }); const runner = process.env.WYR_FIXTURE_MODE === 'true' ? runFixturePipeline : runPipeline; setImmediate(() => void runner({ job, store, config })); return json(res, 202, publicJob(job)); }
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
  } catch (error) { log('http.error', { message: error.message }); return json(res, 500, { error: error.message }); }
});
server.listen(config.port, '0.0.0.0', () => log('server.started', { port: config.port, rootDir: config.rootDir }));
