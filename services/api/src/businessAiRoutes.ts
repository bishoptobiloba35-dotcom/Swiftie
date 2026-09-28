import { Router } from "express";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { driverForUser } from "./database/deliveryRepository.js";
import { canCreatePersonalBuyOrder, canDispatchBusiness, canManageBusiness, canUseAiAction } from "./aiPolicy.js";

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
    if (!parsed.data.businessId && !canCreatePersonalBuyOrder((req as any).user?.role)) {
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
  commissionMinor: z.number().int().nonnegative().max(100000000).default(50000)
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
    const location=await client.query("INSERT INTO drop_off_locations(business_id,name,address,latitude,longitude,phone,operating_hours,capacity,commission_minor) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *",[businessId,d.name,d.address,d.latitude,d.longitude,d.phone,JSON.stringify(d.operatingHours),d.capacity,d.commissionMinor]);
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
  const locations=result.rows.map(row=>{const p1=latitude*Math.PI/180,p2=Number(row.latitude)*Math.PI/180,dp=(Number(row.latitude)-latitude)*Math.PI/180,dl=(Number(row.longitude)-longitude)*Math.PI/180,h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return {...row,distanceKm:6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)}}).filter(row=>row.distanceKm<=radiusKm).sort((a,b)=>a.distanceKm-b.distanceKm);
  res.json({locations});
});
router.get("/drop-off/locations/mine", requireAuth("CUSTOMER","AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const result=await pool.query("SELECT dl.*,ba.display_name AS business_name FROM drop_off_locations dl JOIN business_accounts ba ON ba.id=dl.business_id WHERE ba.owner_user_id=$1 OR EXISTS (SELECT 1 FROM business_members bm WHERE bm.business_id=ba.id AND bm.user_id=$1 AND bm.active=true AND bm.member_role IN ('OWNER','ADMIN')) ORDER BY dl.created_at DESC",[identity(req)]);
  res.json({locations:result.rows});
});
router.get("/admin/drop-off/applications", requireAuth("ADMIN"), async(_req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const result=await pool.query("SELECT dl.*,ba.display_name AS business_name,(SELECT count(*) FROM drop_off_location_documents d WHERE d.location_id=dl.id) AS document_count FROM drop_off_locations dl JOIN business_accounts ba ON ba.id=dl.business_id ORDER BY dl.created_at DESC LIMIT 500");
  res.json({applications:result.rows});
});
router.post("/admin/drop-off/locations/:id/review", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parsed=z.object({status:z.enum(["ACTIVE","SUSPENDED","REJECTED","PENDING"]),note:z.string().max(1000).optional()}).safeParse(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const locationId=String(req.params.id),current=await pool.query("SELECT * FROM drop_off_locations WHERE id=$1",[locationId]);if(!current.rows[0])return res.status(404).json({error:"Location not found"});
  const verified=parsed.data.status==="ACTIVE",client=await pool.connect();
  try{await client.query("BEGIN");const updated=await client.query("UPDATE drop_off_locations SET status=$2,verification_status=$3,verified_by_user_id=CASE WHEN $3='VERIFIED' THEN $4 ELSE verified_by_user_id END,verified_at=CASE WHEN $3='VERIFIED' THEN now() ELSE verified_at END,updated_at=now() WHERE id=$1 RETURNING *",[locationId,parsed.data.status,verified?"VERIFIED":"REJECTED",identity(req)]);await client.query("UPDATE drop_off_location_documents SET status=$2,updated_at=now() WHERE location_id=$1 AND status='PENDING'",[locationId,verified?"APPROVED":"REJECTED"]);await client.query("INSERT INTO drop_off_application_audit(location_id,actor_user_id,old_status,new_status,note) VALUES($1,$2,$3,$4,$5)",[locationId,identity(req),current.rows[0].status,parsed.data.status,parsed.data.note??null]);await client.query("COMMIT");res.json({location:updated.rows[0]});}catch(e){await client.query("ROLLBACK");throw e}finally{client.release();}
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
  const capacity=await pool.query("SELECT count(*)::int AS count FROM drop_off_parcels WHERE location_id=$1 AND status IN ('AT_LOCATION','READY_FOR_COURIER')",[location.id]);
  if(Number(capacity.rows[0].count)>=location.capacity)return res.status(409).json({error:"Drop-off location is at capacity"});
  const parcel=await pool.query("INSERT INTO drop_off_parcels(delivery_id,location_id,endpoint,intake_code) VALUES($1,$2,$3,encode(gen_random_bytes(5),'hex')) RETURNING *",[parsed.data.deliveryId,location.id,parsed.data.endpoint]);
  await pool.query("INSERT INTO drop_off_events(parcel_id,actor_user_id,event_type,metadata) VALUES($1,$2,'PARCEL_EXPECTED',$3::jsonb)",[parcel.rows[0].id,userId,JSON.stringify({endpoint:parsed.data.endpoint})]);
  res.status(201).json({parcel:parcel.rows[0]});
});

router.post("/drop-off/parcels/:id/intake", requireAuth("AGENT","ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const parsed=z.object({intakeCode:z.string().min(6).max(20),storageReference:z.string().max(120).optional()}).safeParse(req.body);
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
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const updated=await client.query("UPDATE drop_off_parcels SET status='READY_FOR_COURIER',storage_reference=COALESCE($2,storage_reference),received_by_user_id=$3,received_at=now(),updated_at=now() WHERE id=$1 AND status='EXPECTED' RETURNING *",[parcelId,parsed.data.storageReference??null,identity(req)]);
    if(!updated.rows[0]){await client.query("ROLLBACK");return res.status(409).json({error:"Parcel intake changed concurrently"});}
    await client.query("INSERT INTO drop_off_events(parcel_id,actor_user_id,event_type,metadata) VALUES($1,$2,'PARCEL_INTAKE','{}'::jsonb)",[parcelId,identity(req)]);
    await client.query("INSERT INTO drop_off_commission_ledger(location_id,parcel_id,amount_minor,status) VALUES($1,$2,$3,'EARNED') ON CONFLICT(parcel_id) DO NOTHING",[parcel.location_id,parcelId,parcel.commission_minor]);
    await client.query("COMMIT");res.status(201).json({parcel:updated.rows[0]});
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release();}
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
