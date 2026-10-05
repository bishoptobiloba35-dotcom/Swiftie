import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./database/db.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";
import { deletePrivateObject, getPrivateObject, putPrivateObject } from "./storage.js";

const router = Router();

function orderId(req: any): string {
  return String(req.params.id ?? "").trim();
}

async function getAgent(userId: string) {
  if (!pool) return null;
  const result = await pool.query(
    "SELECT ap.*, u.full_name, u.phone FROM agent_profiles ap JOIN users u ON u.id=ap.user_id WHERE ap.user_id=$1",
    [userId]
  );
  return result.rows[0] ?? null;
}

async function getOrder(id: string) {
  if (!pool) return null;
  const result = await pool.query("SELECT * FROM buy_orders WHERE id=$1", [id]);
  return result.rows[0] ?? null;
}

router.get("/agents", requireAuth("ADMIN"), async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const result = await pool.query(
    `SELECT ap.*, u.full_name, u.phone, u.email
       FROM agent_profiles ap
       JOIN users u ON u.id=ap.user_id
      ORDER BY ap.created_at DESC
      LIMIT 200`
  );
  res.json({ agents: result.rows });
});

router.post("/agents/:id/status", requireAuth("ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const parsed = z.object({ status: z.enum(["APPROVED", "SUSPENDED", "PENDING"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await pool.query(
    "UPDATE agent_profiles SET status=$2, updated_at=now() WHERE id=$1 RETURNING *",
    [orderId(req), parsed.data.status]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Agent profile not found" });
  res.json({ agent: result.rows[0] });
});

router.get("/agent/settlement-account", requireAuth("AGENT"), async (req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const agent=await getAgent(identity(req)); if(!agent)return res.status(404).json({error:"Agent profile not found"});
  const result=await pool.query("SELECT id,bank_code,bank_name,account_name,account_last4,currency,active,verified_at,created_at,updated_at FROM agent_settlement_accounts WHERE agent_id=$1",[agent.id]);
  res.json({account:result.rows[0]??null});
});
router.post("/agent/settlement-account", requireAuth("AGENT"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const agent=await getAgent(identity(req)); if(!agent||agent.status!=="APPROVED")return res.status(403).json({error:"Approved agent status is required"});
  const parsed=z.object({bankCode:z.string().regex(/^\\d{3,6}$/),accountNumber:z.string().regex(/^\\d{10}$/)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"A valid Nigerian bank code and 10-digit account number are required"});
  const secret=process.env.PAYSTACK_SECRET_KEY;if(!secret)return res.status(503).json({error:"Paystack transfers are not configured"});
  const resolvedResponse=await fetch("https://api.paystack.co/bank/resolve?account_number="+encodeURIComponent(parsed.data.accountNumber)+"&bank_code="+encodeURIComponent(parsed.data.bankCode),{headers:{authorization:"Bearer "+secret}});
  const resolved=await resolvedResponse.json() as any;
  if(!resolvedResponse.ok||!resolved.status||!resolved.data?.account_name)return res.status(400).json({error:resolved.message??"Unable to verify the bank account"});
  const recipientResponse=await fetch("https://api.paystack.co/transferrecipient",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({type:"nuban",name:resolved.data.account_name,account_number:parsed.data.accountNumber,bank_code:parsed.data.bankCode,currency:"NGN"})});
  const recipient=await recipientResponse.json() as any;
  if(!recipientResponse.ok||!recipient.status||!recipient.data?.recipient_code)return res.status(400).json({error:recipient.message??"Unable to create payout recipient"});
  const result=await pool.query(`INSERT INTO agent_settlement_accounts(agent_id,recipient_code,bank_code,bank_name,account_name,account_last4,currency,active,verified_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'NGN',true,now(),now())
    ON CONFLICT(agent_id) DO UPDATE SET recipient_code=EXCLUDED.recipient_code,bank_code=EXCLUDED.bank_code,bank_name=EXCLUDED.bank_name,account_name=EXCLUDED.account_name,account_last4=EXCLUDED.account_last4,currency='NGN',active=true,verified_at=now(),updated_at=now()
    RETURNING id,bank_code,bank_name,account_name,account_last4,currency,active,verified_at,created_at,updated_at`,
    [agent.id,recipient.data.recipient_code,parsed.data.bankCode,recipient.data.details?.bank_name??null,resolved.data.account_name,parsed.data.accountNumber.slice(-4)]);
  res.status(201).json({account:result.rows[0]});
});
router.get("/agent/settlements", requireAuth("AGENT"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const agent=await getAgent(identity(req));if(!agent)return res.status(404).json({error:"Agent profile not found"});
  const result=await pool.query("SELECT bos.id,bos.buy_order_id,bos.amount_minor,bos.currency,bos.status,bos.provider_reference,bos.provider_status,bos.failure_reason,bos.paid_at,bos.created_at,bos.updated_at FROM buy_order_settlements bos WHERE bos.agent_id=$1 ORDER BY bos.created_at DESC LIMIT 100",[agent.id]);
  res.json({settlements:result.rows});
});



router.post("/agent/buy-orders/:id/replacement", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent || agent.status !== "APPROVED") return res.status(403).json({ error: "Approved agent status is required" });
  const parsed = z.object({
    itemId: z.string().uuid(),
    proposedDescription: z.string().trim().min(1).max(500),
    proposedQuantity: z.number().int().positive().max(1000).default(1),
    proposedPriceMinor: z.number().int().nonnegative(),
    evidenceFile: z.string().optional(),
    shopperNote: z.string().trim().max(1000).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await getOrder(orderId(req));
  if (!order || order.agent_id !== agent.id) return res.status(404).json({ error: "Errand not found" });
  if (!["AGENT_ASSIGNED","PURCHASING"].includes(order.status)) return res.status(409).json({ error: "Errand is not in a shopping state" });

  const item = (await pool.query("SELECT * FROM buy_order_items WHERE id=$1 AND buy_order_id=$2 FOR UPDATE", [parsed.data.itemId, order.id])).rows[0];
  if (!item) return res.status(404).json({ error: "Errand item not found" });

  let evidenceKey: string | null = null;
  if (parsed.data.evidenceFile) {
    const match = parsed.data.evidenceFile.match(/^data:(image\/(?:jpeg|jpg|png));base64,(.+)$/i);
    if (!match) return res.status(400).json({ error: "Replacement evidence must be a JPEG or PNG data URL" });
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: "Replacement evidence must be between 1 byte and 8MB" });
    const extension = match[1].includes("png") ? "png" : "jpg";
    evidenceKey = `buy-orders/${order.id}/replacements/${randomUUID()}.${extension}`;
    await putPrivateObject(evidenceKey, buffer, match[1]);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = (await client.query("SELECT * FROM buy_order_items WHERE id=$1 AND buy_order_id=$2 FOR UPDATE", [item.id, order.id])).rows[0];
    if (!locked || locked.status === "PURCHASED" || locked.status === "REFUNDED") {
      await client.query("ROLLBACK");
      if (evidenceKey) await deletePrivateObject(evidenceKey).catch(() => undefined);
      return res.status(409).json({ error: "Errand item can no longer be changed" });
    }
    const automatic = locked.replacement_policy === "BEST_MATCH"
      && parsed.data.proposedPriceMinor <= Number(order.purchase_budget_minor)
      && parsed.data.proposedPriceMinor <= Number(locked.max_authorized_minor ?? order.purchase_budget_minor);

    const status = automatic ? "APPROVED" : "PENDING";
    const inserted = await client.query(
      `INSERT INTO buy_order_replacement_options
        (item_id, proposed_description, proposed_quantity, proposed_price_minor, currency, evidence_key, shopper_note, status, proposed_by_agent_id, approved_by_user_id, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, item_id, proposed_description, proposed_quantity, proposed_price_minor, currency, shopper_note, status, created_at`,
      [locked.id, parsed.data.proposedDescription, parsed.data.proposedQuantity, parsed.data.proposedPriceMinor, order.currency ?? "NGN", evidenceKey, parsed.data.shopperNote ?? null, status, agent.id, automatic ? order.customer_user_id : null, automatic ? new Date() : null]
    );
    await client.query(
      "UPDATE buy_order_items SET status=$2,updated_at=now() WHERE id=$1",
      [locked.id, automatic ? "APPROVED" : "REPLACEMENT_PENDING"]
    );
    await client.query(
      "UPDATE buy_orders SET replacement_review_required=$2,replacement_review_deadline=$3,updated_at=now() WHERE id=$1",
      [order.id, !automatic, automatic ? null : new Date(Date.now() + 15 * 60 * 1000)]
    );
    await client.query(
      "INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,$3,$4::jsonb)",
      [order.id, identity(req), automatic ? "REPLACEMENT_AUTO_APPROVED" : "REPLACEMENT_PROPOSED", JSON.stringify({ itemId: locked.id, replacementId: inserted.rows[0].id, priceMinor: parsed.data.proposedPriceMinor })]
    );
    await client.query("COMMIT");
    return res.status(201).json({ replacement: inserted.rows[0], approvalRequired: !automatic });
  } catch (error) {
    await client.query("ROLLBACK");
    if (evidenceKey) await deletePrivateObject(evidenceKey).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

router.post("/buy-orders/:id/replacement/:replacementId/decision", requireAuth("CUSTOMER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const decision = z.object({ decision: z.enum(["APPROVE","REFUND"]) }).safeParse(req.body);
  if (!decision.success) return res.status(400).json({ error: decision.error.flatten() });
  const id = orderId(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = (await client.query(
      `SELECT r.*, i.buy_order_id, i.replacement_policy, i.status AS item_status, bo.customer_user_id, bo.purchase_budget_minor
         FROM buy_order_replacement_options r
         JOIN buy_order_items i ON i.id=r.item_id
         JOIN buy_orders bo ON bo.id=i.buy_order_id
        WHERE r.id=$1 AND bo.id=$2
        FOR UPDATE OF r,i,bo`,
      [String(req.params.replacementId), id]
    )).rows[0];
    if (!result || result.customer_user_id !== identity(req)) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Replacement request not found" });
    }
    if (result.status !== "PENDING") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Replacement request is no longer pending" });
    }
    if (decision.data.decision === "APPROVE") {
      if (Number(result.proposed_price_minor) > Number(result.purchase_budget_minor)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Approved replacement exceeds the errand spending ceiling", code: "SPENDING_CEILING_EXCEEDED" });
      }
      await client.query("UPDATE buy_order_replacement_options SET status='APPROVED',approved_by_user_id=$2,approved_at=now(),updated_at=now() WHERE id=$1",[result.id,identity(req)]);
      await client.query("UPDATE buy_order_items SET status='APPROVED',updated_at=now() WHERE id=$1",[result.item_id]);
      await client.query("UPDATE buy_orders SET replacement_review_required=false,replacement_review_deadline=NULL,updated_at=now() WHERE id=$1",[id]);
      await client.query("INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,'REPLACEMENT_APPROVED',$3::jsonb)",[id,identity(req),JSON.stringify({replacementId:result.id,itemId:result.item_id})]);
    } else {
      await client.query("UPDATE buy_order_replacement_options SET status='REFUNDED',approved_by_user_id=$2,approved_at=now(),updated_at=now() WHERE id=$1",[result.id,identity(req)]);
      await client.query("UPDATE buy_order_items SET status='REFUNDED',updated_at=now() WHERE id=$1",[result.item_id]);
      await client.query("UPDATE buy_orders SET replacement_review_required=false,replacement_review_deadline=NULL,updated_at=now() WHERE id=$1",[id]);
      await client.query("INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,'ITEM_REFUND_REQUESTED',$3::jsonb)",[id,identity(req),JSON.stringify({replacementId:result.id,itemId:result.item_id})]);
    }
    await client.query("COMMIT");
    return res.json({ ok: true, decision: decision.data.decision });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
\nrouter.get("/agent/buy-orders", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent) return res.status(404).json({ error: "Agent profile not found" });
  const result = await pool.query(
    `SELECT * FROM buy_orders
      WHERE (agent_id=$1 AND status IN ('AGENT_ASSIGNED','PURCHASING','PURCHASED','IN_TRANSIT','DELIVERED','DISPUTED'))
         OR (agent_id IS NULL AND status IN ('REQUESTED','APPROVED'))
      ORDER BY created_at ASC
      LIMIT 100`,
    [agent.id]
  );
  res.json({ buyOrders: result.rows });
});

router.post("/buy-orders/:id/claim", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent || agent.status !== "APPROVED") return res.status(403).json({ error: "Approved agent status is required" });
  const id = orderId(req);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM buy_orders WHERE id=$1 FOR UPDATE", [id]);
    const order = locked.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Buy & Deliver order not found" });
    }
    if (order.agent_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This order is already assigned" });
    }
    if (!["REQUESTED", "APPROVED"].includes(order.status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This order is not available for assignment" });
    }
    if (order.payment_status !== "HELD") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Customer payment must be held before an agent can be assigned", code: "PAYMENT_NOT_HELD" });
    }
    const updated = await client.query(
      `UPDATE buy_orders
          SET agent_id=$2, status='AGENT_ASSIGNED', assigned_at=now(), updated_at=now()
        WHERE id=$1 AND agent_id IS NULL
        RETURNING *`,
      [id, agent.id]
    );
    if (!updated.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Order assignment lost a concurrency race" });
    }
    await client.query(
      "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'AGENT_ASSIGNED',$3::jsonb)",
      [id, identity(req), JSON.stringify({ agentId: agent.id })]
    );
    await client.query(
      "INSERT INTO agent_action_events (agent_id, buy_order_id, action, metadata) VALUES ($1,$2,'CLAIM',$3::jsonb)",
      [agent.id, id, JSON.stringify({ status: "AGENT_ASSIGNED" })]
    );
    await client.query("COMMIT");
    return res.status(200).json({ buyOrder: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.post("/buy-orders/:id/accept", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent || agent.status !== "APPROVED") return res.status(403).json({ error: "Approved agent status is required" });
  const id = orderId(req);
  const result = await pool.query(
    `UPDATE buy_orders
        SET status='PURCHASING', updated_at=now()
      WHERE id=$1 AND agent_id=$2 AND status='AGENT_ASSIGNED'
      RETURNING *`,
    [id, agent.id]
  );
  if (!result.rows[0]) return res.status(409).json({ error: "Order is not assigned to this agent or cannot be accepted" });
  await pool.query(
    "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'PURCHASING_STARTED','{}'::jsonb)",
    [id, identity(req)]
  );
  await pool.query(
    "INSERT INTO agent_action_events (agent_id, buy_order_id, action, metadata) VALUES ($1,$2,'ACCEPT','{}'::jsonb)",
    [agent.id, id]
  );
  res.json({ buyOrder: result.rows[0] });
});

router.post("/buy-orders/:id/purchase", requireAuth("AGENT"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const agent = await getAgent(identity(req));
  if (!agent || agent.status !== "APPROVED") return res.status(403).json({ error: "Approved agent status is required" });
  const parsed = z.object({
    actualPurchaseMinor: z.number().int().positive(),
    receiptFile: z.string().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = orderId(req);
  const order = await getOrder(id);
  if (!order || order.agent_id !== agent.id) return res.status(404).json({ error: "Buy & Deliver order not found" });
  if (order.status !== "PURCHASING") return res.status(409).json({ error: "Order must be in purchasing state" });
  if (order.errand_type && order.replacement_review_required) return res.status(409).json({ error: "Customer replacement decision is required before purchase can continue", code: "REPLACEMENT_REVIEW_REQUIRED" });
  if (order.errand_type) {
    const pendingItems = await pool.query("SELECT count(*)::int AS count FROM buy_order_items WHERE buy_order_id=$1 AND status='REPLACEMENT_PENDING'", [id]);
    if (Number(pendingItems.rows[0]?.count ?? 0) > 0) return res.status(409).json({ error: "One or more errand items are awaiting customer replacement decisions", code: "ITEM_REPLACEMENT_PENDING" });
  }
  if (order.payment_status !== "HELD") return res.status(409).json({ error: "Customer payment must be held before purchase", code: "PAYMENT_NOT_HELD" });
  if (parsed.data.actualPurchaseMinor > Number(order.purchase_budget_minor)) {
    return res.status(409).json({ error: "Actual purchase amount exceeds the authorized budget", code: "PURCHASE_BUDGET_EXCEEDED" });
  }
  if (parsed.data.actualPurchaseMinor > Number(agent.max_purchase_minor)) {
    return res.status(409).json({ error: "Purchase exceeds this agent's authorized purchase limit", code: "AGENT_PURCHASE_LIMIT_EXCEEDED" });
  }

  let receiptKey: string | null = null;
  if (parsed.data.receiptFile) {
    const match = parsed.data.receiptFile.match(/^data:(image\/(?:jpeg|jpg|png)|application\/pdf);base64,(.+)$/i);
    if (!match) return res.status(400).json({ error: "Receipt must be a JPEG, PNG or PDF data URL" });
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: "Receipt must be between 1 byte and 5MB" });
    const extension = match[1].includes("pdf") ? "pdf" : match[1].includes("png") ? "png" : "jpg";
    receiptKey = `buy-orders/${id}/receipts/${randomUUID()}.${extension}`;
    await putPrivateObject(receiptKey, buffer, match[1]);
  }

  const payment = (await pool.query(
    "SELECT id, amount_minor, currency, status FROM buy_order_payments WHERE buy_order_id=$1",
    [id]
  )).rows[0];
  if (!payment || !["HELD", "AUTHORIZED"].includes(payment.status)) {
    return res.status(409).json({ error: "Customer payment record is unavailable for reconciliation", code: "PAYMENT_RECONCILIATION_REQUIRED" });
  }
  const unusedAuthorizationMinor = Math.max(0, Number(payment.amount_minor) - parsed.data.actualPurchaseMinor);
  let result;
  try {
    result = await pool.query(
      `UPDATE buy_orders
          SET actual_purchase_minor=$2, purchase_receipt_key=COALESCE($3,purchase_receipt_key),
              unused_authorization_minor=$5,
              purchased_at=now(), status='PURCHASED', updated_at=now()
        WHERE id=$1 AND agent_id=$4 AND status='PURCHASING' AND payment_status='HELD'
        RETURNING *`,
      [id, parsed.data.actualPurchaseMinor, receiptKey, agent.id, unusedAuthorizationMinor]
    );
  } catch (error) {
    if (receiptKey) {
      try { await deletePrivateObject(receiptKey); } catch (cleanupError) {
        console.error(JSON.stringify({ event: "buy_order_receipt_cleanup_failed", buyOrderId: id, receiptKey, error: cleanupError instanceof Error ? cleanupError.message : "unknown" }));
      }
    }
    throw error;
  }
  if (!result.rows[0]) {
    if (receiptKey) {
      try { await deletePrivateObject(receiptKey); } catch (cleanupError) {
        console.error(JSON.stringify({ event: "buy_order_receipt_cleanup_failed", buyOrderId: id, receiptKey, error: cleanupError instanceof Error ? cleanupError.message : "unknown" }));
      }
    }
    return res.status(409).json({ error: "Order changed before purchase could be recorded" });
  }

  await pool.query(
    "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'PURCHASE_RECORDED',$3::jsonb)",
    [id, identity(req), JSON.stringify({ actualPurchaseMinor: parsed.data.actualPurchaseMinor, receiptAttached: Boolean(receiptKey), unusedAuthorizationMinor })]
  );
  if (unusedAuthorizationMinor > 0) {
    const paymentReference=(await pool.query("SELECT provider_reference FROM buy_order_payments WHERE id=$1",[payment.id])).rows[0]?.provider_reference as string|undefined;
    if (paymentReference && process.env.PAYSTACK_SECRET_KEY) {
      try {
        const refundResponse=await fetch("https://api.paystack.co/refund",{
          method:"POST",
          headers:{authorization:"Bearer "+process.env.PAYSTACK_SECRET_KEY,"content-type":"application/json"},
          body:JSON.stringify({
            transaction:paymentReference,
            amount:String(unusedAuthorizationMinor),
            currency:payment.currency ?? "NGN",
            customer_note:"Unused Buy & Deliver authorization",
            merchant_note:"SwiftDrop unused Buy & Deliver authorization reconciliation"
          })
        });
        const refundPayload=await refundResponse.json() as {status?:boolean;message?:string;data?:{id?:string;status?:string}};
        if(refundResponse.ok&&refundPayload.status){
          await pool.query(
            "UPDATE buy_order_payments SET refund_status='PENDING',refund_amount_minor=$2,refund_reference=COALESCE(refund_reference,$3),updated_at=now() WHERE id=$1",
            [payment.id,unusedAuthorizationMinor,refundPayload.data?.id??null]
          );
          await pool.query(
            "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'UNUSED_AUTHORIZATION_REFUND_REQUESTED',$3::jsonb)",
            [id,identity(req),JSON.stringify({amountMinor:unusedAuthorizationMinor,refundId:refundPayload.data?.id??null})]
          );
        } else {
          await pool.query(
            "UPDATE buy_order_payments SET refund_status='FAILED',refund_amount_minor=$2,updated_at=now() WHERE id=$1",
            [payment.id,unusedAuthorizationMinor]
          );
          await pool.query(
            "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'UNUSED_AUTHORIZATION_REFUND_FAILED',$3::jsonb)",
            [id,identity(req),JSON.stringify({amountMinor:unusedAuthorizationMinor,message:refundPayload.message??"Paystack refund request failed"})]
          );
        }
      } catch(error) {
        await pool.query("UPDATE buy_order_payments SET refund_status='FAILED',refund_amount_minor=$2,updated_at=now() WHERE id=$1",[payment.id,unusedAuthorizationMinor]);
        await pool.query(
          "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'UNUSED_AUTHORIZATION_REFUND_FAILED',$3::jsonb)",
          [id,identity(req),JSON.stringify({amountMinor:unusedAuthorizationMinor,message:error instanceof Error?error.message:"Paystack refund request failed"})]
        );
      }
    } else {
      await pool.query(
        "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'UNUSED_AUTHORIZATION_RECONCILIATION_REQUIRED',$3::jsonb)",
        [id,identity(req),JSON.stringify({amountMinor:unusedAuthorizationMinor,currency:payment.currency??"NGN"})]
      );
    }
  }
  await pool.query(
    "INSERT INTO agent_action_events (agent_id, buy_order_id, action, metadata) VALUES ($1,$2,'PURCHASE_RECORDED',$3::jsonb)",
    [agent.id, id, JSON.stringify({ actualPurchaseMinor: parsed.data.actualPurchaseMinor })]
  );
  res.status(201).json({ buyOrder: result.rows[0] });
});

router.post("/buy-orders/:id/create-delivery", requireAuth("AGENT"), async (req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const agent=await getAgent(identity(req));
  if(!agent||agent.status!=="APPROVED")return res.status(403).json({error:"Approved agent status is required"});
  const id=orderId(req);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const order=(await client.query("SELECT * FROM buy_orders WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(!order||order.agent_id!==agent.id){await client.query("ROLLBACK");return res.status(404).json({error:"Buy & Deliver order not found"});}
    if(order.status!=="PURCHASED"){await client.query("ROLLBACK");return res.status(409).json({error:"The order must be purchased before delivery is created"});}
    if(order.payment_status!=="HELD"){await client.query("ROLLBACK");return res.status(409).json({error:"Customer payment is not held"});}
    if(order.delivery_id){const existing=(await client.query("SELECT id,tracking_code,status FROM deliveries WHERE id=$1",[order.delivery_id])).rows[0];await client.query("COMMIT");return res.json({delivery:existing,buyOrder:order});}
    if(!order.receiver_name||!order.receiver_phone||!order.receiver_pin_hash||!order.destination_address||order.destination_lat==null||order.destination_lng==null){
      await client.query("ROLLBACK");return res.status(409).json({error:"Receiver and delivery destination details are incomplete",code:"DESTINATION_INCOMPLETE"});
    }
    const deliveryId=randomUUID();
    const trackingCode="SD-"+randomUUID().replaceAll("-","").slice(0,8).toUpperCase();
    const pickupAddress=String(order.merchant_address||order.merchant_name||"Merchant pickup");
    const pickupLat=order.merchant_lat==null?order.destination_lat:order.merchant_lat;
    const pickupLng=order.merchant_lng==null?order.destination_lng:order.merchant_lng;
    const delivery=(await client.query(
      `INSERT INTO deliveries
        (id,tracking_code,sender_id,receiver_name,receiver_phone,pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,status,receiver_pin_hash,weight_kg,is_perishable,quote_currency)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CREATED',$12,0,false,$13)
       RETURNING id,tracking_code,status`,
      [deliveryId,trackingCode,order.customer_user_id,order.receiver_name,order.receiver_phone,pickupAddress,pickupLat,pickupLng,order.destination_address,order.destination_lat,order.destination_lng,order.receiver_pin_hash,order.currency||"NGN"]
    )).rows[0];
    await client.query("UPDATE buy_orders SET delivery_id=$2,updated_at=now() WHERE id=$1",[id,deliveryId]);
    await client.query("INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,'DELIVERY_CREATED',$3::jsonb)",[id,identity(req),JSON.stringify({deliveryId,trackingCode})]);
    await client.query("INSERT INTO delivery_events(delivery_id,event_type,actor_user_id,metadata) VALUES($1,'BUY_AND_DELIVER_CREATED',$2,$3::jsonb)",[deliveryId,identity(req),JSON.stringify({buyOrderId:id,agentId:agent.id})]);
    await client.query("COMMIT");
    return res.status(201).json({delivery,buyOrderId:id});
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release();}
});

router.get("/buy-orders/:id/receipt", requireAuth("CUSTOMER", "AGENT", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const order = await getOrder(orderId(req));
  if (!order?.purchase_receipt_key) return res.status(404).json({ error: "Purchase receipt not found" });
  const userId = identity(req);
  const role = (req as any).user?.role;
  if (role === "CUSTOMER" && order.customer_user_id !== userId) return res.status(403).json({ error: "Not authorized" });
  if (role === "AGENT") {
    const agent = await getAgent(userId);
    if (!agent || order.agent_id !== agent.id) return res.status(403).json({ error: "Not authorized" });
  }
  try {
    const object = await getPrivateObject(order.purchase_receipt_key);
    res.setHeader("Content-Type", object.contentType ?? "application/octet-stream");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(object.body);
  } catch {
    return res.status(404).json({ error: "Purchase receipt is unavailable" });
  }
});

router.post("/buy-orders/:id/cancel", requireAuth("CUSTOMER"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE buy_orders
          SET status='CANCELLED', updated_at=now()
        WHERE id=$1 AND customer_user_id=$2
          AND status IN ('REQUESTED','APPROVED','AGENT_ASSIGNED')
        RETURNING *`,
      [orderId(req), identity(req)]
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Order cannot be cancelled at its current stage" });
    }
    if (result.rows[0].business_id) {
      await client.query(
        `INSERT INTO business_spend_ledger (business_id, user_id, reference_type, reference_id, amount_minor, currency)
         VALUES ($1,$2,'BUY_ORDER_RESERVATION_RELEASE',$3,$4,'NGN')`,
        [result.rows[0].business_id, identity(req), result.rows[0].id, -Number(result.rows[0].purchase_budget_minor)]
      );
    }
    await client.query(
      "INSERT INTO buy_order_events (buy_order_id, actor_user_id, event_type, metadata) VALUES ($1,$2,'CANCELLED','{}'::jsonb)",
      [orderId(req), identity(req)]
    );
    await client.query("COMMIT");

    const cancelledOrder=result.rows[0];
    if(cancelledOrder.payment_status==="HELD"&&cancelledOrder.payment_reference&&process.env.PAYSTACK_SECRET_KEY){
      try{
        const payment=(await pool.query("SELECT id,amount_minor,currency,status FROM buy_order_payments WHERE buy_order_id=$1",[cancelledOrder.id])).rows[0];
        if(payment&&["HELD","AUTHORIZED"].includes(payment.status)){
          const refundResponse=await fetch("https://api.paystack.co/refund",{
            method:"POST",
            headers:{authorization:"Bearer "+process.env.PAYSTACK_SECRET_KEY,"content-type":"application/json"},
            body:JSON.stringify({transaction:cancelledOrder.payment_reference,amount:String(payment.amount_minor)})
          });
          const refundPayload=await refundResponse.json() as {status?:boolean;message?:string;data?:{id?:string}};
          if(refundResponse.ok&&refundPayload.status){
            await pool.query("UPDATE buy_order_payments SET refund_status='PENDING',refund_amount_minor=$2,updated_at=now() WHERE id=$1",[payment.id,Number(payment.amount_minor)]);
            await pool.query("INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,'REFUND_REQUESTED',$3::jsonb)",[cancelledOrder.id,identity(req),JSON.stringify({reference:cancelledOrder.payment_reference,amountMinor:Number(payment.amount_minor),refundId:refundPayload.data?.id??null})]);
          }else{
            await pool.query("UPDATE buy_order_payments SET refund_status='FAILED',updated_at=now() WHERE id=$1",[payment.id]);
            await pool.query("INSERT INTO buy_order_events(buy_order_id,actor_user_id,event_type,metadata) VALUES($1,$2,'REFUND_REQUEST_FAILED',$3::jsonb)",[cancelledOrder.id,identity(req),JSON.stringify({message:refundPayload.message??"Paystack refund request failed"})]);
          }
        }
      }catch{
        await pool.query("UPDATE buy_order_payments SET refund_status='FAILED',updated_at=now() WHERE buy_order_id=$1",[cancelledOrder.id]);
      }
    }
    return res.json({ buyOrder: cancelledOrder });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.get("/buy-orders/:id", requireAuth("CUSTOMER", "AGENT", "ADMIN"), async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Database is not configured" });
  const order = await getOrder(orderId(req));
  if (!order) return res.status(404).json({ error: "Buy & Deliver order not found" });
  const userId = identity(req);
  const role = (req as any).user?.role;
  if (role === "CUSTOMER" && order.customer_user_id !== userId) return res.status(403).json({ error: "Not authorized" });
  if (role === "AGENT") {
    const agent = await getAgent(userId);
    if (!agent || order.agent_id !== agent.id) return res.status(403).json({ error: "Not authorized" });
  }
  res.json({ buyOrder: order });
});

export default router;
