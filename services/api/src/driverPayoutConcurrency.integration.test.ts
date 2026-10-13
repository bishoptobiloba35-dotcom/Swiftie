import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery, createEligiblePayout, findActiveDriverPayout } from "./database/deliveryRepository.js";

test("driver cannot begin a second payout while another payout is processing", async () => {
  if (!pool) return;
  await runMigrations();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const customer = (await pool.query(
    "INSERT INTO users(role,full_name,phone,email) VALUES('CUSTOMER','Payout Concurrency Customer','+23490' || $1,$2) RETURNING id",
    [suffix, "payout-concurrency-customer-" + suffix + "@example.test"]
  )).rows[0];
  const driverUser = (await pool.query(
    "INSERT INTO users(role,full_name,phone,email) VALUES('DRIVER','Payout Concurrency Driver','+23491' || $1,$2) RETURNING id",
    [suffix, "payout-concurrency-driver-" + suffix + "@example.test"]
  )).rows[0];
  const driver = (await pool.query(
    "INSERT INTO drivers(user_id,status) VALUES($1,'APPROVED') RETURNING id", [driverUser.id]
  )).rows[0];
  const createDelivery = () => createPersistentDelivery({
    senderId: customer.id, receiverName: "Receiver", receiverPhone: "+2349070000099",
    receiverPin: "4545", declaredValueMinor: 50000,
    pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.4 } },
    dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
    weightKg: 1, dimensionsCm: { length: 10, width: 10, height: 10 }, isPerishable: false, paymentMode: "SENDER_ESCROW"
  });
  let deliveryA: { id: string } | null = null;
  let deliveryB: { id: string } | null = null;
  try {
    deliveryA = await createDelivery();
    deliveryB = await createDelivery();
    const payoutA = await createEligiblePayout(deliveryA.id, driver.id, 50000);
    const payoutB = await createEligiblePayout(deliveryB.id, driver.id, 60000);
    assert.ok(payoutA);
    assert.ok(payoutB);
    await pool.query("UPDATE payouts SET status='PROCESSING',provider_reference=$2 WHERE id=$1", [payoutA.id, "payout-concurrency-" + suffix]);
    const active = await findActiveDriverPayout(driver.id, payoutB.id);
    assert.equal(active?.id, payoutA.id);
    assert.equal(active?.deliveryId, deliveryA.id);
    assert.equal(await findActiveDriverPayout(driver.id, payoutA.id), null);
  } finally {
    if (deliveryA) await pool.query("DELETE FROM deliveries WHERE id=$1", [deliveryA.id]);
    if (deliveryB) await pool.query("DELETE FROM deliveries WHERE id=$1", [deliveryB.id]);
    await pool.query("DELETE FROM drivers WHERE id=$1", [driver.id]);
    await pool.query("DELETE FROM users WHERE id IN ($1,$2)", [customer.id, driverUser.id]);
  }
});
