import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync(new URL('../supabase/migrations/202610300002_backend_api.sql',import.meta.url),'utf8');

test('Supabase backend RPC permissions, deduplication and durable worker fencing',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth to authenticated,service_role;
  grant execute on function auth.uid() to authenticated,service_role;
  create table public.leads(id uuid primary key default gen_random_uuid(),phone text,followup_status text,name text,notes text,stage text,email text,city text,interest text,created_at timestamptz default now(),source text);
  create table public.messages(id uuid primary key,lead_id uuid references public.leads(id),message_text text);
  insert into public.leads(id,phone,followup_status) values('11111111-1111-4111-8111-111111111111','test-phone','scheduled');
  insert into public.messages values('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Existing conversation');`);
  await db.exec(migration);
  // Reapplying the SQL is safe, without deleting existing records or changing pipeline stages.
  await db.exec(migration);
  async function action(action,payload={}){
   const result=await db.transaction(async tx=>{
    await tx.exec('set local role service_role');
    return tx.query('select public.helios_backend($1,$2::jsonb) as result',[action,JSON.stringify(payload)]);
   });return result.rows[0].result;
  }
  await t.test('existing lead schema, follow-up state and conversations survive repeated upgrade',async()=>{
   const columns=(await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='leads' order by ordinal_position")).rows.map(x=>x.column_name);
   assert.deepEqual(columns,['id','phone','followup_status','name','notes','stage','email','city','interest','created_at','source']);
   assert.equal((await db.query('select followup_status from public.leads')).rows[0].followup_status,'scheduled');
   assert.equal((await db.query('select message_text from public.messages')).rows[0].message_text,'Existing conversation');
  });
  await t.test('new staff membership access is self-only and existing members survive reapplication',async()=>{
   await db.exec("insert into auth.users values('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444'); insert into public.staff_members(user_id,display_name) values('33333333-3333-4333-8333-333333333333','Existing staff')");
   await db.exec(migration);
   await db.transaction(async tx=>{
    await tx.exec("set local role authenticated; select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true)");
    assert.equal((await tx.query('select * from public.staff_members')).rows.length,0);
   });
   assert.equal((await db.query('select display_name from public.staff_members')).rows[0].display_name,'Existing staff');
  });
  await t.test('workspace reads the existing lead schema without a legacy automation_jobs table',async()=>{
   const workspace=await action('workspace');
   assert.equal(workspace.leads.length,1);
   assert.equal(workspace.leads[0].name,'test-phone');
   assert.equal(workspace.leads[0].bill,null);
   assert.equal(workspace.leads[0].value,null);
   assert.equal(workspace.jobs[0].status,'scheduled');
   assert.equal(workspace.job_source,'existing_n8n_followups');
  });
  await t.test('staff edits store supplemental fields separately and preserve follow-up scheduling',async()=>{
   await action('edit_lead',{id:'11111111-1111-4111-8111-111111111111',stage:'Qualified',notes:'Verified',value:1200,survey_at:null,actor:'staff'});
   const row=(await db.query('select * from public.leads')).rows[0];
   assert.equal(row.followup_status,'scheduled');assert.equal(row.stage,'Qualified');
   assert.equal((await action('workspace')).leads[0].value,1200);
  });
  await t.test('public enquiry deduplicates without adding columns or opting existing leads into follow-ups',async()=>{
   const request={request_id:'55555555-5555-4555-8555-555555555555',ip_hash:'private-hash',lead:{name:'Form customer',phone:'test-form',email:'test@example.com',city:'Abuja',interest:'Home solar',notes:'',consent:true,address:'Test address',bill:100}};
   await action('inquiry',request);await action('inquiry',request);
   assert.equal((await db.query('select count(*)::int as count from public.leads')).rows[0].count,2);
   assert.equal((await db.query("select followup_status from public.leads where id='11111111-1111-4111-8111-111111111111'")).rows[0].followup_status,'scheduled');
  });
  let job,lead,lease;
  const record={place_id:'p1',fingerprint:'a'.repeat(64),name:'Test Abuja Business',address:'10 Example Street',phone:'+2348000000000',website:'',latitude:9.07,longitude:7.45,category:'business'};
  await t.test('anon and signed-in users cannot call admin RPC or read private tables',async()=>{
   for(const role of ['anon','authenticated']){
    await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select public.helios_backend('status')");}),/permission denied/);
    await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query('select * from helios.prospects');}),/permission denied/);
   }
  });
  await t.test('collector disabled by default; enable and claim exactly one job',async()=>{
   assert.equal((await action('status')).enabled,false);
   assert.equal(await action('claim',{interval_hours:24}),null);
   await action('toggle',{enabled:true,actor:'staff'});
   const first=await action('enqueue',{actor:'staff'});
   assert.equal((await action('enqueue',{actor:'staff'})).id,first.id);
   job=await action('claim',{interval_hours:24});lease=job.lease;
   assert.equal(job.id,first.id);
   assert.equal(await action('claim',{interval_hours:24}),null);
  });
  await t.test('request budget is atomic and survives calls',async()=>{
   const payload={job_id:job.id,lease,limit:1};
   assert.equal((await action('reserve',payload)).allowed,true);
   assert.equal((await action('reserve',payload)).allowed,false);
   assert.equal((await action('status')).requests_used,1);
  });
  await t.test('page retries are idempotent; replacement IDs deduplicate; CRM edits survive',async()=>{
   const batch={job_id:job.id,lease,batch_id:'page1',records:[record],rejected:1};
   assert.equal((await action('ingest',batch)).new,1);
   assert.equal((await action('ingest',batch)).duplicate_batch,true);
   lead=(await action('prospects')).items[0];
   assert.equal(lead.consent,false);
   assert.equal((await action('edit',{id:lead.id,stage:'Qualified',notes:'staff edit',version:lead.version,actor:'staff'})).stage,'Qualified');
   assert.equal((await action('edit',{id:lead.id,stage:'Lost',notes:'stale',version:lead.version,actor:'staff'})).error,'version_conflict');
   await action('ingest',{...batch,batch_id:'page2',records:[{...record,place_id:'replacement'}],rejected:0});
   const data=await action('prospects');
   assert.equal(data.total,1);assert.equal(data.items[0].stage,'Qualified');assert.equal(data.items[0].notes,'staff edit');
   assert.equal((await action('scans')).items[0].rejected_count,1);
  });
  await t.test('expired worker is replaced and cannot reserve, ingest or finish',async()=>{
   await db.query('update helios.collector_control set worker_until=0');
   await db.query('update helios.scans set lease_until=0 where id=$1',[job.id]);
   const next=await action('claim',{interval_hours:24});
   assert.equal(next.id,job.id);assert.notEqual(next.lease,lease);assert.equal(next.attempts,2);
   for(const a of ['reserve','ingest','finish']) assert.equal((await action(a,{job_id:job.id,lease,limit:1,records:[],batch_id:'late'})).error,'lease_lost');
   lease=next.lease;
  });
  await t.test('access denial pauses and disables collector; late pages cannot commit',async()=>{
   await action('fail',{job_id:job.id,lease,error:'provider_access_denied',delay:86400});
   const c=await action('status');assert.equal(c.enabled,false);assert.ok(c.paused_until>0);
   assert.equal((await action('ingest',{job_id:job.id,lease,batch_id:'late2',records:[record],rejected:0})).error,'lease_lost');
  });
  await t.test('third expired attempt becomes terminal after restart',async()=>{
   await db.exec("update helios.collector_control set enabled=true,paused_until=0,worker_until=0,next_scan_at=9999999999; update helios.scans set status='running',attempts=3,lease_until=0");
   assert.equal(await action('claim',{interval_hours:24}),null);
   assert.equal((await action('scans')).items[0].status,'failed');
  });
 }finally{await db.close();}
});
