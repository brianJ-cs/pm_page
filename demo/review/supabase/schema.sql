-- 審核系統：建表草稿（**還沒執行過**）
--
-- 對照 demo/review 本機模式的資料形狀，一張表對一個 db.xxx。
-- 原則（實作指南 8.3）：
--   ・所有「改資料」都走 Edge Function `review`（見 WIRING.md）：它用 service role 連線、
--     先跑 rules.js 的 can() 再寫。所以這裡**只開讀的 policy**，寫的 policy 一條都沒有 ——
--     瀏覽器拿 anon／使用者權杖直接打 REST 寫不進任何一張表。
--   ・例外只有兩個：通知的「已讀」（只准改自己的 read 欄位）、登入頁的公開看板（view）。
--   ・人員、分類對照、商品是全國電子推過來的（需求書 v3.0），欄位照那一份。
--
-- 全部 if not exists，對著在跑的專案重跑是安全的。

-- ---------- 外部資料（全國電子推送） ----------
create table if not exists members (
  employee_id text primary key,
  name        text not null,
  email       text not null unique,
  role        text not null check (role in ('design', 'pm', 'mkt')),
  department  text,
  title       text,
  is_active   boolean not null default true
);
create unique index if not exists members_email_lower on members (lower(email));

create table if not exists assignments (
  category_id    text primary key,
  category_name  text not null,
  owner_id       text not null references members(employee_id),
  owner_name     text,
  manager_id     text not null references members(employee_id),
  manager_name   text,
  director_id    text not null references members(employee_id),
  director_name  text,
  executive_id   text not null references members(employee_id),
  executive_name text
);

create table if not exists products (
  sku         text primary key check (sku !~ '\s'),   -- 不得含空格（實作指南 2.4）
  category_id text,
  brand       text,
  name        text,
  spec        text,
  price       numeric,
  info        text,
  is_active   boolean not null default true
);

-- ---------- 系統自己的設定 ----------
create table if not exists reviewer_settings (          -- 最終審核者設定表（2.3），只有一列
  id             int primary key default 1 check (id = 1),
  r2_managers    boolean not null default false,         -- 二校要不要主管審（全系統一個開關，預設關）
  exec_id        text references members(employee_id),  -- 商品處協理（一律指定；分類表的 executive_id 是處長）
  mkt_exec_id    text references members(employee_id),
  lawyer_id      text references members(employee_id),
  design_lead_id text references members(employee_id),
  updated_by     text,
  updated_at     timestamptz default now()
);

-- 表已經建過的專案補欄位（create table if not exists 不會加新欄位）
alter table reviewer_settings add column if not exists r2_managers boolean not null default false;

create table if not exists delegations (                -- 職代（8.2）
  id            text primary key,
  from_id       text not null references members(employee_id),
  to_id         text not null references members(employee_id),
  assigned_by   text references members(employee_id),   -- 差勤同步帶進來的是 null
  start_at      timestamptz not null,
  end_at        timestamptz not null,
  stages        text not null default 'all',
  source        text not null check (source in ('sync', 'manual')),
  overridden_by text,
  cancelled_at  timestamptz,
  cancelled_by  text,
  created_at    timestamptz default now()
);

create table if not exists announcements (id text primary key, date date not null, text text not null);

-- ---------- 檔期、版位、格子 ----------
-- 每一輪審核的狀態（r2、r3、fin）、審核經過（hist）用 jsonb：形狀跟 rules.js 一模一樣，
-- Edge Function 讀出來就能直接丟給 rules.js，不必一欄一欄拼。
create table if not exists plans (
  id          text primary key,
  name        text not null,
  type        text,
  created_by  text references members(employee_id),
  schedule    jsonb not null,            -- [{ stage, start, end }] × 10
  final       jsonb,                     -- 商品部確認完成、送審稿、三關
  published   jsonb,                     -- 出稿
  flags       jsonb default '{}'::jsonb, -- 通知發過了沒
  rev         bigint not null default 0, -- 樂觀鎖：每次寫入加一（見 WIRING.md「同時按」）
  -- 登入頁公開看板用的兩欄：由 Edge Function 每次寫入時算好存下來（不在 view 裡算）
  public_stage text,
  public_due   timestamptz,
  updated_at  timestamptz default now()
);

create table if not exists blocks (
  id          text primary key,
  plan_id     text not null references plans(id) on delete cascade,
  name        text not null,
  ord         int not null,
  phase       text,
  pm_done     jsonb default '{}'::jsonb,
  masthead_ok boolean default false,
  mh2_ok      boolean default false,
  r2          jsonb
);

create table if not exists cells (
  id          text primary key,
  plan_id     text not null references plans(id) on delete cascade,
  block_id    text not null references blocks(id) on delete cascade,
  category_id text not null references assignments(category_id),
  idx         int not null,
  stage       text not null,
  detail      jsonb,
  note_text   text default '',
  gifts       jsonb default '[]'::jsonb,
  reviewed    boolean default false,
  fix         boolean default false,
  fix2        boolean default false,
  submitted   jsonb,
  made        jsonb,
  version     int default 1,
  r2          jsonb,
  r3          jsonb,
  fin         jsonb,
  hist        jsonb default '[]'::jsonb
);
create index if not exists cells_plan on cells (plan_id);

create table if not exists notes (                     -- 便利貼
  id          text primary key,
  plan_id     text not null references plans(id) on delete cascade,
  block_id    text not null,
  cell_id     text not null references cells(id) on delete cascade,
  author      text not null references members(employee_id),
  author_name text,
  author_role text,
  kind        text not null check (kind in ('修改', '補貼紙', '換品')),
  text        text not null,
  stage       text,
  purpose     text,                      -- 一校／一改／二改／r2pm／reject／cycle
  level       int,
  ctx         text,
  status      text not null default 'open' check (status in ('open', 'resolved')),
  replies     jsonb default '[]'::jsonb,
  resolved_by text,
  resolved_at timestamptz,
  created_at  timestamptz default now()
);
create index if not exists notes_plan on notes (plan_id);

create table if not exists sku_traces (                -- SKU 設計軌跡（8.4）：草稿版、正式版分開
  sku      text primary key,
  draft    jsonb,
  official jsonb
);

-- ---------- 紀錄、通知 ----------
create table if not exists audit_log (                 -- 8.5：只准新增，沒有人改得了、刪得了
  id       text primary key,
  at       timestamptz not null default now(),
  who      text,
  who_name text,
  email    text,
  what     text not null,
  target   text,
  result   text not null,
  detail   text
);
create index if not exists audit_email on audit_log (email, at desc);

create table if not exists notifications (             -- 7.5 站內通知
  id    text primary key,
  to_id text not null references members(employee_id),
  at    timestamptz not null default now(),
  text  text not null,
  link  text,
  kind  text,
  read  boolean not null default false
);
create index if not exists notifications_to on notifications (to_id, at desc);

create table if not exists sweep_state (key text primary key, at timestamptz default now());  -- 延遲通知發過了沒（rules.sweep 的 db.sent）

-- ---------- 誰是誰 ----------
-- 登入的 Google 帳號 → 人員資料裡在職的那一位。查不到＝沒有權限（所有 policy 都靠它）。
create or replace function me() returns text
language sql stable security definer set search_path = public as $$
  select employee_id from members where lower(email) = lower(auth.email()) and is_active limit 1
$$;

-- ---------- RLS：只開讀 ----------
alter table members enable row level security;
alter table assignments enable row level security;
alter table products enable row level security;
alter table reviewer_settings enable row level security;
alter table delegations enable row level security;
alter table announcements enable row level security;
alter table plans enable row level security;
alter table blocks enable row level security;
alter table cells enable row level security;
alter table notes enable row level security;
alter table sku_traces enable row level security;
alter table audit_log enable row level security;
alter table notifications enable row level security;
alter table sweep_state enable row level security;

do $$
declare t text;
begin
  -- 在職、名單上的人讀得到的表（整份 DM 的進度所有人都看得到，7.4 第 7 點）
  foreach t in array array['members','assignments','reviewer_settings','delegations','announcements','plans','blocks','cells','notes','sku_traces']
  loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_read') then
      execute format('create policy %I on %I for select to authenticated using (me() is not null)', t || '_read', t);
    end if;
  end loop;
end $$;

-- 商品：PM 只看得到自己（和代理的）分類的商品＋贈品配件；設計、行銷看全部（2.4 最小權限）
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'products' and policyname = 'products_read') then
    create policy products_read on products for select to authenticated using (
      me() is not null and (
        (select role from members where employee_id = me()) <> 'pm'
        or category_id = '900'
        or category_id in (
          select a.category_id from assignments a
          where a.owner_id = me()
             or a.owner_id in (select d.from_id from delegations d
                               where d.to_id = me() and d.cancelled_at is null and d.overridden_by is null
                                 and now() >= d.start_at and now() < d.end_at))
      ));
  end if;
end $$;

-- 紀錄：一般人只讀得到自己的（登入紀錄那一段），全部的看後台
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'audit_log' and policyname = 'audit_own') then
    create policy audit_own on audit_log for select to authenticated using (lower(email) = lower(auth.email()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'notifications' and policyname = 'notifications_own') then
    create policy notifications_own on notifications for select to authenticated using (to_id = me());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'notifications' and policyname = 'notifications_mark_read') then
    create policy notifications_mark_read on notifications for update to authenticated using (to_id = me()) with check (to_id = me());
  end if;
end $$;
-- 只准改 read 那一欄
revoke update on notifications from authenticated;
grant update (read) on notifications to authenticated;

-- ---------- 登入頁的公開看板 ----------
-- ⚠️ 給 anon 讀：只有名字、走到哪、截止時間。檔期名稱算不算機密要問公司，
--    是的話把 plans 那一段拿掉，只留公告。
create or replace view public_board as
  select 'plan' as kind, p.id, p.name, p.type, p.public_stage as stage, p.public_due as due, p.schedule, null::date as date, null::text as text
    from plans p where p.published is null
  union all
  select 'news', a.id, null, null, null, null, null, a.date, a.text from announcements a;
grant select on public_board to anon, authenticated;
