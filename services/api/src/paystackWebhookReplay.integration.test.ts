import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { claimPaystackWebhookEvent, finalizePaystackWebhookEvent } from "./database/deliveryRepository.js";

test("Paystack webhook claims remain retryable after failed processing", async () => {
  if (!pool) return;
  await runMigrations();
  const hash=randomUUID().replaceAll("-","");
  assert.equal(await claimPaystackWebhookEvent({
    payloadHash:hash,
    eventType:"charge.success",
    providerReference:"SD-WEBHOOK-"+hash
  }),true);
  assert.equal(await claimPaystackWebhookEvent({
    payloadHash:hash,
    eventType:"charge.success",
    providerReference:"SD-WEBHOOK-"+hash
  }),false);

  await finalizePaystackWebhookEvent(hash,"FAILED");

  assert.equal(await claimPaystackWebhookEvent({
    payloadHash:hash,
    eventType:"charge.success",
    providerReference:"SD-WEBHOOK-"+hash
  }),true);

  await finalizePaystackWebhookEvent(hash,"COMPLETED");
  assert.equal(await claimPaystackWebhookEvent({
    payloadHash:hash,
    eventType:"charge.success",
    providerReference:"SD-WEBHOOK-"+hash
  }),false);

  const row=(await pool.query(
    "SELECT processing_status,completed_at,failed_at FROM paystack_webhook_events WHERE payload_hash=$1",
    [hash]
  )).rows[0];
  assert.equal(row.processing_status,"COMPLETED");
  assert.ok(row.completed_at);
});

after(async () => {
  if (pool) await pool.end();
});
