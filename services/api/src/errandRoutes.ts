import { Router } from "express";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { hashPin } from "./security.js";
import { assertFeatureEnabled } from "./featureFlags.js";

const router = Router();

router.use((req, res, next) => {
  if (!req.originalUrl.startsWith("/api/errands")) return next();
  try { assertFeatureEnabled("ERRANDS"); next(); }
  catch { res.status(403).json({ error: "Errands are disabled", code: "FEATURE_DISABLED" }); }
});

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
  destinationLng: z.number().finite().min(-180).max(180),
  stops: z.array(z.object({ stopType: z.enum(["TASK","PICKUP","PURCHASE","INSPECT","DROP_OFF"]).default("TASK"), label: z.string().trim().min(1).max(160), address: z.string().trim().min(3).max(500), latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), instructions: z.string().trim().max(1000).optional() })).max(10).default([])
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
    for (const [index, stop] of data.stops.entries()) {
      await client.query(
        `INSERT INTO buy_order_stops (buy_order_id,stop_order,stop_type,label,address,latitude,longitude,instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [errand.id, index + 1, stop.stopType, stop.label, stop.address, stop.latitude, stop.longitude, stop.instructions ?? null]
      );
    }
    const createdItems = await client.query(
      "SELECT id,requested_description,quantity,max_authorized_minor,requested_price_minor,replacement_policy,status FROM buy_order_items WHERE buy_order_id=$1 ORDER BY created_at",
      [errand.id]
    );
    const createdStops = await client.query(
      "SELECT id,stop_order,stop_type,label,address,latitude,longitude,instructions,status,completed_at,completed_by_user_id FROM buy_order_stops WHERE buy_order_id=$1 ORDER BY stop_order",
      [errand.id]
    );
    await client.query("COMMIT");
    return res.status(201).json({
      errand: {
        id: errand.id,
        errandType: errand.errand_type,
        status: errand.status,
        description: errand.item_description,
        merchantName: errand.merchant_name,
        merchantAddress: errand.merchant_address,
        purchaseBudgetMinor: Number(errand.purchase_budget_minor ?? 0),
        currency: errand.currency,
        replacementPolicy: errand.replacement_policy,
        maxPriceDeltaMinor: Number(errand.max_price_delta_minor ?? 0),
        instructions: errand.errand_instructions,
        requestedCompletionAt: errand.requested_completion_at,
        receiverName: errand.receiver_name,
        receiverPhone: errand.receiver_phone,
        destinationAddress: errand.destination_address,
        destinationLat: errand.destination_lat,
        destinationLng: errand.destination_lng,
        createdAt: errand.created_at,
        updatedAt: errand.updated_at
      },
      stops: createdStops.rows.map((stop) => ({ id: stop.id, order: Number(stop.stop_order), stopType: stop.stop_type, label: stop.label, address: stop.address, latitude: Number(stop.latitude), longitude: Number(stop.longitude), instructions: stop.instructions, status: stop.status, completedAt: stop.completed_at, completedByUserId: stop.completed_by_user_id })),
      items: createdItems.rows.map((item) => ({
        id: item.id,
        description: item.requested_description,
        quantity: Number(item.quantity),
        maxAuthorizedMinor: Number(item.max_authorized_minor),
        requestedPriceMinor: item.requested_price_minor == null ? null : Number(item.requested_price_minor),
        replacementPolicy: item.replacement_policy,
        status: item.status
      }))
    });
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
  const [items, events, payment, stops] = await Promise.all([
    pool.query(`SELECT i.id,i.requested_description,i.quantity,i.max_authorized_minor,i.requested_price_minor,i.replacement_policy,i.status,
       COALESCE((SELECT json_agg(json_build_object(
         'id',r.id,'description',r.proposed_description,'quantity',r.proposed_quantity,'priceMinor',r.proposed_price_minor,
         'currency',r.currency,'shopperNote',r.shopper_note,'status',r.status,'createdAt',r.created_at
       ) ORDER BY r.created_at DESC) FROM buy_order_replacement_options r WHERE r.item_id=i.id),'[]'::json) replacements
       FROM buy_order_items i WHERE i.buy_order_id=$1 ORDER BY i.created_at ASC`, [id]),
    pool.query(`SELECT id,event_type AS "eventType",metadata,created_at AS "createdAt"
       FROM buy_order_events WHERE buy_order_id=$1 ORDER BY created_at ASC LIMIT 200`, [id]),
    pool.query(`SELECT id,status AS payment_status,amount_minor,currency,refund_status,refund_amount_minor
       FROM buy_order_payments WHERE buy_order_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]),
    pool.query(`SELECT id,stop_order,stop_type,label,address,latitude,longitude,instructions,status,completed_at,completed_by_user_id
       FROM buy_order_stops WHERE buy_order_id=$1 ORDER BY stop_order`, [id])
  ]);
  res.json({
    errand: {
      id: order.id,
      errandType: order.errand_type,
      status: order.status,
      itemDescription: order.item_description,
      merchantName: order.merchant_name,
      merchantAddress: order.merchant_address,
      merchantLat: order.merchant_lat,
      merchantLng: order.merchant_lng,
      purchaseBudgetMinor: Number(order.purchase_budget_minor ?? 0),
      actualPurchaseMinor: order.actual_purchase_minor == null ? null : Number(order.actual_purchase_minor),
      currency: order.currency,
      replacementPolicy: order.replacement_policy,
      maxPriceDeltaMinor: Number(order.max_price_delta_minor ?? 0),
      errandInstructions: order.errand_instructions,
      requestedCompletionAt: order.requested_completion_at,
      receiverName: order.receiver_name,
      receiverPhone: order.receiver_phone,
      destinationAddress: order.destination_address,
      destinationLat: order.destination_lat,
      destinationLng: order.destination_lng,
      replacementReviewRequired: Boolean(order.replacement_review_required),
      replacementReviewDeadline: order.replacement_review_deadline,
      agent: order.agent_profile_id ? { id: order.agent_profile_id, name: order.agent_name, phone: order.agent_phone } : null,
      delivery: order.linked_delivery_id ? {
        id: order.linked_delivery_id, trackingCode: order.tracking_code, status: order.delivery_status,
        driverId: order.delivery_driver_id, pickupPhotoUrl: order.pickup_photo_url,
        exceptionStatus: order.exception_status, nextDeliveryAt: order.next_delivery_at,
        receiverConfirmedAt: order.receiver_confirmed_at
      } : null,
      createdAt: order.created_at,
      updatedAt: order.updated_at
    },
    stops: stops.rows.map((stop) => ({ id: stop.id, order: Number(stop.stop_order), stopType: stop.stop_type, label: stop.label, address: stop.address, latitude: Number(stop.latitude), longitude: Number(stop.longitude), instructions: stop.instructions, status: stop.status, completedAt: stop.completed_at, completedByUserId: stop.completed_by_user_id })),
    items: items.rows.map((item) => ({
      id: item.id,
      description: item.requested_description,
      quantity: Number(item.quantity),
      maxAuthorizedMinor: Number(item.max_authorized_minor),
      requestedPriceMinor: item.requested_price_minor == null ? null : Number(item.requested_price_minor),
      replacementPolicy: item.replacement_policy,
      status: item.status,
      replacements: Array.isArray(item.replacements) ? item.replacements.map((option: any) => ({
        id: option.id,
        description: option.description,
        quantity: Number(option.quantity),
        priceMinor: option.priceMinor == null ? null : Number(option.priceMinor),
        currency: option.currency,
        shopperNote: option.shopperNote,
        status: option.status,
        createdAt: option.createdAt
      })) : []
    })),
    events: events.rows.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      metadata: event.metadata,
      createdAt: event.createdAt
    })),
    payment: payment.rows[0] ? {
      id: payment.rows[0].id,
      status: payment.rows[0].status,
      paymentStatus: payment.rows[0].payment_status,
      amountMinor: Number(payment.rows[0].amount_minor),
      currency: payment.rows[0].currency,
      refundStatus: payment.rows[0].refund_status,
      refundAmountMinor: payment.rows[0].refund_amount_minor == null ? null : Number(payment.rows[0].refund_amount_minor)
    } : null
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
  res.json({
    replacementReviewRequired: order.replacement_review_required,
    reviewDeadline: order.replacement_review_deadline,
    items: items.rows.map((item) => ({
      id: item.id,
      description: item.requested_description,
      quantity: Number(item.quantity),
      maxAuthorizedMinor: Number(item.max_authorized_minor),
      requestedPriceMinor: item.requested_price_minor == null ? null : Number(item.requested_price_minor),
      replacementPolicy: item.replacement_policy,
      status: item.status,
      replacements: item.replacements
    }))
  });
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
