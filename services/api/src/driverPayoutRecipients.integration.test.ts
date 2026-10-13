import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { ensureRecipient } from "./driverPayoutRecipients.js";

test("ensureRecipient rejects unverified drivers and reuses a stored recipient", async () => {
  if (!pool) return;
  await runMigrations();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const user = (await pool.query(
    "INSERT INTO users(role,full_name,phone,email) VALUES('DRIVER','Test Driver Recipient','+23480' || $1,$2) RETURNING id",
    [suffix, "recipient-" + suffix + "@example.test"]
  )).rows[0];
  const driver = (await pool.query(
    "INSERT INTO drivers(user_id,status,payout_bank_code,payout_bank_name,payout_account_number,payout_account_name,recipient_verified) VALUES($1,'APPROVED','058','Test Bank','1234567890','Test Driver',false) RETURNING id",
    [user.id]
  )).rows[0];
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "sk_test_recipient_unit";
  let calls = 0;
  try {
    await assert.rejects(() => ensureRecipient(driver.id), /not verified/);
    await pool.query("UPDATE drivers SET recipient_verified=true,recipient_verified_at=now() WHERE id=$1", [driver.id]);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      assert.equal(String(input), "https://api.paystack.co/transferrecipient");
      return new Response(JSON.stringify({ status: true, data: { recipient_code: "RCP_test_once" } }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    assert.equal(await ensureRecipient(driver.id), "RCP_test_once");
    assert.equal(await ensureRecipient(driver.id), "RCP_test_once");
    assert.equal(calls, 1);
    const saved = (await pool.query("SELECT payout_recipient_code FROM drivers WHERE id=$1", [driver.id])).rows[0];
    assert.equal(saved.payout_recipient_code, "RCP_test_once");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
    await pool.query("DELETE FROM drivers WHERE id=$1", [driver.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [user.id]);
  }
});
