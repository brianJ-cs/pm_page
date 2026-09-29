---
name: user-report-fix
description: 公司／使用者回報一串問題（「整本預覽跑掉了」「按縮小 SKU 會跑位」「一鍵對齊 LOGO」這種一句話的回報）時先看這一份 —— 怎麼在 15 分鐘內從「一句話」走到「知道改哪裡」，不要一個一個開瀏覽器去重現。也收著 2026-09-29 那一批四條的根本原因和改法（還沒動手），接著做的時候直接照做，不要再查一次。使用者說「太久」「stop」「user review」「公司回報」的時候也看。
---

# 使用者回報：先查程式、後開瀏覽器、有預算

## 那一次為什麼慢（2026-09-29，使用者：「stop this, this is taking too long」）

四條回報，查了很久、**一行都沒改**就被叫停。時間花在：

- **開瀏覽器去「看看長怎樣」，一共 6 趟，每趟 1～2.5 分鐘**，其中 3 趟白跑：
  ・範例檔期（`?seed=1`）**一格貨都沒挑**，整本預覽只有空框，什麼都比不出來；
  ・在 總體 點一塊想「挑起來」再切 商品 —— **點 總體 的版位不會換掉開著的那一塊**
    （`switchBlock` 在 總體 只 `selectTotalBlock`），兩趟都停在第一塊刊頭。
- **一路讀程式、一路猜**，沒有先講預算，也沒有中途回報。
- 回報本身是別人轉述的（使用者：「its from user review」），**有一條根本沒人說得清楚**，
  卻還是想先把它重現出來。

## 規矩

1. **先講預算（預設 15 分鐘查、之後回報），到了就停下來回報，查到哪講到哪。**
   不要等使用者開口叫停。
2. **先 grep、再開瀏覽器。** 回報裡的字幾乎都對得到畫面上的一顆鈕或一個函式
   （「對齊 LOGO」→ `alignToLogo`、「縮小」→ `scaleSelected`、「整本預覽」→ `pvNode`／`farmBlock`／`captureInto`）。
   讀完那一段講得出原因的，**不必重現**，直接進計畫。
3. **講不清楚的那一條不要去猜著重現**：寫進計畫裡「需要一張截圖／哪一格」，其他條照做。
   使用者也不知道的話（轉述的回報），就先做清楚的那幾條。
4. **真的要看畫面，一趟就夠**，而且用對資料：
   ・要有貨的檔期用 **壓力測試**（`#stressPlanBtn`，照真的 DM 排、176 格有貨），不要用 `?seed=1`。
   ・整本預覽：`#stressPlanBtn` → `[data-tab=total]` → `#dmPrevBtn` → `--wait 50000`（暗房一塊一塊拍）
     → 在 `#totalScroll` 上派 8～12 發 `WheelEvent(deltaY:-120)` 放大 → 截圖。
     **再按一次 `#dmPrevBtn` 關掉**，底下就是 總體 的格線，兩張疊著比最快。
   ・要進某一塊的 商品：**點小地圖**（`#boardSide` 那張），不要點 總體 的版位。
5. 計畫用 `plan-as-tree`，**畫完就停**；使用者點頭才改。改的時候照 `edit-fast`，驗的時候照 `test-budget`。

## 2026-09-29 那一批：原因和改法（還沒改，接著做就照這裡）

使用者已經答過的：**A＝(a) 對齊 LOGO 時價格留在右下角**（照 `rule.png`）。
「統一位置」的範圍沒回答 —— 預設**同一個版位**（跟集體移動同一個範圍），回報時講一句。

### 1. 一鍵對齊 LOGO（品名、型號、SKU、市價、促銷價都要）＋ 一鍵拉到統一位置 ＋ 單格照樣能調

- 現況（`2cell-product-pick.html` 的 `alignToLogo`）：左邊那一疊跟 LOGO 排、右下那一組放回預設 —— **已經是 (a)**，
  缺的是「**一次整塊**」。
- 改法：
  ・主程式 `SELBAR_HTML.brand` 多一顆「整塊統一」（`data-act="alignAll"`），按下去送 `{alignLogo:id, spread:true}` 給那一格。
  ・畫布：`alignToLogo(id, act)` 多收一個 act（接收的那幾格要用**來源那一格的 act**，不然每一格各記一步）；
    做完量 LOGO 看得見的左上角（`visBox`），換成 mm（`unitsPerCm()`），連同 `br.placed` 報上去 `{alignSpread:{act,placed,xMm,yMm}}`。
  ・主程式：照 `bulkMove` 那一段抄 —— 轉 `{alignAt:m}` 給同一塊的其他畫布（跳過來源），`commitAction(m.act)` 整批一步。
  ・畫布收到 `alignAt`：`userAct(m.act)`；沒有 LOGO 就跳過；`placed` 的話 `unpin` → 把 LOGO 看得見的左上角放到那個 mm 點
    （`b.x = X - k.ox`）→ `holdPlace`；沒 placed 就把 LOGO 放回預設位置（照 `alignToLogo` 那招：`buildBlocks` 借一份預設、放回原本的）；
    然後 `alignToLogo(br.id, m.act)`。
  ・只動位置、不鎖；一次 Ctrl+Z 整塊退回。

### 2. 商品帶入或移動時，運算會跑掉 —— **原因不明，不要去猜著重現**

回報的人講不清楚。猜測（**沒驗過**）：跟第 4 條同一個根（「動過就不再自動排」讓旁邊幾塊留在舊位置）。
第 4 條修完請使用者再看一次；還在的話要一張截圖＋哪一格。

### 3. 整本預覽跑掉 —— 三個原因，都在 `design_and_PM.html`

- **(a) 裁過的刊頭在預覽上沒裁**：暗房的 `farmMast(sh)` 只放一張 `<img>`，沒照 `mhCropOf(sh)` 包 `.mh-crop`
  （版上 `buildMasthead` 那一段有）。`captureInto` 找不到 `.mh-crop` 就記成沒裁的整張。
  改法：`farmMast` 照 `buildMasthead` 那幾行包一層 `span.mh-crop`、img 設 `width/height/left/top` 百分比。
- **(b) 暗房送的字級基準是 0**：`pushType(block, find)` 裡 `sheetRefCmH`／`sheetRefCmArea` 走 `cellCm(c, cardEl(c.id))`，
  而 `cellCm` 要 `activeBlock` 和**版上的**卡片 —— 別的版位在版上沒有卡片，算出 0，每一格改照自己多大定字級。
  **只在格子大小不一的版位看得出來**（合併、刊頭站旁邊）。
  改法：`pushType(block, find, root)`；有 root 就從 root 找卡片（`.cell[data-cell-id]`）、`sheetMetrics(block)` 當 metrics 傳給 `cellCm`；
  `cellCm` 在有 metrics 時不必看 `activeBlock`。`farmBlock` 呼叫時傳 `board`。
- **(c) 舊照片認不出版面改過**：`snapSig(block)` 只有格子 id ＋ `mhRev`。改列數（`sh.rows`）、合併（`mw/mh/under`）、
  拉版位寬高（`mastheadW`、`blockAspect`）、改刊頭高／位置（`mastheadH`、`mhSide`、`mhOnly`）之後，
  **記憶體裡**那份照片照用、照舊的百分比貼 → 錯位。IndexedDB 那份只在開檔期時比一次。
  改法：`snapSig` 把上面那些都算進去；拍照時記一份（`captureInto` 裡 `snapSigAt.set(key, snapSig(block))`，
  讀回 IndexedDB 時記 `rec.sig`，存的時候存這一份）；`blockSnap()` 對不上就丟掉那一份（預覽畫「載入中」、暗房會補拍）。
  ⚠️ 簽名格式一換，IndexedDB 裡的舊照片第一次開會全部對不上、各丟一次 —— 自己會拍回來，回報時講一句。
- **(d) 只有刊頭（或 0 格）的版位在預覽上寫「還沒挑貨」**：`farmBlock` 在 `rowH` 是 0 時直接 return，一張都不拍，
  `pvNode` 就畫斜線。壓力測試那一本十幾塊都是這樣 —— 看起來像整本一半沒做。
  改法：`pvNode` 在沒照片、而且這一塊沒有格子時，照 `sheetMetrics` 的 `mhPx / totalH`（只有刊頭＝整塊）畫刊頭：
  有圖貼圖（連 `mhCropOf` 一起），沒圖畫 `.pv-empty.mast` 虛線框。

### 4. 按縮小 SKU 會跑位 —— 原因確定

- 浮起來那條工具列的 ＋／−（`scaleSelected`）對每一塊都 `holdPlace` —— SKU 從此**不再跟著價格排**
  （`packPriceGroups`／`inlineSku`／`spreadStack` 都跳過 placed），而它用 `rx` 釘右邊、`y` 釘上緣，
  縮小時左緣往右、下緣往上，跟價格分家。拖角落那條（`keepAnchor`）沒這問題。`resetSelected` 同一個毛病。
- 改法（`scaleSelected`、`resetSelected` 一起）：
  ・圖、貼圖照舊 `holdPlace`（自動貼齊會蓋掉它們的寬）。
  ・文字類**沒被搬過的不標 placed**，縮完讓自動排版照舊排（`sc`／`fsFix` 本來就不會被排版寫回去）。
  ・**已經搬過的**：先 `unpin`，記下它對齊的那一角（`anchorPoint`），改完 `keepAnchor` 挪回去 ——
    SKU 釘左下（傳 `'ne'`）、價格和規格釘右下（`'nw'`）、LOGO／品名／型號釘左上（`'se'`）。
- 已經被按歪的舊格子：按一次「對齊 LOGO」就回來（它會清掉右下那一組的 placed）。

### 驗（照 test-budget，全部加起來 ≤ 5 分鐘）

- `node .claude/skills/cell-wall/wall.mjs`（動到格子裡的排法，一定要跑）。
- 第 4 條：`scenario.mjs blk` 點中 SKU → 按 `[data-size=down]` 兩下 → `--assert` 量 SKU 和價格看得見的左緣差、下緣間距，前後一樣。
- 第 3 條：規矩 4 那一趟截圖，預覽和底下 總體 的格線對得上、刊頭塊不再寫「還沒挑貨」。
- 第 1 條：選 LOGO → 按「整塊統一」→ 截一張 商品 的圖跟 `rule.png` 並排看。
