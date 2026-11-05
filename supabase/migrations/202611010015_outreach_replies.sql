-- Extend activity reporting with unique replied recipients and a sent-to-reply rate.
-- No customer data is rewritten; only saved linked-gateway inbound messages count.
begin;
create index if not exists gateway_reply_lookup on public.messages(lead_id,message_at)
 where channel='whatsapp' and direction='inbound' and business_phone_id='linked_gateway';
create or replace function public.helios_outreach_activity(p_actor uuid,p_status text default 'all',p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.staff_members where user_id=p_actor) then return jsonb_build_object('error','staff_required');end if;
 if p_status not in ('all','accepted','failed','unknown','reserved','replied') or p_status is null then return jsonb_build_object('error','invalid_status');end if;
 with snapshots as (
  select d.id as claim_id,d.execution_id,d.job_id,d.recipient,d.status,d.message_id,d.updated_at as attempted_at,null::text as detail,2 as priority
  from helios.gateway_test_deliveries d
  union all
  select a.claim_id,a.previous_attempt->>'execution_id',(a.previous_attempt->>'job_id')::uuid,
   a.previous_attempt->>'recipient',case when a.event='confirmed_401_retry_authorized' then 'failed' else a.previous_attempt->>'status' end,
   a.previous_attempt->>'message_id',a.created_at,
   case when a.event='confirmed_401_retry_authorized' then 'HTTP 401: gateway authentication rejected.' else 'Previous attempt before an authorized retry.' end,1
  from helios.gateway_retry_audit a where a.event in ('confirmed_401_retry_authorized','authorized_retry_claimed')
 ), attempts as (
  select distinct on (claim_id,execution_id) * from snapshots order by claim_id,execution_id,priority desc,attempted_at desc
 ), sent_cohort as (
  select d.recipient,d.lead_id,min(coalesce(m.message_at,d.updated_at)) as first_sent
  from helios.gateway_test_deliveries d left join public.messages m
   on m.channel='whatsapp' and m.direction='outbound' and m.business_phone_id='linked_gateway'
   and m.message_id=d.message_id and m.lead_id=d.lead_id
  where d.status='accepted' group by d.recipient,d.lead_id
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
    'name',coalesce(p.name,'Saved contact'),'status',a.status,'message_id',a.message_id,
    'attempted_at',a.attempted_at,'detail',a.detail) as item
  from attempts a left join helios.outreach_jobs j on j.id=a.job_id left join helios.prospects p on p.id=j.prospect_id
  where p_status='all' or a.status=p_status
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
   'contacted_leads',(select count(*) from contacts),'replied_leads',(select count(*) from replied),
   'reply_rate',case when (select count(*) from contacts)=0 then null else
    round(100.0*(select count(*) from replied)/(select count(*) from contacts),1) end) from attempts),
  'total',(select count(*) from display_rows),'items',coalesce((select jsonb_agg(item) from page),'[]'::jsonb),
  'scope','All recorded linked-gateway outreach attempts and post-outreach replies.',
  'sent_definition','Sent means accepted by the gateway. Delivery/read receipt reporting is separate.',
  'reply_definition','Unique recipients with saved inbound gateway messages after accepted outreach; includes automated replies until classified.'
 ) into result;
 return result;
end $$;
revoke all on function public.helios_outreach_activity(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.helios_outreach_activity(uuid,text,integer,integer) to service_role;
notify pgrst,'reload schema';
commit;
