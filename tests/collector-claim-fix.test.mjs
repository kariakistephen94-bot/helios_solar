import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const read=n=>readFileSync(new URL('../supabase/migrations/'+n,import.meta.url),'utf8');
const seed=`create role anon;create role authenticated;create role service_role bypassrls;
create schema auth;create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table public.leads(id uuid primary key,name text,notes text,stage text,created_at timestamptz default now());
create table public.messages(id uuid primary key,lead_id uuid,message_text text);`;
const body=db=>db.query("select pg_get_functiondef('public.helios_backend(text,jsonb)'::regprocedure) d").then(r=>r.rows[0].d);

test('patch qualifies the unconditional search_tasks update and is rerunnable',async()=>{
 const db=new PGlite();
 try{
  await db.exec(seed);await db.exec(read('202610300002_backend_api.sql'));
  // Reproduce the live function: the deployed version lacks the WHERE clause.
  await db.exec(read('202610300003_district_rotation.sql').replace('update helios.search_tasks set active=false where true;','update helios.search_tasks set active=false;'));
  assert.match(await body(db),/update helios\.search_tasks set active=false;/);
  const fix=read('202611010017_collector_claim_where_fix.sql');
  await db.exec(fix);
  const patched=await body(db);
  assert.match(patched,/update helios\.search_tasks set active=false where true;/);
  assert.doesNotMatch(patched,/set active=false;/);
  await db.exec(fix);
  assert.equal(await body(db),patched);
  const grants=await db.query("select has_function_privilege('service_role','public.helios_backend(text,jsonb)','execute') ok, has_function_privilege('anon','public.helios_backend(text,jsonb)','execute') anon");
  assert.equal(grants.rows[0].ok,true);assert.equal(grants.rows[0].anon,false);
 }finally{await db.close()}
});

test('fresh installs already carry the WHERE clause',()=>{
 assert.match(read('202610300003_district_rotation.sql'),/set active=false where true;/);
});
