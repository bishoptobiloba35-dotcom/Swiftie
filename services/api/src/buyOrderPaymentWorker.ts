import { pool } from "./database/db.js";

export async function reconcilePendingBuyOrderPayments(): Promise<void> {
  if (!pool) return;
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return;

  const lock = await pool.query(
    "SELECT pg_try_advisory_lock(hashtext('swiftdrop:buy-payment-reconciliation')) AS acquired"
  );
  if (!lock.rows[0]?.acquired) return;

  try {
    const result = await pool.query(
      `SELECT bop.id,bop.buy_order_id,bop.provider_reference,bop.amount_minor,bop.currency,
              bo.customer_user_id,bo.business_id
         FROM buy_order_payments bop
         JOIN buy_orders bo ON bo.id=bop.buy_order_id
        WHERE bop.status='PENDING'
          AND bop.provider_reference IS NOT NULL
          AND bop.updated_at < now() - interval '10 seconds'
        ORDER BY bop.updated_at ASC
        LIMIT 25`
    );

    for (const payment of result.rows) {
      const response = await fetch(
        "https://api.paystack.co/transaction/verify/" + encodeURIComponent(String(payment.provider_reference)),
        {
          headers: { authorization: "Bearer " + secret },
          signal: AbortSignal.timeout(15_000)
        }
      ).catch(() => null);
      if (!response) continue;

      const payload = await response.json().catch(() => null) as any;
      const providerStatus = String(payload?.data?.status ?? "").toLowerCase();
      const providerAmount = Number(payload?.data?.amount);
      const providerCurrency = String(payload?.data?.currency ?? "").trim();
      const amountMatches =
        Number.isSafeInteger(providerAmount) &&
        providerAmount === Number(payment.amount_minor) &&
        providerCurrency === String(payment.currency).trim();

      if (providerStatus === "success") {
        if (!amountMatches) {
          await pool.query(
            "UPDATE buy_order_payments SET status='FAILED',provider_status='amount_mismatch_reconciliation',updated_at=now() WHERE id=$1 AND status='PENDING'",
            [payment.id]
          );
          await pool.query(
            "UPDATE buy_orders SET payment_status='FAILED',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('HELD','REFUNDED')",
            [payment.buy_order_id]
          );
          continue;
        }

        const claimed = await pool.query(
          "UPDATE buy_order_payments SET status='HELD',provider_status='success_reconciled',updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING id",
          [payment.id]
        );
        if (!claimed.rows[0]) continue;

        await pool.query(
          "UPDATE buy_orders SET payment_reference=$2,payment_status='HELD',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('REFUNDED')",
          [payment.buy_order_id, payment.provider_reference]
        );

        const authorization = payload?.data?.authorization;
        if (
          payment.business_id &&
          authorization?.reusable === true &&
          typeof authorization.authorization_code === "string" &&
          authorization.authorization_code.trim()
        ) {
          const customer = (await pool.query(
            "SELECT email FROM users WHERE id=$1",
            [payment.customer_user_id]
          )).rows[0];
          if (customer?.email) {
            await pool.query(
              `INSERT INTO business_payment_authorizations
                 (business_id,user_id,provider,authorization_code,email,status,last_used_at,updated_at)
               VALUES ($1,$2,'paystack',$3,$4,'ACTIVE',now(),now())
               ON CONFLICT (business_id,user_id,provider)
               DO UPDATE SET authorization_code=EXCLUDED.authorization_code,email=EXCLUDED.email,status='ACTIVE',last_used_at=now(),updated_at=now()`,
              [
                payment.business_id,
                payment.customer_user_id,
                authorization.authorization_code.trim(),
                customer.email
              ]
            );
          }
        }
      } else if (["failed", "abandoned", "reversed", "reversal"].includes(providerStatus)) {
        await pool.query(
          "UPDATE buy_order_payments SET status='FAILED',provider_status=$2,updated_at=now() WHERE id=$1 AND status='PENDING'",
          [payment.id, providerStatus]
        );
        await pool.query(
          "UPDATE buy_orders SET payment_status='FAILED',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('HELD','REFUNDED')",
          [payment.buy_order_id]
        );
      } else {
        await pool.query(
          "UPDATE buy_order_payments SET provider_status=$2,updated_at=now() WHERE id=$1 AND status='PENDING'",
          [payment.id, providerStatus || "pending"]
        );
      }
    }
  } finally {
    await pool.query(
      "SELECT pg_advisory_unlock(hashtext('swiftdrop:buy-payment-reconciliation'))"
    );
  }
}
