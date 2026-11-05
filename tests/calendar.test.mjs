import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const sql=readFileSync(new URL('../supabase/migrations/202610300004_dashboard_calendar.sql',import.meta.url),'utf8');
test('dashboard calendar persistence, authorization and appointment integrity',async t=>{
 const db=new PGlite();
 const actor='11111111-1111-4111-8111-111111111111';
 const id='22222222-2222-4222-8222-222222222222';
 const second='33333333-3333-4333-8333-333333333333';
 const base={id,title:'Battery consultation',event_type:'consultation',lead_id:null,starts_at:'2026-11-05T17:00:00Z',ends_at:'2026-11-05T17:30:00Z',notes:'Overnight backup',actor,status:'scheduled',version:1};
 async function action(name,payload){return (await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_calendar($1,$2::jsonb) as result',[name,JSON.stringify(payload)]);})).rows[0].result;}
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create table public.leads(id uuid primary key);create table public.appointments(id uuid primary key,starts_at timestamptz,ends_at timestamptz,status text);`);
  await db.exec(sql);await db.exec(sql);
  await t.test('non-staff API roles cannot invoke writes',async()=>{
   for(const role of ['anon','authenticated'])await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select public.helios_calendar('create',$1::jsonb)",[JSON.stringify(base)]);}),/permission denied/);
  });
  await t.test('create persists, retries return same row and modified retries fail',async()=>{
   const first=await action('create',base);assert.equal(first.event.id,id);
   assert.equal((await action('create',base)).event.id,id);
   assert.equal((await db.query('select count(*)::int as count from helios.calendar_events')).rows[0].count,1);
   assert.equal((await action('create',{...base,title:'Another title'})).error,'request_conflict');
  });
  await t.test('overlap is rejected but adjacent events are allowed',async()=>{
   assert.equal((await action('create',{...base,id:second,starts_at:'2026-11-05T17:15:00Z'})).error,'slot_conflict');
   assert.equal((await action('create',{...base,id:second,starts_at:'2026-11-05T17:30:00Z',ends_at:'2026-11-05T18:00:00Z'})).event.id,second);
  });
  await t.test('list returns real rows for the selected range',async()=>{
   assert.equal((await action('list',{after:'2026-11-05T00:00:00Z',before:'2026-11-06T00:00:00Z'})).events.length,2);
   assert.equal((await action('list',{after:'2026-12-05T00:00:00Z',before:'2026-12-06T00:00:00Z'})).events.length,0);
  });
  await t.test('updates reject stale versions',async()=>{
   assert.equal((await action('update',{...base,title:'Updated consultation'})).event.version,2);
   assert.equal((await action('update',base)).error,'version_conflict');
  });
  await t.test('cancellation keeps history and frees the slot',async()=>{
   assert.equal((await action('cancel',{id,version:2,actor})).event.status,'cancelled');
   const third='44444444-4444-4444-8444-444444444444';
   assert.equal((await action('create',{...base,id:third})).event.id,third);
  });
  await t.test('existing confirmed WhatsApp appointments block the same slot',async()=>{
   await db.exec("insert into public.appointments values('55555555-5555-4555-8555-555555555555','2026-11-06T17:00Z','2026-11-06T17:30Z','confirmed')");
   assert.equal((await action('create',{...base,id:'66666666-6666-4666-8666-666666666666',starts_at:'2026-11-06T17:00Z',ends_at:'2026-11-06T17:30Z'})).error,'slot_conflict');
   assert.equal((await db.query('select count(*)::int as count from public.appointments')).rows[0].count,1);
  });
 }finally{await db.close();}
});
