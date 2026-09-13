---
name: cell-wall
description: 格子裡的牆 —— 零件「拖不到邊界」「還沒碰到線就停住」「放手又被往裡拉一截」「選取框比東西大一圈」這一類毛病的規矩、經過和測試。改 2cell-product-pick.html 的拖曳、改大小、邊界、對齊線、選取框、keepInside／clampToMargin／圖片排開，或加一種新零件、改一種零件的畫法（字級、內距、包一層容器、換圖）之前先看；使用者說「搬不過去」「推不到邊」「選取框太大」的時候也看。改完一定跑 wall.mjs。
---

# 格子裡的牆

## 規矩只有一條

**一塊零件「看得見的邊」在哪，整支程式只有一份答案：`visBox()`。**
選取框、四顆把手、拖曳的牆、改大小的牆、對齊線、出界滑回來（`keepInside`）、
改邊界時拉回來（`clampToMargin`）、圖片互相排開（`imgVisBox`）、預設版面對齊邊界
（`nudgeGroupBottom`／`packPriceGroups`／`spreadStack`／`stickImage`）、壓力測試的燈 —— 全部讀它。

- 看到的邊 ＝ 碰到牆的邊 ＝ 選取框畫的邊。三件事是同一件。
- **不准再寫第二種量法**。「這一種零件量框就好」「這裡用 offsetWidth 比較快」
  「字比較難量，先估一個」—— 每一句都是下面那張清單上的某一次。
- 加一種零件、改一種零件的畫法：**只改 `visBox()` 那一段**（和它的內臟 `paintedRect`／`inkRect`／`glyphRect`），然後跑測試。

`visBox()` 量什麼：

| 零件 | 看得見的邊 |
|---|---|
| 字（品名、型號、SKU、價格） | 左右＝字真的畫在哪（`Range`）；上下＝字形的墨水（`glyphRect`，不是字框） |
| 價格溢出自己那一欄 | 照實量到溢出去的那一截（零件自己那一層**不**交集，不然 keepInside 不會縮它） |
| 規格那顆藥丸 | 藥丸本身（有底色／框線的就是它自己） |
| 商品圖 | 那張圖；還沒有圖的＝灰圖（`.ph`，框的 70%） |
| 品牌 logo | 裁過的那一塊（`.bcrop` 會裁掉孩子 → 取交集） |
| 貼圖 | 畫出來的那幾層 |
| 選取記號（`.selbox`／`.rz`／`.tobtn`／`.delbtn`） | 跳過 |

## 別人怎麼做（參考）

- **tldraw**：一個形狀一份 `Geometry2d`，點選、框選、吸附、邊界、把手**全部**從它來，
  而且快取、形狀一變就失效。 https://tldraw.dev/sdk-features/geometry
- **Konva**：拖曳用 `dragBoundFunc` 把**提議的位置**夾回框內；改大小用 `boundBoxFunc`，
  超出去就**回傳舊的框**（這一下不算）。兩條都用同一個 `getClientRect()`。
  https://konvajs.org/docs/sandbox/Limited_Drag_And_Resize.html
- **fabric.js**：`object:moving` 裡用 `getBoundingRect()` 夾位置 —— 同一個矩形。
  https://github.com/fabricjs/fabric.js/issues/6024

我們的對應：拖曳＝`clampAll`（夾提議位置）、改大小＝`withinMargin` 不過就還原（Konva 那一套），
兩個都讀 `visBox`。

## 這件事壞過幾次（認得出來才不會再踩）

| 什麼時候 | 症狀 | 其實是 |
|---|---|---|
| `32257bd` | 把手掛外面，靠右下的價格掉到畫布外 | 把手的框和格子的框不是同一個 |
| `f4630b7` | 價格拖不動、放手跳回右下 | 自動排版和手動位置各有一份位置 |
| `487d6ed` | 放手圖片跑到最左 | 右緣錨點的零件沒有 `b.x`，對齊線拿 `undefined` 算 → NaN |
| `8c98ba5` | 出界的零件掛在格子外 | `keepInside` 圖量外框、字量墨水 —— 又一份量法 |
| 2026-09-12 | 選取框比東西大很多 | 選取框量 DOM，另起一份（`inkRect`），跟牆那份（`inkBox`）分家 |
| **2026-09-13** | 冷氣的價格和圖推不到邊界；HITACHI 的選取框太大；放手又被拉回去 | 同時有五份：`inkBox`（牆）、`selRect`（選取框）、`keepInside`（外框）、`clampToMargin`（整塊外框）、`imgVisBox`（灰圖）。整批換成 `visBox` 一份 |

2026-09-13 那一次，新測試在**改之前**量到 142 項沒停在線上：灰圖差 17～22 個單位、
換行的品名差 106、SKU／規格／品名上下差 3～7、拖到邊界放手之後又被 keepInside 往裡拉 3～10。
改完剩 0（見下面怎麼跑）。

## 測試：`wall.mjs`

```bash
node .claude/skills/cell-wall/wall.mjs              # 預設邊界 ＋ 邊界 30 各跑一輪（約 20 秒）
node .claude/skills/cell-wall/wall.mjs --margin 12  # 只跑一個邊界
node .claude/skills/cell-wall/wall.mjs --all        # 過了的也印
```

開單獨的 `2cell-product-pick.html`（不碰上層、不碰 Supabase），一價／二價／三價各排一格，
塞一張四周透明的 logo、一張真的商品圖、一張貼圖、一個劃線價格，然後**用真的滑鼠事件**：

- 每一塊零件往左、右、上、下各用力拖一次（按著 Alt，不讓對齊線吸），
  看得見的邊要落在邊界線上（±1.5 單位）——放手那一刻量一次，**再完整重排一次**再量一次
  （放手之後被 keepInside 拉走也算錯）；
- 一價那一格的圖、價格、貼圖、logo 往右下拉大，要停在線上、不能跑出去
  （到倍率上限停住的另外標出來）。

有一項沒過就 exit 1。印出來的兩欄是「離線多遠」：負的＝還沒到線就停了，正的＝跑出去了。

**什麼叫過**：`全部停在線上`，而且沒有 `page problems`。

## 寫測試／讀測試的坑（這支自己踩過的）

- **標準答案要自己量**（`wall-probe.js` 的 `truth()`），不叫 `visBox()`。拿被測的那一支當答案，
  壞的時候兩邊一起錯，測試照樣綠。
- **滑鼠移動和放手送給 `document.body`，不送 `window`**：有一支提示框的 mousemove 直接叫
  `e.target.closest`，送 window 會炸在那裡 —— 那是測試的錯，不是程式的。
- **貼圖的 `svg` 欄是一張圖的網址**（data URL），不是 svg 原始碼。塞原始碼會生出
  `<img src="<svg …">` 那種壞掉的 DOM，量到的是測試自己弄壞的東西。
- **拖的時候按 Alt**：不按的話對齊線可能在牆旁邊吸住，看起來像「沒到線」。
- 真的拖不到的時候，先分清楚是**牆**（`clampAll` 夾住）還是**零件自己變了**
  （品名拖到右邊折成兩行 —— 2026-09-13 那一次最後剩下的就是這個：`.blk` 是 border-box，
  品名的 max-width 卻照 content-box 算，「減掉」內距和框線，上限窄了兩圈，一靠近牆就折行。
  修法是照 border-box「加上」右邊那一圈，不是改牆。**先猜「捨入」加一點餘裕是沒用的**，
  那一次就白試了一輪）。寫一支小探針把 `offsetWidth`、`box-sizing`、算出來的 `max-width`、
  `visBox` 都倒出來，一眼就分得出來 —— 又是「兩份量法對不起來」，只是這次一份在 CSS 裡。

## 新增一種零件的清單

1. 它看得見的邊是什麼？在上面那張表加一列，**在 `visBox()` 那一段做到**（多半不必改：
   有底色／框線的就是它自己，透明的容器會往裡問，圖／svg 就是它自己）。
2. 它有沒有會裁掉內容的容器（`overflow:hidden`）？`paintedRect` 已經會取交集，確認一下。
3. `wall-probe.js` 的 `truth()` 加一條它的標準答案，`CASES` 裡讓它出現。
4. 跑 `wall.mjs`。預設版面有動到的話，另外跑 `2cell-parity` 和 `stress-board` 比前後，
   並截圖跟 `rule.png` 並排看（最高原則）。
