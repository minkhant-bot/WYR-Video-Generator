import { runMigrations } from '../src/wyr/migrate.js';
import { closePool } from '../src/wyr/db.js';

runMigrations()
  .then(async results => {
    const applied = results.filter(result => result.applied);
    console.log(`Migrations complete: ${applied.length} applied, ${results.length - applied.length} already up to date.`);
    for (const result of applied) console.log(`  applied: ${result.file}`);
    await closePool();
  })
  .catch(async error => {
    console.error(`Migration failed: ${error.message}`);
    await closePool().catch(() => {});
    process.exitCode = 1;
  });
