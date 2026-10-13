import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery, createEligiblePayout } from "./database/deliveryRepository.js";
import { reconcileDriverTransfersDaily } from "./driverPayoutReconciliation.js";

test("daily transfer reconciliation updates known transfers and records mismatches", async () => {
  if (!pool) return;
  await runMigrations();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const customer = (await pool.query(
    "INSERT INTO users(role,full_name,phone,email) VALUES('CUSTOMER','Reconciliation Customer','+23490' || $1,$2) RETURNING id",
    [suffix, "reconcile-customer-" + suffix + "@example.test"]
  )).rows[0];
  const driverUser = (await pool.query(
    "INSERT INTO users(role,full_name,phone,email) VALUES('DRIVER','Reconciliation Driver','+23491' || $1,$2) RETURNING id",
    [suffix, "reconcile-driver-" + suffix + "@example.test"]
  )).rows[0];
  const driver = (await pool.query("INSERT INTO drivers(user_id,status) VALUES($1,'APPROVED') RETURNING id", [driverUser.id])).rows[0];
  const delivery = await createPersistentDelivery({
    senderId: customer.id, receiverName: "Receiver", receiverPhone: "+2349070000099",
    receiverPin: "4545", declaredValueMinor: 50000,
    pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.4 } },
    dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
    weightKg: 1, dimensionsCm: { length: 10, width: 10, height: 10 }, isPerishable: false, paymentMode: "SENDER_ESCROW"
  });
  const payout = await createEligiblePayout(delivery.id, driver.id, 50000);
  assert.ok(payout);
  const reference = "RECONCILE-" + suffix;
  await pool.query("UPDATE payouts SET status='PROCESSING',provider='paystack',provider_reference=$2,net_amount_minor=50000 WHERE id=$1", [payout.id, reference]);

  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = "sk_test_reconciliation";
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.match(url, /^https:\/\/api\.paystack\.co\/transfer\?/);
      return new Response(JSON.stringify({
        status: true,
        data: [
          { reference, status: "success", amount: 50000, currency: "NGN" },
          { reference: "PROVIDER-ONLY-" + suffix, status: "success", amount: 10000, currency: "NGN" }
        ],
        meta: { pageCount: 1 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await reconcileDriverTransfersDaily({ force: true });
    assert.equal(result.skipped, false);
    assert.equal(result.paystackCount, 2);
    assert.ok(result.mismatches >= 1);
    const state = (await pool.query("SELECT status,provider_status FROM payouts WHERE id=$1", [payout.id])).rows[0];
    assert.equal(state.status, "RELEASED");
    assert.equal(state.provider_status, "success");
    const run = (await pool.query("SELECT paystack_count,mismatches_found FROM reconciliation_runs ORDER BY run_at DESC LIMIT 1")).rows[0];
    assert.equal(Number(run.paystack_count), 2);
    assert.ok(Number(run.mismatches_found) >= 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  }
});
