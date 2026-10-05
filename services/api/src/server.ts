import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { attachRealtime, publishDeliveryLocation, publishDeliveryUpdate, issueTrackingToken } from "./realtime.js";
import { getLatestLocation, recordLocation } from "./trackingStore.js";
import { validateLocationEvent } from "./tracking.js";
import { databaseEnabled, createPersistentDelivery, findDelivery, findDeliveryForUser, findByTrackingCode, listOpenJobs, transitionDelivery, savePickupPhoto, verifyReceiverPin, completeDelivery, recordPersistentLocation, latestPersistentLocation, driverForUser, recordDeliveryEvent, listDeliveryEvents, listDeliveryProofs, saveDeliveryProof, hasRequiredDropoffProofs, findPayment, createPayment, updatePaymentStatus, markPaymentRefund, confirmReceiverAndReleaseEscrow, confirmReceiverOnDeliveryPaymentDue, settleReceiverPaymentAndReleasePayout, reservePaymentInitialization, savePaymentCheckoutSession, findPayoutByProviderReference, claimPaystackWebhookEvent, retryFailedPayout, flagPayoutReconciliationMismatch } from "./database/deliveryRepository.js";
import { pool, pingDatabase } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { assignNextDeliveryToDriver, setDriverOnline, createEligiblePayout, findPayout, cancelEligiblePayoutForRefund, createDispute, createReceiverDispute, findDispute, resolveDispute, createSupportTicket, listSupportTickets, resolveSupportTicket, getDriverPayoutAccount, saveDriverPayoutAccount, setPayoutProcessing, setPayoutProviderReference, markPayoutFailed, markPayoutReleased, updatePayoutProviderStatus, recordAdminCaseAudit, listAdminCaseAudit, markDisputeUnderReview, listSupportTicketMessages, recordAdminSupportReply, prepareRefund, releaseDisputeAndCreatePayout } from "./database/deliveryRepository.js";
import { requireAuth } from "./authMiddleware.js";
import authRoutes from "./authRoutes.js";
import { identity } from "./requestIdentity.js";
import { validateProductionConfig } from "./productionConfig.js";
import { getPrivateObject, objectStorageEnabled, putPrivateObject } from "./storage.js";
import { enqueueNotification, processNotificationOutbox, processNotificationPushReceipts } from "./notificationOutbox.js";
import businessAiRoutes from "./businessAiRoutes.js";
import agentRoutes from "./agentRoutes.js";
import marketplaceRoutes from "./marketplaceRoutes.js";
import { processSupportAiBatch } from "./supportAiAgent.js";
import recurringDispatchRoutes from "./recurringDispatchRoutes.js";
import deliveryExceptionRoutes from "./deliveryExceptionRoutes.js";
import errandRoutes from "./errandRoutes.js";
import { processRecurringDispatches } from "./recurringDispatchWorker.js";
import { getActivePricingConfig } from "./pricing.js";
import { reconcileProcessingBuyOrderSettlements } from "./buyOrderSettlementWorker.js";
import { reconcileProcessingDropOffCommissions } from "./dropOffCommissionWorker.js";
import { reconcileCancelledMarketplacePayments } from "./marketplacePaymentWorker.js";
import { reconcilePendingBuyOrderPayments } from "./buyOrderPaymentWorker.js";

const app = express();

function routeParam(value: string | string[] | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Missing or invalid route parameter: ${name}`);
}

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
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  }
}));

app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.log(JSON.stringify({
      event: "http_request",
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100
    }));
  });
  next();
});
app.use("/api/auth", authRoutes);
app.use("/api", businessAiRoutes);
app.use("/api", agentRoutes);
app.use("/api", marketplaceRoutes);
app.use("/api", recurringDispatchRoutes);
app.use("/api", deliveryExceptionRoutes);
app.use("/api", errandRoutes);

type Status = "CREATED" | "PAYMENT_AUTHORIZED" | "DRIVER_ASSIGNED" | "DRIVER_AT_PICKUP" | "PICKED_UP" | "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "CANCELLED" | "DISPUTED" | "RETURNED";
type DeliveryLocation = { latitude: number; longitude: number; recordedAt?: string };
type DeliveryQuote = {
  currency: "NGN";
  distanceMeters: number;
  durationSeconds: number;
  baseFareMinor: number;
  distanceFareMinor: number;
  weightFareMinor: number;
  sizeFareMinor: number;
  perishableSurchargeMinor: number;
  fuelReferenceMinor: number;
  protectionReserveMinor: number;
  pricingVersion: number;
  serviceFeeMinor: number;
  totalMinor: number;
};
type MemoryDelivery = {
  id: string; trackingCode: string; senderId: string; receiverName: string; receiverPhone: string;
  pickup: { label: string; formattedAddress: string; location: DeliveryLocation };
  dropoff: { label: string; formattedAddress: string; location: DeliveryLocation };
  status: Status; paymentMode: "SENDER_ESCROW" | "RECEIVER_ON_DELIVERY"; driverId?: string; pickupPhotoUrl?: string; proofRequirements?: { pickup: string[]; dropoff: string[] }; receiverPin: string;
  quote?: DeliveryQuote; createdAt: string; updatedAt: string;
};
const deliveries = new Map<string, MemoryDelivery>();
const locationRateLimit = new Map<string, number>();
const LOCATION_MIN_INTERVAL_MS = 3000;
const receiverPinAttempts = new Map<string, { windowStartedAt: number; count: number; blockedUntil: number }>();
const RECEIVER_PIN_WINDOW_MS = 5 * 60 * 1000;
const RECEIVER_PIN_MAX_ATTEMPTS = 5;
const RECEIVER_PIN_BLOCK_MS = 15 * 60 * 1000;

function checkReceiverPinRate(key: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const current = receiverPinAttempts.get(key);
  if (!current || now - current.windowStartedAt >= RECEIVER_PIN_WINDOW_MS) {
    receiverPinAttempts.set(key, { windowStartedAt: now, count: 0, blockedUntil: 0 });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (current.blockedUntil > now) return { allowed: false, retryAfterMs: current.blockedUntil - now };
  return { allowed: true, retryAfterMs: 0 };
}

function recordReceiverPinFailure(key: string): void {
  const now = Date.now();
  const current = receiverPinAttempts.get(key) ?? { windowStartedAt: now, count: 0, blockedUntil: 0 };
  current.count += 1;
  if (current.count >= RECEIVER_PIN_MAX_ATTEMPTS) current.blockedUntil = now + RECEIVER_PIN_BLOCK_MS;
  receiverPinAttempts.set(key, current);
}

function clearReceiverPinFailures(key: string): void {
  receiverPinAttempts.delete(key);
}
const notificationForDelivery = async (deliveryId: string, userId: string, title: string, body: string, type: string) => {
  if (!databaseEnabled()) return;
  await enqueueNotification({ deliveryId, userId, title, body, type });
};


const createDeliverySchema = z.object({
  senderId: z.string().uuid().optional(), paymentMode: z.enum(["SENDER_ESCROW","RECEIVER_ON_DELIVERY"]).default("SENDER_ESCROW"), receiverName: z.string().min(1), receiverPhone: z.string().min(7),
  receiverPin: z.string().regex(/^\d{6}$/, "Receiver PIN must be exactly 6 digits"),
  weightKg: z.number().positive().max(1000),
  dimensionsCm: z.object({ length: z.number().positive().max(300), width: z.number().positive().max(300), height: z.number().positive().max(300) }),
  isPerishable: z.boolean(),
  declaredValueMinor: z.number().int().positive().max(10000000000),
  pickup: z.object({ label: z.string(), formattedAddress: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  dropoff: z.object({ label: z.string(), formattedAddress: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  pickupDropOffLocationId: z.string().uuid().optional(),
  pickupInstructions: z.string().trim().max(1000).optional(),
  dropoffInstructions: z.string().trim().max(1000).optional(),
  dropoffDropOffLocationId: z.string().uuid().optional(),
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
  isPerishable: z.boolean(),
  declaredValueMinor: z.number().int().positive().max(10000000000)
});

async function calculateQuote(
  pickup: { latitude: number; longitude: number },
  dropoff: { latitude: number; longitude: number },
  parcel: { weightKg: number; dimensionsCm: { length: number; width: number; height: number }; isPerishable: boolean; declaredValueMinor: number }
): Promise<DeliveryQuote> {
  const config = await getActivePricingConfig();
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
  const fuelReferenceMinor = config.fuelPriceMinorPerLitre * 2;
  const baseFareMinor = fuelReferenceMinor;
  const distanceFareMinor = Math.ceil(distanceKm * 18000);
  const weightFareMinor = Math.ceil(Math.max(0, billableWeightKg - 1) * 10000);
  const sizeFareMinor = Math.ceil(Math.max(0, volumeCm3 - 10000) / 1000 * 250);
  const handlingMinor = baseFareMinor + distanceFareMinor + weightFareMinor + sizeFareMinor;
  const perishableSurchargeMinor = parcel.isPerishable ? Math.ceil(handlingMinor * config.perishableSurchargeBps / 10000) : 0;
  const serviceFeeMinor = Math.ceil((handlingMinor + perishableSurchargeMinor) * config.serviceChargeBps / 10000);
  const protectionReserveMinor = Math.ceil(parcel.declaredValueMinor * config.protectionReserveBps / 10000);
  return {
    currency: "NGN",
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.max(60, Math.round((distanceMeters / 8000) * 3600)),
    baseFareMinor,
    distanceFareMinor,
    weightFareMinor,
    sizeFareMinor,
    perishableSurchargeMinor,
    fuelReferenceMinor,
    protectionReserveMinor,
    pricingVersion: config.version,
    serviceFeeMinor,
    totalMinor: handlingMinor + perishableSurchargeMinor + serviceFeeMinor + protectionReserveMinor
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

app.get("/ready", async (_req, res) => {
  if (!databaseEnabled()) {
    return process.env.NODE_ENV === "production"
      ? res.status(503).json({ ready: false, reason: "production database is not configured" })
      : res.json({ ready: true, database: false });
  }
  try {
    const database = await pingDatabase();
    if (!database) return res.status(503).json({ ready: false, reason: "database unavailable" });
    return res.json({ ready: true, database: true });
  } catch {
    return res.status(503).json({ ready: false, reason: "database unavailable" });
  }
});

app.post("/api/deliveries/:id/rating", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Ratings require the production database" });
  const userId = identity(req);
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), userId, "CUSTOMER");
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
    return res.status(201).json({ rating: { id: result.rows[0].id, deliveryId: result.rows[0].delivery_id, stars: Number(result.rows[0].stars), comment: result.rows[0].comment, createdAt: result.rows[0].created_at } });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return res.status(409).json({ error: "This delivery has already been rated" });
    return res.status(500).json({ error: "Unable to save rating" });
  }
});

app.post("/api/deliveries/:id/rating/receiver", async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Receiver ratings require the production database" });
  const receiverPhone = String(req.body?.receiverPhone ?? "").trim();
  const receiverPin = String(req.body?.receiverPin ?? "").trim();
  const parsed = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).safeParse(req.body);
  if (!receiverPhone || !/^\d{6}$/.test(receiverPin) || !parsed.success) return res.status(400).json({ error: "Receiver phone, six-digit PIN, rating and optional comment are required" });
  const delivery = await findByTrackingCode(String(routeParam(req.params.id, "id")).trim().toUpperCase()).catch(() => null) ?? await findDelivery(routeParam(req.params.id, "id"));
  if (!delivery || delivery.status !== "DELIVERED" || delivery.receiverPhone !== receiverPhone || !delivery.driverId) return res.status(403).json({ error: "Receiver details could not be verified" });
  const pinKey = "rating:" + delivery.id + ":" + receiverPhone;
  const pinRate = checkReceiverPinRate(pinKey);
  if (!pinRate.allowed) return res.status(429).json({ error: "Too many PIN attempts. Try again later.", retryAfterMs: pinRate.retryAfterMs });
  const pinValid = await verifyReceiverPin(delivery.id, receiverPin);
  if (!pinValid) {
    recordReceiverPinFailure(pinKey);
    return res.status(403).json({ error: "Receiver details could not be verified" });
  }
  clearReceiverPinFailures(pinKey);
  try {
    const result = await pool!.query(
      `INSERT INTO receiver_ratings (delivery_id, driver_id, receiver_phone, stars, comment)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, delivery_id, driver_id, stars, comment, created_at`,
      [delivery.id, delivery.driverId, receiverPhone, parsed.data.stars, parsed.data.comment?.trim() || null]
    );
    return res.status(201).json({ rating: result.rows[0] });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return res.status(409).json({ error: "This delivery has already been rated by the receiver" });
    return res.status(500).json({ error: "Unable to save receiver rating" });
  }
});

app.get("/api/driver/payout-account", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Payout account requires the production database" });
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  const account = await getDriverPayoutAccount(driver.id);
  return res.json({ account: account ? { bankCode: account.bankCode, bankName: account.bankName, accountName: account.accountName, accountLast4: account.accountLast4, currency: account.currency } : null });
});

app.post("/api/driver/payout-account", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Payout account requires the production database" });
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  const parsed = z.object({
    bankCode: z.string().regex(/^\d{3,6}$/),
    accountNumber: z.string().regex(/^\d{10}$/)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A valid Nigerian bank code and 10-digit account number are required" });
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: "Paystack transfers are not configured" });
  const resolveResponse = await fetch("https://api.paystack.co/bank/resolve?account_number=" + encodeURIComponent(parsed.data.accountNumber) + "&bank_code=" + encodeURIComponent(parsed.data.bankCode), {
    headers: { authorization: "Bearer " + secret }
  });
  const resolved = await resolveResponse.json() as { status?: boolean; message?: string; data?: { account_name?: string } };
  if (!resolveResponse.ok || !resolved.status || !resolved.data?.account_name) return res.status(400).json({ error: resolved.message ?? "Unable to verify the bank account" });
  const recipientResponse = await fetch("https://api.paystack.co/transferrecipient", {
    method: "POST",
    headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({ type: "nuban", name: resolved.data.account_name, account_number: parsed.data.accountNumber, bank_code: parsed.data.bankCode, currency: "NGN" })
  });
  const recipient = await recipientResponse.json() as { status?: boolean; message?: string; data?: { recipient_code?: string } };
  if (!recipientResponse.ok || !recipient.status || !recipient.data?.recipient_code) return res.status(400).json({ error: recipient.message ?? "Unable to create payout recipient" });
  const account = await saveDriverPayoutAccount({
    driverId: driver.id,
    bankCode: parsed.data.bankCode,
    accountNumber: parsed.data.accountNumber,
    accountName: resolved.data.account_name,
    recipientCode: recipient.data.recipient_code
  });
  return res.status(201).json({ account: account ? { bankCode: account.bankCode, bankName: account.bankName, accountName: account.accountName, accountLast4: account.accountLast4, currency: account.currency } : null });
});

app.get("/api/driver/payouts", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Payouts require the production database" });
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  const result = await pool!.query(
    `SELECT id, delivery_id, amount_minor, currency, status, provider,
            provider_status, failure_reason, processed_at, created_at, updated_at
       FROM payouts
      WHERE driver_id=$1
      ORDER BY created_at DESC
      LIMIT 100`,
    [driver.id]
  );
  const summary = result.rows.reduce((acc: { eligibleMinor: number; processingMinor: number; releasedMinor: number; failedMinor: number }, row: { amount_minor: number; status: string }) => {
    const amount = Number(row.amount_minor);
    if (row.status === "ELIGIBLE") acc.eligibleMinor += amount;
    else if (row.status === "PROCESSING") acc.processingMinor += amount;
    else if (row.status === "RELEASED") acc.releasedMinor += amount;
    else if (row.status === "FAILED") acc.failedMinor += amount;
    return acc;
  }, { eligibleMinor: 0, processingMinor: 0, releasedMinor: 0, failedMinor: 0 });
  return res.json({ summary, payouts: result.rows.map((row) => ({ id: row.id, deliveryId: row.delivery_id, driverId: row.driver_id, amountMinor: Number(row.amount_minor), currency: row.currency, status: row.status, provider: row.provider, providerStatus: row.provider_status, failureReason: row.failure_reason, processedAt: row.processed_at, createdAt: row.created_at, updatedAt: row.updated_at })) });
});

app.get("/api/deliveries/:id/payout", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Payouts require the production database" });
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), identity(req), "DRIVER");
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const payout = await findPayout(routeParam(req.params.id, "id"));
  const publicPayout = payout ? {
    id: payout.id,
    deliveryId: payout.deliveryId,
    amountMinor: payout.amountMinor,
    currency: payout.currency,
    status: payout.status,
    providerStatus: payout.providerStatus,
    failureReason: payout.failureReason,
    processedAt: payout.processedAt
  } : null;
  return res.json({ payout: publicPayout });
});

app.post("/api/deliveries/:id/payout/withdraw", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Payouts require the production database" });
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), identity(req), "DRIVER");
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const payout = await findPayout(routeParam(req.params.id, "id"));
  if (!payout || payout.status !== "ELIGIBLE") return res.status(409).json({ error: "Payout is not eligible yet. The receiver must confirm delivery first." });
  const account = await getDriverPayoutAccount(driver.id);
  if (!account) return res.status(409).json({ error: "Add and verify a payout bank account before withdrawing." });
  const processing = await setPayoutProcessing(routeParam(req.params.id, "id"));
  if (!processing) return res.status(409).json({ error: "Payout is already being processed." });
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) { await markPayoutFailed(routeParam(req.params.id, "id")); return res.status(503).json({ error: "Paystack transfers are not configured" }); }
  const reference = "sd_payout_" + randomUUID().replaceAll("-", "");
  const reserved = await setPayoutProviderReference(routeParam(req.params.id, "id"), reference);
  if (!reserved) {
    await markPayoutFailed(routeParam(req.params.id, "id"));
    return res.status(409).json({ error: "Payout could not be reserved for transfer" });
  }
  try {
    const response = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: JSON.stringify({ source: "balance", amount: processing.amountMinor, recipient: account.recipientCode, reference, reason: "SwiftDrop courier payout", currency: processing.currency }),
      signal: AbortSignal.timeout(15_000)
    });
    const data = await response.json() as { status?: boolean; message?: string; data?: { reference?: string; status?: string } };
    if (!response.ok || !data.status || !data.data?.reference) {
      await markPayoutFailed(routeParam(req.params.id, "id"));
      return res.status(502).json({ error: data.message ?? "Paystack transfer could not be initiated" });
    }
    if (data.data.reference && data.data.reference !== reference) {
      await setPayoutProviderReference(routeParam(req.params.id, "id"), data.data.reference);
    }
    const payoutResult = await findPayout(routeParam(req.params.id, "id"));
    const publicPayout = payoutResult ? {
      id: payoutResult.id,
      deliveryId: payoutResult.deliveryId,
      amountMinor: payoutResult.amountMinor,
      currency: payoutResult.currency,
      status: payoutResult.status,
      providerStatus: payoutResult.providerStatus,
      failureReason: payoutResult.failureReason,
      processedAt: payoutResult.processedAt
    } : null;
    return res.status(202).json({
      payout: publicPayout,
      providerStatus: data.data.status ?? "pending",
      message: "Transfer initiated. Final payout status will be updated from Paystack's transfer webhook or reconciliation worker."
    });
  } catch (error) {
    // A timeout/network error is inconclusive: Paystack may have accepted the transfer.
    // Keep PROCESSING and let the reconciliation worker verify the unique reference.
    console.error(JSON.stringify({
      event: "paystack_payout_initiation_inconclusive",
      deliveryId: routeParam(req.params.id, "id"),
      payoutId: processing.id,
      providerReference: reference,
      error: error instanceof Error ? error.message : "unknown"
    }));
    const payoutResult = await findPayout(routeParam(req.params.id, "id"));
    const publicPayout = payoutResult ? {
      id: payoutResult.id,
      deliveryId: payoutResult.deliveryId,
      amountMinor: payoutResult.amountMinor,
      currency: payoutResult.currency,
      status: payoutResult.status,
      providerStatus: payoutResult.providerStatus,
      failureReason: payoutResult.failureReason,
      processedAt: payoutResult.processedAt
    } : null;
    return res.status(202).json({
      payout: publicPayout,
      providerStatus: "pending",
      message: "Transfer status is being reconciled with Paystack."
    });
  }
});

app.get("/api/drivers/:driverId/ratings", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Ratings require the production database" });
  const result = await pool!.query(
    `SELECT stars, comment, created_at FROM ratings WHERE rated_user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [routeParam(req.params.driverId, "driverId")]
  );
  const average = result.rows.length
    ? result.rows.reduce((sum: number, row: { stars: number }) => sum + Number(row.stars), 0) / result.rows.length
    : null;
  res.json({ average, count: result.rows.length, ratings: result.rows.map((row) => ({ stars: Number(row.stars), comment: row.comment, createdAt: row.created_at })) });
});

app.post("/api/deliveries/:id/rating/driver", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Ratings require the production database" });
  const userId = identity(req);
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), userId, "DRIVER");
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
  res.json({ notifications: result.rows.map((row) => ({ id: row.id, deliveryId: row.delivery_id, title: row.title, body: row.body, type: row.type, readAt: row.read_at, createdAt: row.created_at })) });
});

app.post("/api/notifications/:id/read", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Notifications require the production database" });
  const result = await pool!.query(
    "UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id, read_at",
    [routeParam(req.params.id, "id"), identity(req)]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Notification not found" });
  res.json({ notification: { id: result.rows[0].id, readAt: result.rows[0].read_at } });
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
  try { res.json(await calculateQuote(parsed.data.pickup, parsed.data.dropoff, { weightKg: parsed.data.weightKg, dimensionsCm: parsed.data.dimensionsCm, isPerishable: parsed.data.isPerishable, declaredValueMinor: parsed.data.declaredValueMinor })); } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : "Pricing configuration is unavailable" }); }
});

app.post("/api/deliveries", requireAuth("CUSTOMER"), async (req, res) => {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const input = { ...parsed.data, senderId: identity(req) };
  const quote = await calculateQuote(
    { latitude: parsed.data.pickup.latitude, longitude: parsed.data.pickup.longitude },
    { latitude: parsed.data.dropoff.latitude, longitude: parsed.data.dropoff.longitude },
    { weightKg: parsed.data.weightKg, dimensionsCm: parsed.data.dimensionsCm, isPerishable: parsed.data.isPerishable, declaredValueMinor: parsed.data.declaredValueMinor }
  );
  if (quote.currency !== "NGN" || !Number.isSafeInteger(quote.totalMinor) || quote.totalMinor <= 0) {
    return res.status(500).json({ error: "Unable to calculate delivery quote" });
  }
  parsed.data.quote = quote;
  const pin = parsed.data.receiverPin;
  try {
    if (databaseEnabled()) {
      const selectedLocationIds = [input.pickupDropOffLocationId, input.dropoffDropOffLocationId].filter((id): id is string => Boolean(id));
      if (selectedLocationIds.length > 0) {
        const locationResult = await pool!.query(
          "SELECT id,status,verification_status FROM drop_off_locations WHERE id = ANY($1::uuid[])",
          [selectedLocationIds]
        );
        const approvedIds = new Set(locationResult.rows.filter((row: { status: string; verification_status: string }) => row.status === "ACTIVE" && row.verification_status === "VERIFIED").map((row: { id: string }) => row.id));
        if (approvedIds.size !== new Set(selectedLocationIds).size) {
          return res.status(409).json({ error: "One or more selected drop-off locations are not active and verified" });
        }
      }

      const created = await createPersistentDelivery({
        senderId: input.senderId,
        pickupInstructions: input.pickupInstructions,
        dropoffInstructions: input.dropoffInstructions,
        receiverName: input.receiverName,
        receiverPhone: input.receiverPhone,
        pickup: { label: input.pickup.label, formattedAddress: input.pickup.formattedAddress, location: { latitude: input.pickup.latitude, longitude: input.pickup.longitude } },
        dropoff: { label: input.dropoff.label, formattedAddress: input.dropoff.formattedAddress, location: { latitude: input.dropoff.latitude, longitude: input.dropoff.longitude } },
        receiverPin: pin,
        weightKg: input.weightKg,
        dimensionsCm: input.dimensionsCm,
        isPerishable: input.isPerishable,
        declaredValueMinor: input.declaredValueMinor,
        paymentMode: input.paymentMode,
        quote: input.quote
      });
      if (input.paymentMode === "RECEIVER_ON_DELIVERY") {
        await createPayment({ deliveryId: created.id, provider: process.env.PAYMENT_PROVIDER || "paystack", amountMinor: input.quote.totalMinor, currency: "NGN", collectionMode: "RECEIVER_ON_DELIVERY" });
      }
      if (input.pickupDropOffLocationId) await pool!.query("INSERT INTO drop_off_parcels(delivery_id,location_id,endpoint,intake_code) VALUES($1,$2,'PICKUP',encode(gen_random_bytes(5),'hex')) ON CONFLICT(delivery_id,location_id,endpoint) DO NOTHING", [created.id, input.pickupDropOffLocationId]);
      if (input.dropoffDropOffLocationId) await pool!.query("INSERT INTO drop_off_parcels(delivery_id,location_id,endpoint,intake_code) VALUES($1,$2,'DROPOFF',encode(gen_random_bytes(5),'hex')) ON CONFLICT(delivery_id,location_id,endpoint) DO NOTHING", [created.id, input.dropoffDropOffLocationId]);
      return res.status(201).json(safeDelivery(created));
    }
    const now = new Date().toISOString();
    const delivery: MemoryDelivery = {
      id: randomUUID(),
      trackingCode: trackingCode(),
      senderId: input.senderId,
      receiverName: input.receiverName,
      receiverPhone: input.receiverPhone,
      paymentMode: input.paymentMode,
      pickup: { label: input.pickup.label, formattedAddress: input.pickup.formattedAddress, location: { latitude: input.pickup.latitude, longitude: input.pickup.longitude } },
      dropoff: { label: input.dropoff.label, formattedAddress: input.dropoff.formattedAddress, location: { latitude: input.dropoff.latitude, longitude: input.dropoff.longitude } },
      quote,
      status: "CREATED",
      receiverPin: pin,
      createdAt: now,
      updatedAt: now
    };
    deliveries.set(delivery.id, delivery);
    return res.status(201).json(safeDelivery(delivery));
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unable to create delivery" });
  }
});

app.post("/api/deliveries/:id/payment/initialize", requireAuth("CUSTOMER"), async (req, res) => {
  const userId = identity(req);
  const delivery = databaseEnabled() ? await findDeliveryForUser(routeParam(req.params.id, "id"), userId, "CUSTOMER") : await getOne(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.paymentMode === "RECEIVER_ON_DELIVERY") return res.status(409).json({ error: "This order is payable by the receiver on delivery and does not use sender escrow." });
  if (!databaseEnabled()) return res.status(503).json({ error: "Payments require the production database" });

  const email = String(req.body?.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "Email is required" });
  const amountMinor = delivery.quote?.totalMinor;
  if (!amountMinor || !Number.isSafeInteger(amountMinor)) {
    return res.status(409).json({ error: "Delivery does not have a valid server quote" });
  }
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const provider = process.env.PAYMENT_PROVIDER || "paystack";
  if (provider !== "paystack" || !secret) {
    return res.status(503).json({ error: "Paystack payment configuration is not ready" });
  }

  const reference = "SD-" + delivery.trackingCode + "-" + Date.now();
  const reservation = await reservePaymentInitialization(delivery.id, reference);
  if (!reservation.reserved) {
    if (reservation.payment?.authorizationUrl) return res.status(200).json({ paymentId: reservation.payment.id, authorizationUrl: reservation.payment.authorizationUrl, accessCode: reservation.payment.accessCode, amountMinor: reservation.payment.amountMinor });
    return res.status(409).json({ error: "Payment initialization is already in progress. Retry shortly." });
  }
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

  const saved = await savePaymentCheckoutSession(delivery.id, payload.data.reference ?? reference, payload.data.authorization_url, payload.data.access_code);
  if (!saved) return res.status(409).json({ error: "Payment checkout could not be saved. Retry shortly." });
  await recordDeliveryEvent({
    deliveryId: delivery.id,
    eventType: "PAYMENT_INITIALIZED",
    actorUserId: userId,
    metadata: { paymentId: saved.id, reference: payload.data.reference ?? reference, amountMinor }
  });
  res.status(201).json({
    paymentId: saved.id,
    reference: payload.data.reference ?? reference,
    authorizationUrl: payload.data.authorization_url,
    accessCode: payload.data.access_code
  });
});

app.post("/api/deliveries/:id/payment", requireAuth("CUSTOMER"), async (req, res) => {
  const userId = identity(req);
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(routeParam(req.params.id, "id"), userId, "CUSTOMER")
    : await getOne(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.paymentMode === "RECEIVER_ON_DELIVERY") return res.status(409).json({ error: "Receiver payment is collected after receiver confirmation." });

  const amountMinor = delivery.quote?.totalMinor;
  if (!amountMinor || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return res.status(409).json({ error: "Delivery does not have a valid server quote" });
  }

  if (!databaseEnabled()) {
    return res.status(503).json({ error: "Payments require the production database and payment provider" });
  }

  const payment = await createPayment({
    deliveryId: delivery.id,
    provider: process.env.PAYMENT_PROVIDER || "pending",
    amountMinor,
    currency: "NGN",
    collectionMode: "SENDER_ESCROW"
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
  const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? process.env.PAYSTACK_SECRET_KEY;
  const signature = req.header("x-paystack-signature");
  if (!secret || !signature) return res.status(401).end();

  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) return res.status(400).json({ error: "Webhook body could not be verified" });

  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  const supplied = signature.trim().toLowerCase();
  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return res.status(401).end();
  }

  const event = req.body as any;
  const webhookHash = createHash("sha256").update(rawBody).digest("hex");
  const webhookReference = String(event?.data?.reference ?? "");
  let duplicateWebhook = false;
  if (databaseEnabled()) {
    duplicateWebhook = !(await claimPaystackWebhookEvent({
      payloadHash: webhookHash,
      eventType: String(event?.event ?? ""),
      providerReference: webhookReference || null
    }));
  }
  if (duplicateWebhook) return res.status(200).json({ received: true, duplicate: true });

  if (typeof event?.event === "string" && event.event.startsWith("refund.")) {
    const transactionReference = String(event?.data?.transaction_reference ?? event?.data?.transaction?.reference ?? "");
    if(transactionReference&&databaseEnabled()){
      const buyPayment=(await pool!.query("SELECT bop.*,bo.customer_user_id FROM buy_order_payments bop JOIN buy_orders bo ON bo.id=bop.buy_order_id WHERE bop.provider_reference=$1",[transactionReference])).rows[0];
      if(buyPayment){
        const refundStatus=String(event.event).replace("refund.","");
        const refundReference=String(event?.data?.refund_reference??event?.data?.id??"");
        const amountMinor=Number(event?.data?.amount??0);
        if(!Number.isSafeInteger(amountMinor)||amountMinor<0){
          return res.status(200).json({received:true});
        }
        if(refundStatus==="processed"){
          if (!refundReference) {
            return res.status(200).json({ received: true, reconciliationRequired: true });
          }
          const paymentUpdate = await pool!.query(
            `UPDATE buy_order_payments
                SET refund_status='PROCESSED',
                    refund_reference=$2,
                    refund_amount_minor=$3,
                    total_refunded_minor=CASE
                      WHEN refund_status='PROCESSED' AND refund_reference=$2 THEN total_refunded_minor
                      ELSE LEAST(amount_minor,total_refunded_minor+$3)
                    END,
                    status=CASE
                      WHEN (
                        CASE
                          WHEN refund_status='PROCESSED' AND refund_reference=$2 THEN total_refunded_minor
                          ELSE LEAST(amount_minor,total_refunded_minor+$3)
                        END
                      )>=amount_minor THEN 'REFUNDED' ELSE status
                    END,
                    updated_at=now()
              WHERE id=$1
              RETURNING buy_order_id,total_refunded_minor,amount_minor`,
            [buyPayment.id,refundReference,amountMinor]
          );
          const updatedPayment=paymentUpdate.rows[0];
          if (updatedPayment) {
            await pool!.query(
              `UPDATE buy_orders
                  SET refunded_minor=$2,
                      payment_status=CASE WHEN $2>=COALESCE($3,0) THEN 'REFUNDED' ELSE payment_status END,
                      updated_at=now()
                WHERE id=$1`,
              [updatedPayment.buy_order_id,Number(updatedPayment.total_refunded_minor),Number(updatedPayment.amount_minor)]
            );
          }
        }else if(refundStatus==="failed"){
          await pool!.query("UPDATE buy_order_payments SET refund_status='FAILED',updated_at=now() WHERE id=$1",[buyPayment.id]);
        }else{
          await pool!.query("UPDATE buy_order_payments SET refund_status=$2,updated_at=now() WHERE id=$1",[buyPayment.id,refundStatus.toUpperCase()]);
        }
        if (refundReference) {
          await pool!.query(
            `UPDATE buy_order_item_refunds
                SET status=$2,
                    failure_reason=CASE WHEN $2='FAILED' THEN COALESCE(failure_reason,'Paystack reported refund failure') ELSE NULL END,
                    updated_at=now()
              WHERE provider_ref=$1`,
            [refundReference, refundStatus === "processed" ? "PROCESSED" : refundStatus === "failed" ? "FAILED" : refundStatus.toUpperCase()]
          );
        }
        await pool!.query("INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,$3,$4::jsonb)",[buyPayment.buy_order_id,buyPayment.customer_user_id,"REFUND_"+refundStatus.toUpperCase(),JSON.stringify({transactionReference,refundReference,amountMinor})]);
        return res.status(200).json({received:true});
      }
    }
    if (transactionReference && databaseEnabled()) {
      const marketplacePayment=(await pool!.query(
        "SELECT mop.id,mop.marketplace_order_id,mop.buyer_user_id,mop.amount_minor,mop.total_refunded_minor,mo.delivery_id FROM marketplace_order_payments mop JOIN marketplace_orders mo ON mo.id=mop.marketplace_order_id WHERE mop.provider_reference=$1",
        [transactionReference]
      )).rows[0];
      if (marketplacePayment) {
        const refundStatus=String(event.event).replace("refund.","");
        const refundReference=String(event?.data?.refund_reference??event?.data?.id??"");
        const amountMinor=Number(event?.data?.amount??0);
        if(!Number.isSafeInteger(amountMinor)||amountMinor<0) return res.status(200).json({received:true});
        if(refundStatus==="processed"){
          if (!refundReference) return res.status(200).json({received:true,reconciliationRequired:true});
          const paymentUpdate=await pool!.query(
            `UPDATE marketplace_order_payments
                SET refund_status='PROCESSED',
                    refund_reference=$2,
                    refund_amount_minor=$3,
                    total_refunded_minor=CASE
                      WHEN refund_status='PROCESSED' AND refund_reference=$2 THEN total_refunded_minor
                      ELSE LEAST(amount_minor,total_refunded_minor+$3)
                    END,
                    status=CASE
                      WHEN (
                        CASE
                          WHEN refund_status='PROCESSED' AND refund_reference=$2 THEN total_refunded_minor
                          ELSE LEAST(amount_minor,total_refunded_minor+$3)
                        END
                      )>=amount_minor THEN 'REFUNDED' ELSE status
                    END,
                    refund_updated_at=now(),updated_at=now()
              WHERE id=$1
              RETURNING total_refunded_minor,amount_minor`,
            [marketplacePayment.id,refundReference,amountMinor]
          );
          const updatedPayment=paymentUpdate.rows[0];
          if(updatedPayment && Number(updatedPayment.total_refunded_minor)>=Number(updatedPayment.amount_minor)){
            await pool!.query(
              "UPDATE marketplace_orders SET status='CANCELLED',fulfillment_status='CANCELLED',updated_at=now() WHERE id=$1 AND status='DISPUTED'",
              [marketplacePayment.marketplace_order_id]
            );
          }
        }else if(refundStatus==="failed"){
          await pool!.query("UPDATE marketplace_order_payments SET refund_status='FAILED',refund_updated_at=now(),updated_at=now() WHERE id=$1",[marketplacePayment.id]);
        }else{
          await pool!.query("UPDATE marketplace_order_payments SET refund_status=$2,refund_updated_at=now(),updated_at=now() WHERE id=$1",[marketplacePayment.id,refundStatus.toUpperCase()]);
        }
        if(marketplacePayment.delivery_id){
          await recordDeliveryEvent({deliveryId:marketplacePayment.delivery_id,eventType:"MARKETPLACE_REFUND_"+refundStatus.toUpperCase(),metadata:{transactionReference,refundReference,amountMinor}});
        }
        return res.status(200).json({received:true});
      }
    }
    const refundReference = String(event?.data?.refund_reference ?? event?.data?.id ?? "");
    if (transactionReference && databaseEnabled()) {
      const result = await pool!.query("SELECT delivery_id FROM payments WHERE provider_reference=$1", [transactionReference]);
      const deliveryId = result.rows[0]?.delivery_id as string | undefined;
      if (deliveryId) {
        const refundStatus = String(event.event).replace("refund.", "");
        const amountMinor = Number(event?.data?.amount ?? 0);
        await markPaymentRefund(deliveryId, refundReference, refundStatus, amountMinor);
        if (refundStatus === "processed") {
          const payment = await findPayment(deliveryId);
          const totalRefundedMinor = payment?.totalRefundedMinor ?? 0;
          const fullyRefunded = Boolean(payment && totalRefundedMinor >= payment.amountMinor);
          if (fullyRefunded) {
            await updatePaymentStatus(deliveryId, "REFUNDED", transactionReference);
          }
          await recordDeliveryEvent({
            deliveryId,
            eventType: "REFUND_PROCESSED",
            metadata: { provider: "paystack", transactionReference, refundReference, amountMinor, totalRefundedMinor, fullyRefunded }
          });
        } else if (refundStatus === "failed") {
          await recordDeliveryEvent({ deliveryId, eventType: "REFUND_FAILED", metadata: { provider: "paystack", transactionReference, refundReference } });
        } else {
          await recordDeliveryEvent({ deliveryId, eventType: "REFUND_" + refundStatus.toUpperCase(), metadata: { provider: "paystack", transactionReference, refundReference } });
        }
      }
    }
    return res.status(200).json({ received: true });
  }

  if (event?.event === "transfer.success" || event?.event === "transfer.failed" || event?.event === "transfer.reversed") {
    const reference = String(event?.data?.reference ?? "");
    if (reference && databaseEnabled()) {
      const failureReason = event?.data?.failures?.message ?? event?.data?.failures?.reason ?? null;
      const providerAmount = Number(event?.data?.amount);
      const providerCurrency = String(event?.data?.currency ?? "");
      if (!Number.isSafeInteger(providerAmount) || providerAmount < 0) return res.status(200).json({ received: true });
      const buySettlement=(await pool!.query("SELECT id,buy_order_id,amount_minor,currency,status FROM buy_order_settlements WHERE transfer_reference=$1 FOR UPDATE",[reference])).rows[0];
      if(buySettlement){
        const next=event.event==="transfer.success"?"PAID":event.event==="transfer.failed"?"FAILED":"REVERSED";
        if(event.event==="transfer.success" && (providerAmount!==Number(buySettlement.amount_minor) || providerCurrency!==String(buySettlement.currency))){
          await pool!.query("UPDATE buy_order_settlements SET status='FAILED',provider_status='amount_mismatch',failure_reason='Paystack transfer amount mismatch',updated_at=now() WHERE id=$1",[buySettlement.id]);
        }else{
          await pool!.query("UPDATE buy_order_settlements SET status=$2,provider_status=$3,failure_reason=$4,paid_at=CASE WHEN $2='PAID' THEN now() ELSE paid_at END,updated_at=now() WHERE id=$1",[buySettlement.id,next,String(event.event),failureReason]);
        }
      }
      const commission=(await pool!.query("SELECT id,amount_minor,status FROM drop_off_commission_ledger WHERE provider_reference=$1 FOR UPDATE",[reference])).rows[0];
      if(commission){
        const next=event.event==="transfer.success"?"PAID":event.event==="transfer.failed"?"AVAILABLE":"AVAILABLE";
        if(event.event==="transfer.success" && (providerAmount!==Number(commission.amount_minor) || providerCurrency!=="NGN")){
          await pool!.query("UPDATE drop_off_commission_ledger SET status='AVAILABLE',provider_status='amount_mismatch',updated_at=now() WHERE id=$1",[commission.id]);
        }else{
          await pool!.query("UPDATE drop_off_commission_ledger SET status=$2,provider_status=$3,paid_at=CASE WHEN $2='PAID' THEN now() ELSE paid_at END,updated_at=now() WHERE id=$1",[commission.id,next,String(event.event)]);
        }
      }
      const status = event.event === "transfer.success" ? "RELEASED" : event.event === "transfer.failed" ? "FAILED" : "CANCELLED";
      const payout = await updatePayoutProviderStatus(reference,status,failureReason,Number(event?.data?.amount),String(event?.data?.currency ?? ""));
      if(payout) await recordDeliveryEvent({deliveryId:payout.deliveryId,eventType:"PAYOUT_"+status,metadata:{provider:"paystack",reference}});
    }
    return res.status(200).json({ received: true });
  }

  if (databaseEnabled() && (event?.event === "charge.success" || event?.event === "charge.failed")) {
    const marketplaceReference = String(event?.data?.reference ?? "");
    if (marketplaceReference) {
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        const payment = (await client.query(
          `SELECT mop.*, mo.quantity, mo.status AS order_status
             FROM marketplace_order_payments mop
             JOIN marketplace_orders mo ON mo.id=mop.marketplace_order_id
            WHERE mop.provider_reference=$1
            FOR UPDATE`,
          [marketplaceReference]
        )).rows[0];
        if (payment) {
          const providerAmount = Number(event?.data?.amount);
          const providerCurrency = String(event?.data?.currency ?? "");
          const amountMatches = Number.isSafeInteger(providerAmount) &&
            providerAmount === Number(payment.amount_minor) &&
            providerCurrency === String(payment.currency).trim();

          if (event.event === "charge.success" && amountMatches) {
            if (payment.order_status === "CANCELLED") {
              // Keep it pending so the durable reconciliation worker can refund
              // the late successful charge without blocking this webhook response.
              await client.query(
                `UPDATE marketplace_order_payments
                    SET provider_status='success_after_cancellation', updated_at=now()
                  WHERE id=$1 AND status='PENDING'`,
                [payment.id]
              );
            } else {
              await client.query(
                `UPDATE marketplace_order_payments
                    SET status='AUTHORIZED', provider_status='success', updated_at=now()
                  WHERE id=$1 AND status='PENDING'`,
                [payment.id]
              );
              await client.query(
                `UPDATE marketplace_orders
                    SET status='PAID', updated_at=now()
                  WHERE id=$1 AND status='PENDING_PAYMENT'`,
                [payment.marketplace_order_id]
              );
            }
          } else if (event.event === "charge.failed" || !amountMatches) {
            await client.query(
              `UPDATE marketplace_order_payments
                  SET status='FAILED',
                      provider_status=$2,
                      updated_at=now()
                WHERE id=$1 AND status='PENDING'`,
              [payment.id, !amountMatches ? "amount_mismatch" : "failed"]
            );
            const restored = await client.query(
              `UPDATE marketplace_listings l
                  SET stock_quantity=l.stock_quantity+$2,
                      status=CASE WHEN l.status='SOLD_OUT' THEN 'PUBLISHED' ELSE l.status END,
                      updated_at=now()
                 FROM marketplace_orders mo
                WHERE mo.id=$1 AND l.id=mo.listing_id AND mo.status='PENDING_PAYMENT'
                RETURNING l.stock_quantity,l.status`,
              [payment.marketplace_order_id, payment.quantity]
            );
            await client.query(
              `UPDATE marketplace_orders
                  SET status='CANCELLED', updated_at=now()
                WHERE id=$1 AND status='PENDING_PAYMENT'`,
              [payment.marketplace_order_id]
            );
            if (!restored.rows[0]) {
              await client.query("ROLLBACK");
              return res.status(500).json({ error: "Marketplace stock reconciliation failed" });
            }
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(JSON.stringify({ event: "marketplace_payment_webhook_failed", reference: marketplaceReference, error: error instanceof Error ? error.message : "unknown" }));
        return res.status(500).json({ error: "Marketplace payment processing failed" });
      } finally {
        client.release();
      }
      return res.status(200).json({ received: true });
    }
  }

  const buyReference = String(event?.data?.reference ?? "");
  if (buyReference && databaseEnabled() && (event?.event === "charge.success" || event?.event === "charge.failed")) {
    const buyPaymentResult = await pool!.query(
      "SELECT bop.*, bo.customer_user_id, bo.business_id, u.email AS customer_email, bo.payment_status AS order_payment_status FROM buy_order_payments bop JOIN buy_orders bo ON bo.id=bop.buy_order_id JOIN users u ON u.id=bo.customer_user_id WHERE bop.provider_reference=$1",
      [buyReference]
    );
    const buyPayment = buyPaymentResult.rows[0];
    if (buyPayment) {
      if (event.event === "charge.failed") {
        await pool!.query("UPDATE buy_order_payments SET status='FAILED', updated_at=now() WHERE id=$1 AND status NOT IN ('HELD','RELEASED','REFUNDED')", [buyPayment.id]);
        await pool!.query("UPDATE buy_orders SET payment_status='FAILED', updated_at=now() WHERE id=$1 AND payment_status NOT IN ('HELD','REFUNDED')", [buyPayment.buy_order_id]);
        return res.status(200).json({ received: true, duplicate: duplicateWebhook });
      }
      if (Number(event?.data?.amount) !== Number(buyPayment.amount_minor) || String(event?.data?.currency ?? "") !== String(buyPayment.currency)) {
        await pool!.query("UPDATE buy_order_payments SET status='FAILED', updated_at=now() WHERE id=$1", [buyPayment.id]);
        await pool!.query("UPDATE buy_orders SET payment_status='FAILED', updated_at=now() WHERE id=$1", [buyPayment.buy_order_id]);
        return res.status(200).json({ received: true, duplicate: duplicateWebhook });
      }

      const authorization = event?.data?.authorization;
      if (
        buyPayment.business_id &&
        buyPayment.customer_email &&
        authorization?.reusable === true &&
        typeof authorization.authorization_code === "string" &&
        authorization.authorization_code.trim()
      ) {
        await pool!.query(
          `INSERT INTO business_payment_authorizations
             (business_id,user_id,provider,authorization_code,email,status,last_used_at,updated_at,signature,card_type,card_last4,card_exp_month,card_exp_year,bank,brand)
           VALUES ($1,$2,'paystack',$3,$4,'ACTIVE',now(),now(),$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (business_id,user_id,provider)
           DO UPDATE SET
             authorization_code=EXCLUDED.authorization_code,
             email=EXCLUDED.email,
             status='ACTIVE',
             last_used_at=now(),
             updated_at=now(),
             signature=EXCLUDED.signature,
             card_type=EXCLUDED.card_type,
             card_last4=EXCLUDED.card_last4,
             card_exp_month=EXCLUDED.card_exp_month,
             card_exp_year=EXCLUDED.card_exp_year,
             bank=EXCLUDED.bank,
             brand=EXCLUDED.brand`,
          [
            buyPayment.business_id,
            buyPayment.customer_user_id,
            authorization.authorization_code.trim(),
            buyPayment.customer_email,
            typeof authorization.signature === "string" ? authorization.signature.trim() : null,
            typeof authorization.card_type === "string" ? authorization.card_type : null,
            typeof authorization.last4 === "string" ? authorization.last4 : null,
            typeof authorization.exp_month === "string" ? authorization.exp_month : null,
            typeof authorization.exp_year === "string" ? authorization.exp_year : null,
            typeof authorization.bank === "string" ? authorization.bank : null,
            typeof authorization.brand === "string" ? authorization.brand : null
          ]
        );
        await pool!.query(
          `INSERT INTO buy_order_events
             (buy_order_id,actor_user_id,event_type,metadata)
           VALUES ($1,$2,'RECURRING_PAYMENT_AUTHORIZATION_SAVED',$3::jsonb)`,
          [
            buyPayment.buy_order_id,
            buyPayment.customer_user_id,
            JSON.stringify({ businessId: buyPayment.business_id, provider: "paystack" })
          ]
        );
      }
      await pool!.query("UPDATE buy_order_payments SET status='HELD', updated_at=now() WHERE id=$1 AND status NOT IN ('RELEASED','REFUNDED')", [buyPayment.id]);
      await pool!.query("UPDATE buy_orders SET payment_status='HELD', updated_at=now() WHERE id=$1 AND payment_status NOT IN ('REFUNDED')", [buyPayment.buy_order_id]);
      await pool!.query("INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'PAYMENT_HELD',$3::jsonb)", [buyPayment.buy_order_id, buyPayment.customer_user_id, JSON.stringify({ provider: "paystack", reference: buyReference, amountMinor: Number(buyPayment.amount_minor) })]);
      return res.status(200).json({ received: true, duplicate: duplicateWebhook });
    }
  }

  if (databaseEnabled() && (event?.event === "charge.success" || event?.event === "charge.failed")) {
    const receiverDeliveryId = String(event?.data?.metadata?.deliveryId ?? "");
    const receiverReference = String(event?.data?.reference ?? "");
    if (receiverDeliveryId && receiverReference) {
      const receiverPayment = await findPayment(receiverDeliveryId);
      if (receiverPayment?.collectionMode === "RECEIVER_ON_DELIVERY" && receiverPayment.providerReference === receiverReference) {
        if (event.event === "charge.failed") {
          await updatePaymentStatus(receiverDeliveryId, "FAILED", receiverReference);
          await recordDeliveryEvent({ deliveryId: receiverDeliveryId, eventType: "RECEIVER_PAYMENT_FAILED", metadata: { provider: "paystack", reference: receiverReference } });
          return res.status(200).json({ received: true, duplicate: duplicateWebhook });
        }
        const providerAmount = Number(event?.data?.amount);
        const providerCurrency = String(event?.data?.currency ?? "");
        if (!Number.isSafeInteger(providerAmount) || providerAmount !== receiverPayment.amountMinor || providerCurrency.trim() !== receiverPayment.currency.trim()) {
          await updatePaymentStatus(receiverDeliveryId, "FAILED", receiverReference);
          await recordDeliveryEvent({ deliveryId: receiverDeliveryId, eventType: "RECEIVER_PAYMENT_RECONCILIATION_MISMATCH", metadata: { provider: "paystack", reference: receiverReference, expectedAmount: receiverPayment.amountMinor, expectedCurrency: receiverPayment.currency, providerAmount, providerCurrency } });
          return res.status(200).json({ received: true, duplicate: duplicateWebhook });
        }
        const settled = await settleReceiverPaymentAndReleasePayout(
          receiverDeliveryId,
          receiverReference,
          providerAmount,
          providerCurrency,
          Number(process.env.DRIVER_PAYOUT_PERCENT ?? 90)
        );
        if (!settled) return res.status(409).json({ error: "Receiver payment could not be settled safely" });
        await notificationForDelivery(receiverDeliveryId, settled.delivery.senderId, "Receiver payment received", "The receiver paid for the delivery. The order is complete and courier payout is now eligible.", "RECEIVER_PAYMENT_RECEIVED");
        if (settled.delivery.driverId) {
          const driver = await driverForUser(settled.delivery.driverId);
          if (driver) await notificationForDelivery(receiverDeliveryId, driver.userId, "Receiver payment received", "The receiver has paid. Your courier payout is now eligible.", "PAYOUT_ELIGIBLE");
        }
        publishDeliveryUpdate(receiverDeliveryId, safeDelivery(settled.delivery));
        return res.status(200).json({ received: true, duplicate: duplicateWebhook, paymentMode: "RECEIVER_ON_DELIVERY", payoutAmountMinor: settled.payoutAmountMinor });
      }
    }
  }

  if (event?.event !== "charge.success") return res.status(200).json({ received: true });

  const data = event.data;
  const deliveryId = String(data?.metadata?.deliveryId ?? "");
  const reference = String(data?.reference ?? "");
  if (!deliveryId || !reference) return res.status(200).json({ received: true });

  const payment = await findPayment(deliveryId);
  if (!payment || payment.provider !== "paystack" || (payment.providerReference && payment.providerReference !== reference)) {
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
  return res.status(200).json({ received: true, duplicate: duplicateWebhook });
});

app.post("/api/deliveries/:id/receiver-payment/initialize", async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Receiver payments require the production database" });
  const deliveryId = routeParam(req.params.id, "id");
  const receiverPhone = String(req.body?.receiverPhone ?? "").trim();
  const receiverPin = String(req.body?.receiverPin ?? "").trim();
  const email = String(req.body?.email ?? "").trim();
  if (!receiverPhone || !/^\d{6}$/.test(receiverPin) || !email) {
    return res.status(400).json({ error: "Receiver phone, six-digit PIN and payment email are required" });
  }
  const delivery = await findDelivery(deliveryId);
  if (!delivery || delivery.paymentMode !== "RECEIVER_ON_DELIVERY") return res.status(404).json({ error: "Receiver-paid delivery not found" });
  if (delivery.receiverPhone !== receiverPhone) return res.status(403).json({ error: "Receiver details could not be verified" });
  if (delivery.status !== "ARRIVED" || !delivery.receiverConfirmedAt) {
    return res.status(409).json({ error: "Confirm receipt first. Payment is collected immediately after receiver confirmation." });
  }
  const payment = await findPayment(deliveryId);
  if (!payment || payment.collectionMode !== "RECEIVER_ON_DELIVERY" || !["PENDING","AUTHORIZED"].includes(payment.status)) {
    return res.status(409).json({ error: "This receiver payment is no longer awaiting collection." });
  }
  if (payment.authorizationUrl && payment.providerReference) {
    return res.status(200).json({
      paymentId: payment.id,
      reference: payment.providerReference,
      authorizationUrl: payment.authorizationUrl,
      accessCode: payment.accessCode,
      amountMinor: payment.amountMinor
    });
  }
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const provider = process.env.PAYMENT_PROVIDER || "paystack";
  if (provider !== "paystack" || !secret) return res.status(503).json({ error: "Paystack payment configuration is not ready" });
  const reference = "SD-ROD-" + delivery.trackingCode + "-" + Date.now();
  const reservation = await reservePaymentInitialization(deliveryId, reference);
  if (!reservation.reserved) {
    if (reservation.payment?.authorizationUrl) return res.status(200).json({
      paymentId: reservation.payment.id,
      reference: reservation.payment.providerReference,
      authorizationUrl: reservation.payment.authorizationUrl,
      accessCode: reservation.payment.accessCode,
      amountMinor: reservation.payment.amountMinor
    });
    return res.status(409).json({ error: "Payment initialization is already in progress. Retry shortly." });
  }
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({
      email,
      amount: String(payment.amountMinor),
      currency: "NGN",
      reference,
      metadata: { deliveryId, trackingCode: delivery.trackingCode, collectionMode: "RECEIVER_ON_DELIVERY" }
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json() as any;
  if (!response.ok || !payload.status || !payload.data?.authorization_url) {
    return res.status(502).json({ error: "Receiver payment provider initialization failed" });
  }
  const saved = await savePaymentCheckoutSession(deliveryId, payload.data.reference ?? reference, payload.data.authorization_url, payload.data.access_code);
  if (!saved) return res.status(409).json({ error: "Receiver payment checkout could not be saved. Retry shortly." });
  await recordDeliveryEvent({
    deliveryId,
    eventType: "RECEIVER_PAYMENT_INITIALIZED",
    metadata: { reference: saved.providerReference, amountMinor: saved.amountMinor, currency: saved.currency, collectionMode: "RECEIVER_ON_DELIVERY" }
  });
  return res.status(201).json({
    paymentId: saved.id,
    reference: saved.providerReference,
    authorizationUrl: saved.authorizationUrl,
    accessCode: saved.accessCode,
    amountMinor: saved.amountMinor
  });
});

app.get("/api/deliveries/:id/payment/status", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const role = (req as typeof req & { user?: { role: "CUSTOMER" | "ADMIN" } }).user!.role;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(routeParam(req.params.id, "id"), userId, role)
    : await getOne(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const payment = await findPayment(routeParam(req.params.id, "id"));
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  res.json({ payment });
});

app.post("/api/deliveries/:id/dispute", requireAuth("CUSTOMER", "DRIVER"), async (req, res) => {
  const userId = identity(req);
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(routeParam(req.params.id, "id"), userId, (req as any).user.role)
    : null;
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.status === "CANCELLED") {
    return res.status(409).json({ error: "This delivery can no longer be disputed" });
  }
  const reason = String(req.body?.reason ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  if (!reason) return res.status(400).json({ error: "Dispute reason is required" });
  const dispute = await createDispute(routeParam(req.params.id, "id"), userId, reason, description);
  if (!dispute) return res.status(409).json({ error: "A dispute already exists or database is unavailable" });
  await recordDeliveryEvent({
    deliveryId: routeParam(req.params.id, "id"),
    eventType: "DISPUTE_OPENED",
    actorUserId: userId,
    metadata: { reason }
  });
  res.status(201).json({ dispute });
});

app.post("/api/track/:trackingCode/dispute", async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Receiver disputes require the production database" });
  const receiverPhone = String(req.body?.receiverPhone ?? "").trim();
  const receiverPin = String(req.body?.receiverPin ?? "").trim();
  const reason = String(req.body?.reason ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  if (!receiverPhone || !/^\d{6}$/.test(receiverPin) || !reason) {
    return res.status(400).json({ error: "Receiver phone, six-digit PIN and dispute reason are required" });
  }
  const delivery = await findByTrackingCode(String(routeParam(req.params.trackingCode, "trackingCode")).trim().toUpperCase());
  if (!delivery || delivery.receiverPhone !== receiverPhone) {
    return res.status(403).json({ error: "Receiver details could not be verified" });
  }
  const pinKey = "dispute:" + delivery.id + ":" + receiverPhone;
  const pinRate = checkReceiverPinRate(pinKey);
  if (!pinRate.allowed) return res.status(429).json({ error: "Too many PIN attempts. Try again later.", retryAfterMs: pinRate.retryAfterMs });
  if (!await verifyReceiverPin(delivery.id, receiverPin)) {
    recordReceiverPinFailure(pinKey);
    return res.status(403).json({ error: "Receiver details could not be verified" });
  }
  clearReceiverPinFailures(pinKey);
  if (delivery.status === "CANCELLED") return res.status(409).json({ error: "This delivery is cancelled" });
  const dispute = await createReceiverDispute(delivery.id, receiverPhone, reason, description);
  if (!dispute) return res.status(409).json({ error: "A dispute already exists or database is unavailable" });
  await recordDeliveryEvent({
    deliveryId: delivery.id,
    eventType: "DISPUTE_OPENED",
    metadata: { reason, openedByRole: "RECEIVER" }
  });
  return res.status(201).json({ dispute });
});

app.get("/api/deliveries/:id/dispute", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const role = (req as any).user.role;
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), userId, role);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const dispute = await findDispute(routeParam(req.params.id, "id"));
  if (!dispute) return res.status(404).json({ error: "No dispute found" });
  res.json({ dispute });
});

app.get("/api/support/tickets", requireAuth("CUSTOMER", "DRIVER", "AGENT"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Support requires the production database" });
  const tickets = await listSupportTickets(identity(req));
  const enriched = await Promise.all(tickets.map(async ticket => ({ ...ticket, messages: await listSupportTicketMessages(ticket.id, identity(req)) })));
  return res.json({ tickets: enriched });
});

app.get("/api/support/tickets/:id/messages", requireAuth("CUSTOMER", "DRIVER", "AGENT"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Support requires the production database" });
  const messages = await listSupportTicketMessages(routeParam(req.params.id, "id"), identity(req));
  return res.json({ messages });
});

app.post("/api/support/tickets", requireAuth("CUSTOMER", "DRIVER", "AGENT"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Support requires the production database" });
  const category = String(req.body?.category ?? "").toUpperCase();
  const subject = String(req.body?.subject ?? "").trim();
  const message = String(req.body?.message ?? "").trim();
  const deliveryId = req.body?.deliveryId ? String(req.body.deliveryId) : undefined;
  const role = (req as any).user.role;
  if (category !== "ORDER" && category !== "APP") return res.status(400).json({ error: "Support category must be ORDER or APP" });
  if (subject.length < 3 || subject.length > 120 || message.length < 5 || message.length > 2000) {
    return res.status(400).json({ error: "Enter a subject and a message within the allowed length" });
  }
  if (deliveryId) {
    if (role === "AGENT") {
      const linked = await pool!.query(
        "SELECT 1 FROM buy_orders WHERE delivery_id=$1 AND agent_id=(SELECT id FROM agent_profiles WHERE user_id=$2) LIMIT 1",
        [deliveryId, identity(req)]
      );
      if (!linked.rows[0]) return res.status(404).json({ error: "Order not found" });
    } else {
      const delivery = await findDeliveryForUser(deliveryId, identity(req), role);
      if (!delivery) return res.status(404).json({ error: "Order not found" });
    }
  }
  const ticket = await createSupportTicket(identity(req), category, subject, message, deliveryId);
  if (!ticket) return res.status(503).json({ error: "Unable to create support request" });
  return res.status(201).json({ ticket });
});

app.get("/api/admin/support/tickets/:id/messages", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Support requires the production database" });
  const ticketId = routeParam(req.params.id, "id");
  const ticket = await pool!.query("SELECT id FROM support_tickets WHERE id=$1", [ticketId]);
  if (!ticket.rows[0]) return res.status(404).json({ error: "Support ticket not found" });
  const messages = await listSupportTicketMessages(ticketId);
  return res.json({ messages });
});

app.get("/api/admin/support/ai-actions", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Support AI audit requires the production database" });
  const result = await pool!.query(
    `SELECT a.id, a.ticket_id, a.action_type, a.decision, a.reason, a.response, a.actor, a.created_at,
            t.subject, t.category, t.status AS ticket_status
     FROM support_ai_actions a
     JOIN support_tickets t ON t.id=a.ticket_id
     ORDER BY a.created_at DESC LIMIT 200`
  );
  return res.json({ actions: result.rows });
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

  if (!objectStorageEnabled) {
    return res.status(503).json({ error: "Private object storage is not configured" });
  }
  const filename = randomUUID() + "." + extension;
  const contentType = extension === "pdf" ? "application/pdf" : extension === "png" ? "image/png" : "image/jpeg";
  await putPrivateObject("kyc/" + driver.id + "/" + filename, buffer, contentType);

  const result = await pool!.query(
    "INSERT INTO driver_documents (driver_id, document_type, document_url) VALUES ($1,$2,$3) RETURNING id, document_type, status, created_at",
    [driver.id, documentType, "/api/driver/documents/file/" + filename]
  );
  res.status(201).json({ document: { id: result.rows[0].id, documentType: result.rows[0].document_type, status: result.rows[0].status, createdAt: result.rows[0].created_at } });
});

app.get("/api/driver/documents/file/:filename", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const filename = path.basename(routeParam(req.params.filename, "filename"));
  const documentUrl = "/api/driver/documents/file/" + filename;
  const result = await pool!.query("SELECT driver_id FROM driver_documents WHERE document_url=$1 LIMIT 1", [documentUrl]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Document not found" });

  if ((req as any).user?.role !== "ADMIN") {
    const driver = await driverForUser(identity(req));
    if (!driver || driver.id !== row.driver_id) return res.status(403).json({ error: "Not authorized to view this document" });
  }

  if (!objectStorageEnabled && process.env.NODE_ENV === "production") return res.status(503).json({ error: "Private object storage is not configured" });
  try {
    const stored = await getPrivateObject("kyc/" + row.driver_id + "/" + filename);
    res.setHeader("content-type", stored.contentType ?? "application/octet-stream");
    res.setHeader("cache-control", "private, no-store");
    return res.send(stored.body);
  } catch {
    return res.status(404).json({ error: "Document file not found" });
  }
});

app.post("/api/driver/documents", requireAuth("DRIVER"), async (_req, res) => {
  return res.status(410).json({
    error: "Direct document URLs are no longer accepted. Upload KYC documents through the secure document upload flow."
  });
});

app.get("/api/driver/documents", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  const result = await pool!.query(
    "SELECT id, document_type, document_url, status, review_note, created_at, updated_at FROM driver_documents WHERE driver_id=$1 ORDER BY created_at DESC",
    [driver.id]
  );
  res.json({ documents: result.rows.map((row) => ({ id: row.id, documentType: row.document_type, documentUrl: row.document_url, status: row.status, reviewNote: row.review_note, createdAt: row.created_at, updatedAt: row.updated_at })) });
});

app.get("/api/admin/drivers/:driverId/documents", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    "SELECT id, document_type, document_url, status, review_note, created_at, updated_at FROM driver_documents WHERE driver_id=$1 ORDER BY created_at DESC",
    [routeParam(req.params.driverId, "driverId")]
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
    [routeParam(req.params.documentId, "documentId"), status, note || null]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Document not found" });
  await recordAdminCaseAudit({
    adminUserId: identity(req),
    action: "KYC_DOCUMENT_REVIEWED",
    note: note || null,
    metadata: { documentId: result.rows[0].id, driverId: result.rows[0].driver_id, documentType: result.rows[0].document_type, status }
  });
  res.json({ document: { id: result.rows[0].id, driverId: result.rows[0].driver_id, documentType: result.rows[0].document_type, status: result.rows[0].status, reviewNote: result.rows[0].review_note, updatedAt: result.rows[0].updated_at } });
});

app.get("/api/admin/users", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Admin user management requires the production database" });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const search = String(req.query.search ?? "").trim();
  const result = await pool!.query(
    `SELECT u.id, u.role, u.full_name, u.phone, u.email, u.ai_plan, u.created_at,
            d.id AS driver_id, d.status AS driver_status, d.online AS driver_online
       FROM users u
       LEFT JOIN drivers d ON d.user_id=u.id
      WHERE ($1 = '' OR u.full_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%' OR COALESCE(u.email,'') ILIKE '%' || $1 || '%')
      ORDER BY u.created_at DESC
      LIMIT $2`,
    [search, limit]
  );
  return res.json({ users: result.rows.map((row) => ({ id: row.id, role: row.role, fullName: row.full_name, phone: row.phone, email: row.email, aiPlan: row.ai_plan, createdAt: row.created_at, driver: row.driver_id ? { id: row.driver_id, status: row.driver_status, online: row.driver_online } : null })) });
});

app.get("/api/admin/drivers", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    "SELECT d.id, d.user_id, d.status, d.online, d.vehicle_type, d.vehicle_registration, u.full_name, u.phone, u.email, d.created_at FROM drivers d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 200"
  );
  res.json({ drivers: result.rows.map((row) => ({ id: row.id, userId: row.user_id, status: row.status, online: row.online, vehicleType: row.vehicle_type, vehicleRegistration: row.vehicle_registration, fullName: row.full_name, phone: row.phone, email: row.email, createdAt: row.created_at })) });
});

app.post("/api/admin/drivers/:driverId/approve", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const documents = await pool!.query(
    "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='APPROVED')::int AS approved FROM driver_documents WHERE driver_id=$1",
    [routeParam(req.params.driverId, "driverId")]
  );
  const documentSummary = documents.rows[0];
  if (!documentSummary || documentSummary.total < 1 || documentSummary.approved < 1) {
    return res.status(409).json({ error: "At least one approved KYC document is required before driver approval" });
  }
  const result = await pool!.query(
    "UPDATE drivers SET status='APPROVED', updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING id, user_id, status, online, updated_at",
    [routeParam(req.params.driverId, "driverId")]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Pending driver not found" });
  await recordAdminCaseAudit({ adminUserId: identity(req), action: "DRIVER_APPROVED", metadata: { driverId: result.rows[0].id } });
  const driver = result.rows[0];
  res.json({ driver: { id: driver.id, userId: driver.user_id, status: driver.status, online: driver.online, updatedAt: driver.updated_at } });
});

app.post("/api/admin/drivers/:driverId/suspend", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    "UPDATE drivers SET status='SUSPENDED', online=false, updated_at=now() WHERE id=$1 AND status <> 'SUSPENDED' RETURNING id, user_id, status, online, updated_at",
    [routeParam(req.params.driverId, "driverId")]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Driver not found" });
  await recordAdminCaseAudit({ adminUserId: identity(req), action: "DRIVER_SUSPENDED", metadata: { driverId: result.rows[0].id } });
  const driver = result.rows[0];
  res.json({ driver: { id: driver.id, userId: driver.user_id, status: driver.status, online: driver.online, updatedAt: driver.updated_at } });
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
  res.json({ deliveries: result.rows.map((row) => ({ id: row.id, trackingCode: row.tracking_code, senderId: row.sender_id, driverId: row.driver_id, receiverName: row.receiver_name, status: row.status, quoteTotalMinor: Number(row.quote_total_minor), quoteCurrency: row.quote_currency, createdAt: row.created_at, updatedAt: row.updated_at, latestLocation: row.latest_location })) });
});

app.get("/api/admin/disputes", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    `SELECT dp.id, dp.delivery_id, dp.opened_by, dp.opened_by_phone, dp.opened_by_role,
            dp.reason, dp.description, dp.status, dp.resolution_note, dp.created_at, dp.updated_at,
            d.tracking_code, d.status AS delivery_status, d.receiver_name, d.receiver_phone,
            d.driver_id, d.quote_total_minor, d.quote_currency,
            p.status AS payment_status, p.refund_status, p.refund_amount_minor,
            po.status AS payout_status
       FROM disputes dp
       JOIN deliveries d ON d.id=dp.delivery_id
       LEFT JOIN payments p ON p.delivery_id=d.id
       LEFT JOIN payouts po ON po.delivery_id=d.id
      ORDER BY dp.updated_at DESC
      LIMIT 100`
  );
  res.json({ disputes: result.rows.map((row) => ({ id: row.id, deliveryId: row.delivery_id, openedBy: row.opened_by, openedByPhone: row.opened_by_phone, openedByRole: row.opened_by_role, reason: row.reason, description: row.description, status: row.status, resolutionNote: row.resolution_note, createdAt: row.created_at, updatedAt: row.updated_at, trackingCode: row.tracking_code, deliveryStatus: row.delivery_status, receiverName: row.receiver_name, receiverPhone: row.receiver_phone, driverId: row.driver_id, quoteTotalMinor: Number(row.quote_total_minor), quoteCurrency: row.quote_currency, paymentStatus: row.payment_status, refundStatus: row.refund_status, refundAmountMinor: row.refund_amount_minor, payoutStatus: row.payout_status })) });
});

app.get("/api/admin/disputes/:deliveryId", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    `SELECT d.id, d.tracking_code, d.sender_id, d.driver_id, d.receiver_name, d.receiver_phone,
            d.status, d.pickup_address, d.dropoff_address, d.pickup_lat, d.pickup_lng, d.dropoff_lat, d.dropoff_lng,
            d.pickup_photo_url, d.weight_kg, d.length_cm, d.width_cm, d.height_cm, d.is_perishable,
            d.quote_total_minor, d.quote_currency, d.quote_distance_meters, d.quote_duration_seconds,
            d.created_at, d.updated_at, d.receiver_confirmed_at,
            dp.id AS dispute_id, dp.opened_by, dp.opened_by_phone, dp.opened_by_role, dp.reason,
            dp.description AS dispute_description, dp.status AS dispute_status, dp.resolution_note,
            dp.created_at AS dispute_created_at, dp.updated_at AS dispute_updated_at,
            p.id AS payment_id, p.provider AS payment_provider, p.provider_reference,
            p.amount_minor AS payment_amount_minor, p.currency AS payment_currency, p.status AS payment_status,
            p.escrow_status, p.refund_reference, p.refund_status, p.refund_amount_minor, p.refund_updated_at,
            po.id AS payout_id, po.amount_minor AS payout_amount_minor, po.currency AS payout_currency,
            po.status AS payout_status, po.provider AS payout_provider, po.provider_reference AS payout_provider_reference,
            po.provider_status AS payout_provider_status, po.failure_reason AS payout_failure_reason,
            po.processed_at AS payout_processed_at,
            su.full_name AS sender_name, su.phone AS sender_phone, su.email AS sender_email,
            du.full_name AS driver_name, du.phone AS driver_phone, du.email AS driver_email
       FROM deliveries d
       LEFT JOIN disputes dp ON dp.delivery_id=d.id
       LEFT JOIN payments p ON p.delivery_id=d.id
       LEFT JOIN payouts po ON po.delivery_id=d.id
       LEFT JOIN users su ON su.id=d.sender_id
       LEFT JOIN drivers dr ON dr.id=d.driver_id
       LEFT JOIN users du ON du.id=dr.user_id
      WHERE d.id=$1`,
    [routeParam(req.params.deliveryId, "deliveryId")]
  );
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Delivery not found" });
  const [events, locations, audit] = await Promise.all([
    pool!.query(`SELECT id, event_type, actor_user_id, metadata, created_at FROM delivery_events WHERE delivery_id=$1 ORDER BY created_at ASC LIMIT 200`, [routeParam(req.params.deliveryId, "deliveryId")]),
    pool!.query(`SELECT latitude::float AS latitude, longitude::float AS longitude, accuracy_meters::float AS accuracy_meters, recorded_at FROM location_events WHERE delivery_id=$1 ORDER BY recorded_at DESC LIMIT 100`, [routeParam(req.params.deliveryId, "deliveryId")]),
    listAdminCaseAudit(routeParam(req.params.deliveryId, "deliveryId"))
  ]);
  return res.json({ case: {
    id: row.id, trackingCode: row.tracking_code, senderId: row.sender_id, driverId: row.driver_id,
    receiverName: row.receiver_name, receiverPhone: row.receiver_phone, status: row.status,
    pickupAddress: row.pickup_address, dropoffAddress: row.dropoff_address,
    pickupLat: row.pickup_lat, pickupLng: row.pickup_lng, dropoffLat: row.dropoff_lat, dropoffLng: row.dropoff_lng,
    pickupPhotoUrl: row.pickup_photo_url, weightKg: row.weight_kg, lengthCm: row.length_cm, widthCm: row.width_cm,
    heightCm: row.height_cm, isPerishable: row.is_perishable, quoteTotalMinor: Number(row.quote_total_minor),
    quoteCurrency: row.quote_currency, quoteDistanceMeters: row.quote_distance_meters, quoteDurationSeconds: row.quote_duration_seconds,
    createdAt: row.created_at, updatedAt: row.updated_at, receiverConfirmedAt: row.receiver_confirmed_at,
    dispute: row.dispute_id ? { id: row.dispute_id, openedBy: row.opened_by, openedByPhone: row.opened_by_phone, openedByRole: row.opened_by_role, reason: row.reason, description: row.dispute_description, status: row.dispute_status, resolutionNote: row.resolution_note, createdAt: row.dispute_created_at, updatedAt: row.dispute_updated_at } : null,
    payment: row.payment_id ? { id: row.payment_id, provider: row.payment_provider, amountMinor: Number(row.payment_amount_minor), currency: row.payment_currency, status: row.payment_status, escrowStatus: row.escrow_status, refundStatus: row.refund_status, refundAmountMinor: row.refund_amount_minor, refundUpdatedAt: row.refund_updated_at } : null,
    payout: row.payout_id ? { id: row.payout_id, amountMinor: Number(row.payout_amount_minor), currency: row.payout_currency, status: row.payout_status, provider: row.payout_provider, providerStatus: row.payout_provider_status, failureReason: row.payout_failure_reason, processedAt: row.payout_processed_at } : null,
    sender: { fullName: row.sender_name, phone: row.sender_phone, email: row.sender_email },
    driver: { fullName: row.driver_name, phone: row.driver_phone, email: row.driver_email }
  }, events: events.rows, locations: locations.rows, audit });
});

app.post("/api/admin/disputes/:deliveryId/review", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const dispute = await markDisputeUnderReview(routeParam(req.params.deliveryId, "deliveryId"));
  if (!dispute) return res.status(409).json({ error: "Only open disputes can be moved to review" });
  const note = String(req.body?.note ?? "").trim() || "Case moved to investigation";
  await recordAdminCaseAudit({ deliveryId: routeParam(req.params.deliveryId, "deliveryId"), disputeId: dispute.id, adminUserId: identity(req), action: "DISPUTE_UNDER_REVIEW", note });
  await recordDeliveryEvent({ deliveryId: routeParam(req.params.deliveryId, "deliveryId"), eventType: "DISPUTE_UNDER_REVIEW", actorUserId: identity(req), metadata: { disputeId: dispute.id } });
  return res.json({ dispute });
});

app.get("/api/admin/support/tickets", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const tickets = await listSupportTickets();
  return res.json({ tickets });
});

app.post("/api/admin/support/tickets/:id/resolve", requireAuth("ADMIN"), async (req, res) => {
  const status = String(req.body?.status ?? "");
  const note = String(req.body?.note ?? "").trim();
  if (!["IN_REVIEW","RESOLVED","CLOSED"].includes(status) || !note) return res.status(400).json({ error: "A valid status and resolution note are required" });
  const ticket = await resolveSupportTicket(routeParam(req.params.id, "id"), status as "IN_REVIEW" | "RESOLVED" | "CLOSED", note);
  if (!ticket) return res.status(404).json({ error: "Support ticket not found or already resolved" });
  if (ticket.deliveryId) {
    await recordAdminCaseAudit({
      deliveryId: ticket.deliveryId,
      adminUserId: identity(req),
      action: "SUPPORT_TICKET_UPDATED",
      note,
      metadata: { ticketId: ticket.id, status }
    });
  }
  return res.json({ ticket });
});

app.post("/api/admin/support/tickets/:id/reply", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Support requires the production database" });
  const ticketId = routeParam(req.params.id, "id");
  const message = String(req.body?.message ?? "").trim();
  if (message.length < 1 || message.length > 4000) return res.status(400).json({ error: "Reply must be between 1 and 4000 characters" });
  const ticket = await recordAdminSupportReply(ticketId, identity(req), message);
  if (!ticket) return res.status(404).json({ error: "Support ticket not found or already closed" });
  if (ticket.deliveryId) {
    await recordAdminCaseAudit({
      deliveryId: ticket.deliveryId,
      adminUserId: identity(req),
      action: "SUPPORT_TICKET_ADMIN_REPLY",
      note: message,
      metadata: { ticketId }
    });
  }
  return res.json({ ticket, message });
});

app.get("/api/admin/payouts", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query("SELECT id, delivery_id, driver_id, amount_minor, currency, status, provider, provider_status, failure_reason, processed_at, created_at, updated_at FROM payouts ORDER BY updated_at DESC LIMIT 100");
  res.json({ payouts: result.rows.map((row) => ({ id:row.id,deliveryId:row.delivery_id,driverId:row.driver_id,amountMinor:Number(row.amount_minor),currency:row.currency,status:row.status,provider:row.provider,providerStatus:row.provider_status,failureReason:row.failure_reason,processedAt:row.processed_at,createdAt:row.created_at,updatedAt:row.updated_at })) });
});

app.post("/api/admin/payouts/:deliveryId/retry", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const payout = await retryFailedPayout(routeParam(req.params.deliveryId, "deliveryId"));
  if (!payout) return res.status(409).json({ error: "Only failed or reversed payouts can be retried" });
  await recordDeliveryEvent({
    deliveryId: payout.deliveryId,
    eventType: "PAYOUT_RETRY_REQUESTED",
    actorUserId: identity(req),
    metadata: { amountMinor: payout.amountMinor, currency: payout.currency }
  });
  await recordAdminCaseAudit({
    deliveryId: payout.deliveryId,
    adminUserId: identity(req),
    action: "PAYOUT_RETRY_REQUESTED",
    metadata: { amountMinor: payout.amountMinor, currency: payout.currency }
  });
  res.json({ payout });
});

app.post("/api/admin/deliveries/:id/dispute/resolve", requireAuth("ADMIN"), async (req, res) => {
  const status = String(req.body?.resolution ?? "");
  if (status !== "RESOLVED_REFUND" && status !== "RESOLVED_RELEASE") return res.status(400).json({ error: "Resolution must be RESOLVED_REFUND or RESOLVED_RELEASE" });
  const note = String(req.body?.note ?? "").trim();
  if (note.length < 5 || note.length > 2000) return res.status(400).json({ error: "Resolution note must be between 5 and 2000 characters" });

  if (status === "RESOLVED_REFUND") {
    if (!databaseEnabled()) return res.status(503).json({ error: "Refunds require the production database and Paystack" });

    // Marketplace checkout charges item price + delivery fee in one Paystack
    // transaction. The delivery payment row is only an internal allocation,
    // so refunding it would not return the customer's marketplace purchase.
    const marketplace = (await pool!.query(
      `SELECT mo.id AS marketplace_order_id, mo.status AS order_status, mo.delivery_id,
              mop.id AS payment_id, mop.provider_reference, mop.amount_minor,
              mop.currency, mop.status AS payment_status,
              mop.total_refunded_minor, mop.refund_status,
              p.status AS payout_status
         FROM marketplace_orders mo
         JOIN marketplace_order_payments mop ON mop.marketplace_order_id=mo.id
         LEFT JOIN payouts p ON p.delivery_id=mo.delivery_id
        WHERE mo.delivery_id=$1
        FOR UPDATE OF mo,mop`,
      [routeParam(req.params.id, "id")]
    )).rows[0];

    if (marketplace) {
      const dispute = await findDispute(routeParam(req.params.id, "id"));
      if (!dispute || !["OPEN","UNDER_REVIEW"].includes(dispute.status)) {
        return res.status(409).json({ error: "Marketplace delivery has no open dispute to refund" });
      }
      if (marketplace.payment_status !== "AUTHORIZED" || !marketplace.provider_reference) {
        return res.status(409).json({ error: "Marketplace payment is not in a refundable authorized state" });
      }
      if (["PROCESSING","RELEASED"].includes(String(marketplace.payout_status ?? ""))) {
        return res.status(409).json({ error: "Courier payout is already processing or released; stop and investigate before refunding" });
      }

      const requestedAmount = Number(req.body?.refundAmountMinor);
      const refundAmountMinor = Number.isInteger(requestedAmount) && requestedAmount > 0
        ? requestedAmount
        : Number(marketplace.amount_minor);
      const verifiedLossRaw = req.body?.verifiedLossMinor;
      const verifiedLossMinor = Number.isInteger(verifiedLossRaw) && verifiedLossRaw >= 0 ? verifiedLossRaw : undefined;
      if (refundAmountMinor < 1 || refundAmountMinor > Number(marketplace.amount_minor)) {
        return res.status(400).json({ error: "Refund amount must be a positive whole amount not greater than the marketplace payment" });
      }
      if (verifiedLossMinor != null && refundAmountMinor > verifiedLossMinor) {
        return res.status(400).json({ error: "Refund amount exceeds the verified loss amount" });
      }
      const alreadyRefunded = Number(marketplace.total_refunded_minor ?? 0);
      if (alreadyRefunded + refundAmountMinor > Number(marketplace.amount_minor)) {
        return res.status(400).json({ error: "Refund amount exceeds the remaining marketplace payment balance" });
      }
      if (["PENDING","PROCESSING","PROCESSED"].includes(String(marketplace.refund_status ?? "").toUpperCase())) {
        return res.status(409).json({ error: "A marketplace refund is already in progress or has been processed" });
      }

      const refundReferenceReservation = "pending-" + randomUUID().replaceAll("-", "");
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        const payoutLock = marketplace.delivery_id
          ? (await client.query("SELECT status FROM payouts WHERE delivery_id=$1 FOR UPDATE", [marketplace.delivery_id])).rows[0]
          : null;
        if (payoutLock && ["PROCESSING","RELEASED"].includes(String(payoutLock.status))) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Courier payout changed to processing/released; stop and investigate before refunding" });
        }
        const reserved = await client.query(
          `UPDATE marketplace_order_payments
              SET refund_reference=$2, refund_status='PENDING', refund_amount_minor=$3,
                  refund_updated_at=now(), updated_at=now()
            WHERE id=$1 AND status='AUTHORIZED'
              AND COALESCE(total_refunded_minor,0)+$3 <= amount_minor
              AND (refund_status IS NULL OR refund_status IN ('FAILED','RETRY_REQUIRED'))`,
          [marketplace.payment_id, refundReferenceReservation, refundAmountMinor]
        );
        if (!reserved.rowCount) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Marketplace payment is already being refunded or is no longer refundable" });
        }
        await client.query(
          `UPDATE marketplace_orders SET status='DISPUTED', updated_at=now()
             WHERE id=$1 AND status IN ('PAID','PROCESSING','IN_TRANSIT','DELIVERED','DISPUTED')`,
          [marketplace.marketplace_order_id]
        );
        if (marketplace.delivery_id) {
          await client.query(
            `UPDATE payouts SET status='CANCELLED', updated_at=now()
               WHERE delivery_id=$1 AND status IN ('PENDING','ELIGIBLE')`,
            [marketplace.delivery_id]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) return res.status(503).json({ error: "Paystack refund configuration is not ready" });
      const response = await fetch("https://api.paystack.co/refund", {
        method: "POST",
        headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
        body: JSON.stringify({
          transaction: marketplace.provider_reference,
          amount: refundAmountMinor,
          currency: String(marketplace.currency).trim(),
          customer_note: "SwiftDrop marketplace dispute refund",
          merchant_note: note
        }),
        signal: AbortSignal.timeout(15_000)
      });
      const payload = await response.json() as any;
      if (!response.ok || !payload.status) {
        await pool!.query(
          "UPDATE marketplace_order_payments SET refund_status='FAILED',refund_updated_at=now(),updated_at=now() WHERE id=$1",
          [marketplace.payment_id]
        );
        await recordAdminCaseAudit({
          deliveryId: routeParam(req.params.id, "id"),
          disputeId: dispute.id,
          adminUserId: identity(req),
          action: "MARKETPLACE_REFUND_INITIATION_FAILED",
          note,
          metadata: { provider: "paystack", transactionReference: marketplace.provider_reference, amountMinor: refundAmountMinor, error: payload.message ?? "Paystack refund failed" }
        });
        return res.status(502).json({ error: payload.message ?? "Paystack could not initiate the marketplace refund" });
      }

      const providerRefundReference = String(payload.data?.refund_reference ?? payload.data?.id ?? "");
      const refundStatus = String(payload.data?.status ?? "pending").toUpperCase();
      await pool!.query(
        "UPDATE marketplace_order_payments SET refund_reference=COALESCE($2,refund_reference),refund_status=$3,refund_amount_minor=$4,refund_updated_at=now(),updated_at=now() WHERE id=$1",
        [marketplace.payment_id, providerRefundReference || null, refundStatus, refundAmountMinor]
      );
      const resolved = await resolveDispute(routeParam(req.params.id, "id"), status, note);
      if (!resolved) return res.status(409).json({ error: "The marketplace dispute could not be resolved after refund initiation. Review the audit trail before retrying." });
      await recordAdminCaseAudit({
        deliveryId: routeParam(req.params.id, "id"),
        disputeId: resolved.id,
        adminUserId: identity(req),
        action: "MARKETPLACE_REFUND_INITIATED",
        note,
        metadata: { provider: "paystack", transactionReference: marketplace.provider_reference, refundReference: providerRefundReference, refundStatus, amountMinor: refundAmountMinor, payoutCancelled: true }
      });
      await recordDeliveryEvent({
        deliveryId: routeParam(req.params.id, "id"),
        eventType: "MARKETPLACE_REFUND_INITIATED",
        actorUserId: identity(req),
        metadata: { provider: "paystack", transactionReference: marketplace.provider_reference, refundReference: providerRefundReference, refundStatus, amountMinor: refundAmountMinor }
      });
      return res.json({ dispute: resolved, refund: { status: refundStatus, reference: providerRefundReference, amountMinor: refundAmountMinor, paymentType: "MARKETPLACE_ORDER" } });
    }

    const paymentBefore = await findPayment(routeParam(req.params.id, "id"));
    if (!paymentBefore) return res.status(409).json({ error: "No payment was found for this delivery" });
    const requestedAmount = Number(req.body?.refundAmountMinor);
    const refundAmountMinor = Number.isInteger(requestedAmount) && requestedAmount > 0 ? requestedAmount : paymentBefore.amountMinor;
    const verifiedLossRaw = req.body?.verifiedLossMinor;
    const verifiedLossMinor = Number.isInteger(verifiedLossRaw) && verifiedLossRaw >= 0 ? verifiedLossRaw : undefined;
    if (refundAmountMinor < 1 || refundAmountMinor > paymentBefore.amountMinor) return res.status(400).json({ error: "Refund amount must be a positive whole amount not greater than the original payment" });
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return res.status(503).json({ error: "Paystack refund configuration is not ready" });

    const prepared = await prepareRefund(routeParam(req.params.id, "id"), refundAmountMinor, verifiedLossMinor);
    if (!prepared) return res.status(409).json({ error: "This case is no longer refundable. Check the payment, existing refund and courier payout status." });

    const response = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: JSON.stringify({
        transaction: prepared.payment.providerReference,
        amount: refundAmountMinor,
        currency: prepared.payment.currency,
        customer_note: "SwiftDrop delivery dispute refund",
        merchant_note: note
      })
    });
    const payload = await response.json() as any;
    if (!response.ok || !payload.status) {
      await markPaymentRefund(routeParam(req.params.id, "id"), prepared.payment.refundReference ?? "", "failed", refundAmountMinor);
      await recordAdminCaseAudit({ deliveryId: routeParam(req.params.id, "id"), disputeId: prepared.dispute.id, adminUserId: identity(req), action: "REFUND_INITIATION_FAILED", note, metadata: { provider: "paystack", amountMinor: refundAmountMinor, error: payload.message ?? "Paystack refund failed" } });
      return res.status(502).json({ error: payload.message ?? "Paystack could not initiate the refund" });
    }
    const refundReference = String(payload.data?.refund_reference ?? payload.data?.id ?? "");
    const refundStatus = String(payload.data?.status ?? "pending");
    await markPaymentRefund(routeParam(req.params.id, "id"), refundReference, refundStatus, refundAmountMinor);
    const dispute = await resolveDispute(routeParam(req.params.id, "id"), status, note);
    if (!dispute) return res.status(409).json({ error: "The dispute could not be resolved after refund initiation. Review the audit trail before retrying." });
    await recordAdminCaseAudit({
      deliveryId: routeParam(req.params.id, "id"),
      disputeId: dispute.id,
      adminUserId: identity(req),
      action: "REFUND_INITIATED",
      note,
      metadata: { provider: "paystack", transactionReference: prepared.payment.providerReference, refundReference, refundStatus, amountMinor: refundAmountMinor, payoutCancelled: Boolean(prepared.payout) }
    });
    await recordDeliveryEvent({ deliveryId: routeParam(req.params.id, "id"), eventType: "REFUND_INITIATED", actorUserId: identity(req), metadata: { provider: "paystack", transactionReference: prepared.payment.providerReference, refundReference, refundStatus, amountMinor: refundAmountMinor } });
    return res.json({ dispute, refund: { status: refundStatus, reference: refundReference, amountMinor: refundAmountMinor } });
  }

  if (!databaseEnabled()) return res.status(503).json({ error: "Dispute release requires the production database" });
  const released = await releaseDisputeAndCreatePayout(
    routeParam(req.params.id, "id"),
    Number(process.env.DRIVER_PAYOUT_PERCENT ?? 90),
    note
  );
  if (!released) return res.status(409).json({ error: "This dispute cannot be released. Verify that the payment is held and an assigned driver is eligible for payout." });
  await recordAdminCaseAudit({
    deliveryId: routeParam(req.params.id, "id"),
    disputeId: released.dispute.id,
    adminUserId: identity(req),
    action: "DISPUTE_RELEASED",
    note,
    metadata: { resolution: status, payoutCreated: Boolean(released.payout), payoutAmountMinor: released.payout?.amountMinor ?? 0 }
  });
  await recordDeliveryEvent({
    deliveryId: routeParam(req.params.id, "id"),
    eventType: "DISPUTE_RESOLVED",
    actorUserId: identity(req),
    metadata: { resolution: status, escrowReleased: true, payoutEligible: Boolean(released.payout) }
  });
  return res.json({ dispute: released.dispute, payment: released.payment, payout: released.payout });
});
app.get("/api/deliveries/:id/payout", requireAuth("DRIVER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const role = (req as typeof req & { user?: { role: "DRIVER" | "ADMIN" } }).user!.role;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(routeParam(req.params.id, "id"), userId, role)
    : await getOne(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const payout = await findPayout(routeParam(req.params.id, "id"));
  if (!payout) return res.status(404).json({ error: "Payout has not been created" });
  res.json({ payout });
});

app.get("/api/deliveries/:id/events", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const user = (req as typeof req & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } }).user!;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(routeParam(req.params.id, "id"), user.userId, user.role)
    : await getOne(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  res.json({ events: await listDeliveryEvents(delivery.id) });
});

app.get("/api/deliveries/:id", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const user = (req as typeof req & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } }).user!;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(routeParam(req.params.id, "id"), user.userId, user.role)
    : await getOne(routeParam(req.params.id, "id"));
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

app.post("/api/deliveries/:id/share-tracking", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Shareable tracking requires the production database" });
  const user = (req as typeof req & { user?: { userId: string; role: "CUSTOMER" | "ADMIN" } }).user!;
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), user.userId, user.role);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.status === "CANCELLED") return res.status(409).json({ error: "Cancelled deliveries cannot be shared" });

  const rawToken = randomUUID() + randomUUID();
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await pool!.query(
    "INSERT INTO delivery_tracking_links(delivery_id,token_hash,expires_at,created_by_user_id) VALUES($1,$2,$3,$4)",
    [delivery.id, tokenHash, expiresAt, user.userId]
  );
  const configuredBase = (process.env.PUBLIC_TRACKING_BASE_URL ?? "").trim().replace(/\/$/, "");
  const base = configuredBase || `${req.protocol}://${req.get("host")}/api/public/track`;
  return res.status(201).json({
    url: `${base}/${rawToken}`,
    expiresAt: expiresAt.toISOString()
  });
});

app.get("/api/public/track/:token", async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Public tracking requires the production database" });
  const token = String(routeParam(req.params.token, "token")).trim();
  if (token.length < 32 || token.length > 128) return res.status(404).json({ error: "Tracking link not found or expired" });
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await pool!.query(
    `SELECT d.id,d.tracking_code,d.status,d.pickup,d.dropoff,d.pickup_photo_url,d.updated_at
       FROM delivery_tracking_links l
       JOIN deliveries d ON d.id=l.delivery_id
      WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND l.expires_at > now()`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Tracking link not found or expired" });
  const latestLocation = await latestPersistentLocation(String(row.id));
  return res.json({
    id: row.id,
    trackingCode: row.tracking_code,
    status: row.status,
    pickup: row.pickup,
    dropoff: row.dropoff,
    pickupPhotoUrl: row.pickup_photo_url,
    latestLocation,
    updatedAt: row.updated_at
  });
});

app.get("/api/track/:trackingCode", async (req, res) => {
  const code = String(routeParam(req.params.trackingCode, "trackingCode") ?? "").trim().toUpperCase();
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
  if (!driver || driver.status !== "APPROVED") return null;
  const verification = await pool!.query(
    `SELECT 1 FROM driver_documents WHERE driver_id=$1 AND status='APPROVED' LIMIT 1`,
    [driver.id]
  );
  return verification.rowCount ? driver.id : null;
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
  if (routeParam(req.params.driverId, "driverId") !== driverId) return res.status(403).json({ error: "Driver identity mismatch" });
  const jobs = databaseEnabled()
    ? await listOpenJobs(driverId)
    : [...deliveries.values()].filter(d => !d.driverId && ["CREATED", "PAYMENT_AUTHORIZED"].includes(d.status));
  res.json({ driverId, jobs: jobs.map(safeDelivery) });
});

app.post("/api/deliveries/:id/accept", requireAuth("DRIVER"), async (req, res) => {
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  if (databaseEnabled()) {
    const updated = await transitionDelivery(routeParam(req.params.id, "id"), "PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is no longer available" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "DRIVER_ASSIGNED", actorUserId: identity(req), metadata: { driverId } });
    await notificationForDelivery(updated.id, updated.senderId, "Driver assigned", "A driver has accepted your SwiftDrop delivery.", "DRIVER_ASSIGNED");
    publishDeliveryUpdate(routeParam(req.params.id, "id"), safeDelivery(updated));
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(routeParam(req.params.id, "id"));
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
    const updated = await transitionDelivery(routeParam(req.params.id, "id"), "DRIVER_ASSIGNED", "DRIVER_AT_PICKUP", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not awaiting pickup or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "DRIVER_AT_PICKUP", actorUserId: identity(req), metadata: {} });
    await notificationForDelivery(updated.id, updated.senderId, "Driver has arrived", "Your SwiftDrop driver is at the pickup location.", "DRIVER_AT_PICKUP");
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "DRIVER_ASSIGNED") return res.status(409).json({ error: "Delivery is not awaiting pickup" });
  delivery.status = "DRIVER_AT_PICKUP"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

app.post("/api/uploads/pickup-photo", requireAuth("DRIVER"), async (req, res) => {
  const deliveryId = String(req.body?.deliveryId ?? "").trim();
  if (!deliveryId) return res.status(400).json({ error: "deliveryId is required" });
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  const delivery = await getOne(deliveryId);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId || delivery.status !== "DRIVER_AT_PICKUP") {
    return res.status(403).json({ error: "Only the assigned driver may upload a pickup photo while at pickup" });
  }
  const dataUrl = String(req.body?.image ?? "");
  const match = dataUrl.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/i);
  if (!match) return res.status(400).json({ error: "A JPEG or PNG data URL is required" });
  const extension = match[1].toLowerCase() === "png" ? "png" : "jpg";
  const contentType = extension === "png" ? "image/png" : "image/jpeg";
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0) return res.status(400).json({ error: "Image is empty" });
  if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: "Image is too large" });

  if (!objectStorageEnabled) {
    if (process.env.NODE_ENV === "production") return res.status(503).json({ error: "Private object storage is not configured" });
    return res.status(503).json({ error: "Pickup photo storage is not configured" });
  }

  await putPrivateObject("pickups/" + delivery.id + "/photo." + extension, buffer, contentType);
  res.status(201).json({ url: "/api/deliveries/" + encodeURIComponent(delivery.id) + "/pickup-photo" });
});

app.get("/api/deliveries/:id/pickup-photo", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const user = (req as typeof req & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } }).user!;
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(routeParam(req.params.id, "id"), user.userId, user.role)
    : await getOne(routeParam(req.params.id, "id"));
  if (!delivery || !delivery.pickupPhotoUrl) return res.status(404).json({ error: "Pickup photo not found" });
  if (!objectStorageEnabled && process.env.NODE_ENV === "production") return res.status(503).json({ error: "Private object storage is not configured" });
  try {
    const stored = await getPrivateObject("pickups/" + delivery.id + "/photo.jpg").catch(async () => getPrivateObject("pickups/" + delivery.id + "/photo.png"));
    res.setHeader("content-type", stored.contentType ?? "image/jpeg");
    res.setHeader("cache-control", "private, no-store");
    return res.send(stored.body);
  } catch {
    return res.status(404).json({ error: "Pickup photo not found" });
  }
});

app.get("/api/track/:trackingCode/pickup-photo", async (req, res) => {
  const code = String(routeParam(req.params.trackingCode, "trackingCode") ?? "").trim().toUpperCase();
  const receiverPhone = String(req.query.receiverPhone ?? "").trim();
  if (!receiverPhone) return res.status(400).json({ error: "receiverPhone is required" });
  const delivery = databaseEnabled()
    ? await findByTrackingCode(code)
    : [...deliveries.values()].find(d => d.trackingCode === code) ?? null;
  if (!delivery || delivery.receiverPhone !== receiverPhone || !delivery.pickupPhotoUrl) {
    return res.status(403).json({ error: "Tracking details could not be verified" });
  }
  if (!objectStorageEnabled && process.env.NODE_ENV === "production") return res.status(503).json({ error: "Private object storage is not configured" });
  try {
    const stored = await getPrivateObject("pickups/" + delivery.id + "/photo.jpg").catch(async () => getPrivateObject("pickups/" + delivery.id + "/photo.png"));
    res.setHeader("content-type", stored.contentType ?? "image/jpeg");
    res.setHeader("cache-control", "private, no-store");
    return res.send(stored.body);
  } catch {
    return res.status(404).json({ error: "Pickup photo not found" });
  }
});

app.post("/api/deliveries/:id/dropoff-proof", requireAuth("DRIVER"), async (req, res) => {
  const deliveryId = routeParam(req.params.id, "id");
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  const delivery = databaseEnabled() ? await findDelivery(deliveryId) : await getOne(deliveryId);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId || delivery.status !== "ARRIVED") {
    return res.status(409).json({ error: "Only the assigned driver may capture drop-off proof after arrival" });
  }
  const proofType = String(req.body?.proofType ?? "").trim().toUpperCase();
  if (!["PHOTO","SIGNATURE","BARCODE"].includes(proofType)) {
    return res.status(400).json({ error: "proofType must be PHOTO, SIGNATURE, or BARCODE" });
  }
  const required = Array.isArray(delivery.proofRequirements?.dropoff) ? delivery.proofRequirements.dropoff : ["PIN"];
  if (!required.includes(proofType)) {
    return res.status(409).json({ error: "This proof type is not required for this delivery" });
  }

  if (proofType === "BARCODE") {
    const value = String(req.body?.value ?? "").trim();
    if (!value || value.length > 256) return res.status(400).json({ error: "A valid barcode value is required" });
    if (databaseEnabled()) await saveDeliveryProof({ deliveryId, phase: "DROPOFF", proofType: "BARCODE", proofValue: value, metadata: { source: "driver" }, capturedByUserId: identity(req) });
    return res.status(201).json({ proofType, saved: true });
  }

  const dataUrl = String(req.body?.image ?? "");
  const match = dataUrl.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/i);
  if (!match) return res.status(400).json({ error: "A JPEG or PNG data URL is required" });
  const extension = match[1].toLowerCase() === "png" ? "png" : "jpg";
  const contentType = extension === "png" ? "image/png" : "image/jpeg";
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) return res.status(400).json({ error: "Image is empty" });
  if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: "Image is too large" });
  if (!objectStorageEnabled) {
    if (process.env.NODE_ENV === "production") return res.status(503).json({ error: "Private object storage is not configured" });
    return res.status(503).json({ error: "Proof image storage is not configured" });
  }
  const key = "proofs/" + deliveryId + "/" + proofType.toLowerCase() + "." + extension;
  await putPrivateObject(key, buffer, contentType);
  if (databaseEnabled()) await saveDeliveryProof({ deliveryId, phase: "DROPOFF", proofType: proofType as "PHOTO" | "SIGNATURE", storageKey: key, metadata: { contentType }, capturedByUserId: identity(req) });
  await recordDeliveryEvent({ deliveryId, eventType: "DROPOFF_PROOF_CAPTURED", actorUserId: identity(req), metadata: { proofType } });
  return res.status(201).json({ proofType, url: "/api/deliveries/" + encodeURIComponent(deliveryId) + "/proofs/" + proofType.toLowerCase() });
});

app.get("/api/deliveries/:id/proofs", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const user = (req as typeof req & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } }).user!;
  const deliveryId = routeParam(req.params.id, "id");
  const delivery = databaseEnabled() ? await findDeliveryForUser(deliveryId, user.userId, user.role) : await getOne(deliveryId);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const proofs = databaseEnabled() ? await listDeliveryProofs(deliveryId) : [];
  return res.json({ required: delivery.proofRequirements, proofs: proofs.map(proof => ({ id: proof.id, phase: proof.phase, proofType: proof.proofType, metadata: proof.metadata, createdAt: proof.createdAt, url: proof.storageKey ? "/api/deliveries/" + encodeURIComponent(deliveryId) + "/proofs/" + proof.proofType.toLowerCase() : undefined, proofValue: proof.proofType === "BARCODE" ? proof.proofValue : undefined })) });
});

app.get("/api/deliveries/:id/proofs/:type", requireAuth("CUSTOMER", "DRIVER", "ADMIN"), async (req, res) => {
  const user = (req as typeof req & { user?: { userId: string; role: "CUSTOMER" | "DRIVER" | "ADMIN" } }).user!;
  const deliveryId = routeParam(req.params.id, "id");
  const proofType = String(req.params.type ?? "").trim().toUpperCase();
  const delivery = databaseEnabled() ? await findDeliveryForUser(deliveryId, user.userId, user.role) : await getOne(deliveryId);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (!["PHOTO","SIGNATURE"].includes(proofType)) return res.status(400).json({ error: "Only image proofs can be retrieved" });
  const proof = (await listDeliveryProofs(deliveryId, "DROPOFF")).find(item => item.proofType === proofType);
  if (!proof?.storageKey) return res.status(404).json({ error: "Proof not found" });
  if (!objectStorageEnabled && process.env.NODE_ENV === "production") return res.status(503).json({ error: "Private object storage is not configured" });
  try {
    const stored = await getPrivateObject(proof.storageKey);
    res.setHeader("content-type", stored.contentType ?? "image/jpeg");
    res.setHeader("cache-control", "private, no-store");
    return res.send(stored.body);
  } catch {
    return res.status(404).json({ error: "Proof not found" });
  }
});

app.post("/api/deliveries/:id/pickup", requireAuth("DRIVER"), async (req, res) => {
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  const photo = String(req.body?.pickupPhotoUrl ?? "");
  if (!photo || !photo.startsWith("/api/deliveries/" + routeParam(req.params.id, "id") + "/pickup-photo")) return res.status(400).json({ error: "A valid pickup parcel photo is required" });
  if (databaseEnabled()) {
    const updated = await savePickupPhoto(routeParam(req.params.id, "id"), driverId, photo);
    if (!updated) return res.status(409).json({ error: "Driver must be assigned and at pickup before confirming pickup" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "PICKED_UP", actorUserId: identity(req), metadata: { pickupPhotoUrl: photo } });
    await notificationForDelivery(updated.id, updated.senderId, "Parcel picked up", "Your parcel has been picked up and the pickup photo is available.", "PICKED_UP");
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(routeParam(req.params.id, "id"));
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
    const updated = await transitionDelivery(routeParam(req.params.id, "id"), "PICKED_UP", "IN_TRANSIT", driverId);
    if (!updated) return res.status(409).json({ error: "Parcel must be picked up first or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "IN_TRANSIT", actorUserId: identity(req), metadata: {} });
    await notificationForDelivery(updated.id, updated.senderId, "Parcel is moving", "Your parcel is now in transit. Live tracking is active.", "IN_TRANSIT");
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "PICKED_UP") return res.status(409).json({ error: "Parcel must be picked up first" });
  delivery.status = "IN_TRANSIT"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/location", requireAuth("DRIVER"), async (req, res) => {
  const delivery = await getOne(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  const now = Date.now();
  const rateKey = delivery.id + ":" + driverId;
  const previous = locationRateLimit.get(rateKey) ?? 0;
  if (now - previous < LOCATION_MIN_INTERVAL_MS) {
    return res.status(429).json({ error: "Location update rate exceeded", retryAfterMs: LOCATION_MIN_INTERVAL_MS - (now - previous) });
  }
  const event = {
    deliveryId: delivery.id, driverId,
    latitude: Number(req.body?.latitude), longitude: Number(req.body?.longitude),
    accuracyMeters: req.body?.accuracyMeters == null ? undefined : Number(req.body?.accuracyMeters),
    recordedAt: new Date(now).toISOString()
  };
  const error = validateLocationEvent(event, delivery.driverId ?? "", delivery.status);
  if (error) return res.status(403).json({ error });
  locationRateLimit.set(rateKey, now);
  if (databaseEnabled()) await recordPersistentLocation(event); else recordLocation(event);
  publishDeliveryLocation(delivery.id, event);
  res.status(201).json(event);
});

app.post("/api/deliveries/:id/arrived", requireAuth("DRIVER"), async (req, res) => {
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Authenticated driver profile not found" });
  if (databaseEnabled()) {
    const updated = await transitionDelivery(routeParam(req.params.id, "id"), "IN_TRANSIT", "ARRIVED", driverId);
    if (!updated) return res.status(409).json({ error: "Delivery is not in transit or driver is not assigned" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "ARRIVED", actorUserId: identity(req), metadata: {} });
    await notificationForDelivery(updated.id, updated.senderId, "Driver has arrived", "Your driver has arrived at the delivery location.", "ARRIVED");
    return res.json(safeDelivery(updated));
  }
  const delivery = deliveries.get(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  if (delivery.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (delivery.status !== "IN_TRANSIT") return res.status(409).json({ error: "Delivery is not in transit" });
  delivery.status = "ARRIVED"; delivery.updatedAt = new Date().toISOString();
  publishDeliveryUpdate(delivery.id, safeDelivery(delivery));
  res.json(safeDelivery(delivery));
});

app.post("/api/deliveries/:id/complete", requireAuth("DRIVER"), async (req, res) => {
  const driverId = await authenticatedDriverId(req);
  if (!driverId) return res.status(403).json({ error: "Only KYC-verified drivers can manage deliveries" });
  const current = databaseEnabled() ? await findDelivery(routeParam(req.params.id, "id")) : deliveries.get(routeParam(req.params.id, "id"));
  if (!current || current.driverId !== driverId) return res.status(403).json({ error: "Driver is not assigned to this delivery" });
  if (current.status !== "ARRIVED") return res.status(409).json({ error: "Driver must mark the parcel arrived before receiver confirmation" });
  return res.status(409).json({ error: "Receiver confirmation is required to complete delivery and release payment" });
});

app.post("/api/deliveries/:id/receiver-confirm", async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Receiver confirmation requires the production database" });
  const receiverPhone = String(req.body?.receiverPhone ?? "").trim();
  const receiverPin = String(req.body?.receiverPin ?? "").trim();
  if (!receiverPhone || !/^\d{6}$/.test(receiverPin)) return res.status(400).json({ error: "Receiver phone and six-digit PIN are required" });

  // Buy & Deliver has its own escrow record; do not route it through the normal delivery payment table.
  const buyOrderResult = await pool!.query(
    "SELECT bo.*, d.status AS delivery_status, d.driver_id FROM buy_orders bo JOIN deliveries d ON d.id=bo.delivery_id WHERE bo.delivery_id=$1 FOR UPDATE OF bo, d",
    [routeParam(req.params.id, "id")]
  );
  const buyOrder = buyOrderResult.rows[0];
  if (buyOrder) {
    if (buyOrder.receiver_phone !== receiverPhone) {
      return res.status(403).json({ error: "Receiver details could not be verified" });
    }
    const pinKey = "buy-confirm:" + buyOrder.id + ":" + receiverPhone;
    const pinRate = checkReceiverPinRate(pinKey);
    if (!pinRate.allowed) {
      return res.status(429).json({ error: "Too many PIN attempts. Try again later.", retryAfterMs: pinRate.retryAfterMs });
    }
    if (!await verifyReceiverPin(buyOrder.delivery_id, receiverPin)) {
      recordReceiverPinFailure(pinKey);
      return res.status(403).json({ error: "Receiver details could not be verified" });
    }
    clearReceiverPinFailures(pinKey);
    if (buyOrder.payment_status !== "HELD") return res.status(409).json({ error: "Buy & Deliver payment is not currently held for release" });
    if (buyOrder.delivery_status !== "ARRIVED" || !buyOrder.driver_id) return res.status(409).json({ error: "The courier must arrive before receiver confirmation" });
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      const locked = (await client.query(
        "SELECT bo.*, d.status AS delivery_status, d.driver_id FROM buy_orders bo JOIN deliveries d ON d.id=bo.delivery_id WHERE bo.id=$1 FOR UPDATE OF bo, d",
        [buyOrder.id]
      )).rows[0];
      if (!locked || locked.payment_status !== "HELD" || locked.delivery_status !== "ARRIVED") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Buy & Deliver order changed before receiver confirmation" });
      }
      const updatedDelivery = (await client.query(
        "UPDATE deliveries SET status='DELIVERED', updated_at=now() WHERE id=$1 AND status='ARRIVED' RETURNING *",
        [locked.delivery_id]
      )).rows[0];
      if (!updatedDelivery) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Delivery is no longer awaiting receiver confirmation" });
      }
      await client.query(
        "UPDATE drop_off_parcels SET status='COMPLETED', completed_at=now(), updated_at=now() WHERE delivery_id=$1 AND status='COURIER_COLLECTED'",
        [locked.delivery_id]
      );
      await client.query(
        "INSERT INTO buy_order_settlements (buy_order_id,agent_id,amount_minor,currency,status) VALUES ($1,$2,$3,$4,'PENDING') ON CONFLICT (buy_order_id) DO NOTHING",
        [locked.id, locked.agent_id, Number(locked.actual_purchase_minor ?? 0), locked.currency ?? "NGN"]
      );
      await client.query(
        "UPDATE buy_order_payments SET status='RELEASED', updated_at=now() WHERE buy_order_id=$1 AND status='HELD'",
        [locked.id]
      );
      await client.query(
        "UPDATE buy_orders SET payment_status='RELEASED', status='DELIVERED', updated_at=now() WHERE id=$1 AND payment_status='HELD'",
        [locked.id]
      );
      await client.query(
        "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,NULL,'PAYMENT_RELEASED',$2::jsonb)",
        [locked.id, JSON.stringify({ deliveryId: locked.delivery_id, receiverPhoneVerified: true, releaseReason: "receiver_pin_confirmed" })]
      );
      await client.query(
        "INSERT INTO delivery_events (delivery_id,event_type,actor_user_id,metadata) VALUES ($1,'RECEIVER_CONFIRMED_DELIVERY',$2,$3::jsonb)",
        [locked.delivery_id, identity(req), JSON.stringify({ buyOrderId: locked.id, escrowReleased: true })]
      );
      await client.query("UPDATE drop_off_commission_ledger SET status='AVAILABLE', updated_at=now() WHERE parcel_id IN (SELECT id FROM drop_off_parcels WHERE delivery_id=$1) AND status='EARNED'", [locked.delivery_id]);
      await client.query("COMMIT");
      await notificationForDelivery(locked.delivery_id, locked.customer_user_id, "Delivery confirmed", "The receiver confirmed receipt. Your Buy & Deliver payment has been released.", "DELIVERED");
      publishDeliveryUpdate(locked.delivery_id, safeDelivery(updatedDelivery));
      return res.json({ delivery: safeDelivery(updatedDelivery), buyOrderId: locked.id, escrowStatus: "RELEASED" });
    } catch (error) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: error instanceof Error ? error.message : "Unable to release Buy & Deliver payment" });
    } finally {
      client.release();
    }
  }

  const receiverPaymentDelivery = await findDelivery(routeParam(req.params.id, "id"));
  if (receiverPaymentDelivery?.paymentMode === "RECEIVER_ON_DELIVERY") {
    if (receiverPaymentDelivery.status !== "ARRIVED") return res.status(409).json({ error: "The courier must arrive before receiver confirmation." });
    if (receiverPaymentDelivery.receiverPhone !== receiverPhone) return res.status(403).json({ error: "Receiver details could not be verified" });
    const pinKey = "receiver-payment:" + receiverPaymentDelivery.id + ":" + receiverPhone;
    const pinRate = checkReceiverPinRate(pinKey);
    if (!pinRate.allowed) return res.status(429).json({ error: "Too many PIN attempts. Try again later.", retryAfterMs: pinRate.retryAfterMs });
    if (!await verifyReceiverPin(receiverPaymentDelivery.id, receiverPin)) {
      recordReceiverPinFailure(pinKey);
      return res.status(403).json({ error: "Receiver details could not be verified" });
    }
    clearReceiverPinFailures(pinKey);
    const confirmed = await confirmReceiverOnDeliveryPaymentDue(receiverPaymentDelivery.id, receiverPhone, receiverPin);
    if (!confirmed) return res.status(409).json({ error: "Receiver confirmation has already been recorded or the payment is no longer awaiting collection." });
    await notificationForDelivery(
      confirmed.id,
      confirmed.senderId,
      "Receiver confirmed package",
      "The receiver confirmed the package. Payment is now due from the receiver before courier payout.",
      "RECEIVER_PAYMENT_DUE"
    );
    return res.status(200).json({
      delivery: safeDelivery(confirmed),
      paymentMode: "RECEIVER_ON_DELIVERY",
      paymentRequired: true,
      amountMinor: confirmed.quote?.totalMinor ?? 0,
      message: "Package receipt confirmed. The receiver must now complete payment."
    });
  }

  const payment = await findPayment(routeParam(req.params.id, "id"));
  if (!payment || payment.status !== "HELD") return res.status(409).json({ error: "Payment is not currently held for delivery release" });
  const deliveryForPin = await findDelivery(routeParam(req.params.id, "id"));
  if (!deliveryForPin || deliveryForPin.receiverPhone !== receiverPhone) return res.status(403).json({ error: "Receiver details could not be verified" });
  const pinKey = "confirm:" + deliveryForPin.id + ":" + receiverPhone;
  const pinRate = checkReceiverPinRate(pinKey);
  if (!pinRate.allowed) return res.status(429).json({ error: "Too many PIN attempts. Try again later.", retryAfterMs: pinRate.retryAfterMs });
  if (!await verifyReceiverPin(deliveryForPin.id, receiverPin)) {
    recordReceiverPinFailure(pinKey);
    return res.status(403).json({ error: "Receiver details could not be verified" });
  }
  clearReceiverPinFailures(pinKey);
  try {
    const result = await confirmReceiverAndReleaseEscrow(
      routeParam(req.params.id, "id"),
      receiverPhone,
      receiverPin,
      Number(process.env.DRIVER_PAYOUT_PERCENT ?? 90)
    );
    if (!result) return res.status(403).json({ error: "Receiver details could not be verified or delivery is not awaiting confirmation" });
    await recordDeliveryEvent({
      deliveryId: result.delivery.id,
      eventType: "RECEIVER_CONFIRMED_DELIVERY",
      metadata: { receiverPhoneVerified: true, escrowReleased: true, payoutEligible: result.payoutAmountMinor > 0 }
    });
    await pool!.query(
      "UPDATE drop_off_parcels SET status='COMPLETED', completed_at=now(), updated_at=now() WHERE delivery_id=$1 AND status='COURIER_COLLECTED'",
      [result.delivery.id]
    );
    await pool!.query(
      "UPDATE drop_off_commission_ledger SET status='AVAILABLE', updated_at=now() WHERE parcel_id IN (SELECT id FROM drop_off_parcels WHERE delivery_id=$1) AND status='EARNED'",
      [result.delivery.id]
    );
    await notificationForDelivery(result.delivery.id, result.delivery.senderId, "Delivery confirmed", "The receiver confirmed receipt. Your held payment has been released for courier payout.", "DELIVERED");
    if (result.delivery.driverId) {
      const driver = await driverForUser(result.delivery.driverId);
      if (driver) await notificationForDelivery(result.delivery.id, driver.userId, "Payment released", "The receiver confirmed receipt. Your courier payout is now eligible.", "PAYOUT_ELIGIBLE");
    }
    publishDeliveryUpdate(result.delivery.id, safeDelivery(result.delivery));
    return res.json({ delivery: safeDelivery(result.delivery), payoutAmountMinor: result.payoutAmountMinor, escrowStatus: "RELEASED" });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unable to confirm delivery" });
  }
});

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = res.getHeader("x-request-id");
  console.error(JSON.stringify({
    event: "http_error",
    requestId: typeof requestId === "string" ? requestId : undefined,
    method: req.method,
    path: req.path,
    error: error instanceof Error ? error.message : "Unhandled request error"
  }));
  if (res.headersSent) return;
  return res.status(500).json({
    error: "Internal server error",
    requestId: typeof requestId === "string" ? requestId : undefined
  });
});

attachRealtime(httpServer);
const port = Number(process.env.API_PORT || 4000);


async function reconcileProcessingPaystackPayouts(): Promise<void> {
  if (!databaseEnabled()) return;
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return;

  const result = await pool!.query(
    `SELECT id, delivery_id, provider_reference, amount_minor, currency
       FROM payouts
      WHERE status='PROCESSING'
        AND provider='paystack'
        AND provider_reference IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT 25`
  );

  for (const payout of result.rows) {
    const reference = String(payout.provider_reference);
    try {
      const response = await fetch(
        "https://api.paystack.co/transfer/verify/" + encodeURIComponent(reference),
        { headers: { authorization: "Bearer " + secret }, signal: AbortSignal.timeout(10_000) }
      );
      const data = await response.json() as {
        status?: boolean;
        message?: string;
        data?: {
          reference?: string;
          status?: string;
          amount?: number;
          currency?: string;
          failures?: { message?: string; reason?: string } | null;
        };
      };

      if (!response.ok || !data.status || !data.data) continue;

      const providerStatus = String(data.data.status ?? "").toLowerCase();
      const providerReference = String(data.data.reference ?? reference);
      const providerAmount = data.data.amount == null ? undefined : Number(data.data.amount);
      const providerCurrency = data.data.currency ? String(data.data.currency) : undefined;

      if (providerStatus === "success") {
        const expectedAmount = Number(payout.amount_minor);
        const expectedCurrency = String(payout.currency);
        if (providerAmount !== expectedAmount || providerCurrency !== expectedCurrency) {
          await flagPayoutReconciliationMismatch(
            providerReference,
            `Paystack transfer amount/currency mismatch: expected ${expectedAmount} ${expectedCurrency}, received ${providerAmount ?? "unknown"} ${providerCurrency ?? "unknown"}`,
            providerAmount,
            providerCurrency
          );
          await recordDeliveryEvent({
            deliveryId: payout.delivery_id,
            eventType: "PAYOUT_RECONCILIATION_MISMATCH",
            metadata: { provider: "paystack", reference: providerReference, expectedAmount, expectedCurrency, providerAmount, providerCurrency, source: "reconciliation" }
          }).catch(() => {});
          continue;
        }
        await updatePayoutProviderStatus(providerReference, "RELEASED", null, providerAmount, providerCurrency);
        await recordDeliveryEvent({
          deliveryId: payout.delivery_id,
          eventType: "PAYOUT_RECONCILED_RELEASED",
          metadata: { provider: "paystack", reference: providerReference, source: "reconciliation" }
        }).catch(() => {});
      } else if (providerStatus === "failed" || providerStatus === "reversed") {
        const reason = data.data.failures?.message ?? data.data.failures?.reason ?? data.message ?? "Paystack transfer failed";
        await updatePayoutProviderStatus(providerReference, providerStatus === "reversed" ? "CANCELLED" : "FAILED", reason, providerAmount, providerCurrency);
        await recordDeliveryEvent({
          deliveryId: payout.delivery_id,
          eventType: "PAYOUT_RECONCILED_FAILED",
          metadata: { provider: "paystack", reference: providerReference, providerStatus, reason, source: "reconciliation" }
        }).catch(() => {});
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "paystack_payout_reconciliation_error",
        payoutId: payout.id,
        providerReference: reference,
        error: error instanceof Error ? error.message : "unknown"
      }));
    }
  }
}

async function startServer() {
  validateProductionConfig();
  if (databaseEnabled()) {
    await runMigrations();
    void processNotificationOutbox().catch(() => {});
    void processNotificationPushReceipts().catch(() => {});
    void reconcileProcessingPaystackPayouts().catch(() => {});
    void reconcileProcessingBuyOrderSettlements().catch(() => {});
    void reconcileProcessingDropOffCommissions().catch(() => {});
    void processSupportAiBatch().catch(() => {});
    void processRecurringDispatches().catch(() => {});
    const supportAiWorker = setInterval(() => {
      void processSupportAiBatch().catch(() => {});
    }, 5000);
    const notificationWorker = setInterval(() => {
      void processNotificationOutbox().catch(() => {});
    }, 5000);
    const recurringDispatchWorker = setInterval(() => {
      void processRecurringDispatches().catch(() => {});
    }, 60_000);
    const notificationReceiptWorker = setInterval(() => {
      void processNotificationPushReceipts().catch(() => {});
    }, 60_000);
    const buyOrderSettlementReconciliationWorker = setInterval(() => {
      void reconcileProcessingBuyOrderSettlements().catch(() => {});
    }, 60_000);
    const dropOffCommissionReconciliationWorker = setInterval(() => {
      void reconcileProcessingDropOffCommissions().catch(() => {});
    }, 60_000);
    const payoutReconciliationWorker = setInterval(() => {
      void reconcileProcessingPaystackPayouts().catch(() => {});
    }, 60_000);
    const marketplacePaymentReconciliationWorker = setInterval(() => {
      void reconcileCancelledMarketplacePayments().catch(() => {});
    }, 30_000);
    const buyOrderPaymentReconciliationWorker = setInterval(() => {
      void reconcilePendingBuyOrderPayments().catch(() => {});
    }, 30_000);
    buyOrderPaymentReconciliationWorker.unref();
    supportAiWorker.unref();
    notificationWorker.unref();
    notificationReceiptWorker.unref();
    payoutReconciliationWorker.unref();
    marketplacePaymentReconciliationWorker.unref();
    dropOffCommissionReconciliationWorker.unref();
    buyOrderSettlementReconciliationWorker.unref();
    recurringDispatchWorker.unref();
  }
  httpServer.listen(port, () => console.log(`SwiftDrop API listening on port ${port}`));
}

startServer().catch(error => {
  console.error("SwiftDrop API startup failed:", error);
  process.exit(1);
});
