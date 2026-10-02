import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { attachRealtime, publishDeliveryLocation, publishDeliveryUpdate, issueTrackingToken } from "./realtime.js";
import { getLatestLocation, recordLocation } from "./trackingStore.js";
import { validateLocationEvent } from "./tracking.js";
import { databaseEnabled, createPersistentDelivery, findDelivery, findDeliveryForUser, findByTrackingCode, listOpenJobs, transitionDelivery, savePickupPhoto, verifyReceiverPin, completeDelivery, recordPersistentLocation, latestPersistentLocation, driverForUser, recordDeliveryEvent, listDeliveryEvents, findPayment, createPayment, updatePaymentStatus, markPaymentRefund, confirmReceiverAndReleaseEscrow, findPayoutByProviderReference, claimPaystackWebhookEvent, retryFailedPayout, flagPayoutReconciliationMismatch } from "./database/deliveryRepository.js";
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
import { processSupportAiBatch } from "./supportAiAgent.js";
import recurringDispatchRoutes from "./recurringDispatchRoutes.js";
import deliveryExceptionRoutes from "./deliveryExceptionRoutes.js";
import { processRecurringDispatches } from "./recurringDispatchWorker.js";
import { getActivePricingConfig } from "./pricing.js";
import { reconcileProcessingBuyOrderSettlements } from "./buyOrderSettlementWorker.js";
import { reconcileProcessingDropOffCommissions } from "./dropOffCommissionWorker.js";

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
app.use("/api", recurringDispatchRoutes);
app.use("/api", deliveryExceptionRoutes);

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
  status: Status; driverId?: string; pickupPhotoUrl?: string; receiverPin: string;
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
  senderId: z.string().uuid().optional(), receiverName: z.string().min(1), receiverPhone: z.string().min(7),
  receiverPin: z.string().regex(/^\d{6}$/, "Receiver PIN must be exactly 6 digits"),
  weightKg: z.number().positive().max(1000),
  dimensionsCm: z.object({ length: z.number().positive().max(300), width: z.number().positive().max(300), height: z.number().positive().max(300) }),
  isPerishable: z.boolean(),
  declaredValueMinor: z.number().int().positive().max(10000000000),
  pickup: z.object({ label: z.string(), formattedAddress: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  dropoff: z.object({ label: z.string(), formattedAddress: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  pickupDropOffLocationId: z.string().uuid().optional(),
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
