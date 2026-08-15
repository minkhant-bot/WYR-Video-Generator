import { insertQuestions, countReady } from '../src/wyr/question-pool.js';
import { closePool } from '../src/wyr/db.js';
import { SEED_QUESTIONS } from '../src/wyr/seed-questions.js';

// Loads the static, hand-curated question bank (src/wyr/seed-questions.js) into the SAME
// PostgreSQL wyr_questions table the Groq refill path writes to -- no second question system.
// Safe to re-run: insertQuestions() dedupes against the DB's UNIQUE(dedupe_key) constraint via
// ON CONFLICT DO NOTHING, so an already-seeded row is reported as a rejection, never duplicated,
// and nothing already in the pool (from Groq or a prior seed run) is ever touched or deleted.
const before = await countReady();
console.log(`Seeding ${SEED_QUESTIONS.length} static question(s) from the curated bank. Ready pool before: ${before}.`);

try {
  const { inserted, rejected } = await insertQuestions(SEED_QUESTIONS, { sourceProvider: 'seed' });
  const after = await countReady();
  console.log(`Done. Inserted ${inserted.length} new question(s), skipped ${rejected.length} already-present/invalid. Ready pool now ${after}.`);
  if (rejected.length && rejected.length < SEED_QUESTIONS.length) {
    console.log('First few skipped (usually duplicates of already-seeded rows):');
    for (const item of rejected.slice(0, 10)) console.log(`  - ${item.reasons.join('; ')}`);
  }
} catch (error) {
  console.error(`Seeding failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
