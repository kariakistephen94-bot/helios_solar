-- Staff-only reporting. Gateway acceptance is not a delivery/read receipt.
begin;
create or replace function public.helios_outreach_activity(p_actor uuid,p_status text default 'all',p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.staff_members where user_id=p_actor) then
  return jsonb_build_object('error','staff_required');end if;
 if p_status not in ('all','accepted','failed','unknown','reserved') or p_status is null then
  return jsonb_build_object('error','invalid_status');end if;
 with snapshots as (
  select d.id as claim_id,d.execution_id,d.job_id,d.recipient,d.status,d.message_id,
   d.updated_at as attempted_at,null::text as detail,2 as priority
  from helios.gateway_test_deliveries d
  union all
  select a.claim_id,a.previous_attempt->>'execution_id',
   (a.previous_attempt->>'job_id')::uuid,a.previous_attempt->>'recipient',
   case when a.event='confirmed_401_retry_authorized' then 'failed' else a.previous_attempt->>'status' end,
   a.previous_attempt->>'message_id',a.created_at,
   case when a.event='confirmed_401_retry_authorized' then 'HTTP 401: gateway authentication rejected.' else 'Previous attempt before an authorized retry.' end,1
  from helios.gateway_retry_audit a
  where a.event in ('confirmed_401_retry_authorized','authorized_retry_claimed')
 ), attempts as (
  -- One row per execution, even if its failure appears in multiple audit events.
  select distinct on (claim_id,execution_id) * from snapshots
  order by claim_id,execution_id,priority desc,attempted_at desc
 ), filtered as (
  select a.*,p.name as prospect_name from attempts a
  left join helios.outreach_jobs j on j.id=a.job_id
  left join helios.prospects p on p.id=j.prospect_id
  where p_status='all' or a.status=p_status
 ), page as (
  select * from filtered order by attempted_at desc,claim_id
  limit least(100,greatest(1,coalesce(p_limit,20))) offset least(100000,greatest(0,coalesce(p_offset,0)))
 )
 select jsonb_build_object(
  'summary',(select jsonb_build_object('sent',count(*) filter(where status='accepted'),
   'failed',count(*) filter(where status='failed'),
   'completed',count(*) filter(where status in ('accepted','failed')),
   'uncertain',count(*) filter(where status='unknown'),
   'pending',count(*) filter(where status='reserved'),'attempts',count(*)) from attempts),
  'total',(select count(*) from filtered),
  'items',coalesce((select jsonb_agg(jsonb_build_object(
   'id',claim_id::text||':'||execution_id,'phone','+'||recipient,
   'name',coalesce(prospect_name,'Saved contact'),'status',status,
   'message_id',message_id,'attempted_at',attempted_at,'detail',detail
  )) from page),'[]'::jsonb),
  'scope','All recorded gateway outreach attempts, including authorized retry history.',
  'sent_definition','Sent means accepted by the gateway. Delivery and read status are unavailable.'
 ) into result;
 return result;
end $$;
revoke all on function public.helios_outreach_activity(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.helios_outreach_activity(uuid,text,integer,integer) to service_role;
notify pgrst,'reload schema';
commit;
