import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './utils.js';

const jobs = new Map();
export const createJobStore = rootDir => {
  fs.mkdirSync(rootDir, { recursive: true }); const persist = job => writeJsonAtomic(path.join(job.workspace, 'job.json'), job);
  return {
    create() { const id = crypto.randomUUID(); const workspace = path.join(rootDir, id); for (const folder of ['', 'assets', 'audio', 'render', 'output']) fs.mkdirSync(path.join(workspace, folder), { recursive: true }); const now = new Date().toISOString(); const job = { id, workspace, status: 'queued', stage: 'queued', progress: 0, error: null, topic: null, caption: null, createdAt: now, updatedAt: now, verification: null, selection: null }; jobs.set(id, job); persist(job); return job; },
    get(id) { return jobs.get(id) || null; },
    update(id, changes) { const job = jobs.get(id); if (!job) throw new Error(`Unknown job ${id}.`); Object.assign(job, changes, { updatedAt: new Date().toISOString() }); persist(job); return job; },
  };
};
