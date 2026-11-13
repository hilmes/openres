import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  await client.query('COMMIT');
  console.log('OpenRes schema is ready.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Migration failed:', error instanceof Error ? error.name : 'UnknownError');
  process.exitCode = 1;
} finally { await client.end(); }
