-- Approved hello_world template test only. Restricted to Stephen's two numbers.
-- Replaces the earlier plain-text test; no recent inbound message is required.
begin;
create table if not exists helios.outreach_test_deliveries (
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
alter table helios.outreach_test_deliveries add column if not exists template_name text;
alter table helios.outreach_test_deliveries add column if not exists template_language text;
alter table helios.outreach_test_deliveries enable row level security;
revoke all on helios.outreach_test_deliveries from public,anon,authenticated;

create or replace function public.helios_outreach_test_delivery(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare job helios.outreach_jobs; attempt helios.outreach_test_deliveries;
 prospect helios.prospects; customer public.leads; digits text; last_message timestamptz;
 greeting text; local_hour int; content text; outcome text;
begin
 if p_action='claim' then
  if p_payload->>'template_name' is distinct from 'hello_world' or p_payload->>'template_language' is distinct from 'en_US' then
   return jsonb_build_object('can_send',false,'status','unsupported_test_template');end if;
  if nullif(trim(p_payload->>'execution_id'),'') is null or length(p_payload->>'execution_id')>100 then
   return jsonb_build_object('can_send',false,'status','invalid_request');end if;
  select * into job from helios.outreach_jobs where id=(p_payload->>'job_id')::uuid for update;
  if not found then return jsonb_build_object('can_send',false,'status','not_found');end if;
  if job.status not in ('queued','reviewed') then return jsonb_build_object('can_send',false,'status','not_ready');end if;
  digits:=regexp_replace(coalesce(job.recipient_snapshot,''),'[^0-9]','','g');
  if digits not in ('2348107920394','2349138314501') then
   return jsonb_build_object('can_send',false,'status','not_a_test_number');end if;
  perform pg_advisory_xact_lock(hashtextextended('helios:test-delivery:'||digits,0));
  select * into prospect from helios.prospects where id=job.prospect_id;
  if not found then return jsonb_build_object('can_send',false,'status','prospect_missing');end if;
  if prospect.stage not in ('New prospect','Qualified') then return jsonb_build_object('can_send',false,'status','prospect_closed');end if;
  if regexp_replace(coalesce(prospect.phone,''),'[^0-9]','','g') not in (digits,'0'||substring(digits from 4)) then
   return jsonb_build_object('can_send',false,'status','recipient_changed');end if;
  if exists(select 1 from public.leads l where (l.whatsapp_id=digits or regexp_replace(coalesce(l.phone,''),'[^0-9]','','g')=digits) and (l.opted_out or l.followup_blocked)) then
   return jsonb_build_object('can_send',false,'status','contact_blocked');end if;
  select * into customer from public.leads where whatsapp_id=digits for update;
  if not found then return jsonb_build_object('can_send',false,'status','lead_missing');end if;
  if exists(select 1 from helios.outreach_test_deliveries d where d.recipient=digits or d.job_id=job.id) then
   return jsonb_build_object('can_send',false,'status','already_reserved',
    'reason','A test send has already been reserved. Do not retry automatically.');end if;
  -- Save what was actually sent, not the unrelated solar-introduction text.
  content:='[WhatsApp template: hello_world; language: en_US; no parameters]';
  insert into helios.outreach_test_deliveries(job_id,recipient,execution_id,lead_id,message_text,template_name,template_language)
   values(job.id,digits,p_payload->>'execution_id',customer.id,content,'hello_world','en_US') returning * into attempt;
  return jsonb_build_object('success',true,'can_send',true,'dry_run',false,'status','reserved',
   'job_id',job.id,'claim_id',attempt.id,'recipient',digits,'message_type','template',
   'template_name','hello_world','template_language','en_US');
 elsif p_action='result' then
  select * into attempt from helios.outreach_test_deliveries where id=(p_payload->>'claim_id')::uuid for update;
  if not found then return jsonb_build_object('success',false,'status','not_found');end if;
  if attempt.execution_id is distinct from p_payload->>'execution_id' then return jsonb_build_object('success',false,'status','execution_mismatch');end if;
  outcome:=p_payload->>'outcome';
  if outcome not in ('accepted','failed','unknown') or outcome is null then return jsonb_build_object('success',false,'status','invalid_result');end if;
  if outcome='accepted' and (p_payload->>'message_id' is null or p_payload->>'message_id' not like 'wamid.%') then
   return jsonb_build_object('success',false,'status','missing_message_id');end if;
  if attempt.status<>'reserved' then
   return jsonb_build_object('success',attempt.status=outcome and (outcome<>'accepted' or attempt.message_id=p_payload->>'message_id'),'status',attempt.status);
  end if;
  if outcome='accepted' then
   insert into public.messages(lead_id,channel,direction,message_id,message_type,message_text,business_phone_id,message_at)
    values(attempt.lead_id,'whatsapp','outbound',p_payload->>'message_id','template',attempt.message_text,'1291493224058562',now())
    on conflict(channel,message_id) do nothing;
   update public.leads set last_outbound_at=greatest(coalesce(last_outbound_at,now()),now()) where id=attempt.lead_id;
  end if;
  update helios.outreach_test_deliveries set status=outcome,message_id=case when outcome='accepted' then p_payload->>'message_id' else null end,updated_at=now() where id=attempt.id;
  update helios.outreach_jobs set queue_reason=case outcome when 'accepted' then 'Test message accepted by WhatsApp. Delivery not yet confirmed.' when 'failed' then 'Test send failed. Automatic retry blocked.' else 'Test send outcome uncertain. Automatic retry blocked.' end,updated_at=now() where id=attempt.job_id;
  return jsonb_build_object('success',true,'status',outcome);
 end if;
 return jsonb_build_object('success',false,'status','invalid_action');
end $$;
revoke all on function public.helios_outreach_test_delivery(text,jsonb) from public,anon,authenticated;
grant execute on function public.helios_outreach_test_delivery(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
