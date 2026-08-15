import { runMigrations } from './migrate.js';
import { log } from './utils.js';

const CONNECTION_STRING_PATTERN = /(postgres(?:ql)?:\/\/)\S+/gi;
// Postgres client/driver errors occasionally interpolate the connection string itself (e.g. DNS
// or auth failures); strip it before the message ever reaches a log line or stdout.
export const redactConnectionSecrets = message => (typeof message === 'string' ? message.replace(CONNECTION_STRING_PATTERN, '$1[redacted]') : message);

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
