import { readFile } from "node:fs/promises";
import { pool } from "./db.js";

const migrations = [
  { id: "002_ratings", file: "002_ratings.sql" },
  { id: "003_delivery_pricing_confirmation", file: "003_delivery_pricing_confirmation.sql" },
  { id: "004_receiver_ratings", file: "004_receiver_ratings.sql" },
  { id: "005_driver_payout_accounts", file: "005_driver_payout_accounts.sql" },
  { id: "006_payout_provider_status", file: "006_payout_provider_status.sql" },
  { id: "007_paystack_webhook_events", file: "007_paystack_webhook_events.sql" },
  { id: "008_support_and_receiver_disputes", file: "008_support_and_receiver_disputes.sql" },
  { id: "009_payment_refunds", file: "009_payment_refunds.sql" },
  { id: "010_admin_case_audit", file: "010_admin_case_audit.sql" },
  { id: "011_notification_outbox", file: "011_notification_outbox.sql" },
  { id: "012_notification_push_receipts", file: "012_notification_push_receipts.sql" },
  { id: "013_payment_refund_totals", file: "013_payment_refund_totals.sql" },
  { id: "014_payment_refund_events", file: "014_payment_refund_events.sql" },
  { id: "015_product_plans_ai_agents", file: "015_product_plans_ai_agents.sql" },
  { id: "016_ai_daily_spend_reset", file: "016_ai_daily_spend_reset.sql" }
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

    const migrationUrl = new URL("./migrations/" + migration.file, import.meta.url);
    const sql = await readFile(migrationUrl, "utf8");
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
