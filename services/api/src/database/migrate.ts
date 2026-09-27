import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";

const migrations = [
  { id: "002_ratings", file: "002_ratings.sql" },
  { id: "003_delivery_pricing_confirmation", file: "003_delivery_pricing_confirmation.sql" }
];

export async function runMigrations(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const migration of migrations) {
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE id=$1", [migration.id]);
    if (exists.rowCount) continue;

    const filePath = path.join(process.cwd(), "services", "api", "src", "database", "migrations", migration.file);
    const sql = await readFile(filePath, "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}
