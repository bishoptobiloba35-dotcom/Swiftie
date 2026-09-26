export type LocationEvent = {
  deliveryId: string;
  driverId: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  recordedAt: string;
};

export function validateLocationEvent(
  event: LocationEvent,
  assignedDriverId: string,
  deliveryStatus: string
): string | null {
  if (event.driverId !== assignedDriverId) return "Driver is not assigned to this delivery";
  if (!["PICKED_UP", "IN_TRANSIT", "ARRIVED"].includes(deliveryStatus)) {
    return "Location updates are only accepted after pickup";
  }
  if (event.latitude < -90 || event.latitude > 90) return "Invalid latitude";
  if (event.longitude < -180 || event.longitude > 180) return "Invalid longitude";
  return null;
}
