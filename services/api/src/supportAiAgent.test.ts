import test from "node:test";
import assert from "node:assert/strict";
import { isSafeInformationalSupportRequest } from "./supportAiAgent.js";

function classifySupportRequest(subject: string, message: string): "AUTO_RESOLVED" | "ESCALATED" {
  return isSafeInformationalSupportRequest(subject, message) ? "AUTO_RESOLVED" : "ESCALATED";
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
});

test("support AI safety: generic app guidance remains informational", () => {
  assert.equal(classifySupportRequest("App help", "How do I use the app?"), "AUTO_RESOLVED");
});

test("support AI safety: linked-order context alone cannot auto-resolve an unknown request", () => {
  assert.equal(classifySupportRequest("Something unusual", "I need help with a special request"), "ESCALATED");
});
