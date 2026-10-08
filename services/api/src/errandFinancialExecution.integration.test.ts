process.env.SWIFTDROP_ENABLE_ERRANDS = "true";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { signAccessToken } from "./auth.js";

const API_PORT = 5000 + (process.pid % 100);
let server: ChildProcess | null = null;

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${API_PORT}/ready`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("API did not become ready");
}

test("Hire an Errand HTTP purchase boundary requires evidence and reconciles authorized spend", async () => {
  if (!pool) return;
  await runMigrations();
  server = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", API_PORT: String(API_PORT) },
    stdio: "ignore"
  });

  try {
    await waitForReady();

    const customerId = randomUUID();
    const agentUserId = randomUUID();
    const suffix = `${String(process.pid).slice(-4)}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;

    await pool.query(
      `INSERT INTO users(id,role,full_name,phone,email,password_hash)
       VALUES($1,'CUSTOMER','Errand Financial Customer',$2,$3,'not-used'),
             ($4,'AGENT','Errand Financial Agent',$5,$6,'not-used')`,
      [
        customerId, "+234970" + suffix, customerId + "@example.test",
        agentUserId, "+234971" + suffix, agentUserId + "@example.test"
      ]
    );
    await pool.query("INSERT INTO agent_profiles(user_id,status) VALUES($1,'APPROVED')", [agentUserId]);

    const customerToken = "Bearer " + signAccessToken({ userId: customerId, role: "CUSTOMER" });
    const agentToken = "Bearer " + signAccessToken({ userId: agentUserId, role: "AGENT" });
    const endpoint = `http://127.0.0.1:${API_PORT}/api/errands`;

    const created = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: customerToken, "content-type": "application/json" },
      body: JSON.stringify({
        errandType: "SHOP_FOR_ME",
        description: "Purchase household supplies",
        items: [{
          description: "Laundry detergent 2kg",
          quantity: 1,
          maxAuthorizedMinor: 450000,
          requestedPriceMinor: 400000,
          replacementPolicy: "EXACT_ONLY"
        }],
        spendingCeilingMinor: 500000,
        merchantName: "Financial Test Store",
        merchantAddress: "12 Test Market Road, Lagos",
        merchantLat: 6.5244,
        merchantLng: 3.3792,
        replacementPolicy: "EXACT_ONLY",
        maxPriceDeltaMinor: 0,
        receiverName: "Errand Receiver",
        receiverPhone: "+2348099990001",
        receiverPin: "2468",
        destinationAddress: "20 Test Delivery Road, Lagos",
        destinationLat: 6.5312,
        destinationLng: 3.3864
      })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { errand: { id: string } };
    const buyOrderId = createdBody.errand.id;

    await pool.query(
      `UPDATE buy_orders
          SET status='APPROVED', payment_status='HELD', payment_reference='ERRAND-FINANCIAL-AUTH-1'
        WHERE id=$1`,
      [buyOrderId]
    );
    await pool.query(
      `INSERT INTO buy_order_payments(buy_order_id,provider,provider_reference,amount_minor,currency,status)
       VALUES($1,'paystack','ERRAND-FINANCIAL-AUTH-1',500000,'NGN','HELD')`,
      [buyOrderId]
    );

    const claim = await fetch(`http://127.0.0.1:${API_PORT}/api/buy-orders/${buyOrderId}/claim`, {
      method: "POST",
      headers: { authorization: agentToken }
    });
    assert.equal(claim.status, 200);

    const accepted = await fetch(`http://127.0.0.1:${API_PORT}/api/buy-orders/${buyOrderId}/accept`, {
      method: "POST",
      headers: { authorization: agentToken }
    });
    assert.equal(accepted.status, 200);

    const missingReceipt = await fetch(`http://127.0.0.1:${API_PORT}/api/buy-orders/${buyOrderId}/purchase`, {
      method: "POST",
      headers: { authorization: agentToken, "content-type": "application/json" },
      body: JSON.stringify({ actualPurchaseMinor: 300000 })
    });
    assert.equal(missingReceipt.status, 400);

    const overBudget = await fetch(`http://127.0.0.1:${API_PORT}/api/buy-orders/${buyOrderId}/purchase`, {
      method: "POST",
      headers: { authorization: agentToken, "content-type": "application/json" },
      body: JSON.stringify({ actualPurchaseMinor: 500001, receiptFile: "data:application/pdf;base64,JVBERi0xLjQKJQ==" })
    });
    assert.equal(overBudget.status, 409);

    const purchased = await fetch(`http://127.0.0.1:${API_PORT}/api/buy-orders/${buyOrderId}/purchase`, {
      method: "POST",
      headers: { authorization: agentToken, "content-type": "application/json" },
      body: JSON.stringify({ actualPurchaseMinor: 300000, receiptFile: "data:application/pdf;base64,JVBERi0xLjQKJQ==" })
    });
    assert.equal(purchased.status, 201);

    const state = (await pool.query(
      `SELECT bo.status,bo.actual_purchase_minor,bo.unused_authorization_minor,
              bop.status AS payment_status,
              EXISTS(SELECT 1 FROM buy_order_events e WHERE e.buy_order_id=bo.id AND e.event_type='PURCHASE_RECORDED') AS purchase_recorded,
              EXISTS(SELECT 1 FROM buy_order_events e WHERE e.buy_order_id=bo.id AND e.event_type='UNUSED_AUTHORIZATION_RECONCILIATION_REQUIRED') AS reconciliation_required
         FROM buy_orders bo
         JOIN buy_order_payments bop ON bop.buy_order_id=bo.id
        WHERE bo.id=$1`,
      [buyOrderId]
    )).rows[0];
    assert.equal(state.status, "PURCHASED");
    assert.equal(Number(state.actual_purchase_minor), 300000);
    assert.equal(Number(state.unused_authorization_minor), 200000);
    assert.equal(state.payment_status, "HELD");
    assert.equal(state.purchase_recorded, true);
    assert.equal(state.reconciliation_required, true);

    const replay = await fetch(`http://127.0.0.1:${API_PORT}/api/buy-orders/${buyOrderId}/purchase`, {
      method: "POST",
      headers: { authorization: agentToken, "content-type": "application/json" },
      body: JSON.stringify({ actualPurchaseMinor: 300000, receiptFile: "data:application/pdf;base64,JVBERi0xLjQKJQ==" })
    });
    assert.equal(replay.status, 409);
  } finally {
    server?.kill("SIGTERM");
    server = null;
  }
});

after(async () => {
  server?.kill("SIGTERM");
  if (pool) await pool.end();
});
