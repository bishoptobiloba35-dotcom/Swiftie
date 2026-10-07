import { recoverOutstandingCourierClawbacks } from "./database/deliveryRepository.js";
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool, databaseEnabled } from "./database/db.js";
import { verifyPin } from "./security.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";

const router = Router();
const MIN_WITHDRAWAL_MINOR = 100000;
const COURIER_SHARE_BPS = 7500;
const ESCROW_DISPUTE_HOURS = 2;
const MERCHANT_HOLD_HOURS = 72;
const FLOAT_MIN_RESERVE_MINOR = 500000000;
const FLOAT_TOPUP_THRESHOLD_MINOR = 300000000;

export function createWalletPayoutProviderReference(): string {
  return "sd_wallet_" + randomUUID().replaceAll("-", "");
}

function authUser(req: any): string {
  const id = identity(req);
  if (!id) throw new Error("Authentication required");
  return id;
}

function normalizeNigeriaPhone(phone: string): string {
  const digits=phone.replace(/\D/g,"");
  if(digits.startsWith("234")) return digits;
  if(digits.startsWith("0")) return "234"+digits.slice(1);
  return digits;
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
      "SELECT id,sender_id AS customer_id,merchant_user_id,payment_on_delivery,quote_total_minor,quote_base_fare_minor,quote_service_fee_minor,quote_protection_reserve_minor FROM deliveries WHERE id=$1 FOR UPDATE",
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
    if(!Number.isSafeInteger(totalPaidMinor)||totalPaidMinor<=0){
      await client.query("ROLLBACK");
      return res.status(409).json({error:"Order has no authoritative payable total"});
    }
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
  const parsed=z.object({method:z.enum(["PAYSTACK_CARD","BANK_TRANSFER","USSD","SMS_LINK"]),idempotencyKey:z.string().min(8).max(120)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Invalid payment request"});
  const userId=authUser(req);
  const client=await pool!.connect();
  try{
    await client.query("BEGIN");
    const order=(await client.query("SELECT id,customer_id,receiver_phone,tracking_code,escrow_total_paid_minor FROM deliveries WHERE id=$1 FOR UPDATE",[orderId])).rows[0];
    if(!order){await client.query("ROLLBACK");return res.status(404).json({error:"Order not found"});}
    if(order.customer_id!==userId){await client.query("ROLLBACK");return res.status(403).json({error:"Order access denied"});}
    const existing=(await client.query("SELECT * FROM escrow_payment_attempts WHERE idempotency_key=$1",[parsed.data.idempotencyKey])).rows[0];
    if(existing){await client.query("COMMIT");return res.status(200).json({payment:existing});}
    const amountMinor=Number(order.escrow_total_paid_minor);
    const user=(await client.query("SELECT email FROM users WHERE id=$1",[userId])).rows[0];
    if(parsed.data.method!=="BANK_TRANSFER" && !user?.email){
      await client.query("ROLLBACK");
      return res.status(409).json({error:"Customer email is required for Paystack payment"});
    }
    let providerReference:string|null=null;
    let authorizationUrl:string|undefined;
    let accessCode:string|undefined;
    let ussdCode:string|undefined;
    let smsMessageId:string|undefined;
    if(parsed.data.method!=="BANK_TRANSFER"){
      const secret=process.env.PAYSTACK_SECRET_KEY;
      if(!secret){await client.query("ROLLBACK");return res.status(503).json({error:"Paystack payment configuration is not ready"});}
      const reference="SD-ESCROW-"+orderId+"-"+randomUUID().replaceAll("-","");
      const channels=parsed.data.method==="USSD" ? ["ussd"] : ["card","bank","ussd","bank_transfer"];
      const providerResponse=await fetch("https://api.paystack.co/transaction/initialize",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({email:user.email,amount:String(amountMinor),currency:"NGN",reference,channels,metadata:{deliveryId:orderId,escrow:true}})});
      const payload=await providerResponse.json() as any;
      if(!providerResponse.ok||!payload.status||((parsed.data.method!=="USSD")&&!payload.data?.authorization_url)|| (parsed.data.method==="USSD"&&!payload.data?.ussd_code&&!payload.data?.authorization_url)){await client.query("ROLLBACK");return res.status(502).json({error:payload.message ?? "Paystack payment initialization failed"});}
      const providerReferenceFromPaystack=String(payload.data.reference ?? reference);
      providerReference=providerReferenceFromPaystack;
      authorizationUrl=payload.data.authorization_url;
      accessCode=payload.data.access_code;
      ussdCode=payload.data.ussd_code;
      if(parsed.data.method==="SMS_LINK"){
        const baseUrl=String(process.env.TERMII_BASE_URL ?? "").replace(/\/$/,"");
        const apiKey=process.env.TERMII_API_KEY;
        const senderId=process.env.TERMII_SENDER_ID;
        if(!baseUrl||!apiKey||!senderId){
          await client.query("ROLLBACK");
          return res.status(503).json({error:"Termii SMS payment-link configuration is not ready"});
        }
        const smsResponse=await fetch(baseUrl+"/api/sms/send",{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({
            api_key:apiKey,
            to:normalizeNigeriaPhone(String(order.receiver_phone)),
            from:senderId,
            sms:`Your parcel #${order.tracking_code} is arriving. Pay ₦${(amountMinor/100).toLocaleString()}: ${authorizationUrl}`,
            type:"plain",
            channel:"dnd"
          }),
          signal:AbortSignal.timeout(10000)
        });
        const smsPayload=await smsResponse.json() as any;
        if(!smsResponse.ok||String(smsPayload.code ?? "").toLowerCase()!=="ok"){
          await client.query("ROLLBACK");
          return res.status(502).json({error:smsPayload.message ?? "Unable to send SMS payment link"});
        }
        smsMessageId=String(smsPayload.message_id ?? smsPayload.message_id_str ?? "");
      }
    }
    const payment=(await client.query(
      "INSERT INTO escrow_payment_attempts(order_id,method,provider_reference,amount_minor,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [orderId,parsed.data.method,providerReference,amountMinor,parsed.data.idempotencyKey]
    )).rows[0];
    await client.query("COMMIT");
    return res.status(201).json({payment,authorizationUrl,accessCode,ussdCode,smsMessageId,amountMinor,confirmation:"Payment will be confirmed from the verified provider webhook."});
  }catch(e){await client.query("ROLLBACK");return res.status(500).json({error:"Unable to start escrow payment"});}
  finally{client.release();}
});


export async function reconcilePendingEscrowProviderPayments(): Promise<void> {
  if(!pool || !process.env.PAYSTACK_SECRET_KEY) return;
  const rows=(await pool.query(
    `SELECT epa.id,epa.order_id,epa.provider_reference,epa.amount_minor
       FROM escrow_payment_attempts epa
      WHERE epa.status='PENDING'
        AND epa.method IN ('PAYSTACK_CARD','USSD','SMS_LINK')
        AND epa.provider_reference IS NOT NULL
      ORDER BY epa.updated_at ASC
      LIMIT 50`
  )).rows;
  for(const row of rows){
    const reference=String(row.provider_reference);
    try{
      const response=await fetch("https://api.paystack.co/transaction/verify/"+encodeURIComponent(reference),{
        headers:{authorization:"Bearer "+process.env.PAYSTACK_SECRET_KEY},
        signal:AbortSignal.timeout(10_000)
      });
      const payload=await response.json() as any;
      if(!response.ok||!payload.status) continue;
      const providerStatus=String(payload.data?.status ?? "").toLowerCase();
      if(!["success","failed","abandoned"].includes(providerStatus)) continue;
      const providerAmount=Number(payload.data?.amount);
      const providerCurrency=String(payload.data?.currency ?? "");
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        const attempt=(await client.query(
          `SELECT epa.*,d.sender_id AS customer_id,d.escrow_total_paid_minor
             FROM escrow_payment_attempts epa
             JOIN deliveries d ON d.id=epa.order_id
            WHERE epa.id=$1
            FOR UPDATE OF epa,d`,[row.id]
        )).rows[0];
        if(!attempt || attempt.status!=="PENDING"){await client.query("COMMIT");continue;}
        const amountMatches=Number.isSafeInteger(providerAmount) && providerAmount===Number(attempt.amount_minor) && providerCurrency==="NGN";
        if(providerStatus!=="success" || !amountMatches){
          await client.query("UPDATE escrow_payment_attempts SET status='FAILED',updated_at=now() WHERE id=$1 AND status='PENDING'",[attempt.id]);
          await client.query("COMMIT");
          continue;
        }
        await client.query(
          `UPDATE escrow_payment_attempts SET status='SUCCESS',updated_at=now()
             WHERE id=$1 AND status='PENDING'`,[attempt.id]
        );
        await client.query(
          `UPDATE escrow_ledgers
              SET state='paid_escrow',provider='paystack',provider_reference=$2,
                  funded_at=COALESCE(funded_at,now()),updated_at=now()
            WHERE order_id=$1 AND state='pending_payment'`,[attempt.order_id,reference]
        );
        await client.query(
          `UPDATE deliveries
              SET escrow_payment_state='paid_escrow',escrow_paid_at=COALESCE(escrow_paid_at,now())
            WHERE id=$1 AND escrow_payment_state='pending_payment'`,[attempt.order_id]
        );
        await client.query(
          `UPDATE payments
              SET status='HELD',escrow_status='HELD',provider_reference=COALESCE(provider_reference,$2),updated_at=now()
            WHERE delivery_id=$1 AND collection_mode='SENDER_ESCROW'`,[attempt.order_id,reference]
        );
        await client.query("COMMIT");
      }catch(error){
        await client.query("ROLLBACK");
        console.error("escrow provider reconciliation error",error);
      }finally{client.release();}
    }catch(error){
      console.error("escrow provider verification error",error);
      // Keep the attempt pending for the next reconciliation cycle.
    }
  }
}

router.post("/escrow/:orderId/pin", requireAuth(), async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const parsed=z.object({pin:z.string().regex(/^\d{4}$/)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"PIN must be exactly 4 digits"});
  const userId=authUser(req);
  const client=await pool!.connect();
  try{
    await client.query("BEGIN");
    const order=(await client.query(
      "SELECT d.id,d.sender_id AS customer_id,d.driver_id,d.escrow_total_paid_minor,d.escrow_courier_share_minor,d.escrow_payment_state,d.receiver_pin_hash FROM deliveries d WHERE d.id=$1 FOR UPDATE",
      [String(req.params.orderId)]
    )).rows[0];
    if (order?.driver_id) {
      const driver = (await client.query("SELECT user_id AS courier_user_id FROM drivers WHERE id=$1",[order.driver_id])).rows[0];
      order.courier_user_id = driver?.courier_user_id ?? null;
    }
    if(!order){await client.query("ROLLBACK");return res.status(404).json({error:"Order not found"});}
    if(userId!==order.customer_id && userId!==order.courier_user_id)return res.status(403).json({error:"PIN confirmation not authorized"});
    if(order.escrow_payment_state==="paid_escrow"){
      await client.query("UPDATE escrow_ledgers SET state='arrived',updated_at=now() WHERE order_id=$1 AND state='paid_escrow'",[order.id]);
      await client.query("UPDATE deliveries SET escrow_payment_state='arrived' WHERE id=$1 AND status='ARRIVED'",[order.id]);
      order.escrow_payment_state="arrived";
    }
    if(order.escrow_payment_state!=="arrived"){await client.query("ROLLBACK");return res.status(409).json({error:"Order is not awaiting PIN confirmation"});}
    if(!order.receiver_pin_hash){await client.query("ROLLBACK");return res.status(409).json({error:"Receiver PIN is not configured"});}
    const pinState=(await client.query("SELECT pin_failed_attempts,pin_locked_until FROM deliveries WHERE id=$1 FOR UPDATE",[order.id])).rows[0];
    if(pinState?.pin_locked_until && new Date(pinState.pin_locked_until).getTime()>Date.now()){
      await client.query("ROLLBACK");
      return res.status(429).json({error:"Too many PIN attempts. Try again later.",retryAfterMs:new Date(pinState.pin_locked_until).getTime()-Date.now()});
    }
    const valid=verifyPin(parsed.data.pin, order.receiver_pin_hash);
    if(!valid){
      const failures=Number(pinState?.pin_failed_attempts ?? 0)+1;
      if(failures>=3){
        await client.query("UPDATE deliveries SET pin_failed_attempts=0,pin_locked_until=now()+interval '15 minutes' WHERE id=$1",[order.id]);
      }else{
        await client.query("UPDATE deliveries SET pin_failed_attempts=$2 WHERE id=$1",[order.id,failures]);
      }
      await client.query("COMMIT");
      return res.status(401).json({error:failures>=3?"Too many PIN attempts. Try again later.":"Invalid PIN",retryAfterMs:failures>=3?15*60*1000:undefined});
    }
    await client.query("UPDATE deliveries SET pin_failed_attempts=0,pin_locked_until=NULL WHERE id=$1",[order.id]);
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
      const floatLatest=(await client.query("SELECT balance_after_minor FROM float_transactions ORDER BY created_at DESC LIMIT 1 FOR UPDATE")).rows[0];
      const floatBalance=Number(floatLatest?.balance_after_minor ?? 0);
      const courierAmount=Number(order.escrow_courier_share_minor);
      const floatReserve=500000000;
      const nextFloatBalance=floatBalance-courierAmount;
      if(!Number.isSafeInteger(floatBalance) || nextFloatBalance<floatReserve){
        await client.query("ROLLBACK");
        return res.status(503).json({error:"Courier payout is temporarily unavailable because the protected settlement float is below its reserve"});
      }
      await client.query(
        `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,metadata)
         VALUES('PAYOUT',$1,$2,$3,'{"reason":"courier_pin_instant_payout"}'::jsonb)`,
        [courierAmount,nextFloatBalance,order.id]
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
    if(order.courier_user_id && Number(order.escrow_courier_share_minor)>0){ try { await recoverOutstandingCourierClawbacks(order.courier_user_id,Number(order.escrow_courier_share_minor),order.id); } catch(error){ console.error(JSON.stringify({event:"courier_clawback_future_earnings_recovery_failed",orderId:order.id,error:error instanceof Error?error.message:"unknown"})); } }
    return res.status(200).json({state:"dispute_window",courierPayout:"instant",courierShareMinor:Number(order.escrow_courier_share_minor),disputeWindowUntil:disputeUntil.toISOString()});
  }catch(e){await client.query("ROLLBACK");return res.status(500).json({error:"Unable to confirm PIN",...(process.env.NODE_ENV === "test" ? {detail:e instanceof Error ? e.message : String(e)} : {})});}
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
  if(existing?.status==="ACTIVE")return res.status(200).json({virtualAccount:existing});
  if(existing?.status==="PROVISIONING")return res.status(202).json({status:"PROVISIONING",virtualAccount:existing,message:"Paystack is still provisioning the dedicated virtual account. Retry shortly."});

  const secret=process.env.PAYSTACK_SECRET_KEY;
  if(!secret)return res.status(503).json({error:"Paystack virtual accounts are not configured"});
  const user=(await pool!.query("SELECT full_name,email,phone FROM users WHERE id=$1",[userId])).rows[0];
  if(!user?.email)return res.status(409).json({error:"A verified customer email is required to create a dedicated virtual account"});
  const names=String(user.full_name).trim().split(/\\s+/);
  const firstName=names.shift() ?? "SwiftDrop";
  const lastName=names.join(" ") || "Customer";
  const headers={authorization:"Bearer "+secret,"content-type":"application/json"};
  const preferredBank=process.env.PAYSTACK_DVA_BANK_SLUG || (process.env.PAYSTACK_SECRET_KEY?.startsWith("sk_test_") ? "test-bank" : undefined);
  const provisioning=(await pool!.query(
    `INSERT INTO virtual_accounts(user_id,order_id,customer_code,provider_slug,status,updated_at)
     VALUES($1,$2,NULL,$3,'PROVISIONING',now())
     ON CONFLICT(order_id) DO UPDATE SET user_id=EXCLUDED.user_id,provider_slug=EXCLUDED.provider_slug,status='PROVISIONING',updated_at=now()
     RETURNING *`,
    [userId,order.id,preferredBank ?? null]
  )).rows[0];

  const customerResponse=await fetch("https://api.paystack.co/customer",{method:"POST",headers,body:JSON.stringify({
    email:user.email,first_name:firstName,last_name:lastName,phone:String(user.phone ?? "")
  }),signal:AbortSignal.timeout(15_000)});
  const customerPayload=await customerResponse.json() as any;
  if(!customerResponse.ok||!customerPayload.status||!customerPayload.data?.customer_code){
    await pool!.query("UPDATE virtual_accounts SET status='FAILED',updated_at=now() WHERE order_id=$1",[order.id]);
    return res.status(502).json({error:customerPayload.message ?? "Unable to create Paystack customer for virtual account"});
  }
  await pool!.query(
    "UPDATE virtual_accounts SET customer_code=$2,updated_at=now() WHERE order_id=$1",
    [order.id,customerPayload.data.customer_code]
  );

  const dvaResponse=await fetch("https://api.paystack.co/dedicated_account",{method:"POST",headers,body:JSON.stringify({
    customer:customerPayload.data.customer_code,
    ...(preferredBank ? {preferred_bank:preferredBank} : {}),
    first_name:firstName,last_name:lastName,phone:user.phone
  }),signal:AbortSignal.timeout(15_000)});
  const dvaPayload=await dvaResponse.json() as any;
  if(!dvaResponse.ok||!dvaPayload.status){
    await pool!.query("UPDATE virtual_accounts SET status='FAILED',provider_reference=$2,updated_at=now() WHERE order_id=$1",[order.id,String(dvaPayload.data?.id ?? "") || null]);
    return res.status(502).json({error:dvaPayload.message ?? "Unable to create dedicated virtual account"});
  }
  const data=dvaPayload.data ?? {};
  const providerSlug=String(data.bank?.slug ?? data.preferred_bank ?? preferredBank ?? "") || null;
  if(!data.account_number){
    await pool!.query(
      "UPDATE virtual_accounts SET provider_slug=$2,provider_reference=$3,status='PROVISIONING',updated_at=now() WHERE order_id=$1",
      [order.id,providerSlug,String(data.id ?? "") || null]
    );
    return res.status(202).json({
      status:"PROVISIONING",
      virtualAccount:(await pool!.query("SELECT * FROM virtual_accounts WHERE order_id=$1",[order.id])).rows[0],
      customerCode:customerPayload.data.customer_code,
      message:"Paystack is provisioning the dedicated virtual account. Retry shortly."
    });
  }

  const saved=(await pool!.query(
    `UPDATE virtual_accounts
        SET customer_code=$2,account_name=$3,account_number=$4,bank_name=$5,bank_code=$6,provider_reference=$7,provider_slug=$8,status='ACTIVE',updated_at=now()
      WHERE order_id=$1
      RETURNING *`,
    [order.id,customerPayload.data.customer_code,data.account_name,data.account_number,data.bank?.name ?? null,data.bank?.id ? String(data.bank.id) : null,String(data.id ?? customerPayload.data.customer_code),providerSlug]
  )).rows[0];
  await pool!.query(
    `INSERT INTO escrow_payment_attempts(order_id,method,provider_reference,amount_minor,idempotency_key)
     VALUES($1,'BANK_TRANSFER',NULL,$2,$3)
     ON CONFLICT(idempotency_key) DO NOTHING`,
    [order.id,Number(order.escrow_total_paid_minor),`dva:${order.id}`]
  );
  return res.status(201).json({virtualAccount:saved,displayMessage:`Transfer ₦${(Number(order.escrow_total_paid_minor)/100).toLocaleString()} to ${data.account_number} (${data.bank?.name ?? "Paystack bank"})`});
});

export async function requeryPendingDvaAccounts(): Promise<void> {
  if(!pool || !process.env.PAYSTACK_SECRET_KEY) return;
  const rows=(await pool.query(
    `SELECT va.account_number,va.provider_slug
       FROM virtual_accounts va
       JOIN escrow_payment_attempts epa ON epa.order_id=va.order_id
      WHERE va.status='ACTIVE'
        AND va.account_number IS NOT NULL
        AND epa.method='BANK_TRANSFER'
        AND epa.status='PENDING'
      GROUP BY va.account_number,va.provider_slug
      ORDER BY MIN(epa.updated_at) ASC
      LIMIT 25`
  )).rows;
  const date=new Date().toISOString().slice(0,10);
  for(const row of rows){
    const providerSlug=String(row.provider_slug ?? process.env.PAYSTACK_DVA_PROVIDER_SLUG ?? "").trim();
    if(!providerSlug) continue;
    try{
      await fetch(
        "https://api.paystack.co/dedicated_account/requery?account_number="+encodeURIComponent(String(row.account_number))+"&provider_slug="+encodeURIComponent(providerSlug)+"&date="+date,
        {headers:{authorization:"Bearer "+process.env.PAYSTACK_SECRET_KEY},signal:AbortSignal.timeout(10_000)}
      );
    }catch{
      // Keep the bank-transfer attempt pending; the next scheduled requery retries it.
    }
  }
}

router.get("/wallet/balance", requireAuth(), async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const userId=authUser(req);
  const row=(await pool!.query("SELECT * FROM stakeholder_wallets WHERE user_id=$1",[userId])).rows[0];
  return res.json({wallet:row ?? {balance_minor:0,pending_minor:0,currency:"NGN"}});
});

router.post("/wallet/recipient", requireAuth(), async (req,res)=>{
  if(!databaseEnabled())return res.status(503).json({error:"Database unavailable"});
  const parsed=z.object({bankCode:z.string().regex(/^\\d{3,6}$/),accountNumber:z.string().regex(/^\\d{10}$/)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"A valid Nigerian bank code and 10-digit account number are required"});
  const userId=authUser(req);
  const secret=process.env.PAYSTACK_SECRET_KEY;
  if(!secret)return res.status(503).json({error:"Paystack transfers are not configured"});
  const headers={authorization:"Bearer "+secret,"content-type":"application/json"};
  const resolveResponse=await fetch("https://api.paystack.co/bank/resolve?account_number="+encodeURIComponent(parsed.data.accountNumber)+"&bank_code="+encodeURIComponent(parsed.data.bankCode),{headers:{authorization:"Bearer "+secret}});
  const resolved=await resolveResponse.json() as any;
  if(!resolveResponse.ok||!resolved.status||!resolved.data?.account_name)return res.status(400).json({error:resolved.message ?? "Unable to verify the bank account"});
  const recipientResponse=await fetch("https://api.paystack.co/transferrecipient",{method:"POST",headers,body:JSON.stringify({type:"nuban",name:resolved.data.account_name,account_number:parsed.data.accountNumber,bank_code:parsed.data.bankCode,currency:"NGN"})});
  const recipient=await recipientResponse.json() as any;
  if(!recipientResponse.ok||!recipient.status||!recipient.data?.recipient_code)return res.status(400).json({error:recipient.message ?? "Unable to create payout recipient"});
  let wallet=(await pool!.query("SELECT * FROM stakeholder_wallets WHERE user_id=$1",[userId])).rows[0];
  if(!wallet){
    const user=(await pool!.query("SELECT business_role,role FROM users WHERE id=$1",[userId])).rows[0];
    const stakeholderType=String(user?.business_role ?? "").toUpperCase()==="MERCHANT"?"MERCHANT":
      String(user?.business_role ?? "").toUpperCase()==="AGENT"?"AGENT":
      String(user?.business_role ?? "").toUpperCase()==="ERRAND"?"ERRAND_RUNNER":
      String(user?.business_role ?? "").toUpperCase()==="COURIER" || String(user?.role ?? "").toUpperCase()==="DRIVER"?"COURIER":"CUSTOMER";
    wallet=await ensureWallet(userId,stakeholderType);
  }
  const saved=(await pool!.query("UPDATE stakeholder_wallets SET paystack_recipient_code=$2,bank_account_verified=true,updated_at=now() WHERE id=$1 RETURNING id,user_id,balance_minor,pending_minor,currency,paystack_recipient_code,bank_account_verified",[wallet.id,String(recipient.data.recipient_code)])).rows[0];
  return res.status(201).json({wallet:saved,accountName:resolved.data.account_name,bankCode:parsed.data.bankCode,accountLast4:parsed.data.accountNumber.slice(-4)});
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
    if(!wallet){await client.query("ROLLBACK");return res.status(404).json({error:"Wallet not found"});}
    if(Number(wallet.balance_minor)<parsed.data.amountMinor)return res.status(409).json({error:"Insufficient available balance"});
    const duplicate=(await client.query("SELECT * FROM payout_requests WHERE idempotency_key=$1",[parsed.data.idempotencyKey])).rows[0];
    if(duplicate){await client.query("COMMIT");return res.json({payout:duplicate});}
    if(!wallet.paystack_recipient_code || !wallet.bank_account_verified){
      await client.query("ROLLBACK");
      return res.status(409).json({error:"A verified Paystack payout recipient is required before withdrawal"});
    }
    // Paystack transfer references are provider identifiers, not client idempotency keys.
    // Generate a server-authoritative, provider-compliant lowercase reference so arbitrary
    // client idempotency-key casing/characters can never make the transfer invalid.
    const walletProviderReference = createWalletPayoutProviderReference();
    const payout=(await client.query(
      "INSERT INTO payout_requests(wallet_id,user_id,amount_minor,idempotency_key,status,provider_reference) VALUES($1,$2,$3,$4,'PROCESSING',$5) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *",
      [wallet.id,userId,parsed.data.amountMinor,parsed.data.idempotencyKey,walletProviderReference]
    )).rows[0];
    if(!payout){await client.query("ROLLBACK");return res.status(409).json({error:"Payout request could not be reserved"});}
    await client.query("UPDATE stakeholder_wallets SET balance_minor=balance_minor-$2,pending_minor=pending_minor+$2,updated_at=now() WHERE id=$1",[wallet.id,parsed.data.amountMinor]);
    await client.query("COMMIT");

    const secret=process.env.PAYSTACK_SECRET_KEY;
    if(!secret){
      await pool!.query("UPDATE stakeholder_wallets SET balance_minor=balance_minor+$2,pending_minor=GREATEST(0,pending_minor-$2),updated_at=now() WHERE id=$1",[wallet.id,parsed.data.amountMinor]);
      await pool!.query("UPDATE payout_requests SET status='FAILED',failure_reason='Paystack transfers are not configured',processed_at=now(),updated_at=now() WHERE id=$1 AND status='PROCESSING'",[payout.id]);
      return res.status(503).json({error:"Paystack transfers are not configured"});
    }

    const reference=String(payout.provider_reference);
    let providerResponse: Response;
    try{
      providerResponse=await fetch("https://api.paystack.co/transfer",{
        method:"POST",
        headers:{authorization:"Bearer "+secret,"content-type":"application/json"},
        body:JSON.stringify({source:"balance",amount:parsed.data.amountMinor,recipient:wallet.paystack_recipient_code,reason:"SwiftDrop wallet withdrawal",reference}),
        signal:AbortSignal.timeout(15_000)
      });
    }catch(error){
      return res.status(202).json({
        payout,
        provider:"paystack_transfers",
        status:"PROCESSING",
        message:"Transfer request may have reached Paystack. The payout is retained for webhook/reconciliation verification.",
        reconciliationKey:reference,
        detail:process.env.NODE_ENV==="test" ? (error instanceof Error ? error.message : String(error)) : undefined
      });
    }

    const providerPayload=await providerResponse.json() as any;
    if(!providerResponse.ok||!providerPayload.status||!providerPayload.data?.reference){
      await pool!.query("UPDATE stakeholder_wallets SET balance_minor=balance_minor+$2,pending_minor=GREATEST(0,pending_minor-$2),updated_at=now() WHERE id=$1",[wallet.id,parsed.data.amountMinor]);
      await pool!.query("UPDATE payout_requests SET status='FAILED',failure_reason=$2,processed_at=now(),updated_at=now() WHERE id=$1 AND status='PROCESSING'",[payout.id,String(providerPayload.message ?? "Paystack transfer failed").slice(0,400)]);
      return res.status(502).json({error:providerPayload.message ?? "Paystack transfer failed"});
    }

    const providerReference=String(providerPayload.data.reference);
    const updated=(await pool!.query(
      "UPDATE payout_requests SET provider_reference=$2,status='PROCESSING',updated_at=now() WHERE id=$1 AND status='PROCESSING' RETURNING *",
      [payout.id,providerReference]
    )).rows[0] ?? payout;
    return res.status(201).json({payout:updated,provider:"paystack_transfers"});
  }catch(e){
    await client.query("ROLLBACK");
    return res.status(500).json({error:"Unable to create payout request"});
  }finally{client.release();}
});

export async function reconcileProcessingWalletPayouts(): Promise<void> {
  if(!pool || !process.env.PAYSTACK_SECRET_KEY) return;
  const candidates=(await pool.query(
    `SELECT id,provider_reference FROM payout_requests
      WHERE provider='paystack' AND status='PROCESSING' AND provider_reference IS NOT NULL
      ORDER BY requested_at ASC LIMIT 50`
  )).rows;
  for(const candidate of candidates){
    const reference=String(candidate.provider_reference);
    try{
      const response=await fetch("https://api.paystack.co/transfer/verify/"+encodeURIComponent(reference),{
        headers:{authorization:"Bearer "+process.env.PAYSTACK_SECRET_KEY},
        signal:AbortSignal.timeout(10_000)
      });
      const payload=await response.json() as any;
      if(!response.ok||!payload.status) continue;
      const providerStatus=String(payload.data?.status ?? "").toLowerCase();
      if(!["success","failed","reversed"].includes(providerStatus)) continue;
      const providerAmount=Number(payload.data?.amount);
      const providerCurrency=String(payload.data?.currency ?? "");
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        const locked=(await client.query(
          `SELECT pr.*,sw.balance_minor,sw.pending_minor,sw.currency,sw.id AS wallet_id
             FROM payout_requests pr JOIN stakeholder_wallets sw ON sw.id=pr.wallet_id
            WHERE pr.id=$1 FOR UPDATE OF pr,sw`,[candidate.id]
        )).rows[0];
        if(!locked || locked.status!=="PROCESSING"){await client.query("COMMIT");continue;}
        const amount=Number(locked.amount_minor);
        const matches=Number.isSafeInteger(providerAmount) && providerAmount===amount && providerCurrency===String(locked.currency ?? "NGN");
        if(providerStatus==="success" && matches){
          await client.query("UPDATE payout_requests SET status='RELEASED',processed_at=COALESCE(processed_at,now()),failure_reason=NULL,updated_at=now() WHERE id=$1 AND status='PROCESSING'",[locked.id]);
          await client.query("UPDATE stakeholder_wallets SET pending_minor=GREATEST(0,pending_minor-$2),updated_at=now() WHERE id=$1",[locked.wallet_id,amount]);
        }else{
          const reason=!matches ? "Paystack transfer amount or currency mismatch" : `Paystack transfer ${providerStatus}`;
          await client.query("UPDATE payout_requests SET status='FAILED',failure_reason=$2,processed_at=COALESCE(processed_at,now()),updated_at=now() WHERE id=$1 AND status='PROCESSING'",[locked.id,reason]);
          await client.query("UPDATE stakeholder_wallets SET balance_minor=balance_minor+$2,pending_minor=GREATEST(0,pending_minor-$2),updated_at=now() WHERE id=$1",[locked.wallet_id,amount]);
        }
        await client.query("COMMIT");
      }catch(error){
        await client.query("ROLLBACK");
      }finally{client.release();}
    }catch(error){
      // Keep PROCESSING so a transient Paystack/network outage can be reconciled later.
    }
  }
}

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
