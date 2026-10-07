import { pool } from "./database/db.js";

const RELEASE_HOURS=72;
const FLOAT_MIN_RESERVE_MINOR=500000000;

export async function processPhase2EscrowReleases(): Promise<number> {
  if(!pool) return 0;
  const client=await pool.connect();
  let released=0;
  try{
    await client.query("BEGIN");
    const rows=(await client.query(
      `SELECT el.*,d.merchant_user_id,d.sender_id AS customer_user_id
         FROM escrow_ledgers el
         JOIN deliveries d ON d.id=el.order_id
        WHERE el.state='dispute_window'
          AND el.stakeholder_release_at IS NOT NULL
          AND el.stakeholder_release_at<=now()
          AND NOT EXISTS (
            SELECT 1 FROM disputes ds
             WHERE ds.delivery_id=el.order_id
               AND ds.status IN ('OPEN','UNDER_REVIEW')
          )
        FOR UPDATE OF el,d
        LIMIT 50`
    )).rows;
    for(const row of rows){
      const merchantShare=Number(row.merchant_share_minor ?? 0);
      if(row.merchant_user_id && merchantShare>0){
        const wallet=(await client.query(
          `INSERT INTO stakeholder_wallets(user_id,stakeholder_type,pending_minor,balance_minor)
           VALUES($1,'MERCHANT',0,0)
           ON CONFLICT(user_id) DO UPDATE SET stakeholder_type='MERCHANT'
           RETURNING id`,
          [row.merchant_user_id]
        )).rows[0];
        await client.query(
          "UPDATE stakeholder_wallets SET pending_minor=GREATEST(0,pending_minor-$2),balance_minor=balance_minor+$2,updated_at=now() WHERE id=$1",
          [wallet.id,merchantShare]
        );
        const balance=(await client.query("SELECT balance_minor FROM stakeholder_wallets WHERE id=$1",[wallet.id])).rows[0];
        await client.query(
          `INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,idempotency_key,metadata)
           VALUES($1,$2,'MERCHANT_T72_SETTLEMENT','CREDIT',$3,$4,$5,'{}'::jsonb)
           ON CONFLICT(idempotency_key) DO NOTHING`,
          [wallet.id,row.order_id,merchantShare,Number(balance.balance_minor),`merchant-t72-${row.order_id}`]
        );
      }
      const protectionReserve=Number(row.protection_reserve_minor);
      if(row.customer_user_id && protectionReserve>0){
        const wallet=(await client.query(
          `INSERT INTO stakeholder_wallets(user_id,stakeholder_type,pending_minor,balance_minor)
           VALUES($1,'CUSTOMER',0,0)
           ON CONFLICT(user_id) DO UPDATE SET stakeholder_type='CUSTOMER'
           RETURNING id`,
          [row.customer_user_id]
        )).rows[0];
        await client.query(
          "UPDATE stakeholder_wallets SET balance_minor=balance_minor+$2,updated_at=now() WHERE id=$1",
          [wallet.id,protectionReserve]
        );
        const balance=(await client.query("SELECT balance_minor FROM stakeholder_wallets WHERE id=$1",[wallet.id])).rows[0];
        await client.query(
          `INSERT INTO wallet_transactions(wallet_id,order_id,type,direction,amount_minor,balance_after_minor,idempotency_key,metadata)
           VALUES($1,$2,'PROTECTION_RESERVE_RELEASE','CREDIT',$3,$4,$5,'{"reason":"successful_delivery_72_hour_release"}'::jsonb)
           ON CONFLICT(idempotency_key) DO NOTHING`,
          [wallet.id,row.order_id,protectionReserve,Number(balance.balance_minor),`protection-release-${row.order_id}`]
        );
      }
      const heldForSwiftDrop=Number(row.service_charge_minor)+Number(row.swiftdrop_margin_minor);
      if(heldForSwiftDrop>0){
        const latest=(await client.query("SELECT balance_after_minor FROM float_transactions ORDER BY created_at DESC LIMIT 1 FOR UPDATE")).rows[0];
        const balance=Number(latest?.balance_after_minor ?? 0);
        const next=balance-heldForSwiftDrop;
        if(!Number.isSafeInteger(balance) || next<FLOAT_MIN_RESERVE_MINOR){
          throw new Error(`Insufficient SwiftDrop float reserve for 72-hour escrow release: order=${row.order_id} balance=${balance} required=${heldForSwiftDrop+FLOAT_MIN_RESERVE_MINOR}`);
        }
        await client.query(
          `INSERT INTO float_transactions(type,amount_minor,balance_after_minor,order_id,metadata)
           VALUES('ESCROW_OUT',$1,$2,$3,$4::jsonb)
           ON CONFLICT DO NOTHING`,
          [heldForSwiftDrop,next,row.order_id,JSON.stringify({reason:"stakeholder_72_hour_release"})]
        );
      }
      await client.query(
        `UPDATE escrow_ledgers
            SET state='released',released_at=COALESCE(released_at,now()),updated_at=now()
          WHERE id=$1 AND state='dispute_window'`,
        [row.id]
      );
      await client.query(
        `UPDATE deliveries SET escrow_payment_state='released',escrow_released_at=COALESCE(escrow_released_at,now()) WHERE id=$1`,
        [row.order_id]
      );
      await client.query(
        `UPDATE payments SET status='RELEASED',escrow_status='RELEASED',updated_at=now()
          WHERE delivery_id=$1 AND status='HELD' AND collection_mode='SENDER_ESCROW'`,
        [row.order_id]
      );
      released++;
    }
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  return released;
}

export async function reconcilePhase2Float(reconciledBy?: string): Promise<void> {
  if(!pool) return;
  const client=await pool.connect();
  try{
    const latest=(await client.query("SELECT balance_after_minor FROM float_transactions ORDER BY created_at DESC LIMIT 1")).rows[0];
    const recorded=Number(latest?.balance_after_minor ?? 0);
    const held=(await client.query(
      `SELECT COALESCE(SUM(total_paid_minor-courier_share_minor),0) AS held
         FROM escrow_ledgers
        WHERE state IN ('paid_escrow','picked_up','in_transit','arrived','pin_confirmed','dispute_window')`
    )).rows[0];
    const walletLiability=(await client.query(
      "SELECT COALESCE(SUM(balance_minor+pending_minor),0) AS total FROM stakeholder_wallets"
    )).rows[0];
    const expected=Number(held?.held ?? 0)+Number(walletLiability?.total ?? 0);
    const variance=recorded-expected;
    await client.query(
      `INSERT INTO float_reconciliations(reconciliation_date,expected_balance_minor,recorded_balance_minor,variance_minor,reconciled_by,status)
       VALUES(current_date,$1,$2,$3,$4,$5)
       ON CONFLICT(reconciliation_date) DO UPDATE SET expected_balance_minor=EXCLUDED.expected_balance_minor,recorded_balance_minor=EXCLUDED.recorded_balance_minor,variance_minor=EXCLUDED.variance_minor,reconciled_by=EXCLUDED.reconciled_by,reconciled_at=now(),status=EXCLUDED.status`,
      [expected,recorded,variance,reconciledBy ?? null,variance===0?"MATCHED":"VARIANCE"]
    );
  }finally{client.release();}
}
