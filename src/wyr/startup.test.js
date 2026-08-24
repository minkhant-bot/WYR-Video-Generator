import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { runStartupMigrations, redactConnectionSecrets } from './startup.js';
import { createFakeDb } from './test-fake-db.js';

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

test('runStartupMigrations applies the real migrations directory against the fake db without throwing', () => withFakeDb(async fake => {
  const results = await runStartupMigrations();
  assert.ok(results.length > 0);
  assert.ok(results.every(result => result.applied));
  assert.equal(fake.state.migrations.size, results.length);
}));

test('runStartupMigrations is idempotent across repeated startups', () => withFakeDb(async () => {
  const first = await runStartupMigrations();
  const second = await runStartupMigrations();
  assert.ok(first.every(result => result.applied));
  assert.ok(second.every(result => result.applied === false));
}));

test('runStartupMigrations does not abort startup when FOOD theme seeding is incomplete', () => withFakeDb(async () => {
  const results = await runStartupMigrations({ seedThemes: async () => { throw new Error('existing question belongs to another theme'); } });
  assert.ok(results.every(result => result.applied));
}));

test('runStartupMigrations does not abort startup when FOOD reconciliation is incomplete', () => withFakeDb(async () => {
  const results = await runStartupMigrations({
    reconcileThemes: async () => { throw new Error('safe reconciliation conflict'); },
    seedThemes: async () => [],
  });
  assert.ok(results.every(result => result.applied));
}));

test('runStartupMigrations surfaces a clear, wrapped error when a migration fails', () => withFakeDb(async fake => {
  const originalQuery = fake.client.query;
  fake.client.query = async (sql, params) => { if (sql.includes('CREATE TABLE IF NOT EXISTS wyr_questions')) throw new Error('permission denied for schema public'); return originalQuery(sql, params); };
  await assert.rejects(() => runStartupMigrations(), /Startup database migration failed:.*permission denied for schema public/);
}));

test('runStartupMigrations never leaks a postgres connection string in a thrown error', () => withFakeDb(async fake => {
  const originalQuery = fake.client.query;
  const secretUrl = 'postgresql://wyr_user:s3cr3t-pw@db.railway.internal:5432/railway';
  fake.client.query = async (sql, params) => { if (sql.includes('CREATE TABLE IF NOT EXISTS wyr_questions')) throw new Error(`connection to server failed: ${secretUrl}`); return originalQuery(sql, params); };
  await assert.rejects(() => runStartupMigrations(), error => {
    assert.ok(!error.message.includes('s3cr3t-pw'));
    assert.ok(!error.message.includes(secretUrl));
    assert.match(error.message, /postgresql:\/\/\[redacted\]/);
    return true;
  });
}));

test('redactConnectionSecrets strips postgres:// and postgresql:// connection strings', () => {
  assert.equal(redactConnectionSecrets('failed: postgres://user:pw@host:5432/db'), 'failed: postgres://[redacted]');
  assert.equal(redactConnectionSecrets('failed: postgresql://user:pw@host:5432/db extra text'), 'failed: postgresql://[redacted] extra text');
  assert.equal(redactConnectionSecrets('plain error with no secrets'), 'plain error with no secrets');
  assert.equal(redactConnectionSecrets(undefined), undefined);
});
