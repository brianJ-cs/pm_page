---
name: edit-fast
description: pm_page 改東西的節奏：驗一次、不要在中途生附加產物、動手前先講清楚根本原因、前後兩句衝突就照新的那句，以及**怎麼動檔案**（一律寫一支 .mjs 用錨點改，不要在 shell 裡寫 JS；CRLF／LF 混著）和 driver 驗互動的坑。**改這個專案的任何 .html／.js 之前先看這一份，不必等使用者說** —— 尤其是要一次改好幾個檔案、要用 sed／node -e／heredoc 改檔、或事情已經開始拖的時候。這裡講的是「怎麼不浪費時間」，不是「怎麼寫」（那在 CLAUDE.md 和 pm-page-traps）。
---

# 改這個專案的節奏

時間不是花在改，是花在**驗**。2026-07-30 那一輪量過：`stress.mjs` 一次要等 60 個 iframe
（`--wait 8000`），`parity.mjs` 一個 case 要開兩次瀏覽器 —— 每改一行就跑一輪，
一個下午就是這樣過去的。下面是那一輪換來的規矩。

## 1. 驗一次，在最後

- **不要每改一行就驗。** 一批改完再驗。
- 預設只跑 `parity.mjs --case 3`。它紅了才跑 `--case 1`／`--case 2`。
- `stress-board` 只在**動到排版算法**之後跑一次，不是每次。
- **不要順手截圖。** 使用者要看畫面才截（他會說「看起來怎樣」）。
- 一批的最後一次驗，**一定要含一個真的互動**（點一下、拖一下）。只開頁面看
  console 是不夠的：那一輪刪掉 `FIT`／`FOX`／`FOY` 之後 `scaleOf`／`cellPt`
  還留著參照，整頁載得起來、console 乾淨，但**格子裡點任何東西都會炸**。

```bash
# 一批改完，這三行就是全部（順序：先便宜的、再貴的）
node .claude/skills/2cell-parity/parity.mjs                     # 版面比例
node .claude/skills/run-pm-page/scenario.mjs smoke               # 四個畫面沒炸
node .claude/skills/run-pm-page/scenario.mjs blk --assert "…"    # 真的點下去、拖一下
```

## 2. 動手前先說根本原因（兩句），不要邊改邊猜

那一輪同一個「東西塞不進格子」修了四次：畫面整份縮 → 整組談縮多少 → 排版前先縮字 →
換掉座標框。四次都是在治症狀。**根本原因一開始就在檔案裡**：字級是寫死的 px，
框卻是實際公分算出來的；而原版的框永遠 540×420，所以它沒有這個問題。
先讀 `adoptStageCm`／`U_PER_CM`／原版的框，兩句話講出原因，再動手 —— 省下三輪。

## 3. 前後兩句對不起來，照新的那句做，然後說一聲

不要停下來問。**新的那句是使用者最新的意思**，照它做，並在回報裡寫一行
「這跟先前的 X 衝突，我照新的做了」。
（例：先前談定「同一版位字要一樣大」，後來說「比例照原版」—— 照新的，並記一筆。）

真正該問的只有一種：**兩個做法會做出完全不同的東西，而且改錯要重做**。
那種問題一次問完、附上選項，不要一次問一個。

## 4. 只要程式的時候，不要生附加產物

沒有明確要求就不要寫計畫書、不要建 skill、不要做示範頁。那一輪中途生了兩支量測
腳本，然後花時間在**修那兩支腳本自己的 bug**（量錯尺、跨組比較）——
那些時間不在使用者的目標上。

要寫的時候會明講：「plan it out」「write a skill」「gimme a demo」。

## 5. 別重跑已經綠的東西

驗過而且沒再動到那一塊，就不要再跑一次。要引用結果就引用上一次的數字。

## 6. 這個專案的量尺在哪

| 要驗什麼 | 跑什麼 | 貴不貴 |
|---|---|---|
| 版面比例跟原版一樣 | `2cell-parity/parity.mjs [--case 1\|2\|3]` | 中（開兩次瀏覽器）|
| 極端尺寸不溢出、同組一樣大 | `stress-board/stress.mjs` | **貴**（60 個 iframe）|
| 四個畫面沒炸 | `run-pm-page/scenario.mjs smoke` | 便宜 |
| 真的點得動、拖得動 | `run-pm-page/scenario.mjs blk --assert "…"` | 便宜 |

## 7. 環境

- `netlify` 沒有先在 settings 允許的話，部署指令會被權限分類器擋下來，
  只能請使用者自己用 `!` 跑 —— 那是一次來回。要部署前先確認允許清單。
- 動到正式站之前先看 `build_settings.repo_url` 確認是哪個站
  （`netlify status` 說的 current 不可信，見 memory 的 netlify-sites）。

## 8. 動檔案：**不要在 shell 裡寫 JS**

2026-09-08 那一輪（貼紙）事後點過：一個四檔案的改動，**大約十次工具呼叫花在跟引號
打架**，不是在改東西。這一節就是那十次換來的。

- **改檔案一律：用 Write 寫一支 `.mjs` 到 scratchpad，再 `node` 它。**
  不要 `node -e`、不要在 heredoc 裡塞 JS。這台機器是 Windows 上的 Git Bash，
  每一層都會再吃掉一次跳脫：
  ・`"\r\n"` 在雙引號裡會變成**真的** CR → `Invalid regular expression: missing /`
  ・`\\\\u00a0` 收不回來 → 原始碼裡留下一個看不見的 NBSP
  ・`\${...}` 在 heredoc 外會被展開；heredoc 本身也炸過一次 `unexpected EOF`
- **`python` / `python3` 是 Windows 市集的假殼**：不執行、也不報錯，`&&` 後面照跑。
  當它不存在。
- **CRLF 和 LF 混著**：`design_and_PM.html`、`build-single.mjs`、`CLAUDE.md` 是 **CRLF**；
  `2cell-product-pick.html`、`sticker_editor.html`、`sticker-render.js` 是 **LF**。
  跨行的錨點不換行尾就永遠對不上。所以那支 `.mjs` 一律長這樣（寫一次，之後都抄它）：

```js
import fs from 'fs';
const p='design_and_PM.html';
let s=fs.readFileSync(p,'utf8');
const nl=t=>t.replace(/\r?\n/g,'\r\n');        // CRLF 的檔案套它；LF 的檔案拿掉
const sub=(a0,b0)=>{ const a=nl(a0),b=nl(b0);
  if(!s.includes(a)) throw new Error('找不到錨點：'+a0.slice(0,60));
  if(s.split(a).length>2) throw new Error('錨點不只一個：'+a0.slice(0,60));
  s=s.split(a).join(b); };
```

  兩個 `throw` 才是重點：**錨點對不到、或不只一個，就停下來** —— 不要讓它默默改到
  別的地方去。用 `split/join` 不用 `replace()`：替換字串裡的 `$'` 會把整個後半段
  塞進去（`build-single.mjs` 裡那段 `$` 的註解講的就是同一個坑）。

- **不要用行號改**（`sed -i '216a }'`）。這一輪就插錯一行，而且 **`node --check` 照樣過**
  —— IIFE 裡的頂層 `return` 是合法的，於是整支 `StickerRender` 根本沒被匯出，
  檔案卻「語法沒問題」。行號會跑，錨點不會。
- **`| cat -n` 在這個 repo 會卡住**（OneDrive）：那一次卡了 25 分鐘才回來。
  純 `sed -n '100,120p'` 秒回。

## 9. 用 driver 驗互動的四個坑

同一輪換來的，跟 `run-pm-page` 那份併著看。

- **`--eval` 看不到那支程式的頂層 `let`／`function`**（`activeTab`、`readStickerLib`
  都是 undefined）。**斷言一律走 DOM**：`document.getElementById(...)`、
  `document.querySelector('.ccanvas').contentDocument`（driver 帶了
  `--allow-file-access-from-files`，所以格子裡的畫布量得到）。
- **快捷鍵會被搶焦點**：點過任何 `<input>`（例如「顯示便利貼」那顆開關）之後，
  `--key t` 就進不到那支程式了 —— 那一次因此連貼了三張貼紙都沒發現。
  **能點按鈕就點按鈕**（`--click ".tool[data-tool=edit]"`）。
- **工具列自己會捲**：視窗矮的時候 `.tool[data-tool=sticker]` 捲出畫面，
  `--click` 回「no visible element」。那不是選擇器寫錯。
- **點格子會點到別的東西**：便利貼標記就在格子中央，點下去開的是留言卡。
  先 `--click-text "顯示便利貼"` 收掉，或挑
  `.cell.filled:not(:has(.cmk)):not(:has(.cnb))`。
