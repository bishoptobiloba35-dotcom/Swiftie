const requiredProductionEnv = [
  "DATABASE_URL",
  "JWT_SECRET",
  "PAYSTACK_SECRET_KEY",
  "CORS_ORIGINS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_STORAGE_BUCKET",
  "ESCROW_MODE"
] as const;

export function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  const missing = requiredProductionEnv.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }

  if (process.env.ESCROW_MODE !== "live") {
    throw new Error("ESCROW_MODE must be live in production; mock escrow is never permitted in production");
  }

  if (process.env.JWT_SECRET === "development-only-change-me") {
    throw new Error("JWT_SECRET must not use the development fallback in production");
  }


  const origins = process.env.CORS_ORIGINS!
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0 || origins.some((origin) => !/^https:\/\//i.test(origin))) {
    throw new Error("CORS_ORIGINS must contain one or more HTTPS origins in production");
  }

  const payoutPercent = Number(process.env.DRIVER_PAYOUT_PERCENT ?? "75");
  if (!Number.isFinite(payoutPercent) || payoutPercent <= 0 || payoutPercent > 100) {
    throw new Error("DRIVER_PAYOUT_PERCENT must be a number greater than 0 and at most 100");
  }
}
