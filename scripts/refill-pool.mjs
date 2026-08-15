import { getConfig } from '../src/wyr/config.js';
import { refillPool } from '../src/wyr/refill.js';
import { countReady } from '../src/wyr/question-pool.js';
import { closePool } from '../src/wyr/db.js';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? 'true'] : [arg, 'true'];
}));

const config = getConfig();
const target = Number.isFinite(Number(args.target)) ? Number(args.target) : config.poolTarget;
const maxBatches = Number.isFinite(Number(args['max-batches'])) ? Number(args['max-batches']) : config.poolRefillMaxBatchesPerRun;
const batchSize = Number.isFinite(Number(args['batch-size'])) ? Number(args['batch-size']) : config.questionCount;

if (!config.groqApiKey) { console.error('GROQ_API_KEY is not configured; cannot refill the question pool.'); process.exitCode = 1; process.exit(); }

const before = await countReady();
console.log(`Ready pool: ${before} question(s). Target: ${target}. Refilling in batches of ${batchSize}, up to ${maxBatches} batch(es) this run.`);

try {
  const result = await refillPool({
    apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.timeoutMs,
    target, batchSize, maxBatches,
    onBatch: ({ batch, inserted, rejected, readyAfter }) => console.log(`  batch ${batch}: +${inserted} inserted, ${rejected} rejected, ready=${readyAfter}`),
  });
  console.log(`Done. Batches attempted=${result.batchesAttempted} succeeded=${result.batchesSucceeded}. Inserted ${result.inserted}, rejected ${result.rejected}. Ready pool now ${result.finalReady}. Stopped: ${result.stoppedReason}.`);
  if (result.finalReady < target) console.log(`Below target -- re-run "npm run wyr:refill -- --target=${target}" to continue (progress already saved).`);
} catch (error) {
  console.error(`Refill failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
