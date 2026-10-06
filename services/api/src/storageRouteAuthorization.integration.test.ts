import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";
import { putPrivateObject } from "./storage.js";
import { signAccessToken } from "./auth.js";

const API_PORT = 4500 + (process.pid % 200);
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

async function createUser(role = "CUSTOMER"): Promise<{ id: string; token: string }> {
  if (!pool) throw new Error("DATABASE_URL is required");
  const id = randomUUID();
  const phone = `+23480${String(process.pid).slice(-4)}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [id, role, "Storage Authorization Test", phone, `${id}@example.test`, "not-used"]
  );
  return { id, token: signAccessToken({ userId: id, role: role as "CUSTOMER" | "DRIVER" | "ADMIN" | "AGENT" }) };
}

async function get(path: string, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
}

test("private pickup objects are protected by delivery ownership at the route", async () => {
  if (!pool) return;
  await runMigrations();
  server = spawn(
    process.execPath,
    ["../../node_modules/tsx/dist/cli.mjs", "src/server.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        API_PORT: String(API_PORT),
      },
      stdio: "ignore"
    }
  );

  try {
    await waitForReady();
    const owner = await createUser();
    const other = await createUser();
    const delivery = await createPersistentDelivery({
      senderId: owner.id,
      receiverName: "Storage Receiver",
      receiverPhone: "+2349011111111",
      receiverPin: "123456",
      declaredValueMinor: 500000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
      weightKg: 1,
      dimensionsCm: { length: 10, width: 10, height: 10 },
      isPerishable: false
    });

    await pool.query(
      `UPDATE deliveries SET status='DRIVER_AT_PICKUP', pickup_photo_url=$2 WHERE id=$1`,
      [delivery.id, "/api/deliveries/" + delivery.id + "/pickup-photo"]
    );
    const photo = Buffer.from("private-pickup-proof");
    await putPrivateObject(`pickups/${delivery.id}/photo.jpg`, photo, "image/jpeg");

    const allowed = await get(`/api/deliveries/${delivery.id}/pickup-photo`, owner.token);
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), photo.toString());

    const denied = await get(`/api/deliveries/${delivery.id}/pickup-photo`, other.token);
    assert.equal(denied.status, 404, "unrelated customer must not learn whether another customer's delivery exists");

    const trackingDenied = await fetch(
      `http://127.0.0.1:${API_PORT}/api/track/${delivery.trackingCode}/pickup-photo?receiverPhone=0000000000`
    );
    assert.equal(trackingDenied.status, 403);

    const trackingAllowed = await fetch(
      `http://127.0.0.1:${API_PORT}/api/track/${delivery.trackingCode}/pickup-photo?receiverPhone=+2349011111111`
    );
    assert.equal(trackingAllowed.status, 200);
    assert.equal(await trackingAllowed.text(), photo.toString());
  } finally {
    server?.kill("SIGTERM");
    server = null;
  }
});

test("private KYC objects are restricted to the owning driver or admin", async () => {
  if (!pool) return;
  const driver = await createUser("DRIVER");
  const otherDriver = await createUser("DRIVER");
  const admin = await createUser("ADMIN");

  const driverRow = (await pool.query(
    "INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',false) RETURNING id",
    [driver.id]
  )).rows[0];
  await pool.query("INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',false)", [otherDriver.id]);

  const filename = randomUUID() + ".pdf";
  await pool.query(
    `INSERT INTO driver_documents(driver_id,document_type,document_url,status)
     VALUES($1,'ID',$2,'APPROVED')`,
    [driverRow.id, "/api/driver/documents/file/" + filename]
  );
  const body = Buffer.from("private-kyc-document");
  await putPrivateObject(`kyc/${driverRow.id}/${filename}`, body, "application/pdf");

  const owner = await get(`/api/driver/documents/file/${filename}`, driver.token);
  assert.equal(owner.status, 200);
  assert.equal(await owner.text(), body.toString());

  const denied = await get(`/api/driver/documents/file/${filename}`, otherDriver.token);
  assert.equal(denied.status, 403);

  const adminResponse = await get(`/api/driver/documents/file/${filename}`, admin.token);
  assert.equal(adminResponse.status, 200);
  assert.equal(await adminResponse.text(), body.toString());
});

after(async () => {
  server?.kill("SIGTERM");
  if (pool) await pool.end();
});
