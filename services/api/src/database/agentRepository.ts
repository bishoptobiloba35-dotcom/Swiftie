import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export async function approveAgentApplication(applicationId:string){
 if(!pool)throw new Error("DATABASE_URL is not configured");
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  const a=await c.query("SELECT * FROM agent_applications WHERE id=$1 AND status IN ('PENDING','UNDER_REVIEW') FOR UPDATE",[applicationId]);
  if(!a.rowCount){await c.query("ROLLBACK");return null;}
  const x=a.rows[0], code="AG-"+randomUUID().replaceAll("-","").slice(0,10).toUpperCase();
  await c.query("UPDATE agent_applications SET status='APPROVED',updated_at=now() WHERE id=$1",[applicationId]);
  const g=await c.query(`INSERT INTO agents(application_id,owner_user_id,agent_code,business_name,category,address,services)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[applicationId,x.applicant_user_id,code,x.business_name,x.category,x.address,x.services]);
  await c.query("COMMIT");return g.rows[0];
 }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
}

export async function getAgentForUser(userId:string){
 if(!pool)return null;const r=await pool.query("SELECT * FROM agents WHERE owner_user_id=$1 AND status='ACTIVE'",[userId]);return r.rows[0]??null;
}
export async function listAgents(){
 if(!pool)return[];const r=await pool.query("SELECT id,agent_code,business_name,category,address,latitude,longitude,opening_hours,storage_capacity,status,services FROM agents WHERE status='ACTIVE' ORDER BY business_name");return r.rows;
}
export async function createAgentShipment(input:{agentId:string;deliveryId:string;action:"DROP_OFF"|"PICKUP"|"RELEASE";userId:string;verificationCode?:string;conditionNote?:string}){
 if(!pool)throw new Error("DATABASE_URL is not configured");
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  const a=await c.query("SELECT id FROM agents WHERE id=$1 AND status='ACTIVE' FOR UPDATE",[input.agentId]);
  if(!a.rowCount){await c.query("ROLLBACK");return null;}
  const d=await c.query("SELECT id,status FROM deliveries WHERE id=$1 FOR UPDATE",[input.deliveryId]);
  if(!d.rowCount){await c.query("ROLLBACK");return null;}
  const r=await c.query(`INSERT INTO agent_shipments(agent_id,delivery_id,action,verification_code,condition_note,created_by_user_id,status)
   VALUES($1,$2,$3,$4,$5,$6,'PENDING') RETURNING *`,[input.agentId,input.deliveryId,input.action,input.verificationCode??null,input.conditionNote??null,input.userId]);
  await c.query("COMMIT");return r.rows[0];
 }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
}
export async function updateAgentShipment(shipmentId:string,agentUserId:string,status:"ACCEPTED"|"RELEASED"|"REJECTED",verificationCode?:string){
 if(!pool)return null;const c=await pool.connect();
 try{
  await c.query("BEGIN");
  const s=await c.query(`SELECT ash.* FROM agent_shipments ash JOIN agents a ON a.id=ash.agent_id
   WHERE ash.id=$1 AND a.owner_user_id=$2 AND a.status='ACTIVE' FOR UPDATE`,[shipmentId,agentUserId]);
  if(!s.rowCount){await c.query("ROLLBACK");return null;}
  const row=s.rows[0];
  if(status==="RELEASED" && row.verification_code && row.verification_code!==verificationCode){await c.query("ROLLBACK");return null;}
  const r=await c.query("UPDATE agent_shipments SET status=$2,released_at=CASE WHEN $2='RELEASED' THEN now() ELSE released_at END WHERE id=$1 RETURNING *",[shipmentId,status]);
  await c.query("COMMIT");return r.rows[0];
 }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
}
export async function addAgentEvidence(shipmentId:string,agentUserId:string,type:string,key:string,contentType:string){
 if(!pool)return null;
 const r=await pool.query(`INSERT INTO agent_evidence(agent_shipment_id,evidence_type,object_key,content_type)
 SELECT $1,$3,$4,$5 WHERE EXISTS (
 SELECT 1 FROM agent_shipments s JOIN agents a ON a.id=s.agent_id WHERE s.id=$1 AND a.owner_user_id=$2 AND a.status='ACTIVE'
 ) RETURNING *`,[shipmentId,agentUserId,type,key,contentType]);
 return r.rows[0]??null;
}
export async function listAgentShipments(agentId:string){
 if(!pool)return[];const r=await pool.query("SELECT * FROM agent_shipments WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 100",[agentId]);return r.rows;
}
