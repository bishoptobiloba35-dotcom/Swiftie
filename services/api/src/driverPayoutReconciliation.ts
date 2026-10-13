import { pool } from "./database/db.js";
import { processDriverPayoutTransferEvent } from "./driverPayoutWebhook.js";

function watParts(date: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return { date: get("year") + "-" + get("month") + "-" + get("day"), hour: Number(get("hour")) };
}

export async function reconcileDriverTransfersDaily(options: { force?: boolean } = {}): Promise<{
  skipped: boolean; paystackCount: number; localCount: number; mismatches: number;
}> {
  if (!pool) return { skipped: true, paystackCount: 0, localCount: 0, mismatches: 0 };
  const now = new Date();
  const wat = watParts(now);
  if (!options.force && wat.hour < 18) return { skipped: true, paystackCount: 0, localCount: 0, mismatches: 0 };

  const lastRun = (await pool.query(
    "SELECT run_at FROM reconciliation_runs WHERE provider='paystack' ORDER BY run_at DESC LIMIT 1"
  )).rows[0];
  if (!options.force && lastRun && watParts(new Date(lastRun.run_at)).date === wat.date) {
    return { skipped: true, paystackCount: 0, localCount: 0, mismatches: 0 };
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("Paystack transfer reconciliation requires PAYSTACK_SECRET_KEY");
  const from = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const to = now.toISOString();
  const transfers: Array<{ reference?: string; status?: string; amount?: number; currency?: string; transfer_code?: string }> = [];
  let page = 1;
  let pageCount = 1;
  do {
    const url = "https://api.paystack.co/transfer?from=" + encodeURIComponent(from) +
      "&to=" + encodeURIComponent(to) + "&perPage=200&page=" + page;
    const response = await fetch(url, { headers: { authorization: "Bearer " + secret }, signal: AbortSignal.timeout(15_000) });
    const payload = await response.json() as { status?: boolean; message?: string; data?: typeof transfers; meta?: { pageCount?: number } };
    if (!response.ok || !payload.status || !Array.isArray(payload.data)) {
      throw new Error("Paystack transfer list reconciliation failed: " + String(payload.message ?? response.status));
    }
    transfers.push(...payload.data);
    pageCount = Math.max(1, Number(payload.meta?.pageCount ?? 1));
    page += 1;
  } while (page <= pageCount && page <= 50);

  const localRows = (await pool.query(
    "SELECT id,provider_reference,status,amount_minor,net_amount_minor,currency FROM payouts WHERE status IN ('PENDING','PROCESSING') ORDER BY requested_at"
  )).rows;
  const transferByReference = new Map(transfers.filter(t => t.reference).map(t => [String(t.reference), t]));
  const mismatches: Array<Record<string, unknown>> = [];

  for (const transfer of transfers) {
    if (!transfer.reference) continue;
    const local = localRows.find(row => row.provider_reference === transfer.reference);
    if (!local) {
      mismatches.push({ reference: transfer.reference, reason: "provider_transfer_without_local_payout", providerStatus: transfer.status });
      continue;
    }
    const status = String(transfer.status ?? "").toLowerCase();
    if (status === "success" || status === "failed" || status === "reversed") {
      await processDriverPayoutTransferEvent({
        reference: String(transfer.reference),
        eventType: status === "success" ? "transfer.success" : status === "failed" ? "transfer.failed" : "transfer.reversed",
        amountMinor: Number(transfer.amount),
        currency: String(transfer.currency ?? ""),
        failureReason: status === "failed" ? "Paystack reconciliation reported failed transfer" : null
      });
    }
  }

  for (const local of localRows) {
    if (!local.provider_reference || !transferByReference.has(String(local.provider_reference))) {
      mismatches.push({
        payoutId: local.id, reference: local.provider_reference ?? null,
        reason: local.status === "PENDING" ? "pending_payout_without_provider_record" : "processing_payout_without_provider_record"
      });
    }
  }

  await pool.query(
    "INSERT INTO reconciliation_runs(provider,paystack_count,local_count,mismatches_found,mismatches_details) VALUES('paystack',$1,$2,$3,$4::jsonb)",
    [transfers.length, localRows.length, mismatches.length, JSON.stringify(mismatches)]
  );
  if (mismatches.length) {
    await pool.query(
      "INSERT INTO notifications(user_id,title,body,type) SELECT id,'Paystack reconciliation needs review',$1,'PAYOUT_RECONCILIATION' FROM users WHERE role='ADMIN'",
      [mismatches.length + " payout reconciliation mismatch(es) were found. Review the reconciliation run before taking manual action."]
    );
  }
  return { skipped: false, paystackCount: transfers.length, localCount: localRows.length, mismatches: mismatches.length };
}
