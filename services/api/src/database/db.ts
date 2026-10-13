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

export function databaseEnabled(): boolean {
  return Boolean(pool);
}

export async function pingDatabase(): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}

/**
 * This API uses a shared PostgreSQL pool and does not set a per-request RLS
 * subject on every query. Therefore it must connect through a trusted service
 * role (BYPASSRLS) or own every RLS-protected table. Fail closed rather than
 * start with a role whose reads would be silently filtered by end-user policies.
 */
export async function assertRlsCompatibleDatabaseRole(): Promise<void> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const result = await pool.query(`
    SELECT r.rolsuper, r.rolbypassrls,
           NOT EXISTS (
             SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relkind = 'r'
                AND c.relrowsecurity
                AND c.relowner <> r.oid
           ) AS owns_rls_tables
      FROM pg_roles r
     WHERE r.rolname = current_user
  `);
  const role = result.rows[0];
  if (!role || !(role.rolsuper || role.rolbypassrls || role.owns_rls_tables)) {
    throw new Error(
      "Unsafe DATABASE_URL role: SwiftDrop API requires a trusted service role with BYPASSRLS or ownership of all RLS-protected tables"
    );
  }
}
