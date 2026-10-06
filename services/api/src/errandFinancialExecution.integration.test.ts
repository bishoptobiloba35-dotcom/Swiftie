import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { signAccessToken } from "./auth.js";
import { createPayment, updatePaymentStatus } from "./database/deliveryRepository.js";

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

test("Hire an Errand HTTP boundary executes authorized purchase through delivery settlement creation", async () => {
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
    const driverUserId = randomUUID();
    const suffix = `${String(process.pid).slice(-4)}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;

    await pool.query(
      `INSERT INTO users(id,role,full_name,phone,email,password_hash)
       VALUES($1,'CUSTOMER','Errand Financial Customer',$2,$3,'not-used'),
             ($4,'AGENT','Errand Financial Agent',$5,$6,'not-used'),
             ($7,'DRIVER','Errand Financial Driver',$8,$9,'not-used')`,
      [
        customerId, "+234970" + suffix, customerId + "@example.test",
        agentUserId, "+234971" + suffix, agentUserId + "@example.test",
        driverUserId, "+234972" + suffix, driverUserId + "@example.test"
      ]
    );
    const agent = (await pool.query(
      "INSERT INTO agent_profiles(user_id,status) VALUES($1,'APPROVED') RETURNING id",
      [agentUserId]
    )).rows[0];

    const driver = (await pool.query("INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',true) RETURNING id", [driverUserId])).rows[0];
    await pool.query("INSERT INTO driver_documents(driver_id,document_type,document_url,status) VALUES($1,'DRIVER_LICENSE','integration://errand-financial','APPROVED')", [driver.id]);

    const customerToken = "Bearer " + signAccessToken({ userId: customerId, role: "CUSTOMER" });
    const agentToken = "Bearer " + signAccessToken({ userId: agentUserId, role: "AGENT" });
    const endpoint = `http://127.0.0.1:${API_PORT}/api/errands`;
    const payload = {
      errandType: "SHOP_FOR_ME",
      description: "Purchase household supplies and deliver them",
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
      requestedCompletionAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      receiverName: "Errand Receiver",
      receiverPhone: "+2348099990001",
      receiverPin: "2468",
      destinationAddress: "20 Test Delivery Road, Lagos",
      destinationLat: 6.5312,
      destinationLng: 3.3864
    };

    const created = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: customerToken, "content-type": "application/json" },
      body: JSON.stringify(payload)
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
    const purchasedBody = await purchased.json() as { buyOrder: { actual_purchase_minor?: number; unused_authorization_minor?: number } };
    assert.equal(Number(purchasedBody.buyOrder.actual_purchase_minor), 300000);
    assert.equal(Number(purchasedBody.buyOrder.unused_authorization_minor), 200000);

    const purchaseState = (await pool.query(
      "SELECT status,actual_purchase_minor,unused_authorization_minor FROM buy_orders WHERE id=$1",
      [buyOrderId]
    )).rows[0];
    assert.equal(purchaseState.status, "PURCHASED");
    assert.equal(Number(purchaseState.actual_purchase_minor), 300000);
    assert.equal(Number(purchaseState.unused_authorization_minor), 200000);

    const delivery = await fetch(`http://127.0.0.1:${API_PORT}/api/buy-orders/${buyOrderId}/create-delivery`, {
      method: "POST",
      headers: { authorization: agentToken }
    });
    assert.equal(delivery.status, 201);
    const deliveryBody = await delivery.json() as { delivery: { id: string; tracking_code?: string; trackingCode?: string } };
    const deliveryId = deliveryBody.delivery.id;

    await createPayment({
      deliveryId,
      provider: "paystack",
      amountMinor: 500000,
      currency: "NGN",
      collectionMode: "SENDER_ESCROW"
    });
    assert.ok(await updatePaymentStatus(deliveryId, "HELD", "ERRAND-DELIVERY-ESCROW-1"));
    await pool.query(
      "UPDATE deliveries SET status='ARRIVED',proof_requirements='{\"dropoff\":[\"PIN\"]}'::jsonb WHERE id=$1",
      [deliveryId]
    );

    const receiverConfirm = await fetch(`http://127.0.0.1:${API_PORT}/api/deliveries/${deliveryId}/receiver-confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverPhone: payload.receiverPhone, receiverPin: payload.receiverPin })
    });
    assert.equal(receiverConfirm.status, 200);

    const settlement = (await pool.query(
      `SELECT s.agent_id,s.buy_order_id,s.amount_minor,s.currency,s.status,d.status AS delivery_status,
              p.status AS payment_status
         FROM buy_order_settlements s
         JOIN deliveries d ON d.id=$1
         JOIN payments p ON p.delivery_id=d.id
        WHERE s.buy_order_id=$2`,
      [deliveryId, buyOrderId]
    )).rows[0];
    assert.ok(settlement);
    assert.equal(settlement.agent_id, agent.id);
    assert.equal(settlement.buy_order_id, buyOrderId);
    assert.equal(Number(settlement.amount_minor), 300000);
    assert.equal(settlement.currency, "NGN");
    assert.equal(settlement.status, "PENDING");
    assert.equal(settlement.delivery_status, "DELIVERED");
    assert.equal(settlement.payment_status, "RELEASED");

    const settlementCount = (await pool.query(
      "SELECT count(*)::int AS count FROM buy_order_settlements WHERE buy_order_id=$1",
      [buyOrderId]
    )).rows[0];
    assert.equal(Number(settlementCount.count), 1);
  } finally {
    server?.kill("SIGTERM");
    server = null;
  }
});

after(async () => {
  server?.kill("SIGTERM");
  if (pool) await pool.end();
});
