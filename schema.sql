-- ---------------------------------------------------------------------------
-- pm_page 的 Supabase schema
--
-- ⚠️ 這一份是**事後補的**，不是從資料庫匯出來的。
-- 這兩張表當初是在 Supabase 後台用點的（Table Editor）建出來的，所以在這個 repo
-- 裡一直沒有留下任何紀錄 —— 要重建一套環境的時候，沒有人講得出它們長什麼樣。
-- 這支就是補那個洞。欄位是照線上那兩張表實際回傳的東西寫的，跟
-- `past guides/CARE-PACKAGE-supabase-netlify.md` §4.1 給的 plans DDL 一致。
--
-- 對著**已經在跑**的專案跑這一支是安全的：全部 `if not exists`，policy 也只在
-- 那張表還一條都沒有的時候才建（見下面的 DO 區塊）—— 不會去動你在後台點出來的
-- 那幾條，也不會刪任何東西。
--
-- 品牌 Logo 那兩張表（companies／logos）不在這裡，在 `logo_page/schema.sql`。
-- 兩支各自 idempotent，跑在同一個專案裡不會互相踩到（名字一個都沒撞）。
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- plans —— 一列一個檔期，整包 jsonb
--
-- `data` 裡面就是程式裡那個 plan 物件：版位、格子、便利貼、拼好的畫布全部在
-- `data.layout` 底下（所以 snapshot() 一序列化就有了，存檔和 Ctrl+Z 是免費的）。
--
-- ⚠️ 這張表裡**混著不是檔期的列**：`__presence:<userId>` 是「誰在看哪裡」的心跳。
-- 當初借這張表是因為所有東西都只靠 anon key 打 REST，要 create table 就多一個
-- 未必拿得到的權限。所以讀的每一條路都要過 isPlanRow() 濾掉它們 ——
-- 漏一個就會在檔期列表上冒出一張壞掉的卡。
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- catalogue —— 商品目錄，**全公司只有一列**（id = 'default'）
--
-- `data` = { rows:[{cat,brand,name,model,spec,color,sku,price}], model,brand,bimg,img }
-- rows 一列一個 SKU，SKU 就是那個商品的身分（合併是照它取聯集的）。
-- 後面那四張是「商品名 → 值」的舊對照表：品牌和型號現在住在 rows 上，
-- 對照表留著是為了舊資料（見 CLAUDE.md 的「三個庫」那一段）。
--
-- ⚠️ 只有一列，而且是整包覆蓋 —— 從空白狀態存一次就是把全公司的商品刪光。
-- 前端那邊靠 catReady 擋著（讀到之前完全不存），這裡記一筆免得有人以為
-- 這張表可以隨便 upsert。
-- ---------------------------------------------------------------------------
create table if not exists public.catalogue (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.plans     enable row level security;
alter table public.catalogue enable row level security;

-- RLS policy 和 table privilege 是**兩層不同的東西**，兩層都要過。
-- 後台點出來的表 Supabase 會自己給 anon 權限，用 SQL 建的**不會** ——
-- 少了這一段，表和 policy 都建好了，一打 REST 還是 42501 permission denied。
-- （2026-08-11 在這個專案上跑 logo_page/schema.sql 就是踩到這個。）
grant usage on schema public to anon;
grant select, insert, update, delete on public.plans     to anon;
grant select, insert, update, delete on public.catalogue to anon;

-- ---------------------------------------------------------------------------
-- RLS：內部工具，anon 全開（跟 logo_page 那邊同一個取捨）。
--
-- 只在那張表**一條 policy 都還沒有**的時候才建 —— 線上那兩張已經有在後台點出來
-- 的 policy 了，這裡再建一條同義的只是多一條；而 drop 掉別人的更糟（那是唯一
-- 會讓正在用的系統當場壞掉的寫法）。
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'plans') then
    execute $p$create policy "anon rw plans" on public.plans
              for all to anon using (true) with check (true)$p$;
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'catalogue') then
    execute $p$create policy "anon rw catalogue" on public.catalogue
              for all to anon using (true) with check (true)$p$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage
--
-- 商品圖、品牌圖、刊頭圖都走這個 bucket，plan 裡只留一串網址
-- （base64 塞進 plan 會把 localStorage 撐爆、每次存檔重傳好幾 MB）。
-- 檔名＝那個東西的身分，不是使用者的檔名：商品圖用品名、刊頭用
-- `masthead-<檔期>-<版位>` —— 上傳是 upsert，同名就是同一個物件。
--
-- 這個 bucket 是在後台建的（Storage → New bucket → 勾 Public）。
-- 下面這段補齊它的設定，已經存在就只更新那幾個欄位，不動裡面的檔案。
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = excluded.public;

-- policy 同上：只在還沒有人管過這個 bucket 的時候才建。
-- ⚠️ storage.objects 是**所有 bucket 共用**的一張表，所以條件一定要寫
-- `bucket_id = 'product-images'`，不然會順手把別的 bucket 也開了。
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'storage' and tablename = 'objects'
                    and policyname like 'anon % product-images') then
    execute $p$create policy "anon read product-images" on storage.objects
              for select to anon using (bucket_id = 'product-images')$p$;
    execute $p$create policy "anon insert product-images" on storage.objects
              for insert to anon with check (bucket_id = 'product-images')$p$;
    execute $p$create policy "anon update product-images" on storage.objects
              for update to anon using (bucket_id = 'product-images')
                                 with check (bucket_id = 'product-images')$p$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 沒有 plans_trash
--
-- 上面那份舊指南（CARE-PACKAGE §4.1）裡有它，但線上**從來沒建過**
-- （查過：REST 回 404）。回收桶後來改成只存本機的 `catalogue_trash_v1` ——
-- 刻意的：它是給手滑用的，不是版本控制，而且刪除本身是直接把共用那一列拿掉。
-- 所以這裡不建，免得下一個人看到表就以為那件事還在。
-- ---------------------------------------------------------------------------
