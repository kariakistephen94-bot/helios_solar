-- One-off maintenance, not a migration. Run in the Supabase SQL Editor when you want the demo test
-- numbers to start from scratch. Safe to rerun: a second run finds nothing left to reset.
--
-- Resets ONLY the test-send history of these numbers: 2348107920394, 2349138314501, 2349121402541.
--   * Test-delivery reservations are copied to helios.test_reset_archive, then removed, so each number
--     can receive a first test message again (the system allows one reservation per number).
--   * Their rehearsal (dry-run) claims are removed the same way.
--   * Their queued outreach jobs are returned to a clean, never-dispatched state.
-- Not touched: leads, WhatsApp conversations, opt-outs and follow-up flags, every other prospect or job,
-- the delivery receipt log, and the dispatcher settings (it stays off / test numbers only as you left it).
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
 numbers constant text[]:=array['2348107920394','2349138314501','2349121402541'];
begin
 if to_regclass('helios.gateway_test_deliveries') is not null then
  insert into helios.test_reset_archive(source_table,row_data)
   select 'gateway_test_deliveries',to_jsonb(d) from helios.gateway_test_deliveries d where d.recipient=any(numbers);
  delete from helios.gateway_test_deliveries where recipient=any(numbers);
 end if;
 -- The "Failed" count on the activity panel also reads the retry audit, so those rows reset too.
 if to_regclass('helios.gateway_retry_audit') is not null then
  insert into helios.test_reset_archive(source_table,row_data)
   select 'gateway_retry_audit',to_jsonb(a) from helios.gateway_retry_audit a where a.previous_attempt->>'recipient'=any(numbers);
  delete from helios.gateway_retry_audit where previous_attempt->>'recipient'=any(numbers);
 end if;
 if to_regclass('helios.outreach_test_deliveries') is not null then
  insert into helios.test_reset_archive(source_table,row_data)
   select 'outreach_test_deliveries',to_jsonb(d) from helios.outreach_test_deliveries d where d.recipient=any(numbers);
  delete from helios.outreach_test_deliveries where recipient=any(numbers);
 end if;
 if to_regclass('helios.outreach_test_claims') is not null then
  insert into helios.test_reset_archive(source_table,row_data)
   select 'outreach_test_claims',to_jsonb(c) from helios.outreach_test_claims c
   where c.job_id in (select j.id from helios.outreach_jobs j
    where regexp_replace(coalesce(j.recipient_snapshot,''),'[^0-9]','','g')=any(numbers));
  delete from helios.outreach_test_claims
   where job_id in (select j.id from helios.outreach_jobs j
    where regexp_replace(coalesce(j.recipient_snapshot,''),'[^0-9]','','g')=any(numbers));
 end if;
 -- Only jobs still waiting to go out are reset; cancelled or blocked jobs keep their status.
 update helios.outreach_jobs set dispatched_at=null,dispatch_attempts=0,
  queue_reason='Automatically queued. Delivery is not connected yet.',updated_at=now()
 where status='queued' and regexp_replace(coalesce(recipient_snapshot,''),'[^0-9]','','g')=any(numbers);
end $reset$;

commit;
