import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { attachRealtime, publishDeliveryLocation } from "./realtime.js";
import { getLatestLocation, recordLocation } from "./trackingStore.js";
import { validateLocationEvent } from "./tracking.js";
import { databaseEnabled, createPersistentDelivery, findDelivery, findByTrackingCode, listOpenJobs, transitionDelivery, savePickupPhoto, verifyReceiverPin, completeDelivery, recordPersistentLocation, latestPersistentLocation } from "./database/deliveryRepository.js";
import { pingDatabase } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import authRoutes from "./authRoutes.js";
import { identity } from "./requestIdentity.js";

const app = express();
const httpServer = createServer(app);
app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);

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

app.post("/api/deliveries", async (req, res) => {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const input = parsed.data;
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

app.get("/api/deliveries/:id", async (req, res) => {
  const delivery = await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  res.json(safeDelivery(delivery));
});

app.get("/api/track/:trackingCode", async (req, res) => {
  const delivery = databaseEnabled()
    ? await findByTrackingCode(req.params.trackingCode)
    : [...deliveries.values()].find(d => d.trackingCode === req.params.trackingCode) ?? null;
  if (!delivery) return res.status(404).json({ error: "Tracking code not found" });
  const latestLocation = databaseEnabled() ? await latestPersistentLocation(delivery.id) : getLatestLocation(delivery.id);
  res.json({ id: delivery.id, trackingCode: delivery.trackingCode, status: delivery.status, pickup: delivery.pickup, dropoff: delivery.dropoff, driverId: delivery.driverId, pickupPhotoUrl: delivery.pickupPhotoUrl, latestLocation, updatedAt: delivery.updatedAt });
});

app.get("/api/driver/:driverId/jobs", async (req, res) => {
  const jobs = databaseEnabled()
    ? await listOpenJobs()
    : [...deliveries.values()].filter(d => !d.driverId && ["CREATED", "PAYMENT_AUTHORIZED"].includes(d.status));
  res.json({ driverId: req.params.driverId, jobs: jobs.map(safeDelivery) });
});

app.post("/api/deliveries/:id/accept", async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  if (!driverId) return res.status(400).json({ error: "driverId is required" });
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "CREATED", "DRIVER_ASSIGNED", driverId)
      ?? await transitionDelivery(req.params.id, "PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is no longer available" });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId || !["CREATED", "PAYMENT_AUTHORIZED"].includes(delivery.status)) return res.status(409).json({ error: "Delivery is no longer available" });
  delivery.driverId = driverId; delivery.status = "DRIVER_ASSIGNED"; delivery.updatedAt = new Date().toISOString();
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/at-pickup", async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "DRIVER_ASSIGNED", "DRIVER_AT_PICKUP", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not awaiting pickup or driver is not assigned" });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "DRIVER_ASSIGNED") return res.status(409).json({ error: "Delivery is not awaiting pickup" });
  delivery.status = "DRIVER_AT_PICKUP"; delivery.updatedAt = new Date().toISOString();
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/pickup", async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  const photo = String(req.body?.pickupPhotoUrl ?? "");
  if (!photo) return res.status(400).json({ error: "Pickup parcel photo is required" });
  if (databaseEnabled()) {
    const updated = await savePickupPhoto(req.params.id, driverId, photo);
    if (!updated) return res.status(409).json({ error: "Driver must be assigned and at pickup before confirming pickup" });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "DRIVER_AT_PICKUP") return res.status(409).json({ error: "Driver must be at pickup first" });
  delivery.pickupPhotoUrl = photo; delivery.status = "PICKED_UP"; delivery.updatedAt = new Date().toISOString();
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/start-trip", async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "PICKED_UP", "IN_TRANSIT", driverId);
    if (!updated) return res.status(409).json({ error: "Parcel must be picked up first or driver is not assigned" });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "PICKED_UP") return res.status(409).json({ error: "Parcel must be picked up first" });
  delivery.status = "IN_TRANSIT"; delivery.updatedAt = new Date().toISOString();
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/location", async (req, res) => {
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

app.post("/api/deliveries/:id/arrived", async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "IN_TRANSIT", "ARRIVED", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not in transit or driver is not assigned" });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "IN_TRANSIT") return res.status(409).json({ error: "Delivery is not in transit" });
  delivery.status = "ARRIVED"; delivery.updatedAt = new Date().toISOString();
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/complete", async (req, res) => {
  const driverId = String(req.body?.driverId ?? "");
  const pin = String(req.body?.receiverPin ?? "");
  if (databaseEnabled()) {
    if (!await verifyReceiverPin(req.params.id, pin)) return res.status(401).json({ error: "Invalid receiver PIN" });
    const updated = await completeDelivery(req.params.id, driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not ready or driver is not assigned" });
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (!["IN_TRANSIT", "ARRIVED"].includes(delivery.status)) return res.status(409).json({ error: "Delivery is not ready for completion" });
  if (pin !== delivery.receiverPin) return res.status(401).json({ error: "Invalid receiver PIN" });
  delivery.status = "DELIVERED"; delivery.updatedAt = new Date().toISOString();
  res.json(safeDelivery(delivery));
});

attachRealtime(httpServer);
const port = Number(process.env.API_PORT || 4000);
httpServer.listen(port, () => console.log(`SwiftDrop API listening on port ${port}`));
