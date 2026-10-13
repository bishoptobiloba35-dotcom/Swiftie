import test from "node:test";
import assert from "node:assert/strict";
import { generateReceiverPin, hashPin, verifyPin } from "./security.js";

test("receiver PIN generation always returns exactly four ASCII digits", () => {
  for (let i = 0; i < 10_000; i++) {
    assert.match(generateReceiverPin(), /^\d{4}$/);
  }
});

test("receiver PIN generation preserves leading zeroes", () => {
  const pin = generateReceiverPin();
  assert.equal(pin.length, 4);
  assert.match(pin, /^\d{4}$/);
});

test("PIN hashes store derived values rather than plaintext", () => {
  const pin = "0042";
  const stored = hashPin(pin);
  assert.notEqual(stored, pin);
  assert.ok(stored.includes(":"));
  assert.equal(verifyPin(pin, stored), true);
});

test("hashPin refuses non-four-digit values before deriving a hash", () => {
  for (const pin of ["123", "12345", "123456", "12a4", "", " 123"]) {
    assert.throws(() => hashPin(pin), /exactly four digits/);
  }
});

test("verifyPin rejects non-four-digit values before deriving a hash", () => {
  const stored = hashPin("1234");
  for (const pin of ["123", "12345", "123456", "12a4", "", " 1234"]) {
    assert.equal(verifyPin(pin, stored), false, `should reject ${JSON.stringify(pin)}`);
  }
  assert.equal(verifyPin("1234", stored), true);
});
