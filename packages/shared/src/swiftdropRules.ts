export const SWIFTDROP_RULES = {
  errandGoodsCapMinor: 5_000_000,
  errandMinimumFeeMinor: 30_000,
  errandPlatformCommissionBps: 1_500,
  courierRemittanceHours: 24,
  podReturnFeeBps: 5_000,
  agentDispatchSlaHours: 2,
  escrowDisputeWindowHours: 2,
  pinAutoEscalationHours: 48,
  baseFareMinor: 50_000,
  distanceFareMinorPerKm: 15_000,
  serviceChargeBps: 500,
  protectionReserveBps: 1_000,
  xpressSurchargeBps: 2_000,
  errandDoorstepFeeMinor: 80_000,
  insurancePremiumMinor: 50_000,
  insuranceCoverageMinor: 10_000_000,
  sessionTimeoutDays: 30,
  newUserTrustScore: 50,
  trustRetrainingThreshold: 70,
  trustSuspensionThreshold: 50,
  agentSlaTrustThreshold: 60,
  merchantVisibilityTrustThreshold: 70,
  maxOrdersPerHour: 10,
  receiverPinDigits: 4,
  receiverPinMaxFailures: 3,
  receiverPinLockMinutes: 15,
  courierDeliveryShareBps: 7_500,
  swiftDropDeliveryShareBps: 2_500,
  stakeholderHoldHours: 72,
  minimumWithdrawalMinor: 100_000,
  floatMinimumReserveMinor: 500_000_000,
  floatAutoTopUpThresholdMinor: 300_000_000,
  noCashAccepted: true,
} as const;

export const SWIFTDROP_COPY = {
  homeGreetingSubline: "How far? What are we moving today?",
  paymentSuccess: "Sharp sharp! Payment received.",
  errandWaiting: "Finding you an errand…",
  errandAccepted: "Tunde (verified errand) accepted your request",
  errandChatPrivacy: "Keep everything in this chat. Phone numbers stay hidden until the goods are paid.",
  photoSent: "Photo sent. Customer, review and confirm you're satisfied.",
  agentNewOrderBanner: "🔔 New order paid · #SD-XXXX",
  agentDispatchReminder: "Send out immediately. Parcel must show receiver name, phone & address.",
  shopCheckoutNote: "All orders are sent to a drop-off / pickup station. Only Xpress Drop-off is delivered to your chosen location.",
  podQuoteNote: "Payment on delivery: the receiver pays the courier [total]. The courier remits the cash to SwiftDrop within 24 hours.",
  courierPodNote: "💵 Merchant orders are payment on delivery: collect the fee from the receiver. Remit the cash to your wallet within 24h. If the receiver refuses, tap Return and a return fee applies.",
  trustScoreExcellent: "Trust Score: 94/100 · Excellent",
} as const;

export const TRUST_SCORE_WEIGHTS = {
  deliverySuccess: 0.30,
  onTime: 0.20,
  photoCompliance: 0.15,
  rating: 0.20,
  disputeInverse: 0.15,
} as const;

export function calculateTrustScore(input: {
  deliverySuccessRate: number;
  onTimeRate: number;
  photoComplianceRate: number;
  ratingAvgNormalized: number;
  disputeRate: number;
}): number {
  return Number((
    input.deliverySuccessRate * TRUST_SCORE_WEIGHTS.deliverySuccess +
    input.onTimeRate * TRUST_SCORE_WEIGHTS.onTime +
    input.photoComplianceRate * TRUST_SCORE_WEIGHTS.photoCompliance +
    input.ratingAvgNormalized * TRUST_SCORE_WEIGHTS.rating +
    (100 - input.disputeRate) * TRUST_SCORE_WEIGHTS.disputeInverse
  ).toFixed(2));
}
