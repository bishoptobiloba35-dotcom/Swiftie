import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

type Metrics={customers:number;drivers:number;onlineDrivers:number;deliveries:number;activeDeliveries:number;openDisputes:number;pendingPayouts:number};
type Driver={id:string;userId:string;status:string;online:boolean;vehicle_type?:string;vehicle_registration?:string;full_name?:string;phone?:string;email?:string};
type Dispute={id:string;deliveryId:string;openedBy:string;reason:string;description?:string;status:string};

function App(){
 const [token,setToken]=React.useState(localStorage.getItem("swiftdrop.adminToken")??"");
 const [phone,setPhone]=React.useState(""); const [password,setPassword]=React.useState("");
 const [metrics,setMetrics]=React.useState<Metrics|null>(null); const [drivers,setDrivers]=React.useState<Driver[]>([]);
 const [disputes,setDisputes]=React.useState<Dispute[]>([]);
 const [documents,setDocuments]=React.useState<any[]>([]);
 const [payouts,setPayouts]=React.useState<any[]>([]);\n const [deliveries,setDeliveries]=React.useState<any[]>([]); const [error,setError]=React.useState("");
 const call=async(path:string,init:RequestInit={})=>{const res=await fetch(API_URL+path,{...init,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{}),...(init.headers||{})}}); const data=await res.json(); if(!res.ok) throw new Error(data.error??"Request failed"); return data;};
 async function login(){try{const d=await call("/api/auth/login",{method:"POST",body:JSON.stringify({phone,password})});if(d.user?.role!=="ADMIN")throw new Error("This account is not an admin account.");localStorage.setItem("swiftdrop.adminToken",d.accessToken);setToken(d.accessToken);setError("");}catch(e){setError(e instanceof Error?e.message:"Login failed");}}
 async function refresh(){try{const [m,d,ds,dl,p]=await Promise.all([call("/api/admin/operations"),call("/api/admin/drivers"),call("/api/admin/disputes"),call("/api/admin/deliveries?limit=50"),call("/api/admin/payouts")]);setMetrics(m.metrics??m);setDrivers(d.drivers??d);setDisputes(ds.disputes??ds);setDeliveries(dl.deliveries??[]);setPayouts(p.payouts??[]);setError("");}catch(e){setError(e instanceof Error?e.message:"Unable to load admin data");}}
 React.useEffect(()=>{if(token)void refresh();},[token]);
 async function approve(id:string){await call("/api/admin/drivers/"+id+"/approve",{method:"POST"});await refresh();}
 async function suspend(id:string){await call("/api/admin/drivers/"+id+"/suspend",{method:"POST"});await refresh();}
 async function reviewDocuments(driverId:string){
   const d=await call("/api/admin/drivers/"+driverId+"/documents");
   const docs=d.documents??[];
   for(const doc of docs.filter((x:any)=>x.status==="PENDING")){
     const ok=confirm("Review "+doc.document_type+" for "+driverId.slice(0,8)+"?\\n\\n"+doc.document_url);
     if(!ok) continue;
     const approved=confirm("Approve this document? Cancel means reject.");
     const note=prompt("Review note")??"";
     await call("/api/admin/driver-documents/"+doc.id+"/review",{method:"POST",body:JSON.stringify({status:approved?"APPROVED":"REJECTED",note})});
   }
   await refresh();
 }
 async function resolve(id:string,status:"RESOLVED_REFUND"|"RESOLVED_RELEASE"){const note=prompt("Resolution note");if(!note)return;await call("/api/admin/deliveries/"+id+"/dispute/resolve",{method:"POST",body:JSON.stringify({resolution:status,note})});await refresh();}
 if(!token)return <main className="auth"><section className="panel"><h1>SwiftDrop Admin</h1><p>Operations control center</p><input placeholder="Phone" value={phone} onChange={e=>setPhone(e.target.value)}/><input placeholder="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)}/><button onClick={()=>void login()}>Sign in</button>{error&&<p className="error">{error}</p>}</section></main>;
 return <main><header><div><h1>SwiftDrop Admin</h1><span>Operations control center</span></div><div><button onClick={()=>void refresh()}>Refresh</button><button className="ghost" onClick={()=>{localStorage.removeItem("swiftdrop.adminToken");setToken("");}}>Sign out</button></div></header>
 {error&&<div className="error banner">{error}</div>}
 <section className="grid">{metrics&&Object.entries({Customers:metrics.customers,Drivers:metrics.drivers,"Online drivers":metrics.onlineDrivers,Deliveries:metrics.deliveries,"Active deliveries":metrics.activeDeliveries,"Open disputes":metrics.openDisputes,"Pending payouts":metrics.pendingPayouts}).map(([k,v])=><article className="metric" key={k}><span>{k}</span><strong>{v}</strong></article>)}</section>
 <section className="columns"><article className="panel"><h2>Driver verification</h2>{drivers.map(d=><div className="row" key={d.id}><div><strong>{d.full_name??d.id.slice(0,8)}</strong><small>{d.status} · {d.online?"Online":"Offline"}{d.vehicle_registration?` · ${d.vehicle_registration}`:""}</small></div><div>{d.status==="PENDING"&&<button onClick={()=>void approve(d.id)}>Approve</button>}<button className="ghost" onClick={()=>void reviewDocuments(d.id)}>KYC</button>{d.status==="APPROVED"&&<button className="danger" onClick={()=>void suspend(d.id)}>Suspend</button>}</div></div>)}</article>
 <article className="panel"><h2>Disputes</h2>{disputes.map(d=><div className="row" key={d.id}><div><strong>{d.reason}</strong><small>{d.deliveryId.slice(0,8)} · {d.status}</small></div>{(d.status==="OPEN"||d.status==="UNDER_REVIEW")&&<div><button onClick={()=>void resolve(d.deliveryId,"RESOLVED_RELEASE")}>Release</button><button className="danger" onClick={()=>void resolve(d.deliveryId,"RESOLVED_REFUND")}>Refund</button></div>}</div>)}</article></section>
 <section className="panel"><h2>Payouts</h2>{payouts.map((p:any)=><div className="row" key={p.id}><div><strong>{p.delivery_id?.slice(0,8)}</strong><small>{p.status} · ₦{(Number(p.amount_minor||0)/100).toLocaleString()} · {p.provider_status??"not sent"}</small>{p.failure_reason&&<small>{p.failure_reason}</small>}</div><div>{(p.status==="FAILED"||p.status==="CANCELLED")&&<button onClick={async()=>{try{await call("/api/admin/payouts/"+p.delivery_id+"/retry",{method:"POST"});await refresh();}catch(e){setError(e instanceof Error?e.message:"Unable to retry payout");}}}>Retry</button>}</div></div>)}</section>
 <section className="panel"><h2>Live delivery monitoring</h2>{deliveries.map((d:any)=><div className="row" key={d.id}><div><strong>{d.tracking_code}</strong><small>{d.status} · {d.receiver_name}</small></div><div><small>{d.latest_location?`GPS ${Number(d.latest_location.latitude).toFixed(5)}, ${Number(d.latest_location.longitude).toFixed(5)}`:"No GPS update yet"}</small></div></div>)}</section>
 </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
