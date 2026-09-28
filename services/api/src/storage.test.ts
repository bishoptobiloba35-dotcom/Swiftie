import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeStorageKey } from "./storage.js";

describe("private storage key validation", () => {
  it("accepts generated relative object keys", () => {
    assert.equal(safeStorageKey("pickups/delivery/photo.jpg"), "pickups/delivery/photo.jpg");
  });

  it("rejects traversal and absolute keys", () => {
    assert.throws(() => safeStorageKey("../secret.txt"));
    assert.throws(() => safeStorageKey("pickups/../secret.txt"));
    assert.throws(() => safeStorageKey("/etc/passwd"));
  });
});
