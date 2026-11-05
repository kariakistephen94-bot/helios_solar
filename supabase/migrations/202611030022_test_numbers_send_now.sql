-- Clicking "Turn on auto-send" with "Test numbers only" starts sending to the test numbers straight away
-- (the dispatcher polls every 30 seconds), and test numbers are spaced 30 seconds apart.
-- Turning on auto-send while real prospects are allowed keeps the one-minute safety delay, and every
-- other recipient keeps the configured random gap, sending window and daily cap.
-- Additive and rerunnable: each line is rewritten in place, and only if not already done.
begin;

do $patch$
declare
 f oid:=to_regprocedure('public.helios_outreach_dispatch(text,jsonb)');
 d text;
 old_delay constant text:='then t+interval ''1 minute'' else next_dispatch_at end,';
 new_delay constant text:='then case when coalesce((p_payload->>''live_recipients'')::boolean,live_recipients) then t+interval ''1 minute'' else t end else next_dispatch_at end,';
begin
 if f is null then raise exception 'Apply the outreach dispatch upgrade (202611010018) first';end if;
 d:=pg_get_functiondef(f);
 if position(new_delay in d)=0 then
  if position(old_delay in d)=0 then raise exception 'Enable delay was not recognised; nothing was changed';end if;
  d:=replace(d,old_delay,new_delay);
 end if;
 if d !~ 'then [0-9]+ else c\.min_gap_seconds' then
  raise exception 'Test-number gap (202611030020) must be applied first';end if;
 d:=regexp_replace(d,'then [0-9]+ else c\.min_gap_seconds','then 30 else c.min_gap_seconds');
 execute d;
end $patch$;

notify pgrst,'reload schema';
commit;
