-- JADE / reparo incremental do schema Studio
-- Rode este arquivo no SQL Editor do Supabase se o backend acusar schema incompleto.

create schema if not exists "Studio";

create or replace function "Studio".set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table "Studio".services add column if not exists description text not null default '';
alter table "Studio".services add column if not exists category text not null default 'moment';
alter table "Studio".services add column if not exists image_url text not null default '';

update "Studio".studio_settings
set policy = jsonb_build_object(
  'defaultWorkDays', jsonb_build_array(1, 2, 3, 4, 5, 6),
  'defaultStartTime', '07:00',
  'defaultEndTime', '17:00',
  'sundayEnabled', false,
  'slotIntervalMinutes', 30
) || coalesce(policy, '{}'::jsonb);

alter table "Studio".availability_dates add column if not exists start_time text not null default '09:00';
alter table "Studio".availability_dates add column if not exists end_time text not null default '17:00';
alter table "Studio".availability_dates add column if not exists active boolean not null default true;
alter table "Studio".availability_dates add column if not exists slots jsonb not null default '[]'::jsonb;

create table if not exists "Studio".availability_blocks (
  id text primary key,
  date date not null,
  start_time text not null check (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  end_time text not null check (end_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  full_day boolean not null default false,
  recurrence text not null default 'NONE' check (recurrence in ('NONE', 'WEEKLY')),
  weekday integer check (weekday between 0 and 6),
  reason text not null default '',
  created_by text references "Studio".app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_time < end_time)
);

alter table "Studio".availability_blocks add column if not exists full_day boolean not null default false;
alter table "Studio".availability_blocks add column if not exists recurrence text not null default 'NONE';
alter table "Studio".availability_blocks add column if not exists weekday integer;
update "Studio".availability_blocks set recurrence = 'NONE' where recurrence is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'availability_blocks_recurrence_check'
      and conrelid = '"Studio".availability_blocks'::regclass
  ) then
    alter table "Studio".availability_blocks
      add constraint availability_blocks_recurrence_check check (recurrence in ('NONE', 'WEEKLY'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'availability_blocks_weekday_check'
      and conrelid = '"Studio".availability_blocks'::regclass
  ) then
    alter table "Studio".availability_blocks
      add constraint availability_blocks_weekday_check check (weekday between 0 and 6 or weekday is null);
  end if;
end $$;

alter table "Studio".appointments add column if not exists start_time text;
alter table "Studio".appointments add column if not exists end_time text;

update "Studio".appointments
set start_time = coalesce(start_time, time)
where start_time is null;

update "Studio".appointments as appointment
set end_time = to_char(
  (
    appointment.start_time::time
    + make_interval(mins => coalesce(service.duration_minutes, 60))
  )::time,
  'HH24:MI'
)
from "Studio".services as service
where appointment.service_id = service.id
  and (appointment.end_time is null or appointment.end_time <= appointment.start_time);

update "Studio".appointments
set end_time = to_char((start_time::time + interval '60 minutes')::time, 'HH24:MI')
where end_time is null or end_time <= start_time;

alter table "Studio".appointments alter column start_time set default '09:00';
alter table "Studio".appointments alter column end_time set default '10:00';
alter table "Studio".appointments alter column start_time set not null;
alter table "Studio".appointments alter column end_time set not null;

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'Studio'
      and rel.relname = 'app_users'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table "Studio".app_users drop constraint if exists %I', constraint_row.conname);
  end loop;
end $$;

update "Studio".app_users
set role = case
  when role in ('ADM', 'ADMIN') then 'ADM'
  else 'CLIENT'
end;

alter table "Studio".app_users
  add constraint app_users_role_check check (role in ('CLIENT', 'ADM'));

create index if not exists appointments_date_interval_idx
  on "Studio".appointments (date, start_time, end_time);

create index if not exists availability_blocks_date_interval_idx
  on "Studio".availability_blocks (date, start_time, end_time);

drop trigger if exists availability_blocks_set_updated_at on "Studio".availability_blocks;
create trigger availability_blocks_set_updated_at
before update on "Studio".availability_blocks
for each row execute function "Studio".set_updated_at();

alter table "Studio".availability_blocks enable row level security;

grant usage on schema "Studio" to anon, authenticated, service_role;
grant all on all tables in schema "Studio" to service_role;
grant all on all routines in schema "Studio" to service_role;
grant all on all sequences in schema "Studio" to service_role;

notify pgrst, 'reload schema';
