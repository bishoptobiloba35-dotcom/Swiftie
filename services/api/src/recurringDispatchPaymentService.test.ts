import test from "node:test";
import assert from "node:assert/strict";
import { recurringPaymentReference } from "./recurringDispatchPaymentService.js";

test("recurring Paystack references use only supported characters", () => {
  const reference = recurringPaymentReference("11111111-2222-3333-4444-555555555555","aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(reference, "sd-recurring-11111111222233334444555555555555-aaaaaaaabbbbccccddddeeeeeeeeeeee");
  assert.match(reference, /^[A-Za-z0-9.=\-]+$/);
});

test("recurring references are deterministic by plan, order and attempt", () => {
  const first = recurringPaymentReference("plan-id","order-id",1);
  const retry = recurringPaymentReference("plan-id","order-id",2);
  assert.equal(first, recurringPaymentReference("plan-id","order-id",1));
  assert.notEqual(first, retry);
  assert.equal(retry, "sd-recurring-planid-orderid-r2");
});

test("successful Paystack response requires exact amount and currency", async () => {
  const { evaluateRecurringChargeResponse } = await import("./recurringDispatchPaymentService.js");
  assert.deepEqual(evaluateRecurringChargeResponse(true, { status: true, data: { status: "success", amount: 150000, currency: "NGN", reference: "pay_ref" } }, "fallback", 150000, "ngn"), { kind: "SUCCESS", providerReference: "pay_ref" });
  assert.equal(evaluateRecurringChargeResponse(true, { status: true, data: { status: "success", amount: 149999, currency: "NGN" } }, "fallback", 150000, "NGN").kind, "TERMINAL_FAILURE");
});

test("authorization challenge is waiting and preserves recovery data", async () => {
  const { evaluateRecurringChargeResponse } = await import("./recurringDispatchPaymentService.js");
  assert.deepEqual(evaluateRecurringChargeResponse(true, { status: true, data: { status: "pending", paused: true, authorization_url: "https://example.test/auth", access_code: "access" } }, "fallback", 100, "NGN"), { kind: "CHALLENGE", authorizationUrl: "https://example.test/auth", accessCode: "access" });
});

test("terminal and pending provider states are classified without charging decisions", async () => {
  const { evaluateRecurringChargeResponse } = await import("./recurringDispatchPaymentService.js");
  assert.deepEqual(evaluateRecurringChargeResponse(true, { status: false, data: { status: "failed" } }, "fallback", 100, "NGN"), { kind: "TERMINAL_FAILURE", providerStatus: "failed" });
  assert.deepEqual(evaluateRecurringChargeResponse(true, { status: true, data: { status: "pending" } }, "fallback", 100, "NGN"), { kind: "WAITING", providerStatus: "pending" });
});
