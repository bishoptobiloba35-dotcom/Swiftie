/**
 * Digital Pay-on-Delivery (POD) helpers.
 * Cash is never permitted. Client never marks payment complete.
 * Only a verified Paystack webhook may move RECEIVER_PAYMENT_PENDING → PAYMENT_VERIFIED.
 */

import { canTransition, type DeliveryStatus } from "./deliveryState.js";
import { courierShareForOrder } from "./pricingConstants.js";

export type PodPaymentMode = "PAY_ON_DELIVERY";

async function getPool() {
  const mod = await import("./database/db.js");
  return mod.pool;
}

/**
 * Mark order as awaiting receiver digital payment.
 * Only legal from ARRIVED when payment_mode is PAY_ON_DELIVERY.
 */
export async function markReceiverPaymentPending(deliveryId: string, actorUserId?: string): Promise<{ ok: boolean; error?: string }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "Database unavailable" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query(
      `SELECT id, status, payment_mode, receiver_payment_pending
         FROM deliveries WHERE id=$1 FOR UPDATE`,
      [deliveryId]
    )).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Order not found" };
    }
    if (row.payment_mode !== "PAY_ON_DELIVERY") {
      await client.query("ROLLBACK");
      return { ok: false, error: "Order is not PAY_ON_DELIVERY" };
    }
    const from = row.status as DeliveryStatus;
    if (!canTransition(from, "RECEIVER_PAYMENT_PENDING") && from !== "RECEIVER_PAYMENT_PENDING") {
      await client.query("ROLLBACK");
      return { ok: false, error: `Invalid transition ${from} → RECEIVER_PAYMENT_PENDING` };
    }
    if (from !== "RECEIVER_PAYMENT_PENDING") {
      await client.query(
        `UPDATE deliveries
            SET status='RECEIVER_PAYMENT_PENDING',
                receiver_payment_pending=true,
                updated_at=now()
          WHERE id=$1`,
        [deliveryId]
      );
      await client.query(
        `INSERT INTO delivery_events (delivery_id, event_type, actor_user_id, metadata)
         VALUES ($1,'RECEIVER_PAYMENT_PENDING',$2,$3::jsonb)`,
        [deliveryId, actorUserId ?? null, JSON.stringify({ payment_mode: "PAY_ON_DELIVERY" })]
      );
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    return { ok: false, error: "Unable to mark receiver payment pending" };
  } finally {
    client.release();
  }
}

/**
 * Apply verified Paystack webhook for digital POD.
 * Sets PAYMENT_VERIFIED + pod_verified_at. Idempotent.
 */
export async function applyPodPaymentVerified(
  deliveryId: string,
  providerReference: string,
  amountMinor: number
): Promise<{ ok: boolean; error?: string; alreadyVerified?: boolean }> {
  const pool = await getPool();
  if (!pool) return { ok: false, error: "Database unavailable" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query(
      `SELECT d.id, d.status, d.payment_mode, d.quote_total_minor, d.pod_verified_at,
              d.pricing_version, d.quote_base_fare_minor, d.quote_distance_fare_minor,
              d.quote_weight_fare_minor, d.quote_size_fare_minor, d.quote_perishable_surcharge_minor,
              d.quote_express_surcharge_minor, d.quote_fuel_surcharge_minor,
              d.quote_service_fee_minor, d.quote_protection_reserve_minor,
              p.amount_minor AS payment_amount_minor, p.status AS payment_status
         FROM deliveries d
         LEFT JOIN payments p ON p.delivery_id = d.id
        WHERE d.id=$1
        FOR UPDATE OF d`,
      [deliveryId]
    )).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Order not found" };
    }
    if (row.payment_mode !== "PAY_ON_DELIVERY") {
      await client.query("ROLLBACK");
      return { ok: false, error: "Order is not PAY_ON_DELIVERY" };
    }
    if (row.pod_verified_at || row.status === "PAYMENT_VERIFIED") {
      await client.query("COMMIT");
      return { ok: true, alreadyVerified: true };
    }
    const expected = Number(row.quote_total_minor ?? row.payment_amount_minor ?? 0);
    if (!Number.isSafeInteger(amountMinor) || amountMinor !== expected || expected <= 0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Amount mismatch" };
    }
    const from = row.status as DeliveryStatus;
    if (!canTransition(from, "PAYMENT_VERIFIED") && from !== "PAYMENT_VERIFIED") {
      await client.query("ROLLBACK");
      return { ok: false, error: `Invalid transition ${from} → PAYMENT_VERIFIED` };
    }
    const baseFareMinor = Number(row.quote_base_fare_minor ?? 0);
    const deliveryFeeMinor = baseFareMinor
      + Number(row.quote_distance_fare_minor ?? 0)
      + Number(row.quote_weight_fare_minor ?? 0)
      + Number(row.quote_size_fare_minor ?? 0)
      + Number(row.quote_perishable_surcharge_minor ?? 0)
      + Number(row.quote_express_surcharge_minor ?? 0)
      + Number(row.quote_fuel_surcharge_minor ?? 0);
    const configuredPayoutPercent = process.env.DRIVER_PAYOUT_PERCENT === undefined
      ? undefined
      : Number(process.env.DRIVER_PAYOUT_PERCENT);
    const courierShareMinor = courierShareForOrder({
      pricingVersion: row.pricing_version ?? null,
      deliveryFeeMinor,
      baseFareMinor,
      configuredPercent: configuredPayoutPercent
    });
    const serviceChargeMinor = Number(row.quote_service_fee_minor ?? 0);
    const protectionReserveMinor = Number(row.quote_protection_reserve_minor ?? 0);
    const swiftdropMarginMinor = expected - courierShareMinor - serviceChargeMinor - protectionReserveMinor;
    if (![courierShareMinor, serviceChargeMinor, protectionReserveMinor, swiftdropMarginMinor].every(Number.isSafeInteger) || swiftdropMarginMinor < 0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Invalid escrow split for verified POD payment" };
    }
    await client.query(
      "UPDATE deliveries SET status='PAYMENT_VERIFIED', receiver_payment_pending=false, pod_verified_at=COALESCE(pod_verified_at, now()), escrow_payment_state='paid_escrow', escrow_total_paid_minor=$2, escrow_courier_share_minor=$3, escrow_service_charge_minor=$4, escrow_protection_reserve_minor=$5, escrow_swiftdrop_margin_minor=$6, escrow_merchant_share_minor=0, updated_at=now() WHERE id=$1",
      [deliveryId, expected, courierShareMinor, serviceChargeMinor, protectionReserveMinor, swiftdropMarginMinor]
    );
    await client.query(
      "INSERT INTO escrow_ledgers(order_id,total_paid_minor,courier_share_minor,service_charge_minor,protection_reserve_minor,swiftdrop_margin_minor,merchant_share_minor,state) VALUES($1,$2,$3,$4,$5,$6,0,'paid_escrow') ON CONFLICT(order_id) DO UPDATE SET total_paid_minor=EXCLUDED.total_paid_minor,courier_share_minor=EXCLUDED.courier_share_minor,service_charge_minor=EXCLUDED.service_charge_minor,protection_reserve_minor=EXCLUDED.protection_reserve_minor,swiftdrop_margin_minor=EXCLUDED.swiftdrop_margin_minor,state='paid_escrow',updated_at=now() WHERE escrow_ledgers.state IN ('pending_payment','failed')",
      [deliveryId, expected, courierShareMinor, serviceChargeMinor, protectionReserveMinor, swiftdropMarginMinor]
    );
    await client.query(
      `UPDATE payments
          SET status='HELD',
              escrow_status='HELD',
              provider_reference=COALESCE(provider_reference, $2),
              updated_at=now()
        WHERE delivery_id=$1`,
      [deliveryId, providerReference]
    );
    await client.query(
      `INSERT INTO delivery_events (delivery_id, event_type, metadata)
       VALUES ($1,'PAYMENT_VERIFIED',$2::jsonb)`,
      [deliveryId, JSON.stringify({ provider_reference: providerReference, amount_minor: amountMinor, source: "paystack_webhook" })]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    return { ok: false, error: "Unable to apply POD payment verification" };
  } finally {
    client.release();
  }
}

/**
 * Guard: physical hand-over / PIN may proceed only after payment is verified for POD orders.
 */
export function podAllowsHandover(paymentMode: string, status: DeliveryStatus, podVerifiedAt: string | null): boolean {
  if (paymentMode !== "PAY_ON_DELIVERY") return true;
  return Boolean(podVerifiedAt) || status === "PAYMENT_VERIFIED" || status === "HANDED_OVER" || status === "PIN_CONFIRMED" || status === "DELIVERED" || status === "DISPUTE_WINDOW" || status === "RELEASED";
}
