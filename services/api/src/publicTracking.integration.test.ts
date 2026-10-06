import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { signAccessToken } from "./auth.js";
import { hashPin } from "./security.js";

const API_PORT = 4950 + (process.pid % 50);
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

test("shareable tracking exposes safe live delivery state without authentication", async () => {
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
    const deliveryId = randomUUID();
    const trackingCode = "SD-" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();

    await pool.query(
      `INSERT INTO users(id,role,full_name,phone,email,password_hash)
       VALUES($1,'CUSTOMER','Tracking Customer',$2,$3,'not-used')`,
      [customerId, "+23497" + String(process.pid).slice(-7), customerId + "@example.test"]
    );

    await pool.query(
      `INSERT INTO deliveries
       (id,tracking_code,sender_id,receiver_name,receiver_phone,payment_mode,
        pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,
        status,receiver_pin_hash,weight_kg,is_perishable,declared_value_minor,
        proof_requirements,quote_currency)
       VALUES($1,$2,$3,'Tracking Receiver','+2348011111111','SENDER_ESCROW',
        '10 Pickup Road, Lagos',6.5244,3.3792,'20 Dropoff Road, Lagos',6.5312,3.3864,
        'IN_TRANSIT',$4,1,false,250000,
        '{"pickup":["PHOTO"],"dropoff":["PIN","PHOTO"]}'::jsonb,'NGN')`,
      [deliveryId, trackingCode, customerId, hashPin("2468")]
    );

    const token = "Bearer " + signAccessToken({ userId: customerId, role: "CUSTOMER" });
    const share = await fetch(`http://127.0.0.1:${API_PORT}/api/deliveries/${deliveryId}/share-tracking`, {
      method: "POST",
      headers: { authorization: token }
    });
    assert.equal(share.status, 200);
    const shareBody = await share.json() as { url: string; expiresAt: string };
    assert.match(shareBody.url, /\/api\/public\/track\//);
    assert.ok(Date.parse(shareBody.expiresAt) > Date.now());

    const publicResponse = await fetch(shareBody.url);
    assert.equal(publicResponse.status, 200);
    const publicBody = await publicResponse.json() as {
      trackingCode: string;
      status: string;
      senderName?: string;
      receiverPhone?: string;
      proofRequirements?: unknown;
    };
    assert.equal(publicBody.trackingCode, trackingCode);
    assert.equal(publicBody.status, "IN_TRANSIT");
    assert.equal(publicBody.senderName, undefined);
    assert.equal(publicBody.receiverPhone, undefined);

    const invalid = await fetch(`http://127.0.0.1:${API_PORT}/api/public/track/not-a-real-token`);
    assert.equal(invalid.status, 404);
  } finally {
    server?.kill("SIGTERM");
    server = null;
  }
});

after(async () => {
  server?.kill("SIGTERM");
  if (pool) await pool.end();
});
