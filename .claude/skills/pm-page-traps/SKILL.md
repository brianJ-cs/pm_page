---
name: pm-page-traps
description: pm_page 這個專案踩過的坑，改東西之前先看。包含合成單檔的 $ 陷阱、config.js 連著正式 Supabase（測試會寫到公司資料）、畫布 iframe 裡的變數讀不到、driver 參數的引號地雷、工具手勢被格子上的便利貼記號搶走、總體 改完小地圖不重畫、審核那一邊（review-*.js）的同步和「沒有負責人」，以及該問而沒問的時候會發生什麼。Use when editing design_and_PM.html, 2cell-product-pick.html, build-single.mjs or dev.mjs, when running browser tests against this project, or before saying a change works.
---

# pm_page 踩過的坑

這一份記的是**已經發生過的錯**，不是通則。每一條都花過時間，所以值得先讀一遍。
（`GLOSSARY.md` 是名詞、`CLAUDE.md` 是規矩、這一份是傷疤。）

---

## 一、測試會寫到公司的正式資料

`config.js` 裡是**真的** Supabase 金鑰。用瀏覽器開這幾支頁面時 `PlanSync.ok()` 會回
`true`，於是任何存檔動作都會同步上去。檔期列表上那顆「壓力測試：塞滿假檔期」的 devtool
就往正式資料庫塞過一筆假檔期 —— 它按下去就是新增一筆檔期，同事的列表上會看到。

現在兩邊都預設擋掉了，但要知道為什麼：

- **`driver.mjs` / `scenario.mjs`**：啟動時把 `window.SUPABASE` 釘成唯讀的空設定，
  `config.js` 之後那句賦值會靜靜失敗 → `PlanSync.ok()` 回 false。`file://` 也擋得到。
  真的要測同步才加 `--live`。
- **手動開瀏覽器看**：`PM_NO_SYNC=1 node dev.mjs`，會發一份空的 `config.js`。

**沒有走這兩條路的都算在正式環境上按按鈕**（直接雙擊 HTML、`netlify dev` 不帶
`PM_NO_SYNC`）。特別小心「示範檔期」「清空資料」這種會存檔的按鈕。

---

## 二、`$` 會把 `String.replace` 變成絞肉機

`build-single.mjs --bundle` 要把 96KB 的 HTML 塞進另一支的 `<script>` 裡。
用**字串**當替換內容時，`$'`、`$&`、`` $` `` 都是替換樣式 —— 而商品版面那一頁裡就有
`'$'+b.price` 這種寫法（價格前面的錢字號）。

結果：`$'` 把主程式剩下的兩百多 KB 原封不動塞進那個 JS 字串裡，整包 script 從那裡壞掉，
DOM 跟著錯亂。瀏覽器只說 `SyntaxError: Invalid or unexpected token`，看不出跟 `$` 有關。

```js
main.replace('<body>', () => '<body>\n' + banner)   // 函式：不做任何 $ 展開
```

**辨識法**：build 印出來的大小。`286 KB + 96 KB → 606 KB` 就是壞的（正常是 387 KB）。
現在腳本自己會擋，但同樣的地雷在任何 `replace(x, 字串)` 都成立。

---

## 三、頂層的 `let` 不在 `window` 上

- `design_and_PM.html` 整包在 IIFE 裡 → 外面 `--eval` **完全**讀不到內部變數（`plans`、`setZoom`…）。
- `2cell-product-pick.html` 沒有 IIFE，但頂層是 `let`/`const` → **單獨開**這一頁時 `--eval` 讀得到（同一個 script scope），從**父頁**用 `iframe.contentWindow.BLOCKS` 讀就是 `undefined`。

所以：驗畫布自己的邏輯 → 單獨開 `2cell-product-pick.html` 用 `--eval`；
驗它嵌在拼板裡的行為 → 只能透過 `contentDocument` 問 DOM。

---

## 四、拼板格子裡的零件不能用 `--click` 點

`driver.mjs` 的選擇器會在每個 frame 裡找，第一個命中的往往是**別格**畫布裡的同名元素。
那些格子 `pointer-events` 是關的，但 `elementFromPoint` 在它自己的 document 裡照樣命中 ——
於是點下去只是換了一格。

正確做法：算好座標，直接把 `mousedown`/`mouseup` 派進那一格的 document
（`scenario.mjs` 的 `blk` 場景就是這樣做的，直接用它）。

---

## 五、driver 的參數不要放正規表示式

```bash
--eval "...match(/\"off\":\{[^}]+\}/g)..."     # ✗ 整行卡住，沒有輸出也不會結束
--eval "...split('\"off\":{\"').length-1"      # ✓
```

要數東西就用 `split(...).length - 1`。

---

## 六、每次都重打一長串 driver 參數

`scenario.mjs` 有 `smoke` / `board` / `cell` / `blk` 四個場景，後面照樣可以接 driver 參數，
還多一個 `--assert`（在畫布 iframe 裡跑）。**先看它有沒有蓋到**，再考慮自己拼參數。
上一輪把同一串十五個參數重打了十五次，那是純浪費。

截圖也一樣：能用 `--eval` 斷言就不要截圖，圖很貴。要看版面才截。

---

## 七、示範資料不等於真實情況

- `ensurePmPerBlock()` 是**一個版位一位 PM**，名單不夠就自動長出 `PM 丁戊己庚辛…`。
  所以「一位 PM 一條進度」在示範資料上會變成十行「PM 甲 0/1」—— 那不是 bug，是資料的形狀。
- 剛挑完貨的格子有東西、但 `sheet.confirmed` 還是 false。拿 `confirmed` 當
  「PM 做完了」的條件，畫面就會整片是灰的。
- `?seed=1` 的示範檔期**沒有** `layout` —— 任何讀 `plan.layout` 的東西都要能接受它不存在。

---

## 八、驗完正本，還要驗 `public/`

Netlify 發的是 `public/editor.html`（複製出來的那一份），路徑和 `_redirects` 都不一樣。

```bash
node .claude/skills/run-pm-page/scenario.mjs blk --file "http://localhost:8081/editor?seed=1"
```

`--bundle` 產出的 `dm-editor-single.html` 走的是 `srcdoc`，又是另一條路 —— 動過
`setPickFrame` 或畫布的啟動流程就要單獨驗它。

---

## 九、改 DOM 組裝的程式碼時

這兩個都發生過，而且**畫面不會報錯**，只會少一塊：

- 整段替換的時候把 `parent.appendChild(child)` 弄丟 → 卡片上只剩一條虛線，裡面是空的。
- `line.insertBefore(map, who)` 但 `who` 還沒被 append 進 `line` → `NotFoundError`。

改完看畫面，不要只看有沒有 console error。

---

## 十、工具的手勢在格子上：要在捕獲階段接

格子上坐著別人的東西：便利貼記號（`.cmk`，pointerdown 就開始拖便利貼）、數字泡泡、畫布。
拿著一個工具（刷子、上色、搬移）在格子上按下去，**冒泡階段的 listener 常常根本收不到** —— 記號自己先接走了。
2026-09-28：PM 剛在第一格貼完一則修改，從那一格拉框刷「審核完成」，**一格都沒刷到**，也沒有任何錯誤。
工具的 pointerdown 掛 `boardEl.addEventListener('pointerdown', …, true)`（捕獲），在開頭判斷「我這個工具有沒有拿著」，
沒拿著就 return、拿著就 `stopPropagation`。

**反過來也一樣**：記號自己的 pointerdown 要讓路。手上拿著一張貼紙（`armedKind`）按在舊的記號上，
意思是「再貼一張」，不是「拖那一張舊的」—— 以前記號先接走，新的那一張貼不上去，畫面上沒有任何反應。
加一種會「按在格子上」的模式，就要想一次：記號、數字泡泡、畫布，誰該讓誰。

---

## 十一、點「格子裡的某個東西」也要算點了那一格

「選起來的是哪一格」不只從點格子本身來：點便利貼記號、貼完一則便利貼、從「輪到你」跳過來，都是在講某一格。
意見欄最上面那一塊（審核）讀的是 `rvSel` —— 以前只有點格子本身會設它，於是貼完一則、再點那一格（點到的是記號），
那一塊還講著上一格，「送出調整」那顆鈕找不到。**加一個「講某一格」的入口，就要一起設 `rvSel`**（見 `selectNote`、`dropNote`、`rvGo`）。

---

## 十二、在 總體 改了東西，小地圖要自己重畫

`rebuildAll()` 只在 落版／拼板 重畫右邊那張小地圖。在 總體 改品類（✏）、改「這一塊放什麼」之後不自己叫
`renderMinimap()`，小地圖還寫著舊的名字 —— 連「沒有負責人」的琥珀虛線都留著，看起來像沒改到。
`applyBlockKind`、`applyItems` 都補了；**再加一個 總體 上的編輯，也要補**。

---

## 十三、審核那一邊（review-*.js）的幾個坑

- **擋按鈕的東西要早一點送過去。** 完成按鈕數的是審核那一邊的影本（格子、便利貼），影本是同步過去的。
  只在存檔之後同步的話，剛貼的便利貼要慢一拍才算數 —— 那一拍裡按「蓋章：還沒蓋的 N 格」會把剛標要調整的那一格也蓋掉。
  所以 `markDirty()` 就排一次同步（`reviewSyncSoon`，有 debounce、骨架沒變不送）。
- **規則裡查分類的地方都要容忍「沒有負責人」的格子**（品類不在分類表上，`category_id` 是 null）：
  `catById(...).manager_id` 這種寫法一碰到就炸，而且是整支待辦、延遲通知一起炸（量到過）。一律 `(catById(...) || {})`。
- **快轉補的資料要是主程式改得動的。** 快轉在審核那一邊生了幾則假的一校意見 —— 主程式的便利貼正本在它自己那邊，
  那幾則它打不了勾，一改就永遠送不出去。雛形才生（`Seed &&`）。
- **`var` 也救不了 TDZ 以外的事**：開機很早就會被叫的函式（`setTool` → `syncPassTool` → `paintRvPanel`）碰到的東西，
  寫成 `function` 或 `var`，而且進去先檢查「有沒有資料」再做事。

---

## 十四、兩句話對不起來的時候，要問

需求前後矛盾時自己挑一個「比較合理」的去做，做完才發現挑錯 —— 那比問一句貴得多。
這個專案已經為了「週末怎麼算」來回改了三輪：先照 A 做、被否定、改成 B、又被否定，
最後問了一次就定了。

**判準**：兩種讀法會做出不同的東西 → 問。只是細節沒講 → 自己選一個合理的，然後講出來。
