import { readFile } from "node:fs/promises";
import { pool } from "./db.js";

const migrations = [
  { id: "002_delivery_proofs", file: "002_delivery_proofs.sql" },
  { id: "003_delivery_events", file: "003_delivery_events.sql" },
  { id: "004_delivery_parcel_metrics", file: "004_delivery_parcel_metrics.sql" },
  { id: "005_receiver_confirmation", file: "005_receiver_confirmation.sql" },
  { id: "006_payment_escrow_status", file: "006_payment_escrow_status.sql" },
  { id: "007_paystack_webhook_events", file: "007_paystack_webhook_events.sql" },
  { id: "008_support_and_receiver_disputes", file: "008_support_and_receiver_disputes.sql" },
  { id: "009_payout_provider_status", file: "009_payout_provider_status.sql" },
  { id: "010_notification_outbox", file: "010_notification_outbox.sql" },
  { id: "011_support_ticket_messages", file: "011_support_ticket_messages.sql" },
  { id: "012_admin_case_audit", file: "012_admin_case_audit.sql" },
  { id: "013_delivery_quotes", file: "013_delivery_quotes.sql" },
  { id: "014_driver_online", file: "014_driver_online.sql" },
  { id: "015_payment_refunds", file: "015_payment_refunds.sql" },
  { id: "016_payment_refund_events", file: "016_payment_refund_events.sql" },
  { id: "017_drop_off_network", file: "017_drop_off_network.sql" },
  { id: "018_drop_off_commissions", file: "018_drop_off_commissions.sql" },
  { id: "019_buy_orders", file: "019_buy_orders.sql" },
  { id: "020_buy_order_settlements", file: "020_buy_order_settlements.sql" },
  { id: "021_identity_verification", file: "021_identity_verification.sql" },
  { id: "022_driver_documents", file: "022_driver_documents.sql" },
  { id: "023_delivery_ratings", file: "023_delivery_ratings.sql" },
  { id: "024_notification_device_tokens", file: "024_notification_device_tokens.sql" },
  { id: "025_pin_lockout", file: "025_pin_lockout.sql" },
  { id: "026_quote_breakdown_fields", file: "026_quote_breakdown_fields.sql" },
  { id: "027_driver_payout_accounts", file: "027_driver_payout_accounts.sql" },
  { id: "028_payment_collection_mode", file: "028_payment_collection_mode.sql" },
  { id: "029_returned_delivery_status", file: "029_returned_delivery_status.sql" },
  { id: "030_delivery_instructions", file: "030_delivery_instructions.sql" },
  { id: "031_auth_refresh_tokens", file: "031_auth_refresh_tokens.sql" },
  { id: "032_password_reset_tokens", file: "032_password_reset_tokens.sql" },
  { id: "033_otp_challenges", file: "033_otp_challenges.sql" },
  { id: "034_user_status", file: "034_user_status.sql" },
  { id: "035_authoritative_pricing_config", file: "035_authoritative_pricing_config.sql" },
  { id: "036_marketplace_listings", file: "036_marketplace_listings.sql" },
  { id: "037_marketplace_orders", file: "037_marketplace_orders.sql" },
  { id: "038_business_ai", file: "038_business_ai.sql" },
  { id: "039_agent_role", file: "039_agent_role.sql" },
  { id: "040_recurring_dispatches", file: "040_recurring_dispatches.sql" },
  { id: "041_delivery_exceptions", file: "041_delivery_exceptions.sql" },
  { id: "042_errands", file: "042_errands.sql" },
  { id: "043_notification_push_receipts", file: "043_notification_push_receipts.sql" },
  { id: "044_buy_order_payments", file: "044_buy_order_payments.sql" },
  { id: "045_marketplace_order_payments", file: "045_marketplace_order_payments.sql" },
  { id: "046_drop_off_parcel_codes", file: "046_drop_off_parcel_codes.sql" },
  { id: "047_station_delivery", file: "047_station_delivery.sql" },
  { id: "048_receiver_escrow_fields", file: "048_receiver_escrow_fields.sql" },
  { id: "049_business_payment_authorizations", file: "049_business_payment_authorizations.sql" },
  { id: "050_support_ai", file: "050_support_ai.sql" },
  { id: "060_errand_multi_stop", file: "060_errand_multi_stop.sql" },
  { id: "061_recurring_dispatch_payments", file: "061_recurring_dispatch_payments.sql" },
  { id: "062_exception_evidence", file: "062_exception_evidence.sql" },
  { id: "063_swiftdrop_business_trust_rules", file: "063_swiftdrop_business_trust_rules.sql" },
  { id: "064_swiftdrop_operational_controls", file: "064_swiftdrop_operational_controls.sql" },
  { id: "065_phase2_in_app_escrow", file: "065_phase2_in_app_escrow.sql" },
  { id: "066_phase2_settlement_release", file: "066_phase2_settlement_release.sql" },
  { id: "067_dva_provisioning_recovery", file: "067_dva_provisioning_recovery.sql" },
  { id: "067_escrow_dispute_refund_audit", file: "067_escrow_dispute_refund_audit.sql" },
  { id: "068_escrow_courier_clawback", file: "068_escrow_courier_clawback.sql" },
  { id: "068_paystack_webhook_replay_safety", file: "068_paystack_webhook_replay_safety.sql" },
  { id: "071_escrow_courier_clawback", file: "071_escrow_courier_clawback.sql" },
  { id: "072_courier_clawback_liability", file: "072_courier_clawback_liability.sql" },
  { id: "073_escrow_webhook_idempotency", file: "073_escrow_webhook_idempotency.sql" },
  { id: "074_dva_requery_rate_limit", file: "074_dva_requery_rate_limit.sql" },
  { id: "075_one_active_escrow_payment", file: "075_one_active_escrow_payment.sql" },
  { id: "076_retire_receiver_payment_mode", file: "076_retire_receiver_payment_mode.sql" },
  { id: "077_mvp_v12_delivery_types", file: "077_mvp_v12_delivery_types.sql" },
  { id: "078_pricing_v2_constants", file: "078_pricing_v2_constants.sql" },
];

export async function runMigrations(): Promise<void> {
  if (!pool) throw new Error("DATABASE_URL is not configured");

  // Bootstrap schema_migrations under the same advisory lock used by individual
  // migrations so concurrent API processes cannot race on first boot.
  // The lock must be acquired before the schema_migrations table is created;
  // locking on a table that does not exist yet is handled via a transaction-level
  // advisory lock keyed by a stable string.
  const bootstrapClient = await pool.connect();
  try {
    await bootstrapClient.query("BEGIN");
    await bootstrapClient.query("SELECT pg_advisory_xact_lock(hashtext('swiftdrop:schema-migrations'))");
    await bootstrapClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await bootstrapClient.query("COMMIT");
  } catch (error) {
    await bootstrapClient.query("ROLLBACK");
    throw error;
  } finally {
    bootstrapClient.release();
  }

  for (const migration of migrations) {
    const migrationUrl = new URL("./migrations/" + migration.file, import.meta.url);
    const sql = await readFile(migrationUrl, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('swiftdrop:schema-migrations'))");
      const exists = await client.query("SELECT 1 FROM schema_migrations WHERE id=$1", [migration.id]);
      if (!exists.rowCount) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
