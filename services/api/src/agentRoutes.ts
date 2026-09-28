import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { getPrivateObject, putPrivateObject } from "./storage.js";

const router = Router();

function orderId(req: any): string {
  return String(req.params.id ?? "").trim();
}

async function getAgent(userId: string) {
  if (!pool) return null;
  const result = await pool.query(
    "SELECT ap.*, u.full_name, u.phone FROM agent_profiles ap JOIN users u ON u.id=ap.user_id WHERE ap.user_id=$1",
    [userId]
  );
  return result.rows[0] ?? null;
}

async function getOrder(id: string) {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM buy_orders WHERE id=$1", [id]);
  return result.rows[0] ?? null;
}

router.get("/agents", requireAuth("ADMIN"), async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT ap.*, u.full_name, u.phone, u.email
       FROM agent_profiles ap
       JOIN users u ON u.id=ap.user_id
      ORDER BY ap.created_at DESC
      LIMIT 200`
  );
  res.json({ agents: result.rows });
});

router.post("/agents/:id/status", requireAuth("ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = z.object({ status: z.enum(["APPROVED", "SUSPENDED", "PENDING"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await pool.query(
    "UPDATE agent_profiles SET status=$2, updated_at=now() WHERE id=$1 RETURNING *",
    [orderId(req), parsed.data.status]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Agent profile not found" });
  res.json({ agent: result.rows[0] });
});

router.get("/agent/buy-orders", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent) return res.status(404).json({ error: "Agent profile not found" });
  const result = await pool.query(
    `SELECT * FROM buy_orders
      WHERE (agent_id=$1 AND status IN ('AGENT_ASSIGNED','PURCHASING','PURCHASED','IN_TRANSIT','DELIVERED','DISPUTED'))
         OR (agent_id IS NULL AND status IN ('REQUESTED','APPROVED'))
      ORDER BY created_at ASC
      LIMIT 100`,
    [agent.id]
  );
  res.json({ buyOrders: result.rows });
});

router.post("/buy-orders/:id/claim", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent || agent.status !== "APPROVED") return res.status(403).json({ error: "Approved agent status is required" });
  const id = orderId(req);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM buy_orders WHERE id=$1 FOR UPDATE", [id]);
    const order = locked.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Buy & Deliver order not found" });
    }
    if (order.agent_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This order is already assigned" });
    }
    if (!["REQUESTED", "APPROVED"].includes(order.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This order is not available for assignment" });
    }
    const updated = await client.query(
      `UPDATE buy_orders
          SET agent_id=$2, status='AGENT_ASSIGNED', assigned_at=now(), updated_at=now()
        WHERE id=$1 AND agent_id IS NULL
        RETURNING *`,
      [id, agent.id]
    );
    if (!updated.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Order assignment lost a concurrency race" });
    }
    await client.query(
      "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'AGENT_ASSIGNED',$3::jsonb)",
      [id, identity(req), JSON.stringify({ agentId: agent.id })]
    );
    await client.query(
      "INSERT INTO agent_action_events (agent_id, buy_order_id, action, metadata) VALUES ($1,$2,'CLAIM',$3::jsonb)",
      [agent.id, id, JSON.stringify({ status: "AGENT_ASSIGNED" })]
    );
    await client.query("COMMIT");
    return res.status(200).json({ buyOrder: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.post("/buy-orders/:id/accept", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent || agent.status !== "APPROVED") return res.status(403).json({ error: "Approved agent status is required" });
  const id = orderId(req);
  const result = await pool.query(
    `UPDATE buy_orders
        SET status='PURCHASING', updated_at=now()
      WHERE id=$1 AND agent_id=$2 AND status='AGENT_ASSIGNED'
      RETURNING *`,
    [id, agent.id]
  );
  if (!result.rows[0]) return res.status(409).json({ error: "Order is not assigned to this agent or cannot be accepted" });
  await pool.query(
    "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'PURCHASING_STARTED','{}'::jsonb)",
    [id, identity(req)]
  );
  await pool.query(
    "INSERT INTO agent_action_events (agent_id, buy_order_id, action, metadata) VALUES ($1,$2,'ACCEPT','{}'::jsonb)",
    [agent.id, id]
  );
  res.json({ buyOrder: result.rows[0] });
});

router.post("/buy-orders/:id/purchase", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent || agent.status !== "APPROVED") return res.status(403).json({ error: "Approved agent status is required" });
  const parsed = z.object({
    actualPurchaseMinor: z.number().int().positive(),
    receiptFile: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = orderId(req);
  const order = await getOrder(id);
  if (!order || order.agent_id !== agent.id) return res.status(404).json({ error: "Buy & Deliver order not found" });
  if (order.status !== "PURCHASING") return res.status(409).json({ error: "Order must be in purchasing state" });
  if (parsed.data.actualPurchaseMinor > Number(order.purchase_budget_minor)) {
    return res.status(409).json({ error: "Actual purchase amount exceeds the authorized budget", code: "PURCHASE_BUDGET_EXCEEDED" });
  }
  if (parsed.data.actualPurchaseMinor > Number(agent.max_purchase_minor)) {
    return res.status(409).json({ error: "Purchase exceeds this agent's authorized purchase limit", code: "AGENT_PURCHASE_LIMIT_EXCEEDED" });
  }

  let receiptKey: string | null = null;
  if (parsed.data.receiptFile) {
    const match = parsed.data.receiptFile.match(/^data:(image\/(?:jpeg|jpg|png)|application\/pdf);base64,(.+)$/i);
    if (!match) return res.status(400).json({ error: "Receipt must be a JPEG, PNG or PDF data URL" });
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: "Receipt must be between 1 byte and 5MB" });
    const extension = match[1].includes("pdf") ? "pdf" : match[1].includes("png") ? "png" : "jpg";
    receiptKey = `buy-orders/${id}/receipts/${randomUUID()}.${extension}`;
    await putPrivateObject(receiptKey, buffer, match[1]);
  }

  const result = await pool.query(
    `UPDATE buy_orders
        SET actual_purchase_minor=$2, purchase_receipt_key=COALESCE($3,purchase_receipt_key),
            purchased_at=now(), status='PURCHASED', updated_at=now()
      WHERE id=$1 AND agent_id=$4 AND status='PURCHASING'
      RETURNING *`,
    [id, parsed.data.actualPurchaseMinor, receiptKey, agent.id]
  );
  if (!result.rows[0]) return res.status(409).json({ error: "Order changed before purchase could be recorded" });

  await pool.query(
    "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'PURCHASE_RECORDED',$3::jsonb)",
    [id, identity(req), JSON.stringify({ actualPurchaseMinor: parsed.data.actualPurchaseMinor, receiptAttached: Boolean(receiptKey) })]
  );
  await pool.query(
    "INSERT INTO agent_action_events (agent_id, buy_order_id, action, metadata) VALUES ($1,$2,'PURCHASE_RECORDED',$3::jsonb)",
    [agent.id, id, JSON.stringify({ actualPurchaseMinor: parsed.data.actualPurchaseMinor })]
  );
  res.status(201).json({ buyOrder: result.rows[0] });
});

router.get("/buy-orders/:id/receipt", requireAuth("CUSTOMER", "AGENT", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const order = await getOrder(orderId(req));
  if (!order?.purchase_receipt_key) return res.status(404).json({ error: "Purchase receipt not found" });
  const userId = identity(req);
  const role = (req as any).user?.role;
  if (role === "CUSTOMER" && order.customer_user_id !== userId) return res.status(403).json({ error: "Not authorized" });
  if (role === "AGENT") {
    const agent = await getAgent(userId);
    if (!agent || order.agent_id !== agent.id) return res.status(403).json({ error: "Not authorized" });
  }
  try {
    const object = await getPrivateObject(order.purchase_receipt_key);
    res.setHeader("Content-Type", object.contentType ?? "application/octet-stream");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(object.body);
  } catch {
    return res.status(404).json({ error: "Purchase receipt is unavailable" });
  }
});

router.post("/buy-orders/:id/cancel", requireAuth("CUSTOMER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `UPDATE buy_orders
        SET status='CANCELLED', updated_at=now()
      WHERE id=$1 AND customer_user_id=$2
        AND status IN ('REQUESTED','APPROVED','AGENT_ASSIGNED')
      RETURNING *`,
    [orderId(req), identity(req)]
  );
  if (!result.rows[0]) return res.status(409).json({ error: "Order cannot be cancelled at its current stage" });
  await pool.query(
    "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'CANCELLED','{}'::jsonb)",
    [orderId(req), identity(req)]
  );
  res.json({ buyOrder: result.rows[0] });
});

router.get("/buy-orders/:id", requireAuth("CUSTOMER", "AGENT", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const order = await getOrder(orderId(req));
  if (!order) return res.status(404).json({ error: "Buy & Deliver order not found" });
  const userId = identity(req);
  const role = (req as any).user?.role;
  if (role === "CUSTOMER" && order.customer_user_id !== userId) return res.status(403).json({ error: "Not authorized" });
  if (role === "AGENT") {
    const agent = await getAgent(userId);
    if (!agent || order.agent_id !== agent.id) return res.status(403).json({ error: "Not authorized" });
  }
  res.json({ buyOrder: order });
});

export default router;
