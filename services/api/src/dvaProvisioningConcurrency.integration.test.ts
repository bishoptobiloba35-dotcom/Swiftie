import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";

test("DVA provisioning claim is single-flight per order", async () => {
  if (!pool) return;
  await runMigrations();
  const userId=randomUUID();
  const phone="+234"+String(Date.now()).slice(-10);
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'CUSTOMER','DVA Single Flight Test',$2,$3,'not-used')`,
    [userId,phone,userId+"@example.test"]
  );

  const order=await createPersistentDelivery({
    senderId:userId,
    receiverName:"Provisioning Receiver",
    receiverPhone:"+2349012345678",
    receiverPin:"1234",
    declaredValueMinor:100000,
    pickup:{label:"Pickup",formattedAddress:"Pickup",location:{latitude:9.07,longitude:7.40}},
    dropoff:{label:"Dropoff",formattedAddress:"Dropoff",location:{latitude:9.08,longitude:7.41}},
    weightKg:1,
    dimensionsCm:{length:10,width:10,height:10},
    isPerishable:false,
    quote:{currency:"NGN",distanceMeters:1000,durationSeconds:300,baseFareMinor:50000,distanceFareMinor:15000,weightFareMinor:0,sizeFareMinor:0,perishableSurchargeMinor:0,fuelReferenceMinor:50000,protectionReserveMinor:10000,pricingVersion:1,serviceFeeMinor:3750,totalMinor:78750}
  });

  const claims=await Promise.all(
    [1,2].map(async () => pool!.query(
      `INSERT INTO virtual_accounts(user_id,order_id,customer_code,provider_slug,status,updated_at)
       VALUES($1,$2,NULL,'test-bank','PROVISIONING',now())
       ON CONFLICT(order_id) DO NOTHING
       RETURNING id`,
      [userId,order.id]
    ))
  );

  assert.equal(claims.filter(result => result.rows.length===1).length,1);
  const row=await pool.query("SELECT status FROM virtual_accounts WHERE order_id=$1",[order.id]);
  assert.equal(row.rows[0].status,"PROVISIONING");

  await pool.query("DELETE FROM deliveries WHERE id=$1",[order.id]);
  await pool.query("DELETE FROM users WHERE id=$1",[userId]);
});

after(async () => {
  if (pool) await pool.end();
});
