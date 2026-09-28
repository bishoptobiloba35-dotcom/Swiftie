import test from "node:test";
import assert from "node:assert/strict";
import { validateLocationEvent } from "./tracking.js";

test("accepts an assigned driver location during transit", () => {
  assert.equal(validateLocationEvent({
    deliveryId: "delivery-1",
    driverId: "driver-1",
    latitude: 6.5244,
    longitude: 3.3792,
    accuracyMeters: 25,
    recordedAt: new Date().toISOString()
  }, "driver-1", "IN_TRANSIT"), null);
});

test("rejects location from an unassigned driver", () => {
  assert.equal(validateLocationEvent({
    deliveryId: "delivery-1",
    driverId: "attacker",
    latitude: 6.5244,
    longitude: 3.3792,
    recordedAt: new Date().toISOString()
  }, "driver-1", "IN_TRANSIT"), "Driver is not assigned to this delivery");
});

test("rejects impossible coordinates and excessive accuracy", () => {
  assert.equal(validateLocationEvent({
    deliveryId: "delivery-1",
    driverId: "driver-1",
    latitude: 91,
    longitude: 3,
    recordedAt: new Date().toISOString()
  }, "driver-1", "IN_TRANSIT"), "Invalid latitude");

  assert.equal(validateLocationEvent({
    deliveryId: "delivery-1",
    driverId: "driver-1",
    latitude: 6,
    longitude: 3,
    accuracyMeters: 2001,
    recordedAt: new Date().toISOString()
  }, "driver-1", "IN_TRANSIT"), "Location accuracy is outside the accepted range");
});
