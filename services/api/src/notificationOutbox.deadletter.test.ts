import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffSeconds, notificationAttemptOutcome } from "./notificationOutbox.js";

describe("notification dead-letter policy", () => {
  it("marks a retryable failure as permanently failed at the retry ceiling", () => {
    assert.deepEqual(
      notificationAttemptOutcome({ attempts: 8, retry: true }),
      { state: "FAILED", error: "Notification delivery retry limit exhausted" }
    );
  });

  it("preserves exponential retry before the ceiling", () => {
    const decision = notificationAttemptOutcome({ attempts: 7, retry: true });
    assert.equal(decision.state, "RETRY");
    assert.equal(decision.delaySeconds, backoffSeconds(7));
    assert.equal(decision.error, "Expo reported one or more push delivery errors");
  });

  it("preserves the original provider error when the final attempt fails", () => {
    assert.deepEqual(
      notificationAttemptOutcome({ attempts: 8, retry: true, error: "Expo unavailable" }),
      { state: "FAILED", error: "Expo unavailable" }
    );
  });

  it("marks successful delivery as sent without scheduling another attempt", () => {
    assert.deepEqual(notificationAttemptOutcome({ attempts: 8, retry: false }), { state: "SENT" });
  });
});
