import type {Lead} from './types';
const base = {phone: '(512) 555-0140', address: '', consent: true, notes: '', survey_at: null, ai_summary: null, followup_draft: null, source: 'Website'};
export const demoLeads: Lead[] = [
 {...base,id:'demo-1',name:'Olivia Bennett',email:'olivia@example.com',city:'Austin, TX',bill:285,interest:'Solar + battery',stage:'Proposal sent',value:32400,created_at:'2026-10-23T14:30:00Z',ai_summary:'Homeowner interested in whole-home resilience. Average monthly bill: $285. Requests solar with battery storage. Confirm roof age, available roof area and utility usage before preparing a final design.',followup_draft:'Hi Olivia, thanks for exploring solar with Helios. We would love to learn more about your roof and backup priorities. Would a short discovery call this week work for you?'},
 {...base,id:'demo-2',name:'James Mitchell',email:'james@example.com',city:'Round Rock, TX',bill:210,interest:'Home solar',stage:'Survey scheduled',value:24800,survey_at:'2026-10-28T10:00:00-05:00',created_at:'2026-10-22T16:00:00Z'},
 {...base,id:'demo-3',name:'Sophia Chen',email:'sophia@example.com',city:'Cedar Park, TX',bill:340,interest:'Solar + battery',stage:'Qualified',value:38600,created_at:'2026-10-24T13:15:00Z'},
 {...base,id:'demo-4',name:'Noah Williams',email:'noah@example.com',city:'Austin, TX',bill:180,interest:'Home solar',stage:'New inquiry',value:0,created_at:'2026-10-24T15:45:00Z'},
 {...base,id:'demo-5',name:'Isabella Davis',email:'isabella@example.com',city:'Georgetown, TX',bill:260,interest:'Battery storage',stage:'Won',value:18200,created_at:'2026-10-18T10:00:00Z'},
 {...base,id:'demo-6',name:'Ethan Parker',email:'ethan@example.com',city:'Dripping Springs, TX',bill:310,interest:'Solar + battery',stage:'Survey scheduled',value:35400,survey_at:'2026-10-29T14:00:00-05:00',created_at:'2026-10-21T10:00:00Z'},
 {...base,id:'demo-7',name:'Amelia Rivera',email:'amelia@example.com',city:'Austin, TX',bill:225,interest:'Home solar',stage:'New inquiry',value:0,created_at:'2026-10-24T16:30:00Z'},
 {...base,id:'demo-8',name:'Lucas Foster',email:'lucas@example.com',city:'Buda, TX',bill:195,interest:'Home solar',stage:'Qualified',value:22600,created_at:'2026-10-20T11:00:00Z'}
];
const KEY='helios-demo-leads-v1';
export function readDemo(): Lead[] {try {const raw=localStorage.getItem(KEY);return raw?JSON.parse(raw):demoLeads;}catch{return demoLeads;}}
export function writeDemo(leads: Lead[]) {localStorage.setItem(KEY,JSON.stringify(leads));window.dispatchEvent(new Event('helios-data'));}
export function addDemo(input: Partial<Lead>) {const lead:Lead={...base,id:crypto.randomUUID(),name:'',email:'',city:'',bill:0,interest:'Home solar',stage:'New inquiry',value:0,created_at:new Date().toISOString(),...input};writeDemo([lead,...readDemo()]);return lead;}
export function money(value:number){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(value)}
