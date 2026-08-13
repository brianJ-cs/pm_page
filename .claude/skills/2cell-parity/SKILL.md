---
name: 2cell-parity
description: 跟 2cellOriginal.html 對帳 —— 同樣的商品，每一個元素佔格子的百分比差多少。它是一把**尺**，不是驗收標準（驗收標準是 CLAUDE.md 的最高原則：長得像 rule.png）。改 2cell-product-pick.html 的預設版面（PAD、字級、商品圖大小、欄位擺法）之前先跑一次留基準，改完再跑一次比，看自己動了多少。
---

# 跟原版對帳

⚠️ **這支不是驗收標準。** 驗收標準是 `CLAUDE.md` 最高原則那一條：**長得像 `rule.png`**。
`2cellOriginal.html` 曾經是規範，現在降級成**參考的一把尺** —— 用它量「我這次改動把每個元素
搬了多少」，差多少不代表對或錯。原版跟 `rule.png` 不一樣的地方，**以 `rule.png` 為準**。

它量的是：**預設狀態下，每一個元素佔一格的百分比，跟原版差幾個百分點。**

```bash
cd C:/Users/User/Documents/work/pm_page

node .claude/skills/2cell-parity/parity.mjs            # 三個價格那一組
node .claude/skills/2cell-parity/parity.mjs --case 1   # 一個價格（預設字級不一樣，要另外驗）
node .claude/skills/2cell-parity/parity.mjs --case 2
node .claude/skills/2cell-parity/parity.mjs --json > out/parity.json   # 留基準
```

兩邊挑同一批商品（原版存列號、現在存 SKU，`CASES` 對好了），量同一段程式，
所以差出來的就是版面的差，不是量法的差。差超過 1.5 個百分點就 `exit 1` —— 那個 exit 1 讀成
**「這裡跟原版不一樣，去看一眼是不是往 `rule.png` 的方向走」**，不是「改壞了」。

## 為什麼量百分比，不量 px

原版的格子永遠是 540×420 —— 「品名佔多高」在原版裡是一個**固定比例**。
現在的畫布是照落版給的實際公分開座標系，格子大小每一格都不一樣，px 直接比沒有意義。

**所以現在的畫布一定要開成 9×7cm（＝540:420 ＝ 1.286）再比。** 長寬比不一樣的時候
百分比沒有可比性，這支會印 ⚠ 警告 —— 那時候的輸出只能當「現況記錄」，不能當對帳。

```bash
node .claude/skills/2cell-parity/parity.mjs --cm 17.5,1.6    # 矮格子：原版沒有對照，只看現況
```

## 讀結果

```
元素          原版 x,y,w,h %            現在 x,y,w,h %            差最多
 FAIL img#1     27.78   16.9  35.19   41.9    1.85  23.33   8.15   9.52    32.38
```

- `x,y` ＝ 左上角離格子左上角多遠（x 除格寬、y 除格高）；`w,h` ＝ 佔格寬／格高多少。
- 最後一欄是這個元素四個數字裡差最多的那一個，單位是**百分點**。
- 同一種元素的第 n 個對第 n 個（`img#1` 對 `img#1`）—— 兩邊都是 `buildBlocks` 給的順序。

## 幾個坑

- **一價／二價／三價要各驗一次。** 價格數會換一套預設字級（`PRICE_COUNT_FS`），
  而原版根本沒有這個乘數 —— 差最大的地方就在一價那一組（量到過 19 個百分點）。
- 這支只驗**預設**版面。手動搬過、縮放過的（`b.placed`、`b.sc`、`b.fsFix`）不在範圍內，
  那些是使用者的東西，不該跟原版一樣。
- 原版是單獨一頁（沒有 iframe、沒有身分、沒有上層談字級），所以它的 `--eval`
  讀得到 `picked`／`BLOCKS`；現在那一支要帶 `?ui=stage` 才是拼板裡的樣子。
- 差異的清單和建議的改法在 `2cell-parity-plan.md`。
