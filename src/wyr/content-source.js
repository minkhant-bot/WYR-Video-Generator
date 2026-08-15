import { addIllustrativePercentages } from './content.js';
import { ContentPoolExhaustedError, countReady, selectPlanForJob } from './question-pool.js';
import { maybeTriggerBackgroundRefill, refillPool } from './refill.js';
import { log } from './utils.js';

// Normal path: select+reserve 8 diverse questions straight from the database, zero Groq calls.
// Only if the pool can't currently fill a video does this fall back to ONE bounded emergency
// refill batch (never a live per-video generation call) and retry the selection once. If that
// still isn't enough, it fails clearly with CONTENT_POOL_EMPTY instead of retrying Groq for
// minutes during a user-triggered request.
export const selectContentPlan = async ({ job, config }) => {
  let plan = await selectPlanForJob({ jobId: job.id, count: config.questionCount });
  if (!plan) {
    const ready = await countReady();
    log('content.pool_below_minimum', { ready, required: config.questionCount });
    if (config.groqApiKey) {
      try {
        await refillPool({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.timeoutMs, target: config.poolTarget, batchSize: config.questionCount, maxBatches: config.poolEmergencyRefillMaxBatches });
      } catch (error) { log('content.emergency_refill_failed', { message: error.message }); }
      plan = await selectPlanForJob({ jobId: job.id, count: config.questionCount });
    }
  }
  if (!plan) {
    const ready = await countReady();
    throw new ContentPoolExhaustedError(`CONTENT_POOL_EMPTY: only ${ready} of ${config.questionCount} required questions are available after a bounded emergency refill attempt.`, { ready, required: config.questionCount });
  }
  maybeTriggerBackgroundRefill({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.timeoutMs, target: config.poolTarget, lowWaterMark: config.poolLowWaterMark });
  return addIllustrativePercentages(plan);
};
