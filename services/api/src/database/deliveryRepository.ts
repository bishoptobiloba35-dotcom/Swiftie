import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { hashPin, verifyPin } from "../security.js";

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

export async function updatePaymentStatus(
  deliveryId: string,
  status: PaymentRecord["status"],
  providerReference?: string
): Promise<PaymentRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payments SET status=$2, escrow_status=CASE WHEN $2='HELD' THEN 'HELD' WHEN $2='RELEASED' THEN 'RELEASED' WHEN $2='REFUNDED' THEN 'REFUNDED' ELSE escrow_status END, provider_reference=COALESCE($3, provider_reference), updated_at=now()
     WHERE delivery_id=$1 RETURNING *`,
    [deliveryId, status, providerReference ?? null]
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
  driverId?: string;
  pickupPhotoUrl?: string;
  receiverPinHash: string;
  weightKg?: number;
  dimensionsCm?: { length: number; width: number; height: number };
  isPerishable: boolean;
  receiverConfirmedAt?: string;
  quote?: {
    currency: string;
    distanceMeters: number;
    durationSeconds: number;
    baseFareMinor: number;
    distanceFareMinor: number;
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
    pickup: { label: "Pickup", formattedAddress: row.pickup_address, location: { latitude: Number(row.pickup_lat), longitude: Number(row.pickup_lng), recordedAt: new Date(row.created_at).toISOString() } },
    dropoff: { label: "Drop-off", formattedAddress: row.dropoff_address, location: { latitude: Number(row.dropoff_lat), longitude: Number(row.dropoff_lng), recordedAt: new Date(row.created_at).toISOString() } },
    status: row.status,
    driverId: row.driver_id ?? undefined,
    pickupPhotoUrl: row.pickup_photo_url ?? undefined,
    receiverPinHash: row.receiver_pin_hash,
    weightKg: row.weight_kg == null ? undefined : Number(row.weight_kg),
    dimensionsCm: row.length_cm == null ? undefined : { length: Number(row.length_cm), width: Number(row.width_cm), height: Number(row.height_cm) },
    isPerishable: Boolean(row.is_perishable),
    receiverConfirmedAt: row.receiver_confirmed_at ? new Date(row.receiver_confirmed_at).toISOString() : undefined,
    quote: row.quote_total_minor == null ? undefined : {
      currency: row.quote_currency ?? "NGN",
      distanceMeters: Number(row.quote_distance_meters),
      durationSeconds: Number(row.quote_duration_seconds),
      baseFareMinor: Number(row.quote_base_fare_minor),
      distanceFareMinor: Number(row.quote_distance_fare_minor),
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
  quote?: StoredDelivery["quote"];
}): Promise<StoredDelivery> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const id = randomUUID();
  const code = "SD-" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const result = await pool.query(
    `INSERT INTO deliveries
      (id, tracking_code, sender_id, receiver_name, receiver_phone,
       pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, status, receiver_pin_hash,
       weight_kg, length_cm, width_cm, height_cm, is_perishable,
       quote_distance_meters, quote_duration_seconds, quote_base_fare_minor,
       quote_distance_fare_minor, quote_service_fee_minor, quote_total_minor, quote_currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CREATED',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     RETURNING *`,
    [id, code, input.senderId, input.receiverName, input.receiverPhone,
      input.pickup.formattedAddress, input.pickup.location.latitude, input.pickup.location.longitude,
      input.dropoff.formattedAddress, input.dropoff.location.latitude, input.dropoff.location.longitude,
      hashPin(input.receiverPin), input.weightKg ?? null, input.dimensionsCm?.length ?? null, input.dimensionsCm?.width ?? null, input.dimensionsCm?.height ?? null, input.isPerishable ?? false, input.quote?.distanceMeters ?? null, input.quote?.durationSeconds ?? null,
      input.quote?.baseFareMinor ?? null, input.quote?.distanceFareMinor ?? null,
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
    `UPDATE drivers SET online=$2 WHERE id=$1 AND status='APPROVED' RETURNING id`,
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
    providerReference: row.provider_reference ?? null
  };
}

export type DisputeRecord = {
  id: string;
  deliveryId: string;
  openedBy: string;
  reason: string;
  description?: string | null;
  status: "OPEN" | "UNDER_REVIEW" | "RESOLVED_REFUND" | "RESOLVED_RELEASE" | "CLOSED";
  resolutionNote?: string | null;
};

function rowToDispute(row: any): DisputeRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    openedBy: row.opened_by,
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

export async function findDispute(deliveryId: string): Promise<DisputeRecord | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM disputes WHERE delivery_id=$1", [deliveryId]);
  return result.rows[0] ? rowToDispute(result.rows[0]) : null;
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

export async function findPayout(deliveryId: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM payouts WHERE delivery_id=$1", [deliveryId]);
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function markPayoutReleased(deliveryId: string, providerReference: string): Promise<PayoutRecord | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE payouts
     SET status='RELEASED', provider_reference=$2, updated_at=now()
     WHERE delivery_id=$1 AND status IN ('ELIGIBLE','PROCESSING')
     RETURNING *`,
    [deliveryId, providerReference]
  );
  return result.rows[0] ? rowToPayout(result.rows[0]) : null;
}

export async function assignNextDeliveryToDriver(driverId: string): Promise<StoredDelivery | null> {
  if (!pool) return null;
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

export async function listOpenJobs(): Promise<StoredDelivery[]> {
  if (!pool) return [];
  const result = await pool.query(
    "SELECT * FROM deliveries WHERE driver_id IS NULL AND status = 'PAYMENT_AUTHORIZED' ORDER BY created_at ASC"
  );
  return result.rows.map(rowToDelivery);
}

export async function transitionDelivery(id: string, from: string, to: string, driverId?: string): Promise<StoredDelivery | null> {
  if (!pool) return null;
  const result = await pool.query(
    `UPDATE deliveries
     SET status=$2, driver_id=COALESCE($3, driver_id), updated_at=now()
     WHERE id=$1 AND status=$4
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
    const result = await client.query(`SELECT d.*, p.amount_minor, p.currency AS payment_currency, p.status AS payment_status FROM deliveries d LEFT JOIN payments p ON p.delivery_id=d.id WHERE d.id=$1 FOR UPDATE`, [id]);
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
