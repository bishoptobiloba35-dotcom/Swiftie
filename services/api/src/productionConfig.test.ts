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
    process.env.CORS_ORIGINS = "https://app.example.com,https://admin.example.com";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.SUPABASE_STORAGE_BUCKET = "swiftdrop-private";
    process.env.DRIVER_PAYOUT_PERCENT = "90";
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
    delete process.env.CORS_ORIGINS;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_STORAGE_BUCKET;
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
    process.env.CORS_ORIGINS = "https://app.example.com";
    process.env.OBJECT_STORAGE_BUCKET = "swiftdrop";
    process.env.OBJECT_STORAGE_REGION = "eu-west-1";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
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
    process.env.CORS_ORIGINS = "http://app.example.com";
    process.env.OBJECT_STORAGE_BUCKET = "swiftdrop";
    process.env.OBJECT_STORAGE_REGION = "eu-west-1";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
    assert.throws(() => validateProductionConfig(), /CORS_ORIGINS must contain one or more HTTPS origins/);
  } finally {
    restoreEnv();
  }
});

