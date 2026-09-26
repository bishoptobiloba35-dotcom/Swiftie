import { Router } from "express";
import { z } from "zod";
import { signAccessToken } from "./auth.js";
import { hashPassword, verifyPassword } from "./security.js";
import { pool } from "./database/db.js";

const router = Router();
const schema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["CUSTOMER", "DRIVER", "ADMIN"])
});



const registrationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().optional(),
  password: z.string().min(8).max(128),
  role: z.enum(["CUSTOMER", "DRIVER"]).default("CUSTOMER")
});

router.post("/register", async (req, res) => {
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
    }
    const accessToken = signAccessToken({ userId: user.id, role: user.role });
    res.status(201).json({ accessToken, user });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ error: "Phone or email is already registered" });
    res.status(500).json({ error: "Unable to create account" });
  }
});

const loginSchema = z.object({
  phone: z.string().trim().min(7).max(30),
  password: z.string().min(8).max(128)
});

router.post("/login", async (req, res) => {
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
  res.json({
    accessToken,
    user: { id: user.id, role: user.role, full_name: user.full_name, phone: user.phone, email: user.email }
  });
});

router.post("/dev-token", (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).end();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json({ accessToken: signAccessToken(parsed.data), user: parsed.data });
});

export default router;
