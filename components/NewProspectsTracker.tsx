'use client';

export type TrackerState={
 enabled:boolean;
 configured:boolean;
 new_today:number;
 daily_target:number;
 target_timezone:string;
 active_district:string|null;
 searches_remaining:number;
 requests_used:number;
 daily_request_limit:number;
 paused_until:number;
 next_scan_at?:number;
 worker_until?:number;
};
export type TrackerScan={status:string;new_count:number;outcome?:string|null;error?:string|null};

const STALE_AFTER_SECONDS=15*60;

export function trackerStatus(c:TrackerState,now:number){
 if(!c.configured)return {label:'Google API key required',tone:'warn'} as const;
 if(!c.enabled)return {label:'Collection paused',tone:'warn'} as const;
 if(c.new_today>=c.daily_target)return {label:'Daily target reached',tone:'done'} as const;
 if((c.worker_until??0)>now)return {label:'Scanning now',tone:'live'} as const;
 if(c.paused_until>now)return {label:'Cooling down after a provider limit',tone:'warn'} as const;
 if(c.searches_remaining<=0)return {label:'No district searches left today',tone:'warn'} as const;
 const due=c.next_scan_at??0;
 if(due>0&&now-due>STALE_AFTER_SECONDS)return {label:'Scan overdue, the collector worker may be offline',tone:'warn'} as const;
 return {label:'Waiting for the next scan',tone:'idle'} as const;
}

const tones={
 live:{background:'#e0ecff',color:'#365eae'},
 done:{background:'#e4efdf',color:'#326241'},
 idle:{background:'#f2f3ed',color:'#5c6b55'},
 warn:{background:'#fff0ce',color:'#87631c'},
};

export default function NewProspectsTracker({collector,lastScan,now=Date.now()/1000}:{collector:TrackerState;lastScan?:TrackerScan;now?:number}){
 const target=Math.max(1,collector.daily_target);
 const count=Math.max(0,collector.new_today);
 const percent=Math.min(100,Math.round(count/target*100));
 const status=trackerStatus(collector,now);
 const remaining=Math.max(0,collector.daily_target-count);
 const next=collector.next_scan_at&&collector.next_scan_at>now?new Date(collector.next_scan_at*1000).toLocaleString('en-NG',{timeZone:collector.target_timezone,hour:'numeric',minute:'2-digit',day:'numeric',month:'short'}):null;
 return <section aria-label="New prospects today" style={{margin:'0 0 20px',padding:22,border:'1px solid #dce5dc',borderRadius:16,background:'#f7faf4'}}>
  <div style={{display:'flex',justifyContent:'space-between',gap:16,flexWrap:'wrap',alignItems:'flex-start'}}>
   <div>
    <small style={{fontWeight:700,color:'#52724b'}}>NEW PROSPECTS TODAY</small>
    <p style={{marginTop:8,display:'flex',alignItems:'baseline',gap:8}}><strong style={{fontSize:40,lineHeight:1}}>{count}</strong><span style={{fontSize:16}}>of {collector.daily_target} qualifying businesses</span></p>
   </div>
   <span role="status" style={{...tones[status.tone],borderRadius:20,padding:'6px 14px',fontSize:12,fontWeight:600}}>{status.label}</span>
  </div>
  <div role="progressbar" aria-label="Progress toward the daily prospect target" aria-valuemin={0} aria-valuemax={collector.daily_target} aria-valuenow={Math.min(count,collector.daily_target)} style={{height:10,borderRadius:6,background:'#e1e8d8',marginTop:16,overflow:'hidden'}}>
   <div style={{width:percent+'%',height:'100%',background:count>=collector.daily_target?'#4d854f':'#86a961',transition:'width .4s'}}/>
  </div>
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:12,marginTop:16,fontSize:12}}>
   <div><span style={{color:'#76817b'}}>Still needed today</span><strong style={{display:'block',fontSize:18,marginTop:4}}>{remaining}</strong></div>
   <div><span style={{color:'#76817b'}}>Current district</span><strong style={{display:'block',fontSize:18,marginTop:4}}>{collector.active_district||'Rotating'}</strong></div>
   <div><span style={{color:'#76817b'}}>Searches left today</span><strong style={{display:'block',fontSize:18,marginTop:4}}>{collector.searches_remaining}</strong></div>
   <div><span style={{color:'#76817b'}}>Google requests used</span><strong style={{display:'block',fontSize:18,marginTop:4}}>{collector.requests_used}/{collector.daily_request_limit}</strong></div>
   {next&&<div><span style={{color:'#76817b'}}>Next scan</span><strong style={{display:'block',fontSize:18,marginTop:4}}>{next}</strong></div>}
  </div>
  {lastScan&&<p style={{fontSize:12,marginTop:14,color:'#76817b'}}>Last scan: {lastScan.status}, {lastScan.new_count} new{lastScan.error?' ('+lastScan.error.replaceAll('_',' ')+')':lastScan.outcome?' ('+lastScan.outcome.replaceAll('_',' ')+')':''}</p>}
 </section>;
}
