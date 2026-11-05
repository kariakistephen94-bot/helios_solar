'use client';
import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {apiRequest} from '@/lib/api';

type Summary={sent:number;failed:number;completed:number;uncertain:number;pending:number;attempts:number;contacted_leads?:number;replied_leads?:number;reply_rate?:number|null;delivered?:number;read?:number};
type Attempt={id:string;phone:string;name:string;status:'accepted'|'failed'|'unknown'|'reserved'|'replied'|'delivered'|'read';delivered_at?:string|null;read_at?:string|null;delivered_source?:string;read_source?:string;replied_at?:string;last_reply_at?:string;reply_count?:number;reply_preview?:string;attempted_at:string;detail:string|null};
type Activity={summary:Summary;items:Attempt[];total:number;sent_definition:string};
const labels={accepted:'Sent',failed:'Failed',unknown:'Uncertain',reserved:'Pending',replied:'Replied',delivered:'Delivered',read:'Read'};
const colors={accepted:{background:'#e4efdf',color:'#326241'},failed:{background:'#fbe7e1',color:'#a44432'},unknown:{background:'#fff0ce',color:'#87631c'},reserved:{background:'#e8edf8',color:'#465e98'},replied:{background:'#e6e3fb',color:'#62509a'},delivered:{background:'#e2f3ec',color:'#267358'},read:{background:'#e0ecff',color:'#365eae'}};

export default function OutreachActivity(){
 const [data,setData]=useState<Activity|null>(null),[filter,setFilter]=useState('all'),[page,setPage]=useState(0);
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[repliesOpen,setRepliesOpen]=useState(false);const seq=useRef(0);
 async function refresh(){
  const id=++seq.current;
  try{
   const result=await apiRequest<Activity>(`/v1/outreach/activity?status=${filter}&limit=20&offset=${page*20}`);
   if(id===seq.current){setData(result);setError('');}
  }catch(e){if(id===seq.current)setError(e instanceof Error?e.message:'Unable to load outreach activity.');}
  finally{if(id===seq.current)setLoading(false);}
 }
 useEffect(()=>{setLoading(true);void refresh();const timer=setInterval(()=>void refresh(),15000);const focus=()=>void refresh();window.addEventListener('focus',focus);return()=>{seq.current++;clearInterval(timer);window.removeEventListener('focus',focus)}},[filter,page]);
 return <section aria-label="WhatsApp outreach activity" style={{margin:'24px 0',padding:22,border:'1px solid #dce5dc',borderRadius:16,background:'#fff'}}>
  <div style={{display:'flex',justifyContent:'space-between',gap:16,alignItems:'center',flexWrap:'wrap'}}><div><small style={{fontWeight:700,color:'#52724b'}}>WHATSAPP ACTIVITY</small><h3 style={{marginTop:6}}>Outreach activity</h3></div><button className="button button-outline small" type="button" onClick={()=>void refresh()}>Refresh activity</button></div>
  {error&&<p className="notice error" role="alert" style={{marginTop:16}}>{error}</p>}
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:12,marginTop:20}}>
   {([{key:'sent',label:'Sent',bg:'#edf5e8'},{key:'failed',label:'Failed',bg:'#fff0eb'},{key:'completed',label:'Sent + failed',bg:'#f2f3ed'},{key:'uncertain',label:'Uncertain',bg:'#fff6df'},{key:'delivered',label:'Delivered',bg:'#e2f3ec'},{key:'read',label:'Read',bg:'#e0ecff'}] as const).map(card=><div key={card.key} style={{padding:18,borderRadius:12,background:card.bg}}><p style={{fontSize:12}}>{card.label}</p><strong style={{display:'block',fontSize:30,marginTop:6}}>{data?.summary[card.key]??'—'}</strong></div>)}
  </div>
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12,marginTop:12}}>
   <button type="button" onClick={()=>setRepliesOpen(true)} aria-haspopup="dialog" style={{textAlign:'left',border:'1px solid #dcd5f5',borderRadius:12,padding:18,background:'#f0edff',color:'inherit'}}>
    <span style={{fontSize:12}}>Replied leads</span><strong style={{display:'block',fontSize:30,marginTop:6}}>{data?.summary.replied_leads??'—'}</strong><span style={{fontSize:12}}>View who replied →</span>
   </button>
   <div style={{padding:18,borderRadius:12,background:'#eaf3ee'}}><p style={{fontSize:12}}>Reply conversion</p><strong style={{display:'block',fontSize:30,marginTop:6}}>{data?.summary.reply_rate==null?'—':`${data.summary.reply_rate}%`}</strong><p style={{fontSize:12}}>{data?.summary.replied_leads??'—'} replied / {data?.summary.contacted_leads??'—'} contacted leads</p></div>
  </div>
  {data&&<p style={{fontSize:12,marginTop:8}}>{data.summary.pending} pending · {data.summary.attempts} attempts</p>}
  <div style={{display:'flex',gap:12,alignItems:'center',margin:'18px 0'}}><label htmlFor="outreach-result-filter">Show</label><select id="outreach-result-filter" style={{maxWidth:220}} value={filter} onChange={e=>{setFilter(e.target.value);setPage(0)}}><option value="all">All outcomes</option><option value="accepted">All sent</option><option value="delivered">Delivered (includes read)</option><option value="read">Read</option><option value="failed">Failed</option><option value="replied">Replied leads</option><option value="unknown">Uncertain</option><option value="reserved">Pending</option></select></div>
  {loading&&<p role="status">Loading outreach activity…</p>}
  {!loading&&data&&<><div style={{overflowX:'auto'}}><table className="leads-table" style={{width:'100%'}}><thead><tr><th>Contact</th><th>Phone number</th><th>Outcome</th><th>{filter==='replied'?'Last reply · Nigeria':'Time · Nigeria'}</th></tr></thead><tbody>{data.items.map(item=><tr key={item.id}><td><strong>{item.name}</strong>{item.reply_preview&&<p style={{fontSize:12,marginTop:6,maxWidth:350,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.reply_preview}</p>}{item.detail&&<p style={{fontSize:12,marginTop:4}}>{item.detail}</p>}</td><td style={{whiteSpace:'nowrap'}}>{item.phone}</td><td><span style={{...colors[item.status],display:'inline-block',borderRadius:20,padding:'5px 12px',fontSize:12,fontWeight:600}}>{labels[item.status]}</span>{item.read_at&&<p style={{fontSize:11,marginTop:5}}>{item.read_source==='observed'?'Read observed':'Read reported'}: {new Date(item.read_at).toLocaleString('en-NG',{timeZone:'Africa/Lagos'})}</p>}{!item.read_at&&item.delivered_at&&<p style={{fontSize:11,marginTop:5}}>{item.delivered_source==='observed'?'Delivery observed':'Delivery reported'}: {new Date(item.delivered_at).toLocaleString('en-NG',{timeZone:'Africa/Lagos'})}</p>}</td><td style={{whiteSpace:'nowrap'}}>{new Date(item.last_reply_at||item.attempted_at).toLocaleString('en-NG',{timeZone:'Africa/Lagos'})}</td></tr>)}</tbody></table></div>{!data.items.length&&<p style={{padding:'16px 0'}}>No recorded attempts match this outcome.</p>}<div style={{display:'flex',gap:12,alignItems:'center',marginTop:16,flexWrap:'wrap'}}><span>{data.total} {filter==='replied'?'replied leads':'matching attempts'}</span><button type="button" className="button button-outline small" disabled={!page} onClick={()=>setPage(page-1)}>Previous attempts</button><button type="button" className="button button-outline small" disabled={(page+1)*20>=data.total} onClick={()=>setPage(page+1)}>Next attempts</button></div></>}
 {repliesOpen&&<RepliesDrawer onClose={()=>setRepliesOpen(false)}/>}
 </section>;
}

function RepliesDrawer({onClose}:{onClose:()=>void}){
 const [shown,setShown]=useState(false),[data,setData]=useState<Activity|null>(null),[page,setPage]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const closeTimer=useRef<ReturnType<typeof setTimeout>>(undefined),seq=useRef(0),panel=useRef<HTMLElement>(null);
 function close(){setShown(false);clearTimeout(closeTimer.current);closeTimer.current=setTimeout(onClose,320)}
 useEffect(()=>{const frame=requestAnimationFrame(()=>requestAnimationFrame(()=>{setShown(true);panel.current?.focus()}));const key=(e:KeyboardEvent)=>{if(e.key==='Escape')close()};window.addEventListener('keydown',key);const overflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{cancelAnimationFrame(frame);clearTimeout(closeTimer.current);window.removeEventListener('keydown',key);document.body.style.overflow=overflow}},[]);
 useEffect(()=>{const id=++seq.current;setLoading(true);apiRequest<Activity>(`/v1/outreach/activity?status=replied&limit=20&offset=${page*20}`).then(r=>{if(id===seq.current){setData(r);setError('')}}).catch(e=>{if(id===seq.current)setError(e instanceof Error?e.message:'Unable to load replied leads.')}).finally(()=>{if(id===seq.current)setLoading(false)})},[page]);
 return <><div className={'reply-shade'+(shown?' open':'')} onClick={close}/><aside ref={panel} tabIndex={-1} className={'reply-drawer'+(shown?' open':'')} role="dialog" aria-modal="true" aria-label="Leads who replied">
  <div className="detail-heading"><div><p className="eyebrow">WHATSAPP REPLIES</p><h2>Who replied</h2></div><button className="icon-button" aria-label="Close replied leads" onClick={close}><X size={21}/></button></div>
  {error&&<p className="notice error" role="alert">{error}</p>}
  {loading&&!data&&<p role="status">Loading replied leads…</p>}
  {data&&<>{!data.items.length&&<p>No leads have replied yet.</p>}<ul className="reply-list">{data.items.map(item=><li key={item.id}><div style={{display:'flex',justifyContent:'space-between',gap:12}}><strong>{item.name}</strong><span style={{fontSize:11,whiteSpace:'nowrap'}}>{new Date(item.last_reply_at||item.attempted_at).toLocaleString('en-NG',{timeZone:'Africa/Lagos'})}</span></div><p style={{fontSize:12,marginTop:4}}>{item.phone}{item.reply_count?` · ${item.reply_count} ${item.reply_count===1?'reply':'replies'}`:''}</p>{item.reply_preview&&<p style={{fontSize:13,marginTop:8,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.reply_preview}</p>}</li>)}</ul>
   <div style={{display:'flex',gap:12,alignItems:'center',marginTop:16,flexWrap:'wrap'}}><span style={{fontSize:12}}>{data.total} replied leads</span><button type="button" className="button button-outline small" disabled={!page} onClick={()=>setPage(page-1)}>Previous</button><button type="button" className="button button-outline small" disabled={(page+1)*20>=data.total} onClick={()=>setPage(page+1)}>Next</button></div></>}
 </aside></>;
}
