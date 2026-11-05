import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('test claims reject unreviewed jobs and fence duplicate executions',async()=>{
 const db=new PGlite();
 const id='22222222-2222-4222-8222-222222222222';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema helios;create table helios.outreach_jobs(id uuid primary key,status text,version int,message_text text);insert into helios.outreach_jobs values('${id}','draft',1,'Hello');`);
  const sql=readFileSync(new URL('../supabase/migrations/202610310009_automatic_outreach_claim.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  const claim=async execution=>(await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_outreach_test_claim($1,$2) r',[id,execution]);})).rows[0].r;
  assert.equal((await claim('one')).status,'not_ready');
  await db.exec("update helios.outreach_jobs set status='queued',version=2");
  const r=await claim('one');assert.equal(r.status,'test_claimed');assert.equal(r.can_send,false);assert.equal(r.recipient,undefined);
  assert.equal((await claim('one')).success,true);
  assert.equal((await claim('two')).status,'already_claimed');
  await db.exec("update helios.outreach_jobs set status='cancelled',version=3");
  assert.equal((await claim('one')).status,'not_ready');
  await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role anon');await tx.query('select public.helios_outreach_test_claim($1,$2)',[id,'three']);}),/permission denied/);
 }finally{await db.close();}
});
