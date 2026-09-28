import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateProductionConfig } from "./productionConfig.js";

const productionEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://example",
  JWT_SECRET: "a-production-secret",
  PAYSTACK_SECRET_KEY: "sk_live_example",
  CORS_ORIGINS: "https://app.example.com,https://admin.example.com",
  OBJECT_STORAGE_BUCKET: "swiftdrop-private",
  OBJECT_STORAGE_REGION: "eu-west-1",
  OBJECT_STORAGE_ACCESS_KEY_ID: "access-key",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret-key",
  DRIVER_PAYOUT_PERCENT: "90"
} as const;

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { fn(); } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("production configuration", () => {
  it("accepts a complete production configuration", () => {
    withEnv(productionEnv, () => assert.doesNotThrow(() => validateProductionConfig()));
  });

  it("rejects missing required production configuration", () => {
    withEnv({ ...productionEnv, PAYSTACK_SECRET_KEY: undefined }, () => {
      assert.throws(() => validateProductionConfig(), /PAYSTACK_SECRET_KEY/);
    });
  });

  it("rejects the development JWT fallback", () => {
    withEnv({ ...productionEnv, JWT_SECRET: "development-only-change-me" }, () => {
      assert.throws(() => validateProductionConfig(), /JWT_SECRET/);
    });
  });

  it("rejects insecure production origins and storage endpoints", () => {
    withEnv({ ...productionEnv, CORS_ORIGINS: "http://app.example.com" }, () => {
      assert.throws(() => validateProductionConfig(), /CORS_ORIGINS/);
    });
    withEnv({ ...productionEnv, OBJECT_STORAGE_ENDPOINT: "http://storage.example.com" }, () => {
      assert.throws(() => validateProductionConfig(), /OBJECT_STORAGE_ENDPOINT/);
    });
  });

  it("rejects invalid driver payout percentages", () => {
    withEnv({ ...productionEnv, DRIVER_PAYOUT_PERCENT: "101" }, () => {
      assert.throws(() => validateProductionConfig(), /DRIVER_PAYOUT_PERCENT/);
    });
  });
});
