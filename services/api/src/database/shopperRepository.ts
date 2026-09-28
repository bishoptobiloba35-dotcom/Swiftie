import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export type ShoppingTask = {
  id:string; customerId:string; shopperId?:string|null; deliveryId?:string|null;
  taskType:string; status:string; title:string; notes?:string|null; destinationAddress?:string|null;
  budgetMinor:number; authorizedAmountMinor:number; actualAmountMinor?:number|null; currency:string;
  createdAt:string; updatedAt:string;
};

function task(row:any):ShoppingTask {
  return {id:row.id,customerId:row.customer_id,shopperId:row.shopper_id??null,deliveryId:row.delivery_id??null,
    taskType:row.task_type,status:row.status,title:row.title,notes:row.notes??null,destinationAddress:row.destination_address??null,
    budgetMinor:Number(row.budget_minor),authorizedAmountMinor:Number(row.authorized_amount_minor),actualAmountMinor:row.actual_amount_minor==null?null:Number(row.actual_amount_minor),
    currency:row.currency,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};
}

export async function createShoppingTask(input:{customerId:string;taskType:string;title:string;notes?:string;destinationAddress?:string;budgetMinor:number;deliveryId?:string}){
 if(!pool) throw new Error("DATABASE_URL is not configured");
 const c=await pool.query(`INSERT INTO shopping_tasks(customer_id,task_type,title,notes,destination_address,budget_minor,delivery_id)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[input.customerId,input.taskType,input.title,input.notes??null,input.destinationAddress??null,input.budgetMinor,input.deliveryId??null]);
 return task(c.rows[0]);
}
export async function addShoppingItem(input:{taskId:string;name:string;quantity:number;maxUnitPriceMinor?:number;substitutionPolicy?:string}){
 if(!pool) throw new Error("DATABASE_URL is not configured");
 const r=await pool.query(`INSERT INTO shopping_items(task_id,name,quantity,max_unit_price_minor,substitution_policy)
 VALUES($1,$2,$3,$4,$5) RETURNING *`,[input.taskId,input.name,input.quantity,input.maxUnitPriceMinor??null,input.substitutionPolicy??"ASK_FIRST"]);
 return r.rows[0];
}
export async function listShoppingItems(taskId:string){if(!pool)return[];const r=await pool.query("SELECT * FROM shopping_items WHERE task_id=$1 ORDER BY created_at ASC",[taskId]);return r.rows;}
export async function findShoppingTaskForUser(taskId:string,userId:string,role:"CUSTOMER"|"DRIVER"|"ADMIN"){
 if(!pool)return null;
 const q=role==="CUSTOMER"
 ? await pool.query("SELECT * FROM shopping_tasks WHERE id=$1 AND customer_id=$2",[taskId,userId])
 : role==="DRIVER"
 ? await pool.query("SELECT st.* FROM shopping_tasks st JOIN shopper_profiles sp ON sp.id=st.shopper_id WHERE st.id=$1 AND sp.user_id=$2",[taskId,userId])
 : await pool.query("SELECT * FROM shopping_tasks WHERE id=$1",[taskId]);
 return q.rows[0]?task(q.rows[0]):null;
}
export async function listCustomerShoppingTasks(userId:string){if(!pool)return[];const r=await pool.query("SELECT * FROM shopping_tasks WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100",[userId]);return r.rows.map(task);}
export async function applyAsShopper(userId:string,shopperType:"SHOPPER"|"ERRAND_PARTNER",serviceZones:string[]){
 if(!pool)throw new Error("DATABASE_URL is not configured");
 const r=await pool.query(`INSERT INTO shopper_profiles(user_id,shopper_type,service_zones) VALUES($1,$2,$3)
 ON CONFLICT(user_id) DO UPDATE SET shopper_type=EXCLUDED.shopper_type,service_zones=EXCLUDED.service_zones,updated_at=now()
 RETURNING *`,[userId,shopperType,serviceZones]);
 return r.rows[0];
}
export async function getShopperForUser(userId:string){if(!pool)return null;const r=await pool.query("SELECT * FROM shopper_profiles WHERE user_id=$1",[userId]);return r.rows[0]??null;}
export async function assignShoppingTask(taskId:string,shopperId:string){
 if(!pool)return null;const c=await pool.connect();
 try{await c.query("BEGIN");
 const r=await c.query(`SELECT id FROM shopping_tasks WHERE id=$1 AND status='AUTHORIZED' AND shopper_id IS NULL FOR UPDATE`,[taskId]);
 if(!r.rowCount){await c.query("ROLLBACK");return null;}
 const s=await c.query("SELECT id FROM shopper_profiles WHERE id=$1 AND status='APPROVED' FOR UPDATE",[shopperId]);
 if(!s.rowCount){await c.query("ROLLBACK");return null;}
 const u=await c.query("UPDATE shopping_tasks SET shopper_id=$2,status='ASSIGNED',updated_at=now() WHERE id=$1 RETURNING *",[taskId,shopperId]);
 await c.query("COMMIT");return task(u.rows[0]);
 }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
}
export async function authorizeShoppingTask(taskId:string,userId:string,amountMinor:number){
 if(!pool)return null;const c=await pool.connect();
 try{await c.query("BEGIN");
 const r=await c.query("SELECT * FROM shopping_tasks WHERE id=$1 AND customer_id=$2 FOR UPDATE",[taskId,userId]);
 if(!r.rowCount||amountMinor<Number(r.rows[0].budget_minor)){await c.query("ROLLBACK");return null;}
 const a=await c.query(`INSERT INTO shopping_authorizations(task_id,customer_id,amount_minor,status,approved_at)
 VALUES($1,$2,$3,'APPROVED',now()) ON CONFLICT(task_id) DO UPDATE SET amount_minor=EXCLUDED.amount_minor,status='APPROVED',approved_at=now(),updated_at=now() RETURNING *`,[taskId,userId,amountMinor]);
 const u=await c.query("UPDATE shopping_tasks SET authorized_amount_minor=$2,status='AUTHORIZED',updated_at=now() WHERE id=$1 RETURNING *",[taskId,amountMinor]);
 await c.query("COMMIT");return {task:task(u.rows[0]),authorization:a.rows[0]};
 }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
}
export async function updateShoppingItem(taskId:string,shopperId:string,itemId:string,input:{foundStatus:string;actualUnitPriceMinor?:number;actualQuantity?:number;substituteName?:string}){
 if(!pool)return null;
 const ok=await pool.query("SELECT 1 FROM shopping_tasks WHERE id=$1 AND shopper_id=$2 AND status IN ('ASSIGNED','SHOPPING','AWAITING_APPROVAL')",[taskId,shopperId]);
 if(!ok.rowCount)return null;
 const r=await pool.query(`UPDATE shopping_items SET found_status=$4,actual_unit_price_minor=$5,actual_quantity=$6,substitute_name=$7,updated_at=now()
 WHERE id=$1 AND task_id=$2 RETURNING *`,[itemId,taskId,input.foundStatus,input.actualUnitPriceMinor??null,input.actualQuantity??null,input.substituteName??null]);
 return r.rows[0]??null;
}
export async function recordShoppingEvidence(taskId:string,shopperId:string,type:string,objectKey:string,contentType:string){
 if(!pool)return null;
 const ok=await pool.query("SELECT 1 FROM shopping_tasks WHERE id=$1 AND shopper_id=$2",[taskId,shopperId]);if(!ok.rowCount)return null;
 const r=await pool.query(`INSERT INTO shopping_evidence(task_id,shopper_id,evidence_type,object_key,content_type) VALUES($1,$2,$3,$4,$5) RETURNING *`,[taskId,shopperId,type,objectKey,contentType]);return r.rows[0];
}
export async function setShoppingActual(taskId:string,shopperId:string,actualMinor:number){
 if(!pool)return null;
 const r=await pool.query(`UPDATE shopping_tasks SET actual_amount_minor=$3,status=CASE WHEN $3<=authorized_amount_minor THEN 'PURCHASED' ELSE 'AWAITING_APPROVAL' END,updated_at=now()
 WHERE id=$1 AND shopper_id=$2 AND status IN ('SHOPPING','ASSIGNED') RETURNING *`,[taskId,shopperId,actualMinor]);
 return r.rows[0]?task(r.rows[0]):null;
}
export async function approveShoppingOverage(taskId:string,userId:string,additionalMinor:number){
 if(!pool)return null;const c=await pool.connect();
 try{await c.query("BEGIN");const r=await c.query("SELECT * FROM shopping_tasks WHERE id=$1 AND customer_id=$2 AND status='AWAITING_APPROVAL' FOR UPDATE",[taskId,userId]);
 if(!r.rowCount){await c.query("ROLLBACK");return null;}const current=Number(r.rows[0].authorized_amount_minor),actual=Number(r.rows[0].actual_amount_minor);
 if(additionalMinor<actual-current){await c.query("ROLLBACK");return null;}
 const total=current+additionalMinor;await c.query("UPDATE shopping_authorizations SET amount_minor=$2,updated_at=now() WHERE task_id=$1",[taskId,total]);
 const u=await c.query("UPDATE shopping_tasks SET authorized_amount_minor=$2,status='PURCHASED',updated_at=now() WHERE id=$1 RETURNING *",[taskId,total]);
 await c.query("COMMIT");return task(u.rows[0]);
 }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
}
export async function reconcileShoppingTask(taskId:string,userId:string){
 if(!pool)return null;const r=await pool.query("SELECT * FROM shopping_tasks WHERE id=$1 AND customer_id=$2",[taskId,userId]);if(!r.rowCount)return null;
 const x=r.rows[0],budget=Number(x.budget_minor),auth=Number(x.authorized_amount_minor),actual=Number(x.actual_amount_minor??0);
 const refund=Math.max(0,auth-actual),additional=Math.max(0,actual-auth);
 const status=additional>0?"REQUIRES_APPROVAL":"SETTLED";
 const q=await pool.query(`INSERT INTO shopping_reconciliation(task_id,budget_minor,authorized_amount_minor,actual_amount_minor,refund_amount_minor,additional_approval_minor,status,note)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(task_id) DO UPDATE SET budget_minor=EXCLUDED.budget_minor,authorized_amount_minor=EXCLUDED.authorized_amount_minor,actual_amount_minor=EXCLUDED.actual_amount_minor,refund_amount_minor=EXCLUDED.refund_amount_minor,additional_approval_minor=EXCLUDED.additional_approval_minor,status=EXCLUDED.status,note=EXCLUDED.note RETURNING *`,[taskId,budget,auth,actual,refund,additional,status,additional>0?"Customer approval required for amount above authorization":"Unused authorization should be released/refunded"]);
 return q.rows[0];
}
export async function completeShoppingTask(taskId:string,actorUserId:string){
 if(!pool)return null;
 const r=await pool.query(`UPDATE shopping_tasks SET status='COMPLETED',updated_at=now() WHERE id=$1 AND (customer_id=$2 OR shopper_id=(SELECT id FROM shopper_profiles WHERE user_id=$2)) AND status IN ('PURCHASED','DELIVERING') RETURNING *`,[taskId,actorUserId]);
 return r.rows[0]?task(r.rows[0]):null;
}
