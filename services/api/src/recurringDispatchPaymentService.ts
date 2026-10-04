import type { PoolClient } from "pg";
import { pool } from "./database/db.js";

export type RecurringPaymentResult =
  | { status: "HELD"; orderId: string; reference?: string }
  | { status: "WAITING"; orderId: string; reason: string; authorizationUrl?: string | null; accessCode?: string | null }
  | { status: "FAILED"; orderId: string; reason: string }
  | { status: "MISSING_AUTHORIZATION"; orderId: string };

export function recurringPaymentReference(planId: string, orderId: string, attempt = 1): string {
  const base = `sd-recurring-${planId.replaceAll("-", "")}-${orderId.replaceAll("-", "")}`;
  return attempt <= 1 ? base : `${base}-r${attempt}`;
}

function nextAttempt(reference: string, planId: string, orderId: string): number {
  const base = `sd-recurring-${planId.replaceAll("-", "")}-${orderId.replaceAll("-", "")}`;
  if (reference === base) return 2;
  const match = reference.match(/-r(\d+)$/);
  return match ? Number(match[1]) + 1 : 2;
}

function terminalProviderStatus(status: string): boolean {
  return ["failed", "abandoned", "reversed", "reversal"].includes(status);
}

export type RecurringChargeDecision =
  | { kind: "SUCCESS"; providerReference: string }
  | { kind: "CHALLENGE"; authorizationUrl: string | null; accessCode: string | null }
  | { kind: "TERMINAL_FAILURE"; providerStatus: string }
  | { kind: "WAITING"; providerStatus: string };

export function evaluateRecurringChargeResponse(responseOk: boolean, payload: any, fallbackReference: string, expectedAmountMinor: number, expectedCurrency: string): RecurringChargeDecision {
  const providerStatus = String(payload?.data?.status ?? "").toLowerCase();
  const challenged = Boolean(payload?.data?.paused) || Boolean(payload?.data?.authorization_url);
  if (challenged) {
    return {
      kind: "CHALLENGE",
      authorizationUrl: typeof payload?.data?.authorization_url === "string" ? payload.data.authorization_url : null,
      accessCode: typeof payload?.data?.access_code === "string" ? payload.data.access_code : null
    };
  }
  const successful = responseOk && payload?.status === true && providerStatus === "success";
  if (successful) {
    const providerAmount = Number(payload?.data?.amount);
    const providerCurrency = String(payload?.data?.currency ?? "").trim().toUpperCase();
    const currency = expectedCurrency.trim().toUpperCase();
    if (Number.isSafeInteger(providerAmount) && providerAmount === expectedAmountMinor && providerCurrency === currency) {
      return { kind: "SUCCESS", providerReference: String(payload?.data?.reference ?? fallbackReference) };
    }
    return { kind: "TERMINAL_FAILURE", providerStatus: "amount_mismatch" };
  }
  if (terminalProviderStatus(providerStatus)) {
    return { kind: "TERMINAL_FAILURE", providerStatus: providerStatus || "provider_rejected" };
  }
  return { kind: "WAITING", providerStatus: providerStatus || "pending" };
}

async function verify(reference: string, secret: string): Promise<any | null> {
  const response = await fetch(
    "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
    { headers: { authorization: "Bearer " + secret }, signal: AbortSignal.timeout(15_000) }
  ).catch(() => null);
  if (!response) return null;
  return await response.json().catch(() => null) as any;
}

async function ensureBusinessSpendReservation(orderId: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO business_spend_ledger
      (business_id, user_id, reference_type, reference_id, amount_minor, currency)
     SELECT bo.business_id, bo.customer_user_id, 'BUY_ORDER_RESERVATION', bo.id,
            bo.purchase_budget_minor, bo.currency
       FROM buy_orders bo
      WHERE bo.id=$1
        AND bo.business_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM business_spend_ledger r
           WHERE r.business_id=bo.business_id
             AND r.reference_id=bo.id
             AND r.reference_type='BUY_ORDER_RESERVATION'
        )
        AND (
          SELECT COALESCE(SUM(
            CASE WHEN ledger.reference_type='BUY_ORDER_RESERVATION' THEN ledger.amount_minor
                 WHEN ledger.reference_type='BUY_ORDER_RESERVATION_RELEASE' THEN ledger.amount_minor
                 ELSE 0 END
          ),0)
            FROM business_spend_ledger ledger
           WHERE ledger.business_id=bo.business_id
             AND ledger.reference_id=bo.id
             AND ledger.reference_type IN ('BUY_ORDER_RESERVATION','BUY_ORDER_RESERVATION_RELEASE')
        ) <= 0`,
    [orderId]
  );
}

async function releaseBusinessSpendReservation(orderId: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO business_spend_ledger
      (business_id, user_id, reference_type, reference_id, amount_minor, currency)
     SELECT bo.business_id, bo.customer_user_id, 'BUY_ORDER_RESERVATION_RELEASE', bo.id,
            -r.amount_minor, r.currency
       FROM buy_orders bo
       JOIN LATERAL (
         SELECT amount_minor, currency
           FROM business_spend_ledger
          WHERE business_id=bo.business_id
            AND reference_id=bo.id
            AND reference_type='BUY_ORDER_RESERVATION'
          ORDER BY created_at ASC
          LIMIT 1
       ) r ON true
      WHERE bo.id=$1
        AND bo.business_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM business_spend_ledger release
           WHERE release.business_id=bo.business_id
             AND release.reference_id=bo.id
             AND release.reference_type='BUY_ORDER_RESERVATION_RELEASE'
        )`,
    [orderId]
  );
}

async function reconcileVerifiedPayment(
  orderId: string,
  paymentId: string,
  reference: string,
  amountMinor: number,
  currency: string,
  payload: any,
  authorizationId: string,
  actorUserId: string
): Promise<RecurringPaymentResult | null> {
  if (!pool) return { status: "FAILED", orderId, reason: "DATABASE_NOT_CONFIGURED" };
  const providerStatus = String(payload?.data?.status ?? "").toLowerCase();
  const providerAmount = Number(payload?.data?.amount);
  const providerCurrency = String(payload?.data?.currency ?? "").trim().toUpperCase();
  const expectedCurrency = currency.trim().toUpperCase();
  const amountMatches = Number.isSafeInteger(providerAmount) &&
    providerAmount === amountMinor &&
    providerCurrency === expectedCurrency;

  if (providerStatus === "success") {
    if (!amountMatches) {
      await pool.query(
        "UPDATE buy_order_payments SET status='FAILED',provider_status='amount_mismatch_reconciliation',updated_at=now() WHERE id=$1 AND status='PENDING'",
        [paymentId]
      );
      await pool.query(
        "UPDATE buy_orders SET payment_status='FAILED',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('HELD','AUTHORIZED','REFUNDED')",
        [orderId]
      );
      await releaseBusinessSpendReservation(orderId);
      return { status: "FAILED", orderId, reason: "PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH" };
    }
    const claimed = await pool.query(
      "UPDATE buy_order_payments SET status='HELD',provider_reference=$2,provider_status='success_reconciled',updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING id",
      [paymentId, reference]
    );
    if (!claimed.rows[0]) {
      const current = (await pool.query("SELECT status FROM buy_order_payments WHERE id=$1", [paymentId])).rows[0];
      if (["HELD","AUTHORIZED"].includes(String(current?.status))) return { status: "HELD", orderId, reference };
      return null;
    }
    await pool.query(
      "UPDATE buy_orders SET payment_reference=$2,payment_status='HELD',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('REFUNDED')",
      [orderId, reference]
    );
    await pool.query(
      "UPDATE business_payment_authorizations SET last_used_at=now(),updated_at=now() WHERE id=$1 AND status='ACTIVE'",
      [authorizationId]
    );
    await pool.query(
      "INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,'PAYMENT_HELD_RECONCILED',$3::jsonb)",
      [orderId, actorUserId, JSON.stringify({ provider: "paystack", reference, source: "AUTONOMOUS_RECURRING_DISPATCH_RECONCILIATION" })]
    );
    return { status: "HELD", orderId, reference };
  }

  if (terminalProviderStatus(providerStatus)) {
    await pool.query(
      "UPDATE buy_order_payments SET status='FAILED',provider_status=$2,updated_at=now() WHERE id=$1 AND status='PENDING'",
      [paymentId, providerStatus]
    );
    await pool.query(
      "UPDATE buy_orders SET payment_status='FAILED',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('HELD','AUTHORIZED','REFUNDED')",
      [orderId]
    );
    await releaseBusinessSpendReservation(orderId);
    return { status: "FAILED", orderId, reason: `PAYMENT_PROVIDER_TERMINAL:${providerStatus || "unknown"}` };
  }

  await pool.query(
    "UPDATE buy_order_payments SET provider_status=$2,updated_at=now() WHERE id=$1 AND status='PENDING'",
    [paymentId, providerStatus || "pending"]
  );
  return { status: "WAITING", orderId, reason: providerStatus || "PAYMENT_PENDING" };
}

export async function authorizeRecurringBuyOrder(input: {
  planId: string;
  businessId: string;
  orderId: string;
}): Promise<RecurringPaymentResult> {
  if (!pool) return { status: "FAILED", orderId: input.orderId, reason: "DATABASE_NOT_CONFIGURED" };
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return { status: "FAILED", orderId: input.orderId, reason: "PAYSTACK_NOT_CONFIGURED" };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`swiftdrop:recurring-buy-payment:${input.orderId}`]);

      const row = (await client.query(
        `SELECT bo.id,bo.business_id,bo.customer_user_id,bo.purchase_budget_minor,bo.currency,bo.status,
                u.email,
                bop.id AS payment_id,bop.provider_reference,bop.status AS payment_status
           FROM buy_orders bo
           JOIN users u ON u.id=bo.customer_user_id
           LEFT JOIN buy_order_payments bop ON bop.buy_order_id=bo.id
          WHERE bo.id=$1 AND bo.business_id=$2
          FOR UPDATE OF bo`,
        [input.orderId, input.businessId]
      )).rows[0];

      if (!row) {
        await client.query("ROLLBACK");
        return { status: "FAILED", orderId: input.orderId, reason: "BUY_ORDER_NOT_FOUND" };
      }
      if (["CANCELLED","DELIVERED","DISPUTED"].includes(String(row.status))) {
        await client.query("ROLLBACK");
        return { status: "FAILED", orderId: input.orderId, reason: "BUY_ORDER_NOT_CHARGEABLE" };
      }

      const authorization = (await client.query(
        `SELECT id,authorization_code,email,status
           FROM business_payment_authorizations
          WHERE business_id=$1 AND user_id=$2 AND provider='paystack' AND status='ACTIVE'
          ORDER BY updated_at DESC
          LIMIT 1
          FOR UPDATE`,
        [input.businessId, row.customer_user_id]
      )).rows[0];

      if (!authorization?.authorization_code || !authorization.email) {
        await client.query("ROLLBACK");
        return { status: "MISSING_AUTHORIZATION", orderId: input.orderId };
      }

      if (["HELD","AUTHORIZED"].includes(String(row.payment_status))) {
        await client.query("COMMIT");
        return { status: "HELD", orderId: input.orderId, reference: row.provider_reference ?? undefined };
      }

      const amountMinor = Number(row.purchase_budget_minor);
      const currency = String(row.currency ?? "NGN").trim();
      let reference = String(row.provider_reference ?? "");
      if (!reference || reference.startsWith("sd_recurring_")) {
        reference = recurringPaymentReference(input.planId, input.orderId, 1);
      } else if (row.payment_status === "FAILED") {
        reference = recurringPaymentReference(input.planId, input.orderId, nextAttempt(reference, input.planId, input.orderId));
      } else if (!reference.startsWith("sd-recurring-")) {
        reference = recurringPaymentReference(input.planId, input.orderId, 1);
      }

      if (row.payment_status === "PENDING") {
        if (!row.provider_reference || !row.payment_id) {
          if (row.payment_id) {
            await client.query(
              "UPDATE buy_order_payments SET provider_status='reconciliation_required',updated_at=now() WHERE id=$1 AND status='PENDING'",
              [row.payment_id]
            );
          }
          await client.query("COMMIT");
          return { status: "WAITING", orderId: input.orderId, reason: "PENDING_PAYMENT_RECORD_INVALID_REQUIRES_RECONCILIATION" };
        }
        await client.query("COMMIT");
        const verified = await verify(String(row.provider_reference), secret);
        if (!verified) return { status: "WAITING", orderId: input.orderId, reason: "PAYMENT_VERIFICATION_UNAVAILABLE" };
        const reconciled = await reconcileVerifiedPayment(
          input.orderId,
          String(row.payment_id),
          String(row.provider_reference),
          amountMinor,
          currency,
          verified,
          String(authorization.id),
          String(row.customer_user_id)
        );
        if (reconciled) return reconciled;
        attempt = Math.max(attempt, nextAttempt(String(row.provider_reference), input.planId, input.orderId) - 1);
        continue;
      }

      await ensureBusinessSpendReservation(input.orderId);

      const payment = await client.query(
        `INSERT INTO buy_order_payments
          (buy_order_id,provider,provider_reference,amount_minor,currency,status)
         VALUES ($1,'paystack',$2,$3,$4,'PENDING')
         ON CONFLICT (buy_order_id)
         DO UPDATE SET provider='paystack',provider_reference=EXCLUDED.provider_reference,
                       amount_minor=EXCLUDED.amount_minor,currency=EXCLUDED.currency,
                       status='PENDING',authorization_url=NULL,access_code=NULL,
                       provider_status=NULL,updated_at=now()
         RETURNING id`,
        [input.orderId, reference, amountMinor, currency]
      );
      await client.query(
        "UPDATE buy_orders SET payment_status='PENDING',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('HELD','AUTHORIZED','REFUNDED')",
        [input.orderId]
      );
      await client.query("COMMIT");

      const response = await fetch("https://api.paystack.co/transaction/charge_authorization", {
        method: "POST",
        headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
        body: JSON.stringify({
          email: authorization.email,
          amount: String(amountMinor),
          authorization_code: authorization.authorization_code,
          reference,
          currency,
          metadata: { businessId: input.businessId, dispatchPlanId: input.planId, buyOrderId: input.orderId },
          queue: true
        }),
        signal: AbortSignal.timeout(20_000)
      }).catch(() => null);

      if (!response) {
        return { status: "WAITING", orderId: input.orderId, reason: "PAYMENT_PROVIDER_UNAVAILABLE" };
      }

      const payload = await response.json().catch(() => null) as any;
      const providerStatus = String(payload?.data?.status ?? "").toLowerCase();
      const successful = response.ok && payload?.status === true && providerStatus === "success";
      const challenged = Boolean(payload?.data?.paused) || Boolean(payload?.data?.authorization_url);
      const authorizationUrl = typeof payload?.data?.authorization_url === "string" ? payload.data.authorization_url : null;
      const accessCode = typeof payload?.data?.access_code === "string" ? payload.data.access_code : null;

      if (challenged) {
        await pool.query(
          "UPDATE buy_order_payments SET status='PENDING',provider_reference=$2,provider_status='authorization_required',authorization_url=$3,access_code=$4,updated_at=now() WHERE id=$1",
          [payment.rows[0].id, String(payload?.data?.reference ?? reference), authorizationUrl, accessCode]
        );
        return { status: "WAITING", orderId: input.orderId, reason: "PAYMENT_AUTHORIZATION_REQUIRED", authorizationUrl, accessCode };
      }

      if (successful) {
        const providerAmount = Number(payload?.data?.amount);
        const providerCurrency = String(payload?.data?.currency ?? "").trim().toUpperCase();
        if (!Number.isSafeInteger(providerAmount) || providerAmount !== amountMinor || providerCurrency !== currency.toUpperCase()) {
          await pool.query(
            "UPDATE buy_order_payments SET status='FAILED',provider_status='amount_mismatch',updated_at=now() WHERE id=$1 AND status='PENDING'",
            [payment.rows[0].id]
          );
          await releaseBusinessSpendReservation(input.orderId);
          return { status: "FAILED", orderId: input.orderId, reason: "PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH" };
        }
        await pool.query(
          "UPDATE buy_order_payments SET status='HELD',provider_reference=$2,provider_status='success',updated_at=now() WHERE id=$1 AND status='PENDING'",
          [payment.rows[0].id, String(payload?.data?.reference ?? reference)]
        );
        await pool.query(
          "UPDATE buy_orders SET payment_reference=$2,payment_status='HELD',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('REFUNDED')",
          [input.orderId, String(payload?.data?.reference ?? reference)]
        );
        await pool.query(
          "UPDATE business_payment_authorizations SET last_used_at=now(),updated_at=now() WHERE id=$1 AND status='ACTIVE'",
          [authorization.id]
        );
        await pool.query(
          "INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,'PAYMENT_HELD',$3::jsonb)",
          [input.orderId, row.customer_user_id, JSON.stringify({ provider: "paystack", reference: String(payload?.data?.reference ?? reference), source: "AUTONOMOUS_RECURRING_DISPATCH", dispatchPlanId: input.planId })]
        );
        return { status: "HELD", orderId: input.orderId, reference: String(payload?.data?.reference ?? reference) };
      }

      const invalidAuthorization = ["invalid_authorization","authorization_invalid","expired_authorization"].includes(providerStatus);
      if (invalidAuthorization) {
        await pool.query(
          "UPDATE business_payment_authorizations SET status='REVOKED',updated_at=now() WHERE id=$1 AND status='ACTIVE'",
          [authorization.id]
        );
      }
      await pool.query(
        "UPDATE buy_order_payments SET status='FAILED',provider_status=$2,updated_at=now() WHERE id=$1 AND status='PENDING'",
        [payment.rows[0].id, providerStatus || "provider_rejected"]
      );
      await pool.query(
        "UPDATE buy_orders SET payment_status='FAILED',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('HELD','AUTHORIZED','REFUNDED')",
        [input.orderId]
      );
      await releaseBusinessSpendReservation(input.orderId);
      return { status: "FAILED", orderId: input.orderId, reason: providerStatus || "PAYMENT_FAILED" };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return { status: "FAILED", orderId: input.orderId, reason: error instanceof Error ? error.message : "RECURRING_PAYMENT_ERROR" };
    } finally {
      client.release();
    }
  }

  return { status: "FAILED", orderId: input.orderId, reason: "RECURRING_PAYMENT_RETRY_EXHAUSTED" };
}
