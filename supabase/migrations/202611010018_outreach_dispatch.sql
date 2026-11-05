-- Paced outreach dispatch. Additive and rerunnable; no existing row is changed.
-- Everything is OFF by default: nothing dispatches until staff enable it, and real (non-test)
-- recipients stay blocked until live_recipients is switched on separately.
begin;

create table if not exists helios.outreach_dispatch_control (
 id integer primary key check (id=1),
 enabled boolean not null default false,
 live_recipients boolean not null default false,
 daily_cap integer not null default 20 check (daily_cap between 1 and 100),
 min_gap_seconds integer not null default 600 check (min_gap_seconds between 60 and 86400),
 max_gap_seconds integer not null default 1500 check (max_gap_seconds between 60 and 86400),
 window_start_hour integer not null default 9 check (window_start_hour between 0 and 23),
 window_end_hour integer not null default 17 check (window_end_hour between 1 and 24),
 weekdays_only boolean not null default true,
 next_dispatch_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (max_gap_seconds>=min_gap_seconds),
 check (window_end_hour>window_start_hour)
);
insert into helios.outreach_dispatch_control(id) values (1) on conflict (id) do nothing;
alter table helios.outreach_dispatch_control enable row level security;
revoke all on helios.outreach_dispatch_control from public,anon,authenticated;

alter table helios.outreach_jobs add column if not exists dispatched_at timestamptz;
alter table helios.outreach_jobs add column if not exists dispatch_attempts integer not null default 0;
create index if not exists outreach_jobs_dispatch_idx on helios.outreach_jobs (created_at)
 where dispatched_at is null and status='queued';

create or replace function public.helios_outreach_dispatch(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare c helios.outreach_dispatch_control; job helios.outreach_jobs; t timestamptz:=now();
 local_ts timestamp; hr numeric; day_start timestamptz; sent_today integer; queued integer; gap integer;
 state text; digits text; staff boolean;
begin
 select * into c from helios.outreach_dispatch_control where id=1 for update;
 local_ts:=t at time zone 'Africa/Lagos';
 hr:=extract(hour from local_ts)+extract(minute from local_ts)/60.0;
 day_start:=date_trunc('day',local_ts) at time zone 'Africa/Lagos';
 select count(*)::int into sent_today from helios.outreach_jobs where dispatched_at>=day_start;

 if p_action in ('status','configure') then
  select exists(select 1 from public.staff_members where user_id::text=p_payload->>'actor') into staff;
  if not staff then return jsonb_build_object('error','staff_required');end if;
  if p_action='configure' then
   update helios.outreach_dispatch_control set
    enabled=coalesce((p_payload->>'enabled')::boolean,enabled),
    live_recipients=coalesce((p_payload->>'live_recipients')::boolean,live_recipients),
    next_dispatch_at=case when coalesce((p_payload->>'enabled')::boolean,false) and not enabled
     then t+interval '1 minute' else next_dispatch_at end,
    updated_at=t where id=1 returning * into c;
  end if;
  select count(*)::int into queued from helios.outreach_jobs
   where status='queued' and dispatched_at is null and recipient_snapshot is not null;
  state:=case when not c.enabled then 'disabled'
   when (c.weekdays_only and extract(isodow from local_ts)>5) or hr<c.window_start_hour or hr>=c.window_end_hour then 'outside_hours'
   when sent_today>=c.daily_cap then 'daily_cap_reached'
   when t<c.next_dispatch_at then 'waiting' else 'ready' end;
  return jsonb_build_object('enabled',c.enabled,'live_recipients',c.live_recipients,'state',state,
   'daily_cap',c.daily_cap,'dispatched_today',sent_today,'queued',queued,
   'min_gap_seconds',c.min_gap_seconds,'max_gap_seconds',c.max_gap_seconds,
   'window_start_hour',c.window_start_hour,'window_end_hour',c.window_end_hour,'weekdays_only',c.weekdays_only,
   'next_dispatch_at',extract(epoch from c.next_dispatch_at)::bigint,'timezone','Africa/Lagos');

 elsif p_action='next' then
  if not c.enabled then return jsonb_build_object('dispatch',false,'reason','disabled');end if;
  if (c.weekdays_only and extract(isodow from local_ts)>5) or hr<c.window_start_hour or hr>=c.window_end_hour then
   return jsonb_build_object('dispatch',false,'reason','outside_hours');end if;
  if sent_today>=c.daily_cap then return jsonb_build_object('dispatch',false,'reason','daily_cap_reached');end if;
  if t<c.next_dispatch_at then return jsonb_build_object('dispatch',false,'reason','waiting');end if;
  select * into job from helios.outreach_jobs j
   where j.status='queued' and j.automatic and j.dispatched_at is null and j.recipient_snapshot is not null
    and (c.live_recipients or regexp_replace(j.recipient_snapshot,'[^0-9]','','g') in ('2348107920394','2349138314501'))
    and not exists(select 1 from public.leads l
     where (l.whatsapp_id=regexp_replace(j.recipient_snapshot,'[^0-9]','','g')
      or regexp_replace(coalesce(l.phone,''),'[^0-9]','','g')=regexp_replace(j.recipient_snapshot,'[^0-9]','','g'))
      and (l.opted_out or l.followup_blocked))
   order by j.created_at,j.id for update skip locked limit 1;
  if not found then return jsonb_build_object('dispatch',false,'reason','nothing_queued');end if;
  -- A random gap per message keeps sends spread out and irregular.
  gap:=c.min_gap_seconds+floor(random()*(c.max_gap_seconds-c.min_gap_seconds+1))::int;
  update helios.outreach_jobs set dispatched_at=t,dispatch_attempts=dispatch_attempts+1 where id=job.id;
  update helios.outreach_dispatch_control set next_dispatch_at=t+make_interval(secs=>gap) where id=1;
  return jsonb_build_object('dispatch',true,'job_id',job.id,'next_gap_seconds',gap);

 elsif p_action='release' then
  -- The n8n webhook did not accept the job. Only unclaimed jobs are released; a job that already
  -- has a delivery reservation is never re-dispatched, so a timeout cannot cause a duplicate send.
  select * into job from helios.outreach_jobs where id=(p_payload->>'job_id')::uuid for update;
  if not found then return jsonb_build_object('released',false);end if;
  if exists(select 1 from helios.gateway_test_deliveries d where d.job_id=job.id) then
   return jsonb_build_object('released',false,'reason','already_claimed');end if;
  update helios.outreach_jobs set dispatched_at=null,
   status=case when dispatch_attempts>=5 then 'needs_review' else status end,
   queue_reason=case when dispatch_attempts>=5 then 'Could not reach the n8n outreach workflow after 5 tries.' else queue_reason end
   where id=job.id;
  update helios.outreach_dispatch_control set next_dispatch_at=greatest(next_dispatch_at,t+interval '5 minutes') where id=1;
  return jsonb_build_object('released',true);
 end if;
 return jsonb_build_object('error','invalid_action');
end $$;
revoke all on function public.helios_outreach_dispatch(text,jsonb) from public,anon,authenticated;
grant execute on function public.helios_outreach_dispatch(text,jsonb) to service_role;

-- Claim for jobs the dispatcher sent to n8n. Jobs that were never dispatched return use_test_path,
-- so the existing allowlisted test claim keeps working unchanged.
create or replace function public.helios_outreach_live_claim(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare c helios.outreach_dispatch_control; job helios.outreach_jobs; prospect helios.prospects;
 customer public.leads; attempt helios.gateway_test_deliveries; digits text; local_ts timestamp; hr numeric;
 greeting text; content text; local_hour int;
begin
 if nullif(trim(p_payload->>'execution_id'),'') is null or length(p_payload->>'execution_id')>100 then
  return jsonb_build_object('can_send',false,'status','invalid_request');end if;
 select * into job from helios.outreach_jobs where id=(p_payload->>'job_id')::uuid for update;
 if not found then return jsonb_build_object('can_send',false,'status','not_found');end if;
 if job.dispatched_at is null then return jsonb_build_object('status','use_test_path');end if;
 select * into c from helios.outreach_dispatch_control where id=1;
 if not c.enabled then return jsonb_build_object('can_send',false,'status','dispatch_paused');end if;
 if job.status<>'queued' then return jsonb_build_object('can_send',false,'status','not_ready');end if;
 digits:=regexp_replace(coalesce(job.recipient_snapshot,''),'[^0-9]','','g');
 if digits !~ '^[1-9][0-9]{7,14}$' then return jsonb_build_object('can_send',false,'status','invalid_recipient');end if;
 if not c.live_recipients and digits not in ('2348107920394','2349138314501') then
  return jsonb_build_object('can_send',false,'status','live_recipients_disabled');end if;
 local_ts:=now() at time zone 'Africa/Lagos';
 hr:=extract(hour from local_ts)+extract(minute from local_ts)/60.0;
 if (c.weekdays_only and extract(isodow from local_ts)>5) or hr<c.window_start_hour or hr>=c.window_end_hour then
  return jsonb_build_object('can_send',false,'status','outside_hours');end if;
 perform pg_advisory_xact_lock(hashtextextended('helios:gateway-test-delivery:'||digits,0));
 select * into prospect from helios.prospects where id=job.prospect_id;
 if not found then return jsonb_build_object('can_send',false,'status','prospect_missing');end if;
 if prospect.stage not in ('New prospect','Qualified') then return jsonb_build_object('can_send',false,'status','prospect_closed');end if;
 if regexp_replace(coalesce(prospect.phone,''),'[^0-9]','','g') not in (digits,'0'||substring(digits from 4)) then
  return jsonb_build_object('can_send',false,'status','recipient_changed');end if;
 if exists(select 1 from public.leads l where (l.whatsapp_id=digits or regexp_replace(coalesce(l.phone,''),'[^0-9]','','g')=digits)
  and (l.opted_out or l.followup_blocked)) then
  return jsonb_build_object('can_send',false,'status','contact_blocked');end if;
 select * into attempt from helios.gateway_test_deliveries d where d.recipient=digits or d.job_id=job.id for update;
 if found and not (attempt.status='failed' and attempt.retry_authorized) then
  return jsonb_build_object('can_send',false,'status','already_reserved',
   'reason','A send has already been reserved for this recipient. Do not retry automatically.');end if;
 select * into customer from public.leads where whatsapp_id=digits for update;
 if not found then
  -- Replies from this business are matched to the lead through its WhatsApp number.
  insert into public.leads(whatsapp_id,profile_name,phone,source,notes)
   values(digits,left(prospect.name,200),'+'||digits,'whatsapp','Outbound prospect: '||left(prospect.name,200))
   returning * into customer;
 end if;
 local_hour:=extract(hour from local_ts);
 greeting:='Hello, good '||case when local_hour<12 then 'morning' when local_hour<17 then 'afternoon' else 'evening' end||'.';
 content:=regexp_replace(job.message_text,'^Hello, good (morning|afternoon|evening)\.',greeting);
 if nullif(trim(content),'') is null then return jsonb_build_object('can_send',false,'status','missing_message_text');end if;
 if attempt.id is not null then
  insert into helios.gateway_retry_audit(claim_id,event,previous_attempt) values(attempt.id,'authorized_retry_claimed',to_jsonb(attempt));
  update helios.gateway_test_deliveries set execution_id=p_payload->>'execution_id',status='reserved',message_text=content,
   message_id=null,retry_authorized=false,retry_count=retry_count+1,updated_at=now() where id=attempt.id returning * into attempt;
 else
  insert into helios.gateway_test_deliveries(job_id,recipient,execution_id,lead_id,message_text)
   values(job.id,digits,p_payload->>'execution_id',customer.id,content) returning * into attempt;
 end if;
 return jsonb_build_object('success',true,'can_send',true,'dry_run',false,'status','reserved',
  'job_id',job.id,'claim_id',attempt.id,'recipient',digits,'message_type','text',
  'provider','linked_gateway','message_text',content);
end $$;
revoke all on function public.helios_outreach_live_claim(jsonb) from public,anon,authenticated;
grant execute on function public.helios_outreach_live_claim(jsonb) to service_role;

notify pgrst,'reload schema';
commit;
