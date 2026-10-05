import { pool } from "./database/db.js";

export async function reconcileProcessingDropOffCommissions(): Promise<void> {
  if (!pool) return;
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return;

  const result = await pool.query(`SELECT id,parcel_id,amount_minor,currency,provider_reference
    FROM drop_off_commission_ledger
    WHERE status='PROCESSING' AND provider_reference IS NOT NULL AND provider_status IS DISTINCT FROM 'amount_mismatch'
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

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = (await client.query(
          "SELECT id,parcel_id,amount_minor,currency,status FROM drop_off_commission_ledger WHERE id=$1 FOR UPDATE",
          [commission.id]
        )).rows[0];
        if (!current || current.status !== "PROCESSING") {
          await client.query("ROLLBACK");
          continue;
        }

        if (providerStatus === "success") {
          if (providerAmount !== Number(current.amount_minor) || providerCurrency !== String(current.currency)) {
            const updated = await client.query(
              "UPDATE drop_off_commission_ledger SET status='PROCESSING',provider_reference=$2,provider_status='amount_mismatch',updated_at=now() WHERE id=$1 AND status='PROCESSING' RETURNING id",
              [current.id, providerReference]
            );
            if (updated.rows[0] && current.parcel_id) {
              await client.query(
                "INSERT INTO drop_off_events(parcel_id,event_type,metadata) VALUES($1,'COMMISSION_PAYOUT_RECONCILIATION_MISMATCH',$2::jsonb)",
                [current.parcel_id, JSON.stringify({ commissionId: current.id, providerReference, providerAmount, expectedAmount: Number(current.amount_minor), providerCurrency, expectedCurrency: String(current.currency) })]
              );
            }
            await client.query("COMMIT");
            continue;
          }
          const updated = await client.query(
            "UPDATE drop_off_commission_ledger SET status='PAID',provider_reference=$2,provider_status='success',paid_at=COALESCE(paid_at,now()),updated_at=now() WHERE id=$1 AND status='PROCESSING' RETURNING id",
            [current.id, providerReference]
          );
          if (updated.rows[0] && current.parcel_id) {
            await client.query(
              "INSERT INTO drop_off_events(parcel_id,event_type,metadata) VALUES($1,'COMMISSION_PAYOUT_RECONCILED_PAID',$2::jsonb)",
              [current.parcel_id, JSON.stringify({ commissionId: current.id, providerReference, amountMinor: Number(current.amount_minor), currency: String(current.currency) })]
            );
          }
          await client.query("COMMIT");
        } else if (providerStatus === "failed" || providerStatus === "reversed") {
          const reason = data.data.failures?.message ?? data.data.failures?.reason ?? data.message ?? "Paystack transfer failed";
          const failure = providerStatus + ":" + String(reason).slice(0, 400);
          const updated = await client.query(
            "UPDATE drop_off_commission_ledger SET status='AVAILABLE',provider_reference=$2,provider_status=$3,updated_at=now() WHERE id=$1 AND status='PROCESSING' RETURNING id",
            [current.id, providerReference, failure]
          );
          if (updated.rows[0] && current.parcel_id) {
            await client.query(
              "INSERT INTO drop_off_events(parcel_id,event_type,metadata) VALUES($1,'COMMISSION_PAYOUT_RECONCILED_FAILED',$2::jsonb)",
              [current.parcel_id, JSON.stringify({ commissionId: current.id, providerReference, providerStatus, reason: String(reason).slice(0, 400) })]
            );
          }
          await client.query("COMMIT");
        } else {
          await client.query("ROLLBACK");
        }
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      } finally {
        client.release();
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
