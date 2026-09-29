import { pool } from "./database/db.js";

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
      const deliveryIds = Array.isArray(template.deliveryIds) ? template.deliveryIds.filter((v: unknown) => typeof v === "string") : [];
      const buyOrderIds = Array.isArray(template.buyOrderIds) ? template.buyOrderIds.filter((v: unknown) => typeof v === "string") : [];
      const plan = await client.query(
        `INSERT INTO business_dispatch_plans
          (business_id, created_by_user_id, status, approval_required, estimated_total_minor, plan)
         VALUES ($1,$2,'PREPARED',$3,0,$4::jsonb)
         RETURNING id`,
        [rule.business_id, rule.created_by_user_id, Boolean(rule.approval_required), JSON.stringify({
          recurringDispatchId: rule.id,
          name: rule.name,
          deliveryIds,
          buyOrderIds,
          generatedAt: new Date().toISOString()
        })]
      );
      await client.query(
        `UPDATE business_recurring_dispatches
            SET last_run_at=now(),
                last_dispatch_plan_id=$2,
                next_run_at=next_run_at + make_interval(mins => cadence_minutes),
                updated_at=now()
          WHERE id=$1`,
        [rule.id, plan.rows[0].id]
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
