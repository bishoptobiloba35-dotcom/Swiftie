import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pool } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  confirmReceiverAndReleaseEscrow,
  createPayment,
  createPersistentDelivery,
  savePickupPhoto,
  transitionDelivery,
  updatePaymentStatus
} from "./deliveryRepository.js";

if (!pool) {
  test("production database integration suite requires DATABASE_URL", { skip: true }, () => {});
} else {
  test("migrations are idempotent and core delivery escrow flow is transactional", async () => {
    const schemaUrl = new URL("./schema.sql", import.meta.url);
    const schema = await readFile(schemaUrl, "utf8");

    // CI provisions a dedicated empty PostgreSQL database for this suite.
    // Rebuilding the schema here keeps the test independent from migration order
    // outside the repository and verifies that every committed migration applies.
    await pool.query(schema);
    await runMigrations();
    await runMigrations();

    const customer = (await pool.query(
      `INSERT INTO users (role, full_name, phone, email)
       VALUES ('CUSTOMER','Integration Customer',$1,$2)
       RETURNING id`,
      [`+234900${Date.now()}`, `integration-${Date.now()}@example.test`]
    )).rows[0];

    const driverUser = (await pool.query(
      `INSERT INTO users (role, full_name, phone, email)
       VALUES ('DRIVER','Integration Driver',$1,$2)
       RETURNING id`,
      [`+234901${Date.now()}`, `driver-${Date.now()}@example.test`]
    )).rows[0];

    const driver = (await pool.query(
      "INSERT INTO drivers (user_id,status,online) VALUES ($1,'APPROVED',true) RETURNING id",
      [driverUser.id]
    )).rows[0];

    await pool.query(
      `INSERT INTO driver_documents (driver_id,document_type,document_url,status)
       VALUES ($1,'DRIVER_LICENSE','integration://kyc','APPROVED')`,
      [driver.id]
    );

    const delivery = await createPersistentDelivery({
      senderId: customer.id,
      receiverName: "Integration Receiver",
      receiverPhone: "+2349020000000",
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.0765, longitude: 7.3986 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.4 } },
      receiverPin: "123456",
      weightKg: 2,
      dimensionsCm: { length: 20, width: 20, height: 20 },
      isPerishable: false,
      quote: {
        currency: "NGN",
        distanceMeters: 1000,
        durationSeconds: 450,
        baseFareMinor: 50000,
        distanceFareMinor: 18000,
        weightFareMinor: 10000,
        sizeFareMinor: 0,
        perishableSurchargeMinor: 0,
        serviceFeeMinor: 3900,
        totalMinor: 81900
      }
    });

    await createPayment({ deliveryId: delivery.id, provider: "paystack", amountMinor: 81900 });
    assert.equal((await updatePaymentStatus(delivery.id, "AUTHORIZED", "integration-payment")).status, "AUTHORIZED");
    assert.equal((await transitionDelivery(delivery.id, "CREATED", "PAYMENT_AUTHORIZED"))?.status, "PAYMENT_AUTHORIZED");
    assert.equal((await transitionDelivery(delivery.id, "PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED", driver.id))?.driverId, driver.id);
    assert.equal((await transitionDelivery(delivery.id, "DRIVER_ASSIGNED", "DRIVER_AT_PICKUP", driver.id))?.status, "DRIVER_AT_PICKUP");
    assert.equal((await savePickupPhoto(delivery.id, driver.id, "supabase://pickup/photo"))?.status, "PICKED_UP");
    assert.equal((await transitionDelivery(delivery.id, "PICKED_UP", "IN_TRANSIT", driver.id))?.status, "IN_TRANSIT");
    assert.equal((await transitionDelivery(delivery.id, "IN_TRANSIT", "ARRIVED", driver.id))?.status, "ARRIVED");
    await updatePaymentStatus(delivery.id, "HELD");

    const completed = await confirmReceiverAndReleaseEscrow(
      delivery.id,
      " +2349020000000".trim(),
      "123456",
      90
    );

    assert.ok(completed);
    assert.equal(completed.delivery.status, "DELIVERED");
    assert.equal(completed.payoutAmountMinor, 73710);

    const financial = (await pool.query(
      `SELECT p.status AS payment_status, p.escrow_status,
              po.status AS payout_status, po.amount_minor
         FROM payments p
         LEFT JOIN payouts po ON po.delivery_id=p.delivery_id
        WHERE p.delivery_id=$1`,
      [delivery.id]
    )).rows[0];

    assert.equal(financial.payment_status, "RELEASED");
    assert.equal(financial.escrow_status, "RELEASED");
    assert.equal(financial.payout_status, "ELIGIBLE");
    assert.equal(Number(financial.amount_minor), 73710);
  });
}

after(async () => {
  if (pool) await pool.end();
});
