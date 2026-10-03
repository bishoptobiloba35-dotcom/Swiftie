import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { deletePrivateObject, getPrivateObject, putPrivateObject } from "./storage.js";
import { hashPin } from "./security.js";

const router = Router();

const listingSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  bio: z.string().trim().max(1000).default(""),
  locationLabel: z.string().trim().max(200).optional(),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().min(10).max(5000),
  condition: z.enum(["NEW","LIKE_NEW","GOOD","FAIR","USED","FOR_PARTS"]),
  useDescription: z.string().trim().min(5).max(2000),
  usageInstructions: z.string().trim().max(5000).optional(),
  category: z.string().trim().min(2).max(80),
  priceMinor: z.number().int().positive().max(100000000000),
  deliveryFeeMinor: z.number().int().nonnegative().max(10000000000),
  deliveryMode: z.enum(["SAME_STATE","INTER_STATE","EXPRESS","PICKUP"]),
  stockQuantity: z.number().int().min(0).max(100000),
  pickupAddress: z.string().trim().min(5).max(300),
  pickupLatitude: z.number().min(-90).max(90),
  pickupLongitude: z.number().min(-180).max(180),
  weightKg: z.number().positive().max(1000),
  lengthCm: z.number().positive().max(500),
  widthCm: z.number().positive().max(500),
  heightCm: z.number().positive().max(500),
  isPerishable: z.boolean().default(false),
  media: z.array(z.string()).max(8).optional()
});

const checkoutSchema = z.object({
  quantity: z.number().int().min(1).max(100).default(1),
  requestedDeliveryAt: z.string().datetime().optional(),
  idempotencyKey: z.string().trim().min(16).max(100)
});

router.get("/marketplace/listings", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const q = String(req.query.q ?? "").trim();
  const category = String(req.query.category ?? "").trim();
  const params: unknown[] = [];
  const where: string[] = ["l.status='PUBLISHED'", "s.status='ACTIVE'"];
  if (q) { params.push("%"+q+"%"); where.push("(l.title ILIKE $"+params.length+" OR l.description ILIKE $"+params.length+" OR l.category ILIKE $"+params.length+")"); }
  if (category) { params.push(category); where.push("l.category=$"+params.length); }
  const result = await pool.query(
    `SELECT l.id,l.title,l.description,l.condition,l.use_description,l.usage_instructions,l.category,l.delivery_fee_minor,l.final_price_minor,
            l.currency,l.delivery_mode,l.stock_quantity,l.pickup_address,l.pickup_lat,l.pickup_lng,l.weight_kg,l.length_cm,l.width_cm,l.height_cm,l.is_perishable,l.created_at,
            s.id AS seller_id,s.display_name AS seller_name,s.bio AS seller_bio,s.location_label AS seller_location,
            COALESCE((SELECT json_agg(json_build_object('id',m.id,'url','/api/marketplace/listings/' || m.listing_id || '/media/' || m.id,'sortOrder',m.sort_order) ORDER BY m.sort_order)
                      FROM marketplace_listing_media m WHERE m.listing_id=l.id),'[]'::json) AS media
       FROM marketplace_listings l
       JOIN marketplace_seller_profiles s ON s.id=l.seller_profile_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.created_at DESC
      LIMIT 100`,
    params
  );
  return res.json({ listings: result.rows });
});

router.get("/marketplace/orders", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT mo.id,mo.listing_id,mo.quantity,mo.unit_final_price_minor,mo.total_minor,mo.currency,
            mo.status,mo.fulfillment_status,mo.delivery_id,mo.requested_delivery_at,mo.created_at,mo.updated_at,
            l.title,l.condition,
            s.display_name AS seller_name,
            mop.status AS payment_status,mop.provider_reference
       FROM marketplace_orders mo
       JOIN marketplace_listings l ON l.id=mo.listing_id
       JOIN marketplace_seller_profiles s ON s.id=l.seller_profile_id
       LEFT JOIN marketplace_order_payments mop ON mop.marketplace_order_id=mo.id
      WHERE mo.buyer_user_id=$1
      ORDER BY mo.created_at DESC
      LIMIT 50`,
    [identity(req)]
  );
  return res.json({ orders: result.rows });
});

router.get("/marketplace/orders/:id", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT mo.id,mo.listing_id,mo.quantity,mo.unit_final_price_minor,mo.total_minor,mo.currency,
            mo.status,mo.fulfillment_status,mo.delivery_id,mo.requested_delivery_at,mo.created_at,mo.updated_at,
            l.title,l.description,l.condition,l.use_description,l.usage_instructions,l.delivery_mode,
            s.display_name AS seller_name,s.location_label AS seller_location,
            mop.status AS payment_status,mop.provider_status,mop.provider_reference,mop.authorization_url
       FROM marketplace_orders mo
       JOIN marketplace_listings l ON l.id=mo.listing_id
       JOIN marketplace_seller_profiles s ON s.id=l.seller_profile_id
       LEFT JOIN marketplace_order_payments mop ON mop.marketplace_order_id=mo.id
      WHERE mo.id=$1 AND mo.buyer_user_id=$2`,
    [String(req.params.id), identity(req)]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Marketplace order not found" });
  return res.json({ order: result.rows[0] });
});

router.post("/marketplace/orders/:id/fulfill", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const orderId = String(req.params.id);
  const parsed = z.object({
    receiverName: z.string().trim().min(2).max(120),
    receiverPhone: z.string().trim().min(7).max(30),
    receiverPin: z.string().regex(/^\d{6}$/),
    dropoffAddress: z.string().trim().min(5).max(300),
    dropoffLatitude: z.number().min(-90).max(90),
    dropoffLongitude: z.number().min(-180).max(180)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = identity(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = (await client.query(
      `SELECT mo.*, l.pickup_address,l.pickup_lat,l.pickup_lng,l.weight_kg,l.length_cm,l.width_cm,l.height_cm,l.is_perishable,l.delivery_fee_minor,l.delivery_mode
         FROM marketplace_orders mo
         JOIN marketplace_listings l ON l.id=mo.listing_id
        WHERE mo.id=$1 AND mo.buyer_user_id=$2
        FOR UPDATE`,
      [orderId, userId]
    )).rows[0];
    if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Marketplace order not found" }); }
    if (order.status !== "PAID") return res.status(409).json({ error: "Marketplace order must be paid before fulfillment" });
    if (order.fulfillment_status !== "NOT_STARTED") {
      await client.query("ROLLBACK");
      return res.json({ orderId, fulfillmentStatus: order.fulfillment_status, deliveryId: order.delivery_id ?? null, message: "Marketplace fulfillment is already initialized." });
    }
    if (order.delivery_mode === "PICKUP") return res.status(409).json({ error: "Pickup-only marketplace orders do not require courier fulfillment" });
    if (!order.pickup_address || order.pickup_lat == null || order.pickup_lng == null) return res.status(409).json({ error: "Seller pickup details are incomplete" });
    const deliveryFeeMinor = Number(order.delivery_fee_minor) * Number(order.quantity);
    if (!Number.isSafeInteger(deliveryFeeMinor) || deliveryFeeMinor <= 0) return res.status(409).json({ error: "Marketplace delivery fee must be greater than zero for courier fulfillment" });
    const deliveryId = randomUUID();
    const trackingCode = "SD-" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    const pinHash = hashPin(parsed.data.receiverPin);
    const delivery = (await client.query(
      `INSERT INTO deliveries
        (id,tracking_code,sender_id,receiver_name,receiver_phone,payment_mode,pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,status,receiver_pin_hash,
         weight_kg,length_cm,width_cm,height_cm,is_perishable,declared_value_minor,
         quote_distance_meters,quote_duration_seconds,quote_base_fare_minor,quote_distance_fare_minor,quote_weight_fare_minor,quote_size_fare_minor,quote_perishable_surcharge_minor,quote_service_fee_minor,quote_total_minor,quote_currency)
       VALUES ($1,$2,$3,$4,$5,'SENDER_ESCROW',$6,$7,$8,$9,$10,$11,'PAYMENT_AUTHORIZED',$12,$13,$14,$15,$16,$17,$18,0,0,0,0,0,0,0,0, $19,'NGN')
       RETURNING *`,
      [deliveryId,trackingCode,order.seller_user_id,parsed.data.receiverName,parsed.data.receiverPhone,
       order.pickup_address,Number(order.pickup_lat),Number(order.pickup_lng),parsed.data.dropoffAddress,parsed.data.dropoffLatitude,parsed.data.dropoffLongitude,
       pinHash,Number(order.weight_kg),Number(order.length_cm),Number(order.width_cm),Number(order.height_cm),Boolean(order.is_perishable),Number(order.unit_final_price_minor)*Number(order.quantity),deliveryFeeMinor]
    )).rows[0];
    await client.query(
      `INSERT INTO payments(delivery_id,provider,amount_minor,currency,status,collection_mode,escrow_status)
       VALUES($1,'marketplace', $2,'NGN','HELD','SENDER_ESCROW','HELD')`,
      [deliveryId,deliveryFeeMinor]
    );
    await client.query(
      `INSERT INTO delivery_events(delivery_id,event_type,actor_user_id,metadata)
       VALUES($1,'MARKETPLACE_FULFILLMENT_INITIALIZED',$2,$3::jsonb)`,
      [deliveryId,userId,JSON.stringify({ marketplaceOrderId: orderId, requestedDeliveryAt: order.requested_delivery_at })]
    );
    await client.query(
      `UPDATE deliveries SET next_delivery_at=$2, updated_at=now() WHERE id=$1`,
      [deliveryId,order.requested_delivery_at ?? null]
    );
    const updatedOrder = (await client.query(
      `UPDATE marketplace_orders
          SET delivery_id=$2, fulfillment_status='READY', status='PROCESSING', updated_at=now()
        WHERE id=$1 AND fulfillment_status='NOT_STARTED'
        RETURNING *`,
      [orderId,deliveryId]
    )).rows[0];
    if (!updatedOrder) throw new Error("Marketplace fulfillment state changed concurrently");
    await client.query("COMMIT");
    return res.status(201).json({ order: updatedOrder, deliveryId, trackingCode, fulfillmentStatus: "READY" });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unable to initialize marketplace fulfillment" });
  } finally { client.release(); }
});

router.get("/marketplace/listings/:id/media/:mediaId", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT m.storage_key
       FROM marketplace_listing_media m
       JOIN marketplace_listings l ON l.id=m.listing_id
       JOIN marketplace_seller_profiles s ON s.id=l.seller_profile_id
      WHERE m.id=$1 AND m.listing_id=$2 AND l.status='PUBLISHED' AND s.status='ACTIVE'`,
    [String(req.params.mediaId), String(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Listing image not found" });
  try {
    const stored = await getPrivateObject(result.rows[0].storage_key);
    res.setHeader("content-type", stored.contentType ?? "image/jpeg");
    res.setHeader("cache-control", "public, max-age=300");
    return res.send(stored.body);
  } catch {
    return res.status(404).json({ error: "Listing image is unavailable" });
  }
});

router.get("/marketplace/listings/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id);
  const result = await pool.query(
    `SELECT l.id,l.title,l.description,l.condition,l.use_description,l.usage_instructions,l.category,l.delivery_fee_minor,l.final_price_minor,
            l.currency,l.delivery_mode,l.stock_quantity,l.created_at,
            s.id AS seller_id,s.user_id AS seller_user_id,s.display_name AS seller_name,s.bio AS seller_bio,s.location_label AS seller_location,
            COALESCE((SELECT json_agg(json_build_object('id',m.id,'url','/api/marketplace/listings/' || m.listing_id || '/media/' || m.id,'sortOrder',m.sort_order) ORDER BY m.sort_order)
                      FROM marketplace_listing_media m WHERE m.listing_id=l.id),'[]'::json) AS media
       FROM marketplace_listings l
       JOIN marketplace_seller_profiles s ON s.id=l.seller_profile_id
      WHERE l.id=$1 AND l.status='PUBLISHED' AND s.status='ACTIVE'`,
    [id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Listing not found" });
  const listing = result.rows[0];
  const recommended = await pool.query(
    `SELECT l.id,l.title,l.price_minor,l.delivery_fee_minor,l.final_price_minor,l.currency,l.delivery_mode,l.stock_quantity
       FROM marketplace_listings l
      WHERE l.seller_user_id=$1 AND l.id<>$2 AND l.status='PUBLISHED'
      ORDER BY l.created_at DESC LIMIT 8`,
    [listing.seller_user_id, id]
  );
  return res.json({ listing, recommended: recommended.rows });
});

// Any authenticated SwiftDrop user may sell ordinary everyday goods.
// Selling is no longer restricted to the cancelled Merchant mode or approved Agents.
router.post("/marketplace/listings", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = listingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = identity(req);
  const p = parsed.data;
  const finalPriceMinor = p.priceMinor + p.deliveryFeeMinor;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seller = await client.query(
      `INSERT INTO marketplace_seller_profiles(user_id,display_name,bio,location_label)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(user_id) DO UPDATE SET display_name=EXCLUDED.display_name,bio=EXCLUDED.bio,location_label=EXCLUDED.location_label,updated_at=now()
       RETURNING *`,
      [userId,p.displayName,p.bio,p.locationLabel ?? null]
    );
    const listing = await client.query(
      `INSERT INTO marketplace_listings
       (seller_user_id,seller_profile_id,title,description,condition,use_description,usage_instructions,category,price_minor,delivery_fee_minor,final_price_minor,currency,delivery_mode,stock_quantity,pickup_address,pickup_lat,pickup_lng,weight_kg,length_cm,width_cm,height_cm,is_perishable)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'NGN',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [userId,seller.rows[0].id,p.title,p.description,p.condition,p.useDescription,p.usageInstructions ?? null,p.category,p.priceMinor,p.deliveryFeeMinor,finalPriceMinor,p.deliveryMode,p.stockQuantity,p.pickupAddress,p.pickupLatitude,p.pickupLongitude,p.weightKg,p.lengthCm,p.widthCm,p.heightCm,p.isPerishable]
    );

    const uploadedKeys: string[] = [];
    try {
      for (const [index, media] of (p.media ?? []).entries()) {
        const match = media.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
        if (!match) throw new Error("Each marketplace image must be a JPEG, PNG or WebP data URL");
        const bytes = Buffer.from(match[2], "base64");
        if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Each marketplace image must not exceed 8MB");
        const extension = match[1].toLowerCase() === "webp" ? "webp" : match[1].toLowerCase() === "png" ? "png" : "jpg";
        const contentType = extension === "webp" ? "image/webp" : extension === "png" ? "image/png" : "image/jpeg";
        const key = "marketplace/listings/" + listing.rows[0].id + "/" + String(index).padStart(2, "0") + "-" + randomUUID() + "." + extension;
        await putPrivateObject(key, bytes, contentType);
        uploadedKeys.push(key);
        await client.query(
          "INSERT INTO marketplace_listing_media(listing_id,storage_key,sort_order) VALUES($1,$2,$3)",
          [listing.rows[0].id, key, index]
        );
      }
    } catch (mediaError) {
      for (const key of uploadedKeys) {
        try { await deletePrivateObject(key); } catch {}
      }
      throw mediaError;
    }

    await client.query("COMMIT");
    return res.status(201).json({ listing: listing.rows[0], seller: seller.rows[0], mediaCount: uploadedKeys.length });
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
});

router.post("/marketplace/orders/:id/payment/initialize", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const orderId = String(req.params.id);
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email is required" });
  const userId = identity(req);
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: "Paystack is not configured" });

  const existing = await pool.query(
    `SELECT mop.*, mo.buyer_user_id, mo.status AS order_status
       FROM marketplace_order_payments mop
       JOIN marketplace_orders mo ON mo.id=mop.marketplace_order_id
      WHERE mop.marketplace_order_id=$1 AND mo.buyer_user_id=$2
      ORDER BY mop.created_at DESC LIMIT 1`,
    [orderId, userId]
  );
  const current = existing.rows[0];
  if (current?.status === "AUTHORIZED" || current?.status === "REFUNDED") {
    return res.status(409).json({ error: `Marketplace order payment is already ${String(current.status).toLowerCase()}` });
  }
  const order = (await pool.query(
    `SELECT id,buyer_user_id,total_minor,currency,status FROM marketplace_orders WHERE id=$1 AND buyer_user_id=$2`,
    [orderId, userId]
  )).rows[0];
  if (!order) return res.status(404).json({ error: "Marketplace order not found" });
  if (order.status !== "PENDING_PAYMENT") return res.status(409).json({ error: "Marketplace order is not awaiting payment" });

  const amountMinor = Number(order.total_minor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return res.status(409).json({ error: "Marketplace order amount is invalid" });

  const reference = "SD-MKT-" + orderId + "-" + Date.now();
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({ email, amount: String(amountMinor), currency: "NGN", reference, metadata: { marketplaceOrderId: orderId, buyerUserId: userId } })
  });
  const payload = await response.json() as { status?: boolean; message?: string; data?: { authorization_url?: string; access_code?: string; reference?: string } };
  if (!response.ok || !payload.status || !payload.data?.authorization_url) return res.status(502).json({ error: "Payment provider initialization failed" });

  const payment = await pool.query(
    `INSERT INTO marketplace_order_payments
       (marketplace_order_id,buyer_user_id,provider,provider_reference,amount_minor,currency,status,provider_status,authorization_url)
     VALUES($1,$2,'paystack',$3,$4,'NGN','PENDING','pending',$5)
     ON CONFLICT (marketplace_order_id) DO UPDATE
       SET provider_reference=EXCLUDED.provider_reference, amount_minor=EXCLUDED.amount_minor,
           provider_status='pending', authorization_url=EXCLUDED.authorization_url, updated_at=now()
     RETURNING *`,
    [orderId, userId, reference, amountMinor, payload.data.authorization_url]
  );
  return res.status(201).json({ payment: payment.rows[0], authorizationUrl: payload.data.authorization_url, accessCode: payload.data.access_code ?? null, reference });
});

router.post("/marketplace/orders/:id/payment/verify", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const orderId = String(req.params.id);
  const userId = identity(req);
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: "Paystack is not configured" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payment = (await client.query(
      `SELECT mop.*, mo.quantity, mo.status AS order_status
         FROM marketplace_order_payments mop
         JOIN marketplace_orders mo ON mo.id=mop.marketplace_order_id
        WHERE mop.marketplace_order_id=$1 AND mo.buyer_user_id=$2
        FOR UPDATE`,
      [orderId, userId]
    )).rows[0];
    if (!payment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Marketplace payment not found" });
    }
    if (payment.status === "AUTHORIZED") {
      await client.query("ROLLBACK");
      return res.json({ status: "AUTHORIZED", orderStatus: payment.order_status, providerStatus: payment.provider_status });
    }
    if (payment.status === "REFUNDED") {
      await client.query("ROLLBACK");
      return res.json({ status: "REFUNDED", orderStatus: payment.order_status, providerStatus: payment.provider_status });
    }
    if (!payment.provider_reference) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Marketplace payment has no provider reference" });
    }

    const response = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(String(payment.provider_reference)), {
      headers: { authorization: "Bearer " + secret }
    });
    const payload = await response.json() as {
      status?: boolean;
      message?: string;
      data?: { status?: string; amount?: number; currency?: string; reference?: string };
    };
    if (!response.ok || !payload.status || !payload.data) {
      await client.query("ROLLBACK");
      return res.status(502).json({ error: "Payment provider verification failed" });
    }

    const providerStatus = String(payload.data.status ?? "").toLowerCase();
    const providerAmount = Number(payload.data.amount);
    const providerCurrency = String(payload.data.currency ?? "");
    const amountMatches = Number.isSafeInteger(providerAmount) &&
      providerAmount === Number(payment.amount_minor) &&
      providerCurrency === String(payment.currency).trim();

    if (providerStatus === "success" && amountMatches) {
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
        [orderId]
      );
    } else if (providerStatus === "failed" || providerStatus === "abandoned" || !amountMatches) {
      await client.query(
        `UPDATE marketplace_order_payments
            SET status='FAILED', provider_status=$2, updated_at=now()
          WHERE id=$1 AND status='PENDING'`,
        [payment.id, !amountMatches ? "amount_mismatch" : providerStatus]
      );
      const restored = await client.query(
        `UPDATE marketplace_listings l
            SET stock_quantity=l.stock_quantity+$2,
                status=CASE WHEN l.status='SOLD_OUT' THEN 'PUBLISHED' ELSE l.status END,
                updated_at=now()
           FROM marketplace_orders mo
          WHERE mo.id=$1 AND l.id=mo.listing_id AND mo.status='PENDING_PAYMENT'
          RETURNING l.stock_quantity,l.status`,
        [orderId, payment.quantity]
      );
      const cancelled = await client.query(
        `UPDATE marketplace_orders
            SET status='CANCELLED', updated_at=now()
          WHERE id=$1 AND status='PENDING_PAYMENT'
          RETURNING id`,
        [orderId]
      );
      if (cancelled.rowCount === 1 && restored.rowCount !== 1) {
        await client.query("ROLLBACK");
        return res.status(500).json({ error: "Marketplace stock reconciliation failed" });
      }
    } else if (!amountMatches) {
      await client.query(
        `UPDATE marketplace_order_payments SET provider_status='amount_mismatch', updated_at=now() WHERE id=$1`,
        [payment.id]
      );
    } else {
      await client.query(
        `UPDATE marketplace_order_payments SET provider_status=$2, updated_at=now() WHERE id=$1`,
        [payment.id, providerStatus || "pending"]
      );
    }

    await client.query("COMMIT");
    const refreshed = (await pool.query(
      `SELECT mo.status AS order_status,mop.status,mop.provider_status
         FROM marketplace_orders mo
         JOIN marketplace_order_payments mop ON mop.marketplace_order_id=mo.id
        WHERE mo.id=$1 AND mo.buyer_user_id=$2`,
      [orderId, userId]
    )).rows[0];
    return res.json({ status: refreshed?.status ?? "PENDING", orderStatus: refreshed?.order_status ?? "PENDING_PAYMENT", providerStatus: refreshed?.provider_status ?? providerStatus });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(JSON.stringify({ event: "marketplace_payment_verification_failed", orderId, error: error instanceof Error ? error.message : "unknown" }));
    return res.status(500).json({ error: "Marketplace payment verification failed" });
  } finally {
    client.release();
  }
});

router.get("/marketplace/orders/:id/payment", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT mop.id,mop.marketplace_order_id,mop.amount_minor,mop.currency,mop.status,mop.provider_status,mop.provider_reference,mop.created_at,mop.updated_at
       FROM marketplace_order_payments mop
       JOIN marketplace_orders mo ON mo.id=mop.marketplace_order_id
      WHERE mop.marketplace_order_id=$1 AND mo.buyer_user_id=$2`,
    [String(req.params.id), identity(req)]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Marketplace payment not found" });
  return res.json({ payment: result.rows[0] });
});

router.post("/marketplace/listings/:id/checkout", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsedCheckout = checkoutSchema.safeParse({
    quantity: Number(req.body?.quantity ?? 1),
    requestedDeliveryAt: req.body?.requestedDeliveryAt,
    idempotencyKey: req.body?.idempotencyKey
  });
  if (!parsedCheckout.success) return res.status(400).json({ error: parsedCheckout.error.flatten() });
  const quantity = parsedCheckout.data.quantity;
  const idempotencyKey = parsedCheckout.data.idempotencyKey;
  const requestedDeliveryAt = parsedCheckout.data.requestedDeliveryAt ? new Date(parsedCheckout.data.requestedDeliveryAt) : null;
  if (requestedDeliveryAt && requestedDeliveryAt.getTime() <= Date.now()) {
    return res.status(400).json({ error: "requestedDeliveryAt must be in the future" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingOrder = await client.query(
      `SELECT * FROM marketplace_orders WHERE buyer_user_id=$1 AND checkout_idempotency_key=$2`,
      [identity(req), idempotencyKey]
    );
    if (existingOrder.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(200).json({ order: existingOrder.rows[0], idempotentReplay: true, message: "Checkout already created for this request." });
    }
    const locked = await client.query("SELECT * FROM marketplace_listings WHERE id=$1 FOR UPDATE", [String(req.params.id)]);
    const listing = locked.rows[0];
    if (!listing || listing.status !== "PUBLISHED") { await client.query("ROLLBACK"); return res.status(404).json({ error: "Listing is not available" }); }
    if (Number(listing.stock_quantity) < quantity) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Not enough stock available" }); }
    const total = Number(listing.final_price_minor) * quantity;
    const stockUpdate = await client.query(
      `UPDATE marketplace_listings
          SET stock_quantity = stock_quantity - $2,
              status = CASE WHEN stock_quantity - $2 = 0 THEN 'SOLD_OUT' ELSE status END,
              updated_at = now()
        WHERE id=$1 AND status='PUBLISHED' AND stock_quantity >= $2
        RETURNING stock_quantity,status`,
      [listing.id, quantity]
    );
    if (!stockUpdate.rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ error: "The requested quantity is no longer available" }); }
    const order = await client.query(
      `INSERT INTO marketplace_orders(listing_id,buyer_user_id,seller_user_id,quantity,unit_final_price_minor,total_minor,currency,requested_delivery_at,checkout_idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [listing.id,identity(req),listing.seller_user_id,quantity,listing.final_price_minor,total,listing.currency,requestedDeliveryAt,idempotencyKey]
    );
    await client.query("COMMIT");
    return res.status(201).json({ order: order.rows[0], stockRemaining: Number(stockUpdate.rows[0].stock_quantity), message: "Checkout created. Payment authorization is the next step." });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

export default router;
