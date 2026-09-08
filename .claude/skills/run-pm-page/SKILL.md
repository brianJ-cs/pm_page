---
name: run-pm-page
description: 跑起來看 —— 用 headless Chrome 開 pm_page 那幾支單檔 HTML（design_and_PM.html、2cell-product-pick.html）、點過去、截圖、回報 console 錯誤，並且**決定這次要驗到哪一級**（只開起來／真的點一下／連兩把尺一起跑）。說「好了」之前一定要看這一份：整支程式是一個 inline script，一個執行期錯誤就整頁死掉，而語法檢查照樣過。點不到東西、快捷鍵沒反應的時候也看這裡。
---

# 跑 pm_page 看看

`driver.mjs` 用 Chrome DevTools Protocol 開檔案、點東西、量 computed style、截圖。
零相依套件（Node ≥ 22 內建的 WebSocket 就夠），所以不會替這個沒有 build 的專案裝出一個 node_modules。

全程收集 console 錯誤和未捕捉的例外，最後印出來；有錯就 exit 1 —— 所以它同時是煙霧測試。

## 為什麼一定要跑

整支程式是同一個 `<script>`。在頂層呼叫一個會讀到**下面才宣告**的 `let` 的函式 →
`ReferenceError` → 整支程式停在那一行 → 開起來整頁是死的。**語法檢查完全看不出來**，
而且踩過不只一次：2026-09 那次是把一個 `}` 插錯一行，`node --check` 照樣過
（IIFE 裡的頂層 `return` 是合法的），整支共用的東西根本沒被匯出。

所以規矩是：**說「好了」之前一定跑一次**。但**不是每次都跑同一套** —— 見下面。

## 這次要驗到哪一級

一趟完整走查裡光是 `--wait` 就二十幾秒，每改一行跑一次，一個下午就沒了。
照**這次改了什麼**挑一級，不要每次都跑最貴的那一套。

| 級 | 這次改了什麼 | 跑什麼 | 大概多久 | 什麼叫過 |
|---|---|---|---|---|
| **1** | 只有樣式、文案、註解 | `driver.mjs --file "design_and_PM.html?as=design" --wait 800` | **3.7 秒** | 印出 `ok — no console errors` |
| **2** | 會被點到、會被讀到的東西（多數改動都在這一級） | 下面那條「開檔期 → 拼板」再加一個 `--eval` 斷言 | **5.6 秒** | 同上，**外加真的點一下那件事**，而且斷言拿到預期的值 |
| **2＋** | 動到格子裡的零件（選取、拖曳、刪除） | `scenario.mjs blk --assert "…"` | **17 秒** | 同上，斷言在畫布裡跑得過 |
| **3** | 排版算法、座標、資料的形狀 | 第 2 級 ＋ `2cell-parity/parity.mjs` ＋ `stress-board/stress.mjs` | 分鐘級（開兩次瀏覽器／60 個 iframe） | 兩把尺沒有變紅 |

（上面那三個秒數是 2026-09-08 在這台機器上量的，不是估的。真正貴的是 60 個 iframe
那一套和自己加的長 `--wait` —— 那一輪跑了十幾趟，多數其實第 2 級就夠。）

- **第 1 級不夠的判準很簡單**：這次改的東西，使用者會不會**點到**它？會，就是第 2 級。
- 第 2 級**一定要含一個真的互動**。只開頁面看 console 是不夠的：刪掉某幾個變數之後
  還留著參照的那次，頁面載得起來、console 乾淨，但格子裡點任何東西都會炸。
- 第 3 級只在**動到排版算法之後**跑一次，不是每次。
- 一批改完再驗，不要每改一行驗一次（節奏那一份 `edit-fast` 第 1 節）。
- 改顏色、改版面用 `--eval` 量 computed style，比用眼睛猜可靠。

## 先看這個：`scenario.mjs`

固定的前置動作（開檔期 → 切到拼板 → 塞滿假資料 → 放大 → 打開一格 → 點中一個零件）
收成了四個名字。**不要再一個一個參數重打** —— 那是十幾個參數，每驗一次重打一次，
而且很容易在 shell 的引號上出錯。

```bash
cd "C:/Users/afluf/OneDrive/文件/work/work/pm_page"
S=".claude/skills/run-pm-page/scenario.mjs"

node $S smoke                  # 四個畫面走一輪，看有沒有炸
node $S board --shot out/b.png # 開到拼板、每一格都有商品
node $S cell  --shot out/c.png # ↑ 再放大、打開一格（面板開著）
node $S blk                    # ↑ 再點中格子裡的第一個價格（工具列會出現）
```

後面接的參數原封不動交給 `driver.mjs`。多認一個 **`--assert <js>`**：跟 `--eval` 一樣，
但在**畫布 iframe 裡面**跑，`d` 就是那一格畫布的 document。

```bash
# 選到一個零件之後：工具列上寫什麼、版上還剩幾塊
node $S blk --assert "[d.querySelectorAll('.blk').length, d.querySelector('#props').textContent]"

# 按 Delete、看有沒有進 localStorage、再 Ctrl+Z（鍵盤事件要送進畫布，不是送給主程式）
node $S blk \
  --assert "d.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}))&&'deleted'" \
  --wait 1200 \
  --eval "(localStorage.getItem('catalogue_plans_v1')||'').split('\"off\":{\"').length-1"
```

為什麼要 `--assert` 而不是直接 `--eval`：畫布裡的 `BLOCKS`、`selected` 都是 `let`／`const`，
**頂層的 `let` 不會掛到 `window` 上**，從外面 evaluate 讀不到。只能透過 `contentDocument`
問 DOM。同理，畫布裡的零件不能用 `--click` 點 —— 選擇器會先命中別格畫布裡的同名元素。

> ⚠️ **參數裡不要放正規表示式。** `\{` 這種東西經過 shell 會讓整行卡住不動（沒有輸出、
> 也不會結束）。要數東西用 `split(...).length-1`。

## 怎麼跑（driver.mjs 本人）

`scenario.mjs` 蓋不到的才直接用它。

```bash
cd "C:/Users/afluf/OneDrive/文件/work/work/pm_page"

# 最短的一次：開起來有沒有炸
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?as=design" --wait 800

# 走一輪四個畫面（?seed=1 才有範例檔期，不然列表是空的；
# as=design 是登入的旁路 —— 乾淨的瀏覽器不帶它會停在登入頁）
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?seed=1&as=design" \
  --wait 700 --click ".plan-card .btn.open" --wait 900 --shot out/1-total.png \
  --click-text "落版" --wait 1000 --shot out/2-sheet.png \
  --click-text "拼板" --wait 1300 --shot out/3-board.png

# 量顏色：改樣式前後各跑一次，diff 兩份輸出
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?seed=1&as=design" \
  --wait 700 --click ".plan-card .btn.open" --wait 800 --click-text "拼板" --wait 1200 \
  --eval "getComputedStyle(document.querySelector('#blockHead .title')).color"
```

步驟由左到右依序執行：`--file` `--wait` `--waitfor` `--click` `--click-text` `--drag` `--type` `--key` `--eval` `--shot` `--headed`。

## 讀結果

- 結尾是 `ok — no console errors, no exceptions` 才算過。
- 有問題會印 `--- page problems (n) ---`，並且 exit 1。
- `STEP FAILED click-text: ...` 代表那個字沒出現 —— 通常是前一步還沒畫完，補一個 `--wait`，不是程式壞了。
- 截圖用 Read 工具打開來看，不要只看它有沒有存檔成功。

## 幾個坑

### 點不到、按不動的時候（多半不是程式壞了）

- **點過任何 `<input>` 之後，鍵盤快捷鍵就進不去了。** 那支程式的鍵盤處理會擋掉
  焦點在輸入框裡的按鍵 —— 所以 `--click-text "顯示便利貼"`（那是一顆開關）之後再
  `--key t`，那一下什麼都不會發生。2026-09 那次因此連貼了三張貼紙都沒察覺。
  **能點按鈕就點按鈕**：`--click ".tool[data-tool=edit]"`。
- **左邊那條工具直條自己會捲。** 視窗矮的時候底下那幾顆（🎨、🏷️）捲出畫面，
  `--click` 回 `no visible element`。那不是選擇器寫錯，先 `--size` 拉高或改點別的入口。
- **點格子常常點到別的東西**：便利貼的標記就坐在格子中央，點下去開的是留言卡。
  先 `--click-text "顯示便利貼"` 把標記收掉，或挑一格乾淨的：
  `.cell.filled:not(:has(.cmk)):not(:has(.cnb))`。
- **`--eval` 看不到那支程式的頂層 `let`／`function`**（`activeTab`、`readStickerLib`
  都會是 undefined，見上面 `--assert` 那一段的原因）。**斷言一律走 DOM**，
  格子裡的畫布用 `document.querySelector('.ccanvas').contentDocument`
  （driver 帶了 `--allow-file-access-from-files`，所以進得去）。

### 其他

- **`?seed=1` 一定要加引號**，否則 shell 會吃掉 `?`。沒有 seed 的話 localStorage 是空的，檔期列表也是空的（這是刻意的）。
- 每次跑都是全新的 Chrome profile：**localStorage 不會留下來**，上一輪貼的便利貼、開過的檔期都不在。要有資料就靠 `?seed=1`。
- Chrome 路徑寫死在 `driver.mjs` 最上面的 `CHROME` 陣列裡，換機器要改那裡。
- `--headed` 會把瀏覽器叫出來，是拿來 debug driver 本身的，不是給一般測試用的。
- 截圖預設寫到 `out/`，那個資料夾在 `.gitignore` 裡。

## 瀏覽器測不到的那一個：`imgkey-parity.mjs`

```bash
node .claude/skills/run-pm-page/imgkey-parity.mjs
```

商品圖那把鑰匙（`imgKey()`）在 `product.html` 和 `2cell-product-pick.html` 各有一份
（畫布是 srcdoc 塞進去的，載不了共用的 `.js`）。**兩邊差一個字，商品目錄那一頁放的圖
版面上就找不到 —— 而且兩邊都不會有任何錯誤訊息，圖只是沒出現。**
所以它是 driver 抓不到的那一種壞法：console 乾乾淨淨，畫面上少一張圖。

這一支把兩份原始碼挖出來、拿同一批商品各跑一遍再比（不是比字面：一邊是
`function imgKey(r){}`、一邊是 `const imgKey = r => {}`，本來就長得不一樣）。
順便盯 `design_and_PM.html` 裡那一行 inline 的舊鑰匙。

`scenario.mjs` 每一個場景開瀏覽器之前都會先跑它，所以平常不必自己記得跑；
只改了 `imgKey` 想快速對一下的時候才單獨叫它（純 node，不開瀏覽器）。

## 另一支也能跑

```bash
node .claude/skills/run-pm-page/driver.mjs --file 2cell-product-pick.html --wait 800 --shot out/pick.png
```

單獨開這一頁時，頂層的 `let` 就在同一個 scope 裡，`--eval` 直接讀得到（`BLOCKS`、`picked`、
`cell()`）—— 要驗畫布自己的邏輯，這樣比透過拼板那一層快得多：

```bash
node .claude/skills/run-pm-page/driver.mjs --file 2cell-product-pick.html \
  --wait 500 --click ".cell" --wait 300 \
  --eval "picked=new Set(['2156742','2156739']);cell().picked=picked;layoutKey='';renderOne(0,true);BLOCKS.length"
```

## 部署那一份

`public/` 是 `node build-single.mjs` 複製出來的（**不是**合成單檔，那是 `--bundle`，
只有要寄檔案給別人才需要）。要驗 Netlify 上跑的到底是不是好的，就直接跑那一份：

```bash
node .claude/skills/run-pm-page/scenario.mjs blk --file "public/editor.html?seed=1"
```

單獨開的時候它是完整的編輯器；`?ui=stage` 和 `?ui=panel` 是被主程式嵌進去的兩種樣子。
