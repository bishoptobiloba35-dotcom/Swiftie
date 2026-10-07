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
  { id: "025_support_ai_agent", file: "025_support_ai_agent.sql" },
  { id: "026_support_ticket_messages", file: "026_support_ticket_messages.sql" },
  { id: "027_recurring_business_dispatch", file: "027_recurring_business_dispatch.sql" },
  { id: "028_delivery_exceptions", file: "028_delivery_exceptions.sql" },
  { id: "029_returned_delivery_status", file: "029_returned_delivery_status.sql" },
  { id: "034_declared_goods_value", file: "034_declared_goods_value.sql" },
  { id: "035_authoritative_pricing_config", file: "035_authoritative_pricing_config.sql" },
  { id: "036_marketplace_listings", file: "036_marketplace_listings.sql" },
  { id: "037_marketplace_order_payments", file: "037_marketplace_order_payments.sql" },
  { id: "038_receiver_payment_mode", file: "038_receiver_payment_mode.sql" },
  { id: "039_payment_checkout_session", file: "039_payment_checkout_session.sql" },
  { id: "040_fixed_drop_off_partner_earning", file: "040_fixed_drop_off_partner_earning.sql" },
  { id: "041_fixed_drop_off_partner_source", file: "041_fixed_drop_off_partner_source.sql" },
  { id: "042_marketplace_listing_disclosure", file: "042_marketplace_listing_disclosure.sql" },
  { id: "043_marketplace_delivery_scheduling", file: "043_marketplace_delivery_scheduling.sql" },
  { id: "044_marketplace_checkout_idempotency", file: "044_marketplace_checkout_idempotency.sql" },
  { id: "045_marketplace_order_history_index", file: "045_marketplace_order_history_index.sql" },
  { id: "046_marketplace_delivery_fulfillment", file: "046_marketplace_delivery_fulfillment.sql" },
  { id: "047_marketplace_delivery_fulfillment_hardening", file: "047_marketplace_delivery_fulfillment_hardening.sql" },
  { id: "048_marketplace_payment_refunds", file: "048_marketplace_payment_refunds.sql" },
  { id: "049_business_payment_authorizations", file: "049_business_payment_authorizations.sql" },
  { id: "050_business_payment_authorization_metadata", file: "050_business_payment_authorization_metadata.sql" },
  { id: "051_shareable_tracking_links", file: "051_shareable_tracking_links.sql" },
  { id: "052_delivery_instructions", file: "052_delivery_instructions.sql" },
  { id: "053_marketplace_seller_reviews", file: "053_marketplace_seller_reviews.sql" },
  { id: "054_delivery_proof", file: "054_delivery_proof.sql" },
  { id: "055_unified_errand_services", file: "055_unified_errand_services.sql" },
  { id: "056_errand_replacement_workflow", file: "056_errand_replacement_workflow.sql" },
  { id: "057_marketplace_seller_readiness", file: "057_marketplace_seller_readiness.sql" },
  { id: "058_errand_item_price_authorization", file: "058_errand_item_price_authorization.sql" },
  { id: "059_errand_item_refunds", file: "059_errand_item_refunds.sql" },
  { id: "060_errand_multi_stop", file: "060_errand_multi_stop.sql" },
  { id: "061_notification_dead_letter", file: "061_notification_dead_letter.sql" },
  { id: "062_legal_acceptance", file: "062_legal_acceptance.sql" },
  { id: "063_swiftdrop_business_trust_rules", file: "063_swiftdrop_business_trust_rules.sql" },
  { id: "064_swiftdrop_operational_controls", file: "064_swiftdrop_operational_controls.sql" },
  { id: "065_phase2_in_app_escrow", file: "065_phase2_in_app_escrow.sql" },
  { id: "066_phase2_settlement_release", file: "066_phase2_settlement_release.sql" },
  { id: "067_escrow_dispute_refund_audit", file: "067_escrow_dispute_refund_audit.sql" },
  { id: "067_dva_provisioning_recovery", file: "067_dva_provisioning_recovery.sql" },
  { id: "068_paystack_webhook_replay_safety", file: "068_paystack_webhook_replay_safety.sql" },
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
