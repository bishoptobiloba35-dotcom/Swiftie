import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { recoverCourierEscrowPayout, recoverOutstandingCourierClawbacks } from "./database/deliveryRepository.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";

test("courier escrow clawback is idempotent and never drives wallet negative", async () => {
  if (!pool) return;
  const schema=await readFile(new URL("./database/schema.sql", import.meta.url), "utf8");
  await pool.query(schema);
  await runMigrations();
  const courierId=randomUUID();
  const customerId=randomUUID();
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'DRIVER','Clawback Courier',$2,$3,'not-used'),($4,'CUSTOMER','Clawback Customer',$5,$6,'not-used')`,
    [courierId,"+2348"+String(Math.floor(100000000+Math.random()*899999999)),courierId+"@example.test",customerId,"+2348"+String(Math.floor(100000000+Math.random()*899999999)),customerId+"@example.test"]
  );
  const delivery=await createPersistentDelivery({
    senderId:customerId,
    receiverName:"Receiver",
    receiverPhone:"+2348012345678",
    receiverPin:"1234",
    declaredValueMinor:1000000,
    pickup:{label:"Pickup",formattedAddress:"Pickup",location:{latitude:9.07,longitude:7.40}},
    dropoff:{label:"Dropoff",formattedAddress:"Dropoff",location:{latitude:9.08,longitude:7.41}},
    weightKg:1,
    dimensionsCm:{length:10,width:10,height:10},
    isPerishable:false
  });
  const wallet=(await pool.query(
    `INSERT INTO stakeholder_wallets(user_id,stakeholder_type,balance_minor)
     VALUES($1,'COURIER',500000) RETURNING id,balance_minor`,[courierId]
  )).rows[0];
  const original=(await pool.query(
    `INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,idempotency_key)
     VALUES($1,$2,'COURIER_INSTANT_PAYOUT','CREDIT',200000,500000,$3) RETURNING id`,
    [wallet.id,delivery.id,"test-courier-pin-"+delivery.id]
  )).rows[0];
  const first=await recoverCourierEscrowPayout(delivery.id);
  assert.equal(first.recovered,true);
  assert.equal(first.amountMinor,200000);
  const balance=(await pool.query("SELECT balance_minor FROM stakeholder_wallets WHERE id=$1",[wallet.id])).rows[0];
  assert.equal(Number(balance.balance_minor),300000);
  const debit=(await pool.query(
    `SELECT type,direction,amount_minor FROM wallet_transactions
      WHERE order_id=$1 AND type='COURIER_ESCROW_CLAWBACK'`,[delivery.id]
  )).rows[0];
  assert.equal(debit.type,"COURIER_ESCROW_CLAWBACK");
  assert.equal(debit.direction,"DEBIT");
  assert.equal(Number(debit.amount_minor),200000);
  const second=await recoverCourierEscrowPayout(delivery.id);
  assert.deepEqual(second,{recovered:true,amountMinor:200000});
  const count=(await pool.query(
    `SELECT count(*) AS count FROM wallet_transactions
      WHERE order_id=$1 AND type='COURIER_ESCROW_CLAWBACK'`,[delivery.id]
  )).rows[0];
  assert.equal(Number(count.count),1);
  const originalRow=(await pool.query("SELECT id FROM wallet_transactions WHERE id=$1",[original.id])).rows[0];
  assert.ok(originalRow);
});

test("courier escrow clawback pauses when the courier wallet cannot cover the payout", async () => {
  if (!pool) return;
  await runMigrations();
  const courierId=randomUUID();
  const customerId=randomUUID();
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'DRIVER','Short Courier',$2,$3,'not-used'),($4,'CUSTOMER','Short Customer',$5,$6,'not-used')`,
    [courierId,"+2348"+String(Math.floor(100000000+Math.random()*899999999)),courierId+"@example.test",customerId,"+2348"+String(Math.floor(100000000+Math.random()*899999999)),customerId+"@example.test"]
  );
  const delivery=await createPersistentDelivery({
    senderId:customerId,
    receiverName:"Receiver",
    receiverPhone:"+2348012345678",
    receiverPin:"1234",
    declaredValueMinor:1000000,
    pickup:{label:"Pickup",formattedAddress:"Pickup",location:{latitude:9.07,longitude:7.40}},
    dropoff:{label:"Dropoff",formattedAddress:"Dropoff",location:{latitude:9.08,longitude:7.41}},
    weightKg:1,
    dimensionsCm:{length:10,width:10,height:10},
    isPerishable:false
  });
  const wallet=(await pool.query(
    `INSERT INTO stakeholder_wallets(user_id,stakeholder_type,balance_minor)
     VALUES($1,'COURIER',50000) RETURNING id`,[courierId]
  )).rows[0];
  await pool.query(
    `INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,idempotency_key)
     VALUES($1,$2,'COURIER_INSTANT_PAYOUT','CREDIT',200000,50000,$3)`,
    [wallet.id,delivery.id,"test-short-courier-pin-"+delivery.id]
  );
  const result=await recoverCourierEscrowPayout(delivery.id);
  assert.equal(result.recovered,false);
  assert.equal(result.reason,"insufficient_courier_wallet_funds");
  const balance=(await pool.query("SELECT balance_minor FROM stakeholder_wallets WHERE id=$1",[wallet.id])).rows[0];
  assert.equal(Number(balance.balance_minor),50000);
  const clawback=(await pool.query("SELECT status FROM escrow_courier_clawbacks WHERE order_id=$1",[delivery.id])).rows[0];
  assert.equal(clawback.status,"INSUFFICIENT_FUNDS");
});

after(async () => { if (pool) await pool.end(); });

test("outstanding courier clawback is recovered from future earnings without a negative wallet", async () => {
  if (!pool) return;
  await runMigrations();
  const courierId=randomUUID();
  const customerId=randomUUID();
  const phoneSuffix=String(Math.floor(100000000+Math.random()*899999999));
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'DRIVER','Liability Courier',$2,$3,'not-used'),($4,'CUSTOMER','Liability Customer',$5,$6,'not-used')`,
    [courierId,"+2348"+phoneSuffix,courierId+"@example.test",customerId,"+2348"+String(Number(phoneSuffix)+1),customerId+"@example.test"]
  );
  const delivery=await createPersistentDelivery({
    senderId:customerId, receiverName:"Receiver", receiverPhone:"+2348012345678", receiverPin:"1234",
    declaredValueMinor:1000000,
    pickup:{label:"Pickup",formattedAddress:"Pickup",location:{latitude:9.07,longitude:7.40}},
    dropoff:{label:"Dropoff",formattedAddress:"Dropoff",location:{latitude:9.08,longitude:7.41}},
    weightKg:1, dimensionsCm:{length:10,width:10,height:10}, isPerishable:false
  });
  const wallet=(await pool.query(
    `INSERT INTO stakeholder_wallets(user_id,stakeholder_type,balance_minor) VALUES($1,'COURIER',50000) RETURNING id`,[courierId]
  )).rows[0];
  await pool.query(
    `INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,idempotency_key)
     VALUES($1,$2,'COURIER_INSTANT_PAYOUT','CREDIT',200000,50000,$3)`,
    [wallet.id,delivery.id,"liability-source-"+delivery.id]
  );
  const clawback=await recoverCourierEscrowPayout(delivery.id);
  assert.equal(clawback.recovered,false);
  const liability=(await pool.query(
    `SELECT id,outstanding_amount_minor,status FROM escrow_courier_clawback_liabilities WHERE clawback_id=(SELECT id FROM escrow_courier_clawbacks WHERE order_id=$1)`,[delivery.id]
  )).rows[0];
  assert.equal(liability.status,"OUTSTANDING");
  assert.equal(Number(liability.outstanding_amount_minor),200000);

  await pool.query("UPDATE stakeholder_wallets SET balance_minor=150000 WHERE id=$1",[wallet.id]);
  await pool.query(
    `INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,idempotency_key)
     VALUES($1,$2,'COURIER_INSTANT_PAYOUT','CREDIT',100000,150000,$3)`,
    [wallet.id,delivery.id,"future-earning-1-"+delivery.id]
  );
  const firstRecovery=await recoverOutstandingCourierClawbacks(courierId,100000,delivery.id);
  assert.equal(firstRecovery.appliedMinor,100000);
  assert.equal(firstRecovery.remainingIncomingMinor,0);
  assert.equal(Number((await pool.query("SELECT balance_minor FROM stakeholder_wallets WHERE id=$1",[wallet.id])).rows[0].balance_minor),50000);
  assert.equal(Number((await pool.query("SELECT outstanding_amount_minor FROM escrow_courier_clawback_liabilities WHERE id=$1",[liability.id])).rows[0].outstanding_amount_minor),100000);

  await pool.query("UPDATE stakeholder_wallets SET balance_minor=150000 WHERE id=$1",[wallet.id]);
  await pool.query(
    `INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,idempotency_key)
     VALUES($1,$2,'COURIER_INSTANT_PAYOUT','CREDIT',100000,150000,$3)`,
    [wallet.id,delivery.id,"future-earning-2-"+delivery.id]
  );
  const secondRecovery=await recoverOutstandingCourierClawbacks(courierId,100000,delivery.id);
  assert.equal(secondRecovery.appliedMinor,100000);
  assert.equal(Number((await pool.query("SELECT balance_minor FROM stakeholder_wallets WHERE id=$1",[wallet.id])).rows[0].balance_minor),50000);
  const settled=(await pool.query("SELECT outstanding_amount_minor,status,recovered_amount_minor FROM escrow_courier_clawback_liabilities WHERE id=$1",[liability.id])).rows[0];
  assert.equal(Number(settled.outstanding_amount_minor),0);
  assert.equal(Number(settled.recovered_amount_minor),200000);
  assert.equal(settled.status,"RECOVERED");
});
