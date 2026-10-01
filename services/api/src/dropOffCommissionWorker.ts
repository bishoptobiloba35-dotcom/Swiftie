import { pool } from "./database/db.js";

export async function reconcileProcessingDropOffCommissions(): Promise<void> {
  if (!pool) return;
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return;

  const result = await pool.query(`SELECT id,parcel_id,amount_minor,currency,provider_reference
    FROM drop_off_commission_ledger
    WHERE status='PROCESSING' AND provider_reference IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT 25`);

  for (const commission of result.rows) {
    const reference = String(commission.provider_reference);
    try {
      const response = await fetch(
        "https://api.paystack.co/transfer/verify/" + encodeURIComponent(reference),
        { headers: { authorization: "Bearer " + secret }, signal: AbortSignal.timeout(10_000) }
      );
      const data = await response.json() as any;
      if (!response.ok || !data.status || !data.data) continue;

      const providerStatus = String(data.data.status ?? "").toLowerCase();
      const providerReference = String(data.data.reference ?? reference);
      const providerAmount = data.data.amount == null ? undefined : Number(data.data.amount);
      const providerCurrency = String(data.data.currency ?? "");

      if (providerStatus === "success") {
        if (providerAmount !== Number(commission.amount_minor) || providerCurrency !== String(commission.currency)) {
          await pool.query(
            "UPDATE drop_off_commission_ledger SET status='AVAILABLE',provider_status='amount_mismatch',updated_at=now() WHERE id=$1 AND status='PROCESSING'",
            [commission.id]
          );
          await pool.query(
            "INSERT INTO drop_off_events(parcel_id,actor_user_id,event_type,metadata) VALUES($1,NULL,'COMMISSION_RECONCILIATION_MISMATCH',$2::jsonb)",
            [commission.parcel_id, JSON.stringify({commissionId:commission.id,provider:"paystack",reference:providerReference,providerAmount,providerCurrency})]
          );
          continue;
        }
        await pool.query(
          "UPDATE drop_off_commission_ledger SET status='PAID',provider_reference=$2,provider_status='success',paid_at=COALESCE(paid_at,now()),updated_at=now() WHERE id=$1 AND status='PROCESSING'",
          [commission.id, providerReference]
        );
        await pool.query(
          "INSERT INTO drop_off_events(parcel_id,actor_user_id,event_type,metadata) VALUES($1,NULL,'COMMISSION_RECONCILED_PAID',$2::jsonb)",
          [commission.parcel_id, JSON.stringify({commissionId:commission.id,provider:"paystack",reference:providerReference,source:"reconciliation"})]
        );
      } else if (providerStatus === "failed" || providerStatus === "reversed") {
        const reason = data.data.failures?.message ?? data.data.failures?.reason ?? data.message ?? "Paystack transfer failed";
        await pool.query(
          "UPDATE drop_off_commission_ledger SET status='AVAILABLE',provider_reference=$2,provider_status=$3,updated_at=now() WHERE id=$1 AND status='PROCESSING'",
          [commission.id, providerReference, providerStatus + ":" + String(reason).slice(0, 400)]
        );
        await pool.query(
          "INSERT INTO drop_off_events(parcel_id,actor_user_id,event_type,metadata) VALUES($1,NULL,'COMMISSION_RECONCILED_FAILED',$2::jsonb)",
          [commission.parcel_id, JSON.stringify({commissionId:commission.id,provider:"paystack",reference:providerReference,providerStatus,reason:String(reason).slice(0,400),source:"reconciliation"})]
        );
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "drop_off_commission_reconciliation_error",
        commissionId: commission.id,
        providerReference: reference,
        error: error instanceof Error ? error.message : "unknown"
      }));
    }
  }
}
