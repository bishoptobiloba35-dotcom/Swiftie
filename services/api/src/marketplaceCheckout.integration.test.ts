process.env.SWIFTDROP_ENABLE_MARKETPLACE = "true";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { signAccessToken } from "./auth.js";

const API_PORT = 4700 + (process.pid % 200);
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

test("marketplace checkout creates once, reserves stock atomically, and replays idempotently", async () => {
  if (!pool) return;
  await runMigrations();
  server = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", API_PORT: String(API_PORT) },
    stdio: "ignore"
  });

  try {
    await waitForReady();

    const buyerId = randomUUID();
    const sellerId = randomUUID();
    const suffix = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 100000000n).toString().padStart(8, "0");

    await pool.query(
      `INSERT INTO users(id,role,full_name,phone,email,password_hash)
       VALUES($1,'CUSTOMER','Marketplace HTTP Buyer',$2,$3,'not-used'),
             ($4,'CUSTOMER','Marketplace HTTP Seller',$5,$6,'not-used')`,
      [buyerId, "+23493" + suffix, buyerId + "@example.test", sellerId, "+23494" + suffix, sellerId + "@example.test"]
    );

    const sellerProfile = (await pool.query(
      `INSERT INTO marketplace_seller_profiles(user_id,display_name,bio,location_label)
       VALUES($1,'HTTP Seller','Everyday goods seller','Lagos')
       RETURNING id`, [sellerId]
    )).rows[0];

    const listing = (await pool.query(
      `INSERT INTO marketplace_listings
       (seller_user_id,seller_profile_id,title,description,condition,use_description,usage_instructions,category,
        price_minor,delivery_fee_minor,final_price_minor,currency,delivery_mode,stock_quantity)
       VALUES($1,$2,'HTTP Test Product','A sufficiently detailed production marketplace listing description',
              'GOOD','Everyday use','Follow the included instructions.','Household',120000,10000,130000,'NGN','SAME_STATE',3)
       RETURNING id`, [sellerId, sellerProfile.id]
    )).rows[0];

    const token = "Bearer " + signAccessToken({ userId: buyerId, role: "CUSTOMER" });
    const endpoint = `http://127.0.0.1:${API_PORT}/api/marketplace/listings/${listing.id}/checkout`;
    const idempotencyKey = "marketplace-http-idempotency-001";

    const requestedDeliveryAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const body = JSON.stringify({ quantity: 2, requestedDeliveryAt, idempotencyKey });

    const first = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body
    });
    assert.equal(first.status, 201);
    const firstPayload = await first.json() as { order: { id: string; totalMinor: number; quantity: number; requestedDeliveryAt: string }; stockRemaining: number };
    assert.equal(firstPayload.order.quantity, 2);
    assert.equal(firstPayload.order.totalMinor, 260000);
    assert.equal(firstPayload.stockRemaining, 1);
    assert.ok(firstPayload.order.requestedDeliveryAt);

    const replay = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body
    });
    assert.equal(replay.status, 200);
    const replayPayload = await replay.json() as { order: { id: string; totalMinor: number }; idempotentReplay: boolean };
    assert.equal(replayPayload.idempotentReplay, true);
    assert.equal(replayPayload.order.id, firstPayload.order.id);
    assert.equal(replayPayload.order.totalMinor, 260000);

    const state = (await pool.query(
      `SELECT l.stock_quantity,
              (SELECT COUNT(*) FROM marketplace_orders WHERE listing_id=$1) AS order_count,
              (SELECT total_minor FROM marketplace_orders WHERE id=$2) AS order_total
         FROM marketplace_listings l WHERE l.id=$1`,
      [listing.id, firstPayload.order.id]
    )).rows[0];
    assert.equal(Number(state.stock_quantity), 1);
    assert.equal(Number(state.order_count), 1);
    assert.equal(Number(state.order_total), 260000);

    const invalidPast = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ quantity: 1, requestedDeliveryAt: new Date(Date.now() - 60_000).toISOString(), idempotencyKey: "marketplace-http-past-date-001" })
    });
    assert.equal(invalidPast.status, 400);

    const overStock = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ quantity: 2, requestedDeliveryAt, idempotencyKey: "marketplace-http-overstock-001" })
    });
    assert.equal(overStock.status, 409);
  } finally {
    server?.kill("SIGTERM");
    server = null;
  }
});

after(async () => {
  server?.kill("SIGTERM");
  if (pool) await pool.end();
});
