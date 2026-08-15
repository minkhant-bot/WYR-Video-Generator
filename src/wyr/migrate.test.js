import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetPoolForTests, __setPoolForTests } from './db.js';
import { runMigrations } from './migrate.js';
import { createFakeDb } from './test-fake-db.js';

const withTempMigrations = async (files, operation) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-migrations-'));
  try {
    for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
    await operation(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const withFakeDb = async operation => {
  const fake = createFakeDb();
  __setPoolForTests(fake.pool);
  try { await operation(fake); }
  finally { __resetPoolForTests(); }
};

test('runMigrations applies files in filename order and records them as applied', () => withFakeDb(async fake => withTempMigrations(
  { '002_second.sql': 'SELECT 2;', '001_first.sql': 'SELECT 1;' },
  async migrationsDir => {
    const results = await runMigrations({ migrationsDir });
    assert.deepEqual(results.map(r => r.file), ['001_first.sql', '002_second.sql']);
    assert.ok(results.every(r => r.applied));
    assert.deepEqual([...fake.state.migrations].sort(), ['001_first.sql', '002_second.sql']);
  },
)));

test('runMigrations is idempotent: re-running skips already-applied files', () => withFakeDb(async () => withTempMigrations(
  { '001_first.sql': 'SELECT 1;' },
  async migrationsDir => {
    const first = await runMigrations({ migrationsDir });
    assert.equal(first[0].applied, true);
    const second = await runMigrations({ migrationsDir });
    assert.equal(second[0].applied, false);
  },
)));

test('a failing migration rolls back and does not get recorded as applied', () => withFakeDb(async fake => withTempMigrations(
  { '001_broken.sql': 'THIS IS NOT VALID SQL;' },
  async migrationsDir => {
    const originalQuery = fake.client.query;
    fake.client.query = async (sql, params) => { if (sql.includes('THIS IS NOT VALID SQL')) throw new Error('syntax error'); return originalQuery(sql, params); };
    await assert.rejects(() => runMigrations({ migrationsDir }), /Migration 001_broken.sql failed/);
    assert.equal(fake.state.migrations.has('001_broken.sql'), false);
  },
)));
