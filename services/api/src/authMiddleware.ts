import type { NextFunction, Request, Response } from "express";
import { bearerToken, verifyAccessToken, type AuthRole } from "./auth.js";
import { pool } from "./database/db.js";

type AuthenticatedRequest = Request & { user?: { userId: string; role: AuthRole } };

export function requireAuth(...roles: AuthRole[]) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ error: "Authentication required" });

    try {
      const tokenUser = verifyAccessToken(token);

      // Access tokens are intentionally short-lived, but role/status changes must
      // take effect immediately. Never trust a stale role claim for authorization.
      if (pool) {
        const result = await pool.query(
          `SELECT u.role,
                  CASE
                    WHEN u.role='DRIVER' THEN d.status
                    WHEN u.role='AGENT' THEN a.status
                    ELSE NULL
                  END AS account_status
             FROM users u
             LEFT JOIN drivers d ON d.user_id=u.id
             LEFT JOIN agent_profiles a ON a.user_id=u.id
            WHERE u.id=$1`,
          [tokenUser.userId]
        );

        const current = result.rows[0];
        if (!current) return res.status(401).json({ error: "Account no longer exists" });

        const currentRole = current.role as AuthRole;
        if (currentRole !== tokenUser.role) {
          return res.status(401).json({ error: "Authentication state changed. Please sign in again." });
        }

        if (current.account_status === "SUSPENDED") {
          return res.status(403).json({ error: "Account is suspended" });
        }

        if (roles.length > 0 && !roles.includes(currentRole)) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }

        req.user = { userId: tokenUser.userId, role: currentRole };
      } else {
        // Development mode can operate without a database; production startup
        // requires DATABASE_URL, so this fallback cannot be used for production.
        if (roles.length > 0 && !roles.includes(tokenUser.role)) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }
        req.user = tokenUser;
      }

      return next();
    } catch (error) {
      // Database failures must not silently degrade into token-only authorization.
      if (pool && error instanceof Error && !/Invalid|expired|access token/i.test(error.message)) {
        return res.status(503).json({ error: "Authorization service is temporarily unavailable" });
      }
      return res.status(401).json({ error: "Invalid or expired access token" });
    }
  };
}
