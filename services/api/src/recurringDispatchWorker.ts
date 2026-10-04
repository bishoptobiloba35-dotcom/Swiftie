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
      await client.query("SAVEPOINT recurring_rule");
      try {
        const template = rule.template ?? {};
      const deliveryIds = Array.isArray(template.deliveryIds)
        ? template.deliveryIds.filter((v: unknown) => typeof v === "string")
        : [];
      const buyOrderIds = Array.isArray(template.buyOrderIds)
        ? template.buyOrderIds.filter((v: unknown) => typeof v === "string")
        : [];
      const buyOrderTemplates = Array.isArray(template.buyOrderTemplates)
        ? template.buyOrderTemplates.slice(0, 25)
        : [];

      const creator = await client.query(
        `SELECT bm.member_role, bm.active, bm.spend_limit_minor, ba.status, ba.monthly_spend_limit_minor, ba.per_order_limit_minor
           FROM business_members bm
           JOIN business_accounts ba ON ba.id=bm.business_id
          WHERE bm.business_id=$1 AND bm.user_id=$2`,
        [rule.business_id, rule.created_by_user_id]
      );
      const creatorRow = creator.rows[0];
      if (!creatorRow || !creatorRow.active || creatorRow.status !== "ACTIVE" ||
          !["OWNER", "ADMIN", "DISPATCHER"].includes(creatorRow.member_role)) {
        throw new Error(`Recurring dispatch creator is no longer authorized for business ${rule.business_id}`);
      }

      const existingSpend = await client.query(
        "SELECT COALESCE(SUM(amount_minor),0) AS current_spend FROM business_spend_ledger WHERE business_id=$1 AND created_at >= date_trunc('month', now())",
        [rule.business_id]
      );
      let projectedSpend = Number(existingSpend.rows[0]?.current_spend ?? 0);

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

      const createdBuyOrderIds: string[] = [];
      const skippedBuyOrderTemplates: Array<{ index: number; reason: string }> = [];
      let createdBuyOrderBudgetMinor = 0;
      for (const [index, item] of buyOrderTemplates.entries()) {
        const budget = Number(item?.purchaseBudgetMinor);
        if (!Number.isSafeInteger(budget) || budget <= 0) {
          skippedBuyOrderTemplates.push({ index, reason: "INVALID_PURCHASE_BUDGET" });
          continue;
        }
        if (Number(creatorRow.per_order_limit_minor) > 0 && budget > Number(creatorRow.per_order_limit_minor)) {
          skippedBuyOrderTemplates.push({ index, reason: "PER_ORDER_LIMIT_EXCEEDED" });
          continue;
        }
        if (Number(creatorRow.spend_limit_minor) > 0 && budget > Number(creatorRow.spend_limit_minor)) {
          skippedBuyOrderTemplates.push({ index, reason: "MEMBER_SPEND_LIMIT_EXCEEDED" });
          continue;
        }
        if (projectedSpend + budget > Number(creatorRow.monthly_spend_limit_minor) && Number(creatorRow.monthly_spend_limit_minor) > 0) {
          skippedBuyOrderTemplates.push({ index, reason: "MONTHLY_BUSINESS_LIMIT_EXCEEDED" });
          continue;
        }

        const created = await client.query(
          `INSERT INTO buy_orders
            (customer_user_id, business_id, item_description, merchant_name, merchant_address, purchase_budget_minor, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, purchase_budget_minor, status`,
          [
            rule.created_by_user_id,
            rule.business_id,
            String(item.itemDescription ?? "").trim(),
            item.merchantName ? String(item.merchantName).trim() : null,
            item.merchantAddress ? String(item.merchantAddress).trim() : null,
            budget,
            item.notes ? String(item.notes).trim() : null
          ]
        );
        if (created.rows[0]) {
          createdBuyOrderIds.push(created.rows[0].id);
          createdBuyOrderBudgetMinor += budget;
          projectedSpend += budget;
          await client.query(
            `INSERT INTO business_spend_ledger
              (business_id, user_id, reference_type, reference_id, amount_minor, currency)
             VALUES ($1,$2,'BUY_ORDER_RESERVATION',$3,$4,'NGN')`,
            [rule.business_id, rule.created_by_user_id, created.rows[0].id, budget]
          );
          await client.query(
            `INSERT INTO buy_order_events
              (buy_order_id, actor_user_id, event_type, metadata)
             VALUES ($1,$2,'CREATED_BY_RECURRING_DISPATCH',$3::jsonb)`,
            [created.rows[0].id, rule.created_by_user_id, JSON.stringify({ recurringDispatchId: rule.id, source: "RECURRING_DISPATCH" })]
          );
        }
      }

      const resolvedDeliveryIds = deliveries.rows.map((row: any) => row.id);
      const resolvedBuyOrderIds = [...buyOrders.rows.map((row: any) => row.id), ...createdBuyOrderIds];
      const skippedDeliveryIds = deliveryIds.filter((id: string) => !resolvedDeliveryIds.includes(id));
      const skippedBuyOrderIds = buyOrderIds.filter((id: string) => !resolvedBuyOrderIds.includes(id));
      const estimatedTotalMinor =
        deliveries.rows.reduce((sum: number, row: any) => sum + Number(row.quote_total_minor ?? 0), 0) +
        buyOrders.rows.reduce((sum: number, row: any) => sum + Number(row.purchase_budget_minor ?? 0), 0) +
        createdBuyOrderBudgetMinor;

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
            createdBuyOrderIds,
            requiresPaymentAuthorization: createdBuyOrderIds.length > 0,
            skippedDeliveryIds,
            skippedBuyOrderIds,
            skippedBuyOrderTemplates,

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
        await client.query("RELEASE SAVEPOINT recurring_rule");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT recurring_rule");
        const nextRetryAt = nextFutureRun(new Date(rule.next_run_at), Math.max(1, Number(rule.cadence_minutes)));
        await client.query(
          `UPDATE business_recurring_dispatches
              SET last_run_at=now(),
                  next_run_at=$2,
                  updated_at=now()
            WHERE id=$1`,
          [rule.id, nextRetryAt]
        );
        await client.query(
          `INSERT INTO ai_audit_log
            (user_id, plan, capability, action, allowed, reason, metadata)
           VALUES ($1,(SELECT ai_plan FROM users WHERE id=$1),'ACTION','RECURRING_DISPATCH_WORKER',false,'Recurring dispatch execution failed',$2::jsonb)`,
          [rule.created_by_user_id, JSON.stringify({
            recurringDispatchId: rule.id,
            error: error instanceof Error ? error.message : "Unknown recurring dispatch error",
            retryAt: nextRetryAt.toISOString()
          })]
        );
      }
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
