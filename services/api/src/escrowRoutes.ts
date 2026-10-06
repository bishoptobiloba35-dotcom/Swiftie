import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool, databaseEnabled } from "./database/db.js";
import { verifyReceiverPin } from "./database/deliveryRepository.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";

const router = Router();
const MIN_WITHDRAWAL_MINOR = 100000;
const COURIER_SHARE_BPS = 7500;
const ESCROW_DISPUTE_HOURS = 2;
const MERCHANT_HOLD_HOURS = 72;
const FLOAT_MIN_RESERVE_MINOR = 500000000;
const FLOAT_TOPUP_THRESHOLD_MINOR = 300000000;

function authUser(req: any): string {
  const id = identity(req);
  if (!id) throw new Error("Authentication required");
  return id;
}

async function ensureWallet(userId: string, type: string) {
  const result = await pool!.query(
    `INSERT INTO stakeholder_wallets(user_id, stakeholder_type)
     VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET stakeholder_type=EXCLUDED.stakeholder_type
     RETURNING *`,
    [userId, type]
  );
  return result.rows[0];
}

router.post("/escrow/create", requireAuth, async (req, res) => {
  if (!databaseEnabled()) return res.status(503).json({error:"Database unavailable"});
  const parsed = z.object({ orderId:z.string().uuid() }).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:"Invalid escrow payload"});
  const userId=authUser(req);
  const client=await pool!.connect();
  try{
    await client.query("BEGIN");
    const order=(await client.query(
      "SELECT id,customer_id,payment_on_delivery,quote_total_minor,quote_base_fare_minor,quote_service_fee_minor,quote_protection_reserve_minor FROM deliveries WHERE id=$1 FOR UPDATE",
      [parsed.data.orderId]
    )).rows[0];
    if(!order) return res.status(404).json({error:"Order not found"});
    if(order.customer_id!==userId) return res.status(403).json({error:"Order access denied"});
    if(order.payment_on_delivery===true) return res.status(409).json({error:"Cash-on-delivery is disabled"});
    const existing=(await client.query("SELECT * FROM escrow_ledgers WHERE order_id=$1 FOR UPDATE",[order.id])).rows[0];
    if(existing){ await client.query("COMMIT"); return res.status(200).json({escrow:existing}); }
    const totalPaidMinor=Number(order.quote_total_minor ?? 0);
    const baseFareMinor=Number(order.quote_base_fare_minor ?? 0);
    const serviceChargeMinor=Number(order.quote_service_fee_minor ?? 0);
    const protectionReserveMinor=Number(order.quote_protection_reserve_minor ?? 0);
    if(!Number.isSafeInteger(totalPaidMinor)||totalPaidMinor<=0) return res.status(409).json({error:"Order has no authoritative payable total"});
    const courierShareMinor=Math.floor(baseFareMinor*COURIER_SHARE_BPS/10000);
    const merchantShareMinor=0;
    const swiftdropMarginMinor=totalPaidMinor-courierShareMinor-serviceChargeMinor-protectionReserveMinor-merchantShareMinor;
    if(swiftdropMarginMinor<0) return res.status(409).json({error:"Order pricing cannot produce a valid escrow split"});
    const row=(await client.query(
      `INSERT INTO escrow_ledgers(order_id,total_paid_minor,courier_share_minor,service_charge_minor,protection_reserve_minor,swiftdrop_margin_minor,merchant_share_minor)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [order.id,totalPaidMinor,courierShareMinor,serviceChargeMinor,protectionReserveMinor,swiftdropMarginMinor,merchantShareMinor]
    )).rows[0];
    await client.query("UPDATE deliveries SET escrow_payment_state='pending_payment',escrow_total_paid_minor=$2,escrow_courier_share_minor=$3,escrow_service_charge_minor=$4,escrow_protection_reserve_minor=$5,escrow_swiftdrop_margin_minor=$6,escrow_merchant_share_minor=$7 WHERE id=$1",
      [order.id,totalPaidMinor,courierShareMinor,serviceChargeMinor,protectionReserveMinor,swiftdropMarginMinor,merchantShareMinor]);
    await client.query("COMMIT");
    return res.status(201).json({escrow:row});
  }catch(e){await client.query("ROLLBACK"); return res.status(500).json({error:"Unable to create escrow"});}
  finally{client.release();}
});

router.post("/escrow/:orderId/pay", requireAuth, async (req,res)=>{
  if(!databaseEnabled()) return res.status(503).json({error:"Database unavailable"});
  const orderId=String(req.params.orderId);
  const parsed=z.object({method:z.enum(["PAYSTACK_CARD","BANK_TRANSFER","USSD","SMS_LINK"]),providerReference:z.string().max(200).optional(),idempotencyKey:z.string().min(8).max(120)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Invalid payment request"});
  const userId=authUser(req);
  const client=await pool!.connect();
  try{
    await client.query("BEGIN");
    const order=(await client.query("SELECT id,customer_id,escrow_total_paid_minor FROM deliveries WHERE id=$1 FOR UPDATE",[orderId])).rows[0];
    if(!order)return res.status(404).json({error:"Order not found"});
    if(order.customer_id!==userId)return res.status(403).json({error:"Order access denied"});
    const existing=(await client.query("SELECT * FROM escrow_payment_attempts WHERE idempotency_key=$1",[parsed.data.idempotencyKey])).rows[0];
    if(existing){await client.query("COMMIT");return res.status(200).json({payment:existing});}
    const payment=(await client.query(
      "INSERT INTO escrow_payment_attempts(order_id,method,provider_reference,amount_minor,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [orderId,parsed.data.method,parsed.data.providerReference ?? null,Number(order.escrow_total_paid_minor),parsed.data.idempotencyKey]
    )).rows[0];
    await client.query("COMMIT");
    return res.status(201).json({payment,confirmation:"Payment will be confirmed from the verified provider webhook."});
  }catch(e){await client.query("ROLLBACK");return res.status(500).json({error:"Unable to start escrow payment"});}
  finally{client.release();}
});

router.post("/escrow/:orderId/pin", requireAuth, async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const parsed=z.object({pin:z.string().regex(/^\d{4}$/)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"PIN must be exactly 4 digits"});
  const userId=authUser(req);
  const client=await pool!.connect();
  try{
    await client.query("BEGIN");
    const order=(await client.query(
      "SELECT d.id,d.customer_id,d.driver_id,dr.user_id AS courier_user_id,d.escrow_total_paid_minor,d.escrow_courier_share_minor,d.escrow_payment_state,d.receiver_pin_hash FROM deliveries d LEFT JOIN drivers dr ON dr.id=d.driver_id WHERE d.id=$1 FOR UPDATE",
      [String(req.params.orderId)]
    )).rows[0];
    if(!order)return res.status(404).json({error:"Order not found"});
    if(userId!==order.customer_id && userId!==order.courier_user_id)return res.status(403).json({error:"PIN confirmation not authorized"});
    if(order.escrow_payment_state!=="arrived")return res.status(409).json({error:"Order is not awaiting PIN confirmation"});
    if(!order.receiver_pin_hash)return res.status(409).json({error:"Receiver PIN is not configured"});
    const valid=await verifyReceiverPin(order.id, parsed.data.pin);
    if(!valid){await client.query("ROLLBACK");return res.status(401).json({error:"Invalid PIN"});}
    const disputeUntil=new Date(Date.now()+ESCROW_DISPUTE_HOURS*3600000);
    await client.query(
      `UPDATE escrow_ledgers SET state='dispute_window',pin_confirmed_at=now(),dispute_window_until=$2,updated_at=now()
       WHERE order_id=$1 AND state='arrived'`,
      [order.id,disputeUntil]
    );
    await client.query(
      `UPDATE deliveries SET status='DELIVERED',escrow_payment_state='dispute_window',escrow_pin_confirmed_at=now(),escrow_dispute_window_until=$2 WHERE id=$1`,
      [order.id,disputeUntil]
    );
    if(order.courier_user_id && Number(order.escrow_courier_share_minor)>0){
      await client.query(
        `INSERT INTO stakeholder_wallets(user_id,stakeholder_type,balance_minor)
         VALUES($1,'COURIER',$2)
         ON CONFLICT(user_id) DO UPDATE SET balance_minor=stakeholder_wallets.balance_minor+EXCLUDED.balance_minor,updated_at=now()`,
        [order.courier_user_id,Number(order.escrow_courier_share_minor)]
      );
      const wallet=(await client.query("SELECT id,balance_minor FROM stakeholder_wallets WHERE user_id=$1",[order.courier_user_id])).rows[0];
      await client.query(
        `INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,idempotency_key)
         VALUES($1,$2,'COURIER_INSTANT_PAYOUT','CREDIT',$3,$4,$5)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [wallet.id,order.id,Number(order.escrow_courier_share_minor),Number(wallet.balance_minor),`courier-pin-${order.id}`]
      );
    }
    await client.query("COMMIT");
    return res.status(200).json({state:"dispute_window",courierPayout:"instant",courierShareMinor:Number(order.escrow_courier_share_minor),disputeWindowUntil:disputeUntil.toISOString()});
  }catch(e){await client.query("ROLLBACK");return res.status(500).json({error:"Unable to confirm PIN"});}
  finally{client.release();}
});

router.post("/virtual-account/create", requireAuth, async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const parsed=z.object({orderId:z.string().uuid()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Valid orderId is required"});
  const userId=authUser(req);
  const order=(await pool!.query("SELECT id,customer_id,escrow_total_paid_minor FROM deliveries WHERE id=$1",[parsed.data.orderId])).rows[0];
  if(!order)return res.status(404).json({error:"Order not found"});
  if(order.customer_id!==userId)return res.status(403).json({error:"Order access denied"});
  const existing=(await pool!.query("SELECT * FROM virtual_accounts WHERE order_id=$1",[order.id])).rows[0];
  if(existing)return res.status(200).json({virtualAccount:existing});
  const secret=process.env.PAYSTACK_SECRET_KEY;
  if(!secret)return res.status(503).json({error:"Paystack virtual accounts are not configured"});
  return res.status(501).json({error:"Paystack DVA provisioning requires a configured Paystack customer and dedicated-account profile; no placeholder account is returned"});
});

router.get("/wallet/balance", requireAuth, async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const userId=authUser(req);
  const row=(await pool!.query("SELECT * FROM stakeholder_wallets WHERE user_id=$1",[userId])).rows[0];
  return res.json({wallet:row ?? {balance_minor:0,pending_minor:0,currency:"NGN"}});
});

router.post("/wallet/withdraw", requireAuth, async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const parsed=z.object({amountMinor:z.number().int().min(MIN_WITHDRAWAL_MINOR),idempotencyKey:z.string().min(8).max(120)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Minimum withdrawal is ₦1,000 and a valid idempotency key is required"});
  const userId=authUser(req);
  const client=await pool!.connect();
  try{
    await client.query("BEGIN");
    const wallet=(await client.query("SELECT * FROM stakeholder_wallets WHERE user_id=$1 FOR UPDATE",[userId])).rows[0];
    if(!wallet)return res.status(404).json({error:"Wallet not found"});
    if(Number(wallet.balance_minor)<parsed.data.amountMinor)return res.status(409).json({error:"Insufficient available balance"});
    const duplicate=(await client.query("SELECT * FROM payout_requests WHERE idempotency_key=$1",[parsed.data.idempotencyKey])).rows[0];
    if(duplicate){await client.query("COMMIT");return res.json({payout:duplicate});}
    const payout=(await client.query("INSERT INTO payout_requests(wallet_id,user_id,amount_minor,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *",[wallet.id,userId,parsed.data.amountMinor,parsed.data.idempotencyKey])).rows[0];
    await client.query("UPDATE stakeholder_wallets SET balance_minor=balance_minor-$2,updated_at=now() WHERE id=$1",[wallet.id,parsed.data.amountMinor]);
    await client.query("COMMIT");
    return res.status(201).json({payout,provider:"paystack_transfers"});
  }catch(e){await client.query("ROLLBACK");return res.status(500).json({error:"Unable to create payout request"});}
  finally{client.release();}
});

router.get("/float/balance", requireAuth, async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const userId=authUser(req);
  const role=(await pool!.query("SELECT role FROM users WHERE id=$1",[userId])).rows[0]?.role;
  if(role!=="ADMIN" && role!=="FINANCE")return res.status(403).json({error:"Admin or Finance access required"});
  const latest=(await pool!.query("SELECT balance_after_minor FROM float_transactions ORDER BY created_at DESC LIMIT 1")).rows[0];
  const balance=Number(latest?.balance_after_minor ?? 0);
  return res.json({balanceMinor:balance,minimumReserveMinor:FLOAT_MIN_RESERVE_MINOR,autoTopUpThresholdMinor:FLOAT_TOPUP_THRESHOLD_MINOR,reconciliation:"daily_18:00"});
});

export default router;
