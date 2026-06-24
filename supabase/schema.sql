-- JADE / Gabriely Dias
-- Banco organizado no schema "Studio".
-- Rode este arquivo no SQL Editor do Supabase.

create schema if not exists "Studio";

comment on schema "Studio" is 'Schema do sistema de agendamento e gestao do estudio.';

-- Permite que a API do Supabase enxergue o schema.
-- O backend usa service_role; anon/authenticated continuam protegidos pelo RLS abaixo.
grant usage on schema "Studio" to anon, authenticated, service_role;

-- Atualizacao automatica de updated_at.
create or replace function "Studio".set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Dados gerais do estudio.
create table if not exists "Studio".studio_settings (
  id text primary key default 'main',
  name text not null,
  address text not null default '',
  city text not null default '',
  state text not null default '',
  whatsapp text not null default '',
  instagram text not null default '',
  policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Clientes e administradores do app.
create table if not exists "Studio".app_users (
  id text primary key,
  name text not null default 'Cliente',
  phone text not null unique,
  role text not null default 'CLIENT'
    check (role in ('CLIENT', 'ADM')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- Servicos vendidos no estudio.
create table if not exists "Studio".services (
  id text primary key,
  name text not null,
  description text not null default '',
  image_url text not null default '',
  price_cents integer not null check (price_cents >= 0),
  duration_minutes integer not null check (duration_minutes > 0),
  category text not null default 'moment',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Horarios especificos por data. Se uma data nao existir aqui, ela nao aparece para a cliente.
create table if not exists "Studio".availability_dates (
  date date primary key,
  start_time text not null default '09:00' check (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  end_time text not null default '17:00' check (end_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  active boolean not null default true,
  slots jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bloqueios manuais dentro de um dia disponivel.
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

-- Agendamentos.
create table if not exists "Studio".appointments (
  id text primary key,
  user_id text references "Studio".app_users(id) on delete set null,
  client_name text not null,
  client_phone text not null,
  service_id text references "Studio".services(id) on delete set null,
  service_name text not null,
  date date not null,
  time text not null check (time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  start_time text not null default '09:00' check (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  end_time text not null default '10:00' check (end_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CONFIRMED', 'DONE', 'CANCELLED', 'NO_SHOW')),
  notes text not null default '',
  total_cents integer not null default 0 check (total_cents >= 0),
  deposit_cents integer not null default 0 check (deposit_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migracoes seguras para bancos ja criados com uma versao anterior do schema.
-- Fica antes dos indices/triggers para evitar erro quando a tabela ja existe sem colunas novas.
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

-- Nao permite dois agendamentos ativos no mesmo dia/horario.
create unique index if not exists appointments_unique_active_slot
  on "Studio".appointments (date, time)
  where status not in ('CANCELLED', 'NO_SHOW');

create index if not exists appointments_date_status_idx
  on "Studio".appointments (date, status);

create index if not exists appointments_client_phone_idx
  on "Studio".appointments (client_phone);

create index if not exists appointments_date_interval_idx
  on "Studio".appointments (date, start_time, end_time);

create index if not exists availability_blocks_date_interval_idx
  on "Studio".availability_blocks (date, start_time, end_time);

-- Conteudos do feed.
create table if not exists "Studio".feed_posts (
  id text primary key,
  title text not null,
  subtitle text not null default '',
  content jsonb not null default '[]'::jsonb,
  footer text not null default '',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Grupos de promocoes.
create table if not exists "Studio".promotions (
  id text primary key,
  title text not null,
  type text not null default 'custom',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pacotes dentro de cada promocao.
create table if not exists "Studio".promotion_packages (
  id text primary key,
  promotion_id text not null references "Studio".promotions(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  subtitle text not null default '',
  benefits jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists promotion_packages_promotion_idx
  on "Studio".promotion_packages (promotion_id, sort_order);

-- Pessoas interessadas nos pacotes.
create table if not exists "Studio".promotion_leads (
  id text primary key,
  user_id text references "Studio".app_users(id) on delete set null,
  client_name text not null,
  client_phone text not null,
  promotion_id text references "Studio".promotions(id) on delete set null,
  package_id text references "Studio".promotion_packages(id) on delete set null,
  package_name text,
  message text not null default '',
  status text not null default 'NEW'
    check (status in ('NEW', 'CONTACTED', 'CLOSED', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists promotion_leads_status_idx
  on "Studio".promotion_leads (status, created_at);

create index if not exists promotion_leads_client_phone_idx
  on "Studio".promotion_leads (client_phone);

-- Triggers de updated_at.
drop trigger if exists studio_settings_set_updated_at on "Studio".studio_settings;
create trigger studio_settings_set_updated_at
before update on "Studio".studio_settings
for each row execute function "Studio".set_updated_at();

drop trigger if exists app_users_set_updated_at on "Studio".app_users;
create trigger app_users_set_updated_at
before update on "Studio".app_users
for each row execute function "Studio".set_updated_at();

drop trigger if exists services_set_updated_at on "Studio".services;
create trigger services_set_updated_at
before update on "Studio".services
for each row execute function "Studio".set_updated_at();

drop trigger if exists availability_dates_set_updated_at on "Studio".availability_dates;
create trigger availability_dates_set_updated_at
before update on "Studio".availability_dates
for each row execute function "Studio".set_updated_at();

drop trigger if exists availability_blocks_set_updated_at on "Studio".availability_blocks;
create trigger availability_blocks_set_updated_at
before update on "Studio".availability_blocks
for each row execute function "Studio".set_updated_at();

drop trigger if exists appointments_set_updated_at on "Studio".appointments;
create trigger appointments_set_updated_at
before update on "Studio".appointments
for each row execute function "Studio".set_updated_at();

drop trigger if exists feed_posts_set_updated_at on "Studio".feed_posts;
create trigger feed_posts_set_updated_at
before update on "Studio".feed_posts
for each row execute function "Studio".set_updated_at();

drop trigger if exists promotions_set_updated_at on "Studio".promotions;
create trigger promotions_set_updated_at
before update on "Studio".promotions
for each row execute function "Studio".set_updated_at();

drop trigger if exists promotion_packages_set_updated_at on "Studio".promotion_packages;
create trigger promotion_packages_set_updated_at
before update on "Studio".promotion_packages
for each row execute function "Studio".set_updated_at();

drop trigger if exists promotion_leads_set_updated_at on "Studio".promotion_leads;
create trigger promotion_leads_set_updated_at
before update on "Studio".promotion_leads
for each row execute function "Studio".set_updated_at();

-- RLS ligado em todas as tabelas. O backend usa service_role e passa por cima do RLS.
-- Se no futuro o frontend acessar o Supabase direto, crie policies especificas antes.
alter table "Studio".studio_settings enable row level security;
alter table "Studio".app_users enable row level security;
alter table "Studio".services enable row level security;
alter table "Studio".availability_dates enable row level security;
alter table "Studio".availability_blocks enable row level security;
alter table "Studio".appointments enable row level security;
alter table "Studio".feed_posts enable row level security;
alter table "Studio".promotions enable row level security;
alter table "Studio".promotion_packages enable row level security;
alter table "Studio".promotion_leads enable row level security;

-- Permissoes finais para o backend.
grant all on all tables in schema "Studio" to service_role;
grant all on all routines in schema "Studio" to service_role;
grant all on all sequences in schema "Studio" to service_role;

-- Recarrega o cache da Data API do Supabase apos DDL.
notify pgrst, 'reload schema';
