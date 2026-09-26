import type { LocationEvent } from "./tracking.js";

export type LatestLocation = LocationEvent;

const latestByDelivery = new Map<string, LatestLocation>();

export function recordLocation(event: LocationEvent): LatestLocation {
  latestByDelivery.set(event.deliveryId, event);
  return event;
}

export function getLatestLocation(deliveryId: string): LatestLocation | null {
  return latestByDelivery.get(deliveryId) ?? null;
}
