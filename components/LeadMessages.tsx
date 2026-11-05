'use client';
import {useEffect,useState} from 'react';
import {Loader2,MessageSquare} from 'lucide-react';
import {apiRequest} from '@/lib/api';
type Message={id:string;direction:string;message_text:string;message_type:string;message_at:string;channel:string};
export default function LeadMessages({leadId}:{leadId:string}){
 const [messages,setMessages]=useState<Message[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;async function load(){try{const result=await apiRequest<{messages:Message[]}>('/v1/leads/'+leadId+'/messages');if(active){setMessages(result.messages);setError('');}}catch(e){if(active)setError(e instanceof Error?e.message:'Could not load conversation.');}finally{if(active)setLoading(false);}}void load();const timer=setInterval(()=>void load(),30000);return()=>{active=false;clearInterval(timer);};},[leadId]);
 return <section className="detail-section"><h3><MessageSquare size={15}/>Conversation history</h3>{loading?<p><Loader2 className="spin" size={13}/> Loading messages…</p>:error?<p className="error" role="alert">{error}</p>:!messages.length?<p>No saved messages for this customer.</p>:<div className="lead-message-history">{messages.map(m=><article className={'lead-history-message '+(m.direction==='outbound'?'outbound':'')} key={m.id}><small>{m.direction==='inbound'?'Customer':'Helios'} · {m.channel} · {new Date(m.message_at).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} CT</small><p>{m.message_text||'['+m.message_type+' message]'}</p></article>)}</div>}</section>;
}
