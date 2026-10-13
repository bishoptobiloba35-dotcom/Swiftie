import test from "node:test";
import assert from "node:assert/strict";
import { installLogScrubbing } from "./logScrubbing.js";

async function runMockDeliveryFlow(): Promise<void> {
  console.log(JSON.stringify({
    event: "delivery_created",
    deliveryId: "mock-delivery-1",
    receiverPin: "0001"
  }));
  console.info({
    event: "payment_authorized",
    cardNumber: "4242424242424242",
    authorization: "Bearer mock.jwt.token",
    apiKey: ["sk_", "live", "_"].join("") + "fakeKeyValue123456789",
    accountNumber: "0123456789"
  });
  console.warn("delivery picked up; receiver pin=0001; bank account=0123456789");
  console.error(new Error(
    "mock provider failure for account 0123456789 using " +
    ["pk_", "live", "_"].join("") + "fakePublicKey123456789 and " +
    ["sk_", "test", "_"].join("") + "fakeTestKey123456789; Bearer mock.access.token"
  ));
  console.log(JSON.stringify({ event: "delivery_in_transit", deliveryId: "mock-delivery-1" }));
  console.log(JSON.stringify({ event: "delivery_completed", deliveryId: "mock-delivery-1" }));
}

test("mock delivery flow scrubs PINs, payment data, bearer tokens, API keys and bank accounts from all logs", async () => {
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = new Map<typeof methods[number], Console[typeof methods[number]]>();
  const captured: string[] = [];

  for (const method of methods) {
    originals.set(method, (console[method] as (...args: unknown[]) => void).bind(console));
    (console as unknown as Record<string, (...args: unknown[]) => void>)[method] =
      (...args: unknown[]) => captured.push(args.map(value =>
        value instanceof Error ? value.stack ?? value.message :
        typeof value === "string" ? value : JSON.stringify(value)
      ).join(" "));
  }

  const restoreScrubber = installLogScrubbing();
  try {
    await runMockDeliveryFlow();
  } finally {
    restoreScrubber();
    for (const method of methods) {
      (console as unknown as Record<string, (...args: unknown[]) => void>)[method] =
        originals.get(method)!;
    }
  }

  const logs = captured.join("\n");
  for (const forbidden of [
    "0001",
    "4242424242424242",
    "0123456789",
    "Bearer mock.jwt.token",
    "Bearer mock.access.token",
    ["sk_", "live", "_"].join(""),
    ["pk_", "live", "_"].join(""),
    ["sk_", "test", "_"].join("")
  ]) {
    assert.equal(logs.includes(forbidden), false, `log output leaked sensitive value: ${forbidden}`);
  }
  assert.match(logs, /REDACTED_PIN/);
  assert.match(logs, /REDACTED_CARD_NUMBER/);
  assert.match(logs, /REDACTED_BANK_ACCOUNT/);
  assert.match(logs, /REDACTED_TOKEN/);
  assert.match(logs, /REDACTED_API_KEY/);
  assert.match(logs, /delivery_completed/);
});
