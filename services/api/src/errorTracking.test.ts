import test from "node:test";
import assert from "node:assert/strict";
import { buildExternalErrorEvent } from "./errorTracking.js";

test("external error event contains only safe operational fields", () => {
  const event = buildExternalErrorEvent({
    requestId: "req-123",
    method: "POST",
    path: "/api/deliveries/123",
    status: 500,
    error: new Error("database unavailable")
  });
  assert.equal(event.event, "swiftdrop.api.error");
  assert.equal(event.requestId, "req-123");
  assert.equal(event.status, 500);
  assert.equal(event.message, "database unavailable");
  assert.equal("body" in event, false);
  assert.equal("authorization" in event, false);
});

test("external error event truncates unusually long messages", () => {
  const event = buildExternalErrorEvent({
    method: "GET",
    path: "/health",
    status: 500,
    error: new Error("x".repeat(5000))
  });
  assert.equal(event.message.length, 1000);
});
