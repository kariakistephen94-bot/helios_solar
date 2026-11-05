-- Additive district rotation upgrade. Apply after 202610300002_backend_api.sql.
-- Existing leads, conversations, appointments, prospects and staff edits are preserved.
begin;
do $$ begin
 if to_regprocedure('public.helios_backend(text,jsonb)') is null then
  raise exception 'Apply the existing-system backend upgrade before district rotation';
 end if;
end $$;
alter table helios.prospects add column if not exists rating double precision;
alter table helios.prospects add column if not exists review_count integer;
alter table helios.prospects add column if not exists district text;
alter table helios.prospects add column if not exists quality_checked_at bigint;
create table if not exists helios.collector_policy (
 id integer primary key, daily_target integer not null, min_rating double precision not null,
 min_reviews integer not null, revisit_hours integer not null,max_pages integer not null,plan_hash text
);
create table if not exists helios.search_tasks (
 key text primary key,district text not null,category text not null,bounds jsonb not null,position integer not null,
 page_number integer not null default 0,next_page_token text,token_at bigint not null default 0,
 last_used bigint not null default 0,not_before bigint not null default 0,
 pending jsonb not null default '[]'::jsonb,active boolean not null default true
);
create table if not exists helios.scan_progress (
 scan_id text primary key,task_key text,outcome text,protocol integer not null default 2
);
create table if not exists helios.discovery_days (
 day text not null,prospect_id text not null unique,primary key(day,prospect_id)
);
create index if not exists discovery_days_day on helios.discovery_days(day);
alter table helios.collector_policy enable row level security;
alter table helios.search_tasks enable row level security;
alter table helios.scan_progress enable row level security;
alter table helios.discovery_days enable row level security;
revoke all on helios.collector_policy,helios.search_tasks,helios.scan_progress,helios.discovery_days from public,anon,authenticated;
-- One-time cutover: stop old whole-city jobs. Reapplying does not clear state or pause new jobs.
do $cutover$
declare inserted integer;
begin
 insert into helios.collector_policy values(1,20,4.0,10,168,3,null) on conflict do nothing;
 get diagnostics inserted=row_count;
 if inserted=1 then
  update helios.scans set status='cancelled',error='district_rotation_upgrade',finished_at=extract(epoch from clock_timestamp())::bigint,
   lease=null,lease_until=0 where status in ('queued','running','retry');
  update helios.collector_control set enabled=false,worker_lease=null,worker_until=0,next_scan_at=0 where id=1;
 end if;
end $cutover$;
create or replace function public.helios_backend(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare
 pol helios.collector_policy;
 task helios.search_tasks;
 progress helios.scan_progress;
 today_new integer;
 invalid_count integer:=0;
 remaining_records jsonb;
 local_day text:=to_char(clock_timestamp() at time zone 'Africa/Lagos','YYYY-MM-DD');
 t bigint := floor(extract(epoch from clock_timestamp()));
 c helios.collector_control;
 j helios.scans;
 p helios.prospects;
 r jsonb;
 result jsonb;
 v_id text;
 v_actor text := left(coalesce(p_payload->>'actor','collector'),100);
 v_lease text;
 v_count integer;
 v_new integer := 0;
 v_updated integer := 0;
 v_limit integer;
 v_day text := to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD');
begin
 if jsonb_typeof(p_payload) <> 'object' then raise exception 'invalid_payload'; end if;
 if p_action='workspace' or p_action='leads' then
  if to_regclass('public.leads') is null then return jsonb_build_object('error','existing_leads_table_missing');end if;
  select coalesce(jsonb_agg(x.item),'[]'::jsonb) into result from (
   select jsonb_build_object('name',coalesce(to_jsonb(l)->>'name',to_jsonb(l)->>'profile_name',to_jsonb(l)->>'phone','Unnamed lead'),'email','','phone','','city','','address','','bill',null,'interest','Not recorded',
    'notes','','consent',false,'stage','New inquiry','value',null,'survey_at',null,'ai_summary',null,'followup_draft',null,'source','Existing system')
    ||jsonb_strip_nulls(to_jsonb(l))||coalesce(d.data,'{}'::jsonb) as item
   from public.leads l left join helios.lead_details d on d.lead_id=l.id::text
   order by l.created_at desc,l.id
   limit case when p_action='workspace' then 1001 else least(200,greatest(1,coalesce((p_payload->>'limit')::int,50))) end
   offset case when p_action='workspace' then 0 else least(100000,greatest(0,coalesce((p_payload->>'offset')::int,0))) end
  ) x;
  if p_action='leads' then return jsonb_build_object('items',result);end if;
  select coalesce(jsonb_agg(x.item),'[]'::jsonb) into r from (
   select jsonb_build_object('id','followup:'||l.id::text,'lead_id',l.id,'status',coalesce(to_jsonb(l)->>'followup_status','not_scheduled'),
    'attempts',null,'created_at',l.created_at,'last_error',to_jsonb(l)->>'followup_reason') as item
   from public.leads l where to_jsonb(l)->>'followup_status' is not null order by l.created_at desc,l.id limit 50
  ) x;
  return jsonb_build_object('leads',(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(result) with ordinality where ordinality<=1000),
   'jobs',r,'has_more',jsonb_array_length(result)>1000,'job_source','existing_n8n_followups');
 elsif p_action='edit_lead' then
  if p_payload->>'stage' not in ('New inquiry','Qualified','Survey scheduled','Proposal sent','Won','Lost')
   or length(coalesce(p_payload->>'notes',''))>4000 then raise exception 'invalid_edit';end if;
  update public.leads set stage=(jsonb_populate_record(null::public.leads,jsonb_build_object('stage',p_payload->>'stage'))).stage,notes=coalesce(p_payload->>'notes','')
   where id::text=p_payload->>'id';
  get diagnostics v_count=row_count;
  if v_count=0 then return jsonb_build_object('error','not_found');end if;
  insert into helios.lead_details(lead_id,data) values(p_payload->>'id',jsonb_build_object('value',p_payload->'value','survey_at',p_payload->'survey_at'))
   on conflict(lead_id) do update set data=helios.lead_details.data||excluded.data;
  insert into helios.audit_events values(gen_random_uuid()::text,v_actor,'lead.updated',p_payload->>'id',t);
  return jsonb_build_object('id',p_payload->>'id');
 elsif p_action='inquiry' then
  -- Store the form's own data without adding columns to existing WhatsApp leads.
  perform pg_advisory_xact_lock(hashtextextended(p_payload->>'request_id',0));
  select lead_id into v_id from helios.inquiry_receipts where request_id=(p_payload->>'request_id')::uuid;
  if v_id is not null then return jsonb_build_object('received',true);end if;
  if (p_payload->'lead'->>'consent')::boolean is distinct from true then raise exception 'consent_required';end if;
  insert into helios.intake_limits(bucket,hits,expires_at) values((p_payload->>'ip_hash')||':'||(t/60)::text,1,t+86400)
   on conflict(bucket) do update set hits=helios.intake_limits.hits+1 returning hits into v_count;
  if v_count>5 then raise exception 'rate_limit';end if;
  v_id:=gen_random_uuid()::text;
  insert into public.leads(id,name,email,phone,city,interest,notes,stage,source)
   values(v_id::uuid,p_payload->'lead'->>'name',p_payload->'lead'->>'email',p_payload->'lead'->>'phone',p_payload->'lead'->>'city',
    p_payload->'lead'->>'interest',coalesce(p_payload->'lead'->>'notes',''),'New inquiry','Website');
  insert into helios.lead_details(lead_id,data) values(v_id,jsonb_build_object('address',p_payload->'lead'->'address',
   'bill',p_payload->'lead'->'bill','consent',true));
  insert into helios.inquiry_receipts values((p_payload->>'request_id')::uuid,v_id);
  delete from helios.intake_limits where expires_at<t;
  return jsonb_build_object('received',true);
 end if;
 if p_action='status' then
  select * into c from helios.collector_control where id=1;
  if not found then return jsonb_build_object('error','schema_not_ready');end if;
  select used into v_count from helios.request_budgets where day=v_day;
  select * into pol from helios.collector_policy where id=1;
  select count(*) into today_new from helios.discovery_days where day=local_day;
  return (to_jsonb(c)-'worker_lease')||jsonb_build_object('requests_used',coalesce(v_count,0),'protocol',2,
   'new_today',today_new,'daily_target',pol.daily_target,'min_rating',pol.min_rating,'min_review_count',pol.min_reviews,
   'target_timezone','Africa/Lagos','remaining_target',greatest(0,pol.daily_target-today_new),
   'district_count',(select count(distinct district) from helios.search_tasks where active),
   'searches_remaining',(select count(*) from helios.search_tasks where active and not_before<=t),
   'active_district',(select s.district from helios.scan_progress g join helios.search_tasks s on s.key=g.task_key join helios.scans active_scan on active_scan.id=g.scan_id where active_scan.status='running' limit 1));
 elsif p_action='prospects' then
  v_limit:=least(200,greatest(1,coalesce((p_payload->>'limit')::int,50)));
  select count(*) into v_count from helios.prospects
   where (not coalesce((p_payload->>'qualified_only')::boolean,true) or (rating >= (select min_rating from helios.collector_policy where id=1) and review_count >= (select min_reviews from helios.collector_policy where id=1))) and (coalesce(p_payload->>'q','')='' or strpos(lower(name),lower(p_payload->>'q'))>0)
    and (p_payload->>'stage' is null or stage=p_payload->>'stage');
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into result from (
   select * from helios.prospects
    where (not coalesce((p_payload->>'qualified_only')::boolean,true) or (rating >= (select min_rating from helios.collector_policy where id=1) and review_count >= (select min_reviews from helios.collector_policy where id=1))) and (coalesce(p_payload->>'q','')='' or strpos(lower(name),lower(p_payload->>'q'))>0)
     and (p_payload->>'stage' is null or stage=p_payload->>'stage')
    order by created_at desc,id limit v_limit offset least(100000,greatest(0,coalesce((p_payload->>'offset')::int,0)))
  ) x;
  return jsonb_build_object('items',result,'total',v_count);
 elsif p_action='scans' then
  select coalesce(jsonb_agg(to_jsonb(x)-'lease'),'[]'::jsonb) into result from (
   select s.*,sp.outcome from helios.scans s left join helios.scan_progress sp on sp.scan_id=s.id order by s.created_at desc,s.id limit least(100,greatest(1,coalesce((p_payload->>'limit')::int,30)))
  ) x;
  return jsonb_build_object('items',result);
 elsif p_action='edit' then
  if p_payload->>'stage' not in ('New prospect','Qualified','Survey scheduled','Proposal sent','Won','Lost')
   or length(coalesce(p_payload->>'notes',''))>4000 then raise exception 'invalid_edit';end if;
  select * into p from helios.prospects where id=p_payload->>'id' for update;
  if not found then return jsonb_build_object('error','not_found');end if;
  if p.version<>(p_payload->>'version')::int then return jsonb_build_object('error','version_conflict');end if;
  update helios.prospects set stage=p_payload->>'stage',notes=coalesce(p_payload->>'notes',''),version=version+1
   where id=p.id returning * into p;
  insert into helios.audit_events values(gen_random_uuid()::text,v_actor,'prospect.updated',p.id,t);
  return to_jsonb(p);
 end if;
 -- Collector mutations share one row lock, including admission, daily target and quota accounting.
 select * into c from helios.collector_control where id=1 for update;
 select * into pol from helios.collector_policy where id=1;
 if c.id is null then return jsonb_build_object('error','schema_not_ready');end if;
 select count(*) into today_new from helios.discovery_days where day=local_day;
 if p_action='toggle' then
  update helios.collector_control set enabled=(p_payload->>'enabled')::boolean where id=1;
  insert into helios.audit_events values(gen_random_uuid()::text,v_actor,'collector.toggled','abuja',t);
  return jsonb_build_object('enabled',(p_payload->>'enabled')::boolean);
 elsif p_action='enqueue' then
  if not c.enabled then return jsonb_build_object('error','collector_disabled');end if;
  if today_new>=pol.daily_target then return jsonb_build_object('error','daily_target_reached');end if;
  if c.paused_until>t then return jsonb_build_object('error','collector_cooldown');end if;
  select * into j from helios.scans where status in ('queued','running','retry') order by created_at,id limit 1;
  if found then return to_jsonb(j)-'lease';end if;
  insert into helios.scans(id,slot,status,attempts,lease,lease_until,next_attempt_at,created_at,finished_at,new_count,updated_count,rejected_count,error)
   values(gen_random_uuid()::text,'manual:'||(t/60)::text,'queued',0,null,0,0,t,null,0,0,0,null)
   on conflict(slot) do update set slot=excluded.slot returning * into j;
  insert into helios.audit_events values(gen_random_uuid()::text,v_actor,'scan.requested',j.id,t);
  return to_jsonb(j)-'lease';
 elsif p_action='claim' then
  if coalesce((p_payload->>'protocol')::int,0)<>2 then return jsonb_build_object('error','collector_upgrade_required');end if;
  if not c.enabled or c.paused_until>t or c.worker_until>t then return null;end if;
  if (p_payload->>'daily_target')::int not between 1 and 200 or (p_payload->>'min_rating')::float8 not between 4 and 5
   or (p_payload->>'min_reviews')::int<10 or jsonb_array_length(p_payload->'tasks') not between 1 and 1500 then raise exception 'invalid_policy';end if;
  update helios.collector_policy set daily_target=(p_payload->>'daily_target')::int,min_rating=(p_payload->>'min_rating')::float8,
   min_reviews=(p_payload->>'min_reviews')::int,revisit_hours=greatest(24,(p_payload->>'revisit_hours')::int),
   max_pages=greatest(1,least(3,(p_payload->>'max_pages')::int)) where id=1 returning * into pol;
  if pol.plan_hash is distinct from p_payload->>'plan_hash' then
   update helios.search_tasks set active=false where true;
   for r in select value from jsonb_array_elements(p_payload->'tasks') loop
    if (r->'bounds'->>'south')::float8 not between 8.5 and 9.5 or (r->'bounds'->>'north')::float8 not between 8.5 and 9.5
     or (r->'bounds'->>'west')::float8 not between 6.8 and 8 or (r->'bounds'->>'east')::float8 not between 6.8 and 8 then raise exception 'invalid_district';end if;
    insert into helios.search_tasks(key,district,category,bounds,position)
     values(r->>'key',r->>'district',r->>'category',r->'bounds',(r->>'position')::int)
     on conflict(key) do update set active=true,position=excluded.position;
   end loop;
   update helios.collector_policy set plan_hash=p_payload->>'plan_hash' where id=1;
  end if;
  if today_new>=pol.daily_target then return null;end if;
  update helios.scans set status='failed',error='worker_lease_expired',finished_at=t,lease=null,lease_until=0
   where status='running' and lease_until<=t and attempts>=3;
  if c.next_scan_at<=t then
   if not exists(select 1 from helios.scans where status in ('queued','running','retry')) then
    insert into helios.scans(id,slot,status,attempts,lease,lease_until,next_attempt_at,created_at,finished_at,new_count,updated_count,rejected_count,error)
     values(gen_random_uuid()::text,'district:'||c.next_scan_at::text,'queued',0,null,0,0,t,null,0,0,0,null) on conflict do nothing;
   end if;
   update helios.collector_control set next_scan_at=t+greatest(1,least(720,(p_payload->>'interval_hours')::int))*3600 where id=1;
  end if;
  select * into j from helios.scans where attempts<3 and next_attempt_at<=t
    and (status in ('queued','retry') or (status='running' and lease_until<=t)) order by created_at,id for update skip locked limit 1;
  if not found then return null;end if;
  v_lease:=gen_random_uuid()::text;
  update helios.scans set status='running',attempts=attempts+1,lease=v_lease,lease_until=t+300 where id=j.id returning * into j;
  insert into helios.scan_progress(scan_id) values(j.id) on conflict do nothing;
  update helios.collector_control set worker_lease=v_lease,worker_until=t+300 where id=1;
  return to_jsonb(j);
 end if;
 select * into j from helios.scans where id=p_payload->>'job_id' for update;
 select * into progress from helios.scan_progress where scan_id=j.id;
 if j.id is null or progress.protocol is distinct from 2 or j.status<>'running' or j.lease is distinct from p_payload->>'lease'
  or c.worker_lease is distinct from j.lease or j.lease_until<=t or c.worker_until<=t then return jsonb_build_object('error','lease_lost');end if;
 if not c.enabled and p_action not in ('fail','finish') then
  update helios.scans set status='cancelled',error='collector_disabled',finished_at=t,lease_until=0 where id=j.id;
  update helios.collector_control set worker_until=0,worker_lease=null where id=1;
  return jsonb_build_object('error','collector_disabled');
 end if;
 if p_action='work' then
  if today_new>=pol.daily_target then return jsonb_build_object('done',true,'outcome','daily_target_reached');end if;
  if progress.task_key is not null then select * into task from helios.search_tasks where key=progress.task_key;end if;
  if task.key is null or not task.active or task.not_before>t then
   select * into task from helios.search_tasks where active and not_before<=t order by last_used,position,key limit 1;
  end if;
  if task.key is null then return jsonb_build_object('done',true,'outcome','search_plan_exhausted');end if;
  -- Google page tokens are not assumed valid across long pauses/days.
  if task.next_page_token is not null and task.token_at<t-900 and jsonb_array_length(task.pending)=0 then
   update helios.search_tasks set page_number=0,next_page_token=null,token_at=0 where key=task.key returning * into task;
  end if;
  update helios.scan_progress set task_key=task.key where scan_id=j.id;
  update helios.scans set lease_until=t+300 where id=j.id;
  update helios.collector_control set worker_until=t+300 where id=1;
  return jsonb_build_object('done',false,'task',to_jsonb(task));
 elsif p_action='reserve' then
  if today_new>=pol.daily_target then return jsonb_build_object('error','daily_target_reached');end if;
  v_limit:=greatest(1,least(10000,(p_payload->>'limit')::int));
  insert into helios.request_budgets(day,used) values(v_day,0) on conflict do nothing;
  update helios.request_budgets set used=used+1 where day=v_day and used<v_limit;
  get diagnostics v_count=row_count;
  if v_count=0 then return jsonb_build_object('allowed',false,'retry_after',greatest(1,extract(epoch from (date_trunc('day',clock_timestamp() at time zone 'UTC')+interval '1 day') at time zone 'UTC')::bigint-t));end if;
  update helios.scans set lease_until=t+300 where id=j.id;
  update helios.collector_control set worker_until=t+300 where id=1;
  return jsonb_build_object('allowed',true);
 elsif p_action='reset_page' then
  if progress.task_key is distinct from p_payload->>'task_key' then return jsonb_build_object('error','task_mismatch');end if;
  update helios.search_tasks set next_page_token=null,page_number=0,token_at=0,last_used=t,not_before=t+60 where key=progress.task_key;
  update helios.scan_progress set task_key=null where scan_id=j.id;
  return jsonb_build_object('reset',true);
 elsif p_action='ingest' then
  if exists(select 1 from helios.scan_batches where scan_id=j.id and batch_id=p_payload->>'batch_id') then return jsonb_build_object('duplicate_batch',true);end if;
  if progress.task_key is distinct from p_payload->>'task_key' then return jsonb_build_object('error','task_mismatch');end if;
  select * into task from helios.search_tasks where key=progress.task_key for update;
  if jsonb_typeof(p_payload->'records')<>'array' or jsonb_array_length(p_payload->'records')>20 then raise exception 'invalid_batch';end if;
  insert into helios.scan_batches values(j.id,p_payload->>'batch_id') on conflict do nothing;
  get diagnostics v_count=row_count;
  if v_count=0 then return jsonb_build_object('duplicate_batch',true);end if;
  remaining_records:='[]'::jsonb;
  for r in select value from jsonb_array_elements(p_payload->'records') loop
   if coalesce((r->>'rating')::float8,0)<pol.min_rating or coalesce((r->>'rating')::float8,0)>5
    or coalesce((r->>'review_count')::int,0)<pol.min_reviews
    or not coalesce(((r->>'latitude')::float8 between (task.bounds->>'south')::float8 and (task.bounds->>'north')::float8)
    and ((r->>'longitude')::float8 between (task.bounds->>'west')::float8 and (task.bounds->>'east')::float8),false) then
     invalid_count:=invalid_count+1;continue;
   end if;
   if length(r->>'place_id') not between 1 and 300 or length(r->>'name') not between 1 and 300 or length(r->>'address') not between 1 and 600
    or length(r->>'fingerprint')<>64 then raise exception 'invalid_prospect';end if;
   v_id:=null;
   select prospect_id into v_id from helios.place_identities where place_id=r->>'place_id';
   if v_id is null then select id into v_id from helios.prospects where fingerprint=r->>'fingerprint';end if;
   if v_id is null and today_new>=pol.daily_target then remaining_records:=remaining_records||jsonb_build_array(r);continue;end if;
   if v_id is null then
    v_id:=gen_random_uuid()::text;
    insert into helios.prospects(id,place_id,fingerprint,name,address,phone,website,latitude,longitude,category,stage,notes,consent,business_status,created_at,last_seen_at,version,rating,review_count,district,quality_checked_at)
     values(v_id,r->>'place_id',r->>'fingerprint',r->>'name',r->>'address',coalesce(r->>'phone',''),coalesce(r->>'website',''),
      (r->>'latitude')::float8,(r->>'longitude')::float8,coalesce(r->>'category','business'),'New prospect','',false,'OPERATIONAL',t,t,1,
      (r->>'rating')::float8,(r->>'review_count')::int,task.district,t);
    insert into helios.discovery_days values(local_day,v_id);
    today_new:=today_new+1;v_new:=v_new+1;
   else
    update helios.prospects set name=r->>'name',address=r->>'address',phone=coalesce(r->>'phone',''),website=coalesce(r->>'website',''),
     latitude=(r->>'latitude')::float8,longitude=(r->>'longitude')::float8,category=coalesce(r->>'category','business'),last_seen_at=t,version=version+1,
     rating=(r->>'rating')::float8,review_count=(r->>'review_count')::int,district=task.district,quality_checked_at=t where id=v_id;
    v_updated:=v_updated+1;
   end if;
   insert into helios.place_identities values(r->>'place_id',v_id) on conflict do nothing;
  end loop;
  if coalesce((p_payload->>'from_pending')::boolean,false) then
   update helios.search_tasks set pending=remaining_records,last_used=t where key=task.key returning * into task;
  else
   update helios.search_tasks set pending=remaining_records,page_number=page_number+1,next_page_token=p_payload->>'next_page_token',token_at=t,last_used=t
    where key=task.key returning * into task;
  end if;
  if jsonb_array_length(task.pending)=0 and (task.next_page_token is null or task.page_number>=pol.max_pages) then
   update helios.search_tasks set not_before=t+pol.revisit_hours*3600,page_number=0,next_page_token=null,token_at=0 where key=task.key;
  end if;
  update helios.scan_progress set task_key=null where scan_id=j.id;
  update helios.scans set new_count=new_count+v_new,updated_count=updated_count+v_updated,
   rejected_count=rejected_count+invalid_count+greatest(0,coalesce((p_payload->>'rejected')::int,0)),lease_until=t+300 where id=j.id;
  update helios.collector_control set worker_until=t+300 where id=1;
  return jsonb_build_object('new',v_new,'updated',v_updated,'new_today',today_new,'target_reached',today_new>=pol.daily_target);
 elsif p_action='finish' then
  update helios.scans set status='completed',finished_at=t,lease_until=0,lease=null,error=null where id=j.id;
  update helios.scan_progress set task_key=null,outcome=p_payload->>'outcome' where scan_id=j.id;
  update helios.collector_control set worker_until=0,worker_lease=null where id=1;
  return jsonb_build_object('completed',true);
 elsif p_action='fail' then
  update helios.scans set status=case when attempts>=3 then 'failed' else 'retry' end,error=left(p_payload->>'error',200),
   next_attempt_at=t+greatest(1,(p_payload->>'delay')::bigint),lease_until=0,lease=null,finished_at=case when attempts>=3 then t else null end where id=j.id;
  update helios.collector_control set paused_until=t+greatest(1,(p_payload->>'delay')::bigint),worker_until=0,worker_lease=null,
   enabled=case when p_payload->>'error' in ('provider_access_denied','provider_request_rejected') then false else enabled end where id=1;
  return jsonb_build_object('recorded',true);
 end if;
 raise exception 'unsupported_action';
end $$;
revoke all on function public.helios_backend(text,jsonb) from public,anon,authenticated;
grant execute on function public.helios_backend(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
