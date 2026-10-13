import { pool } from "./db.js";
import { runMigrations } from "./migrate.js";

async function main(): Promise<void> {
  if (!pool) {
    throw new Error("DATABASE_URL is required to run database migrations");
  }

  try {
    await runMigrations();
    const result = await pool.query(
      "SELECT id, applied_at FROM schema_migrations ORDER BY id"
    );
    console.log(JSON.stringify({
      event: "database_migrations_verified",
      count: result.rowCount ?? result.rows.length,
      migrations: result.rows.map((row) => ({
        id: String(row.id),
        appliedAt: row.applied_at instanceof Date
          ? row.applied_at.toISOString()
          : String(row.applied_at)
      }))
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Database migration failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
