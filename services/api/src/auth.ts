import { createHmac, timingSafeEqual } from "node:crypto";

export type AuthRole = "CUSTOMER" | "DRIVER" | "ADMIN";
export type AuthUser = { userId: string; role: AuthRole };

const secret = () => process.env.JWT_SECRET || "development-only-change-me";

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function signAccessToken(user: AuthUser, expiresInSeconds = 7 * 24 * 60 * 60): string {
  const payload = encode(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + expiresInSeconds }));
  const body = encode("swiftdrop.v1") + "." + payload;
  return body + "." + sign(body);
}

export function verifyAccessToken(token: string): AuthUser {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("Invalid access token");
  const body = header + "." + payload;
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid access token");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { userId?: string; role?: string; exp?: number };
  if (!decoded.userId || !decoded.role || !["CUSTOMER", "DRIVER", "ADMIN"].includes(decoded.role)) throw new Error("Invalid access token");
  if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) throw new Error("Access token expired");
  return { userId: decoded.userId, role: decoded.role as AuthRole };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}
