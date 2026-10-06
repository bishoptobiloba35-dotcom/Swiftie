import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";
import { signAccessToken } from "./auth.js";

const API_PORT = 4800 + (process.pid % 100);
const TEST_JWT_SECRET = process.env.JWT_SECRET ?? "development-only-change-me";
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

function auth(userId: string, role: "CUSTOMER" | "DRIVER" | "ADMIN"): string {
  return "Bearer " + signAccessToken({ userId, role });
}

async function request(path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: token,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("delivery transition routes enforce the production state machine at the HTTP boundary", async () => {
  if (!pool) return;
  await runMigrations();

  server = spawn(process.execPath, ["../../node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      API_PORT: String(API_PORT),
      JWT_SECRET: TEST_JWT_SECRET
    },
    stdio: "ignore"
  });

  try {
    await waitForReady();

    const senderId = randomUUID();
    const driverUserId = randomUUID();
    const otherDriverUserId = randomUUID();
    const suffix = `${String(process.pid).slice(-4)}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;

    await pool.query(
      `INSERT INTO users(id,role,full_name,phone,email,password_hash)
       VALUES
         ($1,'CUSTOMER','State Flow Sender',$2,$3,'not-used'),
         ($4,'DRIVER','State Flow Driver',$5,$6,'not-used'),
         ($7,'DRIVER','Other Driver',$8,$9,'not-used')`,
      [
        senderId, "+23490" + suffix, senderId + "@example.test",
        driverUserId, "+23491" + suffix, driverUserId + "@example.test",
        otherDriverUserId, "+23492" + suffix, otherDriverUserId + "@example.test"
      ]
    );

    const driver = (await pool.query(
      "INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',true) RETURNING id",
      [driverUserId]
    )).rows[0];

    const otherDriver = (await pool.query(
      "INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',true) RETURNING id",
      [otherDriverUserId]
    )).rows[0];

    await pool.query(
      "INSERT INTO driver_documents(driver_id,document_type,document_url,status) VALUES($1,'DRIVER_LICENSE','/api/driver/documents/file/state-http-verified','APPROVED')",
      [driver.id]
    );

    const delivery = await createPersistentDelivery({
      senderId,
      receiverName: "Receiver",
      receiverPhone: "+2349020000099",
      receiverPin: "654321",
      declaredValueMinor: 100000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1,
      dimensionsCm: { length: 10, width: 10, height: 10 },
      isPerishable: false
    });

    await pool.query(
      `UPDATE deliveries
          SET status='PAYMENT_AUTHORIZED',
              proof_requirements='{"pickup":["PHOTO"],"dropoff":["PIN"]}'::jsonb
        WHERE id=$1`,
      [delivery.id]
    );

    const driverToken = auth(driverUserId, "DRIVER");
    const otherDriverToken = auth(otherDriverUserId, "DRIVER");

    const unverifiedDriverAccept = await request(`/api/deliveries/${delivery.id}/accept`, otherDriverToken, {});
    assert.equal(unverifiedDriverAccept.status, 403);

    const accepted = await request(`/api/deliveries/${delivery.id}/accept`, driverToken, {});
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).status, "DRIVER_ASSIGNED");

    const illegalFromAssigned = await request(`/api/deliveries/${delivery.id}/start-trip`, driverToken, {});
    assert.equal(illegalFromAssigned.status, 409);

    const atPickup = await request(`/api/deliveries/${delivery.id}/at-pickup`, driverToken, {});
    assert.equal(atPickup.status, 200);
    assert.equal((await atPickup.json()).status, "DRIVER_AT_PICKUP");

    const wrongDriver = await request(`/api/deliveries/${delivery.id}/pickup`, otherDriverToken, { pickupPhotoUrl: `/api/deliveries/${delivery.id}/pickup-photo` });
    assert.equal(wrongDriver.status, 403);

    const missingEvidence = await request(`/api/deliveries/${delivery.id}/pickup`, driverToken, {});
    assert.equal(missingEvidence.status, 400);

    const pickup = await request(`/api/deliveries/${delivery.id}/pickup`, driverToken, { pickupPhotoUrl: `/api/deliveries/${delivery.id}/pickup-photo` });
    assert.equal(pickup.status, 200);
    assert.equal((await pickup.json()).status, "PICKED_UP");

    const pickupReplay = await request(`/api/deliveries/${delivery.id}/pickup`, driverToken, { pickupPhotoUrl: `/api/deliveries/${delivery.id}/pickup-photo` });
    assert.equal(pickupReplay.status, 409);

    const arrivedBeforeTrip = await request(`/api/deliveries/${delivery.id}/arrived`, driverToken, {});
    assert.equal(arrivedBeforeTrip.status, 409);

    const startTrip = await request(`/api/deliveries/${delivery.id}/start-trip`, driverToken, {});
    assert.equal(startTrip.status, 200);
    assert.equal((await startTrip.json()).status, "IN_TRANSIT");

    const startTripReplay = await request(`/api/deliveries/${delivery.id}/start-trip`, driverToken, {});
    assert.equal(startTripReplay.status, 409);

    const arrived = await request(`/api/deliveries/${delivery.id}/arrived`, driverToken, {});
    assert.equal(arrived.status, 200);
    assert.equal((await arrived.json()).status, "ARRIVED");

    const arrivedReplay = await request(`/api/deliveries/${delivery.id}/arrived`, driverToken, {});
    assert.equal(arrivedReplay.status, 409);

    const driverComplete = await request(`/api/deliveries/${delivery.id}/complete`, driverToken, {});
    assert.equal(driverComplete.status, 409);

    const persisted = (await pool.query(
      "SELECT status, driver_id, pickup_photo_url FROM deliveries WHERE id=$1",
      [delivery.id]
    )).rows[0];
    assert.equal(persisted.status, "ARRIVED");
    assert.equal(persisted.driver_id, driver.id);
    assert.equal(persisted.pickup_photo_url, `/api/deliveries/${delivery.id}/pickup-photo`);

    assert.notEqual(otherDriver.id, driver.id);
  } finally {
    server?.kill("SIGTERM");
    server = null;
  }
});

after(async () => {
  server?.kill("SIGTERM");
  if (pool) await pool.end();
});
