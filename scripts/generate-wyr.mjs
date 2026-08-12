import { getConfig } from '../src/wyr/config.js';
import { createJobStore } from '../src/wyr/jobs.js';
import { runPipeline } from '../src/wyr/pipeline.js';

const config = getConfig(); const store = createJobStore(config.rootDir); const job = store.create();
await runPipeline({ job, store, config }); const result = store.get(job.id); console.log(JSON.stringify(result, null, 2)); if (result.status !== 'completed') process.exitCode = 1;
