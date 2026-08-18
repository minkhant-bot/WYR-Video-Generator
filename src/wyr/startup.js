import { runMigrations } from './migrate.js';
import { log, redactConnectionSecrets } from './utils.js';

// Re-exported for backward compatibility -- moved to utils.js so pipeline.js's job-failure
// handling can reuse the same redaction without importing the startup/migration module.
export { redactConnectionSecrets };

// Runs the existing idempotent migration system once, and must resolve before the HTTP server
// starts accepting requests -- a half-migrated schema must never be exposed to traffic. Failure
// is fatal and intentionally not retried here: a broken migration needs a human to look at it,
// not a crash-loop hammering the database. Never runs seed/refill; that stays a separate,
// manually-triggered step (see scripts/refill-pool.mjs).
export const runStartupMigrations = async () => {
  try {
    const results = await runMigrations();
    const applied = results.filter(result => result.applied).length;
    log('db.migrations_complete', { applied, total: results.length });
    return results;
  } catch (error) {
    const message = redactConnectionSecrets(error.message);
    log('db.migrations_failed', { message });
    throw new Error(`Startup database migration failed: ${message}`, { cause: error });
  }
};
