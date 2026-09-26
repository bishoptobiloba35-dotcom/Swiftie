import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { attachRealtime, publishDeliveryLocation, publishDeliveryUpdate, issueTrackingToken } from "./realtime.js";
import { getLatestLocation, recordLocation } from "./trackingStore.js";
import { validateLocationEvent } from "./tracking.js";
import { databaseEnabled, createPersistentDelivery, findDelivery, findDeliveryForUser, findByTrackingCode, listOpenJobs, transitionDelivery, savePickupPhoto, verifyReceiverPin, completeDelivery, recordPersistentLocation, latestPersistentLocation, driverForUser, recordDeliveryEvent, listDeliveryEvents, findPayment, createPayment, updatePaymentStatus } from "./database/deliveryRepository.js";
import { pingDatabase } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import authRoutes from "./authRoutes.js";
import { identity } from "./requestIdentity.js";

const app = express();
const httpServer = createServer(app);
app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/uploads", express.static("uploads"));

type Status = "CREATED" | "PAYMENT_AUTHORIZED" | "DRIVER_ASSIGNED" | "DRIVER_AT_PICKUP" | "PICKED_UP" | "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "CANCELLED" | "DISPUTED";
type MemoryDelivery = {
  id: string; trackingCode: string; senderId: string; receiverName: string; receiverPhone: string;
  pickup: { label: string; formattedAddress: string }; dropoff: { label: string; formattedAddress: string };
  status: Status; driverId?: string; pickupPhotoUrl?: string; receiverPin: string; createdAt: string; updatedAt: string;
};
const deliveries = new Map<string, MemoryDelivery>();

const createDeliverySchema = z.object({
  senderId: z.string().uuid(), receiverName: z.string().min(1), receiverPhone: z.string().min(7),
  pickup: z.object({ label: z.string(), formattedAddress: z.string() }),
  dropoff: z.object({ label: z.string(), formattedAddress: z.string() })
});
const trackingCode = () => "SD-" + Math.random().toString(36).slice(2, 8).toUpperCase();
const safeDelivery = (d: any) => ({ ...d, receiverPin: undefined, receiverPinHash: undefined });

async function getOne(id: string) {
  return databaseEnabled() ? await findDelivery(id) : deliveries.get(id) ?? null;
}

app.get("/health", async (_req, res) => {
  let database = false;
  try { database = await pingDatabase(); } catch {}
  res.json({ ok: true, service: "swiftdrop-api", database });
});

app.post("/api/deliveries", requireAuth("CUSTOMER"), async (req, res) => {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const input = { ...parsed.data, senderId: identity(req) };
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  try {
    if (databaseEnabled()) {
      const created = await createPersistentDelivery({ ...input, receiverPin: pin });
      return res.status(201).json(safeDelivery(created));
    }
    const now = new Date().toISOString();
    const delivery: MemoryDelivery = { id: randomUUID(), trackingCode: trackingCode(), ...input, status: "CREATED", receiverPin: pin, createdAt: now, updatedAt: now };
    deliveries.set(delivery.id, delivery);
    return res.status(201).json(safeDelivery(delivery));
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unable to create delivery" });
  }
});

app.post("/api/deliveries/:id/payment/initialize", requireAuth("CUSTOMER"), async (req, res) => {
  const userId = identity(req);
  const delivery = databaseEnabled() ? await findDeliveryForUser(req.params.id, userId, "CUSTOMER") : await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (!databaseEnabled()) return res.status(503).json({ error: "Payments require the production database" });

  const amountMinor = Number(req.body?.amountMinor);
  const email = String(req.body?.email ?? "").trim();
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !email) {
    return res.status(400).json({ error: "Valid amountMinor and email are required" });
  }
  const secret = process.env.PAYMENT_SECRET_KEY;
  const provider = process.env.PAYMENT_PROVIDER || "paystack";
  if (provider !== "paystack" || !secret) {
    return res.status(503).json({ error: "Paystack payment configuration is not ready" });
  }

  const reference = "SD-" + delivery.trackingCode + "-" + Date.now();
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({
      email,
      amount: String(amountMinor),
      currency: "NGN",
      reference,
      metadata: { deliveryId: delivery.id, trackingCode: delivery.trackingCode }
    })
  });
  const payload = await response.json() as any;
  if (!response.ok || !payload.status || !payload.data?.authorization_url) {
    return res.status(502).json({ error: "Payment provider initialization failed" });
  }

  const payment = await createPayment({ deliveryId: delivery.id, provider: "paystack", amountMinor, currency: "NGN" });
  await updatePaymentStatus(delivery.id, "PENDING", payload.data.reference ?? reference);
  await recordDeliveryEvent({
    deliveryId: delivery.id,
    eventType: "PAYMENT_INITIALIZED",
    actorUserId: userId,
    metadata: { paymentId: payment.id, reference: payload.data.reference ?? reference, amountMinor }
  });
  res.status(201).json({
    paymentId: payment.id,
    reference: payload.data.reference ?? reference,
    authorizationUrl: payload.data.authorization_url,
    accessCode: payload.data.access_code
  });
});

app.post("/api/deliveries/:id/payment", requireAuth("CUSTOMER"), async (req, res) => {
  const userId = identity(req);
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(req.params.id, userId, "CUSTOMER")
    : await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });

  const amountMinor = Number(req.body?.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return res.status(400).json({ error: "A valid server-calculated amount is required" });
  }

  if (!databaseEnabled()) {
    return res.status(503).json({ error: "Payments require the production database and payment provider" });
  }

  const payment = await createPayment({
    deliveryId: delivery.id,
    provider: process.env.PAYMENT_PROVIDER || "pending",
    amountMinor,
    currency: "NGN"
  });
  await recordDeliveryEvent({
    deliveryId: delivery.id,
    eventType: "PAYMENT_CREATED",
    actorUserId: userId,
    metadata: { paymentId: payment.id, amountMinor, currency: "NGN" }
  });
  res.status(201).json({ payment });
});

app.post("/api/deliveries/:id/payment/status", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const role = (req as typeof req & { user?: { role: "CUSTOMER" | "ADMIN" } }).user!.role;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(req.params.id, userId, role)
    : await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });

  const status = String(req.body?.status ?? "");
  if (!["AUTHORIZED","HELD","RELEASED","REFUNDED","FAILED"].includes(status)) {
    return res.status(400).json({ error: "Invalid payment status" });
  }
  const payment = await updatePaymentStatus(req.params.id, status as any, req.body?.providerReference);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  await recordDeliveryEvent({
    deliveryId: delivery.id,
    eventType: "PAYMENT_STATUS_CHANGED",
    actorUserId: userId,
    metadata: { status, providerReference: req.body?.providerReference ?? null }
  });
  res.json({ payment });
});

app.get("/api/deliveries/:id/events", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const user = (req as typeof req & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } }).user!;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(req.params.id, user.userId, user.role)
    : await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  res.json({ events: await listDeliveryEvents(delivery.id) });
});

app.get("/api/deliveries/:id", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const user = (req as typeof req & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } }).user!;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(req.params.id, user.userId, user.role)
    : await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  res.json(safeDelivery(delivery));
});

app.post("/api/track/session", async (req, res) => {
  const code = String(req.body?.trackingCode ?? "").trim();
  if (!code) return res.status(400).json({ error: "trackingCode is required" });
  const delivery = databaseEnabled()
    ? await findByTrackingCode(code)
    : [...deliveries.values()].find(d => d.trackingCode === code) ?? null;
  if (!delivery) return res.status(404).json({ error: "Tracking code not found" });
  res.json({ deliveryId: delivery.id, trackingToken: issueTrackingToken(delivery.id) });
});

app.get("/api/track/:trackingCode", async (req, res) => {
  const delivery = databaseEnabled()
    ? await findByTrackingCode(req.params.trackingCode)
    : [...deliveries.values()].find(d => d.trackingCode === req.params.trackingCode) ?? null;
  if (!delivery) return res.status(404).json({ error: "Tracking code not found" });
  const latestLocation = databaseEnabled() ? await latestPersistentLocation(delivery.id) : getLatestLocation(delivery.id);
  res.json({ id: delivery.id, trackingCode: delivery.trackingCode, status: delivery.status, pickup: delivery.pickup, dropoff: delivery.dropoff, driverId: delivery.driverId, pickupPhotoUrl: delivery.pickupPhotoUrl, latestLocation, updatedAt: delivery.updatedAt });
});

async function authenticatedDriverId(req: express.Request): Promise<string | null> {
  const userId = identity(req as express.Request & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } });
  if (!databaseEnabled()) return userId;
  const driver = await driverForUser(userId);
  return driver?.id ?? null;
}

app.get("/api/driver/:driverId/jobs", requireAuth("DRIVER"), async (req, res) => {
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  if (req.params.driverId !== driverId) return res.status(403).json({ error: "Driver identity mismatch" });
  const jobs = databaseEnabled()
    ? await listOpenJobs()
    : [...deliveries.values()].filter(d => !d.driverId && ["CREATED", "PAYMENT_AUTHORIZED"].includes(d.status));
  res.json({ driverId, jobs: jobs.map(safeDelivery) });
});

app.post("/api/deliveries/:id/accept", requireAuth("DRIVER"), async (req, res) => {
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "CREATED", "DRIVER_ASSIGNED", driverId)
      ?? await transitionDelivery(req.params.id, "PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is no longer available" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "DRIVER_ASSIGNED", actorUserId: identity(req), metadata: { driverId } });
    publishDeliveryUpdate(req.params.id, safeDelivery(updated));
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId || !["CREATED", "PAYMENT_AUTHORIZED"].includes(delivery.status)) return res.status(409).json({ error: "Delivery is no longer available" });
  delivery.driverId = driverId; delivery.status = "DRIVER_ASSIGNED"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/at-pickup", requireAuth("DRIVER"), async (req, res) => {
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "DRIVER_ASSIGNED", "DRIVER_AT_PICKUP", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not awaiting pickup or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "DRIVER_AT_PICKUP", actorUserId: identity(req), metadata: {} });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "DRIVER_ASSIGNED") return res.status(409).json({ error: "Delivery is not awaiting pickup" });
  delivery.status = "DRIVER_AT_PICKUP"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

app.post("/api/uploads/pickup-photo", requireAuth("DRIVER"), async (req, res) => {
  const dataUrl = String(req.body?.image ?? "");
  const match = dataUrl.match(/^data:image\\/(jpeg|jpg|png);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "A JPEG or PNG data URL is required" });
  const extension = match[1] === "png" ? "png" : "jpg";
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: "Image is too large" });
  const filename = randomUUID() + "." + extension;
  const directory = path.resolve("uploads/pickups");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), buffer);
  res.status(201).json({ url: "/uploads/pickups/" + filename });
});

app.post("/api/deliveries/:id/pickup", requireAuth("DRIVER"), async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  const photo = String(req.body?.pickupPhotoUrl ?? "");
  if (!photo) return res.status(400).json({ error: "Pickup parcel photo is required" });
  if (databaseEnabled()) {
    const updated = await savePickupPhoto(req.params.id, driverId, photo);
    if (!updated) return res.status(409).json({ error: "Driver must be assigned and at pickup before confirming pickup" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "PICKED_UP", actorUserId: identity(req), metadata: { pickupPhotoUrl: photo } });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "DRIVER_AT_PICKUP") return res.status(409).json({ error: "Driver must be at pickup first" });
  delivery.pickupPhotoUrl = photo; delivery.status = "PICKED_UP"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/start-trip", requireAuth("DRIVER"), async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "PICKED_UP", "IN_TRANSIT", driverId);
    if (!updated) return res.status(409).json({ error: "Parcel must be picked up first or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "IN_TRANSIT", actorUserId: identity(req), metadata: {} });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "PICKED_UP") return res.status(409).json({ error: "Parcel must be picked up first" });
  delivery.status = "IN_TRANSIT"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/location", requireAuth("DRIVER"), async (req, res) => {
  const delivery = await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const event = {
    deliveryId: delivery.id, driverId: identity(req, String(req.body?.driverId ?? "")),
    latitude: Number(req.body?.latitude), longitude: Number(req.body?.longitude),
    accuracyMeters: req.body?.accuracyMeters == null ? undefined : Number(req.body.accuracyMeters),
    recordedAt: new Date().toISOString()
  };
  const error = validateLocationEvent(event, delivery.driverId ?? "", delivery.status);
  if (error) return res.status(403).json({ error });
  if (databaseEnabled()) await recordPersistentLocation(event); else recordLocation(event);
  publishDeliveryLocation(delivery.id, event);
  res.status(201).json(event);
});

app.post("/api/deliveries/:id/arrived", requireAuth("DRIVER"), async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "IN_TRANSIT", "ARRIVED", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not in transit or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "ARRIVED", actorUserId: identity(req), metadata: {} });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "IN_TRANSIT") return res.status(409).json({ error: "Delivery is not in transit" });
  delivery.status = "ARRIVED"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/complete", requireAuth("DRIVER"), async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  const pin = String(req.body?.receiverPin ?? "");
  if (databaseEnabled()) {
    if (!await verifyReceiverPin(req.params.id, pin)) return res.status(401).json({ error: "Invalid receiver PIN" });
    const updated = await completeDelivery(req.params.id, driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not ready or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "DELIVERED", actorUserId: identity(req), metadata: { receiverPinVerified: true } });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (!["IN_TRANSIT", "ARRIVED"].includes(delivery.status)) return res.status(409).json({ error: "Delivery is not ready for completion" });
  if (pin !== delivery.receiverPin) return res.status(401).json({ error: "Invalid receiver PIN" });
  delivery.status = "DELIVERED"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

attachRealtime(httpServer);
const port = Number(process.env.API_PORT || 4000);
httpServer.listen(port, () => console.log(`SwiftDrop API listening on port ${port}`));
