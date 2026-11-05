-- Additive dashboard calendar. Existing WhatsApp leads and appointments are preserved.
begin;
create schema if not exists helios;
create table if not exists helios.calendar_events (
 id uuid primary key,
 lead_id uuid references public.leads(id),
 title text not null check (length(title) between 1 and 160),
 event_type text not null check (event_type in ('consultation','site_visit','installation','follow_up')),
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 timezone text not null default 'America/Chicago',
 status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
 notes text not null default '' check (length(notes)<=3000),
 version integer not null default 1,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (ends_at>starts_at)
);
alter table helios.calendar_events enable row level security;
create index if not exists calendar_events_time_idx on helios.calendar_events(starts_at,ends_at);
revoke all on helios.calendar_events from public,anon,authenticated;

create or replace function public.helios_calendar(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,helios,public as $$
declare
 e helios.calendar_events;
 wanted_start timestamptz;
 wanted_end timestamptz;
 wanted_id uuid;
begin
 if p_action='list' then
  return jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(c) order by c.starts_at,c.id)
    from helios.calendar_events c where c.starts_at<(p_payload->>'before')::timestamptz
    and c.ends_at>(p_payload->>'after')::timestamptz),'[]'::jsonb));
 end if;
 if p_action not in ('create','update','cancel') then return jsonb_build_object('error','invalid_action');end if;
 -- Serializes writes for the company's single shared booking calendar.
 perform pg_advisory_xact_lock(hashtextextended('helios:dashboard-calendar',0));
 wanted_id:=(p_payload->>'id')::uuid;
 select * into e from helios.calendar_events where id=wanted_id for update;
 if p_action='create' and e.id is not null then
  if e.title=p_payload->>'title' and e.starts_at=(p_payload->>'starts_at')::timestamptz
    and e.ends_at=(p_payload->>'ends_at')::timestamptz
    and e.event_type=p_payload->>'event_type'
    and e.lead_id is not distinct from nullif(p_payload->>'lead_id','')::uuid
    and e.notes=coalesce(p_payload->>'notes','')
    and e.created_by=(p_payload->>'actor')::uuid then
   return jsonb_build_object('event',to_jsonb(e));
  end if;
  return jsonb_build_object('error','request_conflict');
 end if;
 if p_action<>'create' then
  if e.id is null then return jsonb_build_object('error','not_found');end if;
  if e.version<>(p_payload->>'version')::integer then return jsonb_build_object('error','version_conflict');end if;
 end if;
 if p_action='cancel' then
  update helios.calendar_events set status='cancelled',version=version+1,updated_at=now()
   where id=wanted_id returning * into e;
  return jsonb_build_object('event',to_jsonb(e));
 end if;
 wanted_start:=(p_payload->>'starts_at')::timestamptz;
 wanted_end:=(p_payload->>'ends_at')::timestamptz;
 if wanted_end<=wanted_start or wanted_end>wanted_start+interval '7 days' then
  return jsonb_build_object('error','invalid_time');
 end if;
 if coalesce(p_payload->>'status','scheduled')='scheduled' and (
   exists(select 1 from helios.calendar_events c where c.id<>wanted_id and c.status='scheduled'
     and c.starts_at<wanted_end and c.ends_at>wanted_start)
   or exists(select 1 from public.appointments a where a.status='confirmed'
     and a.starts_at<wanted_end and a.ends_at>wanted_start)
 ) then return jsonb_build_object('error','slot_conflict');end if;
 if p_action='create' then
  insert into helios.calendar_events(id,lead_id,title,event_type,starts_at,ends_at,notes,created_by)
   values(wanted_id,nullif(p_payload->>'lead_id','')::uuid,p_payload->>'title',p_payload->>'event_type',
    wanted_start,wanted_end,coalesce(p_payload->>'notes',''),(p_payload->>'actor')::uuid)
   returning * into e;
 else
  update helios.calendar_events set lead_id=nullif(p_payload->>'lead_id','')::uuid,
   title=p_payload->>'title',event_type=p_payload->>'event_type',starts_at=wanted_start,ends_at=wanted_end,
   notes=coalesce(p_payload->>'notes',''),status=p_payload->>'status',version=version+1,updated_at=now()
   where id=wanted_id returning * into e;
 end if;
 return jsonb_build_object('event',to_jsonb(e));
end $$;
revoke all on function public.helios_calendar(text,jsonb) from public,anon,authenticated;
grant execute on function public.helios_calendar(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
