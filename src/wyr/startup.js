import { runMigrations } from './migrate.js';
import { log, redactConnectionSecrets } from './utils.js';
import { seedStaticFoodThemes } from './seed.js';

// Re-exported for backward compatibility -- moved to utils.js so pipeline.js's job-failure
// handling can reuse the same redaction without importing the startup/migration module.
export { redactConnectionSecrets };

// Runs the existing idempotent migration system once, and must resolve before the HTTP server
// starts accepting requests -- a half-migrated schema must never be exposed to traffic. Failure
// is fatal and intentionally not retried here. The small, static FOOD-theme seed is the one
// exception to manual pool maintenance: it is idempotent, network-free, and required immediately
// after migration 004 so an existing questions-only database can serve coherent hook videos.
export const runStartupMigrations = async ({ seedThemes = seedStaticFoodThemes } = {}) => {
  let results;
  try {
    results = await runMigrations();
    const applied = results.filter(result => result.applied).length;
    log('db.migrations_complete', { applied, total: results.length });
  } catch (error) {
    const message = redactConnectionSecrets(error.message);
    log('db.migrations_failed', { message });
    throw new Error(`Startup database migration failed: ${message}`, { cause: error });
  }
  // Seed collisions or incomplete themes are inventory issues, not reasons to abort Railway boot.
  try {
    const themeResults = await seedThemes();
    log('db.food_themes_ready', { inserted: themeResults.filter(result => result.inserted > 0).length, existing: themeResults.filter(result => result.skipped).length, incomplete: themeResults.filter(result => result.rejected.length > 0).length });
  } catch (error) {
    log('db.food_themes_seed_incomplete', { message: redactConnectionSecrets(error.message) });
  }
  return results;
};
