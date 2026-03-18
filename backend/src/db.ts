import { Pool } from "pg";

import { env } from "./config";

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
});

export async function ensureDatabaseReady() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulse_healthchecks (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getDatabaseHealth() {
  const result = await pool.query<{
    now: string;
    current_database: string;
    current_user: string;
  }>(`
    SELECT
      NOW()::TEXT AS now,
      CURRENT_DATABASE() AS current_database,
      CURRENT_USER AS current_user
  `);

  return result.rows[0];
}

export async function createHealthcheck(source: string, note: string) {
  const result = await pool.query<{
    id: string;
    source: string;
    note: string;
    created_at: string;
  }>(
    `
      INSERT INTO pulse_healthchecks (source, note)
      VALUES ($1, $2)
      RETURNING id::TEXT, source, note, created_at::TEXT
    `,
    [source, note],
  );

  return result.rows[0];
}

export async function closeDatabase() {
  await pool.end();
}
