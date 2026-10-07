import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { processPhase2EscrowReleases } from "./phase2EscrowWorker.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";

test("72-hour escrow release refuses to consume the protected float reserve", async () => {
  if (!pool) return;
  await runMigrations();
  const userId=randomUUID();
  const ledgerId=randomUUID();
  const trackingCode=`FLOAT-TEST-${randomUUID().replaceAll("-","").slice(0,12)}`;
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'CUSTOMER','Float Reserve Test',$2,$3,'not-used')`,
    [userId,"+234806"+String(process.pid).slice(-7),userId+"@example.test"]
  );
  const delivery=await createPersistentDelivery({
    senderId:userId,
    receiverName:"Float Receiver",
    receiverPhone:"+2348012345678",
    receiverPin:"1234",
    declaredValueMinor:1000000,
    pickup:{label:"Pickup",formattedAddress:"Pickup",location:{latitude:9.07,longitude:7.40}},
    dropoff:{label:"Dropoff",formattedAddress:"Dropoff",location:{latitude:9.08,longitude:7.41}},
    weightKg:1,
    dimensionsCm:{length:10,width:10,height:10},
    isPerishable:false
  });
  const orderId=delivery.id;
  await pool.query(
    `UPDATE deliveries
        SET status='DELIVERED',
            escrow_payment_state='dispute_window',
            escrow_total_paid_minor=1000000,
            escrow_courier_share_minor=500000,
            escrow_service_charge_minor=50000,
            escrow_protection_reserve_minor=100000,
            escrow_swiftdrop_margin_minor=350000,
            escrow_merchant_share_minor=0
      WHERE id=$1`,
    [orderId]
  );
  await pool.query(
    `INSERT INTO escrow_ledgers(
       id,order_id,total_paid_minor,courier_share_minor,service_charge_minor,
       protection_reserve_minor,swiftdrop_margin_minor,merchant_share_minor,
       state,stakeholder_release_at
     ) VALUES($1,$2,1000000,500000,50000,100000,350000,0,'dispute_window',now()-interval '1 minute')`,
    [ledgerId,orderId]
  );
  await pool.query(
    `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,metadata)
     VALUES('FUNDING',1,400000000,$1,'{}'::jsonb)`,
    [orderId]
  );

  await assert.rejects(
    () => processPhase2EscrowReleases(),
    /Insufficient SwiftDrop float reserve/
  );

  const ledger=(await pool.query("SELECT state FROM escrow_ledgers WHERE id=$1",[ledgerId])).rows[0];
  assert.equal(ledger.state,"dispute_window");
  const float=(await pool.query("SELECT balance_after_minor FROM float_transactions ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.equal(Number(float.balance_after_minor),400000000);
});

after(async () => {
  if (pool) await pool.end();
});
