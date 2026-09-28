import { pool } from "./database/db.js";

type PendingNotification = {
  id: string;
  userId: string;
  title: string;
  body: string;
  type: string;
  deliveryId: string | null;
  pushTokens: string[];
  attempts: number;
};

function backoffSeconds(attempts: number): number {
  return Math.min(900, Math.max(5, 5 * 2 ** Math.min(attempts - 1, 7)));
}

export async function enqueueNotification(input: {
  userId: string;
  deliveryId?: string | null;
  title: string;
  body: string;
  type: string;
}): Promise<void> {
  if (!pool) return;
  await pool.query("BEGIN");
  try {
    const notification = await pool.query(
      \`INSERT INTO notifications (user_id, delivery_id, title, body, type)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id\`,
      [input.userId, input.deliveryId ?? null, input.title, input.body, input.type]
    );
    await pool.query(
      "INSERT INTO notification_outbox (notification_id) VALUES ($1)",
      [notification.rows[0].id]
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function sendToExpo(tokens: string[], title: string, body: string, data: Record<string, string | null>): Promise<{ retry: boolean; invalidTokens: string[] }> {
  let retry = false;
  const invalidTokens: string[] = [];

  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100);
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(batch.map(to => ({ to, title, body, sound: "default", data })))
    });

    if (!response.ok) {
      retry = true;
      continue;
    }

    const payload = await response.json() as {
      data?: Array<{ status?: string; details?: { error?: string }; message?: string }>;
    };
    for (const ticket of payload.data ?? []) {
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        const message = ticket.message ?? "";
        const token = batch.find(candidate => message.includes(candidate));
        if (token) invalidTokens.push(token);
      } else if (ticket.status === "error") {
        retry = true;
      }
    }
  }

  return { retry, invalidTokens };
}

export async function processNotificationOutbox(): Promise<void> {
  if (!pool) return;

  const result = await pool.query(
    \`WITH picked AS (
       SELECT ob.id
         FROM notification_outbox ob
        WHERE ob.sent_at IS NULL
          AND ob.next_attempt_at <= now()
        ORDER BY ob.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 25
     ),
     claimed AS (
       UPDATE notification_outbox ob
          SET attempts=ob.attempts+1,
              next_attempt_at=now()+interval '15 minutes'
         FROM picked
        WHERE ob.id=picked.id
        RETURNING ob.id, ob.notification_id, ob.attempts
     )
     SELECT claimed.id, n.user_id AS "userId", n.title, n.body, n.type,
            n.delivery_id AS "deliveryId", claimed.attempts,
            COALESCE(array_agg(dt.push_token) FILTER (WHERE dt.push_token IS NOT NULL), '{}') AS "pushTokens"
       FROM claimed
       JOIN notifications n ON n.id=claimed.notification_id
       LEFT JOIN device_tokens dt ON dt.user_id=n.user_id
      GROUP BY claimed.id, n.id, n.user_id, n.title, n.body, n.type, n.delivery_id, claimed.attempts\`,
    []
  );

  for (const row of result.rows as PendingNotification[]) {
    const attempts = Number(row.attempts);
    if (!row.pushTokens?.length) {
      await pool.query("UPDATE notification_outbox SET sent_at=now(), attempts=$2, last_error=NULL WHERE id=$1", [row.id, attempts]);
      continue;
    }

    await pool.query(
      "UPDATE notification_outbox SET attempts=$2, next_attempt_at=now()+($3 * interval '1 second') WHERE id=$1",
      [row.id, attempts, backoffSeconds(attempts)]
    );

    try {
      const outcome = await sendToExpo(row.pushTokens, row.title, row.body, {
        type: row.type,
        deliveryId: row.deliveryId
      });
      if (outcome.invalidTokens.length) {
        await pool.query("DELETE FROM device_tokens WHERE push_token = ANY($1::text[])", [outcome.invalidTokens]);
      }
      if (outcome.retry) {
        await pool.query(
          "UPDATE notification_outbox SET next_attempt_at=now()+($2 * interval '1 second'), last_error=$3 WHERE id=$1",
          [row.id, backoffSeconds(attempts), "Expo reported one or more push delivery errors"]
        );
      } else {
        await pool.query(
          "UPDATE notification_outbox SET sent_at=now(), last_error=NULL WHERE id=$1",
          [row.id]
        );
      }
    } catch (error) {
      await pool.query(
        "UPDATE notification_outbox SET last_error=$2 WHERE id=$1",
        [row.id, error instanceof Error ? error.message.slice(0, 500) : "Push delivery failed"]
      );
    }
  }
}
