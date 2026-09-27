import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { attachRealtime, publishDeliveryLocation, publishDeliveryUpdate, issueTrackingToken } from "./realtime.js";
import { getLatestLocation, recordLocation } from "./trackingStore.js";
import { validateLocationEvent } from "./tracking.js";
import { databaseEnabled, createPersistentDelivery, findDelivery, findDeliveryForUser, findByTrackingCode, listOpenJobs, transitionDelivery, savePickupPhoto, verifyReceiverPin, completeDelivery, recordPersistentLocation, latestPersistentLocation, driverForUser, recordDeliveryEvent, listDeliveryEvents, findPayment, createPayment, updatePaymentStatus } from "./database/deliveryRepository.js";
import { pool, pingDatabase } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { assignNextDeliveryToDriver, setDriverOnline, createEligiblePayout, findPayout, createDispute, findDispute, resolveDispute } from "./database/deliveryRepository.js";
import { requireAuth } from "./authMiddleware.js";
import authRoutes from "./authRoutes.js";
import { identity } from "./requestIdentity.js";

const app = express();

const httpServer = createServer(app);
const allowedOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("Origin not allowed by CORS"));
      }
    : true,
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use("/api/auth", authRoutes);
app.use("/uploads", express.static("uploads"));

type Status = "CREATED" | "PAYMENT_AUTHORIZED" | "DRIVER_ASSIGNED" | "DRIVER_AT_PICKUP" | "PICKED_UP" | "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "CANCELLED" | "DISPUTED";
type MemoryDelivery = {
  id: string; trackingCode: string; senderId: string; receiverName: string; receiverPhone: string;
  pickup: { label: string; formattedAddress: string }; dropoff: { label: string; formattedAddress: string };
  status: Status; driverId?: string; pickupPhotoUrl?: string; receiverPin: string; createdAt: string; updatedAt: string;
};
const deliveries = new Map<string, MemoryDelivery>();
const notificationForDelivery = async (deliveryId: string, userId: string, title: string, body: string, type: string) => {
  if (!databaseEnabled()) return;
  await pool!.query("INSERT INTO notifications (user_id, delivery_id, title, body, type) VALUES ($1,$2,$3,$4,$5)", [userId, deliveryId, title, body, type]);
};


const createDeliverySchema = z.object({
  senderId: z.string().uuid().optional(), receiverName: z.string().min(1), receiverPhone: z.string().min(7),
  receiverPin: z.string().regex(/^\d{6}$/, "Receiver PIN must be exactly 6 digits"),
  weightKg: z.number().positive().max(1000),
  dimensionsCm: z.object({ length: z.number().positive().max(300), width: z.number().positive().max(300), height: z.number().positive().max(300) }),
  isPerishable: z.boolean(),
  pickup: z.object({ label: z.string(), formattedAddress: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  dropoff: z.object({ label: z.string(), formattedAddress: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  quote: z.object({
    currency: z.literal("NGN"),
    distanceMeters: z.number().int().nonnegative(),
    durationSeconds: z.number().int().positive(),
    baseFareMinor: z.number().int().positive(),
    distanceFareMinor: z.number().int().nonnegative(),
    weightFareMinor: z.number().int().nonnegative(),
    sizeFareMinor: z.number().int().nonnegative(),
    perishableSurchargeMinor: z.number().int().nonnegative(),
    serviceFeeMinor: z.number().int().nonnegative(),
    totalMinor: z.number().int().positive()
  })
});
const quoteSchema = z.object({
  pickup: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  dropoff: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  weightKg: z.number().positive().max(1000),
  dimensionsCm: z.object({ length: z.number().positive().max(300), width: z.number().positive().max(300), height: z.number().positive().max(300) }),
  isPerishable: z.boolean()
});

function calculateQuote(
  pickup: { latitude: number; longitude: number },
  dropoff: { latitude: number; longitude: number },
  parcel: { weightKg: number; dimensionsCm: { length: number; width: number; height: number }; isPerishable: boolean }
) {
  const earthRadius = 6371000;
  const lat1 = pickup.latitude * Math.PI / 180;
  const lat2 = dropoff.latitude * Math.PI / 180;
  const dLat = (dropoff.latitude - pickup.latitude) * Math.PI / 180;
  const dLng = (dropoff.longitude - pickup.longitude) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const distanceMeters = earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = distanceMeters / 1000;
  const volumeCm3 = parcel.dimensionsCm.length * parcel.dimensionsCm.width * parcel.dimensionsCm.height;
  const volumetricWeightKg = volumeCm3 / 5000;
  const billableWeightKg = Math.max(parcel.weightKg, volumetricWeightKg);
  const baseFareMinor = 50000;
  const distanceFareMinor = Math.ceil(distanceKm * 18000);
  const weightFareMinor = Math.ceil(Math.max(0, billableWeightKg - 1) * 10000);
  const sizeFareMinor = Math.ceil(Math.max(0, volumeCm3 - 10000) / 1000 * 250);
  const handlingMinor = baseFareMinor + distanceFareMinor + weightFareMinor + sizeFareMinor;
  const perishableSurchargeMinor = parcel.isPerishable ? Math.ceil(handlingMinor * 0.15) : 0;
  const serviceFeeMinor = Math.ceil((handlingMinor + perishableSurchargeMinor) * 0.05);
  return {
    currency: "NGN",
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.max(60, Math.round((distanceMeters / 8000) * 3600)),
    baseFareMinor,
    distanceFareMinor,
    weightFareMinor,
    sizeFareMinor,
    perishableSurchargeMinor,
    serviceFeeMinor,
    totalMinor: handlingMinor + perishableSurchargeMinor + serviceFeeMinor
  };
}

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

app.post("/api/deliveries/:id/rating", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Ratings require the production database" });
  const userId = identity(req);
  const delivery = await findDeliveryForUser(req.params.id, userId, "CUSTOMER");
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.status !== "DELIVERED") return res.status(409).json({ error: "Only completed deliveries can be rated" });
  if (!delivery.driverId) return res.status(409).json({ error: "Delivery has no driver to rate" });
  const parsed = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const driver = await driverForUser(delivery.driverId);
  if (!driver) return res.status(409).json({ error: "Driver profile not found" });
  try {
    const result = await pool!.query(
      `INSERT INTO ratings (delivery_id, rater_user_id, rated_user_id, stars, comment)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, delivery_id, rater_user_id, rated_user_id, stars, comment, created_at`,
      [delivery.id, userId, driver.userId, parsed.data.stars, parsed.data.comment?.trim() || null]
    );
    return res.status(201).json({ rating: result.rows[0] });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return res.status(409).json({ error: "This delivery has already been rated" });
    return res.status(500).json({ error: "Unable to save rating" });
  }
});

app.get("/api/drivers/:driverId/ratings", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Ratings require the production database" });
  const result = await pool!.query(
    `SELECT stars, comment, created_at FROM ratings WHERE rated_user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [req.params.driverId]
  );
  const average = result.rows.length
    ? result.rows.reduce((sum: number, row: { stars: number }) => sum + Number(row.stars), 0) / result.rows.length
    : null;
  res.json({ average, count: result.rows.length, ratings: result.rows });
});

app.post("/api/deliveries/:id/rating/driver", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Ratings require the production database" });
  const userId = identity(req);
  const delivery = await findDeliveryForUser(req.params.id, userId, "DRIVER");
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.status !== "DELIVERED") return res.status(409).json({ error: "Only completed deliveries can be rated" });
  const parsed = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await pool!.query(
      `INSERT INTO ratings (delivery_id, rater_user_id, rated_user_id, stars, comment)
       SELECT $1, $2, sender_id, $3, $4 FROM deliveries WHERE id=$1
       RETURNING id, delivery_id, rater_user_id, rated_user_id, stars, comment, created_at`,
      [delivery.id, userId, parsed.data.stars, parsed.data.comment?.trim() || null]
    );
    if (!result.rows[0]) return res.status(409).json({ error: "Sender could not be found" });
    return res.status(201).json({ rating: result.rows[0] });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return res.status(409).json({ error: "This delivery has already been rated" });
    return res.status(500).json({ error: "Unable to save rating" });
  }
});

app.get("/api/notifications", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Notifications require the production database" });
  const result = await pool!.query(
    "SELECT id, delivery_id, title, body, type, read_at, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
    [identity(req)]
  );
  res.json({ notifications: result.rows });
});

app.post("/api/notifications/:id/read", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Notifications require the production database" });
  const result = await pool!.query(
    "UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id, read_at",
    [req.params.id, identity(req)]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Notification not found" });
  res.json({ notification: result.rows[0] });
});

app.post("/api/notifications/device-token", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Notifications require the production database" });
  const token = String(req.body?.token ?? "").trim();
  const platform = String(req.body?.platform ?? "").toUpperCase();
  if (!token || !["IOS", "ANDROID"].includes(platform)) {
    return res.status(400).json({ error: "A valid push token and platform are required" });
  }
  await pool!.query(
    `INSERT INTO device_tokens (user_id, platform, push_token)
     VALUES ($1,$2,$3)
     ON CONFLICT (push_token) DO UPDATE SET user_id=EXCLUDED.user_id, platform=EXCLUDED.platform, updated_at=now()`,
    [identity(req), platform, token]
  );
  res.status(201).json({ registered: true });
});

app.get("/api/locations/search", requireAuth("CUSTOMER"), async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (query.length < 3) return res.status(400).json({ error: "Search query must be at least 3 characters" });
  const provider = process.env.MAPS_PROVIDER;
  const key = process.env.MAPS_API_KEY;
  if (provider !== "google" || !key) return res.status(503).json({ error: "Maps search is not configured" });
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", query);
    url.searchParams.set("key", key);
    url.searchParams.set("region", "ng");
    const response = await fetch(url);
    if (!response.ok) return res.status(502).json({ error: "Maps provider request failed" });
    const data = await response.json() as {
      status?: string;
      results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } }; place_id?: string }>;
    };
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return res.status(502).json({ error: "Maps provider returned an error" });
    res.json({
      results: (data.results ?? []).slice(0, 8).map((result) => ({
        id: result.place_id,
        formattedAddress: result.formatted_address,
        latitude: result.geometry?.location?.lat,
        longitude: result.geometry?.location?.lng
      })).filter((x) => typeof x.latitude === "number" && typeof x.longitude === "number")
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to search locations" });
  }
});

app.post("/api/quotes", requireAuth("CUSTOMER"), async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json(calculateQuote(parsed.data.pickup, parsed.data.dropoff, { weightKg: parsed.data.weightKg, dimensionsCm: parsed.data.dimensionsCm, isPerishable: parsed.data.isPerishable }));
});

app.post("/api/deliveries", requireAuth("CUSTOMER"), async (req, res) => {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const input = { ...parsed.data, senderId: identity(req) };
  const quote = calculateQuote(
    { latitude: parsed.data.pickup.latitude, longitude: parsed.data.pickup.longitude },
    { latitude: parsed.data.dropoff.latitude, longitude: parsed.data.dropoff.longitude },
    { weightKg: parsed.data.weightKg, dimensionsCm: parsed.data.dimensionsCm, isPerishable: parsed.data.isPerishable }
  );
  if (quote.currency !== "NGN" || !Number.isSafeInteger(quote.totalMinor) || quote.totalMinor <= 0) {
    return res.status(500).json({ error: "Unable to calculate delivery quote" });
  }
  parsed.data.quote = quote;
  const pin = parsed.data.receiverPin;
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

  const email = String(req.body?.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "Email is required" });
  const amountMinor = delivery.quote?.totalMinor;
  if (!amountMinor || !Number.isSafeInteger(amountMinor)) {
    return res.status(409).json({ error: "Delivery does not have a valid server quote" });
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

app.post("/api/payments/paystack/webhook", async (req, res) => {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  const signature = req.header("x-paystack-signature");
  if (!secret || !signature) return res.status(401).end();

  const crypto = await import("node:crypto");
  const expected = crypto.createHmac("sha512", secret)
    .update(JSON.stringify(req.body))
    .digest("hex");
  if (signature !== expected) return res.status(401).end();

  const event = req.body as any;
  if (event?.event !== "charge.success") return res.status(200).json({ received: true });

  const data = event.data;
  const deliveryId = String(data?.metadata?.deliveryId ?? "");
  const reference = String(data?.reference ?? "");
  if (!deliveryId || !reference) return res.status(200).json({ received: true });

  const payment = await findPayment(deliveryId);
  if (!payment || payment.provider !== "paystack" || payment.providerReference !== reference) {
    return res.status(200).json({ received: true });
  }

  if (Number(data.amount) !== payment.amountMinor || String(data.currency) !== payment.currency) {
    await updatePaymentStatus(deliveryId, "FAILED", reference);
    return res.status(200).json({ received: true });
  }

  await updatePaymentStatus(deliveryId, "HELD", reference);
  const current = await findDelivery(deliveryId);
  if (current?.status === "CREATED") {
    const authorized = await transitionDelivery(deliveryId, "CREATED", "PAYMENT_AUTHORIZED");
    if (authorized) {
      await recordDeliveryEvent({
        deliveryId,
        eventType: "PAYMENT_AUTHORIZED",
        metadata: { provider: "paystack", reference }
      });
      publishDeliveryUpdate(deliveryId, safeDelivery(authorized));
    }
  }
  await recordDeliveryEvent({
    deliveryId,
    eventType: "PAYMENT_HELD",
    metadata: { provider: "paystack", reference }
  });
  return res.status(200).json({ received: true });
});

app.get("/api/deliveries/:id/payment/status", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const role = (req as typeof req & { user?: { role: "CUSTOMER" | "ADMIN" } }).user!.role;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(req.params.id, userId, role)
    : await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const payment = await findPayment(req.params.id);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  res.json({ payment });
});

app.post("/api/deliveries/:id/dispute", requireAuth("CUSTOMER", "DRIVER"), async (req, res) => {
  const userId = identity(req);
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(req.params.id, userId, (req as any).user.role)
    : null;
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (["DELIVERED", "CANCELLED"].includes(delivery.status)) {
    return res.status(409).json({ error: "This delivery can no longer be disputed" });
  }
  const reason = String(req.body?.reason ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  if (!reason) return res.status(400).json({ error: "Dispute reason is required" });
  const dispute = await createDispute(req.params.id, userId, reason, description);
  if (!dispute) return res.status(409).json({ error: "A dispute already exists or database is unavailable" });
  await recordDeliveryEvent({
    deliveryId: req.params.id,
    eventType: "DISPUTE_OPENED",
    actorUserId: userId,
    metadata: { reason }
  });
  res.status(201).json({ dispute });
});

app.get("/api/deliveries/:id/dispute", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const role = (req as any).user.role;
  const delivery = await findDeliveryForUser(req.params.id, userId, role);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const dispute = await findDispute(req.params.id);
  if (!dispute) return res.status(404).json({ error: "No dispute found" });
  res.json({ dispute });
});

app.post("/api/driver/documents/upload", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const userId = identity(req);
  const driver = await driverForUser(userId);
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });

  const documentType = String(req.body?.documentType ?? "").trim().toUpperCase();
  const dataUrl = String(req.body?.file ?? "");
  if (!documentType || !dataUrl) return res.status(400).json({ error: "Document type and document file are required" });

  let extension = "";
  let base64 = "";
  if (/^data:application\/pdf;base64,/i.test(dataUrl)) {
    extension = "pdf";
    base64 = dataUrl.replace(/^data:application\/pdf;base64,/i, "");
  } else {
    const imageMatch = dataUrl.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/i);
    if (!imageMatch) return res.status(400).json({ error: "Only PDF, JPEG, or PNG documents are supported" });
    extension = imageMatch[1].toLowerCase() === "png" ? "png" : "jpg";
    base64 = imageMatch[2];
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) return res.status(400).json({ error: "Document file is empty" });
  if (buffer.length > 10 * 1024 * 1024) return res.status(413).json({ error: "KYC document must be 10MB or smaller" });

  const filename = randomUUID() + "." + extension;
  const directory = path.resolve(process.env.UPLOADS_DIR ?? "uploads", "kyc");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), buffer);

  const result = await pool!.query(
    "INSERT INTO driver_documents (driver_id, document_type, document_url) VALUES ($1,$2,$3) RETURNING id, document_type, status, created_at",
    [driver.id, documentType, "/api/driver/documents/file/" + filename]
  );
  res.status(201).json({ document: result.rows[0] });
});

app.get("/api/driver/documents/file/:filename", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const filename = path.basename(req.params.filename);
  const documentUrl = "/api/driver/documents/file/" + filename;
  const result = await pool!.query("SELECT driver_id FROM driver_documents WHERE document_url=$1 LIMIT 1", [documentUrl]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Document not found" });

  if ((req as any).user?.role !== "ADMIN") {
    const driver = await driverForUser(identity(req));
    if (!driver || driver.id !== row.driver_id) return res.status(403).json({ error: "Not authorized to view this document" });
  }

  const filePath = path.resolve(process.env.UPLOADS_DIR ?? "uploads", "kyc", filename);
  try { await access(filePath); } catch { return res.status(404).json({ error: "Document file not found" }); }
  return res.sendFile(filePath);
});

app.post("/api/driver/documents", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const userId = identity(req);
  const driver = await driverForUser(userId);
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  const documentType = String(req.body?.documentType ?? "").trim();
  const documentUrl = String(req.body?.documentUrl ?? "").trim();
  if (!documentType || !documentUrl) return res.status(400).json({ error: "Document type and document URL are required" });
  const result = await pool!.query(
    "INSERT INTO driver_documents (driver_id, document_type, document_url) VALUES ($1,$2,$3) RETURNING id, document_type, status, created_at",
    [driver.id, documentType, documentUrl]
  );
  res.status(201).json({ document: result.rows[0] });
});

app.get("/api/driver/documents", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  const result = await pool!.query(
    "SELECT id, document_type, document_url, status, review_note, created_at, updated_at FROM driver_documents WHERE driver_id=$1 ORDER BY created_at DESC",
    [driver.id]
  );
  res.json({ documents: result.rows });
});

app.get("/api/admin/drivers/:driverId/documents", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    "SELECT id, document_type, document_url, status, review_note, created_at, updated_at FROM driver_documents WHERE driver_id=$1 ORDER BY created_at DESC",
    [req.params.driverId]
  );
  res.json({ documents: result.rows });
});

app.post("/api/admin/driver-documents/:documentId/review", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const status = String(req.body?.status ?? "");
  const note = String(req.body?.note ?? "").trim();
  if (status !== "APPROVED" && status !== "REJECTED") return res.status(400).json({ error: "Status must be APPROVED or REJECTED" });
  const result = await pool!.query(
    "UPDATE driver_documents SET status=$2, review_note=$3, updated_at=now() WHERE id=$1 RETURNING id, driver_id, document_type, status, review_note, updated_at",
    [req.params.documentId, status, note || null]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Document not found" });
  res.json({ document: result.rows[0] });
});

app.get("/api/admin/drivers", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    "SELECT d.id, d.user_id, d.status, d.online, d.vehicle_type, d.vehicle_registration, u.full_name, u.phone, u.email, d.created_at FROM drivers d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 200"
  );
  res.json({ drivers: result.rows });
});

app.post("/api/admin/drivers/:driverId/approve", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const documents = await pool!.query(
    "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='APPROVED')::int AS approved FROM driver_documents WHERE driver_id=$1",
    [req.params.driverId]
  );
  const documentSummary = documents.rows[0];
  if (!documentSummary || documentSummary.total < 1 || documentSummary.approved < 1) {
    return res.status(409).json({ error: "At least one approved KYC document is required before driver approval" });
  }
  const result = await pool!.query(
    "UPDATE drivers SET status='APPROVED' WHERE id=$1 AND status='PENDING' RETURNING id, user_id, status",
    [req.params.driverId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Pending driver not found" });
  res.json({ driver: result.rows[0] });
});

app.post("/api/admin/drivers/:driverId/suspend", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    "UPDATE drivers SET status='SUSPENDED', online=false WHERE id=$1 AND status <> 'SUSPENDED' RETURNING id, user_id, status",
    [req.params.driverId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Driver not found" });
  res.json({ driver: result.rows[0] });
});

app.get("/api/admin/operations", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    "SELECT (SELECT count(*) FROM users WHERE role='CUSTOMER')::int AS customers, (SELECT count(*) FROM drivers)::int AS drivers, (SELECT count(*) FROM drivers WHERE status='APPROVED' AND online=true)::int AS online_drivers, (SELECT count(*) FROM deliveries)::int AS deliveries, (SELECT count(*) FROM deliveries WHERE status NOT IN ('DELIVERED','CANCELLED','DISPUTED'))::int AS active_deliveries, (SELECT count(*) FROM disputes WHERE status IN ('OPEN','UNDER_REVIEW'))::int AS open_disputes, (SELECT count(*) FROM payouts WHERE status IN ('ELIGIBLE','PROCESSING'))::int AS pending_payouts"
  );
  res.json({ metrics: result.rows[0] });
});

app.get("/api/admin/deliveries", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
  const params: unknown[] = [];
  const whereClause = status ? "WHERE d.status=$1" : "";
  if (status) params.push(status);
  params.push(limit);
  const result = await pool!.query(
    "SELECT d.id, d.tracking_code, d.sender_id, d.driver_id, d.receiver_name, d.status, d.quote_total_minor, d.quote_currency, d.created_at, d.updated_at, " +
      "(SELECT json_build_object('latitude', le.latitude, 'longitude', le.longitude, 'accuracyMeters', le.accuracy_meters, 'recordedAt', le.recorded_at) FROM location_events le WHERE le.delivery_id=d.id ORDER BY le.recorded_at DESC LIMIT 1) AS latest_location FROM deliveries d " + whereClause + " ORDER BY d.updated_at DESC LIMIT $" + params.length,
    params
  );
  res.json({ deliveries: result.rows });
});

app.get("/api/admin/disputes", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query("SELECT id, delivery_id, opened_by, reason, description, status, resolution_note, created_at, updated_at FROM disputes ORDER BY updated_at DESC LIMIT 100");
  res.json({ disputes: result.rows });
});

app.get("/api/admin/payouts", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query("SELECT id, delivery_id, driver_id, amount_minor, currency, status, provider, provider_reference, created_at, updated_at FROM payouts ORDER BY updated_at DESC LIMIT 100");
  res.json({ payouts: result.rows });
});

app.post("/api/admin/deliveries/:id/dispute/resolve", requireAuth("ADMIN"), async (req, res) => {
  const status = String(req.body?.resolution ?? "");
  if (status !== "RESOLVED_REFUND" && status !== "RESOLVED_RELEASE") {
    return res.status(400).json({ error: "Resolution must be RESOLVED_REFUND or RESOLVED_RELEASE" });
  }
  const note = String(req.body?.note ?? "").trim();
  if (!note) return res.status(400).json({ error: "Resolution note is required" });
  const dispute = await resolveDispute(req.params.id, status, note);
  if (!dispute) return res.status(404).json({ error: "Open dispute not found" });
  if (databaseEnabled()) {
    const payment = await findPayment(req.params.id);
    if (payment && ["HELD", "AUTHORIZED"].includes(payment.status)) {
      await updatePaymentStatus(req.params.id, status === "RESOLVED_REFUND" ? "REFUNDED" : "RELEASED");
    }
  }
  await recordDeliveryEvent({
    deliveryId: req.params.id,
    eventType: "DISPUTE_RESOLVED",
    actorUserId: identity(req),
    metadata: { resolution: status }
  });
  res.json({ dispute });
});

app.get("/api/deliveries/:id/payout", requireAuth("DRIVER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const role = (req as typeof req & { user?: { role: "DRIVER" | "ADMIN" } }).user!.role;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(req.params.id, userId, role)
    : await getOne(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const payout = await findPayout(req.params.id);
  if (!payout) return res.status(404).json({ error: "Payout has not been created" });
  res.json({ payout });
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
  const code = String(req.body?.trackingCode ?? "").trim().toUpperCase();
  const receiverPhone = String(req.body?.receiverPhone ?? "").trim();
  if (!code || !receiverPhone) return res.status(400).json({ error: "trackingCode and receiverPhone are required" });
  const delivery = databaseEnabled()
    ? await findByTrackingCode(code)
    : [...deliveries.values()].find(d => d.trackingCode === code) ?? null;
  if (!delivery) return res.status(404).json({ error: "Tracking details not found" });
  if (delivery.receiverPhone !== receiverPhone) return res.status(403).json({ error: "Tracking details could not be verified" });
  res.json({ deliveryId: delivery.id, trackingToken: issueTrackingToken(delivery.id) });
});

app.get("/api/track/:trackingCode", async (req, res) => {
  const code = String(req.params.trackingCode ?? "").trim().toUpperCase();
  const receiverPhone = String(req.query.receiverPhone ?? "").trim();
  if (!receiverPhone) return res.status(400).json({ error: "receiverPhone is required" });
  const delivery = databaseEnabled()
    ? await findByTrackingCode(code)
    : [...deliveries.values()].find(d => d.trackingCode === code) ?? null;
  if (!delivery) return res.status(404).json({ error: "Tracking details not found" });
  if (delivery.receiverPhone !== receiverPhone) return res.status(403).json({ error: "Tracking details could not be verified" });
  const latestLocation = databaseEnabled() ? await latestPersistentLocation(delivery.id) : getLatestLocation(delivery.id);
  // Public tracking intentionally omits internal driver identity and other account data.
  res.json({
    id: delivery.id,
    trackingCode: delivery.trackingCode,
    status: delivery.status,
    pickup: delivery.pickup,
    dropoff: delivery.dropoff,
    pickupPhotoUrl: delivery.pickupPhotoUrl,
    latestLocation,
    updatedAt: delivery.updatedAt
  });
});

async function authenticatedDriverId(req: express.Request): Promise<string | null> {
  const userId = identity(req as express.Request & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } });
  if (!databaseEnabled()) return userId;
  const driver = await driverForUser(userId);
  return driver?.id ?? null;
}

app.post("/api/driver/availability", requireAuth("DRIVER"), async (req, res) => {
  try {
    const driverId = await authenticatedDriverId(req);
    if (!driverId) return res.status(403).json({ error: "Driver profile is not approved or found" });
    const online = Boolean(req.body?.online);
    if (!databaseEnabled()) return res.status(503).json({ error: "Driver availability requires the production database" });
    const updated = await setDriverOnline(driverId, online);
    if (!updated) return res.status(403).json({ error: "Driver is not approved" });
    return res.json({ online });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unable to update availability" });
  }
});

app.post("/api/driver/auto-assign", requireAuth("DRIVER"), async (req, res) => {
  try {
    const driverId = await authenticatedDriverId(req);
    if (!driverId) return res.status(403).json({ error: "Driver profile is not approved or found" });
    if (!databaseEnabled()) return res.status(503).json({ error: "Driver assignment requires the production database" });
    const delivery = await assignNextDeliveryToDriver(driverId);
    if (!delivery) return res.status(204).end();
    await recordDeliveryEvent({
      deliveryId: delivery.id,
      eventType: "DRIVER_ASSIGNED",
      metadata: { driverId, assignment: "automatic" }
    });
    publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
    return res.json({ delivery: safeDelivery(delivery) });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unable to assign delivery" });
  }
});

app.get("/api/driver/me", requireAuth("DRIVER"), async (req, res) => {
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  res.json({ driver });
});

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
    await notificationForDelivery(updated.id, updated.senderId, "Driver assigned", "A driver has accepted your SwiftDrop delivery.", "DRIVER_ASSIGNED");
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
    await notificationForDelivery(updated.id, updated.senderId, "Driver has arrived", "Your SwiftDrop driver is at the pickup location.", "DRIVER_AT_PICKUP");
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
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  const photo = String(req.body?.pickupPhotoUrl ?? "");
  if (!photo) return res.status(400).json({ error: "Pickup parcel photo is required" });
  if (databaseEnabled()) {
    const updated = await savePickupPhoto(req.params.id, driverId, photo);
    if (!updated) return res.status(409).json({ error: "Driver must be assigned and at pickup before confirming pickup" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "PICKED_UP", actorUserId: identity(req), metadata: { pickupPhotoUrl: photo } });
    await notificationForDelivery(updated.id, updated.senderId, "Parcel picked up", "Your parcel has been picked up and the pickup photo is available.", "PICKED_UP");
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
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "PICKED_UP", "IN_TRANSIT", driverId);
    if (!updated) return res.status(409).json({ error: "Parcel must be picked up first or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "IN_TRANSIT", actorUserId: identity(req), metadata: {} });
    await notificationForDelivery(updated.id, updated.senderId, "Parcel is moving", "Your parcel is now in transit. Live tracking is active.", "IN_TRANSIT");
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
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  const event = {
    deliveryId: delivery.id, driverId,
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
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  if (databaseEnabled()) {
    const updated = await transitionDelivery(req.params.id, "IN_TRANSIT", "ARRIVED", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not in transit or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "ARRIVED", actorUserId: identity(req), metadata: {} });
    await notificationForDelivery(updated.id, updated.senderId, "Driver has arrived", "Your driver has arrived at the delivery location.", "ARRIVED");
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
  const driverId = await authenticatedDriverId(req);
  const pin = String(req.body?.receiverPin ?? "");
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  if (databaseEnabled()) {
    const current = await findDelivery(req.params.id);
    if (!current || current.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
    if (!["IN_TRANSIT", "ARRIVED"].includes(current.status)) return res.status(409).json({ error: "Delivery is not ready for completion" });
    if (!await verifyReceiverPin(req.params.id, pin)) return res.status(401).json({ error: "Invalid receiver PIN" });
    const updated = await completeDelivery(req.params.id, driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not ready or driver is not assigned" });
    const payment = await findPayment(updated.id);
    const payoutPercent = Math.min(100, Math.max(0, Number(process.env.DRIVER_PAYOUT_PERCENT ?? 90)));
    const payoutAmount = payment?.amountMinor ? Math.max(0, Math.floor(payment.amountMinor * payoutPercent / 100)) : 0;
    if (payoutAmount > 0) {
      await createEligiblePayout(updated.id, driverId, payoutAmount);
      await recordDeliveryEvent({
        deliveryId: updated.id,
        eventType: "PAYOUT_ELIGIBLE",
        actorUserId: identity(req),
        metadata: { amountMinor: payoutAmount, currency: payment?.currency ?? "NGN" }
      });
    }
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "DELIVERED", actorUserId: identity(req), metadata: { receiverPinVerified: true } });
    await notificationForDelivery(updated.id, updated.senderId, "Delivery completed", "Your parcel was delivered successfully using the receiver PIN.", "DELIVERED");
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

async function startServer() {
  if (databaseEnabled()) await runMigrations();
  httpServer.listen(port, () => console.log(`SwiftDrop API listening on port ${port}`));
}

startServer().catch(error => {
  console.error("SwiftDrop API startup failed:", error);
  process.exit(1);
});
