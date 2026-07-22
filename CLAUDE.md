# pm_page

DM 落版／拼板 編輯器。**兩支單檔 HTML，沒有 build、沒有 npm、沒有相依套件** —— 用瀏覽器直接開就是完整的程式。請維持這件事。

| 檔案 | 做什麼 |
|---|---|
| `design_and_PM.html` | 主程式：檔期列表、總體／落版／拼板、意見欄。所有程式碼在**同一個** `<script>` 裡 |
| `2cell-product-pick.html` | 商品版面本人。被主程式嵌兩次：`?ui=stage`（格子裡的畫布）、`?ui=panel`（挑貨面板），靠 `postMessage` 溝通 |
| `GLOSSARY.md` | **動手前先看**。「block」在這個專案有三個意思（版位／格／零件），吵過很多次 |

## 改完一定要跑起來看

語法檢查**擋不住這裡最常見的錯**。整支程式是一個 `<script>`：在頂層呼叫一個會讀到下面才宣告的 `let` 的函式 → `ReferenceError` → 整支程式停在那一行 → 開起來整頁是死的。這個坑踩過一次，而且「語法沒問題」完全看不出來。

```bash
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?seed=1" \
  --wait 700 --click ".plan-card .btn.open" --wait 800 \
  --click-text "拼板" --wait 1200 --shot out/check.png
```

跑完會印 `ok — no console errors, no exceptions`，有錯就列出來並 exit 1。`--eval` 可以順便量 computed style —— 改顏色時就是這樣證明「什麼都沒變」的。

## 顏色

- **新顏色一律在 `:root` 取個名字**，不要往下面塞 hex。名字照「做什麼用」取（`--surface`、`--ink-dim`、`--accent-tint`、`--danger-ink`），不照「是什麼顏色」。
- **藍色＝「你正在點的東西」**：分頁、選取、放下去的位置。東西本身不准用藍。
- **便利貼的顏色＝誰貼的**（設計淡紫／PM 黃），**圖示＝哪一種**，角落那個字＝哪一位。
- **版位的底色＝狀態**：灰＝未指派、白＝設計手上、綠＝已交出。小地圖和總體共用同一套。
- 深色那一段（`操作區調深色`）放在 stylesheet **最後面**，靠來源順序覆蓋。淺色的東西要自己寫 `color` —— 不寫就會繼承深色底那套淺灰，白底上直接看不見（這個 bug 出現過三次：`#blockHead`、`.plan-card`、落版的字）。

## 大小

| 說法 | 意思 |
|---|---|
| 固定大小 | 螢幕上永遠同一個 px：便利貼以外的標記、版位標題、刊頭上的說明字 |
| 跟著縮放 | 乘 `var(--z)`：格子裡的品名、便利貼（它指著版面上某一個點） |
| 只縮不放 | `scale(min(1, var(--z)))`：只有紅色數字 |

縮放只是把畫面拉近看，**不會改變印出來的東西**。

## 資料

全部在 `localStorage`，沒有伺服器、不會同步給別人。

- `catalogue_plans_v1` —— 整包檔期。版位、格子、便利貼（`cell.notes`）、拼好的畫布（`cell.board.state`）全都在 `plan.layout` 裡面。
- 因為都在 `layout` 底下，`snapshot()` 一序列化就全部有了 —— 存檔和 Ctrl+Z 是免費的。**改了資料要進歷史就叫 `commitAction()`，只想存檔叫 `markDirty()`。**
- 交接：設計按「確認列排列（鎖定）」＝ `sheet.confirmed` ＝ 交給 PM。**鎖定之前那個版位對 PM 完全不存在**（不是壓暗，是不出現）。
- 一個版位一位 PM（`sheet.pm`），開檔期時 `ensurePmPerBlock()` 照順序自動分。未指派＝每位 PM 都看得到。
- 沒有存檔時預設是空的，要範例資料在網址加 `?seed=1`。檔期列表右上角有「清空資料」。

## 寫程式的調子

- 註解用中文，寫**為什麼**，不寫這行在做什麼。既有的註解就是範例，跟著那個語氣寫。
- 位置只有四個就給四個落點讓人指，不要叫人用拖的去瞄準（刊頭換位置就是這樣改的）。
- 拖曳留給真正連續的量（高度、比例）。
- 動畫：版面重排時不要滑動 —— 列高、格數同時在變，滑動追不上，看起來像壞掉。

## git

`main` 是主線，工作開分支再發 PR。`gh` 在 `C:\Program Files\GitHub CLI\gh.exe`（可能不在 PATH 上）。
`backup/`、`turn/`、`*.bak*.html`、`out/` 都在 `.gitignore` 裡 —— 歷史本身就是備份。
