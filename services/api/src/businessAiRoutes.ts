import { Router } from "express";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";

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
  if (plan !== "PREMIUM") {
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
  const userId = identity(req);
  const action = String(req.body?.action ?? "").trim().toUpperCase();
  const plan = await premiumAction(req, res, action || "UNKNOWN");
  if (!plan) return;

  if (action === "CREATE_BUY_ORDER") {
    if (req.user?.role !== "CUSTOMER") {
      await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "CUSTOMER_ONLY" });
      return res.status(403).json({ error: "Buy & Deliver orders must be created by a customer or authorized business member" });
    }
    const parsed = buyOrderSchema.safeParse(req.body?.input);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    let businessId = parsed.data.businessId;
    if (businessId) {
      const spend = await authorizeBusinessSpend(userId, businessId, parsed.data.purchaseBudgetMinor);
      if (!spend.ok) {
        await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: spend.reason, metadata: { businessId } });
        return res.status(403).json({ error: "Business spending policy blocked this action", code: spend.reason });
      }
    }
    const result = await pool!.query(
      `INSERT INTO buy_orders
        (customer_user_id, business_id, item_description, merchant_name, merchant_address, purchase_budget_minor, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, status, item_description, merchant_name, merchant_address, purchase_budget_minor, delivery_fee_minor, total_authorized_minor, currency, notes, created_at, updated_at`,
      [userId, businessId ?? null, parsed.data.itemDescription, parsed.data.merchantName ?? null, parsed.data.merchantAddress ?? null, parsed.data.purchaseBudgetMinor, parsed.data.notes ?? null]
    );
    await pool!.query(
      "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'CREATED_BY_AI',$3::jsonb)",
      [result.rows[0].id, userId, JSON.stringify({ plan })]
    );
    await audit({ userId, plan, capability: "ACTION", action, allowed: true, metadata: { buyOrderId: result.rows[0].id } });
    return res.status(201).json({ buyOrder: result.rows[0] });
  }

  if (action === "CREATE_BUSINESS") {
    if (req.user?.role !== "CUSTOMER" && req.user?.role !== "ADMIN") {
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
        [userId, parsed.data.legalName, parsed.data.displayName, parsed.data.registrationNumber ?? null, parsed.data.monthlySpendLimitMinor, parsed.data.perOrderLimitMinor, parsed.data.requiresApproval, req.user?.role === "ADMIN" ? "ACTIVE" : "PENDING"]
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
    if (!member || !["OWNER", "ADMIN", "DISPATCHER"].includes(member.memberRole)) {
      await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "BUSINESS_ROLE_NOT_AUTHORIZED", metadata: { businessId: parsed.data.businessId } });
      return res.status(403).json({ error: "Business dispatch authorization required" });
    }

    const buyOrders = parsed.data.buyOrderIds.length
      ? await pool!.query("SELECT id, purchase_budget_minor, status FROM buy_orders WHERE id = ANY($1::uuid[]) AND business_id=$2", [parsed.data.buyOrderIds, parsed.data.businessId])
      : { rows: [] as any[] };
    const deliveries = parsed.data.deliveryIds.length
      ? await pool!.query("SELECT id, quote_total_minor, status FROM deliveries WHERE id = ANY($1::uuid[]) AND sender_id IN (SELECT user_id FROM business_members WHERE business_id=$2)", [parsed.data.deliveryIds, parsed.data.businessId])
      : { rows: [] as any[] };
    const estimatedTotalMinor = buyOrders.rows.reduce((s: number, r: any) => s + Number(r.purchase_budget_minor), 0)
      + deliveries.rows.reduce((s: number, r: any) => s + Number(r.quote_total_minor ?? 0), 0);

    if (member.business.per_order_limit_minor > 0 && estimatedTotalMinor > Number(member.business.per_order_limit_minor)) {
      await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "DISPATCH_LIMIT_EXCEEDED" });
      return res.status(403).json({ error: "Dispatch plan exceeds the business per-order approval limit" });
    }

    const approvalRequired = Boolean(member.business.requires_approval || member.memberRole === "DISPATCHER");
    const planResult = await pool!.query(
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
        JSON.stringify({ buyOrderIds: parsed.data.buyOrderIds, deliveryIds: parsed.data.deliveryIds })
      ]
    );
    await audit({ userId, plan, capability: "ACTION", action, allowed: true, metadata: { dispatchPlanId: planResult.rows[0].id } });
    return res.status(201).json({ dispatchPlan: planResult.rows[0] });
  }

  await audit({ userId, plan, capability: "ACTION", action, allowed: false, reason: "UNKNOWN_ACTION" });
  return res.status(400).json({ error: "Unsupported AI action", code: "UNKNOWN_AI_ACTION" });
});

router.get("/buy-orders", requireAuth("CUSTOMER", "AGENT", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const result = req.user?.role === "ADMIN"
    ? await pool!.query("SELECT * FROM buy_orders ORDER BY created_at DESC LIMIT 200")
    : req.user?.role === "AGENT"
      ? await pool!.query("SELECT bo.* FROM buy_orders bo JOIN agent_profiles ap ON ap.id=bo.agent_id WHERE ap.user_id=$1 ORDER BY bo.created_at DESC LIMIT 100", [userId])
      : await pool!.query("SELECT * FROM buy_orders WHERE customer_user_id=$1 ORDER BY created_at DESC LIMIT 100", [userId]);
  res.json({ buyOrders: result.rows });
});

router.post("/business/accounts", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await pool!.query(
    `INSERT INTO business_accounts
      (owner_user_id, legal_name, display_name, registration_number, monthly_spend_limit_minor, per_order_limit_minor, requires_approval, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [userId, parsed.data.legalName, parsed.data.displayName, parsed.data.registrationNumber ?? null, parsed.data.monthlySpendLimitMinor, parsed.data.perOrderLimitMinor, parsed.data.requiresApproval, req.user?.role === "ADMIN" ? "ACTIVE" : "PENDING"]
  );
  await pool!.query("INSERT INTO business_members (business_id, user_id, member_role) VALUES ($1,$2,'OWNER')", [result.rows[0].id, userId]);
  res.status(201).json({ business: result.rows[0] });
});

router.get("/business/accounts", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  const userId = identity(req);
  const result = req.user?.role === "ADMIN"
    ? await pool!.query("SELECT * FROM business_accounts ORDER BY created_at DESC LIMIT 200")
    : await pool!.query("SELECT ba.* FROM business_accounts ba JOIN business_members bm ON bm.business_id=ba.id WHERE bm.user_id=$1 AND bm.active=true ORDER BY ba.created_at DESC", [userId]);
  res.json({ businesses: result.rows });
});

export default router;
