import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backoffSeconds } from "./notificationOutbox.js";

describe("notification retry backoff", () => {
  it("starts at five seconds and grows exponentially", () => {
    assert.equal(backoffSeconds(1), 5);
    assert.equal(backoffSeconds(2), 10);
    assert.equal(backoffSeconds(3), 20);
  });

  it("caps retries at fifteen minutes", () => {
    assert.equal(backoffSeconds(99), 900);
  });
});
