import test from "node:test";
import assert from "node:assert/strict";
import { isSafeInformationalSupportRequest, unsafeSupportRequestPattern } from "./supportAiPolicy.js";

function classifySupportRequest(subject: string, message: string): "AUTO_RESOLVED" | "ESCALATED" {
  const text = subject + " " + message;
  if (unsafeSupportRequestPattern.test(text)) return "ESCALATED";
  if (isSafeInformationalSupportRequest(subject, message)) return "AUTO_RESOLVED";
  return "ESCALATED";
}

test("support AI safety: informational tracking request can auto-resolve", () => {
  assert.equal(classifySupportRequest("Where is my order?", "Please tell me the tracking status"), "AUTO_RESOLVED");
});

test("support AI safety: payment/refund requests always escalate", () => {
  assert.equal(classifySupportRequest("Refund", "I want my payment returned"), "ESCALATED");
  assert.equal(classifySupportRequest("Payment issue", "Paystack charged me"), "ESCALATED");
});

test("support AI safety: cancellation always escalates", () => {
  assert.equal(classifySupportRequest("Cancel my order", "Please cancel it"), "ESCALATED");
});

test("support AI safety: unknown requests escalate", () => {
  assert.equal(classifySupportRequest("Something unusual", "I need help with a special request"), "ESCALATED");
  assert.equal(classifySupportRequest("Status", "I need help with a special request"), "ESCALATED");
});

test("support AI safety: linked orders do not bypass intent classification", () => {
  assert.equal(isSafeInformationalSupportRequest("Where is my delivery?", "Please show the tracking status"), true);
  assert.equal(isSafeInformationalSupportRequest("Order issue", "I have a special request for the driver"), false);
  assert.equal(isSafeInformationalSupportRequest("Help", "Can you make an exception for me?"), false);
});
