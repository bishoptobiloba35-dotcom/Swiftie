import { pool } from "./database/db.js";

export async function reconcileProcessingBuyOrderSettlements(): Promise<void> {
  if (!pool) return;
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return;
  const result = await pool.query(`SELECT id,buy_order_id,transfer_reference,amount_minor,currency
    FROM buy_order_settlements WHERE status='PROCESSING' AND transfer_reference IS NOT NULL AND provider_status IS DISTINCT FROM 'amount_mismatch'
    ORDER BY updated_at ASC LIMIT 25`);
  for (const settlement of result.rows) {
    const reference = String(settlement.transfer_reference);
    try {
      const response = await fetch("https://api.paystack.co/transfer/verify/" + encodeURIComponent(reference), {
        headers: { authorization: "Bearer " + secret }, signal: AbortSignal.timeout(10_000)
      });
      const data = await response.json() as any;
      if (!response.ok || !data.status || !data.data) continue;
      const providerStatus = String(data.data.status ?? "").toLowerCase();
      const providerReference = String(data.data.reference ?? reference);
      const providerAmount = data.data.amount == null ? undefined : Number(data.data.amount);
      const providerCurrency = data.data.currency ? String(data.data.currency) : undefined;
      if (providerStatus === "success") {
        if (providerAmount !== Number(settlement.amount_minor) || providerCurrency !== String(settlement.currency)) {
          await pool.query("UPDATE buy_order_settlements SET provider_status='amount_mismatch',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='PROCESSING'",
            [settlement.id, `Paystack transfer amount/currency mismatch for ${providerReference}`]);
          continue;
        }
        await pool.query("UPDATE buy_order_settlements SET status='PAID',provider_reference=$2,provider_status='success',paid_at=COALESCE(paid_at,now()),failure_reason=NULL,updated_at=now() WHERE id=$1 AND status='PROCESSING'",
          [settlement.id, providerReference]);
        await pool.query("INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,NULL,'AGENT_SETTLEMENT_RECONCILED_PAID',$2::jsonb)",
          [settlement.buy_order_id, JSON.stringify({provider:"paystack",reference:providerReference,source:"reconciliation"})]);
      } else if (providerStatus === "failed" || providerStatus === "reversed") {
        const reason = data.data.failures?.message ?? data.data.failures?.reason ?? data.message ?? "Paystack transfer failed";
        await pool.query("UPDATE buy_order_settlements SET status=$2,provider_reference=$3,provider_status=$4,failure_reason=$5,updated_at=now() WHERE id=$1 AND status='PROCESSING'",
          [settlement.id, providerStatus === "reversed" ? "REVERSED" : "FAILED", providerReference, providerStatus, reason]);
        await pool.query("INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,NULL,'AGENT_SETTLEMENT_RECONCILED_FAILED',$2::jsonb)",
          [settlement.buy_order_id, JSON.stringify({provider:"paystack",reference:providerReference,providerStatus,reason,source:"reconciliation"})]);
      }
    } catch (error) {
      console.error(JSON.stringify({event:"buy_order_settlement_reconciliation_error",settlementId:settlement.id,providerReference:reference,error:error instanceof Error?error.message:"unknown"}));
    }
  }
}
