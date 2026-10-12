import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { hashPin, verifyPin } from "../security.js";
import { canTransition } from "../deliveryState.js";
import { allowedPaymentSources } from "./paymentState.js";

export type PaymentRecord = {
  id: string;
  deliveryId: string;
  provider: string;
  providerReference?: string;
  authorizationUrl?: string;
  accessCode?: string;
  amountMinor: number;
  currency: string;
  status: "PENDING" | "AUTHORIZED" | "HELD" | "RELEASED" | "REFUNDED" | "FAILED";
  escrowStatus?: "PENDING" | "HELD" | "RELEASED" | "REFUNDED" | "NOT_APPLICABLE";
  collectionMode: "SENDER_ESCROW" | "RECEIVER_ESCROW" | "PAY_ON_DELIVERY";
  createdAt: string;
  refundReference?: string;
  refundStatus?: string;
  refundAmountMinor?: number;
  refundUpdatedAt?: string;
  totalRefundedMinor: number;
  updatedAt: string;
};

export async function findPayment(deliveryId: string): Promise<PaymentRecord | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM payments WHERE delivery_id=$1", [deliveryId]);
  return result.rows[0] ? paymentFromRow(result.rows[0]) : null;
}

function paymentFromRow(row: any): PaymentRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    provider: row.provider,
    providerReference: row.provider_reference ?? undefined,
    authorizationUrl: row.authorization_url ?? undefined,
    accessCode: row.access_code ?? undefined,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    escrowStatus: row.escrow_status ?? undefined,
    collectionMode: (row.collection_mode === "RECEIVER_ESCROW" || row.collection_mode === "PAY_ON_DELIVERY")
      ? row.collection_mode
      : "SENDER_ESCROW",
    refundReference: row.refund_reference ?? undefined,
    refundStatus: row.refund_status ?? undefined,
    refundAmountMinor: row.refund_amount_minor == null ? undefined : Number(row.refund_amount_minor),
    refundUpdatedAt: row.refund_updated_at ? new Date(row.refund_updated_at).toISOString() : undefined,
    totalRefundedMinor: Number(row.total_refunded_minor ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function createPayment(input: {
  deliveryId: string;
  provider: string;
  amountMinor: number;
  currency?: string;
  collectionMode?: "SENDER_ESCROW" | "RECEIVER_ESCROW" | "PAY_ON_DELIVERY";
}): Promise<PaymentRecord> {
  if (input.collectionMode && !["SENDER_ESCROW","RECEIVER_ESCROW","PAY_ON_DELIVERY"].includes(input.collectionMode)) {
    throw new Error("Unsupported payment mode.");
  }
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const result = await pool.query(
    `INSERT INTO payments (delivery_id, provider, amount_minor, currency, status, collection_mode, escrow_status)
     VALUES ($1,$2,$3,$4,'PENDING',$5,'PENDING')
     ON CONFLICT (delivery_id) DO UPDATE SET amount_minor=EXCLUDED.amount_minor,
       currency=EXCLUDED.currency, collection_mode=EXCLUDED.collection_mode,
       escrow_status=COALESCE(payments.escrow_status,'PENDING'),
       updated_at=now()
     RETURNING *`,
    [input.deliveryId, input.provider, input.amountMinor, input.currency ?? "NGN", input.collectionMode ?? "SENDER_ESCROW"]
  );
  return paymentFromRow(result.rows[0]);
}
