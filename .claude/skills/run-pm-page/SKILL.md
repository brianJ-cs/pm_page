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

## 怎麼跑

```bash
cd C:/Users/User/Documents/work/pm_page

# 最短的一次：開起來有沒有炸
node .claude/skills/run-pm-page/driver.mjs --file design_and_PM.html --wait 800

# 走一輪四個畫面（?seed=1 才有範例檔期，不然列表是空的）
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?seed=1" \
  --wait 700 --click ".plan-card .btn.open" --wait 900 --shot out/1-total.png \
  --click-text "落版" --wait 1000 --shot out/2-sheet.png \
  --click-text "拼板" --wait 1300 --shot out/3-board.png

# 量顏色：改樣式前後各跑一次，diff 兩份輸出
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?seed=1" \
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

## 另一支也能跑

```bash
node .claude/skills/run-pm-page/driver.mjs --file 2cell-product-pick.html --wait 800 --shot out/pick.png
```

單獨開的時候它是完整的編輯器；`?ui=stage` 和 `?ui=panel` 是被主程式嵌進去的兩種樣子。
