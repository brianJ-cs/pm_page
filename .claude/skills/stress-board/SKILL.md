---
name: stress-board
description: 量拼板在「壓力測試」假檔期（一個版位 60 格）底下壞成什麼樣 —— 溢出、字級不齊、價格沒貼底、品名落點跑掉，四條規矩各給一個數字，有紅就 exit 1。改 2cell-product-pick.html 的排版（autoSpace、字級、座標系、貼底）之前先跑一次留基準，改完再跑一次比。
---

# 壓力測試的量尺

壓力測試那張畫面壞得很全面。用眼睛看只會得到「everything is fucked」—— 那句話沒辦法
追蹤，也分不出「真的好轉」和「換一個地方壞」。這支把它變成四個數字。

```bash
cd C:/Users/User/Documents/work/pm_page

node .claude/skills/stress-board/stress.mjs                    # 印表格
node .claude/skills/stress-board/stress.mjs --shot out/s.png   # 順手截圖
node .claude/skills/stress-board/stress.mjs --json > out/stress.json   # 存基準給 diff
```

它自己會做完前置：生一個 60 格的假檔期（`#stressPlanBtn`）→ 開到拼板 → 等畫布掛好 →
量每一格的畫布 iframe。走的是 `run-pm-page/driver.mjs`，所以**不會碰到正式 Supabase**。

## 四條規矩（都是 CLAUDE.md 上寫過的，不是這支自己發明的）

| 印出來的名字 | 規矩 | 怎麼量 |
|---|---|---|
| 沒有東西溢出格子 | 寧可字小，也不要壓到隔壁版位 | 每個 `.blk` 的 rect 對 `.cell` 的 rect，超出 >1px 就算 |
| 同價格數＝同字級 | 同一版位裡同樣價格數的格子要一樣大 | 按 `.blk.price` 的顆數分組，比字級 |
| 品名都在同一個落點 | 沒人動過的品名貼左上那一疊 | 品名離格子左上角的距離，量化到 0.5% 再比 |
| 價格貼底一樣高 | 價格離下緣 `PRICE_BOTTOM` | 最低那個價格的下緣離格子下緣多遠 |

**字級和距離都換算成「佔格寬／格高的百分比」才比較。** 每一格在版上多大是落版決定的，
拿螢幕 px 直接比，寬格子和窄格子永遠不一樣，這四條就永遠是紅的。

## 讀結果

```
=== 壓力測試量測（60 / 60 格量到） ===
 FAIL 沒有東西溢出格子          60/60 格溢出，最多 140.9px
 FAIL 同價格數＝同字級          1價:2種(差1.1%)  2價:4種(差7.6%)  3價:3種(差1%)
 ok   品名都在同一個落點         1 種落點 5.5,89.5
 FAIL 價格貼底一樣高           離下緣 -5.44%～2.26%（差 7.7%）
```

- **`ok` 不等於「這樣就對」**：上面那個「品名都在同一個落點」是綠的，但落點是格子
  89.5% 高的地方 —— 一致地錯。數字要自己看，不是只看顏色。
- 貼底出現**負數**＝價格掉到格子外面了，不是「貼得比較鬆」。
- 「N 格量到 / N 格」對不起來＝有畫布還沒掛好，把 `stress.mjs` 裡最後那個 `--wait` 加大。

## 幾個坑

- 這支**只看壓力測試那種極端尺寸**（每格 3.07cm × 0.93cm）。正常尺寸的格子要另外驗：
  `node .claude/skills/run-pm-page/scenario.mjs cell --shot out/c.png`。兩邊都要看 ——
  把極端那邊修好、正常那邊壞掉，是這個檔案改壞過的方式。
- 畫布裡的 `BLOCKS`／`CELLS` 是 `let`，從外面 evaluate 讀不到，所以四條全部只問 DOM。
- 為什麼壓力測試會這麼極端、以及建議怎麼改，寫在 `2cell-rebuild-plan.md`。
