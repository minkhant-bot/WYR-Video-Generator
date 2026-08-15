import pg from 'pg';
import { getConfig } from './config.js';

let pool = null;
let poolOverride = null;

const buildPool = () => {
  const { databaseUrl } = getConfig();
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured. The production question pool requires a PostgreSQL connection string.');
  const needsSsl = /sslmode=require/i.test(databaseUrl) || process.env.PGSSLMODE === 'require';
  return new pg.Pool({ connectionString: databaseUrl, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: Number(process.env.WYR_DB_POOL_MAX || 5) });
};

export const getPool = () => poolOverride || (pool ??= buildPool());

export const withClient = async operation => {
  const client = await getPool().connect();
  try { return await operation(client); }
  finally { client.release(); }
};

export const withTransaction = async operation => withClient(async client => {
  await client.query('BEGIN');
  try { const result = await operation(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
});

export const closePool = async () => { if (pool) { await pool.end(); pool = null; } };

// Test-only seam: lets tests substitute a fake pg.Pool-like object ({ connect: async () => fakeClient })
// so unit/mocked-integration tests never open a real network connection. Never used outside tests.
export const __setPoolForTests = fakePool => { poolOverride = fakePool; };
export const __resetPoolForTests = () => { poolOverride = null; };
