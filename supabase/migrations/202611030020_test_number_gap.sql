-- Test-number sends are spaced 60 seconds apart so a demo does not wait 10-25 minutes between messages.
-- Only the three allowlisted test numbers get the short gap. Every other recipient keeps the configured
-- random min/max gap, and the hours, daily cap and "test numbers only" switch are unchanged.
-- Additive and rerunnable: the function is rewritten in place and a second run finds nothing to change.
begin;

do $patch$
declare
 f oid:=to_regprocedure('public.helios_outreach_dispatch(text,jsonb)');
 def text;
 old_gap constant text:='gap:=c.min_gap_seconds+floor(random()*(c.max_gap_seconds-c.min_gap_seconds+1))::int;';
 new_gap constant text:='gap:=case when regexp_replace(coalesce(job.recipient_snapshot,''''),''[^0-9]'','''',''g'') in (''2348107920394'',''2349138314501'',''2349121402541'') then 60 else c.min_gap_seconds+floor(random()*(c.max_gap_seconds-c.min_gap_seconds+1))::int end;';
begin
 if f is null then raise exception 'Apply the outreach dispatch upgrade (202611010018) first';end if;
 def:=pg_get_functiondef(f);
 if position(old_gap in def)>0 then
  execute replace(def,old_gap,new_gap);
 elsif def !~ 'then [0-9]+ else c\.min_gap_seconds' then
  raise exception 'Dispatch gap logic was not recognised; nothing was changed';
 end if;
end $patch$;

notify pgrst,'reload schema';
commit;
