import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";

test("escrow payment attempts enforce payer metadata, provider-reference uniqueness, idempotency, and collection-channel checks", async () => {
  if (!pool) return;
  await runMigrations();

  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'CUSTOMER','Escrow Attempt Contract Test',$2,$3,'not-used')`,
    [userId, "+234809" + String(Date.now()).slice(-7), userId + "@example.test"]
  );

  const makeOrder = async () => createPersistentDelivery({
    senderId: userId,
    receiverName: "Escrow Contract Receiver",
    receiverPhone: "+2348012345678",
    receiverPin: "1234",
    declaredValueMinor: 100000,
    pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
    dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
    weightKg: 1,
    dimensionsCm: { length: 10, width: 10, height: 10 },
    isPerishable: false
  });

  const order1 = await makeOrder();
  const order2 = await makeOrder();
  const order3 = await makeOrder();
  const order4 = await makeOrder();
  const providerReference = "SD-CONTRACT-" + randomUUID();
  const idempotencyKey = "escrow-contract-" + randomUUID();

  const valid = (await pool.query(
    `INSERT INTO escrow_payment_attempts(
       order_id,payer_id,payer_role,provider,method,provider_reference,
       amount_minor,currency,collection_channel,status,idempotency_key
     ) VALUES($1,$2,'SENDER','paystack','PAYSTACK_CARD',$3,100000,'NGN','CARD','SUCCESS',$4)
     RETURNING payer_id,payer_role,provider,currency,collection_channel,status`,
    [order1.id, userId, providerReference, idempotencyKey]
  )).rows[0];
  assert.equal(valid.payer_id, userId);
  assert.equal(valid.payer_role, "SENDER");
  assert.equal(valid.provider, "paystack");
  assert.equal(valid.currency, "NGN");
  assert.equal(valid.collection_channel, "CARD");
  assert.equal(valid.status, "SUCCESS");

  await assert.rejects(
    pool.query(
      `INSERT INTO escrow_payment_attempts(order_id,payer_id,provider,method,provider_reference,amount_minor,status,idempotency_key)
       VALUES($1,$2,'paystack','PAYSTACK_CARD',$3,100000,'SUCCESS',$4)`,
      [order2.id, userId, providerReference, "provider-duplicate-" + randomUUID()]
    ),
    (error: any) => error?.code === "23505"
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO escrow_payment_attempts(order_id,payer_id,method,amount_minor,status,idempotency_key)
       VALUES($1,$2,'PAYSTACK_CARD',100000,'FAILED',$3)`,
      [order3.id, userId, idempotencyKey]
    ),
    (error: any) => error?.code === "23505"
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO escrow_payment_attempts(order_id,payer_id,method,amount_minor,collection_channel,status,idempotency_key)
       VALUES($1,$2,'PAYSTACK_CARD',100000,'CASH','FAILED',$3)`,
      [order4.id, userId, "invalid-channel-" + randomUUID()]
    ),
    (error: any) => error?.code === "23514"
  );
});

after(async () => {
  if (pool) await pool.end();
});
