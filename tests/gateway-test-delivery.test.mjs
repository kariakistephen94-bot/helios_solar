import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('gateway claims return actual text and store gateway IDs without touching Meta attempts',async()=>{
 const db=new PGlite();
 const lead='11111111-1111-4111-8111-111111111111',job='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;
   create table public.leads(id uuid primary key,whatsapp_id text,phone text,opted_out boolean,followup_blocked boolean,last_outbound_at timestamptz);
   create table public.messages(lead_id uuid,channel text,direction text,message_id text,message_type text,message_text text,business_phone_id text,message_at timestamptz,unique(channel,message_id));
   create table helios.prospects(id text primary key,phone text,stage text);
   create table helios.outreach_jobs(id uuid primary key,prospect_id text,recipient_snapshot text,status text,message_text text,queue_reason text,updated_at timestamptz);
   insert into public.leads values('${lead}','2348107920394','+2348107920394',false,false,null);
   insert into helios.prospects values('p1','+2348107920394','New prospect'),('p2','+2348000000000','New prospect');
   insert into helios.outreach_jobs values('${job}','p1','+2348107920394','queued',E'Hello, good afternoon.\\n\\nTest message',null,null),('${other}','p2','+2348000000000','queued','Test message',null,null);`);
  const sql=readFileSync(new URL('../supabase/migrations/202610310012_gateway_test_delivery.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  async function action(name,payload){return(await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_gateway_test_delivery($1,$2::jsonb) r',[name,JSON.stringify(payload)]);})).rows[0].r;}
  const input={job_id:job,execution_id:'execution-1'};
  assert.equal((await action('claim',{...input,job_id:other})).status,'not_a_test_number');
  await db.exec('update public.leads set followup_blocked=true');
  assert.equal((await action('claim',input)).status,'contact_blocked');
  await db.exec('update public.leads set followup_blocked=false');
  await db.exec(`create table helios.outreach_test_deliveries(job_id uuid,status text);insert into helios.outreach_test_deliveries values('${job}','unknown')`);
  const claimed=await action('claim',input);
  assert.equal(claimed.can_send,true);assert.equal(claimed.recipient,'2348107920394');assert.equal(claimed.provider,'linked_gateway');assert.match(claimed.message_text,/^Hello, good (morning|afternoon|evening)\./);assert.match(claimed.message_text,/Test message$/);
  assert.equal((await action('claim',input)).status,'already_reserved');
  assert.equal((await action('claim',{...input,execution_id:'other'})).can_send,false);
  const result={claim_id:claimed.claim_id,execution_id:'execution-1',outcome:'accepted',message_id:'3EB02873051C70DCB99781'};
  assert.equal((await action('result',{...result,execution_id:'other'})).status,'execution_mismatch');
  assert.equal((await action('result',{...result,message_id:''})).status,'missing_message_id');
  assert.equal((await action('result',result)).status,'accepted');
  assert.equal((await db.query("select status from helios.outreach_test_deliveries")).rows[0].status,'unknown');
  assert.equal((await action('result',result)).success,true);
  assert.equal((await db.query("select count(*)::int n from public.messages where direction='outbound' and message_type='text' and message_id='3EB02873051C70DCB99781'")).rows[0].n,1);
  assert.equal((await action('result',{...result,outcome:'failed'})).success,false);
  await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role anon');await tx.query("select public.helios_gateway_test_delivery('claim','{}')");}),/permission denied/);
 }finally{await db.close();}
});
