import { Router } from "express";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { canDispatchBusiness } from "./aiPolicy.js";

const router = Router();

const recurringBuyOrderTemplateSchema = z.object({
  itemDescription: z.string().trim().min(1).max(500),
  merchantName: z.string().trim().max(200).optional(),
  merchantAddress: z.string().trim().max(500).optional(),
  purchaseBudgetMinor: z.number().int().positive().max(2_000_000_000),
  notes: z.string().trim().max(2000).optional()
});

const ruleSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  cadenceMinutes: z.number().int().min(15).max(43200),
  nextRunAt: z.string().datetime(),
  approvalRequired: z.boolean().default(true),
  template: z.object({
    deliveryIds: z.array(z.string().uuid()).max(100).default([]),
    buyOrderIds: z.array(z.string().uuid()).max(100).default([]),
    buyOrderTemplates: z.array(recurringBuyOrderTemplateSchema).max(25).default([])
  }).default({ deliveryIds: [], buyOrderIds: [], buyOrderTemplates: [] })
});

async function member(userId: string, businessId: string) {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT bm.member_role, ba.status
       FROM business_members bm
       JOIN business_accounts ba ON ba.id=bm.business_id
      WHERE bm.business_id=$1 AND bm.user_id=$2 AND bm.active=true`,
    [businessId, userId]
  );
  return result.rows[0] ?? null;
}

router.get("/business/recurring-dispatches", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const businessId = String(req.query.businessId ?? "");
  const m = await member(identity(req), businessId);
  if (!m && (req as any).user?.role !== "ADMIN") return res.status(403).json({ error: "Business membership required" });
  const result = await pool.query(
    "SELECT * FROM business_recurring_dispatches WHERE business_id=$1 ORDER BY created_at DESC",
    [businessId]
  );
  res.json({ recurringDispatches: result.rows });
});

router.post("/business/recurring-dispatches", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = identity(req);
  const m = await member(userId, parsed.data.businessId);
  if (!m || m.status !== "ACTIVE" || !canDispatchBusiness(m.member_role as any)) {
    return res.status(403).json({ error: "Business dispatch authorization required" });
  }
  if (!parsed.data.approvalRequired && !["OWNER", "ADMIN"].includes(m.member_role)) {
    return res.status(403).json({
      error: "Only a business owner or admin can create approval-free autonomous recurring dispatches",
      code: "AUTONOMOUS_DISPATCH_AUTHORITY_REQUIRED"
    });
  }
  const result = await pool.query(
    `INSERT INTO business_recurring_dispatches
      (business_id, created_by_user_id, name, cadence_minutes, next_run_at, approval_required, template)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING *`,
    [parsed.data.businessId, userId, parsed.data.name, parsed.data.cadenceMinutes, parsed.data.nextRunAt, parsed.data.approvalRequired, JSON.stringify(parsed.data.template)]
  );
  res.status(201).json({ recurringDispatch: result.rows[0] });
});

router.post("/business/recurring-dispatches/:id/cancel", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id ?? "");
  const current = (await pool.query("SELECT business_id FROM business_recurring_dispatches WHERE id=$1", [id])).rows[0];
  if (!current) return res.status(404).json({ error: "Recurring dispatch not found" });
  const m = await member(identity(req), current.business_id);
  if (!m || !canDispatchBusiness(m.member_role as any)) return res.status(403).json({ error: "Business dispatch authorization required" });
  const result = await pool.query(
    "UPDATE business_recurring_dispatches SET active=false, updated_at=now() WHERE id=$1 RETURNING *",
    [id]
  );
  res.json({ recurringDispatch: result.rows[0] });
});

export default router;
