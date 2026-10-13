import { pool } from "./database/db.js";

export async function processDriverPayoutTransferEvent(input: {
  reference: string;
  eventType: "transfer.success" | "transfer.failed" | "transfer.reversed";
  amountMinor: number;
  currency: string;
  failureReason?: string | null;
}): Promise<boolean> {
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payout = (await client.query(
      "SELECT p.*, d.user_id AS driver_user_id FROM payouts p JOIN drivers d ON d.id=p.driver_id WHERE p.provider_reference=$1 FOR UPDATE OF p",
      [input.reference]
    )).rows[0];
    if (!payout) {
      await client.query("COMMIT");
      return false;
    }

    const expected = Number(payout.net_amount_minor ?? payout.amount_minor);
    const amountMatches = Number.isSafeInteger(input.amountMinor) && input.amountMinor === expected;
    const currencyMatches = input.currency.trim() === String(payout.currency ?? "NGN").trim();
    const mismatch = !amountMatches || !currencyMatches;
    const status = mismatch && input.eventType === "transfer.success" ? "FAILED"
      : input.eventType === "transfer.success" ? "RELEASED"
      : input.eventType === "transfer.failed" ? "FAILED" : "REVERSED";
    const providerStatus = mismatch ? "amount_mismatch"
      : input.eventType === "transfer.success" ? "success"
      : input.eventType === "transfer.failed" ? "failed" : "reversed";
    const failure = mismatch ? "Paystack transfer amount or currency mismatch"
      : input.eventType === "transfer.failed" ? "Paystack transfer failed; support will review." : null;

    // Repeated success/reversal callbacks are idempotent; a reversal after success
    // is intentionally processed because it is a new financial state.
    if (!(payout.status === "RELEASED" && input.eventType === "transfer.success") &&
        !(payout.status === "REVERSED" && input.eventType === "transfer.reversed")) {
      await client.query(
        "UPDATE payouts SET status=$2,provider='paystack',provider_status=$3,failure_reason=$4," +
        "completed_at=CASE WHEN $2='RELEASED' THEN COALESCE(completed_at,now()) ELSE completed_at END," +
        "processed_at=CASE WHEN $2 IN ('RELEASED','FAILED','REVERSED') THEN COALESCE(processed_at,now()) ELSE processed_at END," +
        "updated_at=now() WHERE id=$1",
        [payout.id, status, providerStatus, failure]
      );

      if (input.eventType === "transfer.reversed" && !mismatch) {
        const wallet = (await client.query(
          "SELECT id,balance_minor FROM stakeholder_wallets WHERE user_id=$1 AND stakeholder_type='COURIER' FOR UPDATE",
          [payout.driver_user_id]
        )).rows[0];
        if (wallet && Number(wallet.balance_minor) >= expected) {
          // The idempotency key protects against duplicate debit if webhook processing retries.
          const key = "driver-transfer-reversal:" + payout.id;
          const existing = await client.query("SELECT id FROM wallet_transactions WHERE idempotency_key=$1", [key]);
          if (!existing.rowCount) {
            const nextBalance = Number(wallet.balance_minor) - expected;
            await client.query("UPDATE stakeholder_wallets SET balance_minor=$2,updated_at=now() WHERE id=$1", [wallet.id, nextBalance]);
            await client.query(
              "INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,provider_reference,idempotency_key,metadata) " +
              "VALUES($1,$2,'DRIVER_PAYOUT_REVERSAL','DEBIT',$3,$4,$5,$6,$7::jsonb)",
              [wallet.id, payout.delivery_id, expected, nextBalance, input.reference, key,
                JSON.stringify({ provider: "paystack", payoutId: payout.id, reason: "transfer.reversed" })]
            );
          }
        } else {
          await client.query(
            "INSERT INTO notifications(user_id,title,body,type) SELECT id,'Reversed driver payout needs review',$1,'PAYOUT_REVERSED' FROM users WHERE role='ADMIN'",
            [wallet
              ? "A reversed driver payout could not be clawed back because the courier wallet balance is insufficient. Payout " + payout.id + " requires manual recovery."
              : "A reversed driver payout has no courier wallet to claw back. Payout " + payout.id + " requires manual recovery."]
          );
        }
      } else if (input.eventType === "transfer.failed" || mismatch) {
        await client.query(
          "INSERT INTO notifications(user_id,title,body,type) SELECT id,'Driver payout needs review',$1,'PAYOUT_FAILED' FROM users WHERE role='ADMIN'",
          ["Driver payout " + payout.id + " reported " + providerStatus + ". Review the transfer in Paystack; automatic retries are disabled."]
        );
      }

      await client.query(
        "INSERT INTO delivery_events(delivery_id,event_type,metadata) VALUES($1,$2,$3::jsonb)",
        [payout.delivery_id, "PAYOUT_" + status, JSON.stringify({
          provider: "paystack", reference: input.reference, providerStatus,
          amountMinor: input.amountMinor, currency: input.currency
        })]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
