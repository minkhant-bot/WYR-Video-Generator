import { CONTENT_CATEGORIES, GroqContentProvider, groqRateLimitDetails } from './content.js';
import { insertQuestions, countReady } from './question-pool.js';
import { log } from './utils.js';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Rotates through all 20 categories across successive batches so a long refill run still ends up
// with broad category coverage, without ever asking Groq for more than one batch's worth at once.
const categoriesForBatch = (batchIndex, batchSize) => {
  const start = (batchIndex * batchSize) % CONTENT_CATEGORIES.length;
  return Array.from({ length: batchSize }, (_, offset) => CONTENT_CATEGORIES[(start + offset) % CONTENT_CATEGORIES.length]);
};

// Groq is a content SUPPLIER here, never a per-video dependency: this fills the pool a bounded
// batch at a time, persists progress after every batch (via insertQuestions), and stops cleanly
// -- never hammering the provider -- on a 429, a provider error, or reaching `target`/`maxBatches`.
// Safe to re-run: it always starts from the current READY count, so an interrupted run resumes
// exactly where it left off with zero risk of duplicate or lost work.
export const refillPool = async ({ apiKey, model = 'openai/gpt-oss-20b', timeoutMs = 20_000, target = 500, batchSize = 8, maxBatches = 5, startBatchIndex = 0, sleep = wait, onBatch = null }) => {
  if (!apiKey) throw new Error('GROQ_API_KEY is required for a pool refill.');
  const provider = new GroqContentProvider({ apiKey, model, timeoutMs });
  const summary = { batchesAttempted: 0, batchesSucceeded: 0, inserted: 0, rejected: 0, stoppedReason: null };
  const MAX_INLINE_RETRIES_PER_BATCH = 1;
  outer: for (let offset = 0; offset < maxBatches; offset += 1) {
    const ready = await countReady();
    if (ready >= target) { summary.stoppedReason = 'target_reached'; break; }
    const batch = startBatchIndex + offset;
    for (let inlineRetry = 0; ; inlineRetry += 1) {
      summary.batchesAttempted += 1;
      try {
        const categories = categoriesForBatch(batch, batchSize);
        const generated = await provider.generatePlan(batchSize, { categories });
        const { inserted, rejected } = await insertQuestions(generated.questions);
        summary.batchesSucceeded += 1; summary.inserted += inserted.length; summary.rejected += rejected.length;
        log('pool.refill_batch', { batch, requested: batchSize, inserted: inserted.length, rejected: rejected.length, readyAfter: ready + inserted.length });
        if (onBatch) onBatch({ batch, inserted: inserted.length, rejected: rejected.length, readyAfter: ready + inserted.length });
        break;
      } catch (error) {
        const rateLimit = groqRateLimitDetails(error);
        if (rateLimit.rateLimited) {
          log('pool.refill_rate_limited', { batch, retryAfterMs: rateLimit.retryAfterMs, limitType: rateLimit.limitType });
          if (inlineRetry < MAX_INLINE_RETRIES_PER_BATCH && rateLimit.retryAfterMs && rateLimit.retryAfterMs <= 30_000) { await sleep(rateLimit.retryAfterMs); continue; }
          summary.stoppedReason = 'rate_limited'; break outer;
        }
        summary.stoppedReason = 'provider_error';
        log('pool.refill_batch_failed', { batch, message: error.message });
        break outer;
      }
    }
  }
  const finalReady = await countReady();
  if (!summary.stoppedReason) summary.stoppedReason = 'max_batches_reached';
  log('pool.refill_summary', { ...summary, finalReady, target });
  return { ...summary, finalReady };
};

// Single shared in-flight guard covering BOTH the automatic background trigger below and the
// admin-triggered refill (see triggerAdminRefill) -- they must never run concurrently, since both
// would otherwise hit Groq at the same time and race to insert into the same pool. Only the
// bounded per-video emergency top-up in content-source.js sits outside this guard; that path is
// already capped to a single small batch and must never be blocked by a long-running admin refill.
let refillState = { running: false, source: null, target: null, startedAt: null, lastResult: null };

export const getRefillStatus = () => ({ refillRunning: refillState.running, source: refillState.source, target: refillState.target, startedAt: refillState.startedAt, lastRefillStatus: refillState.lastResult });

const beginRefill = (source, target) => { refillState = { running: true, source, target, startedAt: new Date().toISOString(), lastResult: refillState.lastResult }; };
const finishRefill = lastResult => { refillState = { running: false, source: null, target: null, startedAt: null, lastResult }; };

// Fire-and-forget: triggered when the ready pool drops below the low-water mark. Deliberately
// bounded (small maxBatches) and guarded against overlap -- normal video generation must never
// wait on this, and a slow/failing Groq must never cause more than one background refill at a time.
export const maybeTriggerBackgroundRefill = ({ apiKey, model, timeoutMs, target, lowWaterMark, batchSize, maxBatches = 2 }) => {
  if (refillState.running || !apiKey) return;
  beginRefill('background', target);
  countReady()
    .then(ready => {
      if (ready >= lowWaterMark) { finishRefill(refillState.lastResult); return; }
      log('pool.background_refill_triggered', { ready, lowWaterMark, target });
      return refillPool({ apiKey, model, timeoutMs, target, batchSize, maxBatches })
        .then(result => finishRefill({ ...result, source: 'background', finishedAt: new Date().toISOString() }));
    })
    .catch(error => { log('pool.background_refill_failed', { message: error.message }); finishRefill({ stoppedReason: 'error', message: error.message, source: 'background', finishedAt: new Date().toISOString() }); });
};

// Admin-triggered refill (POST /api/admin/content-pool/refill). Fire-and-forget like the
// background trigger -- the HTTP request returns immediately with the current status rather than
// blocking on the whole run -- but returns { started: false } instead of silently doing nothing
// when a refill (of either kind) is already in flight, so the caller can surface that clearly.
export const triggerAdminRefill = ({ apiKey, model, timeoutMs, target, batchSize, maxBatches }) => {
  if (refillState.running) return { started: false, status: getRefillStatus() };
  if (!apiKey) throw new Error('GROQ_API_KEY is required for a pool refill.');
  beginRefill('admin', target);
  log('pool.admin_refill_started', { target, maxBatches });
  refillPool({ apiKey, model, timeoutMs, target, batchSize, maxBatches })
    .then(result => finishRefill({ ...result, source: 'admin', finishedAt: new Date().toISOString() }))
    .catch(error => { log('pool.admin_refill_failed', { message: error.message }); finishRefill({ stoppedReason: 'error', message: error.message, source: 'admin', finishedAt: new Date().toISOString() }); });
  return { started: true, status: getRefillStatus() };
};

export const __resetBackgroundRefillForTests = () => { refillState = { running: false, source: null, target: null, startedAt: null, lastResult: null }; };
