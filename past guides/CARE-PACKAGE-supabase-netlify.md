# Care Package — 把「落版單系統」＋「落版／拼板編輯器」接起來，上 Supabase + Netlify

> 這份是給**另一台機器／另一個 Claude 帳號**照著做的完整說明書。假設你手上只有這個 git repo，
> 沒有看過先前的對話。照第 4 節一步一步做即可。先讀完第 1～3 節建立心智模型，別急著貼程式。
>
> **這個 repo 的鐵則（照做，會省下很多來回）**
> - 兩支都是**單檔 HTML、沒有 build、沒有 npm、沒有相依套件**，瀏覽器直接開就是完整程式。上 Supabase 會**第一次**引入一點網路相依 —— 我們用 `fetch` 打 Supabase 的 REST，**不引入任何 CDN 函式庫**，維持單檔精神。
> - `dm-editor-single.html` 是 **`node build-single.mjs` 產生的**，**永遠不要直接改它**。改 `design_and_PM.html` 和 `2cell-product-pick.html`，再重新 build。
> - 整支程式是一個 `<script>`：頂層呼叫一個「下面才宣告的 `let`」會 `ReferenceError` → 整頁死掉，但檔案 parse 完全正常。**每次改完一定要真的跑起來看**（見第 8 節的 driver）。
> - 先讀 `CLAUDE.md` 和 `GLOSSARY.md`。「block」在這專案有三個意思（版位／格／零件），別搞混。
> - 檔案編碼會有 LF/CRLF 警告，無視即可。

---

## 1. 這兩支是什麼、本來怎麼接

| 檔案 | 角色 | 大概內容 |
|---|---|---|
| `落版單系統.html` | **行銷前台** | 首頁＝檔期列表＋「行銷開檔」（排期程、貼標籤）。進一個檔期＝看階段時程。再進「版位切割」＝把整張 DM 切成一塊一塊**版位**、每塊派**品類＋數量**，最後「提交給設計」。 |
| `design_and_PM.html` ＋ `2cell-product-pick.html` → build 成 `dm-editor-single.html` | **設計／PM 編輯器** | 檔期列表 → 開檔期 → 總體／落版／拼板。設計把每個版位真正的商品版面拼出來。 |

**關鍵事實（已查證）**：兩支**都**用同一個 localStorage key

```js
const LS_KEY = 'catalogue_plans_v1';   // 兩支檔案裡都是這一行
```

而且**同一套 plan 物件結構**（見第 2 節）。也就是說：這兩支本來就是設計來共用同一份資料的 —— 在**同一台瀏覽器**上它們其實已經自動共享。跨人、跨機器不通，只能靠「提交給設計＝下載一個內嵌 JSON 的 `.html`」，設計端再用「帶入」讀回來。

**流程現況**
```
行銷：開檔 → 切版位／派品類數量 → 提交給設計（下載 落版單_xxx.html）
                                              │  ← 用檔案手動傳
設計：帶入該檔 → 總體／落版／拼板 → 存 localStorage
```

**這次要做的**：把中間那條「手動傳檔」換成 **Supabase 共用資料庫**，兩支都部署到 **Netlify**，變成一套線上系統：

```
行銷開檔／切版位 ──▶ Supabase(plans 表) ◀── 設計 落版／拼板
        兩邊即時看到同一份檔期，不再傳檔
```

---

## 2. 資料模型（plan 物件）——這是兩邊的合約

一個 `plan` 大概長這樣（欄位以 repo 內實際程式為準，這裡列會用到的）：

```jsonc
{
  "id": "seed-2",                     // 唯一 id，兩邊都用它認同一個檔期
  "name": "7月中檔・全省對開大DM",
  "type": "全省對開大DM",
  "tags": ["大DM","促銷"],
  "start": "2026-07-17",              // 檔期起日（行銷端排期用）
  "durs": [2,2,1,1,1,1,2,1,1,1],      // 各階段工作天（行銷端）
  "stageOverride": null,              // 手動指定目前階段（行銷端）
  "layout": { "front": {…tree…}, "back": {…tree…} },  // ★ 版面樹：行銷切、設計填
  "guides": { "front": [], "back": [] }
}
```

- **`layout`** 是核心交接物。行銷端「版位切割」產生 front/back 兩棵切割樹，樹葉＝**版位**，每個版位帶 `groups: [{name, count}]`（派了哪些品類、各幾支）。
- 設計端 (`design_and_PM.html`) 讀同一棵 `layout`，樹葉版位再長出 `sheet`（cells、masthead、confirmed、pm、拼好的畫布…）。`sheet` 是**設計端 lazy 建立**的（見 `sheetOf()`），行銷端不碰。
- **交接語意**：設計按「確認列排列（鎖定）」＝ `sheet.confirmed=true` ＝交回給 PM／行銷可見。鎖定前那個版位對 PM 不存在。

> ⚠️ **上手第一件事：核對 `layout` 樹的實際形狀在兩支之間相容。**
> 打開 `落版單系統.html`、行銷切幾塊版位、提交，看下載檔裡的 JSON；再打開 `design_and_PM.html?seed=1`、`window.exportLayout()`（console）看它期望的形狀。確認**版位節點的欄位名**（`groups`/`name`/`count`/`dir`/`children`/`size` 之類）對得起來。若有落差，寫一個小 `normalizeLayout()` 轉一次 —— 別讓形狀不合默默壞掉。

---

## 3. 目標架構

```
        ┌──────────── Netlify (靜態代管) ────────────┐
        │  /                → 落版單系統.html (首頁)   │
        │  /editor          → dm-editor-single.html   │
        │  /config.js       → Supabase URL + anon key │
        └───────────────┬────────────────────────────┘
                        │  fetch (REST / PostgREST)
                        ▼
        ┌──────────── Supabase ──────────────────────┐
        │  Postgres: public.plans (id text, data jsonb│
        │            , updated_at timestamptz)        │
        │  RLS + policy（先開放，之後可加 Auth）       │
        └─────────────────────────────────────────────┘
```

**幾個刻意的選擇**

1. **維持兩支獨立、不合併成一支。** 兩支都是很大的單檔程式、各有一份檔期列表，硬合併風險極高、收益低。改成：`落版單系統.html` 當首頁，「提交給設計 / 開始落版」用**深連結**跳到 `editor?plan=<id>`；兩邊共用 Supabase。要之後再合併是另一個題目。
2. **不引入 supabase-js CDN，用 `fetch` 打 PostgREST。** Supabase 每張表自動有 REST 端點 `https://<proj>.supabase.co/rest/v1/plans`，帶 `apikey` header 就能 CRUD。這樣維持「單檔、零函式庫」。（要 realtime／Auth 再考慮引 `@supabase/supabase-js`，見第 7 節。）
3. **Local-first 同步，不改同步式流程。** 兩支現在都是同步 `localStorage` 讀寫。我們**保留 localStorage 當本機快取**，另外掛一層：開機先用 localStorage 秒開，再向 Supabase 拉一次覆蓋；每次 `savePlans()` 照舊寫 localStorage，**外加** debounce 上傳。這樣幾乎不動原本同步邏輯，最穩。
4. **anon key 直接寫在 `config.js`。** anon key 設計上就是公開的，安全靠 RLS。單檔沒有 build、讀不到環境變數，所以用一個小 `config.js` 注入（或直接硬寫在每支檔案頂端）。

---

## 4. 一步一步做

### 4.1 建 Supabase 專案 + 資料表

1. supabase.com 建 project，記下 **Project URL** 和 **anon public key**（Settings → API）。
2. SQL Editor 跑：

```sql
create table if not exists public.plans (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- 垃圾桶（落版單系統有 trash，選配）
create table if not exists public.plans_trash (
  id text primary key, data jsonb not null, updated_at timestamptz not null default now()
);

alter table public.plans        enable row level security;
alter table public.plans_trash  enable row level security;

-- MVP：先「開放」給 anon 讀寫（內部工具、網址不外流）。要收緊看第 7 節。
create policy "anon rw plans" on public.plans
  for all to anon using (true) with check (true);
create policy "anon rw trash" on public.plans_trash
  for all to anon using (true) with check (true);
```

> 之後要多人不互相蓋，把 `plans` 拆更細（例如 `layout` 獨立一欄、行銷欄位獨立一欄）能降低衝突，但 MVP 用整包 `data jsonb` 最省事。

### 4.2 共用資料層 shim（丟進 repo，一支新檔）

新增 `supabase-sync.js`（純 `fetch`，兩支都 include）。介面刻意做成「跟操作 plans 陣列一樣」：

```js
// supabase-sync.js —— 零相依，靠 window.SUPABASE 設定（見 config.js）
(function () {
  const CFG = window.SUPABASE || {};
  const BASE = CFG.url ? CFG.url.replace(/\/$/, '') + '/rest/v1' : null;
  const H = () => ({
    'apikey': CFG.anonKey,
    'Authorization': 'Bearer ' + (CFG.accessToken || CFG.anonKey),
    'Content-Type': 'application/json'
  });
  const ok = () => !!(BASE && CFG.anonKey);

  async function pullAll(table = 'plans') {          // → [{id,data,updated_at}]
    if (!ok()) return null;
    const r = await fetch(`${BASE}/${table}?select=*`, { headers: H() });
    if (!r.ok) throw new Error('pull ' + r.status);
    return r.json();
  }
  async function upsert(rows, table = 'plans') {     // rows: [{id, data}]
    if (!ok() || !rows.length) return;
    const body = rows.map(x => ({ id: x.id, data: x.data, updated_at: new Date().toISOString() }));
    const r = await fetch(`${BASE}/${table}`, {
      method: 'POST',
      headers: { ...H(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('upsert ' + r.status);
  }
  async function remove(ids, table = 'plans') {
    if (!ok() || !ids.length) return;
    const inList = '(' + ids.map(encodeURIComponent).join(',') + ')';
    await fetch(`${BASE}/${table}?id=in.${inList}`, { method: 'DELETE', headers: H() });
  }

  // debounce 上傳：把「哪些 plan 髒了」收在一起，靜一下再送
  let dirty = new Map(), timer = 0;
  function queueUpsert(plan) {
    dirty.set(plan.id, plan);
    clearTimeout(timer);
    timer = setTimeout(flush, 600);
  }
  async function flush() {
    const rows = [...dirty.values()].map(p => ({ id: p.id, data: p }));
    dirty.clear();
    try { await upsert(rows); } catch (e) { console.warn('sync 上傳失敗', e); }
  }

  window.PlanSync = { ok, pullAll, upsert, remove, queueUpsert, flush };
})();
```

`config.js`（Netlify 上跟 HTML 放一起；**anon key 是公開安全的**）：

```js
window.SUPABASE = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-ANON-PUBLIC-KEY'
};
```

### 4.3 接上「落版單系統.html」

在 `</body>` 前（其他 `<script>` **之後**，這樣 `plans`、`savePlans` 都已宣告）加：

```html
<script src="config.js"></script>
<script src="supabase-sync.js"></script>
<script>
(async function () {
  if (!window.PlanSync || !PlanSync.ok()) return;   // 沒設定就退回純 localStorage
  // 開機拉一次：Supabase 有的覆蓋本機，然後重畫首頁
  try {
    const rows = await PlanSync.pullAll();
    if (rows && rows.length) {
      const byId = new Map(plans.map(p => [p.id, p]));
      rows.forEach(r => byId.set(r.id, r.data));      // 遠端為準（MVP）
      plans = [...byId.values()];
      savePlans();                                    // 寫回本機快取
      if (typeof renderHome === 'function') renderHome();
    }
  } catch (e) { console.warn('初次同步失敗，先用本機資料', e); }

  // 每次存檔順手上傳「當下這個檔期」。找出程式裡實際存檔的地方：
  //   savePlans() 之後、或每個會改到某個 plan 的動作，呼叫 PlanSync.queueUpsert(該 plan)
  // 最省事：包一層 savePlans。但 savePlans 不知道「哪個 plan 髒了」，所以：
  const _save = savePlans;
  window.savePlans = function () {
    _save.apply(this, arguments);
    if (PlanSync.ok()) plans.forEach(p => PlanSync.queueUpsert(p));  // MVP：全上傳(debounced)
  };
})();
</script>
```

> **「提交給設計」改成不再下載檔案、而是導去編輯器。** 找到 `submitBtn` 的 handler（約在 `exportPlanFile(...)`／`toast('已提交給設計…')` 附近）。把「下載 `.html`」換成：先 `await PlanSync.flush()` 確保存上去，再 `location.href = 'editor?plan=' + encodeURIComponent(draft.id)`。想保留下載當備份也可以兩者都留。

### 4.4 接上編輯器（改 `design_and_PM.html`，別改單檔）

一樣在所有 `<script>` 之後加同一組 `config.js` + `supabase-sync.js` + 開機同步塊（跟 4.3 幾乎一樣，把 `renderHome` 換成它自己的首頁重畫函式，例如 `renderPlans`）。另外**吃深連結 `?plan=`**：

```js
// 開機同步完成後：若網址帶 ?plan=，直接開那個檔期
const want = new URLSearchParams(location.search).get('plan');
if (want) {
  const p = plans.find(x => x.id === want);
  if (p && typeof openPlan === 'function') openPlan(p);   // openPlan 名稱以實際程式為準
}
```

存檔同步：這支已有 `savePlans()`（見 `design_and_PM.html`），照 4.3 同樣包一層即可。它另有 `markDirty()` / `commitAction()` —— 那些最終也會走到寫 localStorage，確認它們有呼叫 `savePlans` 或在那裡也 `queueUpsert`。

**改完務必 rebuild：**
```bash
node build-single.mjs
```
然後 `dm-editor-single.html` 才會含上你的改動。Netlify 部署的是 build 後的單檔（或你也可以部署 `design_and_PM.html` + `2cell-product-pick.html` 兩支原始檔，看 4.7）。

### 4.5 打通導覽（deep link）

- 行銷「提交給設計」→ `editor?plan=<id>`（4.3）。
- 編輯器讀 `?plan=<id>` 自動開該檔期（4.4）。
- 兩邊首頁都可加一顆「切換到另一個系統」的連結。
- Netlify 上把路徑對應好（4.7 的 `_redirects`），`/` = 行銷、`/editor` = 編輯器。

### 4.6 沒有 build 的設定注入

就用 `config.js`（4.2）。要換專案／key 只改這一支。**不要**把 service_role key 放進去（那把是全權限、不可公開）——只用 anon。

### 4.7 部署到 Netlify

兩條路，挑一條：

**A. 拖拉部署（最快）**
1. 把要公開的檔案放一個資料夾：`index.html`（＝`落版單系統.html` 改名）、`editor.html`（＝`dm-editor-single.html` 改名）、`config.js`、`supabase-sync.js`、還有編輯器若走「兩支原始檔」則再加 `2cell-product-pick.html`。
2. `_redirects`（純文字，放同資料夾）：
   ```
   /            /index.html    200
   /editor      /editor.html   200
   ```
3. app.netlify.com → 拖整個資料夾上去。得到網址。

**B. 接 Git（之後好維護）**
1. 這個 repo 推上 GitHub。
2. Netlify → New site from Git → 選 repo。
3. **Build command 留空、Publish directory 設成含上述檔案的資料夾**（例如 repo 根目錄，或做一個 `public/`）。因為沒有 build，Netlify 只是把靜態檔搬上去。
4. 若想每次自動 `node build-single.mjs`：Build command 填 `node build-single.mjs`（Netlify 有 Node）、publish 目錄放產物。**但**要確保 build 後產物路徑對得上 `_redirects`。

> Netlify 不需要環境變數（設定在 `config.js`）。若你偏好用 env，得加一個 build 步驟把 env 寫進 `config.js` —— 但那就破壞了「無 build」，MVP 不建議。

---

## 5. 一次性搬移舊資料（localStorage → Supabase）

行銷或設計電腦上若已有既有檔期在 localStorage：開該頁、console 跑一次：

```js
JSON.parse(localStorage.getItem('catalogue_plans_v1') || '[]')
  .forEach(p => PlanSync.queueUpsert(p));
await PlanSync.flush();
```

跑完 Supabase 的 `plans` 表就有了。之後所有機器開機都會拉到同一份。

---

## 6. 併發／衝突（先知道，別被雷到）

- MVP 是**整包 plan、last-write-wins**。兩個人同時改**同一個檔期**，後存的蓋前存的。
- 降風險順序：
  1. 只上傳「當下編輯中的那個 plan」而不是全部（把 4.3 的 `plans.forEach` 換成只 `queueUpsert(當前 plan)`）。這樣行銷改 A 檔、設計改 B 檔就不會互蓋。
  2. 表結構拆欄：`plans(id, marketing jsonb, layout jsonb, updated_at)`，行銷只寫 `marketing`、設計只寫 `layout`。用 PostgREST 的 `PATCH` 只改自己那欄。**這是真正解**，但要多改一點讀寫對應。
  3. 要「別人改了我馬上看到」＝ realtime（第 7 節）。
- 加個 `updated_at` 檢查：上傳前先 `GET` 比對，發現遠端比較新就提示「這個檔期在別處被改過，要覆蓋嗎」。

---

## 7. 帳號（Auth）選項

- **先不做**：anon + 開放 policy。網址不外流即可，最快。（MVP 就這個。）
- **加 Auth（建議之後做）**：Supabase Auth 開 Magic Link / Email。前端要用 `@supabase/supabase-js`（這時才引 CDN），登入後拿 `access_token` 塞進 `window.SUPABASE.accessToken`，`supabase-sync.js` 的 header 就會帶它。policy 改成 `to authenticated`。
- **要 realtime**（多人即時同步）：也需要 `supabase-js` 的 realtime channel，訂 `plans` 表的變更 → 收到就 merge 進 `plans` 並重畫。這會第一次違反「零函式庫」，接受與否你決定。

---

## 8. 驗收清單（每步都要真的跑起來看）

repo 內有 headless 檢查工具，改完務必跑（它會印 `ok — no console errors, no exceptions`，有錯 exit 1）：

```bash
node build-single.mjs   # 先重出單檔
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?seed=1" \
  --wait 700 --click ".plan-card .btn.open" --wait 800 \
  --click-text "拼板" --wait 1200 --shot out/check.png
```

功能面 checklist：
- [ ] `落版單系統.html` 開機不報錯；沒設 Supabase 時退回 localStorage 照常用。
- [ ] 設好 `config.js` 後，行銷開一個新檔期 → Supabase `plans` 表出現該列。
- [ ] 「提交給設計」→ 跳到 `editor?plan=<id>` → 編輯器**自動開到同一個檔期**（layout 帶得過來）。
- [ ] 設計在拼板改東西 → 存檔 → 另一台機器（或無痕）重開 → 拉到最新。
- [ ] `layout` 樹形狀在兩邊相容（第 2 節的核對）；版位的品類／數量正確帶到設計端。
- [ ] 關掉網路：兩支仍能用 localStorage 開（local-first 有效），連回來會再同步。
- [ ] Netlify 上 `/` 與 `/editor` 都開得起來、`config.js` 載得到。

---

## 9. 這兩支特有的雷

- **`dm-editor-single.html` 是產物**，改它沒用、下次 build 會蓋掉。改 `design_and_PM.html` / `2cell-product-pick.html` → `node build-single.mjs`。
- **一個 `<script>` 的世界**：新加的同步塊放在**所有原本 script 之後**，才讀得到 `plans`／`savePlans`／`openPlan`／`renderHome` 這些 `let`/`function`。放前面會 `ReferenceError` 整頁死掉、而且「語法沒問題」看不出來。
- **顏色規範**（見 `CLAUDE.md`）：藍色＝「你正在點的東西」；版位底色＝狀態（灰未指派／白設計手上／綠已交出）。加任何 UI 顏色照這套、在 `:root` 取語意名，別亂塞 hex。
- **函式名以實際程式為準**：本文件寫的 `renderHome`／`renderPlans`／`openPlan`／`submitBtn` 是推測名，貼之前先 grep 確認實際名稱。
- **Supabase CORS**：PostgREST 預設允許跨域，anon key 直接 `fetch` 沒問題；若遇到 401 檢查 RLS policy、檢查 header 帶對 `apikey`＋`Authorization`。
- **別把整包 plan 上傳做得太頻繁**：拼板拖曳一次會 `savePlans` 很多次，`queueUpsert` 的 debounce（600ms）就是為此，別拿掉。

---

## 10. 保底

- 全程**保留 localStorage 路徑**：`config.js` 沒設或 Supabase 掛了，`PlanSync.ok()` 回 false，兩支自動退回純本機模式，跟現在一模一樣。這是你的 rollback —— 把 `config.js` 清空就退回單機版。
- 「提交給設計」若也保留原本的檔案下載，就算後端全倒也還能用檔案傳。

---

### 附：最小改動路線（想先看到會動的）
1. 建 Supabase 表（4.1）。
2. 加 `config.js` + `supabase-sync.js`（4.2）。
3. 只接**編輯器**一支的開機拉取＋存檔上傳（4.4 的兩層），先驗證「A 電腦存、B 電腦看到」。
4. 再接行銷、再打通 `提交給設計 → editor?plan=`（4.3/4.5）。
5. 丟上 Netlify（4.7）。
6. 之後再談 per-plan 上傳、Auth、realtime。
