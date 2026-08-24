import { addIllustrativePercentages } from './content.js';
import { ContentPoolExhaustedError, countReadyFood, countReadyLiteralFood, selectPlanForJob } from './question-pool.js';
import { log } from './utils.js';

// Production is DB-first and food-only: select existing ready food rows once, with zero Groq calls.
// If the food inventory cannot assemble a complete video, fail clearly instead of generating or
// selecting a general-category fallback. Pool refill remains an explicit admin/CLI operation.
export const selectContentPlan = async ({ job, config }) => {
  const plan = await selectPlanForJob({ jobId: job.id, count: config.questionCount, baseDuration: config.secondsPerQuestion });
  if (!plan) {
    const readyFood = await countReadyFood();
    const readyLiteralFood = await countReadyLiteralFood();
    log('content.food_pool_below_minimum', { readyFood, readyLiteralFood, required: config.questionCount });
    throw new ContentPoolExhaustedError(
      `CONTENT_POOL_EMPTY: could not assemble ${config.questionCount} strict literal-food questions from ${readyLiteralFood} valid rows (${readyFood} ready food-category records). Non-food fallback and automatic generation are disabled.`,
      { ready: readyLiteralFood, readyFood, readyLiteralFood, required: config.questionCount, category: 'food' },
    );
  }
  return addIllustrativePercentages(plan);
};
