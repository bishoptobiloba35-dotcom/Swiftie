import test, { after } from "node:test";
import assert from "node:assert/strict";
import { canTransition, assertTransition, type DeliveryStatus } from "./deliveryState.js";
import { safeStorageKey, putPrivateObject, getPrivateObject, deletePrivateObject } from "./storage.js";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery, transitionDelivery, createDispute, createSupportTicket, listSupportTicketMessages, recordAdminSupportReply, createEligiblePayout, updatePayoutProviderStatus, confirmReceiverAndReleaseEscrow, confirmReceiverOnDeliveryPaymentDue, settleReceiverPaymentAndReleasePayout } from "./database/deliveryRepository.js";
import { readFile } from "node:fs/promises";
import { enqueueNotification } from "./notificationOutbox.js";

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
      senderId: customer.id, receiverName: "Coverage Receiver", receiverPhone: "+2349070000000", receiverPin: "4545",
      declaredValueMinor: 100000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1, dimensionsCm: { length: 10, width: 10, height: 10 }, isPerishable: false, paymentMode: "SENDER_ESCROW"
    });
    const perishableDelivery = await createPersistentDelivery({
      senderId: customer.id, receiverName: "Perishable Receiver", receiverPhone: "+2349070000099", receiverPin: "1234",
      declaredValueMinor: 100000,
      pickup: { label: "Perishable Pickup", formattedAddress: "Perishable Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Perishable Dropoff", formattedAddress: "Perishable Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1, dimensionsCm: { length: 10, width: 10, height: 10 }, isPerishable: true, paymentMode: "SENDER_ESCROW"
    });
    const proofRequirements = (await db.query(
      "SELECT proof_requirements FROM deliveries WHERE id=$1", [perishableDelivery.id]
    )).rows[0].proof_requirements;
    assert.deepEqual(proofRequirements, { pickup: ["PHOTO"], dropoff: ["PIN", "PHOTO", "SIGNATURE"] });

    assert.ok(await transitionDelivery(delivery.id, "CREATED", "PAYMENT_AUTHORIZED"));
    assert.ok(await transitionDelivery(delivery.id, "PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED", driver.id));
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

    const legalAcceptance = (await db.query(
      `INSERT INTO legal_acceptances(user_id,terms_version,privacy_version,acceptable_use_version)
       VALUES($1,'2026-09-28','2026-09-28','2026-09-28')
       RETURNING user_id,terms_version,privacy_version,acceptable_use_version`,
      [customer.id]
    )).rows[0];
    assert.equal(legalAcceptance.user_id, customer.id);
    assert.equal(legalAcceptance.terms_version, "2026-09-28");
    const duplicateAcceptance = await db.query(
      `SELECT 1 FROM legal_acceptances
       WHERE user_id=$1 AND terms_version='2026-09-28' AND privacy_version='2026-09-28' AND acceptable_use_version='2026-09-28'`,
      [customer.id]
    );
    assert.equal(duplicateAcceptance.rowCount, 1);

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

    const escrowDelivery = await createPersistentDelivery({
      senderId: customer.id, receiverName: "Escrow Receiver", receiverPhone: "+2349070000010", receiverPin: "6767",
      declaredValueMinor: 100000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1, dimensionsCm: { length: 10, width: 10, height: 10 }, isPerishable: false, paymentMode: "SENDER_ESCROW"
    });
    await db.query(
      `INSERT INTO payments(delivery_id,provider,amount_minor,currency,status,escrow_status,collection_mode)
       VALUES($1,'paystack',100000,'NGN','HELD','HELD','SENDER_ESCROW')`,
      [escrowDelivery.id]
    );
    await db.query(
      `UPDATE deliveries SET driver_id=$2,status='ARRIVED',proof_requirements='{"dropoff":["PIN"]}'::jsonb,
          quote_protection_reserve_minor=10000 WHERE id=$1`,
      [escrowDelivery.id, driver.id]
    );
    await db.query(
      `INSERT INTO delivery_proofs(delivery_id,phase,proof_type,proof_value,metadata,captured_by_user_id)
       VALUES($1,'DROPOFF','BARCODE','676767','{"source":"integration"}'::jsonb,$2)`,
      [escrowDelivery.id, driverUser.id]
    );
    const escrowResult = await confirmReceiverAndReleaseEscrow(escrowDelivery.id, "+2349070000010", "6767", 100);
    assert.ok(escrowResult);
    assert.equal(escrowResult?.delivery.status, "DELIVERED");
    assert.equal(escrowResult?.payoutAmountMinor, 90000);
    const escrowState = (await db.query(
      `SELECT p.status AS payment_status, p.escrow_status, d.status AS delivery_status, d.receiver_confirmed_at IS NOT NULL AS confirmed,
              po.status AS payout_status, po.amount_minor
         FROM payments p JOIN deliveries d ON d.id=p.delivery_id
         LEFT JOIN payouts po ON po.delivery_id=d.id WHERE d.id=$1`, [escrowDelivery.id]
    )).rows[0];
    assert.equal(escrowState.payment_status, "RELEASED");
    assert.equal(escrowState.escrow_status, "RELEASED");
    assert.equal(escrowState.delivery_status, "DELIVERED");
    assert.equal(escrowState.confirmed, true);
    assert.equal(escrowState.payout_status, "ELIGIBLE");
    assert.equal(Number(escrowState.amount_minor), 90000);

    await assert.rejects(
      createPersistentDelivery({
        senderId: customer.id, receiverName: "Legacy Receiver", receiverPhone: "+2349070000011", receiverPin: "7878",
        declaredValueMinor: 100000,
        pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
        dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
        weightKg: 1, dimensionsCm: { length: 10, width: 10, height: 10 }, isPerishable: false, paymentMode: "RECEIVER_ON_DELIVERY"
      }),
      /payment mode|cash|constraint/i
    );

    const payoutDelivery = await createPersistentDelivery({
      senderId: customer.id, receiverName: "Payout Receiver", receiverPhone: "+2349070000001", receiverPin: "5656",
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

    await db.query(
      `UPDATE payouts SET status='PROCESSING',provider='paystack',provider_reference='COVERAGE-PAYOUT-2',updated_at=now() WHERE id=$1`,
      [payout!.id]
    );
    const released = await updatePayoutProviderStatus("COVERAGE-PAYOUT-2", "RELEASED", null, 50000, "NGN");
    assert.ok(released);
    assert.equal(released?.status, "RELEASED");
    assert.equal(released?.providerStatus, "success");

    await enqueueNotification({
      userId: customer.id,
      deliveryId: delivery.id,
      title: "Delivery update",
      body: "Your Swiftie delivery has moved.",
      type: "DELIVERY_STATUS"
    });
    const outbox = (await db.query(
      `SELECT n.user_id, n.delivery_id, n.type, ob.attempts, ob.sent_at, ob.failed_at
         FROM notification_outbox ob
         JOIN notifications n ON n.id=ob.notification_id
        WHERE n.user_id=$1 AND n.delivery_id=$2
        ORDER BY ob.created_at DESC LIMIT 1`,
      [customer.id, delivery.id]
    )).rows[0];
    assert.ok(outbox);
    assert.equal(outbox.user_id, customer.id);
    assert.equal(outbox.delivery_id, delivery.id);
    assert.equal(outbox.type, "DELIVERY_STATUS");
    assert.equal(Number(outbox.attempts), 0);
    assert.equal(outbox.sent_at, null);
    assert.equal(outbox.failed_at, null);
  });
}

after(async () => { if (db) await db.end(); });
