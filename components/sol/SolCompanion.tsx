'use client';

import {useEffect, useRef, useState} from 'react';
import {usePathname} from 'next/navigation';
import {ArrowUpRight, ChevronRight, CalendarDays, CheckCircle2, Clock, Loader2, Pause, Play, RotateCcw, Send, ShieldCheck, Sparkles, X} from 'lucide-react';
import {apiOrigin} from '@/lib/api';
import {supabase} from '@/lib/supabase';
import InquiryForm from '@/components/InquiryForm';
import Sol, {type SolMood} from './Sol';

type Booking = {token:string;name:string;email:string;starts_at:string;ends_at:string;display_time:string;duration_minutes:number};
type Message = {id: string; role: 'user' | 'assistant'; content: string};
const publicWelcome: Message = {id: 'welcome', role: 'assistant', content: 'Hi, I’m Sol, Helios’s AI assistant. What would you like to know about solar or battery backup?'};
const publicSuggestions = ['I’m exploring home solar', 'I need battery backup', 'How do consultations work?'];

function messageContent(text:string) {
  return text.split(/(\*\*[^*\n]{1,180}\*\*|\*[^*\n]{1,180}\*)/g).map((part,index)=>
    /^\*\*[^*]+\*\*$/.test(part)?<strong key={index}>{part.slice(2,-2)}</strong>:
    /^\*[^*]+\*$/.test(part)?<strong key={index}>{part.slice(1,-1)}</strong>:part
  );
}

export default function SolCompanion() {
  const pathname=usePathname();
  const internal=pathname.startsWith('/dashboard');
  const [staffUser,setStaffUser]=useState('');
  useEffect(()=>{
    if(!internal||!supabase)return;
    let active=true;
    void supabase.auth.getSession().then(({data})=>{if(active)setStaffUser(data.session?.user.id||'');});
    const {data}=supabase.auth.onAuthStateChange((_event,session)=>{if(active)setStaffUser(session?.user.id||'');});
    return()=>{active=false;data.subscription.unsubscribe();};
  },[internal]);
  if(internal&&!staffUser)return null;
  return <SolChat key={internal?'staff:'+staffUser:'public'} internal={internal}/>;
}

function SolChat({internal}:{internal:boolean}) {
  const welcome:Message=internal
    ?{id:'welcome',role:'assistant',content:'Hi, I’m Sol, your workspace assistant. Ask me about your live lead counts, incoming replies, appointments, or follow-up activity.'}
    :publicWelcome;
  const suggestions=internal?['How many leads do we have?','How many replies have we received?','Give me a dashboard overview']:publicSuggestions;

  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [mood, setMood] = useState<SolMood>('idle');
  const [messages, setMessages] = useState<Message[]>([welcome]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [failedHistory, setFailedHistory] = useState<Message[] | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [inquiry, setInquiry] = useState(false);
  const [booking,setBooking]=useState<Booking|null>(null);
  const [bookingBusy,setBookingBusy]=useState(false);
  const [bookingError,setBookingError]=useState('');
  const [booked,setBooked]=useState(false);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const locked = useRef(false);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {setOpen(false);}, [pathname]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {setOpen(false); launcher.current?.focus();}
    };
    document.addEventListener('keydown', key);
    const controller = new AbortController();
    if (apiOrigin) {
      void (async()=>{
        const token=internal?(await supabase?.auth.getSession())?.data.session?.access_token:undefined;
        if(controller.signal.aborted)return;
        if(internal&&!token){setAvailable(false);return;}
        const response=await fetch(apiOrigin+(internal?'/v1/staff/chat/status':'/v1/chat/status'),{
          signal:controller.signal,cache:'no-store',headers:token?{Authorization:'Bearer '+token}:{},
        });
        if(!response.ok)throw new Error();
        const data=await response.json();
        if(!controller.signal.aborted)setAvailable(data.available===true);
      })().catch(()=>{if(!controller.signal.aborted)setAvailable(false);});
    } else setAvailable(false);
    return () => {document.removeEventListener('keydown', key); controller.abort();};
  }, [open,internal]);
  useEffect(() => {
    if (open && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages, busy, open, error, booking, bookingError]);

  async function generate(history: Message[]) {
    if (locked.current || bookingBusy) return;
    locked.current = true;
    setBooking(null); setBookingError(''); setBooked(false);
    setBusy(true); setMood('thinking'); setError(''); setFailedHistory(null);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      if (!apiOrigin) throw new Error(internal?'The workspace API is not configured.':'Sol is not connected yet. You can still request a consultation below.');
      // Cap history by both message count and character budget.
      const recent: {role: Message['role']; content: string}[] = [];
      let length = 0;
      for (const message of [...history].reverse()) {
        if (message.id === 'welcome') continue;
        if (recent.length >= 20 || length + message.content.length > 15000) break;
        recent.unshift({role: message.role, content: message.content});
        length += message.content.length;
      }
      const token=internal?(await supabase?.auth.getSession())?.data.session?.access_token:undefined;
      if(internal&&!token)throw new Error('Sign in to use your workspace assistant.');
      const response = await fetch(apiOrigin + (internal?'/v1/staff/chat':'/v1/chat'), {
        method: 'POST', headers: {'Content-Type': 'application/json',...(token?{Authorization:'Bearer '+token}:{})},
        body: JSON.stringify({messages: recent}), signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Sol couldn’t answer just now. Please try again.');
      if (typeof data?.reply !== 'string' || !data.reply.trim()) throw new Error('Sol couldn’t finish that reply. Please try again.');
      setMessages([...history, {id: crypto.randomUUID(), role: 'assistant', content: data.reply}]);
      setBooking(internal?null:data.booking || null); setAvailable(true);
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== 'AbortError'
        ? cause.message : 'The connection timed out. Please try again.');
      setFailedHistory(history);
    } finally {
      clearTimeout(timeout); request.current = null; locked.current = false;
      setBusy(false); setMood('idle');
    }
  }

  function send(text = input) {
    const content = text.trim();
    if (!content || locked.current || bookingBusy || failedHistory || content.length > 2000) return;
    const history = [...messages, {id: crypto.randomUUID(), role: 'user' as const, content}];
    setMessages(history); setInput(''); setConfirmReset(false);
    void generate(history);
  }

  function reset() {
    setBooking(null);setBookingError('');setBooked(false);
    setMessages([welcome]); setError(''); setFailedHistory(null); setInput('');
    setConfirmReset(false); composer.current?.focus();
  }

  async function confirmBooking() {
    if (!booking || bookingBusy || locked.current) return;
    locked.current=true; setBookingBusy(true); setBookingError('');
    try {
      const response=await fetch(apiOrigin+'/v1/chat/booking/confirm',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token:booking.token,consent:true}),signal:AbortSignal.timeout(30000),
      });
      const data=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(typeof data?.detail==='string'?data.detail:'The booking could not be verified. Try confirming this same card again.');
      setBooked(true);
      setMessages(current=>[...current,{id:crypto.randomUUID(),role:'assistant',content:data.reply}]);
      window.dispatchEvent(new Event('helios-data'));
    }catch(cause){setBookingError(cause instanceof Error&&cause.name!=='TimeoutError'?cause.message:'The booking result is uncertain. Confirm this same card again to check it safely.');}
    finally{setBookingBusy(false);locked.current=false;}
  }

  if (pathname === '/companion/' || pathname === '/companion') return null;

  return <aside className="sol-widget" aria-label={internal?'Helios workspace assistant':'Helios solar companion'}>
    {open && <section id="sol-chat" className={'sol-guide sol-chat'+(internal?' sol-staff-chat':'')} ref={panel} tabIndex={-1} role="dialog" aria-label={internal?'Sol workspace assistant':'Chat with Sol'}>
      <header className="sol-guide-header sol-chat-header">
        <div><span className={'sol-online-dot' + (available === false ? ' sol-offline-dot' : '')}/><strong>Sol</strong><span>{internal?'Workspace assistant':'Helios AI assistant'}</span></div>
        <div className="sol-chat-header-actions">
          <button className="sol-ui-icon" disabled={busy || bookingBusy || messages.length === 1} aria-label="Start a new conversation" onClick={() => setConfirmReset(!confirmReset)}><RotateCcw size={15}/></button>
          <button className="sol-ui-icon" aria-label="Close chat" onClick={() => {setOpen(false); launcher.current?.focus();}}><X size={18}/></button>
        </div>
      </header>
      <div className="sol-chat-banner">
        <div className="sol-chat-mascot"><Sol mood={busy ? 'thinking' : 'wave'} paused={paused} interactive={false}/></div>
        <div><span className="sol-chat-eyebrow">{internal?'ON YOUR TEAM':'A BRIGHTER CONVERSATION'}</span><strong>{internal?<>Your workspace.<br/>A clearer perspective.</>:<>A little clarity.<br/>A brighter next step.</>}</strong><p>{internal?'Leads, schedules, and next steps.':'Solar, batteries, and your questions.'}</p></div>
        <button className="sol-ui-icon sol-chat-pause" aria-label={paused ? 'Resume mascot animation' : 'Pause mascot animation'} aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? <Play size={12}/> : <Pause size={12}/>}</button>
      </div>
      {confirmReset && <div className="sol-reset-confirm"><span>Clear this conversation?</span><button onClick={reset}>Start fresh</button><button onClick={() => setConfirmReset(false)}>Keep chat</button></div>}
      <div ref={thread} className="sol-chat-thread" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" aria-busy={busy}>
        <div className="sol-chat-date">{internal?'STAFF ONLY · READ-ONLY ASSISTANT':'LET’S START WITH YOUR HOME'}</div>
        {messages.map(message => <div key={message.id} className={'sol-chat-row sol-chat-' + message.role}>
          {message.role === 'assistant' && <span className="sol-chat-avatar" aria-hidden="true"><Sparkles size={12}/></span>}
          <div><span className="sol-chat-speaker">{message.role === 'assistant' ? 'Sol' : 'You'}</span><p className="sol-chat-bubble">{messageContent(message.content)}</p></div>
        </div>)}
        {booking && <section className={'sol-booking-card '+(booked?'sol-booking-done':'')} aria-label="Consultation booking review">
          <div className="sol-booking-card-title">{booked?<CheckCircle2 size={17}/>:<CalendarDays size={17}/>}<strong>{booked?'You’re booked':'Review your consultation'}</strong></div>
          <p className="sol-booking-time">{booking.display_time}</p>
          <span className="sol-booking-duration"><Clock size={12}/>{booking.duration_minutes} minutes · Helios Solar</span>
          <dl><div><dt>Name</dt><dd>{booking.name}</dd></div><div><dt>Email</dt><dd>{booking.email}</dd></div></dl>
          {!booked&&<><p className="sol-booking-consent">Confirming saves these details for your appointment. No marketing enrolment. No email invitation is sent.</p>
          {bookingError&&<p className="sol-booking-error" role="alert">{bookingError}</p>}
          <div className="sol-booking-actions"><button disabled={bookingBusy} onClick={()=>void confirmBooking()}>{bookingBusy?<Loader2 size={14} className="spin"/>:<CheckCircle2 size={14}/>} {bookingBusy?'Booking…':bookingError?'Check / retry confirmation':'Confirm booking'}</button><button disabled={bookingBusy} onClick={()=>{setBooking(null);setBookingError('');composer.current?.focus();}}>Change details</button></div></>}
        </section>}
        {busy && <div className="sol-chat-row sol-chat-assistant"><span className="sol-chat-avatar" aria-hidden="true"><Sparkles size={12}/></span><div className="sol-chat-typing" role="status"><span/><span/><span/><span className="sr-only">Sol is thinking</span></div></div>}
        {error && <div className="sol-chat-error" role="alert"><p>{error}</p><div><button disabled={busy} onClick={() => failedHistory && void generate(failedHistory)}>Try again</button><button disabled={busy} onClick={() => {setMessages(messages.slice(0, -1)); setInput(failedHistory?.at(-1)?.content || ''); setFailedHistory(null); setError(''); composer.current?.focus();}}>Edit message</button></div></div>}
        {messages.length === 1 && !busy && <div className="sol-chat-suggestions">{suggestions.map(question => <button key={question} onClick={() => send(question)}>{question}<ArrowUpRight size={13}/></button>)}</div>}
      </div>
      <div className="sol-chat-bottom">
        {!internal&&<button className="sol-chat-consult" onClick={() => {setOpen(false); setInquiry(true);}}>Prefer to request a consultation?<ArrowUpRight size={13}/></button>}
        <form className="sol-chat-composer" onSubmit={event => {event.preventDefault(); send();}}>
          <label className="sr-only" htmlFor="sol-message">Your message to Sol</label>
          <textarea ref={composer} id="sol-message" rows={1} maxLength={2000} value={input} disabled={busy || bookingBusy || !!failedHistory} placeholder={internal?'Ask about your workspace…':'Ask me about solar…'} onChange={event => setInput(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault(); send();}}}/>
          <button type="submit" aria-label="Send message" disabled={busy || bookingBusy || !!failedHistory || !input.trim()}>{busy ? <Loader2 size={17} className="spin"/> : <Send size={17}/>}</button>
        </form>
        <div className="sol-chat-footnote"><ShieldCheck size={11}/><span>{internal?'Staff only · fresh workspace data for each reply':'AI can make mistakes. Please verify key details.'}</span></div>
        {available === false && <p className="sol-chat-unavailable">{internal?'Workspace chat is unavailable. Your dashboard is still available.':'Chat is currently unavailable. You can still request a consultation.'}</p>}
      </div>
    </section>}
    <button ref={launcher} className={'sol-launcher ' + (open ? 'is-open' : '')} aria-controls="sol-chat" aria-label={open ? 'Close Sol chat' : internal?'Chat with Sol, your workspace assistant':'Chat with Sol, your solar assistant'} aria-expanded={open} onClick={() => {setOpen(!open); setMood('idle');}} onPointerEnter={() => {if (!open) setMood('wave');}} onPointerLeave={() => {if (!open) setMood('idle');}}>
      <span className="sol-launcher-art" aria-hidden="true"><Sol mood={busy ? 'thinking' : mood} paused={paused} interactive={false}/></span>
      <span className="sol-launcher-text"><strong>{internal?'Sol, on your team.':'Hey, I’m Sol.'}</strong><span>{internal?'Your workspace assistant':'Let’s talk solar'} <Sparkles size={10}/></span></span>
      <span className="sol-launcher-chevron">{open ? <X size={15}/> : <ChevronRight size={17}/>}</span>
    </button>
    {!internal && inquiry && <InquiryForm onClose={() => setInquiry(false)}/>}
  </aside>;
}
