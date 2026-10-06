import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool, databaseEnabled } from "./database/db.js";
import { verifyReceiverPin } from "./database/deliveryRepository.js";
import { requireAuth() } from "./authMiddleware.js";
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

router.post("/escrow/create", requireAuth(), async (req, res) => {
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
    if(!order){ await client.query("ROLLBACK"); return res.status(404).json({error:"Order not found"}); }
    if(order.customer_id!==userId){ await client.query("ROLLBACK"); return res.status(403).json({error:"Order access denied"}); }
    if(order.payment_on_delivery===true){ await client.query("ROLLBACK"); return res.status(409).json({error:"Cash-on-delivery is disabled"}); }
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
    if(swiftdropMarginMinor<0){ await client.query("ROLLBACK"); return res.status(409).json({error:"Order pricing cannot produce a valid escrow split"}); }
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

router.post("/escrow/:orderId/pay", requireAuth(), async (req,res)=>{
  if(!databaseEnabled()) return res.status(503).json({error:"Database unavailable"});
  const orderId=String(req.params.orderId);
  const parsed=z.object({method:z.enum(["PAYSTACK_CARD","BANK_TRANSFER","USSD","SMS_LINK"]),providerReference:z.string().max(200).optional(),idempotencyKey:z.string().min(8).max(120)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Invalid payment request"});
  const userId=authUser(req);
  const client=await pool!.connect();
  try{
    await client.query("BEGIN");
    const order=(await client.query("SELECT id,customer_id,escrow_total_paid_minor FROM deliveries WHERE id=$1 FOR UPDATE",[orderId])).rows[0];
    if(!order){await client.query("ROLLBACK");return res.status(404).json({error:"Order not found"});}
    if(order.customer_id!==userId){await client.query("ROLLBACK");return res.status(403).json({error:"Order access denied"});}
    const existing=(await client.query("SELECT * FROM escrow_payment_attempts WHERE idempotency_key=$1",[parsed.data.idempotencyKey])).rows[0];
    if(existing){await client.query("COMMIT");return res.status(200).json({payment:existing});}
    const amountMinor=Number(order.escrow_total_paid_minor);
    const user=(await client.query("SELECT email FROM users WHERE id=$1",[userId])).rows[0];
    if(!user?.email){await client.query("ROLLBACK");return res.status(409).json({error:"Customer email is required for Paystack payment"});}
    let providerReference=parsed.data.providerReference ?? null;
    let authorizationUrl:string|undefined;
    let accessCode:string|undefined;
    if(parsed.data.method!=="BANK_TRANSFER"){
      const secret=process.env.PAYSTACK_SECRET_KEY;
      if(!secret){await client.query("ROLLBACK");return res.status(503).json({error:"Paystack payment configuration is not ready"});}
      const reference=providerReference ?? "SD-ESCROW-"+orderId+"-"+Date.now();
      const channels=parsed.data.method==="USSD" ? ["ussd"] : ["card","bank","ussd","bank_transfer"];
      const providerResponse=await fetch("https://api.paystack.co/transaction/initialize",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({email:user.email,amount:String(amountMinor),currency:"NGN",reference,channels,metadata:{deliveryId:orderId,escrow:true}})});
      const payload=await providerResponse.json() as any;
      if(!providerResponse.ok||!payload.status||!payload.data?.authorization_url){await client.query("ROLLBACK");return res.status(502).json({error:payload.message ?? "Paystack payment initialization failed"});}
      providerReference=String(payload.data.reference ?? reference);
      authorizationUrl=payload.data.authorization_url;
      accessCode=payload.data.access_code;
    }
    const payment=(await client.query(
      "INSERT INTO escrow_payment_attempts(order_id,method,provider_reference,amount_minor,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [orderId,parsed.data.method,providerReference,amountMinor,parsed.data.idempotencyKey]
    )).rows[0];
    await client.query("COMMIT");
    return res.status(201).json({payment,authorizationUrl,accessCode,amountMinor,confirmation:"Payment will be confirmed from the verified provider webhook."});
  }catch(e){await client.query("ROLLBACK");return res.status(500).json({error:"Unable to start escrow payment"});}
  finally{client.release();}
});

router.post("/escrow/:orderId/pin", requireAuth(), async (req,res)=>{
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
    if(order.escrow_payment_state==="paid_escrow"){
      await client.query("UPDATE escrow_ledgers SET state='arrived',updated_at=now() WHERE order_id=$1 AND state='paid_escrow'",[order.id]);
      await client.query("UPDATE deliveries SET escrow_payment_state='arrived' WHERE id=$1 AND status='ARRIVED'",[order.id]);
      order.escrow_payment_state="arrived";
    }
    if(order.escrow_payment_state!=="arrived"){await client.query("ROLLBACK");return res.status(409).json({error:"Order is not awaiting PIN confirmation"});}
    if(!order.receiver_pin_hash)return res.status(409).json({error:"Receiver PIN is not configured"});
    const valid=await verifyReceiverPin(order.id, parsed.data.pin);
    if(!valid){await client.query("ROLLBACK");return res.status(401).json({error:"Invalid PIN"});}
    const disputeUntil=new Date(Date.now()+ESCROW_DISPUTE_HOURS*3600000);
    await client.query(
      `UPDATE escrow_ledgers SET state='dispute_window',pin_confirmed_at=now(),dispute_window_until=$2,stakeholder_release_at=now()+interval '72 hours',updated_at=now()
       WHERE order_id=$1 AND state='arrived'`,
      [order.id,disputeUntil]
    );
    await client.query(
      `UPDATE deliveries SET status='DELIVERED',escrow_payment_state='dispute_window',escrow_pin_confirmed_at=now(),escrow_dispute_window_until=$2 WHERE id=$1`,
      [order.id,disputeUntil]
    );
    if(Number(order.escrow_courier_share_minor)>0){
      const floatLatest=(await client.query("SELECT balance_after_minor FROM float_transactions ORDER BY created_at DESC LIMIT 1")).rows[0];
      const floatBalance=Number(floatLatest?.balance_after_minor ?? Number(order.escrow_total_paid_minor));
      const courierAmount=Number(order.escrow_courier_share_minor);
      await client.query(
        `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,metadata)
         VALUES('PAYOUT',$1,$2,$3,'{"reason":"courier_pin_instant_payout"}'::jsonb)`,
        [courierAmount,Math.max(0,floatBalance-courierAmount),order.id]
      );
    }
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

router.post("/virtual-account/create", requireAuth(), async (req,res)=>{
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
  const user=(await pool!.query("SELECT full_name,email,phone FROM users WHERE id=$1",[userId])).rows[0];
  if(!user?.email)return res.status(409).json({error:"A verified customer email is required to create a dedicated virtual account"});
  const names=String(user.full_name).trim().split(/\\s+/);
  const firstName=names.shift() ?? "SwiftDrop";
  const lastName=names.join(" ") || "Customer";
  const headers={authorization:"Bearer "+secret,"content-type":"application/json"};
  const customerResponse=await fetch("https://api.paystack.co/customer",{method:"POST",headers,body:JSON.stringify({
    email:user.email,first_name:firstName,last_name:lastName,phone:String(order.customer_id===userId?user.phone:"")
  })});
  const customerPayload=await customerResponse.json() as any;
  if(!customerResponse.ok||!customerPayload.status||!customerPayload.data?.customer_code){
    return res.status(502).json({error:customerPayload.message ?? "Unable to create Paystack customer for virtual account"});
  }
  const preferredBank=process.env.PAYSTACK_DVA_BANK_SLUG || (process.env.PAYSTACK_SECRET_KEY?.startsWith("sk_test_") ? "test-bank" : undefined);
  const dvaResponse=await fetch("https://api.paystack.co/dedicated_account",{method:"POST",headers,body:JSON.stringify({
    customer:customerPayload.data.customer_code,
    ...(preferredBank ? {preferred_bank:preferredBank} : {}),
    first_name:firstName,last_name:lastName,phone:user.phone
  })});
  const dvaPayload=await dvaResponse.json() as any;
  if(!dvaResponse.ok||!dvaPayload.status){
    return res.status(502).json({error:dvaPayload.message ?? "Unable to create dedicated virtual account"});
  }
  const data=dvaPayload.data ?? {};
  if(!data.account_number){
    return res.status(202).json({status:"PROVISIONING",customerCode:customerPayload.data.customer_code,message:"Paystack is provisioning the dedicated virtual account. Retry shortly."});
  }
  const saved=(await pool!.query(
    `INSERT INTO virtual_accounts(user_id,order_id,customer_code,account_name,account_number,bank_name,bank_code,provider_reference,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE')
     ON CONFLICT(order_id) DO UPDATE SET customer_code=EXCLUDED.customer_code,account_name=EXCLUDED.account_name,account_number=EXCLUDED.account_number,bank_name=EXCLUDED.bank_name,bank_code=EXCLUDED.bank_code,provider_reference=EXCLUDED.provider_reference,status='ACTIVE',updated_at=now()
     RETURNING *`,
    [userId,order.id,customerPayload.data.customer_code,data.account_name,data.account_number,data.bank?.name ?? null,data.bank?.id ? String(data.bank.id) : null,String(data.id ?? customerPayload.data.customer_code)]
  )).rows[0];
  return res.status(201).json({virtualAccount:saved,displayMessage:`Transfer ₦${(Number(order.escrow_total_paid_minor)/100).toLocaleString()} to ${data.account_number} (${data.bank?.name ?? "Paystack bank"})`});
});

router.get("/wallet/balance", requireAuth(), async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const userId=authUser(req);
  const row=(await pool!.query("SELECT * FROM stakeholder_wallets WHERE user_id=$1",[userId])).rows[0];
  return res.json({wallet:row ?? {balance_minor:0,pending_minor:0,currency:"NGN"}});
});

router.post("/wallet/withdraw", requireAuth(), async (req,res)=>{
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
    if(!wallet.paystack_recipient_code || !wallet.bank_account_verified){
      await client.query("ROLLBACK");
      return res.status(409).json({error:"A verified Paystack payout recipient is required before withdrawal"});
    }
    await client.query("UPDATE stakeholder_wallets SET balance_minor=balance_minor-$2,pending_minor=pending_minor+$2,updated_at=now() WHERE id=$1",[wallet.id,parsed.data.amountMinor]);
    await client.query("UPDATE payout_requests SET status='PROCESSING' WHERE id=$1",[payout.id]);
    await client.query("COMMIT");
    const secret=process.env.PAYSTACK_SECRET_KEY;
    if(!secret){
      await pool!.query("UPDATE stakeholder_wallets SET balance_minor=balance_minor+$2,pending_minor=GREATEST(0,pending_minor-$2),updated_at=now() WHERE id=$1",[wallet.id,parsed.data.amountMinor]);
      await pool!.query("UPDATE payout_requests SET status='FAILED',failure_reason='Paystack transfers are not configured',updated_at=now() WHERE id=$1",[payout.id]);
      return res.status(503).json({error:"Paystack transfers are not configured"});
    }
    const reference="SD-WALLET-"+payout.id;
    const providerResponse=await fetch("https://api.paystack.co/transfer",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({
      source:"balance",amount:parsed.data.amountMinor,recipient:wallet.paystack_recipient_code,reason:"SwiftDrop wallet withdrawal",reference
    })});
    const providerPayload=await providerResponse.json() as any;
    if(!providerResponse.ok||!providerPayload.status||!providerPayload.data?.reference){
      await pool!.query("UPDATE stakeholder_wallets SET balance_minor=balance_minor+$2,pending_minor=GREATEST(0,pending_minor-$2),updated_at=now() WHERE id=$1",[wallet.id,parsed.data.amountMinor]);
      await pool!.query("UPDATE payout_requests SET status='FAILED',failure_reason=$2,updated_at=now() WHERE id=$1",[payout.id,String(providerPayload.message ?? "Paystack transfer failed").slice(0,400)]);
      return res.status(502).json({error:providerPayload.message ?? "Paystack transfer failed"});
    }
    const updated=(await pool!.query("UPDATE payout_requests SET provider_reference=$2,status='PROCESSING',updated_at=now() WHERE id=$1 RETURNING *",[payout.id,providerPayload.data.reference])).rows[0];
    return res.status(201).json({payout:updated,provider:"paystack_transfers"});
  }catch(e){await client.query("ROLLBACK");return res.status(500).json({error:"Unable to create payout request"});}
  finally{client.release();}
});

router.get("/float/balance", requireAuth(), async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const userId=authUser(req);
  const role=(await pool!.query("SELECT role FROM users WHERE id=$1",[userId])).rows[0]?.role;
  if(role!=="ADMIN" && role!=="FINANCE")return res.status(403).json({error:"Admin or Finance access required"});
  const latest=(await pool!.query("SELECT balance_after_minor FROM float_transactions ORDER BY created_at DESC LIMIT 1")).rows[0];
  const balance=Number(latest?.balance_after_minor ?? 0);
  return res.json({balanceMinor:balance,minimumReserveMinor:FLOAT_MIN_RESERVE_MINOR,autoTopUpThresholdMinor:FLOAT_TOPUP_THRESHOLD_MINOR,reconciliation:"daily_18:00"});
});

export default router;
