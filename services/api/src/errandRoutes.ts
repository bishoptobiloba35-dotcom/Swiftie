import { Router } from "express";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { hashPin } from "./security.js";

const router = Router();

const errandItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().positive().max(1000).default(1),
  maxAuthorizedMinor: z.number().int().nonnegative().max(2_000_000_000).optional(),
  requestedPriceMinor: z.number().int().nonnegative().max(2_000_000_000).optional(),
  replacementPolicy: z.enum(["EXACT_ONLY", "BEST_MATCH", "APPROVED_ALTERNATIVES", "REFUND_IF_UNAVAILABLE"]).optional()
});

const errandSchema = z.object({
  errandType: z.enum(["GENERAL_ERRAND", "PURCHASE_AND_DELIVER", "SHOP_FOR_ME"]),
  description: z.string().trim().min(3).max(2000),
  items: z.array(errandItemSchema).min(1).max(50).default([]),
  spendingCeilingMinor: z.number().int().nonnegative().max(2_000_000_000).default(0),
  merchantName: z.string().trim().max(200).optional(),
  merchantAddress: z.string().trim().max(500).optional(),
  merchantLat: z.number().finite().min(-90).max(90).optional(),
  merchantLng: z.number().finite().min(-180).max(180).optional(),
  replacementPolicy: z.enum(["EXACT_ONLY", "BEST_MATCH", "APPROVED_ALTERNATIVES", "REFUND_IF_UNAVAILABLE"]).default("EXACT_ONLY"),
  maxPriceDeltaMinor: z.number().int().nonnegative().max(2_000_000_000).default(0),
  instructions: z.string().trim().max(2000).optional(),
  requestedCompletionAt: z.string().datetime().optional(),
  receiverName: z.string().trim().min(1).max(160),
  receiverPhone: z.string().trim().min(7).max(40),
  receiverPin: z.string().regex(/^\d{4,6}$/),
  destinationAddress: z.string().trim().min(3).max(500),
  destinationLat: z.number().finite().min(-90).max(90),
  destinationLng: z.number().finite().min(-180).max(180)
}).superRefine((value, ctx) => {
  if (value.errandType !== "GENERAL_ERRAND" && value.spendingCeilingMinor <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spendingCeilingMinor"], message: "A positive spending ceiling is required for shopping errands" });
  }
  for (const [index, item] of value.items.entries()) {
    const max = item.maxAuthorizedMinor ?? value.spendingCeilingMinor;
    if (max > value.spendingCeilingMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "maxAuthorizedMinor"],
        message: "Item authorization cannot exceed the errand spending ceiling"
      });
    }
  }
});

router.post("/errands", requireAuth("CUSTOMER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = errandSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const data = parsed.data;
  const requested = data.requestedCompletionAt ? new Date(data.requestedCompletionAt) : null;
  if (requested && requested.getTime() <= Date.now()) return res.status(400).json({ error: "requestedCompletionAt must be in the future" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO buy_orders
        (customer_user_id, errand_type, item_description, merchant_name, merchant_address,
         merchant_lat, merchant_lng, purchase_budget_minor, notes, replacement_policy,
         max_price_delta_minor, errand_instructions, requested_completion_at,
         receiver_name, receiver_phone, receiver_pin_hash, destination_address,
         destination_lat, destination_lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id, errand_type, status, item_description, merchant_name, merchant_address,
         purchase_budget_minor, currency, replacement_policy, max_price_delta_minor,
         errand_instructions, requested_completion_at, receiver_name, receiver_phone,
         destination_address, destination_lat, destination_lng, created_at, updated_at`,
      [identity(req), data.errandType, data.description, data.merchantName ?? null, data.merchantAddress ?? null,
       data.merchantLat ?? null, data.merchantLng ?? null, data.spendingCeilingMinor, null, data.replacementPolicy,
       data.maxPriceDeltaMinor, data.instructions ?? null, requested, data.receiverName, data.receiverPhone,
       hashPin(data.receiverPin), data.destinationAddress, data.destinationLat, data.destinationLng]
    );
    const errand = result.rows[0];

    for (const item of data.items) {
      await client.query(
        `INSERT INTO buy_order_items
          (buy_order_id, requested_description, quantity, max_authorized_minor, requested_price_minor, replacement_policy)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [errand.id, item.description, item.quantity, item.maxAuthorizedMinor ?? data.spendingCeilingMinor,
         item.requestedPriceMinor ?? null, item.replacementPolicy ?? data.replacementPolicy]
      );
    }

    await client.query(
      "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'ERRAND_CREATED',$3::jsonb)",
      [errand.id, identity(req), JSON.stringify({ errandType: data.errandType, replacementPolicy: data.replacementPolicy, itemCount: data.items.length })]
    );
    const createdItems = await client.query(
      "SELECT id,requested_description,quantity,max_authorized_minor,requested_price_minor,replacement_policy,status FROM buy_order_items WHERE buy_order_id=$1 ORDER BY created_at",
      [errand.id]
    );
    await client.query("COMMIT");
    return res.status(201).json({ errand, items: createdItems.rows });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.get("/errands/:id", requireAuth("CUSTOMER", "ADMIN", "AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id ?? "").trim();
  const order = (await pool.query(
    `SELECT bo.id, bo.customer_user_id, bo.errand_type, bo.status, bo.item_description,
            bo.merchant_name, bo.merchant_address, bo.merchant_lat, bo.merchant_lng,
            bo.purchase_budget_minor, bo.actual_purchase_minor, bo.currency,
            bo.replacement_policy, bo.max_price_delta_minor, bo.errand_instructions,
            bo.requested_completion_at, bo.receiver_name, bo.receiver_phone,
            bo.destination_address, bo.destination_lat, bo.destination_lng,
            bo.agent_id, bo.delivery_id, bo.replacement_review_required,
            bo.replacement_review_deadline, bo.created_at, bo.updated_at,
            ap.id AS agent_profile_id, u.full_name AS agent_name, u.phone AS agent_phone,
            d.id AS linked_delivery_id, d.tracking_code, d.status AS delivery_status,
            d.driver_id AS delivery_driver_id, d.pickup_photo_url, d.exception_status,
            d.next_delivery_at, d.receiver_confirmed_at
       FROM buy_orders bo
       LEFT JOIN agent_profiles ap ON ap.id=bo.agent_id
       LEFT JOIN users u ON u.id=ap.user_id
       LEFT JOIN deliveries d ON d.id=bo.delivery_id
      WHERE bo.id=$1`,
    [id]
  )).rows[0];
  if (!order) return res.status(404).json({ error: "Errand not found" });
  const role = (req as any).user?.role;
  if (role === "CUSTOMER" && order.customer_user_id !== identity(req)) return res.status(403).json({ error: "Not authorized for this errand" });
  if (role === "AGENT" && (!order.agent_profile_id || order.agent_profile_id !== (await pool.query("SELECT id FROM agent_profiles WHERE user_id=$1",[identity(req)])).rows[0]?.id)) {
    return res.status(403).json({ error: "Not authorized for this errand" });
  }
  const [items, events, payment] = await Promise.all([
    pool.query(`SELECT i.id,i.requested_description,i.quantity,i.max_authorized_minor,i.requested_price_minor,i.replacement_policy,i.status,
       COALESCE((SELECT json_agg(json_build_object(
         'id',r.id,'description',r.proposed_description,'quantity',r.proposed_quantity,'priceMinor',r.proposed_price_minor,
         'currency',r.currency,'shopperNote',r.shopper_note,'status',r.status,'createdAt',r.created_at
       ) ORDER BY r.created_at DESC) FROM buy_order_replacement_options r WHERE r.item_id=i.id),'[]'::json) replacements
       FROM buy_order_items i WHERE i.buy_order_id=$1 ORDER BY i.created_at ASC`, [id]),
    pool.query(`SELECT id,event_type AS "eventType",metadata,created_at AS "createdAt"
       FROM buy_order_events WHERE buy_order_id=$1 ORDER BY created_at ASC LIMIT 200`, [id]),
    pool.query(`SELECT id,status,payment_status,amount_minor,currency,refund_status,refund_amount_minor
       FROM buy_order_payments WHERE buy_order_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])
  ]);
  res.json({
    errand: {
      ...order,
      agent: order.agent_profile_id ? { id: order.agent_profile_id, name: order.agent_name, phone: order.agent_phone } : null,
      delivery: order.linked_delivery_id ? {
        id: order.linked_delivery_id, trackingCode: order.tracking_code, status: order.delivery_status,
        driverId: order.delivery_driver_id, pickupPhotoUrl: order.pickup_photo_url,
        exceptionStatus: order.exception_status, nextDeliveryAt: order.next_delivery_at,
        receiverConfirmedAt: order.receiver_confirmed_at
      } : null
    },
    items: items.rows,
    events: events.rows,
    payment: payment.rows[0] ?? null
  });
});

router.get("/errands/:id/replacements", requireAuth("CUSTOMER", "ADMIN", "AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id ?? "").trim();
  const order = (await pool.query("SELECT id, customer_user_id, agent_id, replacement_review_required, replacement_review_deadline FROM buy_orders WHERE id=$1",[id])).rows[0];
  if (!order) return res.status(404).json({ error: "Errand not found" });
  const role = (req as any).user?.role;
  if (role === "CUSTOMER" && order.customer_user_id !== identity(req)) return res.status(403).json({ error: "Not authorized for this errand" });
  if (role === "AGENT") {
    const agent = (await pool.query("SELECT id FROM agent_profiles WHERE user_id=$1",[identity(req)])).rows[0];
    if (!agent || agent.id !== order.agent_id) return res.status(403).json({ error: "Not authorized for this errand" });
  }
  const items = await pool.query(
    `SELECT i.id, i.requested_description, i.quantity, i.max_authorized_minor,
            i.replacement_policy, i.status,
            COALESCE(json_agg(json_build_object(
              'id',r.id,'description',r.proposed_description,'quantity',r.proposed_quantity,
              'priceMinor',r.proposed_price_minor,'currency',r.currency,
              'shopperNote',r.shopper_note,'status',r.status,'createdAt',r.created_at
            ) ORDER BY r.created_at DESC) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS replacements
       FROM buy_order_items i
       LEFT JOIN buy_order_replacement_options r ON r.item_id=i.id
      WHERE i.buy_order_id=$1
      GROUP BY i.id
      ORDER BY i.created_at ASC`,
    [id]
  );
  res.json({ replacementReviewRequired: order.replacement_review_required, reviewDeadline: order.replacement_review_deadline, items: items.rows });
});

router.get("/errands", requireAuth("CUSTOMER", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT id, errand_type, status, item_description, merchant_name, merchant_address,
       purchase_budget_minor, actual_purchase_minor, currency, replacement_policy,
       max_price_delta_minor, errand_instructions, requested_completion_at,
       receiver_name, receiver_phone, destination_address, destination_lat,
       destination_lng, agent_id, delivery_id, created_at, updated_at
       FROM buy_orders
       WHERE customer_user_id=$1 OR $2='ADMIN'
       ORDER BY created_at DESC LIMIT 100`,
    [identity(req), (req as any).user?.role]
  );
  res.json({ errands: result.rows.map((row) => ({
    id: row.id,
    errandType: row.errand_type,
    status: row.status,
    itemDescription: row.item_description,
    merchantName: row.merchant_name,
    purchaseBudgetMinor: Number(row.purchase_budget_minor ?? 0),
    actualPurchaseMinor: row.actual_purchase_minor == null ? null : Number(row.actual_purchase_minor),
    currency: row.currency,
    replacementPolicy: row.replacement_policy,
    maxPriceDeltaMinor: Number(row.max_price_delta_minor ?? 0),
    errandInstructions: row.errand_instructions,
    requestedCompletionAt: row.requested_completion_at,
    receiverName: row.receiver_name,
    receiverPhone: row.receiver_phone,
    destinationAddress: row.destination_address,
    destinationLat: row.destination_lat,
    destinationLng: row.destination_lng,
    agentId: row.agent_id,
    deliveryId: row.delivery_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })) });
});

export default router;
