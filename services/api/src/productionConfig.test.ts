import test from "node:test";
import assert from "node:assert/strict";
import { validateProductionConfig } from "./productionConfig.js";

const original = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("production config accepts complete secure configuration", () => {
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.JWT_SECRET = "a-long-production-secret";
    process.env.PAYSTACK_SECRET_KEY = "sk_live_example";
    process.env.PAYSTACK_PUBLIC_KEY = "pk_live_example";
    process.env.SMS_PROVIDER_API_KEY = "sms-provider-example";
    process.env.PIN_HMAC_SECRET = "pin-hmac-secret-example";
    process.env.CORS_ORIGINS = "https://app.example.com,https://admin.example.com";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.SUPABASE_STORAGE_BUCKET = "swiftdrop-private";
    process.env.ESCROW_MODE = "live";
    process.env.DRIVER_PAYOUT_PERCENT = "75";
    assert.doesNotThrow(() => validateProductionConfig());
  } finally {
    restoreEnv();
  }
});

test("production config rejects missing required secrets", () => {
  try {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_PUBLIC_KEY;
    delete process.env.SMS_PROVIDER_API_KEY;
    delete process.env.PIN_HMAC_SECRET;
    delete process.env.CORS_ORIGINS;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_STORAGE_BUCKET;
    delete process.env.ESCROW_MODE;
    assert.throws(() => validateProductionConfig(), /Missing required production environment variables/);
  } finally {
    restoreEnv();
  }
});

test("production config rejects insecure JWT fallback", () => {
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.JWT_SECRET = "development-only-change-me";
    process.env.PAYSTACK_SECRET_KEY = "sk_live_example";
    process.env.PAYSTACK_PUBLIC_KEY = "pk_live_example";
    process.env.SMS_PROVIDER_API_KEY = "sms-provider-example";
    process.env.PIN_HMAC_SECRET = "pin-hmac-secret-example";
    process.env.CORS_ORIGINS = "https://app.example.com";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.SUPABASE_STORAGE_BUCKET = "swiftdrop-private";
    process.env.ESCROW_MODE = "live";
    assert.throws(() => validateProductionConfig(), /JWT_SECRET must not use the development fallback/);
  } finally {
    restoreEnv();
  }
});

test("production config requires HTTPS CORS origins", () => {
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.JWT_SECRET = "a-long-production-secret";
    process.env.PAYSTACK_SECRET_KEY = "sk_live_example";
    process.env.PAYSTACK_PUBLIC_KEY = "pk_live_example";
    process.env.SMS_PROVIDER_API_KEY = "sms-provider-example";
    process.env.PIN_HMAC_SECRET = "pin-hmac-secret-example";
    process.env.CORS_ORIGINS = "http://app.example.com";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.SUPABASE_STORAGE_BUCKET = "swiftdrop-private";
    process.env.ESCROW_MODE = "live";
    assert.throws(() => validateProductionConfig(), /CORS_ORIGINS must contain one or more HTTPS origins/);
  } finally {
    restoreEnv();
  }
});



test("production config rejects mock escrow mode", () => {
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.JWT_SECRET = "a-long-production-secret";
    process.env.PAYSTACK_SECRET_KEY = "sk_live_example";
    process.env.PAYSTACK_PUBLIC_KEY = "pk_live_example";
    process.env.SMS_PROVIDER_API_KEY = "sms-provider-example";
    process.env.PIN_HMAC_SECRET = "pin-hmac-secret-example";
    process.env.CORS_ORIGINS = "https://app.example.com";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.SUPABASE_STORAGE_BUCKET = "swiftdrop-private";
    process.env.ESCROW_MODE = "mock";
    assert.throws(() => validateProductionConfig(), /ESCROW_MODE must be live/);
  } finally {
    restoreEnv();
  }
});

test("production config rejects Paystack test secret keys", () => {
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.JWT_SECRET = "a-long-production-secret";
    process.env.PAYSTACK_SECRET_KEY = "sk_test_not-for-production";
    process.env.PAYSTACK_PUBLIC_KEY = "pk_live_example";
    process.env.SMS_PROVIDER_API_KEY = "sms-provider-example";
    process.env.PIN_HMAC_SECRET = "pin-hmac-secret-example";
    process.env.CORS_ORIGINS = "https://app.example.com";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.SUPABASE_STORAGE_BUCKET = "swiftdrop-private";
    process.env.ESCROW_MODE = "live";
    assert.throws(() => validateProductionConfig(), /PAYSTACK_SECRET_KEY must be a live Paystack secret key/);
  } finally {
    restoreEnv();
  }
});


test("production config refuses mock escrow with the required startup error", () => {
  try {
    process.env.NODE_ENV = "production";
    process.env.ESCROW_MODE = "mock";
    assert.throws(
      () => validateProductionConfig(),
      (error: unknown) => error instanceof Error && error.message === "Refusing to start: mock escrow in production"
    );
  } finally {
    restoreEnv();
  }
});

test("production config reports the complete missing variable list", () => {
  try {
    process.env.NODE_ENV = "production";
    for (const name of [
      "DATABASE_URL", "JWT_SECRET", "PAYSTACK_SECRET_KEY", "PAYSTACK_PUBLIC_KEY",
      "SMS_PROVIDER_API_KEY", "PIN_HMAC_SECRET", "CORS_ORIGINS", "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET", "ESCROW_MODE"
    ]) delete process.env[name];
    assert.throws(
      () => validateProductionConfig(),
      (error: unknown) => error instanceof Error &&
        error.message.includes("PAYSTACK_PUBLIC_KEY") &&
        error.message.includes("SMS_PROVIDER_API_KEY") &&
        error.message.includes("PIN_HMAC_SECRET")
    );
  } finally {
    restoreEnv();
  }
});
