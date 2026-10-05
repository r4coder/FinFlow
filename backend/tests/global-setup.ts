import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'invoiceflow_test';
const BASE = process.env.TEST_DATABASE_BASE_URL ?? 'postgresql://postgres:postgres@localhost:5432';

/** Creates a fresh test database and applies every migration in prisma/migrations (same SQL `prisma migrate deploy` runs). */
export default async function setup() {
  const admin = new Client({ connectionString: `${BASE}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const db = new Client({ connectionString: `${BASE}/${TEST_DB}` });
  await db.connect();
  const dir = path.resolve(__dirname, '../prisma/migrations');
  for (const m of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort()) {
    await db.query(fs.readFileSync(path.join(dir, m, 'migration.sql'), 'utf8'));
  }
  await db.end();
}
