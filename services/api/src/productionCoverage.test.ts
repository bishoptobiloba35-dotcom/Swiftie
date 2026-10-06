import test, { after } from "node:test";
import assert from "node:assert/strict";
import { canTransition, assertTransition, type DeliveryStatus } from "./deliveryState.js";
import { safeStorageKey, putPrivateObject, getPrivateObject, deletePrivateObject } from "./storage.js";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery, transitionDelivery, createDispute, createSupportTicket, listSupportTicketMessages, recordAdminSupportReply, createEligiblePayout, updatePayoutProviderStatus } from "./database/deliveryRepository.js";
import { readFile } from "node:fs/promises";

const db = pool;

test("delivery state machine accepts every declared forward transition and rejects illegal terminal reversals", () => {
  const allowed: Record<DeliveryStatus, DeliveryStatus[]> = {
    CREATED: ["PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED", "CANCELLED"],
    PAYMENT_AUTHORIZED: ["DRIVER_ASSIGNED", "CANCELLED"],
    DRIVER_ASSIGNED: ["DRIVER_AT_PICKUP", "CANCELLED"],
    DRIVER_AT_PICKUP: ["PICKED_UP", "CANCELLED"],
    PICKED_UP: ["IN_TRANSIT", "DISPUTED"],
    IN_TRANSIT: ["ARRIVED", "DISPUTED", "RETURNED"],
    ARRIVED: ["DELIVERED", "DISPUTED"],
    DELIVERED: [],
    CANCELLED: [],
    DISPUTED: [],
    RETURNED: []
  };
  for (const [from, targets] of Object.entries(allowed) as Array<[DeliveryStatus, DeliveryStatus[]]>) {
    for (const to of targets) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
      assert.doesNotThrow(() => assertTransition(from, to));
    }
  }
  for (const [from, to] of [
    ["DELIVERED", "ARRIVED"], ["CANCELLED", "DRIVER_ASSIGNED"], ["DISPUTED", "DELIVERED"],
    ["RETURNED", "IN_TRANSIT"], ["ARRIVED", "PICKED_UP"], ["CREATED", "DELIVERED"]
  ] as Array<[DeliveryStatus, DeliveryStatus]>) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
    assert.throws(() => assertTransition(from, to));
  }
});

test("private object storage rejects traversal and absolute keys", async () => {
  assert.throws(() => safeStorageKey("../secret"), /Invalid private storage key/);
  assert.throws(() => safeStorageKey("a/../secret"), /Invalid private storage key/);
  assert.throws(() => safeStorageKey("/absolute/file"), /Invalid private storage key/);
  assert.throws(() => safeStorageKey("C:\\absolute\\file"), /Invalid private storage key/);
  if (process.env.NODE_ENV === "production") return;
  const key = "integration-tests/state-coverage.txt";
  await putPrivateObject(key, Buffer.from("swiftie-production-test"), "text/plain");
  const stored = await getPrivateObject(key);
  assert.equal(stored.body.toString(), "swiftie-production-test");
  await deletePrivateObject(key);
  await assert.rejects(() => getPrivateObject(key));
});

if (db) {
  test("database integration covers dispute, support thread, and payout provider reconciliation", async () => {
    const schema = await readFile(new URL("./database/schema.sql", import.meta.url), "utf8");
    await db.query(schema);
    await runMigrations();

    const stamp = Date.now();
    const customer = (await db.query(
      `INSERT INTO users(role,full_name,phone,email) VALUES('CUSTOMER','Coverage Customer',$1,$2) RETURNING id`,
      [`+234905${stamp}`, `coverage-${stamp}@example.test`]
    )).rows[0];
    const driverUser = (await db.query(
      `INSERT INTO users(role,full_name,phone,email) VALUES('DRIVER','Coverage Driver',$1,$2) RETURNING id`,
      [`+234906${stamp}`, `coverage-driver-${stamp}@example.test`]
    )).rows[0];
    const driver = (await db.query(
      `INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',true) RETURNING id`, [driverUser.id]
    )).rows[0];
    await db.query(
      `INSERT INTO driver_documents(driver_id,document_type,document_url,status) VALUES($1,'DRIVER_LICENSE','integration://coverage','APPROVED')`,
      [driver.id]
    );

    const delivery = await createPersistentDelivery({
      senderId: customer.id, receiverName: "Coverage Receiver", receiverPhone: "+2349070000000", receiverPin: "454545",
      declaredValueMinor: 100000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1, dimensionsCm: { length: 10, width: 10, height: 10 }, isPerishable: false, paymentMode: "RECEIVER_ON_DELIVERY"
    });
    assert.ok(await transitionDelivery(delivery.id, "CREATED", "DRIVER_ASSIGNED", driver.id));
    assert.ok(await transitionDelivery(delivery.id, "DRIVER_ASSIGNED", "DRIVER_AT_PICKUP", driver.id));
    assert.ok(await transitionDelivery(delivery.id, "DRIVER_AT_PICKUP", "PICKED_UP", driver.id));
    assert.ok(await transitionDelivery(delivery.id, "PICKED_UP", "IN_TRANSIT", driver.id));
    assert.ok(await transitionDelivery(delivery.id, "IN_TRANSIT", "DISPUTED", driver.id));

    const dispute = await createDispute(delivery.id, customer.id, "DAMAGE", "Coverage dispute");
    assert.ok(dispute);
    assert.equal(dispute?.status, "OPEN");

    const ticket = await createSupportTicket(customer.id, "ORDER", "Coverage support", "Please investigate this order", delivery.id);
    assert.ok(ticket);
    assert.equal(ticket?.status, "OPEN");
    const initialMessages = await listSupportTicketMessages(ticket!.id, customer.id);
    assert.equal(initialMessages.length, 1);
    assert.equal(initialMessages[0].message, "Please investigate this order");

    const admin = (await db.query(
      `INSERT INTO users(role,full_name,phone,email) VALUES('ADMIN','Coverage Admin',$1,$2) RETURNING id`,
      [`+234908${stamp}`, `coverage-admin-${stamp}@example.test`]
    )).rows[0];
    const replied = await recordAdminSupportReply(ticket!.id, admin.id, "Reviewed and escalated for operations");
    assert.ok(replied);
    assert.equal(replied?.status, "IN_REVIEW");
    const messages = await listSupportTicketMessages(ticket!.id, customer.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].senderType, "ADMIN");

    const payoutDelivery = await createPersistentDelivery({
      senderId: customer.id, receiverName: "Payout Receiver", receiverPhone: "+2349070000001", receiverPin: "565656",
      declaredValueMinor: 100000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1, dimensionsCm: { length: 10, width: 10, height: 10 }, isPerishable: false
    });
    const payout = await createEligiblePayout(payoutDelivery.id, driver.id, 50000);
    assert.ok(payout);
    await db.query(
      `UPDATE payouts SET status='PROCESSING',provider='paystack',provider_reference='COVERAGE-PAYOUT-1',updated_at=now() WHERE id=$1`,
      [payout!.id]
    );
    const mismatched = await updatePayoutProviderStatus("COVERAGE-PAYOUT-1", "RELEASED", null, 49999, "NGN");
    assert.ok(mismatched);
    assert.equal(mismatched?.status, "FAILED");
    assert.equal(mismatched?.providerStatus, "amount_mismatch");
  });
}

after(async () => { if (db) await db.end(); });
