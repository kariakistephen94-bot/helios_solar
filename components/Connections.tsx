'use client';
import {useEffect,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {apiRequest} from '@/lib/api';
type Status={backend:boolean;supabase:boolean;website_chat_configured:boolean;collector_configured:boolean;timezone:string};
export default function Connections(){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 async function refresh(){setLoading(true);try{setStatus(await apiRequest<Status>('/v1/connections'));setError('');}catch(e){setError(e instanceof Error?e.message:'Connection check failed.');}finally{setLoading(false);}}
 useEffect(()=>{void refresh();},[]);
 return <section className="panel settings-panel"><div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><h2>Workspace connections</h2><button className="icon-button" disabled={loading} aria-label="Refresh connection status" onClick={()=>void refresh()}><RefreshCw size={15} className={loading?'spin':''}/></button></div>{error&&<p className="error" role="alert">{error}</p>}{[['Backend API',status?.backend],['Supabase storage',status?.supabase],['Website Sol · OpenAI key',status?.website_chat_configured],['Google Places key',status?.collector_configured]].map(([label,value])=><div className="connection-row" key={String(label)}><span>{label}</span><small>{loading?'Checking…':value===true?'Configured':value===false?'Not configured':'Unavailable'}</small></div>)}<div className="connection-row"><span>Calendar timezone</span><small>{status?.timezone||'Not checked'}</small></div></section>;
}
