---
name: deploy-pm-page
description: 把 pm_page 發到 Netlify 的三條線（草稿永久連結／固定網址 alias／正式站）分別會動到誰、哪一個旗標才是省 build 額度的那一個，以及發出去的那一份接的是不是公司的正式資料庫。使用者說「發一份給人看」「deploy」「permalink」「上線」之前先看這一份 —— 這裡分得清「他的連結會不會跟著變」和「這一發會不會寫到正式資料」。
---

# 發佈 pm_page

站台寫死：`b7412c61-ca3f-4474-853b-babbbbae366f`＝`famous-buttercream-edc32c`。
**一定要帶 `--site`** —— `netlify status` 在這台機器上報的是別人的專案（jocular-clafoutis），
不指名就發到別人站上去了。

## 先問一句：這個連結，之後會不會跟著你變？

發佈只有這一個決定要做。**問清楚再發**，因為兩種都合理，而選錯的代價不對稱：
本來要凍住的卻會動，等於在老闆看到一半的時候把畫面換掉。

| 想要的效果 | 怎麼發 | 網址 |
|---|---|---|
| **凍住這一刻**給人看，之後怎麼改都不影響他 | 純草稿（不帶 `--alias`、不帶 `--prod`） | `https://<deploy-id>--famous-buttercream-edc32c.netlify.app` |
| 他**一直重整看最新的**，你不必每次寄新連結 | `node deploy.mjs review` | `https://review--famous-buttercream-edc32c.netlify.app` |
| 自己改自己看 | `node deploy.mjs dev` | `https://dev--famous-buttercream-edc32c.netlify.app` |
| **真的上線** | `--prod`（這個 repo 裡沒有任何一支會幫你做，是故意的） | `https://famous-buttercream-edc32c.netlify.app` |

網址就看得出來是哪一種：**子網域是一長串 16 進位＝凍住的**，是個單字＝會跟著動的指標。

### 純草稿（沒有現成腳本，手打）

`deploy.mjs` 一定會加 `--alias`，所以它發不出純草稿。要凍住的那一份這樣發：

```bash
cd C:/Users/User/Documents/work/pm_page
node build-single.mjs
netlify deploy --no-build --dir public \
  --site b7412c61-ca3f-4474-853b-babbbbae366f \
  --message "給人看的快照 — <日期>"
```

`netlify deploy` 印出來的 **Website Draft URL** 就是那個永久連結，直接把它給人。

## `--no-build` 才是省額度的那一個

「草稿不花額度、正式站才花」是錯的。**被計費的是 build 分鐘數**，而那是 Netlify 在雲端
跑 `netlify.toml` 裡的 build command 燒掉的 —— 草稿和正式站一樣會燒。

- `--no-build` → **省額度**（build 在本機跑完了）
- 不帶 `--prod` → **保護正式站**（正式網址不動）

兩件事互相獨立，兩個都要。

### `--no-build` 的代價：忘了 build 不會有任何錯誤訊息

`--no-build` 是「原封不動上傳 `public/`」，Netlify 不會幫你重新產生。所以**漏掉
`node build-single.mjs` 就是把上一版發出去，而且一聲不吭**。`deploy.mjs` 存在的唯一理由
就是把這兩步綁在一起。手打 `netlify deploy` 的時候，自己記得先 build。

## 檔案凍住了，資料沒有

永久連結凍的是**程式碼**。`public/config.js` 裡是**正式 Supabase 專案的**網址和 anon key，
所以那份快照連的是大家共用的那一個資料庫：

- 他看到的內容還是會自己變（別人在改）。
- 他「試用」時點的每一下 —— 移格子、蓋章、清空資料 —— **都寫進正式資料**。

要給外人試、或不想被亂寫，發 demo 那一份：

```bash
node deploy.mjs review --demo     # 發 out/demo，config.js 是唯讀的那一份
```

那一份的 config.js 是正式的網址和 anon key **加上 `readOnly: true`**：`PlanSync.ok()` 回 false，
檔期、便利貼、貼紙庫、上傳全部只存看的人自己的瀏覽器，碰不到公司資料；
但**商品目錄、商品圖、品牌 Logo 照樣讀得到**（`canRead()`）。給人看的時候網址後面加 `?seed=1` 才有示範檔期。
⚠️ **不要用佔位符**（整個不接）：2026-09-10 發過兩份，商品目錄整片空白、挑貨清單只剩內建那十幾支，
被當成「資料庫被清空了」。
（`out/demo` 的 config.js 是手工換過的，所以 `--demo` 不會重新 build，別把它 build 蓋掉。
要帶新程式進去：先 `node build-single.mjs`，再把 `public/` 除了 `config.js` 以外的檔案複製過去。）
⚠️ `out/demo/logo_page/config.js` 是正式的 Logo 專案：示範版裡設計點得開 Logo 庫那一頁，
那一頁自己連 supabase-js，**唯讀擋不到它**。

## 發完怎麼確認發對了

```bash
netlify api listSiteDeploys --data '{"site_id":"b7412c61-ca3f-4474-853b-babbbbae366f","per_page":5}'
```

看 `context`（`production` ／ `deploy-preview`）和 `links.alias`。
**`links.alias` 跟 `links.permalink` 一樣＝這一發沒有 alias**，也就是純草稿。
（2026-07-31 查過：這個站十發全部沒有 alias —— `review--` 這個網域從來沒存在過。
所以 `deploy.mjs` 最後印的那行網址，在還沒用它發過之前是連不上的。）

## 別做的事

- 不要在使用者沒說「上線／正式」的時候加 `--prod`。
- 不要刪舊 deploy 或站台 —— 別人手上的永久連結是靠那份 deploy 活著的。
- 永久連結 Netlify 會加 `X-Robots-Tag: noindex`，Google 找不到，但**有連結的人都進得去**：
  是不公開，不是有權限控管。
