import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const base=readFileSync(new URL('../supabase/migrations/202610300002_backend_api.sql',import.meta.url),'utf8');
const upgrade=readFileSync(new URL('../supabase/migrations/202610300003_district_rotation.sql',import.meta.url),'utf8');
const tasks=[
 {key:'wuse-hotel',district:'Wuse II',category:'hotels',bounds:{south:9.075,north:9.095,west:7.455,east:7.49},position:0},
 {key:'maitama-hotel',district:'Maitama',category:'hotels',bounds:{south:9.095,north:9.13,west:7.46,east:7.515},position:1}
];
const policy={protocol:2,plan_hash:'test-plan',tasks,daily_target:20,min_rating:4,min_reviews:10,revisit_hours:168,max_pages:3,interval_hours:24};
const seed=()=>`create role anon;create role authenticated;create role service_role bypassrls;
create schema auth;create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table public.leads(id uuid primary key,name text,notes text,stage text,created_at timestamptz default now());
create table public.messages(id uuid primary key,lead_id uuid,message_text text);
insert into public.leads values('11111111-1111-4111-8111-111111111111','Existing lead','Keep notes','Qualified',now());`;
function record(n,task=tasks[0]){return {place_id:'place-'+n,fingerprint:('f'+n).padEnd(64,'x'),name:'Business '+n,address:'Address '+n,phone:'+2348000000000',website:'',latitude:(task.bounds.south+task.bounds.north)/2,longitude:(task.bounds.west+task.bounds.east)/2,category:'hotel',rating:4.4,review_count:12,district:task.district};}
async function setup(){
 const db=new PGlite();await db.exec(seed());await db.exec(base);await db.exec(upgrade);
 const action=async(a,p={})=>(await db.transaction(async tx=>{await tx.exec('set local role service_role');return tx.query('select public.helios_backend($1,$2) as result',[a,JSON.stringify(p)]);})).rows[0].result;
 await action('toggle',{enabled:true});
 const job=await action('claim',policy);
 return {db,action,job,fence:{job_id:job.id,lease:job.lease,protocol:2}};
}
test('district rotation, exact daily cap, persisted pagination and review gate',async t=>{
 const {db,action,job,fence}=await setup();
 try{
  let task;
  await t.test('existing leads remain intact; staff-only function remains private',async()=>{
   assert.equal((await db.query('select notes from public.leads')).rows[0].notes,'Keep notes');
   await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role authenticated');await tx.query("select public.helios_backend('status')");}),/permission denied/);
  });
  await t.test('old workers cannot acquire collector leases',async()=>{
   assert.equal((await action('claim',{interval_hours:24})).error,'collector_upgrade_required');
  });
  await t.test('first task targets one district; bad reviews and out-of-area records rejected in SQL',async()=>{
   task=(await action('work',fence)).task;assert.equal(task.district,'Wuse II');
   const payload={...fence,task_key:task.key,batch_id:'wuse-1',records:[...Array.from({length:15},(_,n)=>record(n)),{...record(100),rating:3.9},{...record(101),review_count:9},{...record(102),latitude:9.12}],rejected:0,next_page_token:'page-two',from_pending:false};
   const result=await action('ingest',payload);assert.equal(result.new,15);
   assert.equal((await action('status')).new_today,15);
   assert.equal((await action('ingest',payload)).duplicate_batch,true);
  });
  await t.test('next page search rotates to next district rather than restarting Abuja',async()=>{
   task=(await action('work',fence)).task;assert.equal(task.district,'Maitama');
  });
  await t.test('day cap stops at 20 exact and stores surplus page results for another day',async()=>{
   const result=await action('ingest',{...fence,task_key:task.key,batch_id:'maitama-1',records:Array.from({length:10},(_,n)=>record(n+200,tasks[1])),rejected:0,next_page_token:null,from_pending:false});
   assert.equal(result.new,5);assert.equal(result.new_today,20);
   assert.equal((await db.query("select jsonb_array_length(pending) as count from helios.search_tasks where key='maitama-hotel'")).rows[0].count,5);
   assert.equal((await action('work',fence)).outcome,'daily_target_reached');
   assert.equal((await action('enqueue')).error,'daily_target_reached');
   assert.equal((await action('prospects')).total,20);
   await action('finish',{...fence,outcome:'daily_target_reached'});
   assert.equal((await action('claim',policy)),null);
  });
  await t.test('resume keeps district/page checkpoints and buffered prospects after restart/day change',async()=>{
   await db.exec("update helios.discovery_days set day='2000-01-01';update helios.collector_control set next_scan_at=1");
   const next=await action('claim',policy),f={job_id:next.id,lease:next.lease,protocol:2};
   const work=await action('work',f);assert.equal(work.task.key,'wuse-hotel');assert.equal(work.task.next_page_token,'page-two');assert.equal(work.task.page_number,1);
   await action('ingest',{...f,task_key:work.task.key,batch_id:'resume-wuse',records:[record(0),record(400)],rejected:0,next_page_token:null,from_pending:false});
   assert.equal((await action('status')).new_today,1); // Duplicate is refreshed, never counted as new.
   const pending=(await action('work',f)).task;assert.equal(pending.district,'Maitama');assert.equal(pending.pending.length,5);
   await action('ingest',{...f,task_key:pending.key,batch_id:'pending-maitama',records:pending.pending,rejected:0,next_page_token:null,from_pending:true});
   assert.equal((await action('status')).new_today,6);
   assert.equal((await action('work',f)).outcome,'search_plan_exhausted');
   await action('finish',{...f,outcome:'search_plan_exhausted'});
  });
  await t.test('rerunning migration preserves progress and never resets existing rows or enabled state',async()=>{
   await db.exec(upgrade);assert.equal((await action('status')).enabled,true);assert.equal((await action('status')).new_today,6);
   assert.equal((await db.query('select count(*)::int as count from public.leads')).rows[0].count,1);
  });
 }finally{await db.close();}
});
test('unreviewed legacy prospects are retained but excluded from default quality-filtered results',async()=>{
 const {db,action}=await setup();
 try{
  await db.query("insert into helios.prospects(id,place_id,fingerprint,name,address,phone,website,latitude,longitude,category,stage,notes,consent,business_status,created_at,last_seen_at,version) values('legacy','legacy','legacy','Legacy','Address','','',9.08,7.47,'business','Qualified','Staff note',false,'OPERATIONAL',0,0,1)");
  assert.equal((await action('prospects')).total,0);assert.equal((await action('prospects',{qualified_only:false})).total,1);
  assert.equal((await db.query("select notes from helios.prospects where id='legacy'")).rows[0].notes,'Staff note');
 }finally{await db.close();}
});
