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
  | "DISPUTED"
  | "RETURNED";

const transitions: Record<DeliveryStatus, DeliveryStatus[]> = {
  CREATED: ["PAYMENT_AUTHORIZED", "CANCELLED"],
  PAYMENT_AUTHORIZED: ["DRIVER_ASSIGNED", "CANCELLED"],
  DRIVER_ASSIGNED: ["DRIVER_AT_PICKUP", "CANCELLED"],
  DRIVER_AT_PICKUP: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["IN_TRANSIT", "DISPUTED"],
  IN_TRANSIT: ["ARRIVED", "DISPUTED", "RETURNED"],
  ARRIVED: ["DELIVERED", "DISPUTED"],
  DELIVERED: [],
  CANCELLED: [],
  DISPUTED: [],
  RETURNED: []
};

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid delivery transition: ${from} -> ${to}`);
  }
}
