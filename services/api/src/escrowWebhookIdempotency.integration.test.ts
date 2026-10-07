import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";

test("escrow float funding reference is idempotent across replayed webhook writes", async () => {
  if (!pool) return;
  await runMigrations();
  const reference="dva-replay-"+randomUUID();

  await pool.query(
    `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,provider_reference,metadata)
     VALUES('ESCROW_IN',100000,100000,NULL,$1,'{"reason":"paystack_escrow_funding"}'::jsonb)`,
    [reference]
  );
  await pool.query(
    `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,provider_reference,metadata)
     VALUES('ESCROW_IN',100000,200000,NULL,$1,'{"reason":"paystack_escrow_funding"}'::jsonb)
     ON CONFLICT DO NOTHING`,
    [reference]
  );

  const count=await pool.query(
    `SELECT count(*)::int AS count
       FROM float_transactions
      WHERE type='ESCROW_IN' AND provider_reference=$1`,
    [reference]
  );
  assert.equal(Number(count.rows[0].count),1);

  await pool.query(
    "DELETE FROM float_transactions WHERE type='ESCROW_IN' AND provider_reference=$1",
    [reference]
  );
});

after(async () => {
  if (pool) await pool.end();
});
