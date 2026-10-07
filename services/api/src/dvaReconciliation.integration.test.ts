import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";
import { requeryPendingDvaAccounts } from "./escrowRoutes.js";

test("pending DVA transfers are periodically re-queried through Paystack", async () => {
  if (!pool) return;
  await runMigrations();
  const userId=randomUUID();
  const order=await createPersistentDelivery({
    senderId:userId,
    receiverName:"DVA Receiver",
    receiverPhone:"+2349012345678",
    receiverPin:"1234",
    declaredValueMinor:100000,
    pickup:{label:"Pickup",formattedAddress:"Pickup",location:{latitude:9.07,longitude:7.40}},
    dropoff:{label:"Dropoff",formattedAddress:"Dropoff",location:{latitude:9.08,longitude:7.41}},
    weightKg:1,
    dimensionsCm:{length:10,width:10,height:10},
    isPerishable:false,
    quote:{currency:"NGN",distanceMeters:1000,durationSeconds:300,baseFareMinor:50000,distanceFareMinor:15000,weightFareMinor:0,sizeFareMinor:0,perishableSurchargeMinor:0,fuelReferenceMinor:50000,protectionReserveMinor:10000,pricingVersion:1,serviceFeeMinor:3750,totalMinor:78750}
  }).catch(async () => {
    await pool!.query(
      `INSERT INTO users(id,role,full_name,phone,email,password_hash)
       VALUES($1,'CUSTOMER','DVA Requery Test',$2,$3,'not-used') ON CONFLICT(id) DO NOTHING`,
      [userId,"+234807"+String(process.pid).slice(-7),userId+"@example.test"]
    );
    return createPersistentDelivery({
      senderId:userId,receiverName:"DVA Receiver",receiverPhone:"+2349012345678",receiverPin:"1234",
      declaredValueMinor:100000,pickup:{label:"Pickup",formattedAddress:"Pickup",location:{latitude:9.07,longitude:7.40}},
      dropoff:{label:"Dropoff",formattedAddress:"Dropoff",location:{latitude:9.08,longitude:7.41}},weightKg:1,
      dimensionsCm:{length:10,width:10,height:10},isPerishable:false
    });
  });
  const accountNumber="9930000902";
  await pool.query(
    `INSERT INTO virtual_accounts(user_id,order_id,account_number,bank_name,provider_slug,status)
     VALUES($1,$2,$3,'Test Bank','test-bank','ACTIVE')
     ON CONFLICT(order_id) DO UPDATE SET account_number=EXCLUDED.account_number,provider_slug=EXCLUDED.provider_slug,status='ACTIVE'`,
    [userId,order.id,accountNumber]
  );
  await pool.query(
    `INSERT INTO escrow_payment_attempts(order_id,method,amount_minor,status,idempotency_key)
     VALUES($1,'BANK_TRANSFER',78750,'PENDING',$2)
     ON CONFLICT(idempotency_key) DO NOTHING`,
    [order.id,"dva-requery-"+order.id]
  );

  const originalFetch=globalThis.fetch;
  const originalSecret=process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY="sk_test_dva_requery";
  globalThis.fetch=(async (input: RequestInfo | URL) => {
    const url=String(input);
    assert.match(url,/dedicated_account\/requery\?account_number=9930000902&provider_slug=test-bank&date=\d{4}-\d{2}-\d{2}/);
    return new Response(JSON.stringify({status:true,message:"requery accepted"}),{status:200});
  }) as typeof fetch;
  try {
    await requeryPendingDvaAccounts();
  } finally {
    globalThis.fetch=originalFetch;
    if(originalSecret===undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY=originalSecret;
  }
});

after(async () => {
  if (pool) await pool.end();
});
