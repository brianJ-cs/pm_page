# TODO — 照順序做，每一步一段可以直接貼給 Claude 的 prompt

> 搭配 `CARE-PACKAGE-supabase-netlify.md` 一起用。那份是「為什麼、細節」，這份是「照著貼」。
> 每一步做完、綠燈了，再貼下一步。別一次全貼。

---

## 先準備：root 資料夾要有這些檔案

**從這個 repo 帶過去（已存在）**
- [ ] `落版單系統.html` —— 行銷前台
- [ ] `design_and_PM.html` —— 編輯器原始檔（要改的是這支）
- [ ] `2cell-product-pick.html` —— 編輯器的商品版面（被上面那支嵌用）
- [ ] `build-single.mjs` —— 把上面兩支打包成單檔
- [ ] `dm-editor-single.html` —— 打包產物（可重建，帶著也行）
- [ ] `CARE-PACKAGE-supabase-netlify.md` —— 詳細說明書
- [ ] `TODO-supabase-netlify.md` —— 這份
- [ ] `CLAUDE.md`、`GLOSSARY.md` —— 專案規範，Claude 要先讀
- [ ] `.claude/skills/run-pm-page/driver.mjs` —— 驗收用的 headless 檢查（整個 `.claude/` 資料夾帶著）

**你在 Supabase 後台拿到、要自己填**
- [ ] Supabase **Project URL**、**anon public key**（Settings → API）

**這次會「新建」的檔案（下面步驟會產生）**
- [ ] `config.js` —— 放 Supabase URL + anon key
- [ ] `supabase-sync.js` —— fetch 同步層
- [ ] `_redirects` —— Netlify 路徑對應

> 最省事：直接 `git clone` 整個 repo 到新機器，該有的就都有了。Node 也要裝（跑 build 和 driver）。

---

## Step 0 — 讓 Claude 先建立心智模型（貼這段）

```
先讀這個 repo 的 CLAUDE.md、GLOSSARY.md、CARE-PACKAGE-supabase-netlify.md，
還有 落版單系統.html 和 design_and_PM.html 的開頭與資料相關部分。
讀完用三句話跟我確認：(1) 這兩支的關係與現在怎麼交接資料，
(2) catalogue_plans_v1 和 plan 物件的角色，(3) 為什麼 dm-editor-single.html 不能直接改。
先不要動任何檔案。
```

## Step 1 — 核對 layout 樹形狀相容（貼這段）

```
我要把「落版單系統」切好的版位交給「design_and_PM」的編輯器用。
請核對兩邊 plan.layout 樹的形狀是否相容：落版單系統「版位切割 / 提交給設計」
產生的樹葉版位欄位（groups / name / count / dir / children / size 等），
對上 design_and_PM 期望的形狀（用 window.exportLayout() 觀察）。
把對得起來、對不起來的欄位列給我。若有落差，寫一個 normalizeLayout() 轉換，
但先給我看你的計畫，別直接改檔。
```

## Step 2 — 建 Supabase 資料表（自己做，或貼給 Claude 產 SQL）

```
照 CARE-PACKAGE 第 4.1 節給我 Supabase SQL：建 public.plans（id text, data jsonb,
updated_at）和 plans_trash，開 RLS、加一條 anon 可讀寫的 policy（MVP 先開放）。
只要 SQL，我自己貼到 Supabase SQL Editor 跑。
```
做完把 Project URL、anon key 記下來。

## Step 3 — 產生 config.js 與 supabase-sync.js（貼這段）

```
照 CARE-PACKAGE 第 4.2 節，在 root 建立兩支新檔：
1) config.js —— 用我等下給你的 Supabase URL 和 anon key（先放佔位符）。
2) supabase-sync.js —— 零相依、用 fetch 打 PostgREST 的同步層（pullAll / upsert /
   remove / queueUpsert(debounce 600ms) / flush，掛在 window.PlanSync）。
建好後不要動兩支 HTML，先讓我把真正的 URL/key 填進 config.js。
```
然後自己把 `config.js` 裡的佔位符換成真的 URL/anon key。

## Step 4 — 先接「編輯器」一支，驗證跨機器同步（貼這段）

```
只改 design_and_PM.html（不要碰 dm-editor-single.html）：照 CARE-PACKAGE 第 4.4 節，
在所有現有 <script> 之後加入 config.js、supabase-sync.js，和一段開機同步塊：
開機先 pullAll 覆蓋本機再重畫首頁；並包一層 savePlans() 讓存檔後 debounce 上傳
（MVP 先只上傳「當前編輯的那個 plan」以免互相蓋）；再吃網址 ?plan=<id> 自動開該檔期。
貼之前先 grep 確認實際函式名（首頁重畫、開檔期那幾個）。
改完 node build-single.mjs 重建，再跑 CARE-PACKAGE 第 8 節的 driver 驗證沒有 console error。
```
**手動驗收**：A 機器開編輯器改個東西 → B 機器（或無痕視窗）重開 → 有沒有拉到最新。

## Step 5 — 接「落版單系統」＋打通提交（貼這段）

```
改 落版單系統.html：照 CARE-PACKAGE 第 4.3 節加同一組 config.js / supabase-sync.js /
開機同步塊（首頁重畫函式用它自己的）。再把「提交給設計」的 handler 改成：
先 await PlanSync.flush() 確保存上去，再導向 editor?plan=<該檔期 id>；
原本的檔案下載可留可拿掉（留著當備援）。改完跑起來確認開機不報錯、提交會跳轉。
```

## Step 6 — Netlify 部署（貼這段）

```
照 CARE-PACKAGE 第 4.7 節準備 Netlify 部署：
建 _redirects（/ → 落版單系統, /editor → 編輯器單檔），
告訴我要把哪些檔案放進發佈資料夾、以及用「拖拉部署」還是「接 Git（build command 留空/或 node build-single.mjs）」各自怎麼設。
先給我步驟清單，我自己上 Netlify 操作。
```

## Step 7 — 一次性搬舊資料（若舊機器 localStorage 有既有檔期，貼這段）

```
給我 CARE-PACKAGE 第 5 節那段 console 指令，把舊機器 localStorage 裡的
catalogue_plans_v1 全部 upsert 上 Supabase。
```

## Step 8 — 收尾驗收（貼這段）

```
跑一遍 CARE-PACKAGE 第 8 節的驗收清單，逐項回報過或沒過。
特別確認：沒設 config 時會退回純 localStorage（rollback 有效）、
關網路仍能用、layout 的品類數量正確從行銷帶到設計。
```

---

## 之後才做（先別碰）
- per-plan 拆欄降低多人衝突（CARE-PACKAGE 第 6 節）
- Supabase Auth（Magic Link）＋收緊 RLS（第 7 節）
- realtime 即時同步（會第一次引入 supabase-js，第 7 節）
