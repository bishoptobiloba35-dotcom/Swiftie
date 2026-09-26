export type UserRole = "CUSTOMER" | "DRIVER" | "ADMIN";

export type DeliveryStatus =
  | "CREATED"
  | "PAYMENT_AUTHORIZED"
  | "DRIVER_ASSIGNED"
  | "DRIVER_AT_PICKUP"
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "ARRIVED"
  | "DELIVERED"
  | "CANCELLED"
  | "DISPUTED";

export interface GeoPoint {
  latitude: number;
  longitude: number;
  recordedAt: string;
}

export interface Address {
  label: string;
  formattedAddress: string;
  location: GeoPoint;
}

export interface DeliveryQuote {
  currency: string;
  distanceMeters: number;
  durationSeconds: number;
  baseFareMinor: number;
  distanceFareMinor: number;
  serviceFeeMinor: number;
  totalMinor: number;
}

export interface Delivery {
  id: string;
  trackingCode: string;
  senderId: string;
  receiverName: string;
  receiverPhone: string;
  pickup: Address;
  dropoff: Address;
  quote: DeliveryQuote;
  status: DeliveryStatus;
  driverId?: string;
  pickupPhotoUrl?: string;
  receiverPinRequired: boolean;
  createdAt: string;
  updatedAt: string;
}
