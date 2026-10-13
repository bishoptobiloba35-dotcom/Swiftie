import { Router } from "express";
import { z } from "zod";
import { signAccessToken } from "./auth.js";
import { hashPassword, verifyPassword } from "./security.js";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";

const router = Router();

const authAttempts = new Map<string, { count: number; resetAt: number }>();
function rateLimitAuth(limit: number) {
  return (req: any, res: any, next: any) => {
    const key = String(req.ip ?? req.socket?.remoteAddress ?? "unknown");
    const now = Date.now();
    const current = authAttempts.get(key);
    if (!current || current.resetAt <= now) {
      authAttempts.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    if (current.count >= limit) {
      res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many authentication attempts. Please try again shortly." });
    }
    current.count += 1;
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of authAttempts) if (value.resetAt <= now) authAttempts.delete(key);
}, 5 * 60_000).unref();

const schema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["CUSTOMER", "DRIVER", "AGENT", "ADMIN"])
});



const TERMS_VERSION = "2026-09-28";
const PRIVACY_VERSION = "2026-09-28";
const ACCEPTABLE_USE_VERSION = "2026-09-28";

const registrationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().optional(),
  password: z.string().min(8).max(128),
  role: z.enum(["CUSTOMER", "DRIVER", "AGENT"]).default("CUSTOMER"),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  acceptableUseAccepted: z.literal(true)
});

router.post("/register", rateLimitAuth(5), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { fullName, phone, email, password, role } = parsed.data;
  try {
    const existing = await pool.query("SELECT id FROM users WHERE phone=$1 OR ($2::text IS NOT NULL AND email=$2)", [phone, email ?? null]);
    if (existing.rows[0]) return res.status(409).json({ error: "An account already exists with that phone or email" });
    const passwordHash = hashPassword(password);
    const userResult = await pool.query(
      "INSERT INTO users (role, full_name, phone, email, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, role, full_name, phone, email",
      [role, fullName, phone, email ?? null, passwordHash]
    );
    const user = userResult.rows[0];
    if (role === "DRIVER") {
      await pool.query("INSERT INTO drivers (user_id) VALUES ($1)", [user.id]);
    } else if (role === "AGENT") {
      await pool.query("INSERT INTO agent_profiles (user_id) VALUES ($1)", [user.id]);
    }
    await pool.query(
      `INSERT INTO legal_acceptances (user_id, terms_version, privacy_version, acceptable_use_version, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user.id, TERMS_VERSION, PRIVACY_VERSION, ACCEPTABLE_USE_VERSION, req.ip ?? null, req.get("user-agent") ?? null]
    );
    const accessToken = signAccessToken({ userId: user.id, role: user.role });
    res.status(201).json({
      accessToken,
      user: {
        id: user.id,
        role: user.role,
        fullName: user.full_name,
        phone: user.phone,
        email: user.email
      }
    });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ error: "Phone or email is already registered" });
    if (error?.code === "42P01") return res.status(503).json({ error: "Account registration is temporarily unavailable while legal acceptance storage is being prepared." });
    res.status(500).json({ error: "Unable to create account" });
  }
});

const loginSchema = z.object({
  phone: z.string().trim().min(7).max(30),
  password: z.string().min(8).max(128)
});

router.post("/login", rateLimitAuth(10), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid login details" });
  const result = await pool.query(
    "SELECT id, role, full_name, phone, email, password_hash FROM users WHERE phone=$1",
    [parsed.data.phone]
  );
  const user = result.rows[0];
  if (!user?.password_hash || !verifyPassword(parsed.data.password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid phone or password" });
  }
  const accessToken = signAccessToken({ userId: user.id, role: user.role });
  if (user.role === "DRIVER") {
    await pool.query(
      `UPDATE drivers d
          SET online=true, updated_at=now()
        WHERE d.user_id=$1
          AND d.status='APPROVED'
          AND EXISTS (
            SELECT 1 FROM driver_documents dd
            WHERE dd.driver_id=d.id AND dd.status='APPROVED'
          )`,
      [user.id]
    );
  }
  res.json({
    accessToken,
    user: { id: user.id, role: user.role, full_name: user.full_name, phone: user.phone, email: user.email }
  });
});


const accountModeSchema = z.object({ mode: z.enum(["INDIVIDUAL", "BUSINESS", "MERCHANT"]) });

router.get("/mode", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  try {
    const userId = identity(req);
    const user = (await pool.query("SELECT mode, account_type, business_role FROM users WHERE id=$1", [userId])).rows[0];
    if (!user) return res.status(404).json({ error: "Account not found" });
    const membership = (await pool.query(
      "SELECT status FROM business_role_memberships WHERE user_id=$1 AND role='MERCHANT'",
      [userId]
    )).rows[0];
    res.json({
      mode: ["INDIVIDUAL", "BUSINESS", "MERCHANT"].includes(user.mode) ? user.mode : "INDIVIDUAL",
      accountType: user.account_type ?? "INDIVIDUAL",
      businessRole: user.business_role ?? null,
      merchantStatus: membership?.status ?? "NOT_REQUESTED"
    });
  } catch {
    res.status(503).json({ error: "Unable to load account mode" });
  }
});

router.post("/merchant-mode/request", requireAuth("CUSTOMER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  try {
    const userId = identity(req);
    const result = await pool.query(
      `INSERT INTO business_role_memberships (user_id, role, status)
       VALUES ($1, 'MERCHANT', 'PENDING')
       ON CONFLICT (user_id, role) DO UPDATE
         SET status = CASE WHEN business_role_memberships.status='SUSPENDED' THEN 'PENDING' ELSE business_role_memberships.status END
       RETURNING status`,
      [userId]
    );
    res.status(202).json({ merchantStatus: result.rows[0].status });
  } catch (error: any) {
    if (error?.code === "42P01") return res.status(503).json({ error: "Merchant onboarding is not available until business-role migrations are applied" });
    res.status(500).json({ error: "Unable to submit Merchant mode request" });
  }
});

router.patch("/mode", requireAuth(), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = accountModeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const userId = identity(req);
    const mode = parsed.data.mode;
    if (mode === "MERCHANT") {
      const membership = (await pool.query(
        "SELECT status FROM business_role_memberships WHERE user_id=$1 AND role='MERCHANT'",
        [userId]
      )).rows[0];
      if (membership?.status !== "APPROVED") {
        return res.status(403).json({ error: "Merchant mode requires an approved Merchant account", merchantStatus: membership?.status ?? "NOT_REQUESTED" });
      }
    }
    const result = await pool.query(
      `UPDATE users
          SET mode=$2,
              account_type=CASE WHEN $2='INDIVIDUAL' THEN 'INDIVIDUAL' ELSE 'BUSINESS' END,
              business_role=CASE WHEN $2='MERCHANT' THEN 'MERCHANT' ELSE business_role END
        WHERE id=$1
        RETURNING mode, account_type, business_role`,
      [userId, mode]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Account not found" });
    res.json({ mode: result.rows[0].mode, accountType: result.rows[0].account_type, businessRole: result.rows[0].business_role });
  } catch {
    res.status(503).json({ error: "Unable to update account mode" });
  }
});

router.get("/admin/merchant-mode/requests", requireAuth("ADMIN"), async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  try {
    const result = await pool.query(
      `SELECT m.user_id, u.full_name, u.phone, u.email, m.status, m.created_at
         FROM business_role_memberships m
         JOIN users u ON u.id=m.user_id
        WHERE m.role='MERCHANT' AND m.status='PENDING'
        ORDER BY m.created_at ASC
        LIMIT 100`
    );
    res.json({ requests: result.rows });
  } catch {
    res.status(503).json({ error: "Unable to load Merchant mode requests" });
  }
});

router.post("/admin/merchant-mode/requests/:userId/approve", requireAuth("ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = z.string().uuid().safeParse(req.params.userId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid user ID" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query(
      "UPDATE business_role_memberships SET status='APPROVED' WHERE user_id=$1 AND role='MERCHANT' AND status='PENDING' RETURNING user_id",
      [parsed.data]
    );
    if (!membership.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pending Merchant request not found" });
    }
    await client.query(
      "UPDATE users SET business_role='MERCHANT', account_type='BUSINESS' WHERE id=$1",
      [parsed.data]
    );
    await client.query("COMMIT");
    res.json({ approved: true, userId: parsed.data });
  } catch {
    await client.query("ROLLBACK");
    res.status(503).json({ error: "Unable to approve Merchant mode request" });
  } finally {
    client.release();
  }
});

router.post("/admin/merchant-mode/requests/:userId/reject", requireAuth("ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = z.string().uuid().safeParse(req.params.userId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid user ID" });
  const result = await pool.query(
    "UPDATE business_role_memberships SET status='SUSPENDED' WHERE user_id=$1 AND role='MERCHANT' AND status='PENDING' RETURNING user_id",
    [parsed.data]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Pending Merchant request not found" });
  res.json({ rejected: true, userId: parsed.data });
});

router.post("/dev-token", (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).end();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json({ accessToken: signAccessToken(parsed.data), user: parsed.data });
});

export default router;
