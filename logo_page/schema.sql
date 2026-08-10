-- Logo catalogue schema
-- Run in the Supabase dashboard: SQL Editor -> New query -> Run.
-- Safe to re-run: every statement is idempotent.
--
-- ACCESS MODEL: "anyone with the link".
-- The policies below intentionally grant the anonymous role full read/write.
-- Anyone who can reach the site can upload, bin, or restore.

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------

create table if not exists public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  sort_order integer not null default 0,
  locked     boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

-- locked: one of the established companies. Kept as a marker only.
alter table public.companies
  add column if not exists locked boolean not null default false;

-- alt_name: the same company in the other script -- 'Panasonic' -> '國際牌',
-- '三菱' -> 'Mitsubishi'. Shown beside the name on the upload tiles and
-- searchable, so either spelling finds the company. Optional; blank is fine.
alter table public.companies
  add column if not exists alt_name text;

-- deleted_at: recycle bin. Non-null = binned, hidden from the main views,
-- restorable. A row must be binned before it can be destroyed (see policy).
alter table public.companies
  add column if not exists deleted_at timestamptz;

create index if not exists companies_active_idx
  on public.companies (deleted_at, sort_order, created_at);

alter table public.companies enable row level security;

drop policy if exists "anon read companies"   on public.companies;
drop policy if exists "anon insert companies" on public.companies;
drop policy if exists "anon update companies" on public.companies;
drop policy if exists "anon delete companies" on public.companies;

create policy "anon read companies"
  on public.companies for select to anon using (true);

create policy "anon insert companies"
  on public.companies for insert to anon with check (true);

create policy "anon update companies"
  on public.companies for update to anon using (true) with check (true);

-- Destroying a company requires it to be in the bin first. This is what makes
-- "delete" a two-step action at the database level, not just in the UI.
create policy "anon delete companies"
  on public.companies for delete to anon using (deleted_at is not null);

-- ---------------------------------------------------------------------------
-- Rename: 三菱 -> Mitsubishi
--
-- Company names are immutable at runtime (see the prevent_rename trigger
-- further down), so this drops the trigger and lets the trigger section
-- recreate it afterwards. The two spellings simply swap places: the English
-- name becomes canonical and 三菱 moves to alt_name, so the company is still
-- found by either spelling and still sorts into an A-to-Z list under M.
--
-- This must run BEFORE the seed below. The seed is guarded on `name`, so if
-- the rename ran after it, the guard would not find 'Mitsubishi' and would
-- insert a second row next to the old 三菱.
--
-- Idempotent: after the first run there is no 三菱 left for it to match.
-- ---------------------------------------------------------------------------

drop trigger if exists companies_prevent_rename on public.companies;

update public.companies
   set name = 'Mitsubishi', alt_name = '三菱'
 where name = '三菱';

-- ---------------------------------------------------------------------------
-- Seed the established companies
--
-- Guarded per name rather than "only if the table is empty", so re-running
-- this file after the list grows adds the newcomers to an existing database.
-- The flip side: a seeded company that was purged from the bin comes back on
-- the next run. Drop its row from the list below if that is not wanted.
-- ---------------------------------------------------------------------------

-- One statement so the list is written once. The UPDATE works from the same
-- snapshot as the INSERT and so does not see the rows the INSERT just added --
-- which is fine, those already carry their alt_name.
with seed(name, alt_name, ord) as (
    values
      ('Mitsubishi',  '三菱',        1),
      ('HITACHI',     '日立',        2),
      ('Panasonic',   '國際牌',      3),
      ('LG',          '樂金',        4),
      ('FUJITSU',     '富士通',      5),
      ('SHARP',       '夏普',        6),
      ('CHIMEI',      '奇美',        7),
      ('TECO',        '東元',        8),
      ('SONY',        '索尼',        9),
      ('SAMSUNG',     '三星',       10),
      ('SAKURA',      '櫻花',       11),
      ('Dyson',       '戴森',       12),
      ('Apple',       '蘋果',       13),
      ('ASUS',        '華碩',       14),
      ('Acer',        '宏碁',       15),
      ('MSI',         '微星',       16),
      ('Toshiba',     '東芝',       17),
      ('Philips',     '飛利浦',     18),
      ('Daikin',      '大金',       19),
      ('Whirlpool',   '惠而浦',     20),
      ('Bosch',       '博世',       21),
      ('BenQ',        '明基',       22),
      ('Logitech',    '羅技',       23),
      ('HP',          '惠普',       24),
      ('Lenovo',      '聯想',       25)
),
inserted as (
  insert into public.companies (name, alt_name, sort_order, locked)
  select seed.name, seed.alt_name, seed.ord, true
  from seed
  where not exists (
    select 1 from public.companies c where c.name = seed.name
  )
)
-- Backfill the second spelling on rows that predate the alt_name column.
-- Names are immutable, alt_name is not, so the established 11 can be filled
-- in without disturbing their rows or the logos hanging off them.
update public.companies c
   set alt_name = seed.alt_name
  from seed
 where c.name = seed.name
   and coalesce(c.alt_name, '') = '';

update public.companies
   set locked = true
 where sort_order between 1 and 25
   and locked = false;

-- ---------------------------------------------------------------------------
-- Names are immutable
--
-- A company name is set once, at insert, and can never be changed afterwards
-- -- established or user-created alike. RLS WITH CHECK cannot see the OLD row,
-- so this has to be a trigger.
-- ---------------------------------------------------------------------------

drop trigger if exists companies_prevent_locked_rename on public.companies;
drop function if exists public.prevent_locked_rename();

create or replace function public.prevent_rename()
returns trigger
language plpgsql
as $$
begin
  if new.name is distinct from old.name then
    raise exception 'company names are immutable ("%" cannot be renamed)', old.name
      using errcode = 'check_violation';
  end if;
  -- Do not let a client flip the established-company marker.
  new.locked := old.locked;
  return new;
end;
$$;

drop trigger if exists companies_prevent_rename on public.companies;
create trigger companies_prevent_rename
  before update on public.companies
  for each row execute function public.prevent_rename();

-- A company must be given a name when it is created.
--
-- This is deliberately a BEFORE INSERT trigger and not a CHECK constraint.
-- A CHECK is re-evaluated on every UPDATE of the row, including the harmless
-- deleted_at write that bins it -- which made pre-existing blank-named rows
-- impossible to delete. Enforcing only at insert keeps old blanks binnable.
alter table public.companies
  drop constraint if exists companies_name_not_blank;

create or replace function public.require_name()
returns trigger
language plpgsql
as $$
begin
  if length(btrim(coalesce(new.name, ''))) = 0 then
    raise exception 'a company must have a name'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists companies_require_name on public.companies;
create trigger companies_require_name
  before insert on public.companies
  for each row execute function public.require_name();

-- ---------------------------------------------------------------------------
-- logos  (many per company)
-- ---------------------------------------------------------------------------

create table if not exists public.logos (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  path       text not null unique,
  file_name  text,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.logos
  add column if not exists deleted_at timestamptz;

create index if not exists logos_company_idx
  on public.logos (company_id, deleted_at, created_at);

alter table public.logos enable row level security;

drop policy if exists "anon read logos rows"   on public.logos;
drop policy if exists "anon insert logos rows" on public.logos;
drop policy if exists "anon update logos rows" on public.logos;
drop policy if exists "anon delete logos rows" on public.logos;

create policy "anon read logos rows"
  on public.logos for select to anon using (true);

create policy "anon insert logos rows"
  on public.logos for insert to anon with check (true);

create policy "anon update logos rows"
  on public.logos for update to anon using (true) with check (true);

create policy "anon delete logos rows"
  on public.logos for delete to anon using (deleted_at is not null);

-- ---------------------------------------------------------------------------
-- One live logo per company
--
-- A partial unique index, so only live rows compete for the slot. Binning a
-- logo frees the company to take a new one, and the bin can still hold any
-- number of old ones for the same company.
--
-- Companies that already hold several live logos have to be trimmed to one
-- before the index will build. The newest is kept -- it is the one the upload
-- tile was already previewing -- and the older ones are binned rather than
-- destroyed, so nothing is lost and they can be restored.
--
-- Note this makes a bin restore fail when the company has taken a new logo in
-- the meantime. That is the intended answer: the slot is occupied.
-- ---------------------------------------------------------------------------

update public.logos
   set deleted_at = now()
 where deleted_at is null
   and exists (
     select 1
       from public.logos k
      where k.company_id = logos.company_id
        and k.deleted_at is null
        and (k.created_at, k.id) > (logos.created_at, logos.id)
   );

create unique index if not exists logos_one_live_per_company
  on public.logos (company_id) where deleted_at is null;

-- Carry over any single logo from the original one-per-company schema.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'companies'
       and column_name = 'logo_path'
  ) then
    execute $mig$
      insert into public.logos (company_id, path)
      select id, logo_path from public.companies where logo_path is not null
      on conflict (path) do nothing
    $mig$;
    execute 'alter table public.companies drop column logo_path';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'logos', 'logos', true, 5242880,
  array['image/png','image/jpeg','image/svg+xml','image/webp','image/gif']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "anon read logos"   on storage.objects;
drop policy if exists "anon insert logos" on storage.objects;
drop policy if exists "anon update logos" on storage.objects;
drop policy if exists "anon delete logos" on storage.objects;

create policy "anon read logos"
  on storage.objects for select to anon using (bucket_id = 'logos');

create policy "anon insert logos"
  on storage.objects for insert to anon with check (bucket_id = 'logos');

create policy "anon update logos"
  on storage.objects for update to anon
  using (bucket_id = 'logos') with check (bucket_id = 'logos');

create policy "anon delete logos"
  on storage.objects for delete to anon using (bucket_id = 'logos');
