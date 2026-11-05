-- ADDITIVE UPGRADE for the existing Helios system.
-- Do NOT rerun the fresh-install 202610240001_helios.sql on an existing database.
-- Existing public.leads, public.messages, n8n workflows, functions and records are preserved.
-- The Maps collector schema/RPC is self-contained and does not require the old initial migration.
-- Supabase HTTPS API + backend secret key; no runtime PostgreSQL connection required.
begin;
-- Add staff authentication only if the existing system does not already have it.
-- Preserve existing membership records, grants, and policies when the table exists.
do $staff_setup$
begin
 if to_regclass('public.staff_members') is null then
  create table public.staff_members (
   user_id uuid primary key references auth.users(id) on delete cascade,
   display_name text not null,
   created_at timestamptz not null default now()
  );
  alter table public.staff_members enable row level security;
  revoke all on public.staff_members from anon,authenticated;
  grant select on public.staff_members to authenticated,service_role;
  create policy "Helios staff can read own membership" on public.staff_members
   for select to authenticated using(user_id=auth.uid());
 end if;
end $staff_setup$;
create schema if not exists helios;
revoke all on schema helios from public, anon, authenticated;
create table if not exists helios.prospects (
 id text primary key, place_id text unique not null, fingerprint text unique not null,
 name text not null, address text not null, phone text not null, website text not null,
 latitude double precision not null, longitude double precision not null, category text not null,
 stage text not null, notes text not null, consent boolean not null, business_status text not null,
 created_at bigint not null, last_seen_at bigint not null, version integer not null
);
create table if not exists helios.place_identities(place_id text primary key,prospect_id text not null);
create index if not exists ix_place_identities_prospect_id on helios.place_identities(prospect_id);
create table if not exists helios.scans (
 id text primary key,slot text unique not null,status text not null,attempts integer not null,
 lease text,lease_until bigint not null,next_attempt_at bigint not null,created_at bigint not null,
 finished_at bigint,new_count integer not null,updated_count integer not null,rejected_count integer not null,error text
);
create index if not exists ix_scans_status on helios.scans(status);
create table if not exists helios.collector_control (
 id integer primary key,enabled boolean not null,next_scan_at bigint not null,paused_until bigint not null
);
alter table helios.collector_control add column if not exists worker_lease text;
alter table helios.collector_control add column if not exists worker_until bigint not null default 0;
create table if not exists helios.request_budgets(day text primary key,used integer not null);
create table if not exists helios.audit_events(id text primary key,actor text not null,action text not null,target text not null,created_at bigint not null);
create table if not exists helios.scan_batches(scan_id text not null,batch_id text not null,primary key(scan_id,batch_id));
-- Supplementary fields are kept outside the existing lead table.
create table if not exists helios.lead_details(lead_id text primary key,data jsonb not null default '{}'::jsonb);
create table if not exists helios.inquiry_receipts(request_id uuid primary key,lead_id text not null unique);
create table if not exists helios.intake_limits(bucket text primary key,hits integer not null,expires_at bigint not null);
alter table helios.lead_details enable row level security;
alter table helios.inquiry_receipts enable row level security;
alter table helios.intake_limits enable row level security;
insert into helios.collector_control(id,enabled,next_scan_at,paused_until) values(1,false,0,0) on conflict do nothing;
alter table helios.prospects enable row level security;
alter table helios.place_identities enable row level security;
alter table helios.scans enable row level security;
alter table helios.collector_control enable row level security;
alter table helios.request_budgets enable row level security;
alter table helios.audit_events enable row level security;
alter table helios.scan_batches enable row level security;
revoke all on all tables in schema helios from public, anon, authenticated;

create or replace function public.helios_backend(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare
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
  return (to_jsonb(c)-'worker_lease')||jsonb_build_object('requests_used',coalesce(v_count,0));
 elsif p_action='prospects' then
  v_limit:=least(200,greatest(1,coalesce((p_payload->>'limit')::int,50)));
  select count(*) into v_count from helios.prospects
   where (coalesce(p_payload->>'q','')='' or strpos(lower(name),lower(p_payload->>'q'))>0)
    and (p_payload->>'stage' is null or stage=p_payload->>'stage');
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into result from (
   select * from helios.prospects
    where (coalesce(p_payload->>'q','')='' or strpos(lower(name),lower(p_payload->>'q'))>0)
     and (p_payload->>'stage' is null or stage=p_payload->>'stage')
    order by created_at desc,id limit v_limit offset least(100000,greatest(0,coalesce((p_payload->>'offset')::int,0)))
  ) x;
  return jsonb_build_object('items',result,'total',v_count);
 elsif p_action='scans' then
  select coalesce(jsonb_agg(to_jsonb(x)-'lease'),'[]'::jsonb) into result from (
   select * from helios.scans order by created_at desc,id limit least(100,greatest(1,coalesce((p_payload->>'limit')::int,30)))
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
 -- One control-row lock serializes collector admission and budget changes across replicas.
 select * into c from helios.collector_control where id=1 for update;
 if not found then return jsonb_build_object('error','schema_not_ready');end if;
 if p_action='toggle' then
  update helios.collector_control set enabled=(p_payload->>'enabled')::boolean where id=1;
  insert into helios.audit_events values(gen_random_uuid()::text,v_actor,'collector.toggled','abuja',t);
  return jsonb_build_object('enabled',(p_payload->>'enabled')::boolean);
 elsif p_action='enqueue' then
  if not c.enabled then return jsonb_build_object('error','collector_disabled');end if;
  if c.paused_until>t then return jsonb_build_object('error','collector_cooldown');end if;
  select * into j from helios.scans where status in ('queued','running','retry') order by created_at,id limit 1;
  if found then return to_jsonb(j)-'lease';end if;
  insert into helios.scans values(gen_random_uuid()::text,'manual:'||(t/60)::text,'queued',0,null,0,0,t,null,0,0,0,null)
   on conflict(slot) do update set slot=excluded.slot returning * into j;
  insert into helios.audit_events values(gen_random_uuid()::text,v_actor,'scan.requested',j.id,t);
  return to_jsonb(j)-'lease';
 elsif p_action='claim' then
  if not c.enabled or c.paused_until>t or c.worker_until>t then return null;end if;
  update helios.scans set status='failed',error='worker_lease_expired',finished_at=t,lease=null,lease_until=0
   where status='running' and lease_until<=t and attempts>=3;
  if c.next_scan_at<=t then
   if not exists(select 1 from helios.scans where status in ('queued','running','retry')) then
    insert into helios.scans values(gen_random_uuid()::text,'scheduled:'||c.next_scan_at::text,'queued',0,null,0,0,t,null,0,0,0,null) on conflict do nothing;
   end if;
   update helios.collector_control set next_scan_at=t+greatest(1,least(720,(p_payload->>'interval_hours')::int))*3600 where id=1;
  end if;
  select * into j from helios.scans where attempts<3 and next_attempt_at<=t
    and (status in ('queued','retry') or (status='running' and lease_until<=t))
    order by created_at,id for update skip locked limit 1;
  if not found then return null;end if;
  v_lease:=gen_random_uuid()::text;
  update helios.scans set status='running',attempts=attempts+1,lease=v_lease,lease_until=t+300 where id=j.id returning * into j;
  update helios.collector_control set worker_lease=v_lease,worker_until=t+300 where id=1;
  return to_jsonb(j);
 end if;
 -- Fencing tokens reject expired or superseded workers, including late network responses.
 select * into j from helios.scans where id=p_payload->>'job_id' for update;
 if not found or j.status<>'running' or j.lease is distinct from p_payload->>'lease'
  or c.worker_lease is distinct from j.lease or j.lease_until<=t or c.worker_until<=t then
  return jsonb_build_object('error','lease_lost');
 end if;
 if p_action='reserve' then
  if not c.enabled then return jsonb_build_object('error','collector_disabled');end if;
  v_limit:=greatest(1,least(10000,(p_payload->>'limit')::int));
  insert into helios.request_budgets(day,used) values(v_day,0) on conflict do nothing;
  update helios.request_budgets set used=used+1 where day=v_day and used<v_limit;
  get diagnostics v_count=row_count;
  if v_count=0 then return jsonb_build_object('allowed',false,'retry_after',greatest(1,extract(epoch from (date_trunc('day',clock_timestamp() at time zone 'UTC')+interval '1 day') at time zone 'UTC')::bigint-t));end if;
  update helios.scans set lease_until=t+300 where id=j.id;
  update helios.collector_control set worker_until=t+300 where id=1;
  return jsonb_build_object('allowed',true);
 elsif p_action='ingest' then
  if not c.enabled then
   update helios.scans set status='cancelled',error='collector_disabled',finished_at=t,lease_until=0 where id=j.id;
   update helios.collector_control set worker_until=0,worker_lease=null where id=1;
   return jsonb_build_object('error','collector_disabled');
  end if;
  if jsonb_typeof(p_payload->'records')<>'array' or jsonb_array_length(p_payload->'records')>20 then raise exception 'invalid_batch';end if;
  insert into helios.scan_batches values(j.id,p_payload->>'batch_id') on conflict do nothing;
  get diagnostics v_count=row_count;
  if v_count=0 then return jsonb_build_object('duplicate_batch',true);end if;
  for r in select value from jsonb_array_elements(p_payload->'records') loop
   if length(r->>'place_id') not between 1 and 300 or length(r->>'name') not between 1 and 300
    or length(r->>'address') not between 1 and 600 or length(r->>'fingerprint')<>64
    or (r->>'latitude')::float8 not between 8.5 and 9.5 or (r->>'longitude')::float8 not between 6.8 and 8.0 then raise exception 'invalid_prospect';end if;
   v_id:=null;
   select prospect_id into v_id from helios.place_identities where place_id=r->>'place_id';
   if v_id is null then select id into v_id from helios.prospects where fingerprint=r->>'fingerprint';end if;
   if v_id is null then
    v_id:=gen_random_uuid()::text;
    insert into helios.prospects values(v_id,r->>'place_id',r->>'fingerprint',r->>'name',r->>'address',coalesce(r->>'phone',''),coalesce(r->>'website',''),
     (r->>'latitude')::float8,(r->>'longitude')::float8,coalesce(r->>'category','business'),'New prospect','',false,'OPERATIONAL',t,t,1);
    v_new:=v_new+1;
   else
    -- Staff-owned CRM fields remain unchanged during rediscovery.
    update helios.prospects set name=r->>'name',address=r->>'address',phone=coalesce(r->>'phone',''),website=coalesce(r->>'website',''),
     latitude=(r->>'latitude')::float8,longitude=(r->>'longitude')::float8,category=coalesce(r->>'category','business'),last_seen_at=t,version=version+1 where id=v_id;
    v_updated:=v_updated+1;
   end if;
   insert into helios.place_identities values(r->>'place_id',v_id) on conflict do nothing;
  end loop;
  update helios.scans set new_count=new_count+v_new,updated_count=updated_count+v_updated,
   rejected_count=rejected_count+greatest(0,coalesce((p_payload->>'rejected')::int,0)),lease_until=t+300 where id=j.id;
  update helios.collector_control set worker_until=t+300 where id=1;
  return jsonb_build_object('new',v_new,'updated',v_updated);
 elsif p_action='finish' then
  update helios.scans set status='completed',finished_at=t,lease_until=0,lease=null,error=null where id=j.id;
  update helios.collector_control set worker_until=0,worker_lease=null where id=1;
  return jsonb_build_object('completed',true);
 elsif p_action='fail' then
  update helios.scans set status=case when attempts>=3 then 'failed' else 'retry' end,
   error=left(p_payload->>'error',200),next_attempt_at=t+greatest(1,(p_payload->>'delay')::bigint),lease_until=0,lease=null,
   finished_at=case when attempts>=3 then t else null end where id=j.id;
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
