-- Additive upgrade: draft/review storage only. No sending, schedules or triggers.
begin;
create table if not exists helios.outreach_jobs (
 id uuid primary key,
 prospect_id text not null references helios.prospects(id),
 template_version text not null,
 message_text text not null check(length(message_text) between 1 and 2000),
 business_name text not null,
 owner_name text,
 recipient_snapshot text,
 status text not null default 'draft' check(status in ('draft','reviewed','cancelled')),
 version integer not null default 1,
 created_by uuid not null,
 reviewed_by uuid,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index if not exists outreach_one_active_template
 on helios.outreach_jobs(prospect_id,template_version) where status in ('draft','reviewed');
alter table helios.outreach_jobs enable row level security;
revoke all on helios.outreach_jobs from public,anon,authenticated;

create or replace function public.helios_outreach(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare j helios.outreach_jobs; p helios.prospects; actor uuid;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' then return jsonb_build_object('error','invalid_request');end if;
 actor := (p_payload->>'actor')::uuid;
 if actor is null or not exists(select 1 from public.staff_members where user_id=actor) then
  return jsonb_build_object('error','staff_required');
 end if;
 if p_action='prospect' then
  select * into p from helios.prospects where id=p_payload->>'prospect_id';
  if not found then return jsonb_build_object('error','not_found');end if;
  return jsonb_build_object('prospect',jsonb_build_object('id',p.id,'name',p.name,'phone',p.phone,'version',p.version));
 elsif p_action='list' then
  return jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(x)) from (
   select job.*,prospect.name as prospect_name from helios.outreach_jobs job join helios.prospects prospect on prospect.id=job.prospect_id
   order by job.created_at desc,job.id limit least(100,greatest(1,coalesce((p_payload->>'limit')::int,50)))
   offset greatest(0,coalesce((p_payload->>'offset')::int,0))
  ) x),'[]'::jsonb),'total',(select count(*) from helios.outreach_jobs));
 elsif p_action='create' then
  select * into p from helios.prospects where id=p_payload->>'prospect_id' for update;
  if not found then return jsonb_build_object('error','not_found');end if;
  select * into j from helios.outreach_jobs where id=(p_payload->>'id')::uuid;
  if found then
   if j.prospect_id is distinct from p.id or j.message_text is distinct from p_payload->>'message_text'
    or j.template_version is distinct from p_payload->>'template_version'
    or j.owner_name is distinct from nullif(p_payload->>'owner_name','') then
    return jsonb_build_object('error','request_conflict');
   end if;
   return jsonb_build_object('job',to_jsonb(j),'already_exists',true);
  end if;
  if p.version is distinct from (p_payload->>'prospect_version')::int then return jsonb_build_object('error','version_conflict');end if;
  select * into j from helios.outreach_jobs where prospect_id=p.id and template_version=p_payload->>'template_version' and status in ('draft','reviewed');
  if found then return jsonb_build_object('job',to_jsonb(j),'already_exists',true);end if;
  if nullif(trim(p_payload->>'message_text'),'') is null or nullif(trim(p_payload->>'business_name'),'') is null
   or p_payload->>'template_version' is distinct from 'solar-introduction-v1' then
   return jsonb_build_object('error','invalid_request');
  end if;
  insert into helios.outreach_jobs(id,prospect_id,template_version,message_text,business_name,owner_name,recipient_snapshot,created_by)
  values((p_payload->>'id')::uuid,p.id,p_payload->>'template_version',p_payload->>'message_text',p_payload->>'business_name',nullif(p_payload->>'owner_name',''),p.phone,actor)
  returning * into j;
  return jsonb_build_object('job',to_jsonb(j),'already_exists',false);
 elsif p_action in ('review','cancel') then
  select * into j from helios.outreach_jobs where id=(p_payload->>'id')::uuid for update;
  if not found then return jsonb_build_object('error','not_found');end if;
  if j.version is distinct from (p_payload->>'version')::int then return jsonb_build_object('error','version_conflict');end if;
  if j.status='cancelled' then return jsonb_build_object('error','invalid_transition');end if;
  if p_action='review' and j.status<>'draft' then return jsonb_build_object('error','invalid_transition');end if;
  update helios.outreach_jobs set status=case when p_action='review' then 'reviewed' else 'cancelled' end,
   reviewed_by=case when p_action='review' then actor else reviewed_by end,
   reviewed_at=case when p_action='review' then now() else reviewed_at end,
   version=version+1,updated_at=now() where id=j.id returning * into j;
  return jsonb_build_object('job',to_jsonb(j));
 end if;
 return jsonb_build_object('error','invalid_action');
end $$;
revoke all on function public.helios_outreach(text,jsonb) from public,anon,authenticated;
grant execute on function public.helios_outreach(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
