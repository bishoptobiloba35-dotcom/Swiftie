import { pool, withDatabase } from "./database/db.js";

type ExpoTicket = { ticketId: string; token: string };
type PendingNotification = { id: string; userId: string; title: string; body: string; type: string; deliveryId: string | null; pushTokens: string[]; attempts: number };
const MAX_NOTIFICATION_ATTEMPTS = 8;

export function backoffSeconds(attempts: number): number {
  return Math.min(900, Math.max(5, 5 * 2 ** Math.min(attempts - 1, 8)));
}

export function notificationAttemptOutcome(input: { attempts: number; retry: boolean; error?: string | null }): { state: "SENT" | "RETRY" | "FAILED"; delaySeconds?: number; error?: string } {
  if (!input.retry) return { state: "SENT" };
  if (input.attempts >= MAX_NOTIFICATION_ATTEMPTS) {
    return { state: "FAILED", error: input.error ?? "Notification delivery retry limit exhausted" };
  }
  return { state: "RETRY", delaySeconds: backoffSeconds(input.attempts), error: input.error ?? "Expo reported one or more push delivery errors" };
}

export async function enqueueNotification(input: { userId: string; deliveryId?: string | null; title: string; body: string; type: string }): Promise<void> {
  if (!pool) return;
  await withDatabase(async client => {
    await client.query("BEGIN");
    try {
      const notification = await client.query(
        `INSERT INTO notifications (user_id, delivery_id, title, body, type)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [input.userId, input.deliveryId ?? null, input.title, input.body, input.type]
      );
      await client.query("INSERT INTO notification_outbox (notification_id) VALUES ($1)", [notification.rows[0].id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function sendToExpo(tokens: string[], title: string, body: string, data: Record<string, string | null>): Promise<{ retry: boolean; invalidTokens: string[]; tickets: ExpoTicket[] }> {
  let retry = false;
  const invalidTokens: string[] = [];
  const tickets: ExpoTicket[] = [];
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100);
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(batch.map(to => ({ to, title, body, sound: "default", data })))
    });
    if (!response.ok) { retry = true; continue; }
    const payload = await response.json() as { data?: Array<{ status?: string; id?: string; details?: { error?: string }; message?: string }> };
    for (let index = 0; index < (payload.data ?? []).length; index += 1) {
      const ticket = payload.data![index];
      const token = batch[index];
      if (ticket.status === "ok" && ticket.id && token) tickets.push({ ticketId: ticket.id, token });
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        if (token) invalidTokens.push(token);
      } else if (ticket.status === "error") retry = true;
    }
  }
  return { retry, invalidTokens, tickets };
}

export async function processNotificationOutbox(): Promise<void> {
  if (!pool) return;
  const result = await pool.query(
    `WITH picked AS (
       SELECT ob.id FROM notification_outbox ob
        WHERE ob.sent_at IS NULL AND ob.failed_at IS NULL
          AND ob.next_attempt_at <= now() AND ob.attempts < $1
        ORDER BY ob.created_at FOR UPDATE SKIP LOCKED LIMIT 25
     ),
     claimed AS (
       UPDATE notification_outbox ob
          SET attempts=ob.attempts+1, next_attempt_at=now()+interval '15 minutes'
         FROM picked WHERE ob.id=picked.id
         RETURNING ob.id, ob.notification_id, ob.attempts
     )
     SELECT claimed.id, n.user_id AS "userId", n.title, n.body, n.type,
            n.delivery_id AS "deliveryId", claimed.attempts,
            COALESCE(array_agg(dt.push_token) FILTER (WHERE dt.push_token IS NOT NULL), '{}') AS "pushTokens"
       FROM claimed JOIN notifications n ON n.id=claimed.notification_id
       LEFT JOIN device_tokens dt ON dt.user_id=n.user_id
      GROUP BY claimed.id, n.id, n.user_id, n.title, n.body, n.type, n.delivery_id, claimed.attempts`,
    [MAX_NOTIFICATION_ATTEMPTS]
  );

  for (const row of result.rows as PendingNotification[]) {
    const attempts = Number(row.attempts);
    if (!row.pushTokens?.length) {
      await pool.query("UPDATE notification_outbox SET sent_at=now(), last_error=NULL WHERE id=$1", [row.id]);
      continue;
    }
    try {
      const outcome = await sendToExpo(row.pushTokens, row.title, row.body, { type: row.type, deliveryId: row.deliveryId });
      if (outcome.invalidTokens.length) await pool.query("DELETE FROM device_tokens WHERE push_token = ANY($1::text[])", [outcome.invalidTokens]);
      if (outcome.tickets.length) {
        await pool.query(
          `INSERT INTO notification_push_receipts (outbox_id, push_token, ticket_id)
           SELECT $1, item->>'token', item->>'ticketId'
           FROM jsonb_array_elements($2::jsonb) AS item
           ON CONFLICT (outbox_id, ticket_id) DO NOTHING`,
          [row.id, JSON.stringify(outcome.tickets)]
        );
      }
      const decision = notificationAttemptOutcome({ attempts, retry: outcome.retry });
      if (decision.state === "FAILED") {
        await pool.query("UPDATE notification_outbox SET failed_at=now(), last_error=$2 WHERE id=$1", [row.id, decision.error]);
      } else if (decision.state === "RETRY") {
        await pool.query(
          "UPDATE notification_outbox SET next_attempt_at=now()+($2 * interval '1 second'), last_error=$3 WHERE id=$1",
          [row.id, decision.delaySeconds, decision.error]
        );
      } else {
        await pool.query("UPDATE notification_outbox SET sent_at=now(), last_error=NULL WHERE id=$1", [row.id]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Push delivery failed";
      if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
        await pool.query("UPDATE notification_outbox SET failed_at=now(), last_error=$2 WHERE id=$1", [row.id, message]);
      } else {
        await pool.query(
          "UPDATE notification_outbox SET next_attempt_at=now()+($2 * interval '1 second'), last_error=$3 WHERE id=$1",
          [row.id, backoffSeconds(attempts), message]
        );
      }
    }
  }
}

export async function processNotificationPushReceipts(): Promise<void> {
  if (!pool) return;
  const result = await pool.query(
    `SELECT id, outbox_id AS "outboxId", push_token AS "pushToken", ticket_id AS "ticketId"
       FROM notification_push_receipts WHERE checked_at IS NULL ORDER BY created_at LIMIT 100`
  );
  const rows = result.rows as Array<{ id: string; outboxId: string; pushToken: string; ticketId: string }>;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ids: batch.map(row => row.ticketId) })
      });
      if (!response.ok) continue;
      const payload = await response.json() as { data?: Record<string, { status?: string; message?: string; details?: { error?: string } }> };
      for (const row of batch) {
        const receipt = payload.data?.[row.ticketId];
        if (!receipt || !receipt.status || receipt.status === "pending") continue;
        await pool.query(
          `UPDATE notification_push_receipts SET status=$2, error_code=$3, message=$4, checked_at=now() WHERE id=$1`,
          [row.id, receipt.status, receipt.details?.error ?? null, receipt.message ?? null]
        );
        if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
          await pool.query("DELETE FROM device_tokens WHERE push_token=$1", [row.pushToken]);
        }
      }
    } catch {}
  }
}
