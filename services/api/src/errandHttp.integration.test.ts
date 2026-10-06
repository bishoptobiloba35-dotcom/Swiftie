import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { signAccessToken } from "./auth.js";

const API_PORT = 4900 + (process.pid % 100);
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

test("Hire an Errand HTTP boundary persists spending and replacement authorization safely", async () => {
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
    const otherCustomerId = randomUUID();
    const suffix = `${String(process.pid).slice(-4)}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;

    await pool.query(
      `INSERT INTO users(id,role,full_name,phone,email,password_hash)
       VALUES($1,'CUSTOMER','Errand HTTP Customer',$2,$3,'not-used'),
             ($4,'CUSTOMER','Errand HTTP Other',$5,$6,'not-used')`,
      [
        customerId, "+23495" + suffix, customerId + "@example.test",
        otherCustomerId, "+23496" + suffix, otherCustomerId + "@example.test"
      ]
    );

    const customerToken = "Bearer " + signAccessToken({ userId: customerId, role: "CUSTOMER" });
    const otherToken = "Bearer " + signAccessToken({ userId: otherCustomerId, role: "CUSTOMER" });
    const endpoint = `http://127.0.0.1:${API_PORT}/api/errands`;
    const requestedCompletionAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const payload = {
      errandType: "SHOP_FOR_ME",
      description: "Purchase household supplies and deliver them",
      items: [
        {
          description: "Laundry detergent 2kg",
          quantity: 2,
          maxAuthorizedMinor: 450000,
          requestedPriceMinor: 400000,
          replacementPolicy: "APPROVED_ALTERNATIVES"
        }
      ],
      spendingCeilingMinor: 500000,
      merchantName: "HTTP Test Store",
      merchantAddress: "12 Test Market Road, Lagos",
      merchantLat: 6.5244,
      merchantLng: 3.3792,
      replacementPolicy: "APPROVED_ALTERNATIVES",
      maxPriceDeltaMinor: 50000,
      instructions: "Do not substitute without the configured approval policy.",
      requestedCompletionAt,
      receiverName: "Errand Receiver",
      receiverPhone: "+2348012345678",
      receiverPin: "2468",
      destinationAddress: "20 Test Delivery Road, Lagos",
      destinationLat: 6.5312,
      destinationLng: 3.3864,
      stops: [
        {
          stopType: "PURCHASE",
          label: "Buy supplies",
          address: "12 Test Market Road, Lagos",
          latitude: 6.5244,
          longitude: 3.3792
        },
        {
          stopType: "DROP_OFF",
          label: "Deliver supplies",
          address: "20 Test Delivery Road, Lagos",
          latitude: 6.5312,
          longitude: 3.3864
        }
      ]
    };

    const created = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: customerToken, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as {
      errand: {
        id: string;
        errandType: string;
        purchaseBudgetMinor: number;
        replacementPolicy: string;
        maxPriceDeltaMinor: number;
        receiverName: string;
        destinationAddress: string;
      };
      items: Array<{
        description: string;
        quantity: number;
        maxAuthorizedMinor: number;
        requestedPriceMinor: number | null;
        replacementPolicy: string;
      }>;
      stops: Array<{ order: number; stopType: string }>;
    };

    assert.equal(createdBody.errand.errandType, "SHOP_FOR_ME");
    assert.equal(createdBody.errand.purchaseBudgetMinor, 500000);
    assert.equal(createdBody.errand.replacementPolicy, "APPROVED_ALTERNATIVES");
    assert.equal(createdBody.errand.maxPriceDeltaMinor, 50000);
    assert.equal(createdBody.errand.receiverName, "Errand Receiver");
    assert.equal(createdBody.errand.destinationAddress, "20 Test Delivery Road, Lagos");
    assert.equal(createdBody.items.length, 1);
    assert.equal(createdBody.items[0].quantity, 2);
    assert.equal(createdBody.items[0].maxAuthorizedMinor, 450000);
    assert.equal(createdBody.items[0].requestedPriceMinor, 400000);
    assert.equal(createdBody.items[0].replacementPolicy, "APPROVED_ALTERNATIVES");
    assert.deepEqual(createdBody.stops.map(stop => stop.stopType), ["PURCHASE", "DROP_OFF"]);

    const persisted = (await pool.query(
      `SELECT bo.customer_user_id,bo.errand_type,bo.purchase_budget_minor,
              bo.replacement_policy,bo.max_price_delta_minor,bo.requested_completion_at,
              i.quantity,i.max_authorized_minor,i.requested_price_minor,i.replacement_policy AS item_replacement_policy,
              COUNT(s.id)::int AS stop_count
         FROM buy_orders bo
         JOIN buy_order_items i ON i.buy_order_id=bo.id
         LEFT JOIN buy_order_stops s ON s.buy_order_id=bo.id
        WHERE bo.id=$1
        GROUP BY bo.id,i.id`,
      [createdBody.errand.id]
    )).rows[0];

    assert.equal(persisted.customer_user_id, customerId);
    assert.equal(persisted.errand_type, "SHOP_FOR_ME");
    assert.equal(Number(persisted.purchase_budget_minor), 500000);
    assert.equal(persisted.replacement_policy, "APPROVED_ALTERNATIVES");
    assert.equal(Number(persisted.max_price_delta_minor), 50000);
    assert.equal(Number(persisted.quantity), 2);
    assert.equal(Number(persisted.max_authorized_minor), 450000);
    assert.equal(Number(persisted.requested_price_minor), 400000);
    assert.equal(persisted.item_replacement_policy, "APPROVED_ALTERNATIVES");
    assert.equal(Number(persisted.stop_count), 2);

    const detail = await fetch(endpoint + "/" + encodeURIComponent(createdBody.errand.id), {
      headers: { authorization: customerToken }
    });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as {
      errand: { id: string; purchaseBudgetMinor: number; actualPurchaseMinor: number | null };
      items: unknown[];
      events: Array<{ eventType: string }>;
      payment: unknown;
    };
    assert.equal(detailBody.errand.id, createdBody.errand.id);
    assert.equal(detailBody.errand.purchaseBudgetMinor, 500000);
    assert.equal(detailBody.errand.actualPurchaseMinor, null);
    assert.equal(detailBody.items.length, 1);
    assert.equal(detailBody.events[0]?.eventType, "ERRAND_CREATED");
    assert.equal(detailBody.payment, null);

    const unauthorized = await fetch(endpoint + "/" + encodeURIComponent(createdBody.errand.id), {
      headers: { authorization: otherToken }
    });
    assert.equal(unauthorized.status, 403);

    const pastCompletion = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: customerToken, "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        description: "This must fail because completion is in the past",
        requestedCompletionAt: new Date(Date.now() - 60_000).toISOString()
      })
    });
    assert.equal(pastCompletion.status, 400);

    const missingCeiling = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: customerToken, "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        spendingCeilingMinor: 0,
        items: [{ ...payload.items[0], maxAuthorizedMinor: 0 }]
      })
    });
    assert.equal(missingCeiling.status, 400);
  } finally {
    server?.kill("SIGTERM");
    server = null;
  }
});

after(async () => {
  server?.kill("SIGTERM");
  if (pool) await pool.end();
});
