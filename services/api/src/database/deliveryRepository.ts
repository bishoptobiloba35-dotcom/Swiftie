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
  amountMinor: number;
  currency: string;
  status: "PENDING" | "AUTHORIZED" | "HELD" | "RELEASED" | "REFUNDED" | "FAILED";
  escrowStatus?: "PENDING" | "HELD" | "RELEASED" | "REFUNDED";
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
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    escrowStatus: row.escrow_status ?? undefined,
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
}): Promise<PaymentRecord> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const result = await pool.query(
    `INSERT INTO payments (delivery_id, provider, amount_minor, currency, status)
     VALUES ($1,$2,$3,$4,'PENDING')
     ON CONFLICT (delivery_id) DO UPDATE SET amount_minor=EXCLUDED.amount_minor,
       currency=EXCLUDED.currency, updated_at=now()
     RETURNING *`,
    [input.deliveryId, input.provider, input.amountMinor, input.currency ?? "NGN"]
  );
  return paymentFromRow(result.rows[0]);
}

export async function markPaymentRefund(deliveryId: string, refundReference: string, refundStatus: string, refundAmountMinor: number): Promise<PaymentRecord | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH existing AS (
         SELECT refund_status
           FROM payment_refund_events
          WHERE delivery_id=$1 AND refund_reference=$2
          FOR UPDATE
       ),
       inserted AS (
         INSERT INTO payment_refund_events (delivery_id, refund_reference, refund_status, amount_minor)
         SELECT $1,$2,$3,$4
         WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING id
       ),
       event_updated AS (
         UPDATE payment_refund_events
            SET refund_status=$3, amount_minor=$4, updated_at=now()
          WHERE delivery_id=$1 AND refund_reference=$2
            AND EXISTS (SELECT 1 FROM existing)
         RETURNING id
       )
       UPDATE payments
          SET refund_reference=$2,
              refund_status=$3,
              refund_amount_minor=$4,
              total_refunded_minor=COALESCE(total_refunded_minor,0) +
                CASE
                  WHEN $3='processed'
                   AND (
                     EXISTS (SELECT 1 FROM inserted)
                     OR EXISTS (SELECT 1 FROM existing WHERE refund_status <> 'processed')
                   )
                  THEN $4
                  ELSE 0
                END,
              refund_updated_at=now(),
              updated_at=now()
        WHERE delivery_id=$1
        RETURNING *`,
      [deliveryId, refundReference || "unknown", refundStatus, refundAmountMinor]
    );
    await client.query('COMMIT');
    return result.rows[0] ? paymentFromRow(result.rows[0]) : null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updatePaymentStatus(
  deliveryId: string,
  status: PaymentRecord["status"],
  providerReference?: string
): Promise<PaymentRecord | null> {
  if (!pool) return null;

  // Financial state changes must be monotonic and explicitly allowed. Webhooks can
  // be retried, so a same-state update remains idempotent, but a terminal state
  // must never be moved backwards by a late or forged callback.
  const allowedFrom = allowedPaymentSources(status);

  const result = await pool.query(
    `UPDATE payments
        SET status=$2,
            escrow_status=CASE
              WHEN $2='HELD' THEN 'HELD'
              WHEN $2='RELEASED' THEN 'RELEASED'
              WHEN $2='REFUNDED' THEN 'REFUNDED'
              ELSE escrow_status
            END,
            provider_reference=COALESCE($3, provider_reference),
            updated_at=now()
      WHERE delivery_id=$1
        AND status = ANY($4::text[])
      RETURNING *`,
    [deliveryId, status, providerReference ?? null, allowedFrom]
  );
  return result.rows[0] ? paymentFromRow(result.rows[0]) : null;
}

export type StoredDelivery = {
  id: string;
  trackingCode: string;
  senderId: string;
  receiverName: string;
  receiverPhone: string;
  pickup: { label: string; formattedAddress: string; location: { latitude: number; longitude: number } };
  dropoff: { label: string; formattedAddress: string; location: { latitude: number; longitude: number } };
  status: string;
  exceptionStatus?: string;
  nextDeliveryAt?: string | null;
  driverId?: string;
  pickupPhotoUrl?: string;
  receiverPinHash: string;
  weightKg?: number;
  dimensionsCm?: { length: number; width: number; height: number };
  isPerishable: boolean;
  declaredValueMinor: number;
  receiverConfirmedAt?: string;
  quote?: {
    currency: string;
    distanceMeters: number;
    durationSeconds: number;
    baseFareMinor: number;
    distanceFareMinor: number;
    weightFareMinor: number;
    sizeFareMinor: number;
    perishableSurchargeMinor: number;
    serviceFeeMinor: number;
    totalMinor: number;
  };
  createdAt: string;
  updatedAt: string;
};

function rowToDelivery(row: any): StoredDelivery {
  return {
    id: row.id,
    trackingCode: row.tracking_code,
    senderId: row.sender_id,
    receiverName: row.receiver_name,
    receiverPhone: row.receiver_phone,
    pickup: { label: "Pickup", formattedAddress: row.pickup_address, location: { latitude: Number(row.pickup_lat), longitude: Number(row.pickup_lng) } },
    dropoff: { label: "Drop-off", formattedAddress: row.dropoff_address, location: { latitude: Number(row.dropoff_lat), longitude: Number(row.dropoff_lng) } },
    status: row.status,
    exceptionStatus: row.exception_status ?? "NONE",
    nextDeliveryAt: row.next_delivery_at ? new Date(row.next_delivery_at).toISOString() : null,
    driverId: row.driver_id ?? undefined,
    pickupPhotoUrl: row.pickup_photo_url ?? undefined,
    receiverPinHash: row.receiver_pin_hash,
    weightKg: row.weight_kg == null ? undefined : Number(row.weight_kg),
    dimensionsCm: row.length_cm == null ? undefined : { length: Number(row.length_cm), width: Number(row.width_cm), height: Number(row.height_cm) },
    isPerishable: Boolean(row.is_perishable),
    declaredValueMinor: Number(row.declared_value_minor),
    receiverConfirmedAt: row.receiver_confirmed_at ? new Date(row.receiver_confirmed_at).toISOString() : undefined,
    quote: row.quote_total_minor == null ? undefined : {
      currency: row.quote_currency ?? "NGN",
      distanceMeters: Number(row.quote_distance_meters),
      durationSeconds: Number(row.quote_duration_seconds),
      baseFareMinor: Number(row.quote_base_fare_minor),
      distanceFareMinor: Number(row.quote_distance_fare_minor),
      weightFareMinor: Number(row.quote_weight_fare_minor ?? 0),
      sizeFareMinor: Number(row.quote_size_fare_minor ?? 0),
      perishableSurchargeMinor: Number(row.quote_perishable_surcharge_minor ?? 0),
      serviceFeeMinor: Number(row.quote_service_fee_minor),
      totalMinor: Number(row.quote_total_minor)
    },
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export function databaseEnabled(): boolean {
  return Boolean(pool);
}

export async function recordDeliveryEvent(input: {
  deliveryId: string;
  eventType: string;
  actorUserId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO delivery_events (delivery_id, event_type, actor_user_id, metadata)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [input.deliveryId, input.eventType, input.actorUserId ?? null, JSON.stringify(input.metadata ?? {})]
  );
}

export async function listDeliveryEvents(deliveryId: string): Promise<Array<{
  id: string;
  eventType: string;
  actorUserId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}>> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, event_type AS "eventType", actor_user_id AS "actorUserId",
      metadata, created_at AS "createdAt"
     FROM delivery_events WHERE delivery_id=$1 ORDER BY created_at ASC`,
    [deliveryId]
  );
  return result.rows.map(row => ({
    ...row,
    actorUserId: row.actorUserId ?? undefined,
    createdAt: new Date(row.createdAt).toISOString()
  }));
}

export async function createPersistentDelivery(input: {
  senderId: string;
  receiverName: string;
  receiverPhone: string;
  pickup: { label: string; formattedAddress: string; location: { latitude: number; longitude: number } };
  dropoff: { label: string; formattedAddress: string; location: { latitude: number; longitude: number } };
  receiverPin: string;
  weightKg: number;
  dimensionsCm: { length: number; width: number; height: number };
  isPerishable: boolean;
  declaredValueMinor: number;
  quote?: StoredDelivery["quote"];
}): Promise<StoredDelivery> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const id = randomUUID();
  const code = "SD-" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const result = await pool.query(
    `INSERT INTO deliveries
      (id, tracking_code, sender_id, receiver_name, receiver_phone,
       pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, status, receiver_pin_hash,
       weight_kg, length_cm, width_cm, height_cm, is_perishable, declared_value_minor,
       quote_distance_meters, quote_duration_seconds, quote_base_fare_minor,
       quote_distance_fare_minor, quote_weight_fare_minor, quote_size_fare_minor, quote_perishable_surcharge_minor, quote_service_fee_minor, quote_total_minor, quote_currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CREATED',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING *`,
    [id, code, input.senderId, input.receiverName, input.receiverPhone,
      input.pickup.formattedAddress, input.pickup.location.latitude, input.pickup.location.longitude,
      input.dropoff.formattedAddress, input.dropoff.location.latitude, input.dropoff.location.longitude,
      hashPin(input.receiverPin), input.weightKg ?? null, input.dimensionsCm?.length ?? null, input.dimensionsCm?.width ?? null, input.dimensionsCm?.height ?? null, input.isPerishable ?? false, input.declaredValueMinor, input.quote?.distanceMeters ?? null, input.quote?.durationSeconds ?? null,
      input.quote?.baseFareMinor ?? null, input.quote?.distanceFareMinor ?? null,
      input.quote?.weightFareMinor ?? null, input.quote?.sizeFareMinor ?? null, input.quote?.perishableSurchargeMinor ?? null,
      input.quote?.serviceFeeMinor ?? null, input.quote?.totalMinor ?? null, input.quote?.currency ?? "NGN"]
  );
  return rowToDelivery(result.rows[0]);
}

export async function findDeliveryForUser(id: string, userId: string, role: "CUSTOMER" | "DRIVER" | "ADMIN"): Promise<StoredDelivery | null> {
  if (!pool) return null;
  const result = role === "CUSTOMER"
    ? await pool.query("SELECT * FROM deliveries WHERE id=$1 AND sender_id=$2", [id, userId])
    : role === "DRIVER"
      ? await pool.query(
          "SELECT d.* FROM deliveries d JOIN drivers dr ON dr.id=d.driver_id WHERE d.id=$1 AND dr.user_id=$2",
          [id, userId]
        )
      : await pool.query("SELECT * FROM deliveries WHERE id=$1", [id]);
  return result.rows[0] ? rowToDelivery(result.rows[0]) : null;
}

export async function driverForUser(userId: string): Promise<{ id: string; userId: string; status: string; online: boolean } | null> {
  if (!pool) return null;
  const result = await pool.query(
    "SELECT id, user_id AS \"userId\", status, online FROM drivers WHERE user_id=$1",
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function findDelivery(id: string): Promise<StoredDelivery | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM deliveries WHERE id=$1", [id]);
  return result.rows[0] ? rowToDelivery(result.rows[0]) : null;
}

export async function findByTrackingCode(code: string): Promise<StoredDelivery | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM deliveries WHERE tracking_code=$1", [code]);
  return result.rows[0] ? rowToDelivery(result.rows[0]) : null;
}

export async function setDriverOnline(driverId: string, online: boolean): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    `UPDATE drivers d
     SET online=$2
     WHERE d.id=$1
       AND d.status='APPROVED'
       AND EXISTS (
         SELECT 1 FROM driver_documents dd
         WHERE dd.driver_id=d.id AND dd.status='APPROVED'
       )
     RETURNING d.id`,
    [driverId, online]
  );
  return result.rowCount === 1;
}

export type PayoutRecord = {
  id: string;
  deliveryId: string;
  driverId: string;
  amountMinor: number;
  currency: string;
  status: "PENDING" | "ELIGIBLE" | "PROCESSING" | "RELEASED" | "FAILED" | "CANCELLED";
  provider?: string | null;
  providerReference?: string | null;
  providerStatus?: string | null;
  failureReason?: string | null;
  processedAt?: string | null;
};

function rowToPayout(row: any): PayoutRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    driverId: row.driver_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    provider: row.provider ?? null,
    providerReference: row.provider_reference ?? null,
    providerStatus: row.provider_status ?? null,
    failureReason: row.failure_reason ?? null,
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null
  };
}

export type DisputeRecord = {
  id: string;
  deliveryId: string;
  openedBy?: string | null;
  reason: string;
  description?: string | null;
  status: "OPEN" | "UNDER_REVIEW" | "RESOLVED_REFUND" | "RESOLVED_RELEASE" | "CLOSED";
  resolutionNote?: string | null;
};

function rowToDispute(row: any): DisputeRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    openedBy: row.opened_by ?? null,
    reason: row.reason,
    description: row.description ?? null,
    status: row.status,
    resolutionNote: row.resolution_note ?? null
  };
}

export async function createDispute(deliveryId: string, openedBy: string, reason: string, description?: string): Promise<DisputeRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `INSERT INTO disputes (delivery_id, opened_by, reason, description)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING *`,
    [deliveryId, openedBy, reason, description ?? null]
  );
  return result.rows[0] ? rowToDispute(result.rows[0]) : null;
}

export async function createReceiverDispute(deliveryId: string, receiverPhone: string, reason: string, description?: string): Promise<DisputeRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `INSERT INTO disputes (delivery_id, opened_by, opened_by_phone, opened_by_role, reason, description)
     VALUES ($1,NULL,$2,'RECEIVER',$3,$4)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING *`,
    [deliveryId, receiverPhone, reason, description ?? null]
  );
  return result.rows[0] ? rowToDispute(result.rows[0]) : null;
}

export type SupportTicketRecord = {
  id: string;
  userId: string;
  deliveryId?: string | null;
  category: "ORDER" | "APP";
  subject: string;
  message: string;
  status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";
  resolutionNote?: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowToSupportTicket(row: any): SupportTicketRecord {
  return {
    id: row.id,
    userId: row.user_id,
    deliveryId: row.delivery_id ?? null,
    category: row.category,
    subject: row.subject,
    message: row.message,
    status: row.status,
    resolutionNote: row.resolution_note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createSupportTicket(userId: string, category: "ORDER" | "APP", subject: string, message: string, deliveryId?: string): Promise<SupportTicketRecord | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO support_tickets (user_id, delivery_id, category, subject, message)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [userId, deliveryId || null, category, subject, message]
    );
    const ticket = result.rows[0];
    if (!ticket) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_user_id, message)
       VALUES ($1,'USER',$2,$3)`,
      [ticket.id, userId, message]
    );
    await client.query("COMMIT");
    return rowToSupportTicket(ticket);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listSupportTicketMessages(ticketId: string, userId?: string): Promise<Array<{ id: string; ticketId: string; senderType: "USER" | "AI" | "ADMIN"; senderUserId?: string | null; message: string; createdAt: string }>> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT m.id, m.ticket_id, m.sender_type, m.sender_user_id, m.message, m.created_at
       FROM support_ticket_messages m
       JOIN support_tickets t ON t.id=m.ticket_id
      WHERE m.ticket_id=$1 AND ($2::uuid IS NULL OR t.user_id=$2)
      ORDER BY m.created_at ASC`,
    [ticketId, userId ?? null]
  );
  return result.rows.map(row => ({
    id: row.id,
    ticketId: row.ticket_id,
    senderType: row.sender_type,
    senderUserId: row.sender_user_id ?? null,
    message: row.message,
    createdAt: new Date(row.created_at).toISOString()
  }));
}

export async function recordSupportAiMessage(ticketId: string, response: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO support_ticket_messages (ticket_id, sender_type, message)
     SELECT $1,'AI',$2
     WHERE NOT EXISTS (
       SELECT 1 FROM support_ticket_messages
       WHERE ticket_id=$1 AND sender_type='AI' AND message=$2
     )`,
    [ticketId, response]
  );
}

export async function recordAdminSupportMessage(ticketId: string, adminUserId: string, response: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_user_id, message)
     VALUES ($1,'ADMIN',$2,$3)`,
    [ticketId, adminUserId, response]
  );
}

export async function recordAdminSupportReply(
  ticketId: string,
  adminUserId: string,
  response: string
): Promise<SupportTicketRecord | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE support_tickets
          SET status='IN_REVIEW', resolution_note=$2, updated_at=now()
        WHERE id=$1 AND status IN ('OPEN','IN_REVIEW')
        RETURNING *`,
      [ticketId, response]
    );
    const ticket = result.rows[0];
    if (!ticket) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_user_id, message)
       VALUES ($1,'ADMIN',$2,$3)`,
      [ticketId, adminUserId, response]
    );
    await client.query("COMMIT");
    return rowToSupportTicket(ticket);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listSupportTickets(userId?: string): Promise<SupportTicketRecord[]> {
  if (!pool) return [];
  const result = await pool.query(
    userId
      ? "SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100"
      : "SELECT * FROM support_tickets ORDER BY updated_at DESC LIMIT 200",
    userId ? [userId] : []
  );
  return result.rows.map(rowToSupportTicket);
}

export type SupportAiActionRecord = {
  id: string; ticketId: string; actionType: string;
  decision: "AUTO_RESOLVED" | "ESCALATED" | "BLOCKED";
  reason: string; response: string; actor: string; createdAt: string;
};

export async function recordSupportAiAction(ticketId: string, actionType: string, decision: SupportAiActionRecord["decision"], reason: string, response: string): Promise<SupportAiActionRecord | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ticket = (await client.query("SELECT ai_handled, status FROM support_tickets WHERE id=$1 FOR UPDATE", [ticketId])).rows[0];
    if (!ticket || ticket.ai_handled || !["OPEN","IN_REVIEW"].includes(ticket.status)) {
      await client.query("ROLLBACK");
      return null;
    }
    const action = (await client.query(`INSERT INTO support_ai_actions (ticket_id, action_type, decision, reason, response) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [ticketId, actionType, decision, reason, response])).rows[0];
    await client.query(`UPDATE support_tickets SET ai_handled=true, ai_action_id=$2, human_required=$3, status=CASE WHEN $3 THEN 'IN_REVIEW' ELSE 'RESOLVED' END, resolution_note=$4, updated_at=now() WHERE id=$1 AND status IN ('OPEN','IN_REVIEW')`, [ticketId, action.id, decision === "ESCALATED", response]);
    await client.query(`INSERT INTO support_ticket_messages (ticket_id, sender_type, message) VALUES ($1,'AI',$2)`, [ticketId, response]);
    await client.query("COMMIT");
    return { id: action.id, ticketId: action.ticket_id, actionType: action.action_type, decision: action.decision, reason: action.reason, response: action.response, actor: action.actor, createdAt: action.created_at };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function listOpenSupportAiTickets(limit = 20): Promise<SupportTicketRecord[]> {
  if (!pool) return [];
  const result = await pool.query(`SELECT * FROM support_tickets WHERE status='OPEN' AND ai_handled=false AND human_required=false ORDER BY created_at ASC LIMIT $1`, [Math.min(Math.max(limit, 1), 50)]);
  return result.rows.map(rowToSupportTicket);
}

export async function notifyAdminsOfSupportAiAction(ticketId: string, actionId: string, decision: string, response: string): Promise<void> {
  if (!pool) return;
  const body = "Support AI " + decision.toLowerCase() + " ticket " + ticketId + ". Action " + actionId + ". " + response;
  await pool.query(`INSERT INTO notifications (user_id, title, body, type, created_at) SELECT id, 'Support AI action', $1, 'SUPPORT_AI_ACTION', now() FROM users WHERE role='ADMIN'`, [body]);
}

export async function notifySupportUserOfAiAction(ticketId: string, actionId: string, decision: string, response: string): Promise<void> {
  if (!pool) return;
  const result = await pool.query(
    `SELECT user_id FROM support_tickets WHERE id=$1`,
    [ticketId]
  );
  const userId = result.rows[0]?.user_id;
  if (!userId) return;
  const title = decision === "AUTO_RESOLVED" ? "SwiftDrop Support replied" : "SwiftDrop Support needs human review";
  await pool.query(
    `INSERT INTO notifications (user_id, title, body, type, created_at)
     VALUES ($1,$2,$3,'SUPPORT_AI_REPLY',now())`,
    [userId, title, response + " (Support action: " + actionId + ")"]
  );
}
export async function resolveSupportTicket(id: string, status: "IN_REVIEW" | "RESOLVED" | "CLOSED", note: string): Promise<SupportTicketRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE support_tickets SET status=$2, resolution_note=$3, updated_at=now()
     WHERE id=$1 AND status IN ('OPEN','IN_REVIEW')
     RETURNING *`,
    [id, status, note]
  );
  return result.rows[0] ? rowToSupportTicket(result.rows[0]) : null;
}

export async function findDispute(deliveryId: string): Promise<DisputeRecord | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM disputes WHERE delivery_id=$1", [deliveryId]);
  return result.rows[0] ? rowToDispute(result.rows[0]) : null;
}

export async function releaseDisputeAndCreatePayout(
  deliveryId: string,
  payoutPercent: number,
  note: string
): Promise<{ dispute: DisputeRecord; payout: PayoutRecord | null; payment: PaymentRecord } | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const disputeResult = await client.query(
      `SELECT * FROM disputes
        WHERE delivery_id=$1 AND status IN ('OPEN','UNDER_REVIEW')
        FOR UPDATE`,
      [deliveryId]
    );
    const disputeRow = disputeResult.rows[0];
    if (!disputeRow) {
      await client.query('ROLLBACK');
      return null;
    }

    const paymentResult = await client.query(
      `SELECT p.*, d.driver_id
         FROM payments p
         JOIN deliveries d ON d.id=p.delivery_id
        WHERE p.delivery_id=$1
        FOR UPDATE`,
      [deliveryId]
    );
    const paymentRow = paymentResult.rows[0];
    if (!paymentRow || !['HELD','RELEASED'].includes(paymentRow.status) || !paymentRow.driver_id) {
      await client.query('ROLLBACK');
      return null;
    }

    const payoutResult = await client.query(
      `SELECT * FROM payouts WHERE delivery_id=$1 FOR UPDATE`,
      [deliveryId]
    );
    const existingPayout = payoutResult.rows[0] ?? null;
    const payoutAmountMinor = Math.max(
      0,
      Math.floor(Number(paymentRow.amount_minor) * Math.min(100, Math.max(0, payoutPercent)) / 100)
    );

    let payoutRow = existingPayout;
    if (payoutAmountMinor > 0 && (!existingPayout || ['PENDING','ELIGIBLE'].includes(existingPayout.status))) {
      const created = await client.query(
        `INSERT INTO payouts (delivery_id, driver_id, amount_minor, currency, status)
         VALUES ($1,$2,$3,$4,'ELIGIBLE')
         ON CONFLICT (delivery_id) DO UPDATE
           SET driver_id=EXCLUDED.driver_id,
               amount_minor=EXCLUDED.amount_minor,
               currency=EXCLUDED.currency,
               status=CASE WHEN payouts.status IN ('PENDING','ELIGIBLE') THEN 'ELIGIBLE' ELSE payouts.status END,
               updated_at=now()
         RETURNING *`,
        [deliveryId, paymentRow.driver_id, payoutAmountMinor, paymentRow.currency ?? 'NGN']
      );
      payoutRow = created.rows[0] ?? existingPayout;
    }

    if (paymentRow.status === 'HELD') {
      await client.query(
        `UPDATE payments
            SET status='RELEASED', escrow_status='RELEASED', updated_at=now()
          WHERE delivery_id=$1 AND status='HELD'`,
        [deliveryId]
      );
    }

    const resolved = await client.query(
      `UPDATE disputes
          SET status='RESOLVED_RELEASE', resolution_note=$2, updated_at=now()
        WHERE delivery_id=$1 AND status IN ('OPEN','UNDER_REVIEW')
        RETURNING *`,
      [deliveryId, note]
    );
    if (!resolved.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('COMMIT');
    const paymentAfter = await pool.query('SELECT * FROM payments WHERE delivery_id=$1', [deliveryId]);
    return {
      dispute: rowToDispute(resolved.rows[0]),
      payout: payoutRow ? rowToPayout(payoutRow) : null,
      payment: paymentFromRow(paymentAfter.rows[0])
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveDispute(deliveryId: string, status: "RESOLVED_REFUND" | "RESOLVED_RELEASE", note: string): Promise<DisputeRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE disputes SET status=$2, resolution_note=$3, updated_at=now()
     WHERE delivery_id=$1 AND status IN ('OPEN','UNDER_REVIEW')
     RETURNING *`,
    [deliveryId, status, note]
  );
  return result.rows[0] ? rowToDispute(result.rows[0]) : null;
}

export async function createEligiblePayout(deliveryId: string, driverId: string, amountMinor: number): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `INSERT INTO payouts (delivery_id, driver_id, amount_minor, status)
     VALUES ($1,$2,$3,'ELIGIBLE')
     ON CONFLICT (delivery_id) DO UPDATE
      SET updated_at=now()
      WHERE payouts.status IN ('PENDING','ELIGIBLE')
     RETURNING *`,
    [deliveryId, driverId, amountMinor]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function cancelEligiblePayoutForRefund(deliveryId: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts SET status='CANCELLED', updated_at=now()
     WHERE delivery_id=$1 AND status IN ('PENDING','ELIGIBLE')
     RETURNING *`,
    [deliveryId]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function findPayout(deliveryId: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM payouts WHERE delivery_id=$1", [deliveryId]);
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function findPayoutByProviderReference(providerReference: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM payouts WHERE provider_reference=$1", [providerReference]);
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function claimPaystackWebhookEvent(input: {
  payloadHash: string;
  eventType: string;
  providerReference?: string | null;
}): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    `INSERT INTO paystack_webhook_events (payload_hash, event_type, provider_reference)
     VALUES ($1,$2,$3)
     ON CONFLICT (payload_hash) DO NOTHING
     RETURNING id`,
    [input.payloadHash, input.eventType, input.providerReference ?? null]
  );
  return Boolean(result.rowCount);
}

export async function markPayoutReleased(deliveryId: string, providerReference: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts
     SET status='RELEASED', provider='paystack', provider_reference=$2, updated_at=now()
     WHERE delivery_id=$1 AND status IN ('PROCESSING','ELIGIBLE')
     RETURNING *`,
    [deliveryId, providerReference]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function flagPayoutReconciliationMismatch(
  providerReference: string,
  failureReason: string,
  providerAmountMinor?: number,
  providerCurrency?: string
): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts
        SET provider='paystack',
            provider_status='amount_mismatch',
            failure_reason=$2,
            updated_at=now()
      WHERE provider_reference=$1
        AND status='PROCESSING'
      RETURNING *`,
    [providerReference, failureReason]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function updatePayoutProviderStatus(
  providerReference: string,
  status: "RELEASED" | "FAILED" | "CANCELLED",
  failureReason?: string | null,
  providerAmountMinor?: number,
  providerCurrency?: string
): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts
     SET status=$2,
         provider='paystack',
         provider_status=$3,
         failure_reason=CASE WHEN $2='FAILED' THEN COALESCE($4, failure_reason, 'Paystack transfer failed') ELSE failure_reason END,
         processed_at=CASE WHEN $2 IN ('RELEASED','FAILED','CANCELLED') THEN COALESCE(processed_at, now()) ELSE processed_at END,
         updated_at=now()
     WHERE provider_reference=$1
       AND (status IN ('PROCESSING','ELIGIBLE') OR ($2='RELEASED' AND status='RELEASED'))
       AND ($5::bigint IS NULL OR amount_minor=$5)
       AND ($6::text IS NULL OR currency=$6)
     RETURNING *`,
    [providerReference, status, status === "RELEASED" ? "success" : status === "CANCELLED" ? "reversed" : "failed", failureReason ?? null, providerAmountMinor ?? null, providerCurrency ?? null]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function setPayoutProviderReference(deliveryId: string, providerReference: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts
     SET provider='paystack', provider_reference=$2, updated_at=now()
     WHERE delivery_id=$1 AND status='PROCESSING' AND provider_reference IS NULL
     RETURNING *`,
    [deliveryId, providerReference]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export type AdminCaseAuditRecord = {
  id: string;
  deliveryId?: string | null;
  disputeId?: string | null;
  adminUserId?: string | null;
  action: string;
  note?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export async function recordAdminCaseAudit(input: {
  deliveryId?: string | null;
  disputeId?: string | null;
  adminUserId?: string | null;
  action: string;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AdminCaseAuditRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `INSERT INTO admin_case_audit (delivery_id, dispute_id, admin_user_id, action, note, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id, delivery_id, dispute_id, admin_user_id, action, note, metadata, created_at`,
    [
      input.deliveryId ?? null,
      input.disputeId ?? null,
      input.adminUserId ?? null,
      input.action,
      input.note ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    deliveryId: row.delivery_id ?? null,
    disputeId: row.dispute_id ?? null,
    adminUserId: row.admin_user_id ?? null,
    action: row.action,
    note: row.note ?? null,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at).toISOString()
  } : null;
}

export async function listAdminCaseAudit(deliveryId: string): Promise<AdminCaseAuditRecord[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, delivery_id, dispute_id, admin_user_id, action, note, metadata, created_at
       FROM admin_case_audit
      WHERE delivery_id=$1
      ORDER BY created_at DESC
      LIMIT 100`,
    [deliveryId]
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    deliveryId: row.delivery_id ?? null,
    disputeId: row.dispute_id ?? null,
    adminUserId: row.admin_user_id ?? null,
    action: row.action,
    note: row.note ?? null,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at).toISOString()
  }));
}

export async function markDisputeUnderReview(deliveryId: string): Promise<DisputeRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE disputes SET status='UNDER_REVIEW', updated_at=now()
      WHERE delivery_id=$1 AND status='OPEN'
      RETURNING *`,
    [deliveryId]
  );
  return result.rows[0] ? rowToDispute(result.rows[0]) : null;
}

export async function prepareRefund(deliveryId: string, refundAmountMinor: number, verifiedLossMinor?: number): Promise<{ payment: PaymentRecord; payout: PayoutRecord | null; dispute: DisputeRecord } | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deliveryLock = await client.query(
      `SELECT id FROM deliveries WHERE id=$1 FOR UPDATE`,
      [deliveryId]
    );
    if (!deliveryLock.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    const paymentResult = await client.query(
      `SELECT * FROM payments WHERE delivery_id=$1 FOR UPDATE`,
      [deliveryId]
    );
    const paymentRow = paymentResult.rows[0];
    if (!paymentRow || paymentRow.provider !== 'paystack' || !paymentRow.provider_reference) {
      await client.query('ROLLBACK');
      return null;
    }
    const amountMinor = Number(paymentRow.amount_minor);
    if (!Number.isInteger(refundAmountMinor) || refundAmountMinor < 1 || refundAmountMinor > amountMinor) {
      await client.query('ROLLBACK');
      return null;
    }
    const deliveryValueResult = await client.query(`SELECT declared_value_minor FROM deliveries WHERE id=$1 FOR UPDATE`, [deliveryId]);
    const declaredValueMinor = Number(deliveryValueResult.rows[0]?.declared_value_minor ?? 0);
    if (!Number.isInteger(declaredValueMinor) || declaredValueMinor < 1) { await client.query('ROLLBACK'); return null; }
    if (verifiedLossMinor != null && (!Number.isInteger(verifiedLossMinor) || verifiedLossMinor < 0 || verifiedLossMinor > declaredValueMinor)) { await client.query('ROLLBACK'); return null; }
    const claimCeilingMinor = verifiedLossMinor == null ? declaredValueMinor : verifiedLossMinor;
    if (refundAmountMinor > claimCeilingMinor) { await client.query('ROLLBACK'); return null; }
    const totalRefundedMinor = Number(paymentRow.total_refunded_minor ?? 0);
    if (paymentRow.status === 'REFUNDED' || ['processed','processing','pending'].includes(String(paymentRow.refund_status ?? ''))) {
      await client.query('ROLLBACK');
      return null;
    }
    if (totalRefundedMinor + refundAmountMinor > amountMinor) {
      await client.query('ROLLBACK');
      return null;
    }
    const disputeResult = await client.query(
      `SELECT * FROM disputes
        WHERE delivery_id=$1 AND status IN ('OPEN','UNDER_REVIEW')
        FOR UPDATE`,
      [deliveryId]
    );
    const disputeRow = disputeResult.rows[0];
    if (!disputeRow) {
      await client.query('ROLLBACK');
      return null;
    }
    const payoutState = await client.query(
      `SELECT * FROM payouts WHERE delivery_id=$1 FOR UPDATE`,
      [deliveryId]
    );
    const existingPayout = payoutState.rows[0] ?? null;
    if (!existingPayout || ['PROCESSING','RELEASED'].includes(existingPayout.status)) {
      await client.query('ROLLBACK');
      return null;
    }
    let payoutRow = existingPayout;
    if (['PENDING','ELIGIBLE'].includes(existingPayout.status)) {
      const payoutResult = await client.query(
        `UPDATE payouts SET status='CANCELLED', updated_at=now()
          WHERE id=$1
          RETURNING *`,
        [existingPayout.id]
      );
      payoutRow = payoutResult.rows[0] ?? existingPayout;
    }
    await client.query('COMMIT');
    return {
      payment: paymentFromRow(paymentRow),
      payout: payoutRow ? rowToPayout(payoutRow) : null,
      dispute: rowToDispute(disputeRow)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function assignNextDeliveryToDriver(driverId: string): Promise<StoredDelivery | null> {
  if (!pool) return null;
  const verified = await pool.query(
    `SELECT 1 FROM drivers d
     WHERE d.id=$1 AND d.status='APPROVED' AND d.online=true
       AND EXISTS (SELECT 1 FROM driver_documents dd WHERE dd.driver_id=d.id AND dd.status='APPROVED')`,
    [driverId]
  );
  if (!verified.rowCount) return null;
  const result = await pool.query(
    `WITH candidate AS (
       SELECT id
       FROM deliveries
       WHERE driver_id IS NULL
         AND status = 'PAYMENT_AUTHORIZED'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE deliveries d
     SET driver_id=$1, status='DRIVER_ASSIGNED', updated_at=now()
     FROM candidate
     WHERE d.id=candidate.id
     RETURNING d.*`,
    [driverId]
  );
  return result.rows[0] ? rowToDelivery(result.rows[0]) : null;
}

export async function listOpenJobs(driverId: string): Promise<StoredDelivery[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT d.* FROM deliveries d
     WHERE d.driver_id IS NULL
       AND d.status = 'PAYMENT_AUTHORIZED'
       AND EXISTS (
         SELECT 1 FROM drivers dr
         WHERE dr.id=$1 AND dr.status='APPROVED' AND dr.online=true
           AND EXISTS (SELECT 1 FROM driver_documents dd WHERE dd.driver_id=dr.id AND dd.status='APPROVED')
       )
     ORDER BY d.created_at ASC`,
    [driverId]
  );
  return result.rows.map(rowToDelivery);
}

export async function transitionDelivery(id: string, from: string, to: string, driverId?: string): Promise<StoredDelivery | null> {
  if (!pool || !canTransition(from as any, to as any)) return null;
  const result = await pool.query(
    `UPDATE deliveries
     SET status=$2, driver_id=COALESCE($3, driver_id), updated_at=now()
     WHERE id=$1
       AND status=$4
       AND (
         ($4='PAYMENT_AUTHORIZED' AND driver_id IS NULL AND $3::uuid IS NOT NULL)
         OR ($4<>'PAYMENT_AUTHORIZED' AND $3::uuid IS NOT NULL AND driver_id=$3::uuid)
         OR ($3::uuid IS NULL)
       )
     RETURNING *`,
    [id, to, driverId ?? null, from]
  );
  return result.rows[0] ? rowToDelivery(result.rows[0]) : null;
}

export async function savePickupPhoto(id: string, driverId: string, photoUrl: string): Promise<StoredDelivery | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE deliveries SET pickup_photo_url=$3, status='PICKED_UP', updated_at=now()
     WHERE id=$1 AND driver_id=$2 AND status='DRIVER_AT_PICKUP'
     RETURNING *`,
    [id, driverId, photoUrl]
  );
  return result.rows[0] ? rowToDelivery(result.rows[0]) : null;
}

export async function verifyReceiverPin(id: string, pin: string): Promise<boolean> {
  const delivery = await findDelivery(id);
  return Boolean(delivery && verifyPin(pin, delivery.receiverPinHash));
}

export async function confirmReceiverAndReleaseEscrow(id: string, receiverPhone: string, pin: string, payoutPercent: number): Promise<{ delivery: StoredDelivery; payoutAmountMinor: number } | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT d.*, p.amount_minor, p.currency AS payment_currency, p.status AS payment_status FROM deliveries d JOIN payments p ON p.delivery_id=d.id WHERE d.id=$1 FOR UPDATE`, [id]);
    const row = result.rows[0];
    if (!row || row.receiver_phone !== receiverPhone || row.status !== 'ARRIVED' || row.payment_status !== 'HELD' || !verifyPin(pin, row.receiver_pin_hash) || !row.driver_id) {
      await client.query('ROLLBACK');
      return null;
    }
    const deliveryResult = await client.query(`UPDATE deliveries SET status='DELIVERED', receiver_confirmed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    const payoutAmountMinor = Math.max(0, Math.floor(Number(row.amount_minor) * Math.min(100, Math.max(0, payoutPercent)) / 100));
    await client.query(`UPDATE payments SET status='RELEASED', escrow_status='RELEASED', updated_at=now() WHERE delivery_id=$1 AND status='HELD'`, [id]);
    if (payoutAmountMinor > 0) {
      await client.query(`INSERT INTO payouts (delivery_id, driver_id, amount_minor, currency, status) VALUES ($1,$2,$3,$4,'ELIGIBLE') ON CONFLICT (delivery_id) DO UPDATE SET amount_minor=EXCLUDED.amount_minor, currency=EXCLUDED.currency, status=CASE WHEN payouts.status IN ('PENDING','ELIGIBLE') THEN 'ELIGIBLE' ELSE payouts.status END, updated_at=now()`, [id, row.driver_id, payoutAmountMinor, row.payment_currency ?? 'NGN']);
    }
    await client.query('COMMIT');
    return { delivery: rowToDelivery(deliveryResult.rows[0]), payoutAmountMinor };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function confirmReceiverDelivery(id: string, receiverPhone: string, pin: string): Promise<StoredDelivery | null> {
  if (!pool) return null;
  const delivery = await findDelivery(id);
  if (!delivery || delivery.receiverPhone !== receiverPhone || !verifyPin(pin, delivery.receiverPinHash)) return null;
  const result = await pool.query(
    `UPDATE deliveries SET status='DELIVERED', receiver_confirmed_at=now(), updated_at=now()
     WHERE id=$1 AND receiver_phone=$2 AND status='ARRIVED'
     RETURNING *`,
    [id, receiverPhone]
  );
  return result.rows[0] ? rowToDelivery(result.rows[0]) : null;
}

export async function completeDelivery(id: string, driverId: string): Promise<StoredDelivery | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE deliveries SET status='DELIVERED', updated_at=now()
     WHERE id=$1 AND driver_id=$2 AND status IN ('IN_TRANSIT','ARRIVED')
     RETURNING *`,
    [id, driverId]
  );
  return result.rows[0] ? rowToDelivery(result.rows[0]) : null;
}

export async function recordPersistentLocation(event: {
  deliveryId: string; driverId: string; latitude: number; longitude: number;
  accuracyMeters?: number; recordedAt: string;
}): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO location_events
      (delivery_id, driver_id, latitude, longitude, accuracy_meters, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [event.deliveryId, event.driverId, event.latitude, event.longitude, event.accuracyMeters ?? null, event.recordedAt]
  );
}

export async function latestPersistentLocation(deliveryId: string) {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT delivery_id AS "deliveryId", driver_id AS "driverId",
      latitude::float AS latitude, longitude::float AS longitude,
      accuracy_meters::float AS "accuracyMeters", recorded_at AS "recordedAt"
     FROM location_events WHERE delivery_id=$1
     ORDER BY recorded_at DESC LIMIT 1`,
    [deliveryId]
  );
  return result.rows[0] ?? null;
}


export type DriverPayoutAccount = {
  bankCode: string;
  bankName?: string | null;
  accountName: string;
  accountLast4: string;
  recipientCode: string;
  currency: string;
};

export async function getDriverPayoutAccount(driverId: string): Promise<DriverPayoutAccount | null> {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT payout_bank_code AS "bankCode", payout_bank_name AS "bankName",
      payout_account_name AS "accountName", RIGHT(payout_account_number, 4) AS "accountLast4",
      payout_recipient_code AS "recipientCode", 'NGN' AS currency
     FROM drivers
     WHERE id=$1 AND payout_recipient_code IS NOT NULL`,
    [driverId]
  );
  return result.rows[0] ?? null;
}

export async function saveDriverPayoutAccount(input: {
  driverId: string;
  bankCode: string;
  bankName?: string;
  accountNumber: string;
  accountName: string;
  recipientCode: string;
}): Promise<DriverPayoutAccount | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE drivers
     SET payout_bank_code=$2, payout_bank_name=$3, payout_account_number=$4,
         payout_account_name=$5, payout_recipient_code=$6
     WHERE id=$1
     RETURNING payout_bank_code AS "bankCode", payout_bank_name AS "bankName",
       payout_account_name AS "accountName", RIGHT(payout_account_number, 4) AS "accountLast4",
       payout_recipient_code AS "recipientCode", 'NGN' AS currency`,
    [input.driverId, input.bankCode, input.bankName ?? null, "*".repeat(6) + input.accountNumber.slice(-4), input.accountName, input.recipientCode]
  );
  return result.rows[0] ?? null;
}

export async function setPayoutProcessing(deliveryId: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts SET status='PROCESSING', provider='paystack', updated_at=now()
     WHERE delivery_id=$1 AND status='ELIGIBLE'
     RETURNING *`,
    [deliveryId]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function markPayoutFailed(deliveryId: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts SET status='FAILED', updated_at=now()
     WHERE delivery_id=$1 AND status='PROCESSING'
     RETURNING *`,
    [deliveryId]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function retryFailedPayout(deliveryId: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts
     SET status='ELIGIBLE', provider_reference=NULL, provider_status=NULL,
         failure_reason=NULL, processed_at=NULL, updated_at=now()
     WHERE delivery_id=$1 AND status IN ('FAILED','CANCELLED')
     RETURNING *`,
    [deliveryId]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}
