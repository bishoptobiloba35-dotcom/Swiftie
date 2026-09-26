import type { Request } from "express";
import type { AuthRole } from "./auth.js";

type UserRequest = Request & { user?: { userId: string; role: AuthRole } };

export function identity(req: UserRequest, fallbackId?: string): string {
  if (req.user?.userId) return req.user.userId;
  if (process.env.NODE_ENV !== "production" && fallbackId) return fallbackId;
  throw new Error("Authenticated identity required");
}

export function role(req: UserRequest, role: AuthRole): boolean {
  return req.user?.role === role;
}
