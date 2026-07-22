# 字級統一：價格、SKU、品名

**狀態：只有規格，還沒動手。** 這份是給接手的人／模型看的完整交辦單 ——
不需要看過當初那場討論，照著做就行。

先讀 `GLOSSARY.md`，尤其是「block」那一段。這份文件裡：

| 講法 | 指的是 | 程式裡 |
|---|---|---|
| **版位 / section** | 設定的作用範圍。小地圖上一個粉紅方塊 | 樹葉 `block`、`sheetOf(block)` |
| **格 / cell** | 一個商品位置。「三價格」講的是**格**，不是版位 | `sheet.cells[]` |
| **零件** | 畫布裡可搬的每一塊（品名、SKU、價格…） | `BLOCKS[]` |

---

## 一、要解決什麼

同一個版位裡，看起來一樣的格子，字卻不一樣大。價格、SKU、品名都有這個問題。
`words.png`、`words2.png` 是實際長出來的樣子，`exp.jpg` 是目標。

`exp.jpg` 是**一個版位**：最上面那條是刊頭，下面 5 列 × 4 格，每格一個價格，
全部同一個大小。那就是做完以後該有的樣子。

---

## 二、根本原因（量過的，不是猜的）

`2cell-product-pick.html:384`：

```js
let CW=540, CH=420;
```

**每一格的排版座標系寬度都固定 540，不管那一格在版上實際有多大。**
然後 `fitStage()`（:429）再把它壓進去：

```js
const cs = Math.max(.02, w / CW);      // :432  w = 這一格真正的像素寬
CH = Math.max(160, Math.round(CW*h/w)); // :433
```

所以 `cs` 每一格都不一樣，寫死的 px 就跟著變。實測（seed 資料，**同一個版位內**）：

| 量到的東西 | 值 |
|---|---|
| 格寬 | 75 / 76 / 100 / 101 px |
| 算出來的 `cs` | 0.139 → 0.187 |
| 同一個 30px 品名 | 4.2px → 5.6px |

**同一個版位裡 34% 的落差。**

### 為什麼確定是這個原因

`.blk.name` 是死的 `font-size:30px`（:81），而且**整支檔案沒有任何地方會改品名字級** ——
render 出來只有 `left`/`top`（:664）：

```js
if(b.kind==='name') return `<div class="blk name..." style="left:${b.x}px;top:${b.y}px">`
```

價格有 `b.fs` 縮放（:676-677），所以價格大小不一有兩種可能、分不出來；
品名沒有，所以品名大小不一**只剩幾何這一種解釋**。這是關鍵證據。

### 為什麼一定要先修這個

三個轉盤設的是「這個版位一個值」，但 `cs` 會再乘上每一格自己的寬度比。
先做轉盤的話，設 `skuSize: 12` 會得到隔壁兩格 1.7px 和 2.2px —— 看起來像轉盤壞了。
**順序不能換。**

---

## 三、談定的規格

作用範圍**一律是版位**，沒有任何跨版位／全 DM 的設定。

| 項目 | 決定 |
|---|---|
| 統一的單位 | **格**，依「這格有幾個價格」分組 |
| 作用範圍 | 一個版位。版位跟版位之間本來就可以不一樣 |
| 轉盤 | 三個（一價／二價／三價），放**拼板工具列**，作用於當下那個版位 |
| 轉盤 vs 自動縮放 | **轉盤說了算**，允許溢出、允許疊到別的東西 |
| 沒動過轉盤時 | 用自動縮放算的預設值＝該版位同組的**最小值**，下限 0.55× |
| 四個價格以上 | 只走自動縮放，不進任何組、沒有轉盤 |
| 單格微調 | 有，**改了就一直記著**直到重設；改過的格子脫離該組 |
| SKU | 一個版位一個大小 |
| 刊頭 | 使用者自己貼的 PNG/JPG ——**完全不要碰** |

---

## 四、動手步驟

### 步驟 1：排版座標系照真實比例（先做這個）

**改什麼**：`CW` 不再固定 540。上層把那一格真正的寬高傳進來，讓
「畫布 1px」在每一格都代表同樣的實際距離，`cs` 全版位一致。

**碰到的地方**
- `2cell-product-pick.html:384` `CW`/`CH` 宣告
- `2cell-product-pick.html:429-440` `fitStage()`
- `2cell-product-pick.html:902` `scaleOf()` —— 也是拿 `CW` 當分母
- `design_and_PM.html:5476` 掛畫布的地方（`setPickFrame(f,'ui=stage&cell='+…)`）
  ：把該格尺寸一起帶進去
- `design_and_PM.html:4886` `setPickFrame()` —— 單檔版走 `srcdoc`，
  參數是塞 `window.__PICK_PARAMS`，兩條路都要帶到

**資料轉檔（不能省）**
已經存下來的零件座標都是舊的 540 空間（`cell.board.state`，在 `plan.layout` 底下）。
要寫一次性的版本轉換，把 x/y 換算到新座標，不然所有排好的格子會跑掉。
做成認版本號的一次性轉換，不要每次 render 都重猜。

**做完會看到**：SKU、品名在同一個版位裡真的一樣大了；價格的落差也去掉一大半。

> ⚠️ 這一步會讓小格子變得比較擠（12px 不再被縮小），
> 所以小格子觸發價格自動縮放的機會**變多**。這是預期內的，步驟 2 的
> 「同組取最小」會把它擴散出去 —— 談的時候已經接受這個結果，
> 真的難看再用單格微調救。

### 步驟 2：`sheet.type` 和三個轉盤

存在版位身上，跟 `sheet.confirmed`／`sheet.pm`／`sheet.masthead` 放一起：

```js
sheet.type = {
  skuSize: 12,                        // 這個版位的 SKU 大小
  priceByCount: { 1:null, 2:null, 3:null },  // null = 還沒動過，用自動算的
}
```

因為住在 `plan.layout` 底下，`snapshot()` 一序列化就有了 ——
**存檔和 Ctrl+Z 是免費的**。改了要進歷史就 `commitAction()`。

**自動縮放改成「回報」而不是「決定」**：`autoSpace()`（:741）現在自己算完 `fs`
就直接套上去（:777-792）。改成把「我需要多少」報上去，由上層收齊該版位同組的值、
取最小、再廣播回來。

好消息：`showBoardOverview()` → `renderGrid(activeBlock)`（`design_and_PM.html:4701/4715`）
**一次只畫一個版位**，所以要互相對齊的畫布本來就同時活在 DOM 裡，
不必處理「沒掛載的格子」。

- 0.55 下限（:779）**只管自動縮放**；轉盤和單格微調不受限
- 轉盤存絕對 px（因為它蓋過自動縮放，「一樣大」就該是一樣的 px）

### 步驟 3：看整份 DM

唯讀。每一格照真實比例畫成靜態圖，像 `exp.jpg` 那樣拼起來。
不要用活的 iframe —— 整份可能 40 格以上。

現有的 `showBoardOverview()` 一次只有一個版位，這是新的一層。

**先做這個也可以**，而且有道理：步驟 1、2 做完有沒有效，本來就要看整份才看得出來。

---

## 五、怎麼驗

語法檢查擋不住這裡最常見的錯：整支程式是一個 `<script>`，
頂層呼叫一個讀到下面才宣告的 `let` → `ReferenceError` → 整頁死掉，
但檔案 parse 完全正常。**每一步做完都要真的跑起來。**

```bash
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?seed=1" \
  --wait 700 --click ".plan-card .btn.open" --wait 800 \
  --click-text "拼板" --wait 1200 --shot out/check.png
```

印 `ok — no console errors, no exceptions` 才算過。

量字級證明有沒有變（`--eval` 會把結果印出來）：

```bash
node .claude/skills/run-pm-page/driver.mjs --file "design_and_PM.html?seed=1" \
  --wait 700 --click ".plan-card .btn.open" --wait 800 --click-text "拼板" --wait 1800 \
  --eval "(()=>{const ws=[...document.querySelectorAll('.cell')].map(e=>Math.round(e.getBoundingClientRect().width)).filter(w=>w>0);return [...new Set(ws)].sort((a,b)=>a-b)})()"
```

修好以前這會印出不只一種寬度、而且字級跟著跑。
**注意 seed 資料沒有拼過的格子（14 格、0 畫布），要量畫布裡的字得先挑貨。**

改完別忘了 `node build-single.mjs` 重出單檔版。

---

## 六、還沒決定的

- 步驟 1 的座標轉換，遇到長寬比變很多的格子只能近似 —— 真的歪掉要怎麼救還沒想
- 單格微調的 UI 長什麼樣（存哪裡也還沒定，大概在 `cell.board.state`）
- 「同組取最小」會不會因為一個很長的品名把整組拉小，要看真實資料才知道
  （所以步驟 2 要把算出來的值露出來，不要藏著）
