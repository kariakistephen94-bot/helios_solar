import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('gateway receipts survive duplicates, early arrival and reordered status events',async()=>{
 const db=new PGlite();const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;
   create table public.staff_members(user_id uuid);insert into public.staff_members values('${actor}');
   create table public.leads(id uuid,name text,profile_name text);insert into public.leads values('${id}','Stephen',null);
   create table public.messages(id text,lead_id uuid,message_at timestamptz,message_text text,message_id text,channel text,direction text,business_phone_id text);
   create table helios.prospects(id text,name text);insert into helios.prospects values('p','Stephen');
   create table helios.outreach_jobs(id uuid,prospect_id text);insert into helios.outreach_jobs values('${id}','p');
   create table helios.gateway_test_deliveries(id uuid,execution_id text,job_id uuid,lead_id uuid,recipient text,status text,message_id text,updated_at timestamptz);
   create table helios.gateway_retry_audit(claim_id uuid,event text,previous_attempt jsonb,created_at timestamptz);`);
  const sql=readFileSync(new URL('../supabase/migrations/202611010016_gateway_receipts.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  const base={event:'message_status',provider:'linked_gateway',sender:'2348107920394',recipient:'2349138314501',message_id:'3EB0TEST0001',occurred_at:new Date().toISOString(),timestamp_source:'provider'};
  async function receipt(status,extra={}){const body={...base,status,event_id:base.message_id+status,...extra};return(await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_gateway_receipt($1::jsonb) r',[JSON.stringify(body)]);})).rows[0].r;}
  const state=async msg=>(await db.query('select * from helios.gateway_message_receipts where message_id=$1',[msg||base.message_id])).rows[0];
  assert.equal((await receipt('read')).accepted,true);
  assert.equal((await receipt('read')).duplicate,true);
  assert.equal((await state()).best_rank,3);assert.equal((await state()).delivered_at,null);
  assert.equal((await receipt('read',{recipient:'2349000000000'})).error,'event_conflict');
  await receipt('delivered');await receipt('sent',{timestamp_source:'observed'});await receipt('failed');
  assert.equal((await state()).best_rank,3);assert.equal((await state()).failed,false);
  // Receipt already exists when n8n later records acceptance; reporting joins it without a replay.
  await db.exec(`insert into helios.gateway_test_deliveries values('${id}','1','${id}','${id}','2349138314501','accepted','3EB0TEST0001',now())`);
  const report=async()=>(await db.query('select public.helios_outreach_activity($1) r',[actor])).rows[0].r;
  const r=await report();assert.equal(r.summary.delivered,1);assert.equal(r.summary.read,1);assert.equal(r.items[0].status,'read');
  assert.equal((await db.query('select count(*)::int n from public.messages')).rows[0].n,0);
  const alt={message_id:'3EB0UNKNOWN',event_id:'alt-failed'};
  await receipt('failed',alt);assert.equal((await state(alt.message_id)).failed,true);
  await receipt('sent',{...alt,event_id:'alt-sent',timestamp_source:'observed'});assert.equal((await state(alt.message_id)).failed,true);
  await receipt('delivered',{...alt,event_id:'alt-delivered'});assert.equal((await state(alt.message_id)).failed,false);
  assert.equal((await report()).summary.delivered,1); // Unknown IDs are stored but not attributed to another contact.
  await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role anon');await tx.query("select public.helios_gateway_receipt('{}')");}),/permission denied/);
 }finally{await db.close();}
});
