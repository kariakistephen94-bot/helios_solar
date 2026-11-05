'use client';
import {useEffect,useState} from 'react';
import {apiRequest} from '@/lib/api';

type Pacing={enabled:boolean;live_recipients:boolean;state:'disabled'|'outside_hours'|'daily_cap_reached'|'waiting'|'ready';daily_cap:number;dispatched_today:number;queued:number;min_gap_seconds:number;max_gap_seconds:number;window_start_hour:number;window_end_hour:number;weekdays_only:boolean;next_dispatch_at:number;timezone:string};
const labels={disabled:'Auto-send is off',outside_hours:'Outside sending hours',daily_cap_reached:'Daily limit reached',waiting:'Waiting for the next slot',ready:'Next message is due'};
const hour=(h:number)=>`${String(h%24).padStart(2,'0')}:00`;

export default function OutreachDispatch(){
 const [data,setData]=useState<Pacing|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function refresh(){try{setData(await apiRequest<Pacing>('/v1/outreach/dispatch'));setError('')}catch(e){setError(e instanceof Error?e.message:'Unable to load outreach pacing.')}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),15000);return()=>clearInterval(timer)},[]);
 async function change(body:{enabled?:boolean;live_recipients?:boolean}){
  if(body.live_recipients&&!window.confirm('Send to real prospect numbers from the linked WhatsApp number? Unsolicited messages can get a number restricted. Messages go out one at a time, within the daily limit.'))return;
  setBusy(true);try{setData(await apiRequest<Pacing>('/v1/outreach/dispatch','PATCH',body));setError('')}catch(e){setError(e instanceof Error?e.message:'Unable to update pacing.')}finally{setBusy(false)}
 }
 const next=data&&data.next_dispatch_at>Date.now()/1000?new Date(data.next_dispatch_at*1000).toLocaleTimeString('en-NG',{timeZone:'Africa/Lagos',hour:'numeric',minute:'2-digit'}):null;
 return <section aria-label="Outreach pacing" style={{margin:'24px 0',padding:22,border:'1px solid #dce5dc',borderRadius:16,background:'#fff'}}>
  <div style={{display:'flex',justifyContent:'space-between',gap:16,flexWrap:'wrap',alignItems:'flex-start'}}>
   <div><small style={{fontWeight:700,color:'#52724b'}}>PACED SENDING</small><h3 style={{marginTop:6}}>Outreach pacing</h3></div>
   {data&&<span role="status" style={{borderRadius:20,padding:'6px 14px',fontSize:12,fontWeight:600,background:data.enabled?'#e4efdf':'#f2f3ed',color:data.enabled?'#326241':'#5c6b55'}}>{labels[data.state]}</span>}
  </div>
  {error&&<p className="notice error" role="alert" style={{marginTop:16}}>{error}</p>}
  {data&&<>
   <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:12,marginTop:18}}>
    <div style={{padding:16,borderRadius:12,background:'#edf5e8'}}><p style={{fontSize:12}}>Sent today</p><strong style={{display:'block',fontSize:26,marginTop:6}}>{data.dispatched_today}/{data.daily_cap}</strong></div>
    <div style={{padding:16,borderRadius:12,background:'#f2f3ed'}}><p style={{fontSize:12}}>Waiting in queue</p><strong style={{display:'block',fontSize:26,marginTop:6}}>{data.queued}</strong></div>
    <div style={{padding:16,borderRadius:12,background:'#f2f3ed'}}><p style={{fontSize:12}}>Next slot</p><strong style={{display:'block',fontSize:26,marginTop:6}}>{data.enabled&&next?next:'—'}</strong></div>
    <div style={{padding:16,borderRadius:12,background:'#f2f3ed'}}><p style={{fontSize:12}}>Gap between sends</p><strong style={{display:'block',fontSize:26,marginTop:6}}>{Math.round(data.min_gap_seconds/60)}–{Math.round(data.max_gap_seconds/60)} min</strong></div>
   </div>
   <p style={{fontSize:12,marginTop:12,color:'#76817b'}}>{data.weekdays_only?'Mon to Fri, ':''}{hour(data.window_start_hour)} to {hour(data.window_end_hour)} WAT · up to {data.daily_cap} a day</p>
   <div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:16}}>
    <button type="button" className={data.enabled?'button button-outline small':'button button-dark small'} disabled={busy} onClick={()=>void change({enabled:!data.enabled})}>{data.enabled?'Pause auto-send':'Turn on auto-send'}</button>
    <button type="button" className="button button-outline small" disabled={busy||!data.enabled} onClick={()=>void change({live_recipients:!data.live_recipients})}>{data.live_recipients?'Stop sending to real prospects':'Allow real prospects'}</button>
   </div>
   <p style={{fontSize:12,marginTop:10,color:'#76817b'}}>{data.live_recipients?'Real prospects allowed':'Test numbers only'}</p>
   {data.enabled&&data.state==='outside_hours'&&<p role="status" style={{fontSize:12,marginTop:6,color:'#76817b'}}>It is outside sending hours ({hour(data.window_start_hour)} to {hour(data.window_end_hour)} WAT). Real prospects wait until the next window; your test numbers are still sent.</p>}
  </>}
 </section>;
}
