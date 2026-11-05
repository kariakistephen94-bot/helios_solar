-- Apply after 202610300004_dashboard_calendar.sql. Existing bookings remain intact.
begin;
alter table helios.calendar_events alter column created_by drop not null;
alter table helios.calendar_events add column if not exists source text not null default 'dashboard';
create table if not exists helios.website_booking_receipts (
 request_id uuid primary key,
 event_id uuid not null references helios.calendar_events(id),
 lead_id uuid not null references public.leads(id),
 client_hash text not null,
 created_at timestamptz not null default now()
);
alter table helios.website_booking_receipts enable row level security;
revoke all on helios.website_booking_receipts from public,anon,authenticated;

create or replace function public.helios_website_booking(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare
 wanted_start timestamptz;
 wanted_end timestamptz;
 local_start timestamp;
 receipt helios.website_booking_receipts;
 e helios.calendar_events;
 customer_id uuid;
 used_count integer;
begin
 if p_action='status' then return jsonb_build_object('ready',true);end if;
 if p_action not in ('availability','confirm') then return jsonb_build_object('error','invalid_action');end if;
 -- Same lock as staff calendar writes: only one local writer can reserve a slot.
 perform pg_advisory_xact_lock(hashtextextended('helios:dashboard-calendar',0));
 if p_action='confirm' then
  select * into receipt from helios.website_booking_receipts where request_id=(p_payload->>'request_id')::uuid;
  if receipt.request_id is not null then
   if receipt.client_hash<>p_payload->>'client_hash' then return jsonb_build_object('error','invalid_request');end if;
   select * into e from helios.calendar_events where id=receipt.event_id;
   return jsonb_build_object('event',jsonb_build_object('id',e.id,'starts_at',e.starts_at,'ends_at',e.ends_at,'status',e.status,'timezone',e.timezone));
  end if;
 end if;
 wanted_start:=(p_payload->>'starts_at')::timestamptz;
 wanted_end:=wanted_start+interval '30 minutes';
 local_start:=wanted_start at time zone 'America/Chicago';
 if wanted_start<=clock_timestamp()+interval '15 minutes'
  or wanted_start>clock_timestamp()+interval '90 days'
  or extract(isodow from local_start)>5
  or local_start::time<time '09:00' or local_start::time>time '16:30'
  or extract(minute from local_start) not in (0,30) or extract(second from local_start)<>0
 then return jsonb_build_object('error','invalid_time');end if;
 if exists(select 1 from helios.calendar_events where status='scheduled' and starts_at<wanted_end and ends_at>wanted_start)
  or exists(select 1 from public.appointments where status='confirmed' and starts_at<wanted_end and ends_at>wanted_start)
 then return jsonb_build_object('available',false,'error','slot_conflict');end if;
 if p_action='availability' then return jsonb_build_object('available',true);end if;
 if coalesce(p_payload->>'name','')='' or length(p_payload->>'name')>100
  or coalesce(p_payload->>'email','')!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  or length(p_payload->>'email')>180 or length(coalesce(p_payload->>'notes',''))>2000
  or coalesce(p_payload->>'client_hash','')='' then return jsonb_build_object('error','invalid_request');end if;
 select count(*) into used_count from helios.website_booking_receipts
  where client_hash=p_payload->>'client_hash' and created_at>clock_timestamp()-interval '24 hours';
 if used_count>=3 then return jsonb_build_object('error','booking_limit');end if;
 -- Create a fresh website lead rather than merging on an unverified email.
 customer_id:=gen_random_uuid();
 insert into public.leads(id,name,email,source,interest,notes,stage)
 values(customer_id,p_payload->>'name',lower(p_payload->>'email'),'website','Consultation',
  coalesce(p_payload->>'notes',''),'Survey scheduled');
 insert into helios.calendar_events(id,lead_id,title,event_type,starts_at,ends_at,notes,created_by,source)
 values((p_payload->>'request_id')::uuid,customer_id,'Consultation · '||(p_payload->>'name'),
  'consultation',wanted_start,wanted_end,coalesce(p_payload->>'notes',''),null,'website') returning * into e;
 insert into helios.website_booking_receipts(request_id,event_id,lead_id,client_hash)
 values((p_payload->>'request_id')::uuid,e.id,customer_id,p_payload->>'client_hash');
 return jsonb_build_object('event',jsonb_build_object('id',e.id,'starts_at',e.starts_at,'ends_at',e.ends_at,'status',e.status,'timezone',e.timezone));
end $$;
revoke all on function public.helios_website_booking(text,jsonb) from public,anon,authenticated;
grant execute on function public.helios_website_booking(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
