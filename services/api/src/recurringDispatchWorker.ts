import { pool } from "./database/db.js";

function nextFutureRun(nextRunAt: Date, cadenceMinutes: number): Date {
  const cadenceMs = cadenceMinutes * 60_000;
  let next = nextRunAt.getTime() + cadenceMs;
  const now = Date.now();
  while (next <= now) next += cadenceMs;
  return new Date(next);
}

export async function processRecurringDispatches(limit = 10): Promise<number> {
  if (!pool) return 0;
  const client = await pool.connect();
  let processed = 0;
  try {
    await client.query("BEGIN");
    const due = await client.query(
      `SELECT rd.*, ba.status AS business_status
         FROM business_recurring_dispatches rd
         JOIN business_accounts ba ON ba.id=rd.business_id
        WHERE rd.active=true AND rd.next_run_at <= now() AND ba.status='ACTIVE'
        ORDER BY rd.next_run_at ASC
        LIMIT $1
        FOR UPDATE OF rd SKIP LOCKED`,
      [Math.min(Math.max(limit, 1), 25)]
    );

    for (const rule of due.rows) {
      const template = rule.template ?? {};
      const deliveryIds = Array.isArray(template.deliveryIds)
        ? template.deliveryIds.filter((v: unknown) => typeof v === "string")
        : [];
      const buyOrderIds = Array.isArray(template.buyOrderIds)
        ? template.buyOrderIds.filter((v: unknown) => typeof v === "string")
        : [];

      const deliveries = deliveryIds.length
        ? await client.query(
            `SELECT id, quote_total_minor, status
               FROM deliveries
              WHERE id=ANY($1::uuid[])
                AND status IN ('PAYMENT_AUTHORIZED','DRIVER_ASSIGNED')
                AND sender_id IN (
                  SELECT user_id FROM business_members
                   WHERE business_id=$2 AND active=true
                )`,
            [deliveryIds, rule.business_id]
          )
        : { rows: [] as any[] };

      const buyOrders = buyOrderIds.length
        ? await client.query(
            `SELECT id, purchase_budget_minor, status
               FROM buy_orders
              WHERE id=ANY($1::uuid[]) AND business_id=$2`,
            [buyOrderIds, rule.business_id]
          )
        : { rows: [] as any[] };

      const resolvedDeliveryIds = deliveries.rows.map((row: any) => row.id);
      const resolvedBuyOrderIds = buyOrders.rows.map((row: any) => row.id);
      const estimatedTotalMinor =
        deliveries.rows.reduce((sum: number, row: any) => sum + Number(row.quote_total_minor ?? 0), 0) +
        buyOrders.rows.reduce((sum: number, row: any) => sum + Number(row.purchase_budget_minor ?? 0), 0);

      const nextRunAt = nextFutureRun(new Date(rule.next_run_at), Number(rule.cadence_minutes));
      const plan = await client.query(
        `INSERT INTO business_dispatch_plans
          (business_id, created_by_user_id, status, approval_required, estimated_total_minor, plan)
         VALUES ($1,$2,'PREPARED',$3,$4,$5::jsonb)
         RETURNING id`,
        [
          rule.business_id,
          rule.created_by_user_id,
          Boolean(rule.approval_required),
          estimatedTotalMinor,
          JSON.stringify({
            recurringDispatchId: rule.id,
            name: rule.name,
            deliveryIds: resolvedDeliveryIds,
            buyOrderIds: resolvedBuyOrderIds,
            skippedDeliveryIds: deliveryIds.filter((id: string) => !resolvedDeliveryIds.includes(id)),
            skippedBuyOrderIds: buyOrderIds.filter((id: string) => !resolvedBuyOrderIds.includes(id)),
            generatedAt: new Date().toISOString()
          })
        ]
      );

      await client.query(
        `UPDATE business_recurring_dispatches
            SET last_run_at=now(),
                last_dispatch_plan_id=$2,
                next_run_at=$3,
                updated_at=now()
          WHERE id=$1`,
        [rule.id, plan.rows[0].id, nextRunAt]
      );
      processed += 1;
    }
    await client.query("COMMIT");
    return processed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
