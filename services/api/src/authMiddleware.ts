import type { NextFunction, Request, Response } from "express";
import { bearerToken, verifyAccessToken, type AuthRole } from "./auth.js";

export function requireAuth(...roles: AuthRole[]) {
  return (req: Request & { user?: { userId: string; role: AuthRole } }, res: Response, next: NextFunction) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ error: "Authentication required" });
    try {
      const user = verifyAccessToken(token);
      if (roles.length > 0 && !roles.includes(user.role)) return res.status(403).json({ error: "Insufficient permissions" });
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired access token" });
    }
  };
}
