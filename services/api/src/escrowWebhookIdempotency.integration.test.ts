import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";

test("escrow float funding reference is idempotent across replayed webhook writes", async () => {
  if (!pool) return;
  await runMigrations();
  const userId=randomUUID();
  const orderId=randomUUID();
  const reference="dva-replay-"+randomUUID();

  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'CUSTOMER','Escrow Webhook Replay Test',$2,$3,'not-used')`,
    [userId,"+234"+String(Date.now()).slice(-10),userId+"@example.test"]
  );
  await pool.query(
    `INSERT INTO deliveries(
       id,sender_id,receiver_name,receiver_phone,status,payment_mode,collection_mode,
       declared_value_minor,quote_total_minor
     ) VALUES($1,$2,'Replay Receiver','+2349012345678','CREATED','SENDER_ESCROW','SENDER_ESCROW',100000,100000)`,
    [orderId,userId]
  );

  await pool.query(
    `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,provider_reference,metadata)
     VALUES('ESCROW_IN',100000,100000,$1,$2,'{"reason":"paystack_escrow_funding"}'::jsonb)`,
    [orderId,reference]
  );
  await pool.query(
    `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,provider_reference,metadata)
     VALUES('ESCROW_IN',100000,200000,$1,$2,'{"reason":"paystack_escrow_funding"}'::jsonb)
     ON CONFLICT DO NOTHING`,
    [orderId,reference]
  );

  const count=await pool.query(
    `SELECT count(*)::int AS count
       FROM float_transactions
      WHERE type='ESCROW_IN' AND provider_reference=$1`,
    [reference]
  );
  assert.equal(Number(count.rows[0].count),1);

  await pool.query("DELETE FROM deliveries WHERE id=$1",[orderId]);
  await pool.query("DELETE FROM users WHERE id=$1",[userId]);
});

after(async () => {
  if (pool) await pool.end();
});
