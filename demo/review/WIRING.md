# 審核系統雛形：怎麼跑、怎麼接上 Supabase

依據《DM 審核流程實作指南 v1.1》（`main process/DM審核流程實作指南.md`）。
這一包是**雛形**：流程、權限、畫面都照正式的做，但資料存在這台瀏覽器，格子是假的（不接排版畫布）。

## 怎麼跑

- 直接用瀏覽器打開 `demo/review/index.html`，不用裝任何東西。
- 畫面照主程式（`design_and_PM.html`）的樣子做：檔期列表、編輯器那一條、總體／落版／商品／進度、
  左邊一條工具、右邊的版位／字級／意見。**真的會動的只有審核**：
  「輪到你」在檔期列表最上面、格子的狀態寫在格子底下、審核的按鈕在「意見」那一頁、整份 DM 在紙的上緣和「進度」裡。
  總體、落版、左邊那一條工具、字級、匯出、商品目錄那幾顆只是長得像，按了會講一句「在主程式裡」。
- 右下角 🛠 是測試工具：
  - **換人**：直接以某人登入，也可以把人標成離職
  - **時鐘**：撥系統的「現在」，看延遲；另外可以模擬 07:00 差勤同步失敗
  - **快轉**：把檔期推到任何一關（從提明細到出稿），補的資料跟一路點過來的一樣
  - **紀錄**：全部的稽核紀錄
- 網址帶 `?as=員工編號`（例如 `?as=E10118`）直接以那個人登入。
- 規則測試：`node demo/review/rules.test.mjs`（138 項，涵蓋實作指南裡每一個略過、退件的例子）。

## 檔案

| 檔案 | 做什麼 | 接上 Supabase 之後 |
|---|---|---|
| `index.html` | 所有畫面 | **不改** |
| `rules.js` | 所有規則：誰能按什麼、按了之後往哪走、略過、退件、延遲、待辦 | **整支搬到 Edge Function**，瀏覽器那一份照樣留著（用來決定按鈕亮不亮） |
| `store.js` | 資料層。本機模式扮演後端 | 填最下面 `SUPABASE` 那一段（每一支對應哪個端點已經寫好） |
| `seed.js` | 假資料 | 不用了（人員、分類、商品由全國電子推送） |
| `supabase/schema.sql` | 建表、RLS 草稿（**還沒執行過**） | 在 SQL Editor 跑一次 |
| `rules.test.mjs` | 規則測試 | Edge Function 那一份也用它測 |

## 為什麼接上去幾乎不用改畫面

1. **畫面只送「動作」**：例如 `act('stamp', { cell_id })`。是誰按的由登入狀態決定，畫面不說。
2. **判斷全在 `rules.js`**：零相依、沒有 DOM、輸入輸出都是純資料。本機模式在 `store.js` 裡呼叫它，
   接上之後在 Edge Function 裡呼叫**同一支**。
3. **每一支都是非同步的**：本機模式也故意慢一點，所以「送出中…」「確認權限中…」現在就看得到。
4. **紀錄由後端寫**：`act()` 做完才記，被拒也記（未授權操作被拒，8.3）。

## 接線步驟

### 1. 建表

在 Supabase 的 SQL Editor 跑 `supabase/schema.sql`。重點：

- **只開讀的 RLS**。寫入全部走 Edge Function（它用 service role，先跑 `rules.can()` 再寫），
  所以瀏覽器拿使用者權杖直接打 REST，一張表都寫不進去。
- 例外：通知只准改自己的 `read` 欄位；登入頁的 `public_board` 給 anon 讀。
- `me()` 把登入的 Google 帳號對到人員資料裡在職的那一位，查不到＝沒有權限。

### 2. 登入

- Supabase → Authentication → Providers → Google 打開，填公司的 OAuth client。
- 授權不靠 Google 網域，靠**人員資料**：`whoami` 查不到、或 `is_active = false` 就擋下並寫紀錄。
  （之後可以另外加 `hd=公司網域` 參數，讓選帳號那一頁只列公司帳號。）
- `store.js` 的 `auth.signIn()` 換成整頁轉去
  `/auth/v1/authorize?provider=google&redirect_to=<這一頁>`；轉回來之後頁面照常開機，
  發現有權杖就叫 `whoami({ fresh: true })`。模擬的選帳號窗就不會出現了。

### 3. Edge Function `review`

一支函式、用 `op` 分：`whoami`、`todo`、`plans`、`plan`、`progress`、`settings`、`delegations`、`act`、`sweep`。

```ts
// supabase/functions/review/index.ts（示意）
import './rules.js';                       // 同一支，掛在 globalThis.ReviewRules
const R = (globalThis as any).ReviewRules;

Deno.serve(async req => {
  const user = await userFromJwt(req);      // Supabase JWT → email
  const { op, ...p } = await req.json();
  const db = await loadDb(p.plan_id);        // 讀成跟本機模式一模一樣的形狀（見下）
  const me = R.authorize(user.email, db);
  if (!me.ok) return json(me);               // 並寫一筆「登入被拒」／「未授權」
  if (op === 'act') {
    const res = R.act(db, me.member.employee_id, p.action, p.payload, Date.now());
    await commit(db, p.plan_id);             // 比對前後、只寫改過的列，見「同時按」
    return json(res);
  }
  // …其他 op 對應 rules.todo / planView / categoryProgress …
});
```

**`loadDb` 讀哪些**：members、assignments、reviewer_settings、有效的 delegations、這一份 plan 的
plans／blocks／cells／notes、這份 plan 用到的 sku_traces、products（只有 `act` 的挑貨、贈品需要）、
Storage 上商品圖的檔名清單（圖片比對用，只有設計的 `plan` 需要）。

**同時按**：兩位 PM 同時按同一個版位的一校完成，只能有一個人讓它換關。`plans.rev` 當樂觀鎖：
`commit` 在一個 RPC（`review_commit(plan_id, expect_rev, changes jsonb)`）裡檢查 rev、寫入、rev + 1；
rev 對不上就重新 `loadDb` 再跑一次 `act`（最多三次）—— 跟主程式 `PlanSync.writeOne` 同一套想法。

### 4. 排程

- **延遲通知**：`pg_cron` 每 10 分鐘呼叫 `review` 的 `sweep`（跑 `rules.sweep`）。
  本機模式沒有排程，是每次讀資料時掃一次，結果一樣。
- **07:00 差勤同步**：從全國電子差勤取請假和代理，寫進 `delegations`（`source = 'sync'`）。
  失敗時通知系統管理者和當天有請假的 PM 的課長（本機模式用 🛠 → 時鐘 → 模擬）。

### 5. 通知寄出去

`notifications` 表現在只在站內顯示（右上角的鈴）。要寄信或推播，在這張表加一個 insert trigger
接寄信服務就好，規則不必動。

### 6. 打開開關

```html
<script>window.REVIEW_BACKEND = { mode: 'supabase', url: '…', anonKey: '…' };</script>
```

放在 `store.js` 前面。沒設就是本機模式（也是 rollback：拿掉這一行就退回本機）。

## 要問公司的事

1. **登入頁右邊的「進行中的檔期」**：不用登入就看得到檔期名稱。名稱算機密的話，那一欄只留公告和聯絡窗口。
2. **行銷處協理、律師的 role**：需求書只准 design／pm／mkt，雛形先填 mkt。
3. **系統管理者**：差勤同步失敗要通知他，但人員資料裡沒有這個身分。
4. **通知的管道**：站內、email、還是 LINE？
5. **AI／PDF／JPG 輸出**：出稿那一步雛形只寫正式版軌跡，檔案輸出要等接上排版程式。

## 指南沒寫清楚、雛形先這樣做的（都可以推翻）

| # | 事項 | 雛形的做法 |
|---|---|---|
| 1 | 二校時課長退了其中幾格，其他格要不要等 | 部長要等這個版位每一格都過了課長那一關才開始 |
| 2 | 一改的「便利貼都已處理」 | 每一張都要被設計標成「已處理」 |
| 3 | 主管怎麼按 | 一顆送出鈕：有貼便利貼的格子＝退件，其他＝通過；按鈕上直接寫幾格通過、幾格退件 |
| 4 | PM 在退件循環裡再退回設計 | 也要附便利貼 |
| 5 | 退件的人重審 | 一格一格按「通過」或「再退件」，不必等整個版位 |
| 6 | 最終審核者退了幾格之後 | 那幾格都重審通過，他這一關自動算通過，不必再按一次 |
| 7 | PM 蓋章前發現要調整 | 貼便利貼，按「送出調整」；改好回來的「蓋章 N」就是一般蓋章 |
| 8 | 延遲通知的單位 | 一個品類一個階段發一次，不是一格發一次（不然一次幾十則） |
| 9 | 「出稿日前 2 天」是幾點 | 出稿那一天往前 2 天的 00:00 |
| 10 | 贈品圖片 | 用商品編號比對圖檔清單（跟商品圖同一套），找不到就顯示缺圖 |
