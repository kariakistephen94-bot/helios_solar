'use client';
import {useEffect, useRef, useState} from 'react';
import {apiRequest} from '@/lib/api';

type Job = {id:string; prospect_name:string; business_name:string; message_text:string; status:'draft'|'reviewed'|'cancelled'|'queued'|'blocked'|'needs_review';queue_reason?:string;automatic?:boolean; version:number; created_at:string};
export default function OutreachQueue({refreshKey}:{refreshKey:number}) {
  const [items,setItems]=useState<Job[]>([]), [total,setTotal]=useState(0), [page,setPage]=useState(0);
  const [loading,setLoading]=useState(true), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const sequence=useRef(0);
  async function refresh() {
    const id=++sequence.current;
    setLoading(true);
    try {
      const result=await apiRequest<{items:Job[];total:number}>(`/v1/outreach/jobs?limit=10&offset=${page*10}`);
      if(id===sequence.current){setItems(result.items);setTotal(result.total);setError('');}
    } catch(e){if(id===sequence.current)setError(e instanceof Error?e.message:'Unable to load outreach drafts.');}
    finally{if(id===sequence.current)setLoading(false);}
  }
  useEffect(()=>{void refresh(); const timer=setInterval(()=>void refresh(),15000); return()=>{clearInterval(timer);sequence.current++;};},[refreshKey,page]);
  async function update(job:Job, action:'review'|'cancel') {
    setBusy(true);setError('');
    try {await apiRequest(`/v1/outreach/jobs/${job.id}/${action}`,'POST',{version:job.version});await refresh();}
    catch(e){setError(e instanceof Error?e.message:'Unable to update this draft.');}
    finally{setBusy(false);}
  }
  return <section aria-label="Outreach draft queue" style={{margin:'24px 0',padding:20,border:'1px solid #dce5dc',borderRadius:16,background:'#f7f9f6'}}>
    <div style={{display:'flex',gap:12,justifyContent:'space-between',flexWrap:'wrap',alignItems:'center'}}>
      <div><h3>Outreach queue</h3></div>
      <button type="button" className="button button-outline small" disabled={loading||busy} onClick={()=>void refresh()}>Refresh queue</button>
    </div>
    {error&&<p className="notice error" role="alert" style={{marginTop:16}}>{error}</p>}
    {loading&&<p role="status" style={{marginTop:16}}>Loading queued messages…</p>}
    {!loading&&!error&&!items.length&&<p style={{marginTop:16}}>No queued messages yet.</p>}
    {items.map(job=><article key={job.id} style={{marginTop:16,padding:16,background:'white',border:'1px solid #e0e7dc',borderRadius:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'start',gap:12,flexWrap:'wrap'}}>
        <div><strong>{job.prospect_name}</strong><p style={{fontSize:12,marginTop:4}}>Saved {new Date(job.created_at).toLocaleString('en-NG',{timeZone:'Africa/Lagos'})} WAT</p></div>
        <span style={{borderRadius:20,padding:'4px 12px',fontSize:12,fontWeight:600,background:job.status==='reviewed'?'#e1edcc':job.status==='cancelled'?'#eee':'#fff1d1'}}>{job.status==='reviewed'?'Reviewed':job.status==='cancelled'?'Cancelled':job.status==='queued'?'Queued':job.status==='blocked'?'Blocked':job.status==='needs_review'?'Name needs attention':'Legacy draft'}</span>
      </div>
      {job.queue_reason&&<p style={{fontSize:12,marginTop:10}}>{job.queue_reason}</p>}<details style={{marginTop:12}}><summary style={{cursor:'pointer'}}>Read saved message</summary><p style={{whiteSpace:'pre-wrap',lineHeight:1.7,marginTop:12,overflowWrap:'anywhere'}}>{job.message_text}</p></details>
      {job.status!=='cancelled'&&<div style={{display:'flex',gap:10,marginTop:16,flexWrap:'wrap'}}>
        {false&&job.status==='draft'&&<button type="button" className="button button-dark small" disabled={busy||loading} onClick={()=>void update(job,'review')}>Mark reviewed</button>}
        <button type="button" className="button button-outline small" disabled={busy||loading} onClick={()=>void update(job,'cancel')}>Stop outreach</button>
      </div>}
    </article>)}
    <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap',marginTop:16}}><span>{total} queued records</span>
      <button type="button" className="button button-outline small" disabled={!page||busy||loading} onClick={()=>setPage(page-1)}>Previous messages</button>
      <button type="button" className="button button-outline small" disabled={(page+1)*10>=total||busy||loading} onClick={()=>setPage(page+1)}>Next messages</button>
    </div>
  </section>;
}
