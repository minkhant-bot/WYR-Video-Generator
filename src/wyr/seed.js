import { getPoolStats, insertFoodTheme, insertQuestions } from './question-pool.js';
import { SEED_QUESTIONS } from './seed-questions.js';
import { FOOD_THEME_SEEDS } from './food-themes.js';

// Backs POST /api/admin/content-pool/seed-static (see wyr-server.js) and performs exactly what
// `npm run wyr:seed` (scripts/seed-pool.mjs) does: the same curated dataset through the same
// insertQuestions()/wyr_questions path the Groq refill uses -- no network call, no GROQ_API_KEY,
// no separate question system. Idempotent via the DB's UNIQUE(dedupe_key) + ON CONFLICT DO
// NOTHING: an already-seeded row always comes back as a "skipped" duplicate, never inserted
// twice, and nothing already in the pool is ever touched or deleted. Returns a safe numeric-only
// summary -- never question text, row ids, or anything DB/credential-shaped.
export const seedStaticPool = async () => {
  const { inserted, rejected } = await insertQuestions(SEED_QUESTIONS, { sourceProvider: 'seed' });
  const themeResults = await seedStaticFoodThemes();
  const skipped = rejected.filter(item => item.reasons.some(reason => reason.includes('duplicate')));
  const trueRejected = rejected.filter(item => !item.reasons.some(reason => reason.includes('duplicate')));
  const stats = await getPoolStats();
  return { inserted: inserted.length + themeResults.reduce((sum, result) => sum + result.inserted, 0), skipped: skipped.length, rejected: trueRejected.length + themeResults.reduce((sum, result) => sum + result.rejected.length, 0), themesInserted: themeResults.filter(result => result.inserted > 0).length, themesSkipped: themeResults.filter(result => result.skipped).length, ready: stats.ready, total: stats.total };
};

export const seedStaticFoodThemes = async () => {
  const results = [];
  for (const theme of FOOD_THEME_SEEDS) results.push(await insertFoodTheme(theme, { sourceProvider: 'seed-theme' }));
  return results;
};
