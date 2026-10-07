import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";
import { reconcilePendingEscrowProviderPayments } from "./escrowRoutes.js";

test("pending Paystack escrow charge is recovered by provider verification", async () => {
  if (!pool) return;
  await runMigrations();
  const userId=randomUUID();
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'CUSTOMER','Escrow Reconciliation Test',$2,$3,'not-used')`,
    [userId,"+234805"+String(process.pid).slice(-7),userId+"@example.test"]
  );
  const delivery=await createPersistentDelivery({
    senderId:userId,
    receiverName:"Receiver",
    receiverPhone:"+2348012345678",
    receiverPin:"1234",
    declaredValueMinor:100000,
    pickup:{label:"Pickup",formattedAddress:"Pickup",location:{latitude:9.07,longitude:7.40}},
    dropoff:{label:"Dropoff",formattedAddress:"Dropoff",location:{latitude:9.08,longitude:7.41}},
    weightKg:1,
    dimensionsCm:{length:10,width:10,height:10},
    isPerishable:false
  });
  await pool.query(
    `INSERT INTO escrow_ledgers(order_id,total_paid_minor,courier_share_minor,service_charge_minor,protection_reserve_minor,swiftdrop_margin_minor,state)
     VALUES($1,100000,37500,5000,10000,47500,'pending_payment')`,
    [delivery.id]
  );
  const reference="SD-VERIFY-"+randomUUID();
  await pool.query(
    `INSERT INTO escrow_payment_attempts(order_id,method,provider_reference,amount_minor,idempotency_key)
     VALUES($1,'PAYSTACK_CARD',$2,100000,$3)`,
    [delivery.id,reference,"reconcile-"+randomUUID()]
  );
  await pool.query(
    `INSERT INTO payments(delivery_id,provider,amount_minor,currency,collection_mode,status,escrow_status)
     VALUES($1,'paystack',100000,'NGN','SENDER_ESCROW','PENDING','PENDING')`,
    [delivery.id]
  );

  const originalFetch=globalThis.fetch;
  const originalSecret=process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY="sk_test_escrow_reconcile";
  globalThis.fetch=(async (input: RequestInfo | URL) => {
    assert.equal(String(input),"https://api.paystack.co/transaction/verify/"+encodeURIComponent(reference));
    return new Response(JSON.stringify({
      status:true,
      data:{status:"success",amount:100000,currency:"NGN",reference}
    }),{status:200});
  }) as typeof fetch;
  try {
    await reconcilePendingEscrowProviderPayments();
    const row=(await pool.query(
      `SELECT epa.status AS attempt_status,el.state AS escrow_state,d.escrow_payment_state,p.status AS payment_status
         FROM escrow_payment_attempts epa
         JOIN escrow_ledgers el ON el.order_id=epa.order_id
         JOIN deliveries d ON d.id=epa.order_id
         JOIN payments p ON p.delivery_id=epa.order_id
        WHERE epa.order_id=$1`,[delivery.id]
    )).rows[0];
    assert.equal(row.attempt_status,"SUCCESS");
    assert.equal(row.escrow_state,"paid_escrow");
    assert.equal(row.escrow_payment_state,"paid_escrow");
    assert.equal(row.payment_status,"HELD");
  } finally {
    globalThis.fetch=originalFetch;
    if(originalSecret===undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY=originalSecret;
  }
});

after(async () => {
  if (pool) await pool.end();
});
