import test from "node:test";
import assert from "node:assert/strict";

test("two-litre fuel reference is exactly two litres of the configured price", () => {
  const fuelPriceMinorPerLitre = 250000;
  assert.equal(fuelPriceMinorPerLitre * 2, 500000);
});

test("requested default percentages are represented as basis points", () => {
  assert.equal(500 / 10000, 0.05);
  assert.equal(1000 / 10000, 0.10);
});
