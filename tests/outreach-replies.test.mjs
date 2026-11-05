import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('reply rate counts unique contacted recipients and excludes old or unrelated messages',async()=>{
 const db=new PGlite();
 const actor='11111111-1111-4111-8111-111111111111';
 const a='22222222-2222-4222-8222-222222222222',b='33333333-3333-4333-8333-333333333333',c='44444444-4444-4444-8444-444444444444';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;
   create table public.staff_members(user_id uuid);insert into public.staff_members values('${actor}');
   create table public.leads(id uuid,name text,profile_name text);insert into public.leads values('${a}','Stephen',null),('${b}','Second contact',null),('${c}','Uncontacted',null);
   create table public.messages(id text,lead_id uuid,message_at timestamptz,message_text text,message_id text,channel text,direction text,business_phone_id text);
   create table helios.prospects(id text,name text);insert into helios.prospects values('p','Test business');
   create table helios.outreach_jobs(id uuid,prospect_id text);insert into helios.outreach_jobs values('${a}','p');
   create table helios.gateway_test_deliveries(id uuid,execution_id text,job_id uuid,lead_id uuid,recipient text,status text,message_id text,updated_at timestamptz);
   insert into helios.gateway_test_deliveries values
    ('${a}','1','${a}','${a}','2349138314501','accepted','send-a','2026-11-01T10:00Z'),
    ('${b}','2','${a}','${b}','2348100000000','accepted','send-b','2026-11-01T10:00Z'),
    ('${c}','3','${a}','${a}','2349138314501','accepted','send-a-repeat','2026-11-01T10:30Z');
   create table helios.gateway_retry_audit(claim_id uuid,event text,previous_attempt jsonb,created_at timestamptz);
   insert into public.messages values
    ('old','${a}','2026-11-01T09:00Z','Old chat','old','whatsapp','inbound','linked_gateway'),
    ('meta','${b}','2026-11-01T11:00Z','Meta message','meta','whatsapp','inbound','1291493224058562'),
    ('unrelated','${c}','2026-11-01T11:00Z','Unrelated message','unrelated','whatsapp','inbound','linked_gateway');`);
  const sql=readFileSync(new URL('../supabase/migrations/202611010015_outreach_replies.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  async function report(status='all',offset=0,who=actor){return(await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_outreach_activity($1,$2,1,$3) r',[who,status,offset]);})).rows[0].r;}
  let r=await report();assert.equal(r.summary.contacted_leads,2);assert.equal(r.summary.sent,3);assert.equal(r.summary.replied_leads,0);assert.equal(r.summary.reply_rate,0);
  await db.exec(`insert into public.messages values
   ('reply-a','${a}','2026-11-01T11:00Z','Yes, tell me more','reply-a','whatsapp','inbound','linked_gateway'),
   ('reply-a-again','${a}','2026-11-01T11:01Z','Another reply','reply-a-again','whatsapp','inbound','linked_gateway');`);
  r=await report('replied');assert.equal(r.summary.replied_leads,1);assert.equal(r.summary.reply_rate,50);assert.equal(r.total,1);assert.equal(r.items[0].phone,'+2349138314501');assert.equal(r.items[0].reply_count,2);assert.equal(r.items[0].reply_preview,'Another reply');
  assert.equal((await report('all',1)).summary.reply_rate,50);
  await db.exec(`insert into public.messages values('reply-b','${b}','2026-11-01T12:00Z','Interested','reply-b','whatsapp','inbound','linked_gateway');`);
  r=await report('replied');assert.equal(r.summary.replied_leads,2);assert.equal(r.summary.reply_rate,100);assert.equal(r.total,2);assert.equal(r.items.length,1);
  assert.equal((await report('replied',0,'99999999-9999-4999-8999-999999999999')).error,'staff_required');
  await db.exec('delete from helios.gateway_test_deliveries');r=await report();assert.equal(r.summary.reply_rate,null);assert.equal(r.summary.replied_leads,0);
 }finally{await db.close();}
});
