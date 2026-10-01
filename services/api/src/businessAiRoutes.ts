  const id=String(req.params.id),client=await pool.connect();
  try{
    await client.query("BEGIN");
    const row=(await client.query("SELECT s.*,a.recipient_code,a.active AS account_active FROM buy_order_settlements s JOIN agent_settlement_accounts a ON a.agent_id=s.agent_id WHERE s.id=$1 FOR UPDATE",[id])).rows[0];
    if(!row){await client.query("ROLLBACK");return res.status(404).json({error:"Settlement not found"});}
    if(!["PENDING","FAILED"].includes(row.status)){await client.query("ROLLBACK");return res.status(409).json({error:"Settlement is not eligible for payout"});}
    if(!row.account_active||Number(row.amount_minor)<=0){await client.query("ROLLBACK");return res.status(409).json({error:"Active payout account and positive settlement are required"});}
    const reference="sd_buyset_"+randomUUID().replaceAll("-","");
    await client.query("UPDATE buy_order_settlements SET status='PROCESSING',transfer_reference=$2,provider_status='pending',failure_reason=NULL,updated_at=now() WHERE id=$1",[id,reference]);
    await client.query("COMMIT");
    let response: Response;
    try {
      response = await fetch("https://api.paystack.co/transfer",{
        method:"POST",
        headers:{authorization:"Bearer "+secret,"content-type":"application/json"},
        body:JSON.stringify({source:"balance",amount:Number(row.amount_minor),recipient:row.recipient_code,reference,reason:"SwiftDrop Buy & Deliver agent settlement",currency:row.currency}),
        signal:AbortSignal.timeout(15_000)
      });
    } catch (error) {
      // A timeout/network failure is inconclusive: Paystack may have accepted the
      // transfer. Keep PROCESSING so reconciliation can verify the unique reference
      // instead of risking a duplicate transfer.
      await pool.query(
        "UPDATE buy_order_settlements SET provider_status='unknown',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='PROCESSING'",
        [id,error instanceof Error ? error.message : "Paystack transfer result is inconclusive"]
      );
      return res.status(202).json({error:"Settlement transfer result is pending provider reconciliation",code:"PAYOUT_RECONCILIATION_REQUIRED"});
    }
    const payload=await response.json() as any;
    if(!response.ok||!payload.status||!payload.data?.reference){
      await pool.query("UPDATE buy_order_settlements SET status='FAILED',provider_status='failed',failure_reason=$2,updated_at=now() WHERE id=$1 AND status='PROCESSING'",[id,payload.message??"Paystack transfer failed"]);
      return res.status(502).json({error:payload.message??"Paystack transfer could not be initiated"});
    }
    if(payload.data.reference!==reference)await pool.query("UPDATE buy_order_settlements SET transfer_reference=$2,updated_at=now() WHERE id=$1",[id,payload.data.reference]);
    return res.status(202).json({settlement:(await pool.query("SELECT * FROM buy_order_settlements WHERE id=$1",[id])).rows[0]});
  }catch(error){try{await client.query("ROLLBACK")}catch{}throw error}finally{client.release();}
});
router.post("/admin/drop-off/commission/:id/pay", requireAuth("ADMIN"), async(req,res)=>{
  if(!pool)return res.status(503).json({error:"Database is not configured"});
  const secret=process.env.PAYSTACK_SECRET_KEY;if(!secret)return res.status(503).json({error:"Paystack transfers are not configured"});
  const id=String(req.params.id),client=await pool.connect();
  try{
    await client.query("BEGIN");
    const row=(await client.query("SELECT c.*,a.recipient_code,a.active AS account_active FROM drop_off_commission_ledger c JOIN drop_off_settlement_accounts a ON a.location_id=c.location_id WHERE c.id=$1 FOR UPDATE",[id])).rows[0];
    if(!row){await client.query("ROLLBACK");return res.status(404).json({error:"Commission record not found"});}
    if(row.status!=="AVAILABLE"){await client.query("ROLLBACK");return res.status(409).json({error:"Commission is not available for payout"});}
    if(!row.account_active||Number(row.amount_minor)<=0){await client.query("ROLLBACK");return res.status(409).json({error:"Active payout account and positive commission are required"});}
    const reference="sd_drop_"+randomUUID().replaceAll("-","");
    await client.query("UPDATE drop_off_commission_ledger SET status='PROCESSING',provider_reference=$2,provider_status='pending',updated_at=now() WHERE id=$1 AND status='AVAILABLE'",[id,reference]);
    await client.query("COMMIT");
    const response=await fetch("https://api.paystack.co/transfer",{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({source:"balance",amount:Number(row.amount_minor),recipient:row.recipient_code,reference,reason:"SwiftDrop drop-off partner commission",currency:row.currency})});
    const payload=await response.json() as any;
    if(!response.ok||!payload.status||!payload.data?.reference){
      await pool.query("UPDATE drop_off_commission_ledger SET status='AVAILABLE',provider_status='failed',provider_reference=NULL,updated_at=now() WHERE id=$1 AND status='PROCESSING'",[id]);
      return res.status(502).json({error:payload.message??"Paystack transfer could not be initiated"});
    }
    if(payload.data.reference!==reference)await pool.query("UPDATE drop_off_commission_ledger SET provider_reference=$2,updated_at=now() WHERE id=$1",[id,payload.data.reference]);
    return res.status(202).json({commission:(await pool.query("SELECT * FROM drop_off_commission_ledger WHERE id=$1",[id])).rows[0]});