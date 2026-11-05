import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const read=n=>readFileSync(new URL('../supabase/migrations/'+n,import.meta.url),'utf8');
const staff='11111111-1111-4111-8111-111111111111';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const phone=n=>'234800000'+String(1000+n);

async function setup(jobs=3){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;
  create table public.staff_members(user_id uuid);insert into public.staff_members values('${staff}');
  create table public.leads(id uuid primary key default gen_random_uuid(),whatsapp_id text,profile_name text,phone text,source text,notes text,opted_out boolean default false,followup_blocked boolean default false,last_outbound_at timestamptz);
  create table public.messages(lead_id uuid,channel text,direction text,message_id text,message_type text,message_text text,business_phone_id text,message_at timestamptz,unique(channel,message_id));
  create table helios.prospects(id text primary key,name text,phone text,stage text);
  create table helios.outreach_jobs(id uuid primary key,prospect_id text,recipient_snapshot text,status text,message_text text,queue_reason text,updated_at timestamptz,automatic boolean,created_at timestamptz default now());`);
 for(let n=1;n<=jobs;n++){
  await db.exec(`insert into helios.prospects values('p${n}','Business ${n}','0${phone(n).slice(3)}','New prospect');
   insert into helios.outreach_jobs(id,prospect_id,recipient_snapshot,status,message_text,automatic,created_at) values('${id(n)}','p${n}','+${phone(n)}','queued',E'Hello, good afternoon.\\n\\nPitch ${n}',true,now()+interval '${n} seconds');`);
 }
 await db.exec(read('202610310012_gateway_test_delivery.sql'));
 await db.exec(read('202611010013_gateway_confirmed_failure_retry.sql'));
 const sql=read('202611010018_outreach_dispatch.sql');
 await db.exec(sql);await db.exec(sql);
 const call=async(fn,args,role='service_role')=>(await db.transaction(async tx=>{await tx.exec('set local role '+role);return tx.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)+(i?'::jsonb':'')).join(',')}) r`,args);})).rows[0].r;
 const dispatch=(a,p={})=>call('helios_outreach_dispatch',[a,JSON.stringify(p)]);
 const claim=(job,exec='e1')=>call('helios_outreach_live_claim',[JSON.stringify({job_id:job,execution_id:exec})].map(x=>x));
 const open=(extra='')=>db.exec(`update helios.outreach_dispatch_control set enabled=true,live_recipients=true,weekdays_only=false,window_start_hour=0,window_end_hour=24,next_dispatch_at=now()-interval '1 second'${extra}`);
 return {db,dispatch,claim,open};
}

test('nothing dispatches until enabled, and only test numbers until live recipients are allowed',async()=>{
 const {db,dispatch,open}=await setup(2);
 try{
  assert.equal((await dispatch('next')).reason,'disabled');
  await open();
  await db.exec("update helios.outreach_dispatch_control set live_recipients=false");
  assert.equal((await dispatch('next')).reason,'nothing_queued');
  await db.exec("update helios.outreach_dispatch_control set live_recipients=true");
  assert.equal((await dispatch('next')).dispatch,true);
 }finally{await db.close()}
});

test('jobs go out one at a time, oldest first, with a random gap and a daily cap',async()=>{
 const {db,dispatch,open}=await setup(3);
 try{
  await open(",min_gap_seconds=60,max_gap_seconds=120,daily_cap=2");
  const first=await dispatch('next');
  assert.equal(first.job_id,id(1));assert.ok(first.next_gap_seconds>=60&&first.next_gap_seconds<=120);
  assert.equal((await dispatch('next')).reason,'waiting');
  await db.exec("update helios.outreach_dispatch_control set next_dispatch_at=now()-interval '1 second'");
  assert.equal((await dispatch('next')).job_id,id(2));
  await db.exec("update helios.outreach_dispatch_control set next_dispatch_at=now()-interval '1 second'");
  assert.equal((await dispatch('next')).reason,'daily_cap_reached');
  const gaps=new Set();
  for(let i=0;i<20;i++){await db.exec("update helios.outreach_jobs set dispatched_at=null;update helios.outreach_dispatch_control set next_dispatch_at=now()-interval '1 second',daily_cap=5,min_gap_seconds=60,max_gap_seconds=1500");gaps.add((await dispatch('next')).next_gap_seconds)}
  assert.ok(gaps.size>5,'gaps must vary between sends');
 }finally{await db.close()}
});

test('hours window, blocked contacts and release behaviour',async()=>{
 const {db,dispatch,open}=await setup(2);
 try{
  await open();
  const h=(await db.query("select extract(hour from now() at time zone 'Africa/Lagos')::int h")).rows[0].h;
  await db.exec(h>=1?`update helios.outreach_dispatch_control set window_start_hour=0,window_end_hour=${h}`:"update helios.outreach_dispatch_control set window_start_hour=1,window_end_hour=24");
  assert.equal((await dispatch('next')).reason,'outside_hours');
  await db.exec("update helios.outreach_dispatch_control set window_start_hour=0,window_end_hour=24");
  await db.exec(`insert into public.leads(whatsapp_id,phone,opted_out) values('${phone(1)}','+${phone(1)}',true)`);
  const next=await dispatch('next');assert.equal(next.job_id,id(2),'opted-out contact must be skipped');
  const rel=await dispatch('release',{job_id:id(2)});assert.equal(rel.released,true);
  assert.equal((await db.query(`select dispatched_at from helios.outreach_jobs where id='${id(2)}'`)).rows[0].dispatched_at,null);
  assert.equal((await dispatch('next')).reason,'waiting');
  await db.exec("update helios.outreach_jobs set dispatch_attempts=5 where id='"+id(2)+"'");
  await dispatch('release',{job_id:id(2)});
  assert.equal((await db.query(`select status from helios.outreach_jobs where id='${id(2)}'`)).rows[0].status,'needs_review');
 }finally{await db.close()}
});

test('staff control: only staff can read or change pacing, and enabling delays the first send',async()=>{
 const {db,dispatch}=await setup(1);
 try{
  assert.equal((await dispatch('status',{actor:'99999999-9999-4999-8999-999999999999'})).error,'staff_required');
  assert.equal((await dispatch('configure',{actor:'99999999-9999-4999-8999-999999999999',enabled:true})).error,'staff_required');
  const s=await dispatch('configure',{actor:staff,enabled:true});
  assert.equal(s.enabled,true);assert.equal(s.live_recipients,false);assert.equal(s.queued,1);
  assert.ok(s.next_dispatch_at>Date.now()/1000);
  await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role anon');await tx.query("select public.helios_outreach_dispatch('next','{}')");}),/permission denied/);
 }finally{await db.close()}
});

test('live claim: undispatched jobs use the test path; dispatched jobs reserve once and create the lead',async()=>{
 const {db,dispatch,claim,open}=await setup(2);
 try{
  assert.equal((await claim(id(1))).status,'use_test_path');
  await open();
  const sent=await dispatch('next');assert.equal(sent.job_id,id(1));
  await db.exec("update helios.outreach_dispatch_control set live_recipients=false");
  assert.equal((await claim(id(1))).status,'live_recipients_disabled');
  await db.exec("update helios.outreach_dispatch_control set live_recipients=true,enabled=false");
  assert.equal((await claim(id(1))).status,'dispatch_paused');
  await db.exec("update helios.outreach_dispatch_control set enabled=true");
  const c=await claim(id(1));
  assert.equal(c.can_send,true);assert.equal(c.recipient,phone(1));assert.match(c.message_text,/^Hello, good (morning|afternoon|evening)\./);assert.match(c.message_text,/Pitch 1$/);
  const lead=(await db.query(`select profile_name,phone,source from public.leads where whatsapp_id='${phone(1)}'`)).rows;
  assert.equal(lead.length,1);assert.equal(lead[0].profile_name,'Business 1');assert.equal(lead[0].source,'whatsapp');
  assert.equal((await claim(id(1),'e2')).status,'already_reserved');
  assert.equal((await dispatch('release',{job_id:id(1)})).reason,'already_claimed');
  await db.exec("update helios.prospects set stage='Lost' where id='p2'");
  await db.exec("update helios.outreach_jobs set dispatched_at=now() where id='"+id(2)+"'");
  assert.equal((await claim(id(2))).status,'prospect_closed');
 }finally{await db.close()}
});
