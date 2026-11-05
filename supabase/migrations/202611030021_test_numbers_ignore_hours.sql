-- The three allowlisted test numbers are sent whenever auto send is on, including outside the 09:00-17:00
-- Mon-Fri window and at weekends. Every other recipient keeps the sending window, daily cap and gap, and
-- "Test numbers only" still blocks real prospects. The status call also reports that test numbers ignore hours,
-- so the dashboard can say so instead of implying nothing will send.
-- Additive and rerunnable: each line of the two functions is rewritten in place, and only if not already done.
begin;

do $patch$
declare
 dispatch_oid oid:=to_regprocedure('public.helios_outreach_dispatch(text,jsonb)');
 claim_oid oid:=to_regprocedure('public.helios_outreach_live_claim(jsonb)');
 d text; c text;
 test_list constant text:='(''2348107920394'',''2349138314501'',''2349121402541'')';
 outside constant text:='((c.weekdays_only and extract(isodow from local_ts)>5) or hr<c.window_start_hour or hr>=c.window_end_hour)';
begin
 if dispatch_oid is null or claim_oid is null then raise exception 'Apply the outreach dispatch upgrade (202611010018) first';end if;
 d:=pg_get_functiondef(dispatch_oid);
 c:=pg_get_functiondef(claim_oid);

 -- 1. dispatch: the early "outside hours" exit becomes a no-op; the job query below enforces the window instead.
 d:=replace(d,'return jsonb_build_object(''dispatch'',false,''reason'',''outside_hours'');end if;','null;end if;');

 -- 2. dispatch: outside the window only test-number jobs may be picked.
 if position('not '||outside||' or regexp_replace(j.recipient_snapshot' in d)=0 then
  if position('and (c.live_recipients or regexp_replace(j.recipient_snapshot,''[^0-9]'','''',''g'') in '||test_list||')' in d)=0 then
   raise exception 'Dispatch job selection was not recognised; nothing was changed';end if;
  d:=replace(d,'and (c.live_recipients or regexp_replace(j.recipient_snapshot,''[^0-9]'','''',''g'') in '||test_list||')',
   'and (c.live_recipients or regexp_replace(j.recipient_snapshot,''[^0-9]'','''',''g'') in '||test_list||')'
   ||' and (not '||outside||' or regexp_replace(j.recipient_snapshot,''[^0-9]'','''',''g'') in '||test_list||')');
 end if;

 -- 3. dispatch: when nothing can go out only because it is outside hours, say so.
 if position('case when '||outside||' then ''outside_hours''' in d)=0 then
  if position('return jsonb_build_object(''dispatch'',false,''reason'',''nothing_queued'');end if;' in d)=0 then
   raise exception 'Dispatch idle exit was not recognised; nothing was changed';end if;
  d:=replace(d,'return jsonb_build_object(''dispatch'',false,''reason'',''nothing_queued'');end if;',
   'return jsonb_build_object(''dispatch'',false,''reason'',case when '||outside||' then ''outside_hours'' else ''nothing_queued'' end);end if;');
 end if;

 -- 4. status: tell the dashboard that test numbers ignore the window.
 if position('''test_numbers_ignore_hours'',true' in d)=0 then
  if position('''live_recipients'',c.live_recipients,''state'',state,' in d)=0 then
   raise exception 'Dispatch status was not recognised; nothing was changed';end if;
  d:=replace(d,'''live_recipients'',c.live_recipients,''state'',state,','''live_recipients'',c.live_recipients,''state'',state,''test_numbers_ignore_hours'',true,');
 end if;

 -- 5. live claim: the same exemption for jobs the dispatcher already released.
 if position('if digits in '||test_list||' then null; else return jsonb_build_object(''can_send'',false,''status'',''outside_hours'')' in c)=0 then
  if position('return jsonb_build_object(''can_send'',false,''status'',''outside_hours'');end if;' in c)=0 then
   raise exception 'Live claim hours check was not recognised; nothing was changed';end if;
  c:=replace(c,'return jsonb_build_object(''can_send'',false,''status'',''outside_hours'');end if;',
   'if digits in '||test_list||' then null; else return jsonb_build_object(''can_send'',false,''status'',''outside_hours'');end if;end if;');
 end if;

 execute d;
 execute c;
end $patch$;

notify pgrst,'reload schema';
commit;
