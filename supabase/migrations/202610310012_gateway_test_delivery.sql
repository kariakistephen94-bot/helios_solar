-- Linked-device gateway text delivery: authorized Stephen test numbers only.
-- Earlier Meta attempts remain unchanged in their original table.
begin;
create table if not exists helios.gateway_test_deliveries (
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null unique references helios.outreach_jobs(id),
 recipient text not null unique,
 execution_id text not null,
 lead_id uuid not null references public.leads(id),
 message_text text not null,
 status text not null default 'reserved' check(status in ('reserved','accepted','failed','unknown')),
 message_id text unique,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table helios.gateway_test_deliveries enable row level security;
revoke all on helios.gateway_test_deliveries from public,anon,authenticated;

create or replace function public.helios_gateway_test_delivery(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare job helios.outreach_jobs; attempt helios.gateway_test_deliveries;
 prospect helios.prospects; customer public.leads; digits text; last_message timestamptz;
 greeting text; local_hour int; content text; outcome text;
begin
 if p_action='claim' then
  if nullif(trim(p_payload->>'execution_id'),'') is null or length(p_payload->>'execution_id')>100 then
   return jsonb_build_object('can_send',false,'status','invalid_request');end if;
  select * into job from helios.outreach_jobs where id=(p_payload->>'job_id')::uuid for update;
  if not found then return jsonb_build_object('can_send',false,'status','not_found');end if;
  if job.status not in ('queued','reviewed') then return jsonb_build_object('can_send',false,'status','not_ready');end if;
  digits:=regexp_replace(coalesce(job.recipient_snapshot,''),'[^0-9]','','g');
  if digits not in ('2348107920394','2349138314501') then
   return jsonb_build_object('can_send',false,'status','not_a_test_number');end if;
  perform pg_advisory_xact_lock(hashtextextended('helios:gateway-test-delivery:'||digits,0));
  select * into prospect from helios.prospects where id=job.prospect_id;
  if not found then return jsonb_build_object('can_send',false,'status','prospect_missing');end if;
  if prospect.stage not in ('New prospect','Qualified') then return jsonb_build_object('can_send',false,'status','prospect_closed');end if;
  if regexp_replace(coalesce(prospect.phone,''),'[^0-9]','','g') not in (digits,'0'||substring(digits from 4)) then
   return jsonb_build_object('can_send',false,'status','recipient_changed');end if;
  if exists(select 1 from public.leads l where (l.whatsapp_id=digits or regexp_replace(coalesce(l.phone,''),'[^0-9]','','g')=digits) and (l.opted_out or l.followup_blocked)) then
   return jsonb_build_object('can_send',false,'status','contact_blocked');end if;
  select * into customer from public.leads where whatsapp_id=digits for update;
  if not found then return jsonb_build_object('can_send',false,'status','lead_missing');end if;
  if exists(select 1 from helios.gateway_test_deliveries d where d.recipient=digits or d.job_id=job.id) then
   return jsonb_build_object('can_send',false,'status','already_reserved',
    'reason','A test send has already been reserved. Do not retry automatically.');end if;
  -- Refresh the greeting at claim time, using Nigeria time and no AI calls.
  local_hour:=extract(hour from now() at time zone 'Africa/Lagos');
  greeting:='Hello, good '||case when local_hour<12 then 'morning' when local_hour<17 then 'afternoon' else 'evening' end||'.';
  content:=regexp_replace(job.message_text,'^Hello, good (morning|afternoon|evening)\.',greeting);
  if nullif(trim(content),'') is null then return jsonb_build_object('can_send',false,'status','missing_message_text');end if;
  insert into helios.gateway_test_deliveries(job_id,recipient,execution_id,lead_id,message_text)
   values(job.id,digits,p_payload->>'execution_id',customer.id,content) returning * into attempt;
  return jsonb_build_object('success',true,'can_send',true,'dry_run',false,'status','reserved',
   'job_id',job.id,'claim_id',attempt.id,'recipient',digits,'message_type','text',
   'provider','linked_gateway','message_text',content);
 elsif p_action='result' then
  select * into attempt from helios.gateway_test_deliveries where id=(p_payload->>'claim_id')::uuid for update;
  if not found then return jsonb_build_object('success',false,'status','not_found');end if;
  if attempt.execution_id is distinct from p_payload->>'execution_id' then return jsonb_build_object('success',false,'status','execution_mismatch');end if;
  outcome:=p_payload->>'outcome';
  if outcome not in ('accepted','failed','unknown') or outcome is null then return jsonb_build_object('success',false,'status','invalid_result');end if;
  if outcome='accepted' and (p_payload->>'message_id' is null or p_payload->>'message_id' !~ '^[A-Za-z0-9_-]{8,200}$') then
   return jsonb_build_object('success',false,'status','missing_message_id');end if;
  if attempt.status<>'reserved' then
   return jsonb_build_object('success',attempt.status=outcome and (outcome<>'accepted' or attempt.message_id=p_payload->>'message_id'),'status',attempt.status);
  end if;
  if outcome='accepted' then
   insert into public.messages(lead_id,channel,direction,message_id,message_type,message_text,business_phone_id,message_at)
    values(attempt.lead_id,'whatsapp','outbound',p_payload->>'message_id','text',attempt.message_text,'linked_gateway',now())
    on conflict(channel,message_id) do nothing;
   update public.leads set last_outbound_at=greatest(coalesce(last_outbound_at,now()),now()) where id=attempt.lead_id;
  end if;
  update helios.gateway_test_deliveries set status=outcome,message_id=case when outcome='accepted' then p_payload->>'message_id' else null end,updated_at=now() where id=attempt.id;
  update helios.outreach_jobs set queue_reason=case outcome when 'accepted' then 'Gateway accepted the test message. Delivery not confirmed.' when 'failed' then 'Test send failed. Automatic retry blocked.' else 'Test send outcome uncertain. Automatic retry blocked.' end,updated_at=now() where id=attempt.job_id;
  return jsonb_build_object('success',true,'status',outcome);
 end if;
 return jsonb_build_object('success',false,'status','invalid_action');
end $$;
revoke all on function public.helios_gateway_test_delivery(text,jsonb) from public,anon,authenticated;
grant execute on function public.helios_gateway_test_delivery(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
