export type PaymentStatus = "PENDING" | "AUTHORIZED" | "HELD" | "RELEASED" | "REFUNDED" | "FAILED";

const PAYMENT_SOURCES: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ["PENDING"],
  AUTHORIZED: ["PENDING", "AUTHORIZED"],
  HELD: ["PENDING", "AUTHORIZED", "HELD"],
  RELEASED: ["HELD", "RELEASED"],
  REFUNDED: ["PENDING", "AUTHORIZED", "HELD", "RELEASED", "REFUNDED"],
  FAILED: ["PENDING", "AUTHORIZED", "FAILED"]
};

export function allowedPaymentSources(status: PaymentStatus): readonly PaymentStatus[] {
  return PAYMENT_SOURCES[status];
}

export function canTransitionPaymentStatus(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_SOURCES[to].includes(from);
}
