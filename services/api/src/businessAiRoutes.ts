import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { driverForUser } from "./database/deliveryRepository.js";
import { canCreatePersonalBuyOrder, canDispatchBusiness, canManageBusiness, canUseAiAction } from "./aiPolicy.js";
import { getPrivateObject, putPrivateObject } from "./storage.js";

const router = Router();

type Plan = "BASIC" | "PREMIUM";
type Capability = "INFORMATION" | "ACTION";

async function currentPlan(userId: string): Promise<Plan> {
  if (!pool) return "BASIC";
  const result = await pool.query("SELECT ai_plan FROM users WHERE id=$1", [userId]);
  return result.rows[0]?.ai_plan === "PREMIUM" ? "PREMIUM" : "BASIC";
}

async function audit(input: {
  userId: string;
  plan: Plan;
  capability: string;
  action?: string;
  allowed: boolean;
  reason?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO ai_audit_log
      (user_id, plan, capability, action, allowed, reason, request_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      input.userId,
      input.plan,
      input.capability,
      input.action ?? null,
      input.allowed,
      input.reason ?? null,
      input.requestId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

async function premiumAction(req: any, res: any, action: string): Promise<Plan | null> {
  const userId = identity(req);
  const plan = await currentPlan(userId);
  if (!canUseAiAction(plan)) {
    await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "PREMIUM_REQUIRED", requestId: String(res.getHeader("x-request-id") ?? "") });
    res.status(403).json({ error: "This AI action requires Premium AI", code: "PREMIUM_AI_REQUIRED" });
    return null;
  }
  return plan;
}

const buyOrderSchema = z.object({
  itemDescription: z.string().trim().min(3).max(500),
  merchantName: z.string().trim().max(160).optional(),
  merchantAddress: z.string().trim().max(500).optional(),
  purchaseBudgetMinor: z.number().int().positive().max(100000000),
  notes: z.string().trim().max(1000).optional(),
  businessId: z.string().uuid().optional()
});

const businessSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(120),
  registrationNumber: z.string().trim().max(100).optional(),
  monthlySpendLimitMinor: z.number().int().nonnegative().max(100000000000),
  perOrderLimitMinor: z.number().int().nonnegative().max(1000000000),
  requiresApproval: z.boolean()
});

const dispatchSchema = z.object({
  businessId: z.string().uuid(),
  buyOrderIds: z.array(z.string().uuid()).max(100).default([]),
  deliveryIds: z.array(z.string().uuid()).max(100).default([]),
  deliveryWindowStart: z.string().datetime().optional(),
  deliveryWindowEnd: z.string().datetime().optional()
});

async function businessMember(userId: string, businessId: string): Promise<{ memberRole: string; spendLimitMinor: number; business: any } | null> {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT bm.member_role, bm.spend_limit_minor, ba.*
       FROM business_members bm
       JOIN business_accounts ba ON ba.id=bm.business_id
      WHERE bm.business_id=$1 AND bm.user_id=$2 AND bm.active=true`,
    [businessId, userId]
  );
  if (!result.rows[0]) return null;
  return {
    memberRole: result.rows[0].member_role,
    spendLimitMinor: Number(result.rows[0].spend_limit_minor),
    business: result.rows[0]
  };
}

async function authorizeBusinessSpend(userId: string, businessId: string, amountMinor: number): Promise<{ ok: boolean; reason?: string; member?: any }> {
  const member = await businessMember(userId, businessId);
  if (!member) return { ok: false, reason: "BUSINESS_MEMBERSHIP_REQUIRED" };
  const roleAllowed = ["OWNER", "ADMIN", "DISPATCHER"].includes(member.memberRole);
  if (!roleAllowed) return { ok: false, reason: "BUSINESS_ROLE_NOT_AUTHORIZED", member };
  if (member.business.status !== "ACTIVE") return { ok: false, reason: "BUSINESS_NOT_ACTIVE", member };
  if (member.business.per_order_limit_minor > 0 && amountMinor > Number(member.business.per_order_limit_minor)) {
    return { ok: false, reason: "PER_ORDER_LIMIT_EXCEEDED", member };
  }
  if (member.spendLimitMinor > 0 && amountMinor > member.spendLimitMinor) {
    return { ok: false, reason: "MEMBER_SPEND_LIMIT_EXCEEDED", member };
  }
  if (member.business.requires_approval && member.memberRole === "DISPATCHER") {
    return { ok: false, reason: "BUSINESS_APPROVAL_REQUIRED", member };
  }
  return { ok: true, member };
}

router.get("/ai/entitlement", requireAuth("CUSTOMER", "DRIVER", "AGENT", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const plan = await currentPlan(userId);
  await audit({ userId, plan, capability: "INFORMATION", action: "READ_ENTITLEMENT", allowed: true });
  res.json({
    plan,
    basic: { informational: true, actions: false },
    premium: { informational: true, actions: true }
  });
});

router.post("/ai/query", requireAuth("CUSTOMER", "DRIVER", "AGENT", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const plan = await currentPlan(userId);
  const question = String(req.body?.question ?? "").trim();
  if (question.length < 1 || question.length > 2000) return res.status(400).json({ error: "A question is required" });
  await audit({ userId, plan, capability: "INFORMATION", action: "QUERY", allowed: true });
  res.json({
    plan,
    mode: "INFORMATIONAL",
    answer: "SwiftDrop AI can provide information in Basic and Premium. Action-taking requests require Premium AI and server authorization.",
    question
  });
});

router.post("/ai/action", requireAuth("CUSTOMER", "DRIVER", "AGENT", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "AI actions require the production database" });
  const userId = identity(req);
  const action = String(req.body?.action ?? "").trim().toUpperCase();
  const plan = await premiumAction(req, res, action || "UNKNOWN");
  if (!plan) return;

  if (action === "CREATE_BUY_ORDER") {
    if (!(req.body?.input?.businessId) && !canCreatePersonalBuyOrder((req as any).user?.role)) {
      await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "CUSTOMER_ONLY" });
      return res.status(403).json({ error: "Buy & Deliver orders must be created by a customer or authorized business member" });
    }
    const parsed = buyOrderSchema.safeParse(req.body?.input);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      let businessMemberRow: any = null;
      if (parsed.data.businessId) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [parsed.data.businessId]);
        const memberResult = await client.query(
          `SELECT bm.member_role, bm.spend_limit_minor, ba.*
             FROM business_members bm
             JOIN business_accounts ba ON ba.id=bm.business_id
            WHERE bm.business_id=$1 AND bm.user_id=$2 AND bm.active=true
            FOR UPDATE OF ba`,
          [parsed.data.businessId, userId]
        );
        businessMemberRow = memberResult.rows[0];
        if (!businessMemberRow) {
          await client.query("ROLLBACK");
          await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "BUSINESS_MEMBERSHIP_REQUIRED", metadata: { businessId: parsed.data.businessId } });
          return res.status(403).json({ error: "Active business membership is required", code: "BUSINESS_MEMBERSHIP_REQUIRED" });
        }
        if (!["OWNER", "ADMIN", "DISPATCHER"].includes(businessMemberRow.member_role)) {
          await client.query("ROLLBACK");
          await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "BUSINESS_ROLE_NOT_AUTHORIZED", metadata: { businessId: parsed.data.businessId } });
          return res.status(403).json({ error: "Business role is not authorized to spend", code: "BUSINESS_ROLE_NOT_AUTHORIZED" });
        }
        if (businessMemberRow.status !== "ACTIVE") {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Business account is not active", code: "BUSINESS_NOT_ACTIVE" });
        }
        if (Number(businessMemberRow.per_order_limit_minor) > 0 && parsed.data.purchaseBudgetMinor > Number(businessMemberRow.per_order_limit_minor)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Purchase budget exceeds the business per-order limit", code: "PER_ORDER_LIMIT_EXCEEDED" });
        }
        if (Number(businessMemberRow.spend_limit_minor) > 0 && parsed.data.purchaseBudgetMinor > Number(businessMemberRow.spend_limit_minor)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "Purchase budget exceeds the member spending limit", code: "MEMBER_SPEND_LIMIT_EXCEEDED" });
        }
        const spendResult = await client.query(
          "SELECT COALESCE(SUM(amount_minor),0) AS current_spend FROM business_spend_ledger WHERE business_id=$1 AND created_at >= date_trunc('month', now())",
          [parsed.data.businessId]
        );
        const currentSpend = Number(spendResult.rows[0]?.current_spend ?? 0);
        const monthlyLimit = Number(businessMemberRow.monthly_spend_limit_minor);
        if (monthlyLimit > 0 && currentSpend + parsed.data.purchaseBudgetMinor > monthlyLimit) {
          await client.query("ROLLBACK");
          await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "MONTHLY_SPEND_LIMIT_EXCEEDED", metadata: { businessId: parsed.data.businessId, currentSpend, requested: parsed.data.purchaseBudgetMinor, monthlyLimit } });
          return res.status(403).json({ error: "Monthly business spending limit would be exceeded", code: "MONTHLY_SPEND_LIMIT_EXCEEDED" });
        }
      }

      const result = await client.query(
        `INSERT INTO buy_orders
          (customer_user_id, business_id, item_description, merchant_name, merchant_address, purchase_budget_minor, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, status, item_description, merchant_name, merchant_address, purchase_budget_minor, delivery_fee_minor, total_authorized_minor, currency, notes, created_at, updated_at`,
        [userId, parsed.data.businessId ?? null, parsed.data.itemDescription, parsed.data.merchantName ?? null, parsed.data.merchantAddress ?? null, parsed.data.purchaseBudgetMinor, parsed.data.notes ?? null]
      );

      if (parsed.data.businessId) {
        await client.query(
          `INSERT INTO business_spend_ledger (business_id, user_id, reference_type, reference_id, amount_minor, currency)
           VALUES ($1,$2,'BUY_ORDER_RESERVATION',$3,$4,'NGN')`,
          [parsed.data.businessId, userId, result.rows[0].id, parsed.data.purchaseBudgetMinor]
        );
      }

      await client.query(
        "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'CREATED_BY_AI',$3::jsonb)",
        [result.rows[0].id, userId, JSON.stringify({ plan, businessId: parsed.data.businessId ?? null })]
      );
      await client.query("COMMIT");
      await audit({ userId, plan, capability: "ACTION", action, allowed: true, metadata: { buyOrderId: result.rows[0].id } });
      return res.status(201).json({ buyOrder: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }


  if (action === "RESCHEDULE_DELIVERY") {
    const input = z.object({
      deliveryId: z.string().uuid(),
      nextDeliveryAt: z.string().datetime()
    }).safeParse(req.body?.input);
    if (!input.success) return res.status(400).json({ error: input.error.flatten() });

    const next = new Date(input.data.nextDeliveryAt);
    if (next.getTime() <= Date.now()) {
      await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "RESCHEDULE_TIME_NOT_FUTURE", metadata: { deliveryId: input.data.deliveryId } });
      return res.status(400).json({ error: "nextDeliveryAt must be in the future" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const delivery = (await client.query(
        "SELECT id,sender_id,status,exception_status FROM deliveries WHERE id=$1 FOR UPDATE",
        [input.data.deliveryId]
      )).rows[0];
      if (!delivery) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Delivery not found" });
      }
      if ((req as any).user?.role !== "ADMIN" && delivery.sender_id !== userId) {
        await client.query("ROLLBACK");
        await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "DELIVERY_NOT_OWNED", metadata: { deliveryId: input.data.deliveryId } });
        return res.status(403).json({ error: "Not authorized to reschedule this delivery" });
      }
      if (!["FAILED_ATTEMPT", "RESCHEDULED"].includes(delivery.exception_status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Only a failed delivery attempt can be rescheduled" });
      }

      await client.query(
        "UPDATE deliveries SET exception_status='RESCHEDULED',next_delivery_at=$2,updated_at=now() WHERE id=$1",
        [input.data.deliveryId, next]
      );
      await client.query(
        "INSERT INTO delivery_exception_events(delivery_id,actor_user_id,event_type,metadata) VALUES($1,$2,'DELIVERY_RESCHEDULED',$3::jsonb)",
        [input.data.deliveryId, userId, JSON.stringify({ nextDeliveryAt: next.toISOString(), source: "SWIFT_AI" })]
      );
      await client.query("COMMIT");
      await audit({ userId, plan, capability: "ACTION", action, allowed: true, metadata: { deliveryId: input.data.deliveryId, nextDeliveryAt: next.toISOString() } });
      return res.json({ deliveryId: input.data.deliveryId, exceptionStatus: "RESCHEDULED", nextDeliveryAt: next.toISOString() });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  if (action === "REQUEST_RETURN_TO_SENDER") {
    const input = z.object({
      deliveryId: z.string().uuid()
    }).safeParse(req.body?.input);
    if (!input.success) return res.status(400).json({ error: input.error.flatten() });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const delivery = (await client.query(
        "SELECT id,sender_id,status,driver_id,exception_status FROM deliveries WHERE id=$1 FOR UPDATE",
        [input.data.deliveryId]
      )).rows[0];
      if (!delivery) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Delivery not found" });
      }
      if ((req as any).user?.role !== "ADMIN" && delivery.sender_id !== userId) {
        await client.query("ROLLBACK");
        await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "DELIVERY_NOT_OWNED", metadata: { deliveryId: input.data.deliveryId } });
        return res.status(403).json({ error: "Not authorized to request a return for this delivery" });
      }
      if (!["FAILED_ATTEMPT", "RESCHEDULED"].includes(delivery.exception_status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Return-to-sender is only available after a failed delivery attempt" });
      }

      await client.query(
        "UPDATE deliveries SET exception_status='RETURN_REQUESTED',return_reason='CUSTOMER_REQUEST',updated_at=now() WHERE id=$1",
        [input.data.deliveryId]
      );
      await client.query(
        "INSERT INTO delivery_exception_events(delivery_id,actor_user_id,event_type,metadata) VALUES($1,$2,'RETURN_REQUESTED',$3::jsonb)",
        [input.data.deliveryId, userId, JSON.stringify({ reason: "CUSTOMER_REQUEST", source: "SWIFT_AI" })]
      );
      await client.query("COMMIT");
      await audit({ userId, plan, capability: "ACTION", action, allowed: true, metadata: { deliveryId: input.data.deliveryId } });
      return res.json({ deliveryId: input.data.deliveryId, exceptionStatus: "RETURN_REQUESTED" });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  if (action === "CREATE_BUSINESS") {
    if (!canManageBusiness((req as any).user?.role)) {
      await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "ROLE_NOT_AUTHORIZED" });
      return res.status(403).json({ error: "Only customer or admin accounts can create business accounts" });
    }
    const parsed = businessSchema.safeParse(req.body?.input);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      const business = await client.query(
        `INSERT INTO business_accounts
          (owner_user_id, legal_name, display_name, registration_number, monthly_spend_limit_minor, per_order_limit_minor, requires_approval, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [userId, parsed.data.legalName, parsed.data.displayName, parsed.data.registrationNumber ?? null, parsed.data.monthlySpendLimitMinor, parsed.data.perOrderLimitMinor, parsed.data.requiresApproval, (req as any).user?.role === "ADMIN" ? "ACTIVE" : "PENDING"]
      );
      await client.query(
        "INSERT INTO business_members (business_id, user_id, member_role) VALUES ($1,$2,'OWNER')",
        [business.rows[0].id, userId]
      );
      await client.query("COMMIT");
      await audit({ userId, plan, capability: "ACTION", action, allowed: true, metadata: { businessId: business.rows[0].id } });
      return res.status(201).json({ business: business.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  if (action === "CREATE_DISPATCH_PLAN") {
    const parsed = dispatchSchema.safeParse(req.body?.input);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const member = await businessMember(userId, parsed.data.businessId);
    if (!member || !canDispatchBusiness(member.memberRole as any)) {
      await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "BUSINESS_ROLE_NOT_AUTHORIZED", metadata: { businessId: parsed.data.businessId } });
      return res.status(403).json({ error: "Business dispatch authorization required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [parsed.data.businessId]);

      const buyOrders = parsed.data.buyOrderIds.length
        ? await client.query("SELECT id, purchase_budget_minor, status FROM buy_orders WHERE id = ANY($1::uuid[]) AND business_id=$2 FOR UPDATE", [parsed.data.buyOrderIds, parsed.data.businessId])
        : { rows: [] as any[] };
      const deliveries = parsed.data.deliveryIds.length
        ? await client.query("SELECT id, quote_total_minor, status FROM deliveries WHERE id = ANY($1::uuid[]) AND sender_id IN (SELECT user_id FROM business_members WHERE business_id=$2) FOR UPDATE", [parsed.data.deliveryIds, parsed.data.businessId])
        : { rows: [] as any[] };

      const resolvedBuyOrderIds = buyOrders.rows.map((row: any) => row.id);
      const resolvedDeliveryIds = deliveries.rows.map((row: any) => row.id);
      const skippedBuyOrderIds = parsed.data.buyOrderIds.filter(id => !resolvedBuyOrderIds.includes(id));
      const skippedDeliveryIds = parsed.data.deliveryIds.filter(id => !resolvedDeliveryIds.includes(id));

      const estimatedTotalMinor = buyOrders.rows.reduce((s: number, r: any) => s + Number(r.purchase_budget_minor), 0)
        + deliveries.rows.reduce((s: number, r: any) => s + Number(r.quote_total_minor ?? 0), 0);

      const perOrderLimitMinor = Number(member.business.per_order_limit_minor);
      const oversizedBuyOrder = buyOrders.rows.find((row: any) => perOrderLimitMinor > 0 && Number(row.purchase_budget_minor) > perOrderLimitMinor);
      const oversizedDelivery = deliveries.rows.find((row: any) => perOrderLimitMinor > 0 && Number(row.quote_total_minor ?? 0) > perOrderLimitMinor);
      if (oversizedBuyOrder || oversizedDelivery) {
        await client.query("ROLLBACK");
        await audit({
          userId,
          plan,
          capability: "ACTION",
          action,
          allowed: false,
          reason: "PER_ORDER_LIMIT_EXCEEDED",
          metadata: {
            businessId: parsed.data.businessId,
            buyOrderId: oversizedBuyOrder?.id ?? null,
            deliveryId: oversizedDelivery?.id ?? null,
            perOrderLimitMinor
          }
        });
        return res.status(403).json({
          error: "One or more items in the dispatch plan exceed the business per-order limit",
          code: "PER_ORDER_LIMIT_EXCEEDED"
        });
      }

      const monthlySpend = await client.query(
        "SELECT COALESCE(SUM(CASE WHEN reference_type='BUY_ORDER_RESERVATION' THEN amount_minor WHEN reference_type='BUY_ORDER_RESERVATION_RELEASE' THEN amount_minor ELSE 0 END),0) AS total FROM business_spend_ledger WHERE business_id=$1 AND created_at >= date_trunc('month', now())",
        [parsed.data.businessId]
      );
      const monthlyLimit = Number(member.business.monthly_spend_limit_minor);
      const currentMonthlySpend = Number(monthlySpend.rows[0]?.total ?? 0);
      if (monthlyLimit > 0 && currentMonthlySpend + estimatedTotalMinor > monthlyLimit) {
        await client.query("ROLLBACK");
        await audit({
          userId, plan, capability: "ACTION", action, allowed: false,
          reason: "MONTHLY_SPEND_LIMIT_EXCEEDED",
          metadata: { businessId: parsed.data.businessId, currentMonthlySpend, estimatedTotalMinor, monthlyLimit }
        });
        return res.status(403).json({ error: "Dispatch plan would exceed the monthly business spending limit" });
      }

      const approvalRequired = Boolean(member.business.requires_approval || member.memberRole === "DISPATCHER");
      const planResult = await client.query(
        `INSERT INTO business_dispatch_plans
          (business_id, created_by_user_id, status, delivery_window_start, delivery_window_end, estimated_total_minor, approval_required, plan)
         VALUES ($1,$2,'PREPARED',$3,$4,$5,$6,$7::jsonb)
         RETURNING *`,
        [
          parsed.data.businessId,
          userId,
          parsed.data.deliveryWindowStart ?? null,
          parsed.data.deliveryWindowEnd ?? null,
          estimatedTotalMinor,
          approvalRequired,
          JSON.stringify({
            buyOrderIds: resolvedBuyOrderIds,
            deliveryIds: resolvedDeliveryIds,
            requestedBuyOrderIds: parsed.data.buyOrderIds,
            requestedDeliveryIds: parsed.data.deliveryIds,
            skippedBuyOrderIds,
            skippedDeliveryIds
          })
        ]
      );
      await client.query("COMMIT");
      await audit({
        userId, plan, capability: "ACTION", action, allowed: true,
        metadata: { dispatchPlanId: planResult.rows[0].id, skippedBuyOrderIds, skippedDeliveryIds }
      });
      return res.status(201).json({ dispatchPlan: planResult.rows[0], skippedBuyOrderIds, skippedDeliveryIds });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "UNKNOWN_ACTION" });
  return res.status(400).json({ error: "Unsupported AI action", code: "UNKNOWN_AI_ACTION" });
});

router.get("/admin/recurring-dispatch-recovery", requireAuth("ADMIN"), async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT p.id, p.business_id, p.created_by_user_id, p.status, p.approval_required,
            p.estimated_total_minor, p.created_at, p.updated_at, p.plan,
            b.display_name AS business_display_name
       FROM business_dispatch_plans p
       JOIN business_accounts b ON b.id=p.business_id
      WHERE p.status='PREPARED'
        AND p.plan->>'autonomousRecoveryState' IS NOT NULL
      ORDER BY p.updated_at ASC
      LIMIT 200`
  );
  return res.json({ recoveries: result.rows.map((row: any) => ({
    dispatchPlanId: row.id,
    businessId: row.business_id,
    businessDisplayName: row.business_display_name,
    createdByUserId: row.created_by_user_id,
    status: row.status,
    approvalRequired: row.approval_required,
    estimatedTotalMinor: Number(row.estimated_total_minor),
    recoveryState: row.plan?.autonomousRecoveryState ?? null,
    recoveryReason: row.plan?.autonomousRecoveryReason ?? null,
    retryAt: row.plan?.autonomousRetryAt ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    plan: row.plan
  })) });
});

router.get("/business/dispatch-plans", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const businessId = String(req.query.businessId ?? "");
  const m = await businessMember(identity(req), businessId);
  if (!m && (req as any).user?.role !== "ADMIN") return res.status(403).json({ error: "Business membership required" });
  const result = await pool.query(
    "SELECT * FROM business_dispatch_plans WHERE business_id=$1 ORDER BY created_at DESC LIMIT 200",
    [businessId]
  );
  return res.json({ dispatchPlans: result.rows });
});

router.post("/business/dispatch-plans/:id/approve", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id);
  const current = (await pool.query("SELECT * FROM business_dispatch_plans WHERE id=$1", [id])).rows[0];
  if (!current) return res.status(404).json({ error: "Dispatch plan not found" });
  const member = await businessMember(identity(req), current.business_id);
  if ((req as any).user?.role !== "ADMIN" && (!member || !["OWNER","ADMIN"].includes(member.memberRole))) {
    return res.status(403).json({ error: "Business approval authority required" });
  }
  if (current.status !== "PREPARED") return res.status(409).json({ error: "Only prepared dispatch plans can be approved" });
  const result = await pool.query(
    "UPDATE business_dispatch_plans SET status='APPROVED',approved_by_user_id=$2,approved_at=now(),updated_at=now() WHERE id=$1 AND status='PREPARED' RETURNING *",
    [id, identity(req)]
  );
  if (!result.rows[0]) return res.status(409).json({ error: "Dispatch plan changed concurrently" });
  await audit({ userId: identity(req), plan: await currentPlan(identity(req)), capability: "ACTION", action: "APPROVE_DISPATCH_PLAN", allowed: true, metadata: { dispatchPlanId: id } });
  return res.json({ dispatchPlan: result.rows[0] });
});

router.post("/business/dispatch-plans/:id/execute", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plan = (await client.query("SELECT * FROM business_dispatch_plans WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!plan) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Dispatch plan not found" }); }
    const member = await businessMember(identity(req), plan.business_id);
    if ((req as any).user?.role !== "ADMIN" && (!member || !canDispatchBusiness(member.memberRole as any))) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Business dispatch authorization required" });
    }
    if (plan.status === "EXECUTED") { await client.query("COMMIT"); return res.json({ dispatchPlan: plan, idempotent: true }); }
    if (plan.status === "CANCELLED") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Cancelled dispatch plan cannot be executed" }); }
    if (plan.approval_required && plan.status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Dispatch plan approval is required before execution", code: "APPROVAL_REQUIRED" });
    }
    if (!plan.approval_required && plan.status !== "PREPARED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Only prepared dispatch plans can be executed" });
    }

    const dispatch = plan.plan ?? {};
    const deliveryIds = Array.isArray(dispatch.deliveryIds) ? dispatch.deliveryIds.filter((v: unknown) => typeof v === "string") : [];
    const buyOrderIds = Array.isArray(dispatch.buyOrderIds) ? dispatch.buyOrderIds.filter((v: unknown) => typeof v === "string") : [];
    const createdBuyOrderIds = Array.isArray(dispatch.createdBuyOrderIds) ? dispatch.createdBuyOrderIds.filter((v: unknown) => typeof v === "string") : [];
    const requiresPaymentAuthorization = dispatch.requiresPaymentAuthorization === true || createdBuyOrderIds.length > 0;

    if (deliveryIds.length) {
      const invalid = await client.query(
        "SELECT id,status,driver_id FROM deliveries WHERE id=ANY($1::uuid[]) AND status NOT IN ('PAYMENT_AUTHORIZED','DRIVER_ASSIGNED')",
        [deliveryIds]
      );
      if (invalid.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "One or more deliveries are no longer dispatchable", deliveries: invalid.rows });
      }
    }

    if (buyOrderIds.length) {
      const buyOrders = await client.query(
        "SELECT id,status,payment_status,purchase_budget_minor FROM buy_orders WHERE id=ANY($1::uuid[]) AND business_id=$2 FOR UPDATE",
        [buyOrderIds, plan.business_id]
      );
      if (buyOrders.rows.length !== buyOrderIds.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "One or more Buy & Deliver orders are missing from this business dispatch plan" });
      }
      if (requiresPaymentAuthorization) {
        const unpaid = buyOrders.rows.filter((row: any) => !["HELD", "AUTHORIZED"].includes(String(row.payment_status)));
        if (unpaid.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Buy & Deliver payment authorization is required before this recurring dispatch can execute",
            code: "PAYMENT_AUTHORIZATION_REQUIRED",
            buyOrders: unpaid.map((row: any) => ({ id: row.id, paymentStatus: row.payment_status, status: row.status }))
          });
        }
      }
    }

    const updated = await client.query(
      "UPDATE business_dispatch_plans SET status='EXECUTED',executed_at=now(),updated_at=now() WHERE id=$1 AND status IN ('PREPARED','APPROVED') RETURNING *",
      [id]
    );
    if (!updated.rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Dispatch plan changed concurrently" }); }

    // Execution releases the selected deliveries into the existing driver-matching
    // workflow. Record one durable delivery event per release so customers,
    // operators, and audit tooling can see why the delivery became dispatchable.
    if (deliveryIds.length) {
      await client.query(
        `INSERT INTO delivery_events (delivery_id, event_type, actor_user_id, metadata)
         SELECT unnest($1::uuid[]), 'BUSINESS_DISPATCH_RELEASED', $2, $3::jsonb`,
        [deliveryIds, identity(req), JSON.stringify({ dispatchPlanId: id, businessId: plan.business_id })]
      );
    }

    await client.query(
      "INSERT INTO ai_audit_log(user_id,plan,capability,action,allowed,reason,metadata) VALUES($1,(SELECT ai_plan FROM users WHERE id=$1),'ACTION','EXECUTE_DISPATCH_PLAN',true,'Dispatch plan released to operational workflow',$2::jsonb)",
      [identity(req), JSON.stringify({ dispatchPlanId: id, deliveryIds })]
    );
    await client.query("COMMIT");
    return res.json({ dispatchPlan: updated.rows[0], releasedDeliveryIds: deliveryIds });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
});

router.post("/business/dispatch-plans/:id/cancel", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id);
  const current = (await pool.query("SELECT * FROM business_dispatch_plans WHERE id=$1", [id])).rows[0];
  if (!current) return res.status(404).json({ error: "Dispatch plan not found" });
  const member = await businessMember(identity(req), current.business_id);
  if ((req as any).user?.role !== "ADMIN" && (!member || !canDispatchBusiness(member.memberRole as any))) {
    return res.status(403).json({ error: "Business dispatch authorization required" });
  }
  if (["EXECUTED","CANCELLED"].includes(current.status)) return res.status(409).json({ error: "This dispatch plan can no longer be cancelled" });
  const result = await pool.query(
    "UPDATE business_dispatch_plans SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status IN ('PREPARED','APPROVED') RETURNING *",
    [id]
  );
  if (!result.rows[0]) return res.status(409).json({ error: "Dispatch plan changed concurrently" });
  return res.json({ dispatchPlan: result.rows[0] });
});

router.post("/buy-orders/:id/payment/initialize", requireAuth("CUSTOMER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Buy & Deliver payments require the production database" });
  const id = String(req.params.id ?? "").trim();
  const customerId = identity(req);
  const orderResult = await pool.query("SELECT id, customer_user_id, purchase_budget_minor, currency, status FROM buy_orders WHERE id=$1", [id]);
  const order = orderResult.rows[0];
  if (!order || order.customer_user_id !== customerId) return res.status(404).json({ error: "Buy & Deliver order not found" });
  if (["CANCELLED", "DELIVERED", "DISPUTED"].includes(order.status)) return res.status(409).json({ error: "This order cannot accept a new payment" });

  const existing = await pool.query("SELECT id, provider, provider_reference, amount_minor, currency, status, authorization_url, access_code FROM buy_order_payments WHERE buy_order_id=$1", [id]);
  const current = existing.rows[0];
  if (current && ["HELD", "AUTHORIZED"].includes(current.status)) return res.json({ payment: current, message: "Payment is already authorized/held" });
  if (current?.status === "PENDING" && current.authorization_url && current.provider_reference) return res.json({ payment: current, authorizationUrl: current.authorization_url, accessCode: current.access_code });

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (process.env.PAYMENT_PROVIDER && process.env.PAYMENT_PROVIDER !== "paystack") return res.status(503).json({ error: "Buy & Deliver payment provider is not supported" });
  if (!secret) return res.status(503).json({ error: "Paystack payment configuration is not ready" });
  const userResult = await pool.query("SELECT email FROM users WHERE id=$1", [customerId]);
  const email = String(userResult.rows[0]?.email ?? "").trim();
  if (!email) return res.status(409).json({ error: "A customer email address is required before payment" });
  const amountMinor = Number(order.purchase_budget_minor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return res.status(409).json({ error: "Buy & Deliver payment amount is invalid" });

  const reference = "sd_buy_" + id.replaceAll("-", "") + "_" + randomUUID().replaceAll("-", "");
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({ email, amount: String(amountMinor), currency: String(order.currency ?? "NGN"), reference, metadata: { buyOrderId: id, customerUserId: customerId, paymentScope: "BUY_AND_DELIVER_PURCHASE_BUDGET" } })
  });
  const payload = await response.json() as { status?: boolean; message?: string; data?: { authorization_url?: string; access_code?: string; reference?: string } };
  if (!response.ok || !payload.status || !payload.data?.reference || !payload.data.authorization_url) return res.status(502).json({ error: payload.message ?? "Paystack payment initialization failed" });

  const providerReference = payload.data.reference;
  const paymentResult = await pool.query(
    "INSERT INTO buy_order_payments (buy_order_id, provider, provider_reference, amount_minor, currency, status, authorization_url, access_code) VALUES ($1,'paystack',$2,$3,$4,'PENDING',$5,$6) ON CONFLICT (buy_order_id) DO UPDATE SET provider='paystack', provider_reference=EXCLUDED.provider_reference, amount_minor=EXCLUDED.amount_minor, currency=EXCLUDED.currency, status='PENDING', authorization_url=EXCLUDED.authorization_url, access_code=EXCLUDED.access_code, updated_at=now() RETURNING id, buy_order_id, provider, provider_reference, amount_minor, currency, status, authorization_url, access_code, created_at, updated_at",
    [id, providerReference, amountMinor, String(order.currency ?? "NGN"), payload.data.authorization_url, payload.data.access_code ?? null]
  );
  await pool.query("UPDATE buy_orders SET payment_reference=$2, payment_status='PENDING', updated_at=now() WHERE id=$1", [id, providerReference]);
  await pool.query("INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'PAYMENT_INITIALIZED',$3::jsonb)", [id, customerId, JSON.stringify({ provider: "paystack", reference: providerReference, amountMinor })]);
  return res.status(201).json({ payment: paymentResult.rows[0], authorizationUrl: payload.data.authorization_url, accessCode: payload.data.access_code ?? null });
});


router.post("/business/dispatch-plans/:id/authorize-buy-orders", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Business payment authorization requires the production database" });
  const planId = String(req.params.id ?? "").trim();
  const userId = identity(req);
  const plan = (await pool.query(
    "SELECT id,business_id,status,approval_required,plan FROM business_dispatch_plans WHERE id=$1",
    [planId]
  )).rows[0];
  if (!plan) return res.status(404).json({ error: "Dispatch plan not found" });

  const member = await businessMember(userId, plan.business_id);
  if ((req as any).user?.role !== "ADMIN" && (!member || !["OWNER","ADMIN"].includes(member.memberRole))) {
    return res.status(403).json({ error: "Business payment authorization authority required" });
  }
  if (["CANCELLED", "EXECUTED"].includes(String(plan.status))) {
    return res.status(409).json({ error: "This dispatch plan can no longer be financially authorized" });
  }
  if (plan.approval_required && plan.status !== "APPROVED") {
    return res.status(409).json({
      error: "Dispatch plan approval is required before payment authorization",
      code: "APPROVAL_REQUIRED"
    });
  }

  const buyOrderIds = Array.isArray(plan.plan?.buyOrderIds)
    ? plan.plan.buyOrderIds.filter((v: unknown) => typeof v === "string")
    : [];
  if (!buyOrderIds.length) return res.json({ dispatchPlanId: planId, authorizedBuyOrderIds: [], failedBuyOrders: [] });

  const orders = await pool.query(
    `SELECT id,customer_user_id,purchase_budget_minor,currency,status,payment_status
       FROM buy_orders
      WHERE id=ANY($1::uuid[]) AND business_id=$2
      ORDER BY created_at ASC`,
    [buyOrderIds, plan.business_id]
  );

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: "Paystack payment configuration is not ready" });

  // A business may have multiple members with separate reusable Paystack
  // authorizations. Resolve the latest active authorization for every order owner
  // in one query so large recurring batches do not create an N+1 query pattern.
  const ownerIds = [...new Set(
    orders.rows
      .map((order: any) => String(order.customer_user_id ?? ""))
      .filter(Boolean)
  )];
  const authorizationByUser = new Map<string, any>();
  if (ownerIds.length) {
    const authorizations = await pool.query(
      `SELECT DISTINCT ON (user_id)
          id,user_id,authorization_code,email,status
         FROM business_payment_authorizations
        WHERE business_id=$1
          AND user_id=ANY($2::uuid[])
          AND status='ACTIVE'
        ORDER BY user_id,updated_at DESC`,
      [plan.business_id, ownerIds]
    );
    for (const authorization of authorizations.rows) {
      authorizationByUser.set(String(authorization.user_id), authorization);
    }
  }

  const authorizedBuyOrderIds: string[] = [];
  const failedBuyOrders: Array<{ id: string; reason: string }> = [];
  const paymentAuthorizationRequired: Array<{ id: string; authorizationUrl: string | null; accessCode: string | null }> = [];

  for (const order of orders.rows) {
    const authorization = authorizationByUser.get(String(order.customer_user_id ?? ""));
    if (!authorization) {
      failedBuyOrders.push({ id: order.id, reason: "PAYMENT_AUTHORIZATION_REQUIRED" });
      continue;
    }
    if (String(order.customer_user_id ?? "") !== String(authorization.user_id ?? "")) {
      failedBuyOrders.push({ id: order.id, reason: "PAYMENT_AUTHORIZATION_OWNER_MISMATCH" });
      continue;
    }
    if (["HELD", "AUTHORIZED"].includes(String(order.payment_status))) {
      authorizedBuyOrderIds.push(order.id);
      continue;
    }

    const amountMinor = Number(order.purchase_budget_minor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      failedBuyOrders.push({ id: order.id, reason: "INVALID_PURCHASE_BUDGET" });
      continue;
    }

    const reference = "sd-recurring-" + planId.replaceAll("-", "") + "-" + order.id.replaceAll("-", "");
    const payment = await pool.query(
      `INSERT INTO buy_order_payments
         (buy_order_id,provider,provider_reference,amount_minor,currency,status)
       VALUES ($1,'paystack',$2,$3,$4,'PENDING')
       ON CONFLICT (buy_order_id)
       DO UPDATE SET
         provider='paystack',
         amount_minor=EXCLUDED.amount_minor,
         currency=EXCLUDED.currency,
         provider_reference=CASE
           WHEN buy_order_payments.status='FAILED' THEN EXCLUDED.provider_reference
           ELSE buy_order_payments.provider_reference
         END,
         status=CASE
           WHEN buy_order_payments.status='FAILED' THEN 'PENDING'
           ELSE buy_order_payments.status
         END,
         updated_at=now()
       RETURNING id,provider_reference,status,amount_minor,currency`,
      [order.id, reference, amountMinor, String(order.currency ?? "NGN")]
    );

    const paymentRow = payment.rows[0];
    let effectiveReference = String(paymentRow.provider_reference || reference);

    try {
      if (paymentRow.status === "HELD" || paymentRow.status === "AUTHORIZED") {
        authorizedBuyOrderIds.push(order.id);
        continue;
      }

      if (paymentRow.status === "PENDING" && paymentRow.provider_reference) {
        const verify = await fetch(
          "https://api.paystack.co/transaction/verify/" + encodeURIComponent(paymentRow.provider_reference),
          { headers: { authorization: "Bearer " + secret }, signal: AbortSignal.timeout(15_000) }
        ).catch(() => null);
        const verified = verify ? await verify.json().catch(() => null) as any : null;
        const verifiedStatus = String(verified?.data?.status ?? "").toLowerCase();
        const verifiedAmount = Number(verified?.data?.amount);
        const verifiedCurrency = String(verified?.data?.currency ?? "").trim();

        if (verifiedStatus === "success") {
          if (verifiedAmount !== amountMinor || verifiedCurrency !== String(order.currency ?? "NGN").trim()) {
            await pool.query(
              "UPDATE buy_order_payments SET status='FAILED',provider_status='amount_mismatch_reconciliation',updated_at=now() WHERE id=$1 AND status='PENDING'",
              [paymentRow.id]
            );
            failedBuyOrders.push({ id: order.id, reason: "PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH" });
            continue;
          }
          await pool.query(
            "UPDATE buy_order_payments SET status='HELD',provider_status='success_reconciled',updated_at=now() WHERE id=$1 AND status='PENDING'",
            [paymentRow.id]
          );
          await pool.query(
            "UPDATE buy_orders SET payment_reference=$2,payment_status='HELD',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('REFUNDED')",
            [order.id, paymentRow.provider_reference]
          );
          authorizedBuyOrderIds.push(order.id);
          continue;
        }

        if (!["failed","abandoned","reversed","reversal"].includes(verifiedStatus)) {
          failedBuyOrders.push({ id: order.id, reason: "EXISTING_PAYMENT_STILL_PENDING" });
          continue;
        }

        effectiveReference = reference;
        await pool.query(
          "UPDATE buy_order_payments SET provider_reference=$2,status='PENDING',provider_status=$3,updated_at=now() WHERE id=$1 AND status='PENDING'",
          [paymentRow.id, effectiveReference, verifiedStatus]
        );
      }

      const response = await fetch("https://api.paystack.co/transaction/charge_authorization", {
        method: "POST",
        headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
        body: JSON.stringify({
          email: authorization.email,
          amount: String(amountMinor),
          authorization_code: authorization.authorization_code,
          reference: effectiveReference,
          currency: String(order.currency ?? "NGN"),
          metadata: {
            buyOrderId: order.id,
            dispatchPlanId: planId,
            businessId: plan.business_id,
            paymentScope: "RECURRING_BUY_AND_DELIVER"
          }
        }),
        signal: AbortSignal.timeout(20_000)
      });
      const payload = await response.json() as {
        status?: boolean;
        message?: string;
        data?: { status?: string; reference?: string; amount?: number; currency?: string; authorization_url?: string; access_code?: string; } ;
      };

      const providerReference = String(payload.data?.reference ?? reference);
      const providerAmount = Number(payload.data?.amount ?? amountMinor);
      const providerCurrency = String(payload.data?.currency ?? order.currency ?? "NGN");
      const successful = response.ok &&
        payload.status === true &&
        String(payload.data?.status ?? "").toLowerCase() === "success" &&
        providerAmount === amountMinor &&
        providerCurrency.trim() === String(order.currency ?? "NGN").trim();

      if (!successful) {
        const providerStatus = String(payload.data?.status ?? "").toLowerCase();
        const challenged = providerStatus === "paused" || Boolean(payload.data?.authorization_url);
        const authorizationUrl = typeof payload.data?.authorization_url === "string" ? payload.data.authorization_url : null;
        const accessCode = typeof payload.data?.access_code === "string" ? payload.data.access_code : null;

        if (challenged) {
          await pool.query(
            "UPDATE buy_order_payments SET status='PENDING',provider_reference=$2,provider_status='authorization_required',authorization_url=$3,access_code=$4,updated_at=now() WHERE id=$1",
            [paymentRow.id, providerReference, authorizationUrl, accessCode]
          );
          paymentAuthorizationRequired.push({ id: order.id, authorizationUrl, accessCode });
          failedBuyOrders.push({ id: order.id, reason: "PAYMENT_AUTHORIZATION_REQUIRED" });
          continue;
        }

        await pool.query(
          "UPDATE buy_order_payments SET status='FAILED',provider_reference=$2,provider_status=$3,updated_at=now() WHERE id=$1",
          [paymentRow.id, providerReference, providerStatus || "charge_failed"]
        );
        if (["invalid_authorization","authorization_invalid","expired_authorization"].includes(providerStatus)) {
          await pool.query(
            "UPDATE business_payment_authorizations SET status='REVOKED',updated_at=now() WHERE id=$1 AND status='ACTIVE'",
            [authorization.id]
          );
        }
        failedBuyOrders.push({ id: order.id, reason: payload.message ?? "Paystack recurring charge failed" });
        continue;
      }

      await pool.query(
        "UPDATE buy_order_payments SET status='HELD',provider_reference=$2,updated_at=now() WHERE id=$1",
        [paymentRow.id, providerReference]
      );
      await pool.query(
        "UPDATE buy_orders SET payment_reference=$2,payment_status='HELD',updated_at=now() WHERE id=$1 AND payment_status NOT IN ('REFUNDED')",
        [order.id, providerReference]
      );
      await pool.query(
        "UPDATE business_payment_authorizations SET last_used_at=now(),updated_at=now() WHERE id=$1 AND status='ACTIVE'",
        [authorization.id]
      );
      await pool.query(
        "INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,'RECURRING_PAYMENT_CHARGED',$3::jsonb)",
        [order.id, userId, JSON.stringify({ dispatchPlanId: planId, provider: "paystack", reference: providerReference, amountMinor })]
      );
      authorizedBuyOrderIds.push(order.id);
    } catch (error) {
      await pool.query(
        "UPDATE buy_order_payments SET status='PENDING',updated_at=now() WHERE id=$1",
        [paymentRow.id]
      );
      failedBuyOrders.push({ id: order.id, reason: error instanceof Error ? error.message : "Paystack recurring charge request failed" });
    }
  }

  if (failedBuyOrders.length) {
    return res.status(409).json({
      error: "One or more Buy & Deliver payments could not be authorized",
      code: "PAYMENT_AUTHORIZATION_INCOMPLETE",
      dispatchPlanId: planId,
      authorizedBuyOrderIds,
      failedBuyOrders,
      paymentAuthorizationRequired
    });
  }
  await audit({
    userId,
    plan: await currentPlan(userId),
    capability: "ACTION",
    action: "AUTHORIZE_RECURRING_BUY_ORDERS",
    allowed: true,
    metadata: { dispatchPlanId: planId, authorizedBuyOrderIds }
  });
  return res.json({ dispatchPlanId: planId, authorizedBuyOrderIds, failedBuyOrders: [], paymentAuthorizationRequired: [] });
});

router.get("/buy-orders/:id/payment/status", requireAuth("CUSTOMER", "AGENT", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Buy & Deliver payments require the production database" });
  const id = String(req.params.id ?? "").trim();
  const result = await pool.query("SELECT bop.*, bo.customer_user_id, bo.payment_status AS order_payment_status FROM buy_order_payments bop JOIN buy_orders bo ON bo.id=bop.buy_order_id WHERE bop.buy_order_id=$1", [id]);
  if (!result.rows[0]) return res.status(404).json({ error: "Buy & Deliver payment not found" });
  const row = result.rows[0];
  const role = (req as any).user?.role;
  if (role === "CUSTOMER" && row.customer_user_id !== identity(req)) return res.status(403).json({ error: "Not authorized" });
  return res.json({ payment: row });
});

router.get("/buy-orders", requireAuth("CUSTOMER", "AGENT", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Buy & Deliver requires the production database" });
  const userId = identity(req);
  const result = (req as any).user?.role === "ADMIN"
    ? await pool!.query("SELECT * FROM buy_orders ORDER BY created_at DESC LIMIT 200")
    : (req as any).user?.role === "AGENT"
      ? await pool!.query("SELECT bo.* FROM buy_orders bo JOIN agent_profiles ap ON ap.id=bo.agent_id WHERE ap.user_id=$1 ORDER BY bo.created_at DESC LIMIT 100", [userId])
      : await pool!.query("SELECT * FROM buy_orders WHERE customer_user_id=$1 ORDER BY created_at DESC LIMIT 100", [userId]);
  res.json({ buyOrders: result.rows });
});

router.post("/business/accounts", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Business accounts require the production database" });
  const userId = identity(req);
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await pool!.query(
    `INSERT INTO business_accounts
      (owner_user_id, legal_name, display_name, registration_number, monthly_spend_limit_minor, per_order_limit_minor, requires_approval, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [userId, parsed.data.legalName, parsed.data.displayName, parsed.data.registrationNumber ?? null, parsed.data.monthlySpendLimitMinor, parsed.data.perOrderLimitMinor, parsed.data.requiresApproval, (req as any).user?.role === "ADMIN" ? "ACTIVE" : "PENDING"]
  );
  await pool!.query("INSERT INTO business_members (business_id, user_id, member_role) VALUES ($1,$2,'OWNER')", [result.rows[0].id, userId]);
  res.status(201).json({ business: result.rows[0] });
});

router.get("/admin/business/recurring-dispatches", requireAuth("ADMIN"), async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT rd.*, ba.display_name AS business_name,
            bdp.status AS plan_status, bdp.created_at AS plan_created_at
       FROM business_recurring_dispatches rd
       JOIN business_accounts ba ON ba.id=rd.business_id
       LEFT JOIN business_dispatch_plans bdp ON bdp.id=rd.last_dispatch_plan_id
      ORDER BY rd.active DESC, rd.next_run_at ASC
      LIMIT 200`
  );
  res.json({ recurringDispatches: result.rows });
});

router.get("/business/accounts", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Business accounts require the production database" });
  const userId = identity(req);
  const result = (req as any).user?.role === "ADMIN"
    ? await pool!.query("SELECT * FROM business_accounts ORDER BY created_at DESC LIMIT 200")
    : await pool!.query("SELECT ba.* FROM business_accounts ba JOIN business_members bm ON bm.business_id=ba.id WHERE bm.user_id=$1 AND bm.active=true ORDER BY ba.created_at DESC", [userId]);
  res.json({ businesses: result.rows });
});

const dropOffApplicationSchema = z.object({
  businessId: z.string().uuid().optional(), legalName: z.string().trim().min(2).max(200).optional(), displayName: z.string().trim().min(2).max(120).optional(),
  registrationNumber: z.string().trim().max(100).optional(), name: z.string().trim().min(2).max(160), address: z.string().trim().min(5).max(500),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), phone: z.string().trim().min(7).max(30),
  operatingHours: z.record(z.string(), z.string()).default({}), capacity: z.number().int().min(1).max(10000).default(50),
  commissionMinor: z.literal(50000).default(50000)
});
async function managesDropOff(userId: string, locationId: string): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query("SELECT 1 FROM drop_off_locations dl JOIN business_accounts ba ON ba.id=dl.business_id LEFT JOIN business_members bm ON bm.business_id=ba.id AND bm.user_id=$2 AND bm.active=true WHERE dl.id=$1 AND (ba.owner_user_id=$2 OR bm.member_role IN ('OWNER','ADMIN'))",[locationId,userId]);
  return Boolean(result.rows[0]);
}
router.post("/drop-off/applications", requireAuth("CUSTOMER","AGENT","ADMIN"), async (req,res) => {
  if (!pool) return res.status(503).json({error:"Drop-off applications require the production database"});
  const parsed=dropOffApplicationSchema.safeParse(req.body); if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const d=parsed.data,userId=identity(req),client=await pool.connect();
  try {
    await client.query("BEGIN"); let businessId=d.businessId;
    if(businessId){
      const managed=await client.query("SELECT 1 FROM business_accounts ba LEFT JOIN business_members bm ON bm.business_id=ba.id AND bm.user_id=$2 AND bm.active=true WHERE ba.id=$1 AND (ba.owner_user_id=$2 OR bm.member_role IN ('OWNER','ADMIN'))",[businessId,userId]);
      if(!managed.rows[0]){await client.query("ROLLBACK");return res.status(403).json({error:"You do not manage this business"});}
    } else {
      const b=await client.query("INSERT INTO business_accounts(owner_user_id,legal_name,display_name,registration_number,status) VALUES($1,$2,$3,$4,'PENDING') RETURNING id",[userId,d.legalName??d.displayName??d.name,d.displayName??d.name,d.registrationNumber??null]);
      businessId=b.rows[0].id; await client.query("INSERT INTO business_members(business_id,user_id,member_role) VALUES($1,$2,'OWNER')",[businessId,userId]);
    }
    const location=await client.query("INSERT INTO drop_off_locations(business_id,name,address,latitude,longitude,phone,operating_hours,capacity,commission_minor) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *",[businessId,d.name,d.address,d.latitude,d.longitude,d.phone,JSON.stringify(d.operatingHours),d.capacity,50000]);
    await client.query("INSERT INTO drop_off_application_audit(location_id,actor_user_id,new_status,note) VALUES($1,$2,'PENDING','Application submitted')",[location.rows[0].id,userId]);
    await client.query("COMMIT"); res.status(201).json({location:location.rows[0]});
  } catch(e){await client.query("ROLLBACK");res.status(400).json({error:e instanceof Error?e.message:"Unable to submit application"});} finally{client.release();}
});
router.get("/drop-off/locations", requireAuth("CUSTOMER","AGENT","ADMIN"), async (req,res) => {
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const latitude=Number(req.query.latitude),longitude=Number(req.query.longitude),radiusKm=Math.min(100,Math.max(1,Number(req.query.radiusKm)||25));
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return res.status(400).json({error:"latitude and longitude are required"});
  const latDelta=radiusKm/111,lngDelta=radiusKm/(111*Math.max(.2,Math.cos(latitude*Math.PI/180)));
  const result=await pool.query("SELECT dl.*,ba.display_name AS business_name FROM drop_off_locations dl JOIN business_accounts ba ON ba.id=dl.business_id WHERE dl.status='ACTIVE' AND dl.verification_status='VERIFIED' AND dl.latitude BETWEEN $1 AND $2 AND dl.longitude BETWEEN $3 AND $4 LIMIT 200",[latitude-latDelta,latitude+latDelta,longitude-lngDelta,longitude+lngDelta]);
  const locations=result.rows.map(row=>{const p1=latitude*Math.PI/180,p2=Number(row.latitude)*Math.PI/180,dp=(Number(row.latitude)-latitude)*Math.PI/180,dl=(Number(row.longitude)-longitude)*Math.PI/180,h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return {...row,distanceKm:6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h))}}).filter(row=>row.distanceKm<=radiusKm).sort((a,b)=>a.distanceKm-b.distanceKm);
  res.json({locations});
});
router.get("/drop-off/locations/mine", requireAuth("CUSTOMER","AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const result=await pool.query("SELECT dl.*,ba.display_name AS business_name FROM drop_off_locations dl JOIN business_accounts ba ON ba.id=dl.business_id WHERE ba.owner_user_id=$1 OR EXISTS (SELECT 1 FROM business_members bm WHERE bm.business_id=ba.id AND bm.user_id=$1 AND bm.active=true AND bm.member_role IN ('OWNER','ADMIN')) ORDER BY dl.created_at DESC",[identity(req)]);
  res.json({locations:result.rows});
});
router.post("/drop-off/locations/:id/documents", requireAuth("CUSTOMER","AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parsed=z.object({documentType:z.enum(["BUSINESS_REGISTRATION","PREMISES_EVIDENCE","IDENTITY","OTHER"]),dataUrl:z.string().min(20).max(8_000_000)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const locationId=String(req.params.id);
  if((req as any).user?.role!=="ADMIN"&&!await managesDropOff(identity(req),locationId))return res.status(403).json({error:"Not authorized"});
  const m=parsed.data.dataUrl.match(/^data:(application\/pdf|image\/(?:jpeg|jpg|png));base64,(.+)$/i);
  if(!m)return res.status(400).json({error:"Document must be PDF, JPEG, JPG or PNG"});
  const bytes=Buffer.from(m[2],"base64"); if(bytes.length>5*1024*1024)return res.status(400).json({error:"Document exceeds 5MB"});
  const key="drop-off/"+locationId+"/documents/"+crypto.randomUUID();
  try{
    await putPrivateObject(key,bytes,m[1]);
    const saved=await pool.query("INSERT INTO drop_off_location_documents(location_id,document_type,storage_key,status) VALUES($1,$2,$3,'PENDING') RETURNING id,document_type,status,created_at",[locationId,parsed.data.documentType,key]);
    res.status(201).json({document:saved.rows[0]});
  }catch(e){res.status(503).json({error:e instanceof Error?e.message:"Unable to store document"});}
});

router.post("/admin/business/accounts/:id/status", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parsed=z.object({status:z.enum(["PENDING","ACTIVE","SUSPENDED"])}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const result=await pool.query("UPDATE business_accounts SET status=$2,updated_at=now() WHERE id=$1 RETURNING *",[String(req.params.id),parsed.data.status]);
  if(!result.rows[0])return res.status(404).json({error:"Business account not found"});
  await pool.query("INSERT INTO ai_audit_log(user_id,plan,capability,action,allowed,reason,metadata) VALUES((SELECT owner_user_id FROM business_accounts WHERE id=$1),(SELECT ai_plan FROM users WHERE id=(SELECT owner_user_id FROM business_accounts WHERE id=$1)),'ADMIN_BUSINESS_STATUS','UPDATE',true,'Admin status update',$2::jsonb)",[String(req.params.id),JSON.stringify({businessId:String(req.params.id),status:parsed.data.status})]);
  return res.json({business:result.rows[0]});
});

router.post("/admin/ai/users/:id/plan", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parsed=z.object({plan:z.enum(["BASIC","PREMIUM"]),reason:z.string().trim().min(3).max(500)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const current=(await client.query("SELECT id,ai_plan FROM users WHERE id=$1 FOR UPDATE",[String(req.params.id)])).rows[0];
    if(!current){await client.query("ROLLBACK");return res.status(404).json({error:"User not found"});}
    if(current.ai_plan!==parsed.data.plan){
      await client.query("UPDATE users SET ai_plan=$2 WHERE id=$1",[current.id,parsed.data.plan]);
      await client.query("INSERT INTO ai_entitlement_events(user_id,old_plan,new_plan,changed_by_user_id,reason) VALUES($1,$2,$3,$4,$5)",[current.id,current.ai_plan,parsed.data.plan,identity(req),parsed.data.reason]);
    }
    await client.query("COMMIT");
    return res.json({userId:current.id,plan:parsed.data.plan});
  }catch(error){await client.query("ROLLBACK");return res.status(500).json({error:error instanceof Error?error.message:"Unable to update AI entitlement"});}
  finally{client.release();}
});

router.get("/drop-off/settlement-account/:id", requireAuth("CUSTOMER","AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const id=String(req.params.id),role=(req as any).user?.role;
  if(role!=="ADMIN"&&!await managesDropOff(identity(req),id))return res.status(403).json({error:"Not authorized"});
  const result=await pool.query("SELECT id,bank_code,bank_name,account_name,account_last4,currency,active,verified_at,created_at,updated_at FROM drop_off_settlement_accounts WHERE location_id=$1",[id]);
  res.json({account:result.rows[0]??null});
});
router.post("/drop-off/settlement-account/:id", requireAuth("CUSTOMER","AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const id=String(req.params.id),role=(req as any).user?.role;
  if(role!=="ADMIN"&&!await managesDropOff(identity(req),id))return res.status(403).json({error:"Not authorized"});
  const parsed=z.object({bankCode:z.string().regex(/^\\d{3,6}$/),accountNumber:z.string().regex(/^\\d{10}$/)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"A valid Nigerian bank code and 10-digit account number are required"});
  const secret=process.env.PAYSTACK_SECRET_KEY;if(!secret)return res.status(503).json({error:"Paystack transfers are not configured"});
  const rr=await fetch("https://api.paystack.co/bank/resolve?account_number="+encodeURIComponent(parsed.data.accountNumber)+"&bank_code="+encodeURIComponent(parsed.data.bankCode),{headers:{authorization:"Bearer "+secret}});
  const resolved=await rr.json() as any;
  if(!rr.ok||!resolved.status||!resolved.data?.account_name)return res.status(400).json({error:resolved.message??"Unable to verify the bank account"});
  const cr=await fetch("https://api.paystack.co/transferrecipient",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({type:"nuban",name:resolved.data.account_name,account_number:parsed.data.accountNumber,bank_code:parsed.data.bankCode,currency:"NGN"})});
  const recipient=await cr.json() as any;
  if(!cr.ok||!recipient.status||!recipient.data?.recipient_code)return res.status(400).json({error:recipient.message??"Unable to create payout recipient"});
  const saved=await pool.query(`INSERT INTO drop_off_settlement_accounts(location_id,recipient_code,bank_code,bank_name,account_name,account_last4,currency,active,verified_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'NGN',true,now(),now())
    ON CONFLICT(location_id) DO UPDATE SET recipient_code=EXCLUDED.recipient_code,bank_code=EXCLUDED.bank_code,bank_name=EXCLUDED.bank_name,account_name=EXCLUDED.account_name,account_last4=EXCLUDED.account_last4,active=true,verified_at=now(),updated_at=now()
    RETURNING id,bank_code,bank_name,account_name,account_last4,currency,active,verified_at,created_at,updated_at`,
    [id,recipient.data.recipient_code,parsed.data.bankCode,recipient.data.details?.bank_name??null,resolved.data.account_name,parsed.data.accountNumber.slice(-4)]);
  res.status(201).json({account:saved.rows[0]});
});
router.post("/admin/buy-order-settlements/:id/pay", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const secret=process.env.PAYSTACK_SECRET_KEY;if(!secret)return res.status(503).json({error:"Paystack transfers are not configured"});
  const id=String(req.params.id),client=await pool.connect();
  try{
    await client.query("BEGIN");
    const row=(await client.query("SELECT s.*,a.recipient_code,a.active AS account_active FROM buy_order_settlements s JOIN agent_settlement_accounts a ON a.agent_id=s.agent_id WHERE s.id=$1 FOR UPDATE",[id])).rows[0];
    if(!row){await client.query("ROLLBACK");return res.status(404).json({error:"Settlement not found"});}
    if(!["PENDING","FAILED"].includes(row.status)){await client.query("ROLLBACK");return res.status(409).json({error:"Settlement is not eligible for payout"});}
    if(!row.account_active||Number(row.amount_minor)<=0){await client.query("ROLLBACK");return res.status(409).json({error:"Active payout account and positive settlement are required"});}
    const reference="sd_buyset_"+randomUUID().replaceAll("-","");
    await client.query("UPDATE buy_order_settlements SET status='PROCESSING',transfer_reference=$2,provider_status='pending',failure_reason=NULL,updated_at=now() WHERE id=$1",[id,reference]);
    await client.query("COMMIT");
    let response: Response;
    try {
      response=await fetch("https://api.paystack.co/transfer",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({source:"balance",amount:Number(row.amount_minor),recipient:row.recipient_code,reference,reason:"SwiftDrop Buy & Deliver agent settlement",currency:row.currency}),signal:AbortSignal.timeout(15_000)});
    } catch(error) {
      await pool.query("UPDATE buy_order_settlements SET provider_status='unknown',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='PROCESSING'",[id,error instanceof Error?error.message:"Paystack transfer result is inconclusive"]);
      return res.status(202).json({error:"Settlement transfer result is pending provider reconciliation",code:"PAYOUT_RECONCILIATION_REQUIRED"});
    }
    const payload=await response.json() as any;
    if(!response.ok||!payload.status||!payload.data?.reference){
      await pool.query("UPDATE buy_order_settlements SET status='FAILED',provider_status='failed',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='PROCESSING'",[id,payload.message??"Paystack transfer failed"]);
      return res.status(502).json({error:payload.message??"Paystack transfer could not be initiated"});
    }
    if(payload.data.reference!==reference)await pool.query("UPDATE buy_order_settlements SET transfer_reference=$2,updated_at=now() WHERE id=$1",[id,payload.data.reference]);
    return res.status(202).json({settlement:(await pool.query("SELECT * FROM buy_order_settlements WHERE id=$1",[id])).rows[0]});
  }catch(error){try{await client.query("ROLLBACK")}catch{}throw error}finally{client.release();}
});
router.post("/admin/drop-off/commission/:id/pay", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const secret=process.env.PAYSTACK_SECRET_KEY;if(!secret)return res.status(503).json({error:"Paystack transfers are not configured"});
  const id=String(req.params.id),client=await pool.connect();
  try{
    await client.query("BEGIN");
    const row=(await client.query("SELECT c.*,a.recipient_code,a.active AS account_active FROM drop_off_commission_ledger c JOIN drop_off_settlement_accounts a ON a.location_id=c.location_id WHERE c.id=$1 FOR UPDATE",[id])).rows[0];
    if(!row){await client.query("ROLLBACK");return res.status(404).json({error:"Commission record not found"});}
    if(row.status!=="AVAILABLE"){await client.query("ROLLBACK");return res.status(409).json({error:"Commission is not available for payout"});}
    if(!row.account_active||Number(row.amount_minor)<=0){await client.query("ROLLBACK");return res.status(409).json({error:"Active payout account and positive commission are required"});}
    const reference="sd_drop_"+randomUUID().replaceAll("-","");
    await client.query("UPDATE drop_off_commission_ledger SET status='PROCESSING',provider_reference=$2,provider_status='pending',updated_at=now() WHERE id=$1 AND status='AVAILABLE'",[id,reference]);
    await client.query("COMMIT");
    const response=await fetch("https://api.paystack.co/transfer",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({source:"balance",amount:Number(row.amount_minor),recipient:row.recipient_code,reference,reason:"SwiftDrop drop-off partner commission",currency:row.currency}),signal:AbortSignal.timeout(15_000)});
    const payload=await response.json() as any;
    if(!response.ok||!payload.status||!payload.data?.reference){
      await pool.query("UPDATE drop_off_commission_ledger SET status='AVAILABLE',provider_status='failed',provider_reference=NULL,updated_at=now() WHERE id=$1 AND status='PROCESSING'",[id]);
      return res.status(502).json({error:payload.message??"Paystack transfer could not be initiated"});
    }
    if(payload.data.reference!==reference)await pool.query("UPDATE drop_off_commission_ledger SET provider_reference=$2,updated_at=now() WHERE id=$1",[id,payload.data.reference]);
    return res.status(202).json({commission:(await pool.query("SELECT * FROM drop_off_commission_ledger WHERE id=$1",[id])).rows[0]});
  }catch(error){try{await client.query("ROLLBACK")}catch{}throw error}finally{client.release();}
});

router.get("/admin/buy-order-settlements", requireAuth("ADMIN"), async(_req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const result=await pool.query("SELECT s.*,bo.item_description,bo.customer_user_id,ap.user_id AS agent_user_id,u.full_name AS agent_name FROM buy_order_settlements s JOIN buy_orders bo ON bo.id=s.buy_order_id JOIN agent_profiles ap ON ap.id=s.agent_id JOIN users u ON u.id=ap.user_id ORDER BY s.created_at DESC LIMIT 200");
  return res.json({settlements:result.rows});
});
router.post("/admin/buy-order-settlements/:id/status", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parsed=z.object({status:z.enum(["PROCESSING","PAID","FAILED","REVERSED"]),providerReference:z.string().trim().max(200).optional(),failureReason:z.string().trim().max(500).optional()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const id=String(req.params.id),client=await pool.connect();
  try{
    await client.query("BEGIN");
    const current=(await client.query("SELECT * FROM buy_order_settlements WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(!current){await client.query("ROLLBACK");return res.status(404).json({error:"Settlement not found"});}
    const reference=parsed.data.providerReference??current.provider_reference??current.transfer_reference;
    if(parsed.data.status==="PAID"&&!reference){await client.query("ROLLBACK");return res.status(400).json({error:"A provider transfer reference is required before marking a settlement paid"});}
    if(parsed.data.status==="PAID"&&current.status==="REVERSED"){await client.query("ROLLBACK");return res.status(409).json({error:"A reversed settlement cannot be marked paid manually"});}
    const result=await client.query("UPDATE buy_order_settlements SET status=$2,provider_reference=COALESCE($3,provider_reference,transfer_reference),failure_reason=COALESCE($4,failure_reason),paid_at=CASE WHEN $2='PAID' THEN COALESCE(paid_at,now()) ELSE paid_at END,updated_at=now() WHERE id=$1 RETURNING *",[id,parsed.data.status,reference??null,parsed.data.failureReason??null]);
    await client.query("INSERT INTO ai_audit_log(user_id,plan,capability,action,allowed,reason,metadata) VALUES($1,(SELECT ai_plan FROM users WHERE id=$1),'SETTLEMENT_STATUS','UPDATE',true,'Admin settlement status update',$2::jsonb)",[identity(req),JSON.stringify({settlementId:id,status:parsed.data.status,providerReference:reference??null})]);
    await client.query("COMMIT");
    return res.json({settlement:result.rows[0]});
  }catch(error){try{await client.query("ROLLBACK")}catch{}throw error}finally{client.release();}
});

router.get("/admin/drop-off/locations/:locationId/documents", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const result=await pool.query("SELECT id,document_type,status,review_note,created_at,updated_at FROM drop_off_location_documents WHERE location_id=$1 ORDER BY created_at ASC",[String(req.params.locationId)]);
  return res.json({documents:result.rows});
});

router.get("/admin/drop-off/locations/:locationId/documents/:documentId", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const row=(await pool.query("SELECT storage_key,document_type,status FROM drop_off_location_documents WHERE id=$1 AND location_id=$2",[String(req.params.documentId),String(req.params.locationId)])).rows[0];
  if(!row?.storage_key)return res.status(404).json({error:"Drop-off document not found"});
  try{
    const object=await getPrivateObject(row.storage_key);
    res.setHeader("Content-Type",object.contentType??"application/octet-stream");
    res.setHeader("Cache-Control","private, no-store");
    return res.send(object.body);
  }catch{return res.status(404).json({error:"Drop-off document is unavailable"});}
});

router.get("/admin/drop-off/commission", requireAuth("ADMIN"), async(_req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const result=await pool.query("SELECT l.id AS location_id,l.name,l.address,ba.display_name AS business_name,c.status,c.currency,count(*)::int AS parcels,sum(c.amount_minor)::bigint AS amount_minor FROM drop_off_commission_ledger c JOIN drop_off_locations l ON l.id=c.location_id JOIN business_accounts ba ON ba.id=l.business_id GROUP BY l.id,l.name,l.address,ba.display_name,c.status,c.currency ORDER BY l.name,c.status");
  return res.json({commission:result.rows});
});

router.get("/admin/drop-off/applications", requireAuth("ADMIN"), async(_req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const result=await pool.query("SELECT dl.*,ba.display_name AS business_name,(SELECT count(*) FROM drop_off_location_documents d WHERE d.location_id=dl.id) AS document_count FROM drop_off_locations dl JOIN business_accounts ba ON ba.id=dl.business_id ORDER BY dl.created_at DESC LIMIT 500");
  res.json({applications:result.rows});
});
router.post("/admin/drop-off/locations/:id/review", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parsed=z.object({status:z.enum(["ACTIVE","SUSPENDED","REJECTED","PENDING"]),note:z.string().max(1000).optional()}).safeParse(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const locationId=String(req.params.id);
  const current=await pool.query("SELECT dl.*,ba.status AS business_status FROM drop_off_locations dl JOIN business_accounts ba ON ba.id=dl.business_id WHERE dl.id=$1",[locationId]);
  if(!current.rows[0])return res.status(404).json({error:"Location not found"});
  const verified=parsed.data.status==="ACTIVE",client=await pool.connect();
  try{
    await client.query("BEGIN");
    if(verified){
      if(current.rows[0].business_status!=="ACTIVE"){await client.query("ROLLBACK");return res.status(409).json({error:"The linked business account must be ACTIVE before a drop-off location can be approved"});}
      const docs=(await client.query("SELECT document_type FROM drop_off_location_documents WHERE location_id=$1 AND status IN ('PENDING','APPROVED')",[locationId])).rows.map((row:any)=>row.document_type);
      const required=["BUSINESS_REGISTRATION","PREMISES_EVIDENCE","IDENTITY"];
      const missing=required.filter(type=>!docs.includes(type));
      if(missing.length){await client.query("ROLLBACK");return res.status(409).json({error:"Required verification documents are missing",missing});}
    }
    const updated=await client.query("UPDATE drop_off_locations SET status=$2,verification_status=$3,verified_by_user_id=CASE WHEN $3='VERIFIED' THEN $4 ELSE verified_by_user_id END,verified_at=CASE WHEN $3='VERIFIED' THEN now() ELSE verified_at END,updated_at=now() WHERE id=$1 RETURNING *",[locationId,parsed.data.status,verified?"VERIFIED":"REJECTED",identity(req)]);
    await client.query("UPDATE drop_off_location_documents SET status=$2,updated_at=now() WHERE location_id=$1 AND status='PENDING'",[locationId,verified?"APPROVED":"REJECTED"]);
    await client.query("INSERT INTO drop_off_application_audit(location_id,actor_user_id,old_status,new_status,note) VALUES($1,$2,$3,$4,$5)",[locationId,identity(req),current.rows[0].status,parsed.data.status,parsed.data.note??null]);
    await client.query("COMMIT");
    res.json({location:updated.rows[0]});
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release();}
});

router.post("/drop-off/parcels", requireAuth("CUSTOMER","AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Drop-off parcels require the production database"});
  const parsed=z.object({deliveryId:z.string().uuid(),locationId:z.string().uuid(),endpoint:z.enum(["PICKUP","DROPOFF"])}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const userId=identity(req),role=(req as any).user?.role;
  const delivery=await pool.query("SELECT id FROM deliveries WHERE id=$1 AND sender_id=$2",[parsed.data.deliveryId,userId]);
  if(!delivery.rows[0]&&role!=="ADMIN")return res.status(404).json({error:"Delivery not found"});
  const location=(await pool.query("SELECT * FROM drop_off_locations WHERE id=$1",[parsed.data.locationId])).rows[0];
  if(!location||location.status!=="ACTIVE"||location.verification_status!=="VERIFIED")return res.status(409).json({error:"Drop-off location is not active"});
  const existing=await pool.query("SELECT * FROM drop_off_parcels WHERE delivery_id=$1 AND location_id=$2 AND endpoint=$3",[parsed.data.deliveryId,parsed.data.locationId,parsed.data.endpoint]);
  if(existing.rows[0])return res.json({parcel:existing.rows[0]});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const lockedLocation=(await client.query("SELECT capacity FROM drop_off_locations WHERE id=$1 AND status='ACTIVE' AND verification_status='VERIFIED' FOR UPDATE",[location.id])).rows[0];
    if(!lockedLocation){await client.query("ROLLBACK");return res.status(409).json({error:"Drop-off location is no longer active"});}
    const capacity=await client.query("SELECT count(*)::int AS count FROM drop_off_parcels WHERE location_id=$1 AND status IN ('AT_LOCATION','READY_FOR_COURIER')",[location.id]);
    if(Number(capacity.rows[0].count)>=Number(lockedLocation.capacity)){await client.query("ROLLBACK");return res.status(409).json({error:"Drop-off location is at capacity"});}
    const parcel=await client.query("INSERT INTO drop_off_parcels(delivery_id,location_id,endpoint,intake_code) VALUES($1,$2,$3,encode(gen_random_bytes(5),'hex')) RETURNING *",[parsed.data.deliveryId,location.id,parsed.data.endpoint]);
    await client.query("INSERT INTO drop_off_events(parcel_id,actor_user_id,event_type,metadata) VALUES($1,$2,'PARCEL_EXPECTED',$3::jsonb)",[parcel.rows[0].id,userId,JSON.stringify({endpoint:parsed.data.endpoint})]);
    await client.query("COMMIT");
    res.status(201).json({parcel:parcel.rows[0]});
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release();}
});

router.post("/drop-off/parcels/:id/intake", requireAuth("CUSTOMER","AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parsed=z.object({intakeCode:z.string().min(6).max(20),storageReference:z.string().max(120).optional(),parcelPhoto:z.string().optional()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const parcelId=String(req.params.id);
  const parcel=(await pool.query("SELECT p.*,dl.capacity,dl.commission_minor FROM drop_off_parcels p JOIN drop_off_locations dl ON dl.id=p.location_id WHERE p.id=$1",[parcelId])).rows[0];
  if(!parcel)return res.status(404).json({error:"Parcel not found"});
  if((req as any).user?.role!=="ADMIN"&&!await managesDropOff(identity(req),parcel.location_id))return res.status(403).json({error:"Only the approved drop-off operator can intake parcels"});
  if(parcel.intake_code!==parsed.data.intakeCode)return res.status(403).json({error:"Invalid parcel intake code"});
  if(parcel.status==="READY_FOR_COURIER")return res.json({parcel});
  if(parcel.status!=="EXPECTED")return res.status(409).json({error:"Parcel is not awaiting intake"});
  const count=(await pool.query("SELECT count(*)::int AS count FROM drop_off_parcels WHERE location_id=$1 AND status IN ('AT_LOCATION','READY_FOR_COURIER')",[parcel.location_id])).rows[0].count;
  if(Number(count)>=parcel.capacity)return res.status(409).json({error:"Location capacity exceeded"});
  let parcelPhotoKey:string|null=null;
  if(parsed.data.parcelPhoto){
    const m=parsed.data.parcelPhoto.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/i);
    if(!m)return res.status(400).json({error:"parcelPhoto must be a JPEG or PNG data URL"});
    const bytes=Buffer.from(m[2],"base64");
    if(!bytes.length||bytes.length>8*1024*1024)return res.status(413).json({error:"Parcel photo must be between 1 byte and 8MB"});
    const extension=m[1].toLowerCase()==="png"?"png":"jpg";
    parcelPhotoKey="drop-off/"+parcel.location_id+"/parcels/"+parcelId+"/intake-"+crypto.randomUUID()+"."+extension;
    await putPrivateObject(parcelPhotoKey,bytes,extension==="png"?"image/png":"image/jpeg");
  }
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const updated=await client.query("UPDATE drop_off_parcels SET status='READY_FOR_COURIER',storage_reference=COALESCE($2,storage_reference),received_by_user_id=$3,received_at=now(),parcel_photo_key=COALESCE($4,parcel_photo_key),updated_at=now() WHERE id=$1 AND status='EXPECTED' RETURNING *",[parcelId,parsed.data.storageReference??null,identity(req),parcelPhotoKey]);
    if(!updated.rows[0]){await client.query("ROLLBACK");return res.status(409).json({error:"Parcel intake changed concurrently"});}
    await client.query("INSERT INTO drop_off_events(parcel_id,actor_user_id,event_type,metadata) VALUES($1,$2,'PARCEL_INTAKE','{}'::jsonb)",[parcelId,identity(req)]);
    await client.query("INSERT INTO drop_off_commission_ledger(location_id,parcel_id,amount_minor,status) VALUES($1,$2,$3,'EARNED') ON CONFLICT(parcel_id) DO NOTHING",[parcel.location_id,parcelId,parcel.commission_minor]);
    await client.query("COMMIT");res.status(201).json({parcel:updated.rows[0]});
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release();}
});

router.get("/drop-off/parcels/:id", requireAuth("CUSTOMER","AGENT","DRIVER","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parcelId=String(req.params.id);
  const row=(await pool.query(
    `SELECT p.*, d.sender_id, d.driver_id, d.tracking_code, d.status AS delivery_status,
            dl.name AS location_name, dl.address AS location_address, ba.display_name AS business_name
       FROM drop_off_parcels p
       JOIN deliveries d ON d.id=p.delivery_id
       JOIN drop_off_locations dl ON dl.id=p.location_id
       JOIN business_accounts ba ON ba.id=dl.business_id
      WHERE p.id=$1`,[parcelId])).rows[0];
  if(!row)return res.status(404).json({error:"Drop-off parcel not found"});
  const user=(req as any).user;
  let authorized=user?.role==="ADMIN";
  if(user?.role==="CUSTOMER")authorized=row.sender_id===identity(req);
  if(user?.role==="DRIVER")authorized=row.driver_id && (await driverForUser(identity(req)))?.id===row.driver_id;
  if(user?.role==="AGENT")authorized=await managesDropOff(identity(req),row.location_id);
  if(!authorized)return res.status(403).json({error:"Not authorized"});
  const events=await pool.query("SELECT id,event_type,actor_user_id,metadata,created_at FROM drop_off_events WHERE parcel_id=$1 ORDER BY created_at ASC",[parcelId]);
  return res.json({parcel:row,events:events.rows});
});

router.get("/drop-off/parcels/:id/photo", requireAuth("CUSTOMER","AGENT","DRIVER","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parcelId=String(req.params.id);
  const row=(await pool.query("SELECT p.parcel_photo_key,p.location_id,d.sender_id,d.driver_id FROM drop_off_parcels p JOIN deliveries d ON d.id=p.delivery_id WHERE p.id=$1",[parcelId])).rows[0];
  if(!row?.parcel_photo_key)return res.status(404).json({error:"Parcel photo not found"});
  const user=(req as any).user;
  let authorized=user?.role==="ADMIN";
  if(user?.role==="CUSTOMER")authorized=row.sender_id===identity(req);
  if(user?.role==="DRIVER")authorized=row.driver_id && (await driverForUser(identity(req)))?.id===row.driver_id;
  if(user?.role==="AGENT")authorized=await managesDropOff(identity(req),row.location_id);
  if(!authorized)return res.status(403).json({error:"Not authorized"});
  try{
    const object=await getPrivateObject(row.parcel_photo_key);
    res.setHeader("Content-Type",object.contentType??"image/jpeg");
    res.setHeader("Cache-Control","private, no-store");
    return res.send(object.body);
  }catch{return res.status(404).json({error:"Parcel photo is unavailable"});}
});

router.post("/drop-off/parcels/:id/collect", requireAuth("DRIVER"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const driver=await driverForUser(identity(req));
  if(!driver||driver.status!=="APPROVED")return res.status(403).json({error:"Approved driver status is required"});
  const parcel=(await pool.query("SELECT p.*,d.driver_id FROM drop_off_parcels p JOIN deliveries d ON d.id=p.delivery_id WHERE p.id=$1",[String(req.params.id)])).rows[0];
  if(!parcel)return res.status(404).json({error:"Parcel not found"});
  if(parcel.driver_id!==driver.id)return res.status(403).json({error:"This parcel is not assigned to this driver"});
  if(parcel.status!=="READY_FOR_COURIER")return res.status(409).json({error:"Parcel is not ready for courier collection"});
  const updated=await pool.query("UPDATE drop_off_parcels SET status='COURIER_COLLECTED',courier_driver_id=$2,courier_collected_at=now(),updated_at=now() WHERE id=$1 AND status='READY_FOR_COURIER' RETURNING *",[parcel.id,driver.id]);
  if(!updated.rows[0])return res.status(409).json({error:"Parcel collection changed concurrently"});
  await pool.query("INSERT INTO drop_off_events(parcel_id,actor_user_id,event_type,metadata) VALUES($1,$2,'COURIER_COLLECTED',$3::jsonb)",[parcel.id,identity(req),JSON.stringify({driverId:driver.id})]);
  res.json({parcel:updated.rows[0]});
});

router.get("/drop-off/locations/:id/commission", requireAuth("AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const locationId=String(req.params.id);
  if((req as any).user?.role!=="ADMIN"&&!await managesDropOff(identity(req),locationId))return res.status(403).json({error:"Not authorized"});
  const result=await pool.query("SELECT status,currency,count(*)::int AS parcels,sum(amount_minor)::bigint AS amount_minor FROM drop_off_commission_ledger WHERE location_id=$1 GROUP BY status,currency ORDER BY status",[locationId]);
  res.json({commission:result.rows});
});


export default router;
