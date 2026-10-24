import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('database permissions, intake and queue lifecycle',async t=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role;
 grant execute on function auth.uid() to anon,authenticated,service_role;`);
 // PGlite includes core gen_random_uuid; it does not need Supabase's pgcrypto extension.
 const migration=readFileSync(new URL('../supabase/migrations/202610240001_helios.sql',import.meta.url),'utf8').replace('create extension if not exists pgcrypto;','');
 await db.exec(migration);
 const staff='11111111-1111-4111-8111-111111111111';const outsider='22222222-2222-4222-8222-222222222222';
 await db.query('insert into auth.users(id) values($1),($2)',[staff,outsider]);
 await db.query('insert into public.staff_members(user_id,display_name) values($1,$2)',[staff,'Demo Staff']);
 async function as(role,uid,sql,params=[]){return db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[uid||'']);return tx.query(sql,params)})}
 const payload={name:'Test Customer',email:'test@example.com',phone:'512-555-0123',city:'Austin',address:'100 Example Lane',bill:225,interest:'Home solar',notes:'Test enquiry',consent:true};
 const id='33333333-3333-4333-8333-333333333333';
 let leadId;
 await t.test('atomic intake creates one lead and job despite repeated UUID',async()=>{const first=await as('service_role',null,'select enqueue_lead($1,$2,$3) as id',[id,'hash-test',payload]);leadId=first.rows[0].id;const repeated=await as('service_role',null,'select enqueue_lead($1,$2,$3) as id',[id,'hash-test',payload]);assert.equal(repeated.rows[0].id,leadId);assert.equal((await db.query('select count(*)::int as n from automation_jobs')).rows[0].n,1)});
 await t.test('anonymous users cannot read or directly insert leads',async()=>{await assert.rejects(as('anon',null,'select * from leads'),/permission denied/);await assert.rejects(as('anon',null,"insert into staff_members(user_id,display_name) values($1,'Intruder')",[outsider]),/permission denied/)});
 await t.test('authenticated outsiders cannot see leads or call service RPCs',async()=>{assert.equal((await as('authenticated',outsider,'select * from leads')).rows.length,0);await assert.rejects(as('authenticated',outsider,'select claim_qualification_job()'),/permission denied/)});
 await t.test('staff can read and edit allowed fields, but not AI fields or membership',async()=>{assert.equal((await as('authenticated',staff,'select * from leads')).rows.length,1);await as('authenticated',staff,"update leads set stage='Qualified',value=24000 where id=$1",[leadId]);await assert.rejects(as('authenticated',staff,"update leads set ai_summary='forged' where id=$1",[leadId]),/permission denied/);await assert.rejects(as('authenticated',staff,"insert into staff_members(user_id,display_name) values($1,'Escalated')",[outsider]),/permission denied/);await assert.rejects(as('authenticated',staff,'select lease_token from automation_jobs'),/permission denied/)});
 let job;
 await t.test('claim creates a lease and cannot claim the same active job',async()=>{job=(await as('service_role',null,'select claim_qualification_job() as job')).rows[0].job;assert.ok(job.lease_token);assert.equal(job.lead.name,payload.name);assert.equal(job.lead.email,undefined);assert.equal((await as('service_role',null,'select claim_qualification_job() as job')).rows[0].job,null)});
 await t.test('invalid lease cannot finish and valid result updates only AI fields',async()=>{assert.equal((await as('service_role',null,'select finish_qualification_job($1,$2,$3) as ok',[job.job_id,outsider,{summary:'Valid summary',followup_draft:'Valid draft'}])).rows[0].ok,false);assert.equal((await as('service_role',null,'select finish_qualification_job($1,$2,$3) as ok',[job.job_id,job.lease_token,{summary:'Valid summary',followup_draft:'Valid draft'}])).rows[0].ok,true);const record=(await db.query('select * from leads where id=$1',[leadId])).rows[0];assert.equal(record.ai_summary,'Valid summary');assert.equal(record.stage,'Qualified');assert.equal(record.value,'24000');assert.equal((await db.query('select status from automation_jobs where id=$1',[job.job_id])).rows[0].status,'completed')});
 await t.test('rate limiting blocks a sixth unique intake in the same bucket',async()=>{for(let i=0;i<5;i++)await as('service_role',null,'select enqueue_lead($1,$2,$3)',[crypto.randomUUID(),'rate-test',payload]);await assert.rejects(as('service_role',null,'select enqueue_lead($1,$2,$3)',[crypto.randomUUID(),'rate-test',payload]),/rate_limit/)});
 await t.test('expired lease is reissued and stale worker cannot complete it',async()=>{const first=(await as('service_role',null,'select claim_qualification_job() as job')).rows[0].job;await db.query("update automation_jobs set locked_at=now()-interval '11 minutes',created_at=now()-interval '1 day' where id=$1",[first.job_id]);const second=(await as('service_role',null,'select claim_qualification_job() as job')).rows[0].job;assert.equal(second.job_id,first.job_id);assert.notEqual(second.lease_token,first.lease_token);assert.equal((await as('service_role',null,'select finish_qualification_job($1,$2,$3) as ok',[first.job_id,first.lease_token,{summary:'Stale',followup_draft:'Stale'}])).rows[0].ok,false);await as('service_role',null,'select finish_qualification_job($1,$2,null,$3)',[second.job_id,second.lease_token,'Provider failure']);const row=(await db.query('select * from automation_jobs where id=$1',[second.job_id])).rows[0];assert.equal(row.status,'retry');assert.equal(row.attempts,2);assert.ok(new Date(row.next_attempt_at)>new Date())});
 await t.test('third failure is terminal',async()=>{const row=(await db.query("select id from automation_jobs where status='retry' limit 1")).rows[0];await db.query("update automation_jobs set next_attempt_at=now()-interval '1 minute',created_at=now()-interval '2 days' where id=$1",[row.id]);const third=(await as('service_role',null,'select claim_qualification_job() as job')).rows[0].job;assert.equal(third.job_id,row.id);await as('service_role',null,'select finish_qualification_job($1,$2,null,$3)',[third.job_id,third.lease_token,'Provider failure']);assert.equal((await db.query('select status from automation_jobs where id=$1',[row.id])).rows[0].status,'failed')});
 }finally{await db.close()}
});
