-- JADE / correcao rapida dos bloqueios da agenda
-- Rode no SQL Editor do Supabase quando faltar availability_blocks.full_day.

alter table "Studio".availability_blocks
  add column if not exists full_day boolean not null default false;

alter table "Studio".availability_blocks
  add column if not exists recurrence text not null default 'NONE';

alter table "Studio".availability_blocks
  add column if not exists weekday integer;

update "Studio".availability_blocks
set recurrence = 'NONE'
where recurrence is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'availability_blocks_recurrence_check'
      and conrelid = '"Studio".availability_blocks'::regclass
  ) then
    alter table "Studio".availability_blocks
      add constraint availability_blocks_recurrence_check
      check (recurrence in ('NONE', 'WEEKLY'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'availability_blocks_weekday_check'
      and conrelid = '"Studio".availability_blocks'::regclass
  ) then
    alter table "Studio".availability_blocks
      add constraint availability_blocks_weekday_check
      check (weekday between 0 and 6 or weekday is null);
  end if;
end $$;

notify pgrst, 'reload schema';

select column_name
from information_schema.columns
where table_schema = 'Studio'
  and table_name = 'availability_blocks'
  and column_name in ('full_day', 'recurrence', 'weekday')
order by column_name;
