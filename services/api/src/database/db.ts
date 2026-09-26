import { Pool, type PoolClient } from "pg";

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

export async function withDatabase<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function pingDatabase(): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}
