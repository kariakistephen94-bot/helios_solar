import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const read=n=>readFileSync(new URL('../supabase/migrations/'+n,import.meta.url),'utf8');
const job=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;
  create table public.staff_members(user_id uuid);
  create table public.leads(id uuid primary key default gen_random_uuid(),whatsapp_id text,profile_name text,name text,phone text,source text,interest text,notes text,stage text,
   opted_out boolean default false,followup_blocked boolean default false,followup_opt_in boolean default false,followup_status text,followup_reason text,last_outbound_at timestamptz);
  create table public.messages(lead_id uuid,channel text,direction text,message_id text,message_type text,message_text text,business_phone_id text,message_at timestamptz,unique(channel,message_id));
  create table helios.prospects(id text primary key,place_id text unique not null,fingerprint text unique,name text not null,address text,phone text not null,website text,
   latitude double precision not null,longitude double precision not null,category text,stage text not null,notes text,consent boolean,business_status text,created_at bigint,last_seen_at bigint,version int);
  create table helios.outreach_jobs(id uuid primary key,prospect_id text,recipient_snapshot text,status text,message_text text,queue_reason text,updated_at timestamptz,automatic boolean,created_at timestamptz default now());`);
 await db.exec(read('202610310012_gateway_test_delivery.sql'));
 await db.exec(read('202611010013_gateway_confirmed_failure_retry.sql'));
 await db.exec(read('202611010018_outreach_dispatch.sql'));
 const call=async(fn,args)=>(await db.transaction(async tx=>{await tx.exec('set local role service_role');
  return tx.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)+(i?'::jsonb':'')).join(',')}) r`,args);})).rows[0].r;
 return {db,call};
}

test('second demo phone becomes a sendable test contact, rerunnably and without widening live sending',async()=>{
 const {db,call}=await setup();
 try{
  const sql=read('202611020019_demo_test_numbers.sql');
  await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query("select count(*)::int n from helios.prospects where place_id='manual:stephen:2349121402541'")).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from public.leads where whatsapp_id='2349121402541'")).rows[0].n,1);
  const prospect=(await db.query("select id,phone,category,stage,consent from helios.prospects where place_id='manual:stephen:2349121402541'")).rows[0];
  assert.deepEqual([prospect.phone,prospect.category,prospect.stage,prospect.consent],['+2349121402541','test_contact','New prospect',false]);
  await db.exec(`insert into helios.prospects(id,place_id,name,phone,stage,latitude,longitude) values('other','g1','Other Co','+2348000009999','New prospect',9,7);
   insert into helios.outreach_jobs(id,prospect_id,recipient_snapshot,status,message_text,automatic,created_at) values
    ('${job(1)}','other','+2348000009999','queued',E'Hello, good afternoon.\\n\\nOther','t',now()),
    ('${job(2)}','${prospect.id}','+2349121402541','queued',E'Hello, good afternoon.\\n\\nDemo','t',now()+interval '1 second');
   update helios.outreach_dispatch_control set enabled=true,live_recipients=false,weekdays_only=false,window_start_hour=0,window_end_hour=24,next_dispatch_at=now()-interval '1 second'`);
  // With live recipients off, only the allowlisted demo phone is dispatched, never the business.
  const next=await call('helios_outreach_dispatch',['next','{}']);
  assert.equal(next.dispatch,true);assert.equal(next.job_id,job(2));
  const claim=await call('helios_outreach_live_claim',[JSON.stringify({job_id:job(2),execution_id:'e1'})]);
  assert.equal(claim.can_send,true);assert.equal(claim.recipient,'2349121402541');
  const blocked=await call('helios_gateway_test_delivery',['claim',JSON.stringify({job_id:job(1),execution_id:'e2'})]);
  assert.equal(blocked.can_send,false);assert.equal(blocked.status,'not_a_test_number');
  // An opt-out or follow-up block on the new lead still stops the send.
  await db.exec("update public.leads set followup_blocked=true where whatsapp_id='2349121402541'");
  await db.exec(`update helios.gateway_test_deliveries set status='failed',retry_authorized=true`);
  const stopped=await call('helios_gateway_test_delivery',['claim',JSON.stringify({job_id:job(2),execution_id:'e3'})]);
  assert.equal(stopped.status,'contact_blocked');
 }finally{await db.close()}
});

test('reset gives the test numbers a fresh start without touching anyone else or any lead state',async()=>{
 const {db,call}=await setup();
 try{
  await db.exec(read('202611020019_demo_test_numbers.sql'));
  const prospect=(await db.query("select id from helios.prospects where place_id='manual:stephen:2349121402541'")).rows[0];
  await db.exec(`insert into public.leads(whatsapp_id,phone,followup_blocked) values('2349138314501','+2349138314501',false),('2348000009999','+2348000009999',false);
   insert into helios.prospects(id,place_id,name,phone,stage,latitude,longitude) values('o','g1','Other','+2348000009999','New prospect',9,7);
   insert into helios.outreach_jobs(id,prospect_id,recipient_snapshot,status,message_text,automatic) values
    ('${job(1)}','${prospect.id}','+2349121402541','queued','Hello, good afternoon.','t'),
    ('${job(2)}','o','+2348000009999','queued','Hello, good afternoon.','t');`);
  const claim=async j=>call('helios_gateway_test_delivery',['claim',JSON.stringify({job_id:j,execution_id:'e'+j.slice(-1)})]);
  const first=await claim(job(1));assert.equal(first.can_send,true);
  await call('helios_gateway_test_delivery',['result',JSON.stringify({claim_id:first.claim_id,execution_id:'e1',outcome:'accepted',message_id:'3EB0A'})]);
  assert.equal((await claim(job(1))).status,'already_reserved');
  // A delivery for a non-test recipient must survive the reset.
  await db.exec(`insert into helios.gateway_test_deliveries(job_id,recipient,execution_id,lead_id,message_text)
   select '${job(2)}','2348000009999','x',id,'keep' from public.leads where whatsapp_id='2348000009999'`);
  await db.exec("update helios.outreach_jobs set dispatched_at=now(),dispatch_attempts=2,queue_reason='Gateway accepted the test message.' where id='"+job(1)+"'");
  await db.exec("update public.leads set followup_blocked=true where whatsapp_id='2349138314501'");
  const sql=readFileSync(new URL('../supabase/maintenance/reset_demo_test_numbers.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query("select count(*)::int n from helios.test_reset_archive where source_table='gateway_test_deliveries'")).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from helios.gateway_test_deliveries where recipient='2349121402541'")).rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from helios.gateway_test_deliveries where recipient='2348000009999'")).rows[0].n,1);
  const j=(await db.query("select dispatched_at,dispatch_attempts,status from helios.outreach_jobs where id='"+job(1)+"'")).rows[0];
  assert.deepEqual([j.dispatched_at,j.dispatch_attempts,j.status],[null,0,'queued']);
  // Opt-out and follow-up flags are never reset.
  assert.equal((await db.query("select followup_blocked from public.leads where whatsapp_id='2349138314501'")).rows[0].followup_blocked,true);
  // The number can be claimed for a first send again.
  assert.equal((await claim(job(1))).can_send,true);
 }finally{await db.close()}
});

test('test numbers are spaced 60 seconds apart; every other recipient keeps the configured gap',async()=>{
 const {db,call}=await setup();
 try{
  await db.exec(read('202611020019_demo_test_numbers.sql'));
  const sql=read('202611030020_test_number_gap.sql');
  await db.exec(sql);await db.exec(sql);
  const prospect=(await db.query("select id from helios.prospects where place_id='manual:stephen:2349121402541'")).rows[0];
  await db.exec(`insert into helios.prospects(id,place_id,name,phone,stage,latitude,longitude) values('o','g1','Other','+2348000009999','New prospect',9,7);
   insert into helios.outreach_jobs(id,prospect_id,recipient_snapshot,status,message_text,automatic,created_at) values
    ('${job(1)}','${prospect.id}','+2349121402541','queued','Hello','t',now()),
    ('${job(2)}','o','+2348000009999','queued','Hello','t',now()+interval '1 second');
   update helios.outreach_dispatch_control set enabled=true,live_recipients=true,weekdays_only=false,window_start_hour=0,window_end_hour=24,min_gap_seconds=600,max_gap_seconds=1500,daily_cap=10,next_dispatch_at=now()-interval '1 second'`);
  const test=await call('helios_outreach_dispatch',['next','{}']);
  assert.equal(test.job_id,job(1));assert.equal(test.next_gap_seconds,60);
  await db.exec("update helios.outreach_dispatch_control set next_dispatch_at=now()-interval '1 second'");
  const other=await call('helios_outreach_dispatch',['next','{}']);
  assert.equal(other.job_id,job(2));assert.ok(other.next_gap_seconds>=600&&other.next_gap_seconds<=1500);
 }finally{await db.close()}
});

test('test numbers send outside the sending window; real recipients still wait for it',async()=>{
 const {db,call}=await setup();
 try{
  await db.exec(read('202611020019_demo_test_numbers.sql'));
  await db.exec(read('202611030020_test_number_gap.sql'));
  const sql=read('202611030021_test_numbers_ignore_hours.sql');
  await db.exec(sql);await db.exec(sql);
  const prospect=(await db.query("select id from helios.prospects where place_id='manual:stephen:2349121402541'")).rows[0];
  await db.exec(`insert into helios.prospects(id,place_id,name,phone,stage,latitude,longitude) values('o','g1','Other','+2348000009999','New prospect',9,7);
   insert into helios.outreach_jobs(id,prospect_id,recipient_snapshot,status,message_text,automatic,created_at) values
    ('${job(1)}','o','+2348000009999','queued','Hello','t',now()),
    ('${job(2)}','${prospect.id}','+2349121402541','queued','Hello','t',now()+interval '1 second');
   update helios.outreach_dispatch_control set enabled=true,live_recipients=true,weekdays_only=false,daily_cap=10,next_dispatch_at=now()-interval '1 second',
    window_start_hour=case when extract(hour from now() at time zone 'Africa/Lagos')<12 then 20 else 1 end,
    window_end_hour=case when extract(hour from now() at time zone 'Africa/Lagos')<12 then 22 else 3 end`);
  const first=await call('helios_outreach_dispatch',['next','{}']);
  assert.equal(first.dispatch,true);assert.equal(first.job_id,job(2));
  await db.exec("update helios.outreach_dispatch_control set next_dispatch_at=now()-interval '1 second'");
  const second=await call('helios_outreach_dispatch',['next','{}']);
  assert.equal(second.dispatch,false);assert.equal(second.reason,'outside_hours');
  // The released test job also passes the live claim outside the window.
  await db.exec(`update helios.outreach_jobs set dispatched_at=now() where id='${job(2)}'`);
  const claim=await call('helios_outreach_live_claim',[JSON.stringify({job_id:job(2),execution_id:'e1'})]);
  assert.equal(claim.can_send,true);
  await db.exec(`update helios.outreach_jobs set dispatched_at=now() where id='${job(1)}'`);
  const real=await call('helios_outreach_live_claim',[JSON.stringify({job_id:job(1),execution_id:'e2'})]);
  assert.equal(real.status,'outside_hours');
  const staff='11111111-1111-4111-8111-111111111111';
  await db.exec(`insert into public.staff_members values('${staff}')`);
  const st=await call('helios_outreach_dispatch',['status',JSON.stringify({actor:staff})]);
  assert.equal(st.state,'outside_hours');assert.equal(st.test_numbers_ignore_hours,true);
 }finally{await db.close()}
});

test('turning on auto-send starts test numbers at once with a 30 second gap; live recipients keep the delay',async()=>{
 const {db,call}=await setup();
 try{
  await db.exec(read('202611020019_demo_test_numbers.sql'));
  await db.exec(read('202611030020_test_number_gap.sql'));
  await db.exec(read('202611030021_test_numbers_ignore_hours.sql'));
  const sql=read('202611030022_test_numbers_send_now.sql');
  await db.exec(sql);await db.exec(sql);
  const staff='11111111-1111-4111-8111-111111111111';
  await db.exec(`insert into public.staff_members values('${staff}')`);
  const prospect=(await db.query("select id from helios.prospects where place_id='manual:stephen:2349121402541'")).rows[0];
  await db.exec(`insert into helios.outreach_jobs(id,prospect_id,recipient_snapshot,status,message_text,automatic) values('${job(1)}','${prospect.id}','+2349121402541','queued','Hello','t');
   update helios.outreach_dispatch_control set weekdays_only=false,window_start_hour=0,window_end_hour=24`);
  const on=await call('helios_outreach_dispatch',['configure',JSON.stringify({actor:staff,enabled:true})]);
  assert.ok(on.next_dispatch_at<=Date.now()/1000+1);
  const sent=await call('helios_outreach_dispatch',['next','{}']);
  assert.equal(sent.dispatch,true);assert.equal(sent.next_gap_seconds,30);
  await call('helios_outreach_dispatch',['configure',JSON.stringify({actor:staff,enabled:false})]);
  const live=await call('helios_outreach_dispatch',['configure',JSON.stringify({actor:staff,enabled:true,live_recipients:true})]);
  assert.ok(live.next_dispatch_at>Date.now()/1000+30);
 }finally{await db.close()}
});

test('reset also zeroes the failed count and the sent-today counter',async()=>{
 const {db,call}=await setup();
 try{
  await db.exec(read('202611020019_demo_test_numbers.sql'));
  const prospect=(await db.query("select id from helios.prospects where place_id='manual:stephen:2349121402541'")).rows[0];
  await db.exec(`insert into helios.outreach_jobs(id,prospect_id,recipient_snapshot,status,message_text,automatic,dispatched_at,dispatch_attempts) values('${job(1)}','${prospect.id}','+2349121402541','queued','Hello','t',now(),1);
   insert into helios.gateway_retry_audit(claim_id,event,previous_attempt) values(gen_random_uuid(),'x','{"recipient":"2349121402541","status":"failed"}'),(gen_random_uuid(),'x','{"recipient":"2348000009999","status":"failed"}')`);
  const sql=readFileSync(new URL('../supabase/maintenance/reset_demo_test_numbers.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query("select count(*)::int n from helios.gateway_retry_audit")).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from helios.gateway_retry_audit where previous_attempt->>'recipient'='2348000009999'")).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from helios.test_reset_archive where source_table='gateway_retry_audit'")).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from helios.outreach_jobs where dispatched_at is not null")).rows[0].n,0);
 }finally{await db.close()}
});

test('conversation reset archives chats, clears follow-up state, and never touches opt-outs or other leads',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema helios;
   create table public.leads(id uuid primary key default gen_random_uuid(),whatsapp_id text,name text,stage text,notes text,opted_out boolean default false,followup_blocked boolean default false,
    followup_opt_in boolean default false,followup_status text,followup_reason text,followup_due_at timestamptz,followup_count int default 0,followup_last_sent_at timestamptz,
    followup_anchor_message_id text,last_inbound_at timestamptz,last_outbound_at timestamptz);
   create table public.messages(lead_id uuid,direction text,message_text text);
   insert into public.leads(id,whatsapp_id,name,stage,notes,followup_status,followup_due_at,followup_count,followup_anchor_message_id,last_inbound_at,last_outbound_at,followup_opt_in,opted_out) values
    ('00000000-0000-4000-8000-000000000001','2349121402541','Stephen','Interested','old','scheduled',now(),2,'wamid.x',now(),now(),true,false),
    ('00000000-0000-4000-8000-000000000002','2349138314501','Stephen','Interested','old','scheduled',now(),1,'wamid.y',now(),now(),true,true),
    ('00000000-0000-4000-8000-000000000003','2348000009999','Other','Interested','keep','scheduled',now(),1,'wamid.z',now(),now(),true,false);
   insert into public.messages values('00000000-0000-4000-8000-000000000001','inbound','a'),('00000000-0000-4000-8000-000000000001','outbound','b'),
    ('00000000-0000-4000-8000-000000000002','inbound','c'),('00000000-0000-4000-8000-000000000003','inbound','keep');`);
  const sql=readFileSync(new URL('../supabase/maintenance/reset_demo_test_conversations.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  assert.deepEqual((await db.query("select lead_id::text,message_text from public.messages")).rows,[{lead_id:'00000000-0000-4000-8000-000000000003',message_text:'keep'}]);
  assert.equal((await db.query("select count(*)::int n from helios.test_reset_archive where source_table='messages'")).rows[0].n,3);
  assert.equal((await db.query("select count(*)::int n from helios.test_reset_archive where source_table='leads'")).rows[0].n,2);
  const r=(await db.query("select whatsapp_id,stage,followup_status,followup_due_at,followup_count,followup_anchor_message_id,last_inbound_at,opted_out,notes from public.leads order by whatsapp_id")).rows;
  assert.deepEqual([r[1].followup_status,r[1].followup_due_at,r[1].followup_count,r[1].followup_anchor_message_id,r[1].last_inbound_at,r[1].stage],['cancelled',null,0,null,null,'New inquiry']);
  assert.equal(r[2].opted_out,true);
  assert.equal(r[0].followup_status,'scheduled');assert.equal(r[0].notes,'keep');
 }finally{await db.close()}
});
