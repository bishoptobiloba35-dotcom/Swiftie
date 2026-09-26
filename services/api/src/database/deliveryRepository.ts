import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
import { hashPin, verifyPin } from "../security.js";

export type StoredDelivery = {
  id: string;
  trackingCode: string;
  senderId: string;
  receiverName: string;
  receiverPhone: string;
  pickup: { label: string; formattedAddress: string };
  dropoff: { label: string; formattedAddress: string };
  status: string;
  driverId?: string;
  pickupPhotoUrl?: string;
  receiverPinHash: string;
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
    pickup: { label: "Pickup", formattedAddress: row.pickup_address },
    dropoff: { label: "Drop-off", formattedAddress: row.dropoff_address },
    status: row.status,
    driverId: row.driver_id ?? undefined,
    pickupPhotoUrl: row.pickup_photo_url ?? undefined,
    receiverPinHash: row.receiver_pin_hash,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export function databaseEnabled(): boolean {
  return Boolean(pool);
}

export async function createPersistentDelivery(input: {
  senderId: string;
  receiverName: string;
  receiverPhone: string;
  pickup: { label: string; formattedAddress: string };
  dropoff: { label: string; formattedAddress: string };
  receiverPin: string;
}): Promise<StoredDelivery> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const id = randomUUID();
  const code = "SD-" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const result = await pool.query(
    `INSERT INTO deliveries
      (id, tracking_code, sender_id, receiver_name, receiver_phone,
       pickup_address, dropoff_address, status, receiver_pin_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'CREATED',$8)
     RETURNING *`,
    [id, code, input.senderId, input.receiverName, input.receiverPhone,
      input.pickup.formattedAddress, input.dropoff.formattedAddress, hashPin(input.receiverPin)]
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

export async function listOpenJobs(): Promise<StoredDelivery[]> {
  if (!pool) return [];
  const result = await pool.query(
    "SELECT * FROM deliveries WHERE driver_id IS NULL AND status IN ('CREATED','PAYMENT_AUTHORIZED') ORDER BY created_at ASC"
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
