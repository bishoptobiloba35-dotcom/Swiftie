import { pool } from "./database/db.js";

export async function ensureRecipient(driverId: string): Promise<string> {
  if (!pool) throw new Error("Payouts require the production database");
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("Paystack transfers are not configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query(
      "SELECT payout_bank_code,payout_bank_name,payout_account_number,payout_account_name,payout_recipient_code,recipient_verified FROM drivers WHERE id=$1 FOR UPDATE",
      [driverId]
    )).rows[0];
    if (!row) throw new Error("Driver profile not found");
    if (!row.recipient_verified) throw new Error("Payout bank account is not verified");
    if (row.payout_recipient_code) {
      await client.query("COMMIT");
      return String(row.payout_recipient_code);
    }
    if (!row.payout_bank_code || !row.payout_account_number || !row.payout_account_name) {
      throw new Error("Verified payout bank details are incomplete");
    }
    const response = await fetch("https://api.paystack.co/transferrecipient", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: JSON.stringify({
        type: "nuban", name: row.payout_account_name,
        account_number: row.payout_account_number, bank_code: row.payout_bank_code, currency: "NGN"
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await response.json() as { status?: boolean; message?: string; data?: { recipient_code?: string } };
    if (!response.ok || !payload.status || !payload.data?.recipient_code) {
      throw new Error(payload.message ?? "Unable to create payout recipient");
    }
    await client.query(
      "UPDATE drivers SET payout_recipient_code=$2 WHERE id=$1 AND recipient_verified=true",
      [driverId, payload.data.recipient_code]
    );
    await client.query("COMMIT");
    return payload.data.recipient_code;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
