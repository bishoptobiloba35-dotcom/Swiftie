import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery, createEligiblePayout } from "./database/deliveryRepository.js";

const WEBHOOK_SECRET = "integration-paystack-webhook-secret";
const API_PORT = 4300 + (process.pid % 200);
let server: ChildProcess | null = null;

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/ready`);
      if (response.ok) return;
      lastError = new Error(`ready returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw lastError instanceof Error ? lastError : new Error("API did not become ready");
}

async function postPaystackWebhook(event: Record<string, unknown>, secret = WEBHOOK_SECRET): Promise<Response> {
  const rawBody = JSON.stringify(event);
  const signature = createHmac("sha512", secret).update(rawBody).digest("hex");
  return fetch(`http://127.0.0.1:${API_PORT}/api/paystack/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-paystack-signature": signature },
    body: rawBody
  });
}

async function seedProcessingPayout(reference: string, amountMinor: number) {
  if (!pool) throw new Error("DATABASE_URL is required");
  const stamp = `${Date.now()}-${reference}`;
  const customer = (await pool.query(
    `INSERT INTO users(role,full_name,phone,email) VALUES('CUSTOMER','Webhook Coverage Customer',$1,$2) RETURNING id`,
    [`+234909${String(process.pid).slice(-3)}${Math.floor(Math.random() * 1000)}`, `webhook-${stamp}@example.test`]
  )).rows[0];

  const driverUser = (await pool.query(
    `INSERT INTO users(role,full_name,phone,email) VALUES('DRIVER','Webhook Coverage Driver',$1,$2) RETURNING id`,
    [`+234908${String(process.pid).slice(-3)}${Math.floor(Math.random() * 1000)}`, `webhook-driver-${stamp}@example.test`]
  )).rows[0];

  const driver = (await pool.query(
    `INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',true) RETURNING id`,
    [driverUser.id]
  )).rows[0];

  const delivery = await createPersistentDelivery({
    senderId: customer.id,
    receiverName: "Webhook Receiver",
    receiverPhone: "+2349070000099",
    receiverPin: "454545",
    declaredValueMinor: amountMinor,
    pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
    dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
    weightKg: 1,
    dimensionsCm: { length: 10, width: 10, height: 10 },
    isPerishable: false,
    paymentMode: "SENDER_ESCROW"
  });
  const payout = await createEligiblePayout(delivery.id, driver.id, amountMinor);
  assert.ok(payout);
  await pool.query(
    `UPDATE payouts
        SET status='PROCESSING', provider='paystack', provider_reference=$2, updated_at=now()
      WHERE id=$1`,
    [payout.id, reference]
  );
  return { deliveryId: delivery.id, payoutId: payout.id };
}

function terminateServer(): void {
  if (!server) return;
  server.kill("SIGTERM");
  server = null;
}

test("Paystack payout webhook route reconciles success, failure and reversal with amount/currency verification", async () => {
  if (!pool) return;

  await runMigrations();
  server = spawn(
    process.execPath,
    ["../../node_modules/tsx/dist/cli.mjs", "src/server.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        API_PORT: String(API_PORT),
        PAYSTACK_WEBHOOK_SECRET: WEBHOOK_SECRET
      },
      stdio: "ignore"
    }
  );

  try {
    await waitForReady();

    const success = await seedProcessingPayout("WEBHOOK-SUCCESS-1", 50000);
    const successResponse = await postPaystackWebhook({
      event: "transfer.success",
      data: { reference: "WEBHOOK-SUCCESS-1", amount: 50000, currency: "NGN" }
    });
    assert.equal(successResponse.status, 200);
    const successState = (await pool.query(
      `SELECT status,provider_status,failure_reason FROM payouts WHERE id=$1`,
      [success.payoutId]
    )).rows[0];
    assert.equal(successState.status, "RELEASED");
    assert.equal(successState.provider_status, "transfer.success");
    assert.equal(successState.failure_reason, null);

    const failed = await seedProcessingPayout("WEBHOOK-FAILED-1", 60000);
    const failedResponse = await postPaystackWebhook({
      event: "transfer.failed",
      data: { reference: "WEBHOOK-FAILED-1", amount: 60000, currency: "NGN", failures: { message: "Bank rejected transfer" } }
    });
    assert.equal(failedResponse.status, 200);
    const failedState = (await pool.query(
      `SELECT status,provider_status,failure_reason FROM payouts WHERE id=$1`,
      [failed.payoutId]
    )).rows[0];
    assert.equal(failedState.status, "FAILED");
    assert.equal(failedState.provider_status, "transfer.failed");
    assert.equal(failedState.failure_reason, "Bank rejected transfer");

    const reversed = await seedProcessingPayout("WEBHOOK-REVERSED-1", 70000);
    const reversedResponse = await postPaystackWebhook({
      event: "transfer.reversed",
      data: { reference: "WEBHOOK-REVERSED-1", amount: 70000, currency: "NGN" }
    });
    assert.equal(reversedResponse.status, 200);
    const reversedState = (await pool.query(
      `SELECT status,provider_status FROM payouts WHERE id=$1`,
      [reversed.payoutId]
    )).rows[0];
    assert.equal(reversedState.status, "CANCELLED");
    assert.equal(reversedState.provider_status, "transfer.reversed");

    const mismatch = await seedProcessingPayout("WEBHOOK-MISMATCH-1", 80000);
    const mismatchResponse = await postPaystackWebhook({
      event: "transfer.success",
      data: { reference: "WEBHOOK-MISMATCH-1", amount: 79999, currency: "NGN" }
    });
    assert.equal(mismatchResponse.status, 200);
    const mismatchState = (await pool.query(
      `SELECT status,provider_status,failure_reason FROM payouts WHERE id=$1`,
      [mismatch.payoutId]
    )).rows[0];
    assert.equal(mismatchState.status, "FAILED");
    assert.equal(mismatchState.provider_status, "amount_mismatch");
    assert.equal(mismatchState.failure_reason, "Paystack payout amount/currency mismatch");

    const invalidSignature = await postPaystackWebhook(
      { event: "transfer.success", data: { reference: "WEBHOOK-MISMATCH-1", amount: 80000, currency: "NGN" } },
      "wrong-secret"
    );
    assert.equal(invalidSignature.status, 401);
  } finally {
    terminateServer();
  }
});

after(async () => {
  terminateServer();
  if (pool) await pool.end();
});
