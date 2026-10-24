-- Single-company workspace. Apply with the Supabase CLI or SQL editor.
create extension if not exists pgcrypto;
create table public.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);
alter table public.staff_members enable row level security;
create policy "Staff can see own membership" on public.staff_members for select to authenticated using (user_id=auth.uid());
create function public.is_staff() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.staff_members where user_id=auth.uid());
$$;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  request_id uuid unique not null,
  name text not null check(length(name) between 1 and 100),
  email text not null check(length(email)<=180),
  phone text not null check(length(phone) between 5 and 30),
  city text not null check(length(city) between 1 and 100),
  address text not null check(length(address) between 1 and 240),
  bill numeric not null check(bill>0 and bill<=10000),
  interest text not null check(interest in ('Home solar','Battery storage','Solar + battery')),
  notes text not null default '' check(length(notes)<=4000),
  consent boolean not null check(consent=true),
  stage text not null default 'New inquiry' check(stage in ('New inquiry','Qualified','Survey scheduled','Proposal sent','Won','Lost')),
  value numeric not null default 0 check(value>=0 and value<=1000000),
  survey_at timestamptz,
  ai_summary text,
  followup_draft text,
  source text not null default 'Website',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_created_idx on public.leads(created_at desc);
create index leads_stage_idx on public.leads(stage);
alter table public.leads enable row level security;
create policy "Staff read leads" on public.leads for select to authenticated using(public.is_staff());
create policy "Staff update leads" on public.leads for update to authenticated using(public.is_staff()) with check(public.is_staff());
revoke all on public.leads from anon, authenticated;
grant select on public.leads to authenticated;
grant update(stage,value,survey_at,notes) on public.leads to authenticated;
revoke all on public.staff_members from anon,authenticated;
grant select on public.staff_members to authenticated;

create table public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid unique not null references public.leads(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','processing','retry','completed','failed')),
  attempts integer not null default 0,
  lease_token uuid,
  locked_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index jobs_pending_idx on public.automation_jobs(status,next_attempt_at);
alter table public.automation_jobs enable row level security;
create policy "Staff see jobs" on public.automation_jobs for select to authenticated using(public.is_staff());
revoke all on public.automation_jobs from anon,authenticated;
grant select(id,lead_id,status,attempts,created_at,last_error) on public.automation_jobs to authenticated;

create table public.intake_limits (bucket text primary key, hits integer not null, expires_at timestamptz not null);
alter table public.intake_limits enable row level security;
revoke all on public.intake_limits from anon,authenticated;

create function public.enqueue_lead(p_request_id uuid,p_ip_hash text,p_payload jsonb) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_hits integer; v_bucket text;
begin
  select id into v_id from public.leads where request_id=p_request_id;
  if v_id is not null then return v_id; end if;
  v_bucket:=p_ip_hash||':'||to_char(now() at time zone 'UTC','YYYYMMDDHH24MI');
  insert into public.intake_limits(bucket,hits,expires_at) values(v_bucket,1,now()+interval '1 day')
    on conflict(bucket) do update set hits=intake_limits.hits+1 returning hits into v_hits;
  if v_hits>5 then raise exception 'rate_limit' using errcode='P0001'; end if;
  delete from public.intake_limits where expires_at<now();
  insert into public.leads(request_id,name,email,phone,city,address,bill,interest,notes,consent)
    values(p_request_id,p_payload->>'name',p_payload->>'email',p_payload->>'phone',p_payload->>'city',p_payload->>'address',(p_payload->>'bill')::numeric,p_payload->>'interest',coalesce(p_payload->>'notes',''),(p_payload->>'consent')::boolean)
    on conflict(request_id) do update set request_id=excluded.request_id returning id into v_id;
  insert into public.automation_jobs(lead_id) values(v_id) on conflict(lead_id) do nothing;
  return v_id;
end; $$;

-- Claim one job atomically. Expired leases can be retried; old workers cannot finish a new lease.
create function public.claim_qualification_job() returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_job public.automation_jobs; v_lead public.leads;
begin
  update public.automation_jobs set status='failed',last_error='Worker lease expired after maximum attempts',lease_token=null
    where status='processing' and locked_at<now()-interval '10 minutes' and attempts>=3;
  select * into v_job from public.automation_jobs
    where attempts<3 and ((status in ('pending','retry') and next_attempt_at<=now()) or (status='processing' and locked_at<now()-interval '10 minutes'))
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.automation_jobs set status='processing',attempts=attempts+1,locked_at=now(),lease_token=gen_random_uuid()
    where id=v_job.id returning * into v_job;
  select * into v_lead from public.leads where id=v_job.lead_id;
  return jsonb_build_object('job_id',v_job.id,'lease_token',v_job.lease_token,'lead',jsonb_build_object(
    'name',v_lead.name,'city',v_lead.city,'bill',v_lead.bill,'interest',v_lead.interest,'notes',v_lead.notes));
end; $$;

create function public.finish_qualification_job(p_job_id uuid,p_lease_token uuid,p_result jsonb default null,p_error text default null) returns boolean
language plpgsql security definer set search_path=public as $$
declare v_job public.automation_jobs;
begin
  select * into v_job from public.automation_jobs where id=p_job_id for update;
  if not found or v_job.status<>'processing' or v_job.lease_token is distinct from p_lease_token then return false; end if;
  if p_error is not null then
    update public.automation_jobs set status=case when attempts>=3 then 'failed' else 'retry' end,
      last_error=left(p_error,500),next_attempt_at=now()+interval '5 minutes',lease_token=null where id=p_job_id;
    return true;
  end if;
  if p_result is null or jsonb_typeof(p_result->'summary') is distinct from 'string'
    or jsonb_typeof(p_result->'followup_draft') is distinct from 'string'
    or length(p_result->>'summary') not between 1 and 4000
    or length(p_result->>'followup_draft') not between 1 and 4000 then
      raise exception 'Invalid qualification result';
  end if;
  update public.leads set ai_summary=p_result->>'summary',followup_draft=p_result->>'followup_draft',updated_at=now() where id=v_job.lead_id;
  update public.automation_jobs set status='completed',completed_at=now(),lease_token=null,last_error=null where id=p_job_id;
  return true;
end; $$;

-- A second workflow calls this for a staff operations digest. It sends no customer messages.
create function public.workspace_digest() returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object('generated_at',now(),
 'new_enquiries',(select count(*) from public.leads where stage='New inquiry'),
 'awaiting_briefs',(select count(*) from public.leads where ai_summary is null),
 'failed_jobs',(select count(*) from public.automation_jobs where status='failed'),
 'open_pipeline',(select coalesce(sum(value),0) from public.leads where stage not in ('Won','Lost')),
 'surveys_next_7_days',(select count(*) from public.leads where survey_at between now() and now()+interval '7 days' and stage<>'Lost'));
$$;
revoke all on function public.enqueue_lead(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.claim_qualification_job() from public,anon,authenticated;
revoke all on function public.finish_qualification_job(uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.workspace_digest() from public,anon,authenticated;
grant execute on function public.enqueue_lead(uuid,text,jsonb) to service_role;
grant execute on function public.claim_qualification_job() to service_role;
grant execute on function public.finish_qualification_job(uuid,uuid,jsonb,text) to service_role;
grant execute on function public.workspace_digest() to service_role;
grant all on public.leads,public.staff_members,public.automation_jobs,public.intake_limits to service_role;
