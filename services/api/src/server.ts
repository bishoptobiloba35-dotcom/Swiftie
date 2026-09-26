import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { attachRealtime, publishDeliveryLocation } from "./realtime.js";
import { getLatestLocation, recordLocation } from "./trackingStore.js";
import { validateLocationEvent } from "./tracking.js";

const app = express();
const httpServer = createServer(app);
app.use(cors());
app.use(express.json());

type Status = "CREATED" | "PAYMENT_AUTHORIZED" | "DRIVER_ASSIGNED" | "DRIVER_AT_PICKUP" | "PICKED_UP" | "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "CANCELLED" | "DISPUTED";
type Delivery = {
  id: string; trackingCode: string; senderId: string; receiverName: string; receiverPhone: string;
  pickup: { label: string; formattedAddress: string };
  dropoff: { label: string; formattedAddress: string };
  status: Status; driverId?: string; pickupPhotoUrl?: string; receiverPin: string;
  createdAt: string; updatedAt: string;
};

const deliveries = new Map<string, Delivery>();
const createDeliverySchema = z.object({
  senderId: z.string().min(1), receiverName: z.string().min(1), receiverPhone: z.string().min(7),
  pickup: z.object({ label: z.string(), formattedAddress: z.string() }),
  dropoff: z.object({ label: z.string(), formattedAddress: z.string() })
});
const trackingCode = () => "SD-" + Math.random().toString(36).slice(2, 8).toUpperCase();

app.get("/health", (_req, res) => res.json({ ok: true, service: "swiftdrop-api", time: new Date().toISOString() }));

app.post("/api/deliveries", (req, res) => {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const now = new Date().toISOString();
  const delivery: Delivery = { id: randomUUID(), trackingCode: trackingCode(), ...parsed.data, status: "CREATED",
    receiverPin: String(Math.floor(100000 + Math.random() * 900000)), createdAt: now, updatedAt: now };
  deliveries.set(delivery.id, delivery);
  res.status(201).json(delivery);
});

app.get("/api/deliveries/:id", (req, res) => {
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  res.json(delivery);
});

app.get("/api/track/:trackingCode", (req, res) => {
  const delivery = [...deliveries.values()].find(d => d.trackingCode === req.params.trackingCode);
  if (!delivery) return res.status(404).json({ error: "Tracking code not found" });
  res.json({ trackingCode: delivery.trackingCode, status: delivery.status, pickup: delivery.pickup, dropoff: delivery.dropoff,
    driverId: delivery.driverId, pickupPhotoUrl: delivery.pickupPhotoUrl, latestLocation: getLatestLocation(delivery.id), updatedAt: delivery.updatedAt });
});

app.post("/api/deliveries/:id/assign-driver", (req, res) => {
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (!req.body?.driverId) return res.status(400).json({ error: "driverId is required" });
  delivery.driverId = String(req.body.driverId); delivery.status = "DRIVER_ASSIGNED"; delivery.updatedAt = new Date().toISOString();
  res.json(delivery);
});

app.post("/api/deliveries/:id/pickup", (req, res) => {
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (!delivery.driverId) return res.status(409).json({ error: "Driver must be assigned first" });
  if (!req.body?.pickupPhotoUrl) return res.status(400).json({ error: "Pickup parcel photo is required" });
  delivery.pickupPhotoUrl = String(req.body.pickupPhotoUrl); delivery.status = "PICKED_UP"; delivery.updatedAt = new Date().toISOString();
  res.json(delivery);
});

app.post("/api/deliveries/:id/start-trip", (req, res) => {
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.status !== "PICKED_UP") return res.status(409).json({ error: "Parcel must be picked up first" });
  delivery.status = "IN_TRANSIT"; delivery.updatedAt = new Date().toISOString(); res.json(delivery);
});

app.post("/api/deliveries/:id/location", (req, res) => {
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const event = { deliveryId: delivery.id, driverId: String(req.body?.driverId ?? ""),
    latitude: Number(req.body?.latitude), longitude: Number(req.body?.longitude),
    accuracyMeters: req.body?.accuracyMeters == null ? undefined : Number(req.body.accuracyMeters),
    recordedAt: new Date().toISOString() };
  const error = validateLocationEvent(event, delivery.driverId ?? "", delivery.status);
  if (error) return res.status(403).json({ error });
  const saved = recordLocation(event); publishDeliveryLocation(delivery.id, saved); res.status(201).json(saved);
});

app.post("/api/deliveries/:id/complete", (req, res) => {
  const delivery = deliveries.get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (!["IN_TRANSIT", "ARRIVED"].includes(delivery.status)) return res.status(409).json({ error: "Delivery is not ready for completion" });
  if (String(req.body?.receiverPin) !== delivery.receiverPin) return res.status(401).json({ error: "Invalid receiver PIN" });
  delivery.status = "DELIVERED"; delivery.updatedAt = new Date().toISOString();
  res.json({ ...delivery, receiverPin: undefined });
});

attachRealtime(httpServer);
const port = Number(process.env.API_PORT || 4000);
httpServer.listen(port, () => console.log(`SwiftDrop API listening on port ${port}`));
