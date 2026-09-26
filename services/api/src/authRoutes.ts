import { Router } from "express";
import { z } from "zod";
import { signAccessToken } from "./auth.js";

const router = Router();
const schema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["CUSTOMER", "DRIVER", "ADMIN"])
});

router.post("/dev-token", (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).end();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json({ accessToken: signAccessToken(parsed.data), user: parsed.data });
});

export default router;
