import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { reconcileProcessingWalletPayouts, createWalletPayoutProviderReference } from "./escrowRoutes.js";

test("wallet payout provider references are server-generated and Paystack-compliant", () => {
  for (let i = 0; i < 20; i += 1) {
    const reference = createWalletPayoutProviderReference();
    assert.match(reference, /^sd_wallet_[a-f0-9]{32}$/);
    assert.ok(reference.length >= 16 && reference.length <= 50);
  }
});

test("wallet payout reconciliation releases an exact Paystack transfer once and is idempotent", async () => {
  if (!pool) return;
  await runMigrations();
  const userId=randomUUID();
  const walletId=randomUUID();
  const payoutId=randomUUID();
  const reference="SD-WALLET-RECON-"+randomUUID();
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'CUSTOMER','Wallet Reconciliation Test',$2,$3,'not-used')`,
    [userId,"+234809"+String(process.pid).slice(-7),userId+"@example.test"]
  );
  await pool.query(
    `INSERT INTO stakeholder_wallets(id,user_id,stakeholder_type,balance_minor,pending_minor,currency)
     VALUES($1,$2,'COURIER',0,100000,'NGN')`,
    [walletId,userId]
  );
  await pool.query(
    `INSERT INTO payout_requests(id,wallet_id,user_id,amount_minor,status,provider,provider_reference,idempotency_key)
     VALUES($1,$2,$3,100000,'PROCESSING','paystack',$4,$5)`,
    [payoutId,walletId,userId,reference,"wallet-recon-"+randomUUID()]
  );

  const originalFetch=globalThis.fetch;
  const originalSecret=process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY="sk_test_wallet_reconciliation";
  globalThis.fetch=(async (input: RequestInfo | URL) => {
    assert.equal(String(input),"https://api.paystack.co/transfer/verify/"+encodeURIComponent(reference));
    return new Response(JSON.stringify({
      status:true,
      data:{status:"success",amount:100000,currency:"NGN",reference}
    }),{status:200,headers:{"content-type":"application/json"}});
  }) as typeof fetch;

  try {
    await reconcileProcessingWalletPayouts();
    const first=(await pool.query(
      "SELECT pr.status,sw.balance_minor,sw.pending_minor FROM payout_requests pr JOIN stakeholder_wallets sw ON sw.id=pr.wallet_id WHERE pr.id=$1",
      [payoutId]
    )).rows[0];
    assert.equal(first.status,"RELEASED");
    assert.equal(Number(first.balance_minor),0);
    assert.equal(Number(first.pending_minor),0);

    await reconcileProcessingWalletPayouts();
    const second=(await pool.query(
      "SELECT status FROM payout_requests WHERE id=$1",
      [payoutId]
    )).rows[0];
    assert.equal(second.status,"RELEASED");
  } finally {
    globalThis.fetch=originalFetch;
    if(originalSecret===undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY=originalSecret;
  }
});

test("wallet payout reconciliation rejects a Paystack amount mismatch and returns funds", async () => {
  if (!pool) return;
  const userId=randomUUID();
  const walletId=randomUUID();
  const payoutId=randomUUID();
  const reference="SD-WALLET-MISMATCH-"+randomUUID();
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,'CUSTOMER','Wallet Mismatch Test',$2,$3,'not-used')`,
    [userId,"+234808"+String(process.pid).slice(-7),userId+"@example.test"]
  );
  await pool.query(
    `INSERT INTO stakeholder_wallets(id,user_id,stakeholder_type,balance_minor,pending_minor,currency)
     VALUES($1,$2,'COURIER',0,100000,'NGN')`,
    [walletId,userId]
  );
  await pool.query(
    `INSERT INTO payout_requests(id,wallet_id,user_id,amount_minor,status,provider,provider_reference,idempotency_key)
     VALUES($1,$2,$3,100000,'PROCESSING','paystack',$4,$5)`,
    [payoutId,walletId,userId,reference,"wallet-mismatch-"+randomUUID()]
  );
  const originalFetch=globalThis.fetch;
  const originalSecret=process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY="sk_test_wallet_reconciliation";
  globalThis.fetch=(async () => new Response(JSON.stringify({
    status:true,
    data:{status:"success",amount:99999,currency:"NGN",reference}
  }),{status:200})) as typeof fetch;
  try {
    await reconcileProcessingWalletPayouts();
    const row=(await pool.query(
      "SELECT pr.status,pr.failure_reason,sw.balance_minor,sw.pending_minor FROM payout_requests pr JOIN stakeholder_wallets sw ON sw.id=pr.wallet_id WHERE pr.id=$1",
      [payoutId]
    )).rows[0];
    assert.equal(row.status,"FAILED");
    assert.equal(row.failure_reason,"Paystack transfer amount or currency mismatch");
    assert.equal(Number(row.balance_minor),100000);
    assert.equal(Number(row.pending_minor),0);
  } finally {
    globalThis.fetch=originalFetch;
    if(originalSecret===undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY=originalSecret;
  }
});

after(async () => {
  if (pool) await pool.end();
});
