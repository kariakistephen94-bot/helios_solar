import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const calendar=readFileSync(new URL('../supabase/migrations/202610300004_dashboard_calendar.sql',import.meta.url),'utf8');
const booking=readFileSync(new URL('../supabase/migrations/202610300005_website_booking.sql',import.meta.url),'utf8');
test('website booking is atomic, private, idempotent and shares staff conflict protection',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create table public.leads(id uuid primary key,name text,email text,source text check(source in ('website','whatsapp')),interest text,notes text,stage text);
  create table public.appointments(id uuid primary key,starts_at timestamptz,ends_at timestamptz,status text);`);
  await db.exec(calendar);await db.exec(booking);await db.exec(booking);
  const next=(await db.query("select ((date_trunc('week',now() at time zone 'America/Chicago')+interval '7 days 10 hours') at time zone 'America/Chicago')::text as start")).rows[0].start;
  const payload={request_id:'11111111-1111-4111-8111-111111111111',starts_at:next,name:'Test Visitor',email:'test@example.com',notes:'Battery backup',client_hash:'test-client'};
  async function rpc(action,data=payload){return (await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_website_booking($1,$2::jsonb) as result',[action,JSON.stringify(data)]);})).rows[0].result;}
  await t.test('public roles cannot directly confirm bookings',async()=>{
   await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role anon');await tx.query("select public.helios_website_booking('confirm',$1::jsonb)",[JSON.stringify(payload)]);}),/permission denied/);
  });
  await t.test('availability check creates no lead or event',async()=>{
   assert.equal((await rpc('availability')).available,true);
   assert.equal((await db.query('select count(*)::int as n from public.leads')).rows[0].n,0);
  });
  await t.test('confirmation atomically saves a website lead and local appointment',async()=>{
   const result=await rpc('confirm');assert.equal(result.event.status,'scheduled');
   const lead=(await db.query('select * from public.leads')).rows[0];assert.equal(lead.source,'website');assert.equal(lead.stage,'Survey scheduled');
   const event=(await db.query('select * from helios.calendar_events')).rows[0];assert.equal(event.created_by,null);assert.equal(event.source,'website');
  });
  await t.test('repeated confirmation returns the same booking, without duplicate leads',async()=>{
   assert.equal((await rpc('confirm')).event.id,payload.request_id);
   assert.equal((await db.query('select count(*)::int as n from public.leads')).rows[0].n,1);
  });
  await t.test('another request cannot book the same time or create an orphan lead',async()=>{
   assert.equal((await rpc('confirm',{...payload,request_id:'22222222-2222-4222-8222-222222222222'})).error,'slot_conflict');
   assert.equal((await db.query('select count(*)::int as n from public.leads')).rows[0].n,1);
  });
  await t.test('receipt cannot be replayed by another visitor',async()=>{
   assert.equal((await rpc('confirm',{...payload,client_hash:'other-client'})).error,'invalid_request');
  });
  await t.test('late-night and past times are rejected by the database',async()=>{
   const late=(await db.query("select ((date_trunc('week',now() at time zone 'America/Chicago')+interval '7 days 23 hours 30 minutes') at time zone 'America/Chicago')::text as start")).rows[0].start;
   assert.equal((await rpc('availability',{starts_at:late})).error,'invalid_time');
   assert.equal((await rpc('availability',{starts_at:'2020-01-01T10:00:00Z'})).error,'invalid_time');
  });
 }finally{await db.close();}
});
