import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { attachRealtime, publishDeliveryLocation, publishDeliveryUpdate, issueTrackingToken } from "./realtime.js";
import { getLatestLocation, recordLocation } from "./trackingStore.js";
import { validateLocationEvent } from "./tracking.js";
import { databaseEnabled, createPersistentDelivery, findDelivery, findDeliveryForUser, findByTrackingCode, listOpenJobs, transitionDelivery, savePickupPhoto, verifyReceiverPin, completeDelivery, recordPersistentLocation, latestPersistentLocation, driverForUser, recordDeliveryEvent, listDeliveryEvents, findPayment, createPayment, updatePaymentStatus, savePaymentAuthorization, markPaymentRefund, confirmReceiverAndReleaseEscrow, findPayoutByProviderReference, claimPaystackWebhookEvent, retryFailedPayout } from "./database/deliveryRepository.js";
import { pool, pingDatabase } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { assignNextDeliveryToDriver, setDriverOnline, createEligiblePayout, findPayout, cancelEligiblePayoutForRefund, createDispute, createReceiverDispute, findDispute, resolveDispute, createSupportTicket, listSupportTickets, resolveSupportTicket, getDriverPayoutAccount, saveDriverPayoutAccount, setPayoutProcessing, setPayoutProviderReference, markPayoutFailed, markPayoutReleased, updatePayoutProviderStatus, recordAdminCaseAudit, listAdminCaseAudit, markDisputeUnderReview, prepareRefund, releaseDisputeAndCreatePayout, recordFailedDeliveryAttempt, rescheduleDelivery, listDeliveryAttempts, createBusinessAccount, attachDeliveryToBusiness, listBusinessReadyDeliveries, dispatchBusinessDelivery, getBusinessAiRules, reserveBusinessSpend, releaseBusinessSpend } from "./database/deliveryRepository.js";
import { requireAuth } from "./authMiddleware.js";
import authRoutes from "./authRoutes.js";
import { identity } from "./requestIdentity.js";
import { validateProductionConfig } from "./productionConfig.js";
import { ensureAiDefaults, getAiPermission, updateAiPermission, auditAiAction, evaluateAiPayment, reserveAiSpend, releaseAiSpend, getAiAccess, consumeAiChatCredit, type AiMode } from "./aiPolicy.js";
import { executeAiAction } from "./aiExecutor.js";
import { getPrivateObject, objectStorageEnabled, putPrivateObject } from "./storage.js";
import { enqueueNotification, processNotificationOutbox, processNotificationPushReceipts } from "./notificationOutbox.js";

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

async function hasIndividualPremium(userId: string): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    `INSERT INTO user_plans (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING individual_plan`,
    [userId]
  );
  if (result.rows[0]) return result.rows[0].individual_plan === "PREMIUM";
  const current = await pool.query("SELECT individual_plan FROM user_plans WHERE user_id=$1", [userId]);
  return current.rows[0]?.individual_plan === "PREMIUM";
}

async function hasBusinessPremium(userId: string): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    `SELECT up.business_plan
       FROM user_plans up
      WHERE up.user_id=$1
        AND up.business_plan='PREMIUM'`,
    [userId]
  );
  return result.rows.length > 0;
}

app.post("/api/business/profile", requireAuth("CUSTOMER"), async (req,res)=>{
 if(!databaseEnabled()) return res.status(503).json({error:"Business profile requires the production database"});
 const name=String(req.body?.name??"").trim();
 if(name.length<2||name.length>120) return res.status(400).json({error:"Business name is required"});
 try{return res.status(201).json({business:await createBusinessAccount(identity(req),name)});}catch{return res.status(500).json({error:"Unable to create business profile"});}
});
app.post("/api/business/deliveries/:id/queue", requireAuth("CUSTOMER"), async (req,res)=>{
 if(!databaseEnabled()) return res.status(503).json({error:"Business dispatch requires the production database"});
 const priority=Number(req.body?.priority??0), scheduledFor=req.body?.scheduledFor?String(req.body.scheduledFor):undefined;
 if(!Number.isInteger(priority)||priority<0||priority>100)return res.status(400).json({error:"Invalid priority"});
 try{
  const b=await pool!.query("SELECT id FROM business_accounts WHERE owner_user_id=$1 AND status='ACTIVE' LIMIT 1",[identity(req)]);
  if(!b.rows[0])return res.status(404).json({error:"Business profile not found"});
  const d=await findDeliveryForUser(routeParam(req.params.id,"id"),identity(req),"CUSTOMER");
  if(!d)return res.status(404).json({error:"Delivery not found"});
  const item=await attachDeliveryToBusiness(b.rows[0].id,d.id,priority,scheduledFor);
  return item?res.status(201).json({item}):res.status(409).json({error:"Unable to queue delivery"});
 }catch{return res.status(500).json({error:"Unable to queue business delivery"});}
});
app.get("/api/business/dispatch/ready", requireAuth("CUSTOMER"), async(req,res)=>{
 if(!databaseEnabled())return res.status(503).json({error:"Business dispatch requires the production database"});
 try{const b=await pool!.query("SELECT id FROM business_accounts WHERE owner_user_id=$1 AND status='ACTIVE' LIMIT 1",[identity(req)]);if(!b.rows[0])return res.status(404).json({error:"Business profile not found"});return res.json({deliveries:await listBusinessReadyDeliveries(b.rows[0].id)});}catch{return res.status(500).json({error:"Unable to load business dispatch queue"});}
});
app.get("/api/me/product-profile", requireAuth("CUSTOMER", "DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Product profile requires the production database" });
  const userId = identity(req);
  try {
    const result = await pool!.query(
      `INSERT INTO user_plans (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at=now()
       RETURNING user_id, individual_plan, business_plan`,
      [userId]
    );
    const business = await pool!.query(
      `SELECT id, name, status FROM business_accounts WHERE owner_user_id=$1 LIMIT 1`,
      [userId]
    );
    return res.json({ plan: result.rows[0], business: business.rows[0] ?? null });
  } catch {
    return res.status(500).json({ error: "Unable to load product profile" });
  }
});

app.post("/api/business/dispatch/run", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Business dispatch requires the production database" });
  if (!await hasBusinessPremium(identity(req))) return res.status(403).json({ error: "Business Premium is required for AI dispatch" });
  const parsed = z.object({
    deliveryIds: z.array(z.string().uuid()).min(1).max(100),
    approved: z.boolean().default(false)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const businessResult = await pool!.query(
      "SELECT id FROM business_accounts WHERE owner_user_id=$1 AND status='ACTIVE' LIMIT 1",
      [identity(req)]
    );
    if (!businessResult.rows[0]) return res.status(404).json({ error: "Business profile not found" });

    const businessId = businessResult.rows[0].id;
    const rules = await getBusinessAiRules(businessId);
    if (!rules) return res.status(409).json({ error: "Business AI rules are not configured" });

    const ready = await listBusinessReadyDeliveries(businessId);
    const readyMap = new Map(ready.map(item => [item.delivery.id, item]));
    const results: Array<Record<string, unknown>> = [];
    let estimatedTotal = 0;

    for (const deliveryId of parsed.data.deliveryIds) {
      const item = readyMap.get(deliveryId);
      if (!item) {
        results.push({ deliveryId, status: "SKIPPED", reason: "Not ready or not eligible" });
        continue;
      }
      const amount = Number(item.delivery.quote?.totalMinor ?? 0);
      if (!Number.isInteger(amount) || amount <= 0) {
        results.push({ deliveryId, status: "SKIPPED", reason: "Delivery has no valid server quote" });
        continue;
      }
      if (rules.maxDeliveryCostMinor != null && amount > rules.maxDeliveryCostMinor) {
        results.push({ deliveryId, status: "SKIPPED", reason: "Exceeds Business AI maximum delivery cost" });
        continue;
      }
      estimatedTotal += amount;
    }

    if (rules.approvalThresholdMinor > 0 && estimatedTotal > rules.approvalThresholdMinor && !parsed.data.approved) {
      await auditAiAction({
        userId: identity(req),
        actionType: "BUSINESS_DISPATCH",
        status: "PREPARED",
        amountMinor: estimatedTotal,
        targetType: "BUSINESS",
        targetId: businessId,
        details: { reason: "Approval threshold exceeded", deliveryIds: parsed.data.deliveryIds }
      });
      return res.status(202).json({ requiresApproval: true, estimatedTotalMinor: estimatedTotal, results });
    }

    const reserved = estimatedTotal === 0 || await reserveBusinessSpend(businessId, estimatedTotal);
    if (!reserved) {
      await auditAiAction({
        userId: identity(req),
        actionType: "BUSINESS_DISPATCH",
        status: "REJECTED",
        amountMinor: estimatedTotal,
        targetType: "BUSINESS",
        targetId: businessId,
        details: { reason: "Daily Business AI spending limit would be exceeded" }
      });
      return res.status(403).json({ error: "Daily Business AI spending limit would be exceeded" });
    }

    let spent = 0;
    try {
      for (const deliveryId of parsed.data.deliveryIds) {
        const item = readyMap.get(deliveryId);
        if (!item) continue;
        const amount = Number(item.delivery.quote?.totalMinor ?? 0);
        if (!Number.isInteger(amount) || amount <= 0) continue;
        if (rules.maxDeliveryCostMinor != null && amount > rules.maxDeliveryCostMinor) continue;

        const delivery = await dispatchBusinessDelivery(businessId, deliveryId, rules.preferredVehicle ?? undefined);
        if (delivery) {
          spent += amount;
          results.push({ deliveryId, status: "DISPATCHED", driverId: delivery.driverId });
        } else {
          results.push({ deliveryId, status: "SKIPPED", reason: "No eligible courier available" });
        }
      }

      const unused = estimatedTotal - spent;
      if (unused > 0) await releaseBusinessSpend(businessId, unused);

      await auditAiAction({
        userId: identity(req),
        actionType: "BUSINESS_DISPATCH",
        status: "EXECUTED",
        amountMinor: spent,
        targetType: "BUSINESS",
        targetId: businessId,
        details: {
          results,
          rules: {
            preferredVehicle: rules.preferredVehicle,
            maxDeliveryCostMinor: rules.maxDeliveryCostMinor,
            approvalThresholdMinor: rules.approvalThresholdMinor
          }
        }
      });
      return res.json({ requiresApproval: false, estimatedTotalMinor: estimatedTotal, spentMinor: spent, results });
    } catch (error) {
      const unused = estimatedTotal - spent;
      if (unused > 0) await releaseBusinessSpend(businessId, unused);
      const message = error instanceof Error ? error.message : "Unable to run business dispatch";
      await auditAiAction({
        userId: identity(req),
        actionType: "BUSINESS_DISPATCH",
        status: "FAILED",
        amountMinor: spent,
        targetType: "BUSINESS",
        targetId: businessId,
        details: { error: message }
      });
      return res.status(500).json({ error: message });
    }
  } catch {
    return res.status(500).json({ error: "Unable to run business dispatch" });
  }
});
app.get("/api/ai/access", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "AI access requires the production database" });
  try {
    return res.json({ access: await getAiAccess(identity(req)) });
  } catch {
    return res.status(500).json({ error: "Unable to load AI access" });
  }
});

app.post("/api/ai/chat", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "AI chat requires the production database" });
  const message = String(req.body?.message ?? "").trim();
  if (message.length < 1 || message.length > 2000) return res.status(400).json({ error: "A message between 1 and 2000 characters is required" });
  try {
    const access = await getAiAccess(identity(req));
    if (access.remainingChatCredits <= 0) return res.status(429).json({
      error: "Your Swift AI chat credits are used up for this month",
      plan: access.plan,
      monthlyChatCredits: access.monthlyChatCredits
    });
    const credit = await consumeAiChatCredit(identity(req));
    const normalized = message.toLowerCase();
    let suggestedAction: string | null = null;
    if (/(track|where.*parcel|where.*delivery|location|moving)/.test(normalized)) suggestedAction = "GET_TRACKING";
    else if (/(status|delivered|delivery.*status)/.test(normalized)) suggestedAction = "GET_DELIVERY_STATUS";
    else if (/(support|help|problem|issue)/.test(normalized)) suggestedAction = "CONTACT_SUPPORT";
    else if (/(reschedule|change.*delivery.*time)/.test(normalized)) suggestedAction = "RESCHEDULE_DELIVERY";
    else if (/(pay|payment|pay for)/.test(normalized)) suggestedAction = "PAY_DELIVERY";

    const premiumOnly = suggestedAction === "PAY_DELIVERY" || suggestedAction === "RESCHEDULE_DELIVERY";
    if (premiumOnly && access.plan === "BASIC") {
      return res.json({
        reply: "That Swift AI tool is available on Individual Premium. On Basic, I can help you track deliveries, check delivery status, and contact support.",
        suggestedAction: null,
        access: { ...access, remainingChatCredits: credit.remaining }
      });
    }
    return res.json({
      reply: suggestedAction
        ? `I can help with that. Choose the suggested Swift AI action to continue.`
        : "I can help you track a delivery, check its status, or contact SwiftDrop support. Individual Premium also adds rescheduling and payment actions.",
      suggestedAction,
      access: { ...access, remainingChatCredits: credit.remaining }
    });
  } catch (error) {
    return res.status(429).json({ error: error instanceof Error ? error.message : "Unable to use AI chat" });
  }
});

app.get("/api/ai/permissions", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "AI permissions require the production database" });
  if (!await hasIndividualPremium(identity(req))) return res.status(403).json({ error: "Individual Premium is required for Swift AI" });
  try {
    return res.json({ permissions: await getAiPermission(identity(req)) });
  } catch {
    return res.status(500).json({ error: "Unable to load AI permissions" });
  }
});

app.patch("/api/ai/permissions", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "AI permissions require the production database" });
  if (!await hasIndividualPremium(identity(req))) return res.status(403).json({ error: "Individual Premium is required for Swift AI" });
  const parsed = z.object({
    mode: z.enum(["ASSIST", "AUTHORIZED", "AUTONOMOUS"]).optional(),
    autoPayEnabled: z.boolean().optional(),
    autoPayLimitMinor: z.number().int().min(0).max(100_000_000).optional(),
    dailySpendLimitMinor: z.number().int().min(0).max(500_000_000).optional(),
    preferredVehicle: z.string().trim().max(40).nullable().optional(),
    maxDeliveryCostMinor: z.number().int().min(0).max(100_000_000).nullable().optional(),
    approvalThresholdMinor: z.number().int().min(0).max(100_000_000).nullable().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.mode === "AUTONOMOUS" && !parsed.data.autoPayEnabled) {
    return res.status(400).json({ error: "Autonomous mode requires automatic payments to be explicitly enabled" });
  }
  try {
    const permissions = await updateAiPermission(identity(req), { ...parsed.data, preferredVehicle: parsed.data.preferredVehicle ?? undefined, maxDeliveryCostMinor: parsed.data.maxDeliveryCostMinor ?? undefined, approvalThresholdMinor: parsed.data.approvalThresholdMinor ?? undefined });
    await auditAiAction({ userId: identity(req), actionType: "UPDATE_AI_PERMISSIONS", status: "EXECUTED", details: { mode: permissions.mode } });
    return res.json({ permissions });
  } catch {
    return res.status(500).json({ error: "Unable to update AI permissions" });
  }
});

app.post("/api/ai/actions", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "AI actions require the production database" });
  const aiAccess = await getAiAccess(identity(req));
  const actionProbe = String(req.body?.actionType ?? "").trim().toUpperCase();
  if (!aiAccess.allowedActions.includes(actionProbe)) {
    return res.status(403).json({ error: "This Swift AI tool is not available on your current plan", plan: aiAccess.plan, allowedActions: aiAccess.allowedActions });
  }
  const parsed = z.object({
    actionType: z.string().trim().min(2).max(80),
    amountMinor: z.number().int().positive().max(500_000_000).optional(),
    targetType: z.string().trim().max(80).optional(),
    targetId: z.string().uuid().optional(),
    approved: z.boolean().default(false),
    details: z.record(z.string(), z.unknown()).default({})
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = identity(req);
  const actionType = parsed.data.actionType.trim().toUpperCase();
  const paymentAction = actionType === "PAY_DELIVERY";

  try {
    let effectiveAmount = parsed.data.amountMinor;
    if (paymentAction) {
      if (!parsed.data.targetId) return res.status(400).json({ error: "A delivery ID is required for PAY_DELIVERY" });
      const delivery = await findDeliveryForUser(parsed.data.targetId, userId, "CUSTOMER");
      if (!delivery) return res.status(404).json({ error: "Delivery not found" });
      effectiveAmount = delivery.quote?.totalMinor;
      if (!effectiveAmount || !Number.isSafeInteger(effectiveAmount) || effectiveAmount <= 0) {
        return res.status(409).json({ error: "Delivery does not have a valid server quote" });
      }
    } else if (parsed.data.amountMinor != null) {
      return res.status(400).json({ error: "Payment amounts are only accepted for PAY_DELIVERY and are derived from the server quote" });
    }

    const permissions = await getAiPermission(userId);
    const payment = effectiveAmount == null
      ? { allowed: true, requiresApproval: permissions.mode === "ASSIST", reason: permissions.mode === "ASSIST" ? "AI is configured for assisted actions" : undefined }
      : evaluateAiPayment(permissions, effectiveAmount);

    if (!payment.allowed) {
      const audit = await auditAiAction({
        userId, actionType, status: "REJECTED", amountMinor: effectiveAmount,
        targetType: parsed.data.targetType, targetId: parsed.data.targetId,
        details: { reason: payment.reason }
      });
      return res.status(403).json({ error: payment.reason ?? "AI action rejected", audit });
    }

    const requiresApproval = payment.requiresApproval && !parsed.data.approved;
    if (requiresApproval) {
      const audit = await auditAiAction({
        userId, actionType, status: "PREPARED", amountMinor: effectiveAmount,
        targetType: parsed.data.targetType, targetId: parsed.data.targetId,
        details: { ...parsed.data.details, requiresApproval: true, reason: payment.reason }
      });
      return res.status(201).json({ action: audit, requiresApproval: true, reason: payment.reason });
    }

    let spendReserved = false;
    let shouldReserveSpend = false;
    if (paymentAction && effectiveAmount != null) {
      const existing = await findPayment(parsed.data.targetId!);
      shouldReserveSpend = !(existing?.status === "PENDING" && Boolean(existing.authorizationUrl) && Boolean(existing.providerReference));
      if (shouldReserveSpend) {
        spendReserved = await reserveAiSpend(userId, effectiveAmount);
        if (!spendReserved) {
          const audit = await auditAiAction({
            userId, actionType, status: "REJECTED", amountMinor: effectiveAmount,
            targetType: parsed.data.targetType, targetId: parsed.data.targetId,
            details: { reason: "AI daily spending limit would be exceeded" }
          });
          return res.status(403).json({ error: "AI daily spending limit would be exceeded", audit });
        }
      }
    }

    try {
      const execution = await executeAiAction({
        userId,
        actionType,
        targetId: parsed.data.targetId,
        details: parsed.data.details,
        approved: parsed.data.approved
      });

      if (!execution.executed) {
        if (spendReserved) await releaseAiSpend(userId, effectiveAmount!);
        const audit = await auditAiAction({
          userId, actionType, status: "PREPARED", amountMinor: effectiveAmount,
          targetType: parsed.data.targetType, targetId: parsed.data.targetId,
          details: { ...parsed.data.details, requiresApproval: true, result: execution.result }
        });
        return res.status(201).json({ action: audit, requiresApproval: true });
      }

      const audit = await auditAiAction({
        userId, actionType, status: "EXECUTED", amountMinor: execution.amountMinor ?? effectiveAmount,
        targetType: parsed.data.targetType, targetId: execution.targetId ?? parsed.data.targetId,
        details: { ...parsed.data.details, requiresApproval: false, spendReserved, result: execution.result }
      });
      return res.status(201).json({ action: audit, requiresApproval: false, result: execution.result });
    } catch (error) {
      if (spendReserved) await releaseAiSpend(userId, effectiveAmount!);
      const message = error instanceof Error ? error.message : "AI action execution failed";
      const audit = await auditAiAction({
        userId, actionType, status: "FAILED", amountMinor: effectiveAmount,
        targetType: parsed.data.targetType, targetId: parsed.data.targetId,
        details: { ...parsed.data.details, error: message, spendReleased: spendReserved }
      });
      return res.status(409).json({ error: message, audit });
    }
  } catch {
    return res.status(500).json({ error: "Unable to evaluate AI action" });
  }
});

app.get("/api/ai/activity", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "AI activity requires the production database" });
  if (!await hasIndividualPremium(identity(req))) return res.status(403).json({ error: "Individual Premium is required for Swift AI" });
  const result = await pool!.query(
    `SELECT id, action_type, status, amount_minor, currency, target_type, target_id, details, created_at
       FROM ai_action_audit WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [identity(req)]
  );
  return res.json({ activity: result.rows });
});

app.post("/api/business", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Business accounts require the production database" });
  const parsed = z.object({ name: z.string().trim().min(2).max(160) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await pool!.query(
      `INSERT INTO business_accounts (owner_user_id, name) VALUES ($1,$2)
       ON CONFLICT (owner_user_id) DO UPDATE SET name=EXCLUDED.name, updated_at=now()
       RETURNING id, name, status`,
      [identity(req), parsed.data.name]
    );
    await pool!.query(`INSERT INTO business_ai_rules (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`, [result.rows[0].id]);
    return res.status(201).json({ business: result.rows[0] });
  } catch {
    return res.status(500).json({ error: "Unable to create business account" });
  }
});

app.get("/api/business/ai-rules", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Business AI requires the production database" });
  if (!await hasBusinessPremium(identity(req))) return res.status(403).json({ error: "Business Premium is required for Business AI" });
  const business = await pool!.query(`SELECT id FROM business_accounts WHERE owner_user_id=$1 LIMIT 1`, [identity(req)]);
  if (!business.rows[0]) return res.status(404).json({ error: "Business account not found" });
  const rules = await pool!.query(`SELECT * FROM business_ai_rules WHERE business_id=$1`, [business.rows[0].id]);
  return res.json({ businessId: business.rows[0].id, rules: rules.rows[0] ?? null });
});

app.patch("/api/business/ai-rules", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Business AI requires the production database" });
  if (!await hasBusinessPremium(identity(req))) return res.status(403).json({ error: "Business Premium is required for Business AI" });
  const parsed = z.object({
    autoDispatchEnabled: z.boolean().optional(),
    weekdaySchedule: z.string().trim().max(100).nullable().optional(),
    dailySpendLimitMinor: z.number().int().min(0).max(2_000_000_000).optional(),
    approvalThresholdMinor: z.number().int().min(0).max(2_000_000_000).optional(),
    maxDeliveryCostMinor: z.number().int().min(0).max(500_000_000).nullable().optional(),
    preferredVehicle: z.string().trim().max(40).nullable().optional(),
    autoReplaceCancelled: z.boolean().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const business = await pool!.query(`SELECT id FROM business_accounts WHERE owner_user_id=$1 LIMIT 1`, [identity(req)]);
  if (!business.rows[0]) return res.status(404).json({ error: "Business account not found" });
  const current = await pool!.query(`SELECT * FROM business_ai_rules WHERE business_id=$1`, [business.rows[0].id]);
  const row = current.rows[0] ?? {};
  const next = { autoDispatchEnabled: parsed.data.autoDispatchEnabled ?? Boolean(row.auto_dispatch_enabled), weekdaySchedule: parsed.data.weekdaySchedule === undefined ? row.weekday_schedule : parsed.data.weekdaySchedule, dailySpendLimitMinor: parsed.data.dailySpendLimitMinor ?? Number(row.daily_spend_limit_minor ?? 0), approvalThresholdMinor: parsed.data.approvalThresholdMinor ?? Number(row.approval_threshold_minor ?? 0), maxDeliveryCostMinor: parsed.data.maxDeliveryCostMinor === undefined ? (row.max_delivery_cost_minor == null ? null : Number(row.max_delivery_cost_minor)) : parsed.data.maxDeliveryCostMinor, preferredVehicle: parsed.data.preferredVehicle === undefined ? row.preferred_vehicle : parsed.data.preferredVehicle, autoReplaceCancelled: parsed.data.autoReplaceCancelled ?? Boolean(row.auto_replace_cancelled) };
  const updated = await pool!.query(
    `UPDATE business_ai_rules SET auto_dispatch_enabled=$2, weekday_schedule=$3, daily_spend_limit_minor=$4,
       approval_threshold_minor=$5, max_delivery_cost_minor=$6, preferred_vehicle=$7, auto_replace_cancelled=$8, updated_at=now()
     WHERE business_id=$1 RETURNING *`,
    [business.rows[0].id, next.autoDispatchEnabled, next.weekdaySchedule, next.dailySpendLimitMinor, next.approvalThresholdMinor, next.maxDeliveryCostMinor, next.preferredVehicle, next.autoReplaceCancelled]
  );
  return res.json({ rules: updated.rows[0] });
});

app.post("/api/agents/apply", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Agent applications require the production database" });
  const parsed = z.object({
    businessName: z.string().trim().min(2).max(160),
    category: z.string().trim().min(2).max(80),
    address: z.string().trim().min(5).max(500),
    services: z.array(z.enum(["DROP_OFF","PICKUP","RETURNS"])).min(1).max(3)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await pool!.query(
    `INSERT INTO agent_applications (applicant_user_id, business_name, category, address, services)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, business_name, category, address, services, status, created_at`,
    [identity(req), parsed.data.businessName, parsed.data.category, parsed.data.address, parsed.data.services]
  );
  return res.status(201).json({ application: result.rows[0] });
});

type Status = "CREATED" | "PAYMENT_AUTHORIZED" | "DRIVER_ASSIGNED" | "DRIVER_AT_PICKUP" | "PICKED_UP" | "IN_TRANSIT" | "ARRIVED" | "RESCHEDULED" | "DELIVERED" | "CANCELLED" | "DISPUTED";
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
): DeliveryQuote {
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
    return res.status(201).json({ rating: result.rows[0] });
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
  return res.json({ account });
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
  return res.status(201).json({ account });
});

app.get("/api/driver/payouts", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Payouts require the production database" });
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  const result = await pool!.query(
    `SELECT id, delivery_id, amount_minor, currency, status, provider, provider_reference,
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
  return res.json({ summary, payouts: result.rows });
});

app.get("/api/deliveries/:id/payout", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Payouts require the production database" });
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), identity(req), "DRIVER");
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  const payout = await findPayout(routeParam(req.params.id, "id"));
  return res.json({ payout });
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
  const response = await fetch("https://api.paystack.co/transfer", {
    method: "POST",
    headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({ source: "balance", amount: processing.amountMinor, recipient: account.recipientCode, reference, reason: "SwiftDrop courier payout", currency: processing.currency })
  });
  const data = await response.json() as { status?: boolean; message?: string; data?: { reference?: string; status?: string } };
  if (!response.ok || !data.status || !data.data?.reference) {
    await markPayoutFailed(routeParam(req.params.id, "id"));
    return res.status(502).json({ error: data.message ?? "Paystack transfer could not be initiated" });
  }
  if (data.data.reference && data.data.reference !== reference) {
    await setPayoutProviderReference(routeParam(req.params.id, "id"), data.data.reference);
  }
  return res.status(202).json({
    payout: await findPayout(routeParam(req.params.id, "id")),
    providerStatus: data.data.status ?? "pending",
    message: "Transfer initiated. Final payout status will be updated from Paystack's transfer webhook."
  });
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
  res.json({ average, count: result.rows.length, ratings: result.rows });
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
  res.json({ notifications: result.rows });
});

app.post("/api/notifications/:id/read", requireAuth(), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Notifications require the production database" });
  const result = await pool!.query(
    "UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id, read_at",
    [routeParam(req.params.id, "id"), identity(req)]
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
      const created = await createPersistentDelivery({
        senderId: input.senderId,
        receiverName: input.receiverName,
        receiverPhone: input.receiverPhone,
        pickup: { label: input.pickup.label, formattedAddress: input.pickup.formattedAddress, location: { latitude: input.pickup.latitude, longitude: input.pickup.longitude } },
        dropoff: { label: input.dropoff.label, formattedAddress: input.dropoff.formattedAddress, location: { latitude: input.dropoff.latitude, longitude: input.dropoff.longitude } },
        receiverPin: pin,
        weightKg: input.weightKg,
        dimensionsCm: input.dimensionsCm,
        isPerishable: input.isPerishable,
        quote: input.quote
      });
      return res.status(201).json(safeDelivery(created));
    }
    const now = new Date().toISOString();
    const delivery: MemoryDelivery = {
      id: randomUUID(),
      trackingCode: trackingCode(),
      senderId: input.senderId,
      receiverName: input.receiverName,
      receiverPhone: input.receiverPhone,
      pickup: { label: input.pickup.label, formattedAddress: input.pickup.formattedAddress, location: { latitude: input.pickup.latitude, longitude: input.pickup.longitude } },
      dropoff: { label: input.dropoff.label, formattedAddress: input.dropoff.formattedAddress, location: { latitude: input.dropoff.latitude, longitude: input.dropoff.longitude } },
      quote: input.quote,
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

  const existing = await findPayment(delivery.id);
  if (existing && (existing.amountMinor !== amountMinor || existing.currency !== "NGN")) {
    return res.status(409).json({ error: "Existing payment amount no longer matches the server quote" });
  }
  if (existing?.status === "HELD" || existing?.status === "RELEASED") {
    return res.status(409).json({ error: "This delivery already has a completed payment state" });
  }
  if (existing?.status === "PENDING" && existing.authorizationUrl && existing.providerReference) {
    return res.status(200).json({
      paymentId: existing.id,
      reference: existing.providerReference,
      authorizationUrl: existing.authorizationUrl,
      accessCode: existing.accessCode
    });
  }

  // Reserve one stable provider reference before contacting Paystack. A retry after
  // a network/database interruption therefore targets the same payment attempt.
  const reference = existing?.providerReference ?? ("SD-" + delivery.trackingCode + "-PAY");
  const payment = existing ?? await createPayment({
    deliveryId: delivery.id,
    provider: "paystack",
    amountMinor,
    currency: "NGN"
  });


  await updatePaymentStatus(delivery.id, "PENDING", reference);

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
    // If Paystack already accepted this reference but the response was lost,
    // verify it before allowing another payment attempt.
    const verify = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), {
      headers: { authorization: "Bearer " + secret }
    }).catch(() => null);
    if (verify?.ok) {
      const verified = await verify.json() as any;
      const data = verified?.data;
      if (verified?.status && data?.status === "success" && Number(data.amount) === amountMinor && String(data.currency) === "NGN") {
        const saved = await savePaymentAuthorization(
          delivery.id,
          reference,
          String(data.authorization_url ?? ""),
          data.access_code ? String(data.access_code) : undefined
        );
        if (saved?.authorizationUrl) {
          return res.status(200).json({
            paymentId: saved.id,
            reference,
            authorizationUrl: saved.authorizationUrl,
            accessCode: saved.accessCode
          });
        }
      }
    }
    return res.status(502).json({ error: "Payment provider initialization failed" });
  }

  const saved = await savePaymentAuthorization(
    delivery.id,
    String(payload.data.reference ?? reference),
    String(payload.data.authorization_url),
    payload.data.access_code ? String(payload.data.access_code) : undefined
  );
  if (!saved) return res.status(500).json({ error: "Unable to persist payment authorization" });

  await recordDeliveryEvent({
    deliveryId: delivery.id,
    eventType: "PAYMENT_INITIALIZED",
    actorUserId: userId,
    metadata: { paymentId: saved.id, reference: saved.providerReference, amountMinor }
  });
  return res.status(201).json({
    paymentId: saved.id,
    reference: saved.providerReference,
    authorizationUrl: saved.authorizationUrl,
    accessCode: saved.accessCode
  });
});

app.post("/api/deliveries/:id/payment", requireAuth("CUSTOMER"), async (req, res) => {
  const userId = identity(req);
  const delivery = databaseEnabled()
    ? await findDeliveryForUser(routeParam(req.params.id, "id"), userId, "CUSTOMER")
    : await getOne(routeParam(req.params.id, "id"));
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });

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
  if (typeof event?.event === "string" && event.event.startsWith("refund.")) {
    const transactionReference = String(event?.data?.transaction_reference ?? event?.data?.transaction?.reference ?? "");
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
        } else if (refundStatus === "needs-attention") {
          await recordDeliveryEvent({ deliveryId, eventType: "REFUND_NEEDS_ATTENTION", metadata: { provider: "paystack", transactionReference, refundReference } });
        } else {
          await recordDeliveryEvent({ deliveryId, eventType: "REFUND_" + refundStatus.toUpperCase(), metadata: { provider: "paystack", transactionReference, refundReference } });
        }
      }
    }
    return res.status(200).json({ received: true });
  }

  if (event?.event === "transfer.success" || event?.event === "transfer.failed" || event?.event === "transfer.reversed") {
    const reference = String(event?.data?.reference ?? "");
    if (reference) {
      const status = event.event === "transfer.success" ? "RELEASED" : event.event === "transfer.failed" ? "FAILED" : "CANCELLED";
      const failureReason = event?.data?.failures?.message ?? event?.data?.failures?.reason ?? event?.data?.reason ?? null;
      const payout = await updatePayoutProviderStatus(
        reference,
        status,
        failureReason,
        Number(event?.data?.amount),
        String(event?.data?.currency ?? "")
      );
      if (payout) {
        await recordDeliveryEvent({ deliveryId: payout.deliveryId, eventType: "PAYOUT_" + status, metadata: { provider: "paystack", reference } });
      }
    }
    return res.status(200).json({ received: true });
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

app.get("/api/support/tickets", requireAuth("CUSTOMER", "DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Support requires the production database" });
  const tickets = await listSupportTickets(identity(req));
  return res.json({ tickets });
});

app.post("/api/support/tickets", requireAuth("CUSTOMER", "DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Support requires the production database" });
  const category = String(req.body?.category ?? "").toUpperCase();
  const subject = String(req.body?.subject ?? "").trim();
  const message = String(req.body?.message ?? "").trim();
  const deliveryId = req.body?.deliveryId ? String(req.body.deliveryId) : undefined;
  if (category !== "ORDER" && category !== "APP") return res.status(400).json({ error: "Support category must be ORDER or APP" });
  if (subject.length < 3 || subject.length > 120 || message.length < 5 || message.length > 2000) {
    return res.status(400).json({ error: "Enter a subject and a message within the allowed length" });
  }
  if (deliveryId) {
    const delivery = await findDeliveryForUser(deliveryId, identity(req), (req as any).user.role);
    if (!delivery) return res.status(404).json({ error: "Order not found" });
  }
  const ticket = await createSupportTicket(identity(req), category, subject, message, deliveryId);
  if (!ticket) return res.status(503).json({ error: "Unable to create support request" });
  return res.status(201).json({ ticket });
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
  res.status(201).json({ document: result.rows[0] });
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
  res.json({ documents: result.rows });
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
  res.json({ document: result.rows[0] });
});

app.get("/api/admin/users", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Admin user management requires the production database" });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const search = String(req.query.search ?? "").trim();
  const result = await pool!.query(
    `SELECT u.id, u.role, u.full_name, u.phone, u.email, u.created_at,
            d.id AS driver_id, d.status AS driver_status, d.online AS driver_online
       FROM users u
       LEFT JOIN drivers d ON d.user_id=u.id
      WHERE ($1 = '' OR u.full_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%' OR COALESCE(u.email,'') ILIKE '%' || $1 || '%')
      ORDER BY u.created_at DESC
      LIMIT $2`,
    [search, limit]
  );
  return res.json({ users: result.rows });
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
    [routeParam(req.params.driverId, "driverId")]
  );
  const documentSummary = documents.rows[0];
  if (!documentSummary || documentSummary.total < 1 || documentSummary.approved < 1) {
    return res.status(409).json({ error: "At least one approved KYC document is required before driver approval" });
  }
  const result = await pool!.query(
    "UPDATE drivers SET status='APPROVED' WHERE id=$1 AND status='PENDING' RETURNING id, user_id, status",
    [routeParam(req.params.driverId, "driverId")]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Pending driver not found" });
  await recordAdminCaseAudit({ adminUserId: identity(req), action: "DRIVER_APPROVED", metadata: { driverId: result.rows[0].id } });
  res.json({ driver: result.rows[0] });
});

app.post("/api/admin/drivers/:driverId/suspend", requireAuth("ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query(
    "UPDATE drivers SET status='SUSPENDED', online=false WHERE id=$1 AND status <> 'SUSPENDED' RETURNING id, user_id, status",
    [routeParam(req.params.driverId, "driverId")]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Driver not found" });
  await recordAdminCaseAudit({ adminUserId: identity(req), action: "DRIVER_SUSPENDED", metadata: { driverId: result.rows[0].id } });
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
  res.json({ disputes: result.rows });
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
  return res.json({ case: row, events: events.rows, locations: locations.rows, audit });
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

app.get("/api/admin/payouts", requireAuth("ADMIN"), async (_req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool!.query("SELECT id, delivery_id, driver_id, amount_minor, currency, status, provider, provider_reference, provider_status, failure_reason, processed_at, created_at, updated_at FROM payouts ORDER BY updated_at DESC LIMIT 100");
  res.json({ payouts: result.rows });
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
    const paymentBefore = await findPayment(routeParam(req.params.id, "id"));
    if (!paymentBefore) return res.status(409).json({ error: "No payment was found for this delivery" });
    const requestedAmount = Number(req.body?.refundAmountMinor);
    const refundAmountMinor = Number.isInteger(requestedAmount) && requestedAmount > 0 ? requestedAmount : paymentBefore.amountMinor;
    if (refundAmountMinor < 1 || refundAmountMinor > paymentBefore.amountMinor) return res.status(400).json({ error: "Refund amount must be a positive whole amount not greater than the original payment" });
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return res.status(503).json({ error: "Paystack refund configuration is not ready" });

    const prepared = await prepareRefund(routeParam(req.params.id, "id"), refundAmountMinor);
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

app.post("/api/deliveries/:id/failed-attempt", requireAuth("DRIVER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Failed delivery handling requires the production database" });
  const parsed = z.object({
    outcome: z.enum(["RECEIVER_UNAVAILABLE","ACCESS_BLOCKED","ADDRESS_ISSUE","REFUSED","OTHER"]),
    notes: z.string().trim().max(1000).optional(),
    contactAttempted: z.boolean(),
    waitMinutes: z.number().int().min(0).max(240),
    action: z.enum(["RESCHEDULE","RETURN_TO_SENDER","SUPPORT"])
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const driver = await driverForUser(identity(req));
  if (!driver) return res.status(404).json({ error: "Driver profile not found" });
  try {
    const result = await recordFailedDeliveryAttempt({ deliveryId: routeParam(req.params.id, "id"), driverId: driver.id, ...parsed.data });
    if (!result) return res.status(409).json({ error: "Delivery is not eligible for a failed-delivery attempt" });
    await recordDeliveryEvent({ deliveryId: result.delivery.id, eventType: "DELIVERY_ATTEMPT_FAILED", actorUserId: identity(req), metadata: { attemptId: result.attemptId, ...parsed.data } });
    publishDeliveryUpdate(result.delivery.id, safeDelivery(result.delivery));
    return res.status(201).json({ attemptId: result.attemptId, delivery: safeDelivery(result.delivery) });
  } catch { return res.status(500).json({ error: "Unable to record failed delivery attempt" }); }
});

app.get("/api/deliveries/:id/attempts", requireAuth("CUSTOMER","DRIVER","ADMIN"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Delivery attempts require the production database" });
  const role = (req as typeof req & { user?: { role: "CUSTOMER" | "DRIVER" | "ADMIN" } }).user!.role;
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), identity(req), role);
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  return res.json({ attempts: await listDeliveryAttempts(delivery.id) });
});

app.post("/api/deliveries/:id/reschedule", requireAuth("CUSTOMER"), async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({ error: "Rescheduling requires the production database" });
  const parsed = z.object({ scheduledFor: z.string().datetime() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const delivery = await findDeliveryForUser(routeParam(req.params.id, "id"), identity(req), "CUSTOMER");
  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  try {
    const updated = await rescheduleDelivery({ deliveryId: delivery.id, userId: identity(req), scheduledFor: parsed.data.scheduledFor });
    if (!updated) return res.status(409).json({ error: "Delivery cannot be rescheduled or has reached the reschedule limit" });
    await recordDeliveryEvent({ deliveryId: updated.id, eventType: "DELIVERY_RESCHEDULED", actorUserId: identity(req), metadata: { scheduledFor: parsed.data.scheduledFor } });
    publishDeliveryUpdate(updated.id, safeDelivery(updated));
    return res.json({ delivery: safeDelivery(updated) });
  } catch { return res.status(500).json({ error: "Unable to reschedule delivery" }); }
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

async function startServer() {
  validateProductionConfig();
  if (databaseEnabled()) {
    await runMigrations();
    void processNotificationOutbox().catch(() => {});
    void processNotificationPushReceipts().catch(() => {});
    const notificationWorker = setInterval(() => {
      void processNotificationOutbox().catch(() => {});
    }, 5000);
    const notificationReceiptWorker = setInterval(() => {
      void processNotificationPushReceipts().catch(() => {});
    }, 60_000);
    notificationWorker.unref();
    notificationReceiptWorker.unref();
  }
  httpServer.listen(port, () => console.log(`SwiftDrop API listening on port ${port}`));
}

startServer().catch(error => {
  console.error("SwiftDrop API startup failed:", error);
  process.exit(1);
});
