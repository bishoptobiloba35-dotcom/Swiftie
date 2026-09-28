const requiredProductionEnv = [
  "DATABASE_URL",
  "JWT_SECRET",
  "PAYSTACK_SECRET_KEY",
  "CORS_ORIGINS",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY"
] as const;

export function validateProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  const missing = requiredProductionEnv.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }

  if (process.env.JWT_SECRET === "development-only-change-me") {
    throw new Error("JWT_SECRET must not use the development fallback in production");
  }

  const objectEndpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim();
  if (objectEndpoint && !/^https:\/\//i.test(objectEndpoint)) {
    throw new Error("OBJECT_STORAGE_ENDPOINT must use HTTPS in production");
  }

  const origins = process.env.CORS_ORIGINS!
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0 || origins.some((origin) => !/^https:\/\//i.test(origin))) {
    throw new Error("CORS_ORIGINS must contain one or more HTTPS origins in production");
  }

  const payoutPercent = Number(process.env.DRIVER_PAYOUT_PERCENT ?? "90");
  if (!Number.isFinite(payoutPercent) || payoutPercent <= 0 || payoutPercent > 100) {
    throw new Error("DRIVER_PAYOUT_PERCENT must be a number greater than 0 and at most 100");
  }
}
