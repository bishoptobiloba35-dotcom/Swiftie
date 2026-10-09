import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { signAccessToken } from "./auth.js";
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
    const suffix = (BigInt("0x" + randomUUID().replaceAll("-", "")) % 100000000n).toString().padStart(8, "0");
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
      receiverPin: "6543",
      declaredValueMinor: 100000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1,
      dimensionsCm: { length: 10, width: 10, height: 10 },
      isPerishable: false
    });
    await pool.query(
      `UPDATE deliveries SET driver_id=$2,status='ARRIVED',proof_requirements='{"pickup":["PHOTO"],"dropoff":["PIN"]}'::jsonb,
          escrow_payment_state='paid_escrow',escrow_total_paid_minor=100000,escrow_courier_share_minor=37500,
          escrow_service_charge_minor=5000,escrow_protection_reserve_minor=10000,escrow_swiftdrop_margin_minor=37500
        WHERE id=$1`,
      [delivery.id, driver.id]
    );
    await createPayment({ deliveryId: delivery.id, provider: "paystack", amountMinor: 100000, currency: "NGN", collectionMode: "SENDER_ESCROW" });
    assert.ok(await updatePaymentStatus(delivery.id, "HELD", "ESCROW-HTTP-1"));
    await pool.query(
      `INSERT INTO escrow_ledgers(order_id,total_paid_minor,courier_share_minor,service_charge_minor,protection_reserve_minor,swiftdrop_margin_minor,merchant_share_minor,state)
       VALUES($1,100000,37500,5000,10000,37500,0,'paid_escrow')`,
      [delivery.id]
    );
    await pool.query(
      `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,metadata)
       VALUES('FUNDING',600000000,600000000,$1,'{"reason":"receiver_confirmation_test_float"}'::jsonb)`,
      [delivery.id]
    );

    const endpoint = `http://127.0.0.1:${API_PORT}/api/escrow/${delivery.id}/pin`;
    const token = signAccessToken({ userId: sender, role: "CUSTOMER" });
    const authHeaders = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const wrong = await fetch(endpoint, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ pin: "0000" })
    });
    const wrongBody = await wrong.text();
    assert.equal(wrong.status, 401, `unexpected PIN response: ${wrongBody}`);

    const confirmed = await fetch(endpoint, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ pin: "6543" })
    });
    assert.equal(confirmed.status, 200);
    const payload = await confirmed.json() as { state: string; courierPayout: string; courierShareMinor: number };
    assert.equal(payload.state, "dispute_window");
    assert.equal(payload.courierPayout, "instant");
    assert.equal(payload.courierShareMinor, 37500);

    const financial = (await pool.query(
      `SELECT d.status AS delivery_status, d.escrow_payment_state, d.escrow_pin_confirmed_at,
              e.state AS escrow_state, e.pin_confirmed_at, e.dispute_window_until,
              wt.type AS wallet_tx_type, wt.amount_minor AS wallet_tx_amount
         FROM deliveries d
         LEFT JOIN escrow_ledgers e ON e.order_id=d.id
         LEFT JOIN stakeholder_wallets sw ON sw.user_id=$2
         LEFT JOIN wallet_transactions wt ON wt.wallet_id=sw.id AND wt.order_id=d.id AND wt.idempotency_key=$3
        WHERE d.id=$1`, [delivery.id, driverUser, `courier-pin-${delivery.id}`]
    )).rows[0];
    assert.equal(financial.delivery_status, "DELIVERED");
    assert.ok(financial.escrow_pin_confirmed_at);
    assert.ok(financial.pin_confirmed_at);
    assert.equal(financial.escrow_payment_state, "dispute_window");
    assert.equal(financial.escrow_state, "dispute_window");
    assert.ok(financial.dispute_window_until);
    assert.equal(financial.wallet_tx_type, "COURIER_INSTANT_PAYOUT");
    assert.equal(Number(financial.wallet_tx_amount), 37500);

    const replay = await fetch(endpoint, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ pin: "6543" })
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
