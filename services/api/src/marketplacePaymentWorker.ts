import { pool } from "./database/db.js";

export async function reconcileCancelledMarketplacePayments(): Promise<void> {
  if (!pool) return;
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return;

  const lock = await pool.query("SELECT pg_try_advisory_lock(hashtext('swiftdrop:marketplace-payment-reconciliation')) AS acquired");
  if (!lock.rows[0]?.acquired) return;

  try {
    const result = await pool.query(
      `SELECT mop.id,mop.marketplace_order_id,mop.provider_reference,mop.amount_minor,mop.currency,
              mo.status AS order_status
         FROM marketplace_order_payments mop
         JOIN marketplace_orders mo ON mo.id=mop.marketplace_order_id
        WHERE mo.status='CANCELLED'
          AND mop.provider_reference IS NOT NULL
          AND mop.updated_at < now() - interval '5 seconds'
          AND (
            mop.status='PENDING'
            OR (mop.status='AUTHORIZED' AND mop.refund_status IN ('RETRY_REQUIRED','FAILED'))
          )
        ORDER BY mop.updated_at ASC
        LIMIT 25`
    );

    for (const payment of result.rows) {
      const response = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(String(payment.provider_reference)), {
        headers: { authorization: "Bearer " + secret },
        signal: AbortSignal.timeout(15_000)
      }).catch(() => null);
      if (!response) continue;
      const payload = await response.json().catch(() => null) as any;
      const providerStatus = String(payload?.data?.status ?? "").toLowerCase();
      const providerAmount = Number(payload?.data?.amount);
      const providerCurrency = String(payload?.data?.currency ?? "").trim();

      if (providerStatus === "success") {
        const amountMatches = Number.isSafeInteger(providerAmount) &&
          providerAmount === Number(payment.amount_minor) &&
          providerCurrency === String(payment.currency).trim();
        if (!amountMatches) {
          await pool.query(
            "UPDATE marketplace_order_payments SET status='FAILED',provider_status='amount_mismatch_after_cancellation',updated_at=now() WHERE id=$1 AND status='PENDING'",
            [payment.id]
          );
          continue;
        }

        const claimed = await pool.query(
          `UPDATE marketplace_order_payments
              SET status='AUTHORIZED',provider_status='success_after_cancellation',updated_at=now()
            WHERE id=$1 AND status='PENDING'
            RETURNING provider_reference,amount_minor,currency`,
          [payment.id]
        );
        if (!claimed.rows[0]) continue;

        const refundClaim = await pool.query(
          `UPDATE marketplace_order_payments
              SET refund_status='PROCESSING',refund_updated_at=now(),updated_at=now()
            WHERE id=$1
              AND status='AUTHORIZED'
              AND COALESCE(refund_status,'') IN ('RETRY_REQUIRED','FAILED')
            RETURNING id`,
          [payment.id]
        );
        if (!refundClaim.rows[0] && payment.status !== "PENDING") continue;

        const refundResponse = await fetch("https://api.paystack.co/refund", {
          method: "POST",
          headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
          body: JSON.stringify({
            transaction: payment.provider_reference,
            amount: Number(payment.amount_minor),
            currency: String(payment.currency).trim(),
            customer_note: "SwiftDrop refund for a cancelled marketplace order",
            merchant_note: "Automatic reconciliation refund after payment completed after cancellation"
          }),
          signal: AbortSignal.timeout(15_000)
        }).catch(() => null);

        if (!refundResponse) {
          await pool.query(
            "UPDATE marketplace_order_payments SET refund_status='RETRY_REQUIRED',refund_updated_at=now(),updated_at=now() WHERE id=$1",
            [payment.id]
          );
          continue;
        }

        const refundPayload = await refundResponse.json().catch(() => null) as any;
        if (!refundResponse.ok || !refundPayload?.status) {
          await pool.query(
            "UPDATE marketplace_order_payments SET refund_status='FAILED',refund_updated_at=now(),updated_at=now() WHERE id=$1",
            [payment.id]
          );
          continue;
        }

        await pool.query(
          `UPDATE marketplace_order_payments
              SET refund_reference=COALESCE($2,refund_reference),
                  refund_status=$3,
                  refund_amount_minor=$4,
                  refund_updated_at=now(),
                  updated_at=now()
            WHERE id=$1`,
          [
            payment.id,
            String(refundPayload.data?.refund_reference ?? refundPayload.data?.id ?? "") || null,
            String(refundPayload.data?.status ?? "pending").toUpperCase(),
            Number(payment.amount_minor)
          ]
        );
      } else if (["failed","abandoned","reversed","reversal"].includes(providerStatus)) {
        await pool.query(
          "UPDATE marketplace_order_payments SET status='FAILED',provider_status=$2,updated_at=now() WHERE id=$1 AND status='PENDING'",
          [payment.id, providerStatus]
        );
      } else {
        await pool.query(
          "UPDATE marketplace_order_payments SET provider_status=$2,updated_at=now() WHERE id=$1 AND status='PENDING'",
          [payment.id, providerStatus || "pending"]
        );
      }
    }
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext('swiftdrop:marketplace-payment-reconciliation'))");
  }
}
