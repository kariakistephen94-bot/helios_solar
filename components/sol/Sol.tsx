'use client';

import {useId,useState,type CSSProperties} from 'react';

export type SolMood = 'idle' | 'wave' | 'thinking' | 'charging' | 'celebrate' | 'sleep';
export const solMoods: {id:SolMood;label:string;description:string}[] = [
 {id:'idle',label:'Just vibing',description:'A little sunshine, keeping you company.'},
 {id:'wave',label:'Say hello',description:'Hey, you. Ready for a brighter day?'},
 {id:'thinking',label:'Thinking',description:'Connecting the dots. Finding the bright side.'},
 {id:'charging',label:'Sun recharge',description:'A moment in the sunshine goes a long way.'},
 {id:'celebrate',label:'Good news',description:'Small wins deserve a little happy dance.'},
 {id:'sleep',label:'Power nap',description:'Even a little sun needs some downtime.'}
];

/** Resolution-independent solar companion. All artwork and motion are native SVG/CSS. */
export default function Sol({mood='idle',paused=false,className='',interactive=true}: {mood?:SolMood;paused?:boolean;className?:string;interactive?:boolean}) {
 const id=useId().replaceAll(':','');
 const [look,setLook]=useState({x:0,y:0});
 const fill=(name:string)=>`url(#${id}-${name})`;
 const style={'--sol-look-x':`${look.x}px`,'--sol-look-y':`${look.y}px`,'--sol-tilt':`${look.x*.65}deg`} as CSSProperties;
 return <div className={`sol-character sol-${mood} ${paused?'sol-paused':''} ${className}`} style={style} onPointerMove={e=>{if(!interactive||paused||mood==='sleep')return;const r=e.currentTarget.getBoundingClientRect();setLook({x:Math.max(-5,Math.min(5,(e.clientX-r.left-r.width/2)/r.width*14)),y:Math.max(-3,Math.min(3,(e.clientY-r.top-r.height/2)/r.height*10))})}} onPointerLeave={()=>setLook({x:0,y:0})}>
 <svg viewBox="0 0 320 340" fill="none" role="img" aria-label={`Sol, the Helios solar companion, ${solMoods.find(s=>s.id===mood)?.label.toLowerCase()}`}>
  <defs>
   <radialGradient id={`${id}-shell`} cx=".32" cy=".22" r=".85"><stop stopColor="#fff2b3"/><stop offset=".26" stopColor="#ffdc76"/><stop offset=".67" stopColor="#ecac3e"/><stop offset="1" stopColor="#b96725"/></radialGradient>
   <linearGradient id={`${id}-fin`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#ffe49a"/><stop offset=".5" stopColor="#edb049"/><stop offset="1" stopColor="#b9752d"/></linearGradient>
   <linearGradient id={`${id}-glass`} x1=".15" y1="0" x2=".9" y2="1"><stop stopColor="#2d5146"/><stop offset=".5" stopColor="#17362e"/><stop offset="1" stopColor="#102820"/></linearGradient>
   <linearGradient id={`${id}-panel`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#52725d"/><stop offset="1" stopColor="#1c4032"/></linearGradient>
   <linearGradient id={`${id}-belly`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fff2c3"/><stop offset="1" stopColor="#db9b3a"/></linearGradient>
   <radialGradient id={`${id}-core`}><stop stopColor="#ffffe3"/><stop offset=".5" stopColor="#f7f5a7"/><stop offset="1" stopColor="#c6e67c"/></radialGradient>
   <radialGradient id={`${id}-aura`}><stop stopColor="#e8e987" stopOpacity=".3"/><stop offset="1" stopColor="#cfe67e" stopOpacity="0"/></radialGradient>
   <radialGradient id={`${id}-shadow`}><stop stopColor="#061b14" stopOpacity=".45"/><stop offset="1" stopColor="#061b14" stopOpacity="0"/></radialGradient>
   <filter id={`${id}-glow`} x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3"/></filter>
   <filter id={`${id}-soft`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
  </defs>
  <ellipse className="sol-ground-shadow" cx="160" cy="295" rx="66" ry="12" fill={fill('shadow')}/>
  <circle className="sol-aura" cx="160" cy="163" r="130" fill={fill('aura')}/>
  <g className="sol-particles" stroke="#deed9b" strokeWidth="1.5" strokeLinecap="round"><path className="sol-particle p1" d="M49 118v10m-5-5h10"/><path className="sol-particle p2" d="M267 77v12m-6-6h12"/><path className="sol-particle p3" d="M267 214v8m-4-4h8"/><circle className="sol-particle p4" cx="64" cy="226" r="2"/><circle className="sol-particle p5" cx="243" cy="145" r="2"/></g>
  <g className="sol-thoughts"><circle cx="235" cy="104" r="4" fill="#d5ed95"/><circle cx="251" cy="89" r="6" fill="#d5ed95"/><circle cx="271" cy="68" r="9" fill="#d5ed95"/><path d="M271 63v10m-5-5h10" stroke="#436843" strokeWidth="1.5"/></g>
  <g className="sol-sleep-marks" fill="#dcebb0" fontFamily="Manrope, sans-serif" fontWeight="600"><text x="224" y="114" fontSize="13">z</text><text x="242" y="94" fontSize="18">z</text><text x="263" y="69" fontSize="25">z</text></g>
  <g className="sol-float"><g className="sol-body">
   <g className="sol-rays" fill={fill('fin')} stroke="#ffe5a1" strokeWidth=".6">
    {[0,45,90,135,180,225,270,315].map((angle,i)=><g key={angle} transform={`rotate(${angle} 160 151)`}><path className={`sol-fin fin-${i}`} d="M151 77c-1-10 4-25 9-28 5 3 10 18 9 28l-9 13-9-13Z"/><path d="m160 58 0 19" stroke="#fff2bc" strokeOpacity=".6"/></g>)}
   </g>
   <g className="sol-ear ear-left"><path d="M112 96C90 97 80 79 82 60c22 1 38 12 39 29l-9 7Z" fill={fill('fin')} stroke="#ffe7a4"/><path d="M109 87c-13-1-19-10-20-19 15 3 23 9 25 18l-5 1Z" fill={fill('panel')}/><path d="m92 72 16 11m-9-14-3 8m12-4-4 9" stroke="#a5ba8b" strokeOpacity=".45" strokeWidth=".7"/></g>
   <g className="sol-ear ear-right"><path d="M208 96c22 1 32-17 30-36-22 1-38 12-39 29l9 7Z" fill={fill('fin')} stroke="#ffe7a4"/><path d="M211 87c13-1 19-10 20-19-15 3-23 9-25 18l5 1Z" fill={fill('panel')}/><path d="m228 72-16 11m9-14 3 8m-12-4 4 9" stroke="#a5ba8b" strokeOpacity=".45" strokeWidth=".7"/></g>
   <g className="sol-antenna"><path d="M160 91V61" stroke="#d4a34c" strokeWidth="4"/><path d="M160 69c-16-4-19-16-13-24 10 2 15 11 13 24Z" fill="#d7eb9e"/><path d="M160 66c0-17 10-28 22-26 0 15-9 26-22 26Z" fill="#9dbd6b"/><path d="m160 63 15-16" stroke="#d6e8aa" strokeWidth="1"/></g>
   <g className="sol-arm arm-left"><path d="M100 170c-19-7-30 0-35 15" stroke="#c18c38" strokeWidth="10" strokeLinecap="round"/><ellipse cx="65" cy="189" rx="14" ry="17" transform="rotate(22 65 189)" fill={fill('shell')} stroke="#ffe1a0" strokeWidth=".8"/><path d="m58 188 3 8" stroke="#fff1bd" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round"/></g>
   <g className="sol-arm arm-right"><path d="M220 170c19-7 30 0 35 15" stroke="#c18c38" strokeWidth="10" strokeLinecap="round"/><ellipse cx="255" cy="189" rx="14" ry="17" transform="rotate(-22 255 189)" fill={fill('shell')} stroke="#ffe1a0" strokeWidth=".8"/><path d="m261 188-3 8" stroke="#fff1bd" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round"/></g>
   <g className="sol-feet"><g className="sol-foot foot-left"><path d="m133 215-3 25" stroke="#c99541" strokeWidth="11" strokeLinecap="round"/><path d="M118 241c0-8 7-13 14-11 9 2 14 11 11 17-9 5-24 2-25-6Z" fill={fill('shell')} stroke="#ffe4a1" strokeWidth=".7"/></g><g className="sol-foot foot-right"><path d="m187 215 3 25" stroke="#c99541" strokeWidth="11" strokeLinecap="round"/><path d="M202 241c0-8-7-13-14-11-9 2-14 11-11 17 9 5 24 2 25-6Z" fill={fill('shell')} stroke="#ffe4a1" strokeWidth=".7"/></g></g>
   <path d="M104 172c1 42 19 61 56 61s55-19 56-61H104Z" fill={fill('belly')} stroke="#f4cb76" strokeWidth="1"/>
   <path d="M126 213c8 7 20 10 34 10s26-3 34-10" stroke="#f8e1a0" strokeWidth="1.5" strokeLinecap="round"/>
   <ellipse cx="160" cy="145" rx="67" ry="63" fill={fill('shell')} stroke="#ffe7a2" strokeWidth="1.2"/>
   <path d="M111 112c9-15 25-23 43-23" stroke="#fff9d3" strokeOpacity=".75" strokeWidth="3.5" strokeLinecap="round"/>
   <path d="M105 144c0-23 16-35 55-35s55 12 55 35-16 42-55 42-55-19-55-42Z" fill="#bd8635"/>
   <path d="M107 141c0-22 16-33 53-33s53 11 53 33-16 39-53 39-53-17-53-39Z" fill={fill('glass')} stroke="#f6cb74" strokeWidth="1"/>
   <path d="M116 125c13-10 35-13 53-11" stroke="#9ab19b" strokeOpacity=".23" strokeWidth="2" strokeLinecap="round"/>
   <g className="sol-face">
    <g className="sol-eyes"><g className="sol-open-eyes"><rect x="128" y="128" width="13" height="21" rx="6.5" fill="#d9ef9b"/><rect x="179" y="128" width="13" height="21" rx="6.5" fill="#d9ef9b"/><rect x="128" y="128" width="13" height="21" rx="6.5" fill="#d9ef9b" opacity=".45" filter={fill('glow')}/><rect x="179" y="128" width="13" height="21" rx="6.5" fill="#d9ef9b" opacity=".45" filter={fill('glow')}/><circle cx="132" cy="132" r="2" fill="#fcffe8"/><circle cx="183" cy="132" r="2" fill="#fcffe8"/></g><g className="sol-happy-eyes" stroke="#def4a4" strokeWidth="4.5" strokeLinecap="round"><path d="M127 141q8-15 16 0"/><path d="M177 141q8-15 16 0"/></g><g className="sol-closed-eyes" stroke="#c4dc96" strokeWidth="3" strokeLinecap="round"><path d="M127 140q8 6 16 0"/><path d="M177 140q8 6 16 0"/></g></g>
    <ellipse cx="121" cy="154" rx="7" ry="3" fill="#e8b45f" opacity=".28"/><ellipse cx="199" cy="154" rx="7" ry="3" fill="#e8b45f" opacity=".28"/>
    <path className="sol-smile" d="M151 157q9 9 18 0" stroke="#d4e9a0" strokeWidth="2.5" strokeLinecap="round"/>
    <ellipse className="sol-o-mouth" cx="160" cy="160" rx="4" ry="5" stroke="#d4e9a0" strokeWidth="2"/>
   </g>
   <g className="sol-heart"><circle cx="160" cy="207" r="14" fill="#d19e43"/><circle cx="160" cy="207" r="11" fill="#426446" stroke="#f9e8a9" strokeWidth="1"/><circle className="sol-core-glow" cx="160" cy="207" r="8" fill="#e4f6a1" filter={fill('glow')}/><path d="m162 199-7 9h5l-2 7 8-10h-6l2-6Z" fill={fill('core')}/></g>
  </g></g>
  <g className="sol-orbit"><ellipse cx="160" cy="185" rx="106" ry="31" transform="rotate(-17 160 185)" stroke="#d5ea9a" strokeOpacity=".2" strokeDasharray="2 6"/><circle className="sol-orbit-dot" cx="62" cy="214" r="4" fill="#e5f3b7"/><circle cx="62" cy="214" r="8" fill="#e5f3b7" opacity=".2" filter={fill('glow')}/></g>
 </svg></div>
}
