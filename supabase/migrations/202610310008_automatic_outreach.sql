-- Automatic template queue. No delivery or marketing consent is granted here.
begin;
alter table helios.outreach_jobs alter column created_by drop not null;
alter table helios.outreach_jobs add column if not exists automatic boolean not null default false;
alter table helios.outreach_jobs add column if not exists queue_reason text;
alter table helios.outreach_jobs drop constraint if exists outreach_jobs_status_check;
alter table helios.outreach_jobs add constraint outreach_jobs_status_check
 check(status in ('draft','reviewed','cancelled','queued','blocked','needs_review'));
drop index if exists helios.outreach_one_active_template;
create unique index outreach_one_active_template on helios.outreach_jobs(prospect_id,template_version)
 where status in ('draft','reviewed','queued','blocked','needs_review');

create or replace function public.helios_outreach_automatic(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare prospect helios.prospects; job helios.outreach_jobs; phone_digits text; blocked boolean;
begin
 if p_action='candidates' then
  return jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(x)) from (
   select p.id,p.name,p.phone,p.version,p.category from helios.prospects p
   where p.stage in ('New prospect','Qualified') and not exists (
    select 1 from helios.outreach_jobs j where j.prospect_id=p.id and j.template_version='solar-introduction-v1'
   ) order by p.created_at desc,p.id limit 50
  ) x),'[]'::jsonb));
 elsif p_action='enqueue' then
  select * into prospect from helios.prospects where id=p_payload->>'prospect_id' for update;
  if not found then return jsonb_build_object('error','not_found');end if;
  -- Any previous attempt, including cancellation, prevents automatic re-enrolment.
  select * into job from helios.outreach_jobs where prospect_id=prospect.id
   and template_version='solar-introduction-v1' order by created_at desc limit 1;
  if found then return jsonb_build_object('status','existing','job_id',job.id);end if;
  if prospect.stage not in ('New prospect','Qualified') or prospect.version is distinct from (p_payload->>'prospect_version')::int then
   return jsonb_build_object('error','version_conflict');
  end if;
  phone_digits:=regexp_replace(prospect.phone,'[^0-9]','','g');
  if phone_digits ~ '^0[789][0-9]{9}$' then phone_digits:='234'||substring(phone_digits from 2);end if;
  select exists(select 1 from public.leads l where
   (l.whatsapp_id=phone_digits or regexp_replace(coalesce(l.phone,''),'[^0-9]','','g')=phone_digits)
   and (l.opted_out or l.followup_blocked)) into blocked;
  if nullif(trim(p_payload->>'message_text'),'') is null then return jsonb_build_object('error','invalid_message');end if;
  insert into helios.outreach_jobs(id,prospect_id,template_version,message_text,business_name,
   owner_name,recipient_snapshot,status,automatic,queue_reason)
  values((p_payload->>'id')::uuid,prospect.id,'solar-introduction-v1',p_payload->>'message_text',
   coalesce(nullif(p_payload->>'business_name',''),prospect.name),null,
   case when phone_digits ~ '^[1-9][0-9]{7,14}$' then '+'||phone_digits else null end,
   case when blocked or phone_digits !~ '^[1-9][0-9]{7,14}$' then 'blocked'
    when p_payload->>'draft_status'='needs_review' then 'needs_review' else 'queued' end,
   true,case when blocked then 'Existing contact has blocked outreach or opted out.'
    when phone_digits !~ '^[1-9][0-9]{7,14}$' then 'Missing or invalid contact number.'
    when p_payload->>'draft_status'='needs_review' then 'Business name needs a short alias.'
    else 'Automatically queued. Delivery is not connected yet.' end)
  returning * into job;
  return jsonb_build_object('status',job.status,'job_id',job.id);
 end if;
 return jsonb_build_object('error','invalid_action');
end $$;
revoke all on function public.helios_outreach_automatic(text,jsonb) from public,anon,authenticated;
grant execute on function public.helios_outreach_automatic(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
