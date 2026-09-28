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
  { id: "015_business_agent_ai", file: "015_business_agent_ai.sql" },
  { id: "016_buy_order_operations", file: "016_buy_order_operations.sql" },
  { id: "017_drop_off_network", file: "017_drop_off_network.sql" },
  { id: "018_buy_order_payment_destination", file: "018_buy_order_payment_destination.sql" },
  { id: "019_buy_order_payment_checkout", file: "019_buy_order_payment_checkout.sql" },
  { id: "020_buy_order_financial_reconciliation", file: "020_buy_order_financial_reconciliation.sql" },
  { id: "021_delivery_dimensions", file: "021_delivery_dimensions.sql" },
  { id: "022_buy_order_financial_states", file: "022_buy_order_financial_states.sql" },
  { id: "023_buy_order_settlements", file: "023_buy_order_settlements.sql" },
  { id: "024_settlement_accounts", file: "024_settlement_accounts.sql" },
  { id: "025_support_ai_agent", file: "025_support_ai_agent.sql" }
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
