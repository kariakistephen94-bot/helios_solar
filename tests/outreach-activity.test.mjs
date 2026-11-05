import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('outreach counts are exact across pages and retry audit events are deduplicated',async()=>{
 const db=new PGlite();const actor='11111111-1111-4111-8111-111111111111';
 const claim='22222222-2222-4222-8222-222222222222';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;
   create table public.staff_members(user_id uuid);insert into public.staff_members values('${actor}');
   create table helios.prospects(id text,name text);insert into helios.prospects values('p','Stephen');
   create table helios.outreach_jobs(id uuid,prospect_id text);insert into helios.outreach_jobs values('${claim}','p');
   create table helios.gateway_test_deliveries(id uuid,execution_id text,job_id uuid,recipient text,status text,message_id text,updated_at timestamptz);
   insert into helios.gateway_test_deliveries values
    ('${claim}','166','${claim}','2349138314501','accepted','3EB0success',now()),
    ('33333333-3333-4333-8333-333333333333','167','${claim}','2348000000001','failed',null,now()),
    ('44444444-4444-4444-8444-444444444444','168','${claim}','2348000000002','unknown',null,now()),
    ('55555555-5555-4555-8555-555555555555','169','${claim}','2348000000003','reserved',null,now());
   create table helios.gateway_retry_audit(claim_id uuid,event text,previous_attempt jsonb,created_at timestamptz);`);
  const before={execution_id:'100',job_id:claim,recipient:'2349138314501',status:'reserved',message_id:null};
  await db.query('insert into helios.gateway_retry_audit values($1,$2,$3,now()-interval \'1 hour\')',[claim,'confirmed_401_retry_authorized',JSON.stringify(before)]);
  await db.query('insert into helios.gateway_retry_audit values($1,$2,$3,now())',[claim,'authorized_retry_claimed',JSON.stringify({...before,status:'failed'})]);
  const sql=readFileSync(new URL('../supabase/migrations/202611010014_outreach_activity.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  async function report(status='all',offset=0,who=actor){return(await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_outreach_activity($1,$2,1,$3) r',[who,status,offset]);})).rows[0].r;}
  const r=await report();assert.deepEqual(r.summary,{sent:1,failed:2,completed:3,uncertain:1,pending:1,attempts:5});
  assert.equal(r.items.length,1);assert.equal(r.total,5);
  assert.deepEqual((await report('all',1)).summary,r.summary);
  const failed=await report('failed');assert.equal(failed.total,2);assert.equal(failed.items[0].status,'failed');assert.match(failed.items[0].phone,/^\+234/);
  assert.equal((await report('all',0,'99999999-9999-4999-8999-999999999999')).error,'staff_required');
  await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role authenticated');await tx.query('select public.helios_outreach_activity($1)',[actor]);}),/permission denied/);
 }finally{await db.close();}
});
