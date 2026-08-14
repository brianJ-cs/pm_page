---
name: run-pm-page
description: Launch pm_page's single-file HTML apps (design_and_PM.html, 2cell-product-pick.html) in headless Chrome, click through the views, screenshot, and report console errors. Use before claiming any change works — these apps are one big inline script, so a runtime error kills the whole page while the file still parses fine.
---

# 跑 pm_page 看看

`driver.mjs` 用 Chrome DevTools Protocol 開檔案、點東西、量 computed style、截圖。
零相依套件（Node ≥ 22 內建的 WebSocket 就夠），所以不會替這個沒有 build 的專案裝出一個 node_modules。

全程收集 console 錯誤和未捕捉的例外，最後印出來；有錯就 exit 1 —— 所以它同時是煙霧測試。

## 什麼時候一定要跑

- **改過任何頂層（module-level）的程式碼之後。** 整支程式是同一個 `<script>`：在頂層呼叫一個會讀到下面才宣告的 `let` 的函式，就是 `ReferenceError`，整頁死掉，而語法檢查完全看不出來。這個坑踩過。
- 改顏色、改版面之後 —— 用 `--eval` 量 computed style，比用眼睛猜可靠。
- 說「修好了」之前。

## 先看這個：`scenario.mjs`

固定的前置動作（開檔期 → 切到拼板 → 塞滿假資料 → 放大 → 打開一格 → 點中一個零件）
收成了四個名字。**不要再一個一個參數重打** —— 那是十幾個參數，每驗一次重打一次，
而且很容易在 shell 的引號上出錯。

```bash
cd C:/Users/User/Documents/work/pm_page
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
cd C:/Users/User/Documents/work/pm_page

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
