import { Router } from "express";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";

const router = Router();

const listingSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  bio: z.string().trim().max(1000).default(""),
  locationLabel: z.string().trim().max(200).optional(),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().min(10).max(5000),
  category: z.string().trim().min(2).max(80),
  priceMinor: z.number().int().positive().max(100000000000),
  deliveryFeeMinor: z.number().int().nonnegative().max(10000000000),
  deliveryMode: z.enum(["SAME_STATE","INTER_STATE","EXPRESS","PICKUP"]),
  stockQuantity: z.number().int().min(0).max(100000)
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
    `SELECT l.id,l.title,l.description,l.category,l.price_minor,l.delivery_fee_minor,l.final_price_minor,
            l.currency,l.delivery_mode,l.stock_quantity,l.created_at,
            s.id AS seller_id,s.display_name AS seller_name,s.bio AS seller_bio,s.location_label AS seller_location,
            COALESCE((SELECT json_agg(json_build_object('storageKey',m.storage_key,'sortOrder',m.sort_order) ORDER BY m.sort_order)
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

router.get("/marketplace/listings/:id", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const id = String(req.params.id);
  const result = await pool.query(
    `SELECT l.id,l.title,l.description,l.category,l.price_minor,l.delivery_fee_minor,l.final_price_minor,
            l.currency,l.delivery_mode,l.stock_quantity,l.created_at,
            s.id AS seller_id,s.user_id AS seller_user_id,s.display_name AS seller_name,s.bio AS seller_bio,s.location_label AS seller_location
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

router.post("/marketplace/listings", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = listingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = identity(req);
  const agent = await pool.query("SELECT status FROM agent_profiles WHERE user_id=$1", [userId]);
  if (agent.rows[0]?.status !== "APPROVED") return res.status(403).json({ error: "Approved agent status is required to publish marketplace goods" });
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
       (seller_user_id,seller_profile_id,title,description,category,price_minor,delivery_fee_minor,final_price_minor,currency,delivery_mode,stock_quantity)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'NGN',$9,$10)
       RETURNING *`,
      [userId,seller.rows[0].id,p.title,p.description,p.category,p.priceMinor,p.deliveryFeeMinor,finalPriceMinor,p.deliveryMode,p.stockQuantity]
    );
    await client.query("COMMIT");
    return res.status(201).json({ listing: listing.rows[0], seller: seller.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
});

router.post("/marketplace/listings/:id/checkout", requireAuth("CUSTOMER","AGENT","DRIVER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const quantity = Number(req.body?.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return res.status(400).json({ error: "Quantity must be a positive whole number" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
    if (!stockUpdate.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "The requested quantity is no longer available" });
    }
    const order = await client.query(
      `INSERT INTO marketplace_orders(listing_id,buyer_user_id,seller_user_id,quantity,unit_final_price_minor,total_minor,currency)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [listing.id,identity(req),listing.seller_user_id,quantity,listing.final_price_minor,total,listing.currency]
    );
    await client.query("COMMIT");
    return res.status(201).json({
      order: order.rows[0],
      stockRemaining: Number(stockUpdate.rows[0].stock_quantity),
      message: "Checkout created. Payment authorization is the next step."
    });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});

export default router;
