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
