import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const sql=readFileSync(new URL('../supabase/migrations/202610310006_outreach_queue.sql',import.meta.url),'utf8');
test('outreach draft persistence and guards',async t=>{
 const db=new PGlite();
 const actor='11111111-1111-4111-8111-111111111111';
 const id='22222222-2222-4222-8222-222222222222';
 const base={actor,id,prospect_id:'prospect-1',prospect_version:1,template_version:'solar-introduction-v1',message_text:'Hello\n\nOpen to a chat?',business_name:'Example Business'};
 async function action(name,payload=base){return (await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_outreach($1,$2::jsonb) as result',[name,JSON.stringify(payload)]);})).rows[0].result;}
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;create table public.staff_members(user_id uuid primary key);create table helios.prospects(id text primary key,name text,phone text,version int);insert into public.staff_members values('${actor}');insert into helios.prospects values('prospect-1','Example Business','+2348000000000',1);`);
  await db.exec(sql);await db.exec(sql);
  await t.test('public roles cannot invoke queue',async()=>{
   for(const role of ['anon','authenticated'])await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select public.helios_outreach('create',$1::jsonb)",[JSON.stringify(base)]);}),/permission denied/);
   assert.equal((await action('create',{...base,actor:null})).error,'staff_required');
  });
  await t.test('draft snapshot and exact retry persist once',async()=>{
   const r=await action('create');assert.equal(r.job.status,'draft');assert.equal(r.job.recipient_snapshot,'+2348000000000');
   assert.equal((await action('create')).already_exists,true);
   assert.equal((await action('create',{...base,message_text:'Different'})).error,'request_conflict');
  });
  await t.test('different request cannot duplicate active prospect template',async()=>{
   const r=await action('create',{...base,id:'33333333-3333-4333-8333-333333333333'});
   assert.equal(r.job.id,id);assert.equal(r.already_exists,true);
   assert.equal((await action('list')).total,1);
  });
  await t.test('review records actor and rejects stale revisions',async()=>{
   const r=await action('review',{actor,id,version:1});assert.equal(r.job.status,'reviewed');assert.equal(r.job.reviewed_by,actor);
   assert.equal((await action('cancel',{actor,id,version:1})).error,'version_conflict');
   assert.equal((await action('cancel',{actor,id,version:2})).job.status,'cancelled');
   assert.equal((await action('review',{actor,id,version:3})).error,'invalid_transition');
  });
  await t.test('stale prospect cannot create a new draft',async()=>{
   await db.exec("update helios.prospects set version=2");
   assert.equal((await action('create',{...base,id:'44444444-4444-4444-8444-444444444444'})).error,'version_conflict');
   assert.equal((await db.query('select count(*)::int n from helios.outreach_jobs')).rows[0].n,1);
  });
 }finally{await db.close();}
});
