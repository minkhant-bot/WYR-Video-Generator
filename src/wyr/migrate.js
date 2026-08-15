import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withClient } from './db.js';
import { log } from './utils.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const ensureMigrationsTable = client => client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');

// Applies every *.sql file in migrations/ not yet recorded in schema_migrations, in filename
// order, each inside its own transaction. Safe to run repeatedly (already-applied files are
// skipped) and safe to interrupt (each migration either fully commits or fully rolls back).
export const runMigrations = async ({ migrationsDir = MIGRATIONS_DIR } = {}) => {
  const files = fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  return withClient(async client => {
    await ensureMigrationsTable(client);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map(row => row.name));
    const results = [];
    for (const file of files) {
      if (applied.has(file)) { results.push({ file, applied: false }); continue; }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log('db.migration_applied', { file });
        results.push({ file, applied: true });
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
      }
    }
    return results;
  });
};
