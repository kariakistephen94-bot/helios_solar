-- Adds Stephen's second phone (09121402541 / 2349121402541) as a demo test contact.
-- Additive and rerunnable. 09138314501 and 08107920394 are already test contacts and are not touched.
-- This only widens the existing test-number allowlist by one user-owned number. It does not enable
-- live recipients, clear any opt-out or follow-up block, or authorize sending to researched businesses.
begin;

do $$ begin
 if to_regprocedure('public.helios_outreach_dispatch(text,jsonb)') is null
  or to_regprocedure('public.helios_outreach_live_claim(jsonb)') is null
  or to_regprocedure('public.helios_gateway_test_delivery(text,jsonb)') is null then
  raise exception 'Apply the outreach dispatch upgrade (202611010018) before the demo test numbers';
 end if;
end $$;

-- The allowlist is a literal inside several functions. Rewrite each in place so grants and bodies are
-- otherwise unchanged. Functions that already carry the new number no longer contain the old list.
do $patch$
declare
 f record;
 old_list constant text:='(''2348107920394'',''2349138314501'')';
 new_list constant text:='(''2348107920394'',''2349138314501'',''2349121402541'')';
begin
 for f in
  select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
   and p.proname in ('helios_outreach_dispatch','helios_outreach_live_claim','helios_gateway_test_delivery','helios_outreach_test_delivery')
   and position(old_list in p.prosrc)>0
 loop
  execute replace(pg_get_functiondef(f.oid),old_list,new_list);
 end loop;
 if exists(
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
   and p.proname in ('helios_outreach_dispatch','helios_outreach_live_claim','helios_gateway_test_delivery')
   and position(new_list in p.prosrc)=0
 ) then
  raise exception 'Test-number allowlist was not updated in every delivery function';
 end if;
end $patch$;

-- Test contacts have no Google location (the existing ones are stored the same way).
alter table helios.prospects alter column latitude drop not null;
alter table helios.prospects alter column longitude drop not null;

insert into helios.prospects(id,place_id,fingerprint,name,address,phone,website,latitude,longitude,category,
 stage,notes,consent,business_status,created_at,last_seen_at,version)
values(gen_random_uuid()::text,'manual:stephen:2349121402541','manual:stephen:2349121402541','Stephen','',
 '+2349121402541','',null,null,'test_contact','New prospect',
 'User-owned test contact (second phone), added at Stephen''s request for the demo. No Google location or business rating. Adding this record does not authorize sending.',
 false,'TEST_CONTACT',extract(epoch from now())::bigint,extract(epoch from now())::bigint,1)
on conflict (place_id) do nothing;

-- The gateway claim requires a lead row for the recipient. Follow-ups stay off for this lead.
insert into public.leads(whatsapp_id,profile_name,name,phone,source,interest,notes,stage,
 followup_opt_in,opted_out,followup_blocked,followup_status,followup_reason)
select '2349121402541','Stephen','Stephen','+2349121402541','whatsapp','solar',
 'User-owned demo test contact (second phone).','New inquiry',
 false,false,false,'cancelled','Demo test contact; no automatic follow-ups.'
where not exists(select 1 from public.leads l where l.whatsapp_id='2349121402541'
 or regexp_replace(coalesce(l.phone,''),'[^0-9]','','g')='2349121402541');

notify pgrst,'reload schema';
commit;
