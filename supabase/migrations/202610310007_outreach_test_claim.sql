-- Dry-run claims only. Does not authorize or send a WhatsApp message.
begin;
create table if not exists helios.outreach_test_claims (
 job_id uuid primary key references helios.outreach_jobs(id),
 execution_id text not null check(length(execution_id) between 1 and 100),
 job_version integer not null,
 created_at timestamptz not null default now()
);
alter table helios.outreach_test_claims enable row level security;
revoke all on helios.outreach_test_claims from public,anon,authenticated;
create or replace function public.helios_outreach_test_claim(p_job_id uuid,p_execution_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare job helios.outreach_jobs; claim helios.outreach_test_claims;
begin
 if p_execution_id is null or length(trim(p_execution_id)) not between 1 and 100 then
  return jsonb_build_object('success',false,'can_send',false,'status','invalid_request');
 end if;
 select * into job from helios.outreach_jobs where id=p_job_id for update;
 if not found then return jsonb_build_object('success',false,'can_send',false,'status','not_found');end if;
 if job.status<>'reviewed' then
  return jsonb_build_object('success',false,'can_send',false,'status','not_reviewed');
 end if;
 select * into claim from helios.outreach_test_claims where job_id=p_job_id;
 if found then
  if claim.execution_id<>p_execution_id or claim.job_version<>job.version then
   return jsonb_build_object('success',false,'can_send',false,'status','already_claimed');
  end if;
 else
  insert into helios.outreach_test_claims(job_id,execution_id,job_version)
  values(p_job_id,p_execution_id,job.version);
 end if;
 return jsonb_build_object('success',true,'can_send',false,'dry_run',true,
  'status','test_claimed','job_id',job.id,'message_text',job.message_text,
  'reason','Connection rehearsal only. WhatsApp delivery is not enabled.');
end $$;
revoke all on function public.helios_outreach_test_claim(uuid,text) from public,anon,authenticated;
grant execute on function public.helios_outreach_test_claim(uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
