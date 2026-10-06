import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { driverForUser } from "./database/deliveryRepository.js";
import { deletePrivateObject, putPrivateObject } from "./storage.js";

const router = Router();

const failureSchema = z.object({
  reason: z.enum(["RECIPIENT_UNAVAILABLE","WRONG_ADDRESS","RECIPIENT_REFUSED","ACCESS_BLOCKED","SAFETY_ISSUE","VEHICLE_ISSUE","WEATHER","OTHER"]),
  notes: z.string().trim().max(1000).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  evidencePhoto: z.string().optional()
});

const rescheduleSchema = z.object({
  nextDeliveryAt: z.string().datetime()
});

router.get("/deliveries/:id/exceptions", requireAuth("CUSTOMER","DRIVER","ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id);
  const delivery = (await pool.query(
    "SELECT id,sender_id,driver_id,status,exception_status,next_delivery_at,return_reason,returned_at FROM deliveries WHERE id=$1",
    [id]
  )).rows[0];
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });

  const user = (req as any).user;
  let allowed = user?.role === "ADMIN" || delivery.sender_id === identity(req);
  if (user?.role === "DRIVER") {
    const driver = await driverForUser(identity(req));
    allowed = Boolean(driver && driver.id === delivery.driver_id);
  }
  if (!allowed) return res.status(403).json({ error: "Not authorized" });

  const attempts = await pool.query(
    "SELECT id,attempt_number,outcome,reason,notes,latitude,longitude,created_at FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number ASC",
    [id]
  );
  const events = await pool.query(
    "SELECT id,event_type,actor_user_id,metadata,created_at FROM delivery_exception_events WHERE delivery_id=$1 ORDER BY created_at ASC",
    [id]
  );
  return res.json({
    delivery: {
      id: delivery.id,
      status: delivery.status,
      exceptionStatus: delivery.exception_status,
      nextDeliveryAt: delivery.next_delivery_at,
      returnReason: delivery.return_reason,
      returnedAt: delivery.returned_at
    },
    attempts: attempts.rows.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attempt_number,
      outcome: attempt.outcome,
      reason: attempt.reason,
      notes: attempt.notes,
      latitude: attempt.latitude,
      longitude: attempt.longitude,
      createdAt: attempt.created_at
    })),
    events: events.rows.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      metadata: event.metadata,
      createdAt: event.created_at
    }))
  });
});

router.post("/deliveries/:id/failure", requireAuth("DRIVER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = failureSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const driver = await driverForUser(identity(req));
  if (!driver || driver.status !== "APPROVED") return res.status(403).json({ error: "Approved driver status is required" });

  const id = String(req.params.id);
  let evidenceKey: string | null = null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const delivery = (await client.query(
      "SELECT id,sender_id,driver_id,status,exception_status FROM deliveries WHERE id=$1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!delivery) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Delivery not found" }); }
    if (delivery.driver_id !== driver.id) { await client.query("ROLLBACK"); return res.status(403).json({ error: "This delivery is not assigned to you" }); }
    if (!["IN_TRANSIT","ARRIVED"].includes(delivery.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A delivery attempt can only fail while the parcel is in transit or at destination" });
    }
    if (["RETURN_REQUESTED","RETURN_IN_TRANSIT","RETURNED"].includes(delivery.exception_status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This delivery is already in a return workflow" });
    }

    const count = Number((await client.query(
      "SELECT count(*)::int AS count FROM delivery_attempts WHERE delivery_id=$1",
      [id]
    )).rows[0].count);
    const attemptNumber = count + 1;
    const maxAttempts = 3;
    if (attemptNumber > maxAttempts) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Maximum delivery attempts reached. The delivery must be rescheduled or returned to sender." });
    }
    if (parsed.data.evidencePhoto) {
      const match = parsed.data.evidencePhoto.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/i);
      if (!match) { await client.query("ROLLBACK"); return res.status(400).json({ error: "evidencePhoto must be a JPEG or PNG data URL" }); }
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
        await client.query("ROLLBACK");
        return res.status(413).json({ error: "Evidence photo must not exceed 8MB" });
      }
      const extension = match[1].toLowerCase() === "png" ? "png" : "jpg";
      evidenceKey = "delivery-exceptions/" + id + "/" + randomUUID() + "." + extension;
      await putPrivateObject(evidenceKey, bytes, extension === "png" ? "image/png" : "image/jpeg");
    }

    await client.query(
      "INSERT INTO delivery_attempts(delivery_id,driver_id,attempt_number,outcome,reason,notes,evidence_key,latitude,longitude) VALUES($1,$2,$3,'FAILED',$4,$5,$6,$7,$8)",
      [id, driver.id, attemptNumber, parsed.data.reason, parsed.data.notes ?? null, evidenceKey, parsed.data.latitude ?? null, parsed.data.longitude ?? null]
    );
    await client.query(
      "UPDATE deliveries SET exception_status='FAILED_ATTEMPT', updated_at=now() WHERE id=$1",
      [id]
    );
    await client.query(
      "INSERT INTO delivery_exception_events(delivery_id,actor_user_id,event_type,metadata) VALUES($1,$2,'DELIVERY_ATTEMPT_FAILED',$3::jsonb)",
      [id, identity(req), JSON.stringify({ attemptNumber, reason: parsed.data.reason })]
    );
    await client.query("COMMIT");
    return res.status(201).json({ ok: true, attemptNumber, exceptionStatus: "FAILED_ATTEMPT" });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    if (evidenceKey) {
      try { await deletePrivateObject(evidenceKey); } catch (cleanupError) {
        console.error(JSON.stringify({ event: "delivery_exception_evidence_cleanup_failed", deliveryId: id, evidenceKey, error: cleanupError instanceof Error ? cleanupError.message : "unknown" }));
      }
    }
    throw error;
  } finally {
    client.release();
  }
});

router.post("/deliveries/:id/reschedule", requireAuth("CUSTOMER","ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = String(req.params.id);
  const next = new Date(parsed.data.nextDeliveryAt);
  if (next.getTime() <= Date.now()) return res.status(400).json({ error: "nextDeliveryAt must be in the future" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const delivery = (await client.query(
      "SELECT id,sender_id,status,exception_status FROM deliveries WHERE id=$1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!delivery) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Delivery not found" }); }
    if ((req as any).user?.role !== "ADMIN" && delivery.sender_id !== identity(req)) {
      await client.query("ROLLBACK"); return res.status(403).json({ error: "Not authorized" });
    }
    if (!["FAILED_ATTEMPT","RESCHEDULED"].includes(delivery.exception_status)) {
      await client.query("ROLLBACK"); return res.status(409).json({ error: "Only a failed delivery attempt can be rescheduled" });
    }

    await client.query(
      "UPDATE deliveries SET exception_status='RESCHEDULED',next_delivery_at=$2,updated_at=now() WHERE id=$1",
      [id, next]
    );
    await client.query(
      "INSERT INTO delivery_exception_events(delivery_id,actor_user_id,event_type,metadata) VALUES($1,$2,'DELIVERY_RESCHEDULED',$3::jsonb)",
      [id, identity(req), JSON.stringify({ nextDeliveryAt: next.toISOString() })]
    );
    await client.query("COMMIT");
    return res.json({ deliveryId: id, exceptionStatus: "RESCHEDULED", nextDeliveryAt: next.toISOString() });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
});

router.post("/deliveries/:id/return-to-sender", requireAuth("CUSTOMER","ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const delivery = (await client.query(
      "SELECT id,sender_id,status,driver_id,exception_status FROM deliveries WHERE id=$1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!delivery) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Delivery not found" }); }
    if ((req as any).user?.role !== "ADMIN" && delivery.sender_id !== identity(req)) {
      await client.query("ROLLBACK"); return res.status(403).json({ error: "Not authorized" });
    }
    if (!["FAILED_ATTEMPT","RESCHEDULED"].includes(delivery.exception_status)) {
      await client.query("ROLLBACK"); return res.status(409).json({ error: "Return-to-sender is only available after a failed delivery attempt" });
    }

    await client.query(
      "UPDATE deliveries SET exception_status='RETURN_REQUESTED',return_reason='CUSTOMER_REQUEST',updated_at=now() WHERE id=$1",
      [id]
    );
    await client.query(
      "INSERT INTO delivery_exception_events(delivery_id,actor_user_id,event_type,metadata) VALUES($1,$2,'RETURN_REQUESTED',$3::jsonb)",
      [id, identity(req), JSON.stringify({ reason: "CUSTOMER_REQUEST" })]
    );
    await client.query("COMMIT");
    return res.json({ deliveryId: id, exceptionStatus: "RETURN_REQUESTED" });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
});

router.post("/deliveries/:id/return/start", requireAuth("DRIVER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const driver = await driverForUser(identity(req));
  if (!driver || driver.status !== "APPROVED") return res.status(403).json({ error: "Approved driver status is required" });
  const id = String(req.params.id);
  const updated = await pool.query(
    "UPDATE deliveries SET exception_status='RETURN_IN_TRANSIT',status='IN_TRANSIT',updated_at=now() WHERE id=$1 AND driver_id=$2 AND exception_status='RETURN_REQUESTED' RETURNING id,exception_status,status",
    [id, driver.id]
  );
  if (!updated.rows[0]) return res.status(409).json({ error: "Delivery is not ready for return transit or is assigned to another driver" });
  await pool.query(
    "INSERT INTO delivery_exception_events(delivery_id,actor_user_id,event_type,metadata) VALUES($1,$2,'RETURN_STARTED',$3::jsonb)",
    [id, identity(req), JSON.stringify({ driverId: driver.id })]
  );
  return res.json({ delivery: { id: updated.rows[0].id, exceptionStatus: updated.rows[0].exception_status, status: updated.rows[0].status } });
});

router.post("/deliveries/:id/return/complete", requireAuth("DRIVER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const driver = await driverForUser(identity(req));
  if (!driver || driver.status !== "APPROVED") return res.status(403).json({ error: "Approved driver status is required" });
  const id = String(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      "UPDATE deliveries SET exception_status='RETURNED',status='RETURNED',next_delivery_at=NULL,returned_at=now(),updated_at=now() WHERE id=$1 AND driver_id=$2 AND exception_status='RETURN_IN_TRANSIT' AND status='IN_TRANSIT' RETURNING id,exception_status,status,returned_at",
      [id, driver.id]
    );
    if (!updated.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Delivery is not in return transit or is assigned to another driver" });
    }
    const metadata = { driverId: driver.id, status: "RETURNED" };
    await client.query(
      "INSERT INTO delivery_exception_events(delivery_id,actor_user_id,event_type,metadata) VALUES($1,$2,'RETURN_COMPLETED',$3::jsonb)",
      [id, identity(req), JSON.stringify(metadata)]
    );
    // A returned parcel must never silently release or refund money.
    const payment = (await client.query(
      "SELECT id,status,escrow_status,amount_minor,currency FROM payments WHERE delivery_id=$1 FOR UPDATE",
      [id]
    )).rows[0] ?? null;
    const financialReviewRequired = Boolean(payment && ["HELD","AUTHORIZED"].includes(payment.status));
    await client.query(
      "INSERT INTO delivery_events(delivery_id,event_type,actor_user_id,metadata) VALUES($1,'RETURNED',$2,$3::jsonb)",
      [id, identity(req), JSON.stringify({
        driverId: driver.id,
        returnReason: "CUSTOMER_REQUEST",
        paymentStatus: payment?.status ?? null,
        escrowStatus: payment?.escrow_status ?? null,
        financialReviewRequired
      })]
    );
    if (financialReviewRequired) {
      await client.query(
        "INSERT INTO notifications(user_id,delivery_id,title,body,type,created_at) SELECT id,$1,'Returned delivery requires financial review',$2,'PAYMENT_REVIEW',now() FROM users WHERE role='ADMIN'",
        [id, `Delivery ${id} was returned with payment ${payment.status}; review refund/dispute handling before releasing funds.`]
      );
    }
    await client.query("COMMIT");
    return res.json({ delivery: { id: updated.rows[0].id, exceptionStatus: updated.rows[0].exception_status, status: updated.rows[0].status, returnedAt: updated.rows[0].returned_at } });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
});

export default router;
