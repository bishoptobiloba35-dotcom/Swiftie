import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery, createPayment, updatePaymentStatus } from "./database/deliveryRepository.js";

const API_PORT = 4600 + (process.pid % 200);
let server: ChildProcess | null = null;

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/ready`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("API did not become ready");
}

test("receiver confirmation route verifies PIN and atomically releases escrow for courier payout", async () => {
  if (!pool) return;
  await runMigrations();
  server = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", API_PORT: String(API_PORT) },
    stdio: "ignore"
  });

  try {
    await waitForReady();
    const sender = randomUUID();
    const driverUser = randomUUID();
    const suffix = `${String(process.pid).slice(-4)}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
    await pool.query(
      `INSERT INTO users(id,role,full_name,phone,email,password_hash)
       VALUES($1,'CUSTOMER','Receiver Flow Sender',$2,$3,'not-used'),($4,'DRIVER','Receiver Flow Driver',$5,$6,'not-used')`,
      [sender, "+23480" + suffix, sender + "@example.test", driverUser, "+23481" + suffix, driverUser + "@example.test"]
    );
    const driver = (await pool.query(
      "INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',true) RETURNING id", [driverUser]
    )).rows[0];

    const delivery = await createPersistentDelivery({
      senderId: sender,
      receiverName: "Receiver",
      receiverPhone: "+2349020000042",
      receiverPin: "654321",
      declaredValueMinor: 100000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1,
      dimensionsCm: { length: 10, width: 10, height: 10 },
      isPerishable: false
    });
    await pool.query(
      `UPDATE deliveries SET driver_id=$2,status='ARRIVED',proof_requirements='{"pickup":["PHOTO"],"dropoff":["PIN"]}'::jsonb WHERE id=$1`,
      [delivery.id, driver.id]
    );
    await createPayment({ deliveryId: delivery.id, provider: "paystack", amountMinor: 100000, currency: "NGN", collectionMode: "SENDER_ESCROW" });
    assert.ok(await updatePaymentStatus(delivery.id, "HELD", "ESCROW-HTTP-1"));

    const endpoint = `http://127.0.0.1:${API_PORT}/api/deliveries/${delivery.id}/receiver-confirm`;
    const wrong = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverPhone: "+2349020000042", receiverPin: "000000" })
    });
    assert.equal(wrong.status, 403);

    const confirmed = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverPhone: "+2349020000042", receiverPin: "654321" })
    });
    assert.equal(confirmed.status, 200);
    const payload = await confirmed.json() as { escrowStatus: string; payoutAmountMinor: number; delivery: { status: string } };
    assert.equal(payload.escrowStatus, "RELEASED");
    assert.equal(payload.delivery.status, "DELIVERED");
    assert.equal(payload.payoutAmountMinor, 90000);

    const financial = (await pool.query(
      `SELECT d.status AS delivery_status, d.receiver_confirmed_at, p.status AS payment_status, p.escrow_status,
              po.status AS payout_status, po.amount_minor AS payout_amount
         FROM deliveries d JOIN payments p ON p.delivery_id=d.id LEFT JOIN payouts po ON po.delivery_id=d.id
        WHERE d.id=$1`, [delivery.id]
    )).rows[0];
    assert.equal(financial.delivery_status, "DELIVERED");
    assert.ok(financial.receiver_confirmed_at);
    assert.equal(financial.payment_status, "RELEASED");
    assert.equal(financial.escrow_status, "RELEASED");
    assert.equal(financial.payout_status, "ELIGIBLE");
    assert.equal(Number(financial.payout_amount), 90000);

    const replay = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverPhone: "+2349020000042", receiverPin: "654321" })
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
