export type DeliveryStatus =
  | "CREATED"
  | "PAYMENT_AUTHORIZED"
  | "PAYMENT_PENDING"           // generic pending (sender or receiver)
  | "DRIVER_ASSIGNED"
  | "DRIVER_AT_PICKUP"
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "ARRIVED"
  | "RECEIVER_PAYMENT_PENDING"  // digital POD only — receiver must pay in-app
  | "PAYMENT_VERIFIED"          // set exclusively by verified webhook
  | "HANDED_OVER"
  | "PIN_CONFIRMED"
  | "DELIVERED"
  | "DISPUTE_WINDOW"
  | "RELEASED"
  | "CANCELLED"
  | "DISPUTED"
  | "RETURNED";

/**
 * Legal transitions for the core trust loop.
 * PAY_ON_DELIVERY path inserts RECEIVER_PAYMENT_PENDING → PAYMENT_VERIFIED
 * between ARRIVED and HANDED_OVER. SENDER_ESCROW / RECEIVER_ESCROW skip those.
 */
const transitions: Record<DeliveryStatus, DeliveryStatus[]> = {
  CREATED: ["PAYMENT_AUTHORIZED", "PAYMENT_PENDING", "DRIVER_ASSIGNED", "CANCELLED"],
  PAYMENT_AUTHORIZED: ["DRIVER_ASSIGNED", "CANCELLED"],
  PAYMENT_PENDING: ["PAYMENT_AUTHORIZED", "CANCELLED"],
  DRIVER_ASSIGNED: ["DRIVER_AT_PICKUP", "CANCELLED"],
  DRIVER_AT_PICKUP: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["IN_TRANSIT", "DISPUTED"],
  IN_TRANSIT: ["ARRIVED", "DISPUTED", "RETURNED"],
  ARRIVED: [
    "DELIVERED",                 // legacy / non-POD path
    "RECEIVER_PAYMENT_PENDING",  // digital POD
    "HANDED_OVER",
    "DISPUTED"
  ],
  RECEIVER_PAYMENT_PENDING: ["PAYMENT_VERIFIED", "CANCELLED", "DISPUTED"],
  PAYMENT_VERIFIED: ["HANDED_OVER", "DISPUTED"],
  HANDED_OVER: ["PIN_CONFIRMED", "DISPUTED"],
  PIN_CONFIRMED: ["DELIVERED", "DISPUTE_WINDOW"],
  DELIVERED: ["DISPUTE_WINDOW", "RELEASED"],
  DISPUTE_WINDOW: ["RELEASED", "DISPUTED"],
  RELEASED: [],
  CANCELLED: [],
  DISPUTED: [],
  RETURNED: []
};

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid delivery transition: ${from} -> ${to}`);
  }
}

/**
 * Returns true when the order is on the digital POD path and is currently
 * waiting for the receiver to complete in-app payment.
 */
export function isAwaitingReceiverPayment(status: DeliveryStatus): boolean {
  return status === "RECEIVER_PAYMENT_PENDING";
}

/**
 * Returns true when payment has been server-verified (webhook) and the
 * physical hand-over / PIN steps may proceed.
 */
export function isPaymentVerified(status: DeliveryStatus): boolean {
  return (
    status === "PAYMENT_VERIFIED" ||
    status === "HANDED_OVER" ||
    status === "PIN_CONFIRMED" ||
    status === "DELIVERED" ||
    status === "DISPUTE_WINDOW" ||
    status === "RELEASED"
  );
}
