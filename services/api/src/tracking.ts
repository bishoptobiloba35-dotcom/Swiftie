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
  if (!Number.isFinite(event.latitude) || event.latitude < -90 || event.latitude > 90) return "Invalid latitude";
  if (!Number.isFinite(event.longitude) || event.longitude < -180 || event.longitude > 180) return "Invalid longitude";
  if (event.accuracyMeters != null && (!Number.isFinite(event.accuracyMeters) || event.accuracyMeters < 0 || event.accuracyMeters > 2000)) return "Location accuracy is outside the accepted range";
  return null;
}
