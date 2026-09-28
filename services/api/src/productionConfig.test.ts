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
    assert.throws(() => validateProductionConfig(), /CORS_ORIGINS must contain one or more HTTPS origins/);
  } finally {
    restoreEnv();
  }
});

test("production config validates payout percentage", () => {
  try {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://example";
    process.env.JWT_SECRET = "a-long-production-secret";
    process.env.PAYSTACK_SECRET_KEY = "sk_live_example";
    process.env.CORS_ORIGINS = "https://app.example.com";
    process.env.DRIVER_PAYOUT_PERCENT = "101";
    assert.throws(() => validateProductionConfig(), /DRIVER_PAYOUT_PERCENT/);
  } finally {
    restoreEnv();
  }
});
