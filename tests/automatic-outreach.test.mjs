import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('automatic queue preserves suppression and never re-enrols cancelled jobs',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;
   create table public.staff_members(user_id uuid primary key);
   create table public.leads(whatsapp_id text,phone text,opted_out boolean,followup_blocked boolean);
   create table helios.prospects(id text primary key,name text,phone text,version int,category text,stage text,created_at bigint);
   insert into helios.prospects values('p1','Stephen','08107920394',1,'test_contact','New prospect',1),('p2','Blocked','+2349138314501',1,'business','New prospect',2),('p3','Missing','',1,'business','New prospect',3);
   insert into public.leads values('2349138314501','+2349138314501',false,true);`);
  await db.exec(readFileSync(new URL('../supabase/migrations/202610310006_outreach_queue.sql',import.meta.url),'utf8'));
  const sql=readFileSync(new URL('../supabase/migrations/202610310008_automatic_outreach.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  async function call(action,payload={}){return(await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_outreach_automatic($1,$2::jsonb) r',[action,JSON.stringify(payload)]);})).rows[0].r;}
  assert.equal((await call('candidates')).items.length,3);
  const base={id:'22222222-2222-4222-8222-222222222222',prospect_id:'p1',prospect_version:1,draft_status:'draft',business_name:'Stephen',message_text:'Hello'};
  assert.equal((await call('enqueue',base)).status,'queued');
  assert.equal((await call('enqueue',base)).status,'existing');
  assert.equal((await db.query("select recipient_snapshot from helios.outreach_jobs where prospect_id='p1'")).rows[0].recipient_snapshot,'+2348107920394');
  assert.equal((await call('enqueue',{...base,id:'33333333-3333-4333-8333-333333333333',prospect_id:'p2'})).status,'blocked');
  assert.equal((await call('enqueue',{...base,id:'44444444-4444-4444-8444-444444444444',prospect_id:'p3'})).status,'blocked');
  await db.exec("update helios.outreach_jobs set status='cancelled' where prospect_id='p1'");
  assert.equal((await call('candidates')).items.length,0);
  assert.equal((await call('enqueue',base)).status,'existing');
  await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role anon');await tx.query("select public.helios_outreach_automatic('candidates','{}')");}),/permission denied/);
 }finally{await db.close();}
});
