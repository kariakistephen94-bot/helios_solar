-- Durable gateway receipts. Independent from inbound conversation messages.
begin;
create table if not exists helios.gateway_receipt_events (
 event_id text primary key,sender text not null,recipient text not null,message_id text not null,
 status text not null check(status in ('sent','delivered','read','failed')),
 occurred_at timestamptz not null,timestamp_source text not null check(timestamp_source in ('provider','observed')),
 received_at timestamptz not null default now()
);
create table if not exists helios.gateway_message_receipts (
 sender text not null,message_id text not null,recipient text not null,
 best_rank integer not null default 0 check(best_rank between 0 and 3),
 failed boolean not null default false,
 sent_at timestamptz,delivered_at timestamptz,read_at timestamptz,failed_at timestamptz,
 sent_source text,delivered_source text,read_source text,failed_source text,
 updated_at timestamptz not null default now(),primary key(sender,message_id)
);
alter table helios.gateway_receipt_events enable row level security;
alter table helios.gateway_message_receipts enable row level security;
revoke all on helios.gateway_receipt_events,helios.gateway_message_receipts from public,anon,authenticated;
create or replace function public.helios_gateway_receipt(p_event jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare previous helios.gateway_receipt_events; state helios.gateway_message_receipts; stamp timestamptz;
begin
 if coalesce(p_event->>'status','') not in ('sent','delivered','read','failed') or coalesce(p_event->>'timestamp_source','') not in ('provider','observed')
  or p_event->>'sender' is distinct from '2348107920394' or nullif(p_event->>'event_id','') is null
  or nullif(p_event->>'message_id','') is null or coalesce(p_event->>'recipient','') !~ '^[1-9][0-9]{6,14}$' then
  return jsonb_build_object('error','invalid_event');end if;
 stamp:=(p_event->>'occurred_at')::timestamptz;
 if stamp is null or stamp<'2015-01-01Z'::timestamptz or stamp>now()+interval '5 minutes' then return jsonb_build_object('error','invalid_timestamp');end if;
 perform pg_advisory_xact_lock(hashtextextended('helios:receipt:'||(p_event->>'sender')||':'||(p_event->>'message_id'),0));
 select * into previous from helios.gateway_receipt_events where event_id=p_event->>'event_id';
 if found then
  if previous.sender is distinct from p_event->>'sender' or previous.recipient is distinct from p_event->>'recipient'
   or previous.message_id is distinct from p_event->>'message_id' or previous.status is distinct from p_event->>'status'
   or previous.occurred_at is distinct from stamp or previous.timestamp_source is distinct from p_event->>'timestamp_source' then
   return jsonb_build_object('error','event_conflict');end if;
  return jsonb_build_object('accepted',true,'duplicate',true);
 end if;
 insert into helios.gateway_message_receipts(sender,message_id,recipient)
 values(p_event->>'sender',p_event->>'message_id',p_event->>'recipient') on conflict do nothing;
 select * into state from helios.gateway_message_receipts where sender=p_event->>'sender' and message_id=p_event->>'message_id' for update;
 if state.recipient is distinct from p_event->>'recipient' then return jsonb_build_object('error','recipient_conflict');end if;
 insert into helios.gateway_receipt_events(event_id,sender,recipient,message_id,status,occurred_at,timestamp_source)
 values(p_event->>'event_id',p_event->>'sender',p_event->>'recipient',p_event->>'message_id',p_event->>'status',stamp,p_event->>'timestamp_source');
 update helios.gateway_message_receipts set
  best_rank=greatest(best_rank,case p_event->>'status' when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end),
  failed=case when p_event->>'status' in ('delivered','read') then false when p_event->>'status'='failed' and best_rank<2 then true else failed end,
  sent_at=case when p_event->>'status'='sent' then stamp else sent_at end,
  delivered_at=case when p_event->>'status'='delivered' then stamp else delivered_at end,
  read_at=case when p_event->>'status'='read' then stamp else read_at end,
  failed_at=case when p_event->>'status'='failed' then stamp else failed_at end,
  sent_source=case when p_event->>'status'='sent' then p_event->>'timestamp_source' else sent_source end,
  delivered_source=case when p_event->>'status'='delivered' then p_event->>'timestamp_source' else delivered_source end,
  read_source=case when p_event->>'status'='read' then p_event->>'timestamp_source' else read_source end,
  failed_source=case when p_event->>'status'='failed' then p_event->>'timestamp_source' else failed_source end,
  updated_at=now()
 where sender=state.sender and message_id=state.message_id;
 return jsonb_build_object('accepted',true,'duplicate',false);
end $$;
revoke all on function public.helios_gateway_receipt(jsonb) from public,anon,authenticated;
grant execute on function public.helios_gateway_receipt(jsonb) to service_role;

create index if not exists gateway_reply_lookup on public.messages(lead_id,message_at)
 where channel='whatsapp' and direction='inbound' and business_phone_id='linked_gateway';
create or replace function public.helios_outreach_activity(p_actor uuid,p_status text default 'all',p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.staff_members where user_id=p_actor) then return jsonb_build_object('error','staff_required');end if;
 if p_status not in ('all','accepted','failed','unknown','reserved','replied','delivered','read') or p_status is null then return jsonb_build_object('error','invalid_status');end if;
 with snapshots as (
  select d.id as claim_id,d.execution_id,d.job_id,d.recipient,d.status,d.message_id,d.updated_at as attempted_at,null::text as detail,2 as priority
  from helios.gateway_test_deliveries d
  union all
  select a.claim_id,a.previous_attempt->>'execution_id',(a.previous_attempt->>'job_id')::uuid,
   a.previous_attempt->>'recipient',case when a.event='confirmed_401_retry_authorized' then 'failed' else a.previous_attempt->>'status' end,
   a.previous_attempt->>'message_id',a.created_at,
   case when a.event='confirmed_401_retry_authorized' then 'HTTP 401: gateway authentication rejected.' else 'Previous attempt before an authorized retry.' end,1
  from helios.gateway_retry_audit a where a.event in ('confirmed_401_retry_authorized','authorized_retry_claimed')
 ), raw_attempts as (
  select distinct on (claim_id,execution_id) * from snapshots order by claim_id,execution_id,priority desc,attempted_at desc
 ), attempts as (
  select a.claim_id,a.execution_id,a.job_id,a.recipient,
   case when a.status='accepted' and s.failed and s.best_rank<2 then 'failed' else a.status end as status,
   a.message_id,a.attempted_at,
   case when a.status='accepted' and s.failed and s.best_rank<2 then 'WhatsApp reported an explicit send failure.' else a.detail end as detail,
   a.priority,coalesce(s.best_rank,0) as best_rank,s.delivered_at,s.read_at,s.delivered_source,s.read_source
  from raw_attempts a left join helios.gateway_message_receipts s
   on s.sender='2348107920394' and s.message_id=a.message_id and s.recipient=a.recipient
 ), sent_cohort as (
  select d.recipient,d.lead_id,min(coalesce(m.message_at,d.updated_at)) as first_sent
  from helios.gateway_test_deliveries d left join public.messages m
   on m.channel='whatsapp' and m.direction='outbound' and m.business_phone_id='linked_gateway'
   and m.message_id=d.message_id and m.lead_id=d.lead_id
  left join helios.gateway_message_receipts s on s.sender='2348107920394' and s.message_id=d.message_id and s.recipient=d.recipient
  where d.status='accepted' and not coalesce(s.failed and s.best_rank<2,false) group by d.recipient,d.lead_id
 ), contacts as (
  select recipient,min(first_sent) as first_sent,(array_agg(lead_id order by first_sent desc))[1] as lead_id
  from sent_cohort group by recipient
 ), reply_messages as (
  select distinct c.recipient,m.id,m.message_at,m.message_text
  from sent_cohort c join public.messages m on m.lead_id=c.lead_id
   and m.channel='whatsapp' and m.direction='inbound' and m.business_phone_id='linked_gateway'
   and m.message_at>c.first_sent
 ), replied as (
  select recipient,min(message_at) as first_reply,max(message_at) as last_reply,count(*) as message_count,
   (array_agg(left(message_text,160) order by message_at desc,id desc))[1] as preview
  from reply_messages group by recipient
 ), display_rows as (
  select a.status,a.attempted_at as sort_at,a.claim_id::text||':'||a.execution_id as sort_id,
   jsonb_build_object('id',a.claim_id::text||':'||a.execution_id,'phone','+'||a.recipient,
    'name',coalesce(p.name,'Saved contact'),'status',case when a.status='accepted' and a.best_rank>=3 then 'read'
     when a.status='accepted' and a.best_rank>=2 then 'delivered' else a.status end,'message_id',a.message_id,
    'delivered_at',a.delivered_at,'read_at',a.read_at,'delivered_source',a.delivered_source,'read_source',a.read_source,
    'attempted_at',a.attempted_at,'detail',a.detail) as item
  from attempts a left join helios.outreach_jobs j on j.id=a.job_id left join helios.prospects p on p.id=j.prospect_id
  where p_status='all' or a.status=p_status or (p_status='delivered' and a.status='accepted' and a.best_rank>=2) or (p_status='read' and a.status='accepted' and a.best_rank>=3)
  union all
  select 'replied',r.last_reply,'reply:'||r.recipient,
   jsonb_build_object('id','reply:'||r.recipient,'phone','+'||r.recipient,
    'name',coalesce(l.name,l.profile_name,'Saved contact'),'status','replied',
    'lead_id',c.lead_id,'attempted_at',c.first_sent,'replied_at',r.first_reply,'last_reply_at',r.last_reply,
    'reply_count',r.message_count,'reply_preview',r.preview,'detail',null)
  from replied r join contacts c on c.recipient=r.recipient left join public.leads l on l.id=c.lead_id
  where p_status='replied'
 ), page as (
  select * from display_rows order by sort_at desc,sort_id
  limit least(100,greatest(1,coalesce(p_limit,20))) offset least(100000,greatest(0,coalesce(p_offset,0)))
 )
 select jsonb_build_object('summary',
  (select jsonb_build_object('sent',count(*) filter(where status='accepted'),'failed',count(*) filter(where status='failed'),
   'completed',count(*) filter(where status in ('accepted','failed')),'uncertain',count(*) filter(where status='unknown'),
   'pending',count(*) filter(where status='reserved'),'attempts',count(*),
   'delivered',count(*) filter(where status='accepted' and best_rank>=2),'read',count(*) filter(where status='accepted' and best_rank>=3),
   'contacted_leads',(select count(*) from contacts),'replied_leads',(select count(*) from replied),
   'reply_rate',case when (select count(*) from contacts)=0 then null else
    round(100.0*(select count(*) from replied)/(select count(*) from contacts),1) end) from attempts),
  'total',(select count(*) from display_rows),'items',coalesce((select jsonb_agg(item) from page),'[]'::jsonb),
  'scope','All recorded linked-gateway outreach attempts and post-outreach replies.',
  'sent_definition','Sent means accepted for sending. Delivered and Read require WhatsApp receipts; a missing receipt is unknown, not failure.',
  'reply_definition','Unique recipients with saved inbound gateway messages after accepted outreach; includes automated replies until classified.'
 ) into result;
 return result;
end $$;
revoke all on function public.helios_outreach_activity(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.helios_outreach_activity(uuid,text,integer,integer) to service_role;
notify pgrst,'reload schema';
commit;
