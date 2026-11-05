-- One-off maintenance, not a migration. OPTIONAL companion to reset_demo_test_numbers.sql.
-- Run it when you want the WhatsApp reply agent to start a brand-new conversation with your two phones,
-- instead of continuing the old thread (the agent reads the saved chat history before every reply).
-- Safe to rerun: a second run finds nothing left to reset.
--
-- Affects ONLY the leads for 2349121402541 and 2349138314501:
--   * Every saved chat message for those leads is copied to helios.test_reset_archive, then deleted.
--   * The lead rows are copied to the archive, then returned to a clean demo state: no scheduled
--     follow-up, no follow-up history, no inbound/outbound timestamps, neutral notes.
-- Not touched: opted_out and followup_blocked (an opt-out is never reset), appointments (delete those
-- from the dashboard calendar so the Google event is removed too), every other lead, and the
-- gateway number 2348107920394.
begin;

create table if not exists helios.test_reset_archive (
 id uuid primary key default gen_random_uuid(),
 source_table text not null,
 row_data jsonb not null,
 archived_at timestamptz not null default now()
);
alter table helios.test_reset_archive enable row level security;
revoke all on helios.test_reset_archive from public,anon,authenticated;

do $reset$
declare
 numbers constant text[]:=array['2349121402541','2349138314501'];
 ids uuid[];
begin
 select coalesce(array_agg(l.id),'{}') into ids from public.leads l where l.whatsapp_id=any(numbers);

 insert into helios.test_reset_archive(source_table,row_data)
  select 'messages',to_jsonb(m) from public.messages m where m.lead_id=any(ids);
 delete from public.messages where lead_id=any(ids);

 insert into helios.test_reset_archive(source_table,row_data)
  select 'leads',to_jsonb(l) from public.leads l
  where l.id=any(ids)
   and (l.followup_status is distinct from 'cancelled' or l.followup_due_at is not null or l.followup_count<>0
    or l.last_inbound_at is not null or l.last_outbound_at is not null or l.followup_anchor_message_id is not null);
 update public.leads set stage='New inquiry',followup_status='cancelled',followup_due_at=null,followup_count=0,
  followup_last_sent_at=null,followup_anchor_message_id=null,followup_opt_in=false,
  followup_reason='Demo test contact; no automatic follow-ups.',
  last_inbound_at=null,last_outbound_at=null,notes='User-owned demo test contact.'
 where id=any(ids);
end $reset$;

commit;
