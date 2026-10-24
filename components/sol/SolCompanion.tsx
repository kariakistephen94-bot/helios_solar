'use client';

import {useEffect,useRef,useState} from 'react';
import {usePathname} from 'next/navigation';
import {ArrowUpRight,ChevronRight,Maximize2,Pause,Play,Sparkles,X} from 'lucide-react';
import Sol,{type SolMood} from './Sol';

const questions=[
 {label:'Could my home go solar?',answer:'Let’s start with your roof, shade and electricity use. A property assessment is the next step before recommending equipment or a system size.'},
 {label:'What about backup power?',answer:'Solar alone usually switches off during a grid outage. A battery with the right backup controls can support selected circuits. Start by deciding which essentials you want to keep running.'},
 {label:'How much would it cost?',answer:'That depends on your roof, electrical work, system size and storage. Helios’s next step is a consultation and site assessment, followed by an itemized proposal. I won’t guess a price for your home.'}
];

export default function SolCompanion(){
 const pathname=usePathname();const [open,setOpen]=useState(false),[paused,setPaused]=useState(false),[mood,setMood]=useState<SolMood>('idle'),[reply,setReply]=useState('A little sunshine, right when you need it. What would you like to explore?'),[busy,setBusy]=useState(false);const timer=useRef<ReturnType<typeof setTimeout>|null>(null);const panel=useRef<HTMLElement>(null);const launcher=useRef<HTMLButtonElement>(null);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current)},[]);
 useEffect(()=>{if(!open)return;const previous=document.activeElement as HTMLElement|null;panel.current?.focus();const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false)};document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus()}},[open]);
 useEffect(()=>{setOpen(false)},[pathname]);
 if(pathname==='/companion/'||pathname==='/companion')return null;
 function toggle(){setOpen(!open);if(!open){if(timer.current)clearTimeout(timer.current);if(busy){setReply('A little sunshine, right when you need it. What would you like to explore?');setBusy(false)}setMood('wave');timer.current=setTimeout(()=>setMood('idle'),2400)}}
 function answer(index:number){if(timer.current)clearTimeout(timer.current);setBusy(true);setMood('thinking');setReply('A little bright thinking…');timer.current=setTimeout(()=>{setReply(questions[index].answer);setBusy(false);setMood('idle')},1000)}
 return <aside className="sol-widget" aria-label="Helios solar companion">
  {open&&<section className="sol-guide" ref={panel} tabIndex={-1} aria-label="Sol solar guide"><header className="sol-guide-header"><div><span className="sol-online-dot"/><strong>Sol</strong><span>Your solar sidekick</span></div><button className="sol-ui-icon" aria-label="Close solar guide" onClick={()=>setOpen(false)}><X size={17}/></button></header><div className="sol-guide-stage"><div className="sol-guide-orbit"/><Sol mood={mood} paused={paused}/><span className="sol-guide-stage-label">A LITTLE SUNSHINE. ALWAYS ON YOUR SIDE.</span><button className="sol-ui-icon sol-pause" aria-label={paused?'Resume mascot animation':'Pause mascot animation'} aria-pressed={paused} onClick={()=>setPaused(!paused)}>{paused?<Play size={13}/>:<Pause size={13}/>}</button></div><div className="sol-guide-body"><p className="sol-guide-intro"><Sparkles size={12}/> BRIGHT IDEAS START HERE</p><p className={'sol-reply '+(busy?'sol-reply-thinking':'')} aria-live="polite">{reply}</p><div className="sol-question-list">{questions.map((q,i)=><button key={q.label} onClick={()=>answer(i)} disabled={busy}>{q.label}<ChevronRight size={14}/></button>)}</div><a className="sol-guide-cta" href={pathname.startsWith('/dashboard')?'/':'/#solutions'} onClick={()=>setOpen(false)}>Explore Helios solutions <ArrowUpRight size={14}/></a><footer><span>Demo guide · curated answers</span><a href="/companion/">Meet Sol <Maximize2 size={11}/></a></footer></div></section>}
  <button ref={launcher} className={'sol-launcher '+(open?'is-open':'')} aria-label={open?'Close Sol solar companion':'Meet Sol, your solar companion'} aria-expanded={open} onClick={toggle} onPointerEnter={()=>{if(!open)setMood('wave')}} onPointerLeave={()=>{if(!open)setMood('idle')}}><span className="sol-launcher-art" aria-hidden="true"><Sol mood={open?'idle':mood} paused={paused} interactive={false}/></span><span className="sol-launcher-text"><strong>Hey, I’m Sol.</strong><span>Your solar sidekick <Sparkles size={10}/></span></span><span className="sol-launcher-chevron">{open?<X size={15}/>:<ChevronRight size={17}/>}</span></button>
 </aside>
}
