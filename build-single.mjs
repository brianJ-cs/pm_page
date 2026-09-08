#!/usr/bin/env node
/* 把要公開的檔案擺進 public/：node build-single.mjs
 *
 * 平常就只是「複製」—— 沒有任何字串處理。Netlify 一次發好幾支檔案完全沒問題，
 * 編輯器用相對網址載得到商品版面那一頁，拼板就會動。
 *
 *   public/index.html               ← design_and_PM.html（整支程式；三個身分都從這裡進）
 *   public/2cell-product-pick.html  ← 名字不能改：主程式是用這個相對網址載它的
 *   public/product.html             ← 商品目錄（全公司一份，跟檔期無關）
 *   public/sticker_editor.html      ← 貼紙庫（?embed=1 是被主程式請進浮層的那一種穿法）
 *   public/sticker-render.js        ← 貼紙怎麼畫出來（貼紙庫和格子裡的畫布共用同一份）
 *   public/logo_page/               ← 品牌 Logo 庫（本來是獨立的一站）
 *   public/config.js, supabase-sync.js, _redirects
 *
 * ---- 合成單檔（--bundle）-------------------------------------------------
 * 只有「要寄一個檔案給別人」的時候才需要：對方沒有第二支檔案也開得起來。
 * 網站不需要它，所以預設不做 —— 那一段要把 96KB 的 HTML 塞進另一支的 <script>
 * 裡，是這支腳本唯一會動字串的地方，也是唯一出過事的地方（見下面的 $ 註解）。
 *
 *   node build-single.mjs --bundle      → 另外產出 dm-editor-single.html
 */

import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PUB  = join(here, 'public');
const MAIN = join(here, 'design_and_PM.html');
const PICK = join(here, '2cell-product-pick.html');
const kb = n => (n / 1024).toFixed(0) + ' KB';

/* ---- 平常這一段就是全部：複製 ------------------------------------------- */
/* 每次都從空的開始。上一版產出的檔案留在 public/ 裡不會有人發現，
   而 `netlify deploy --no-build` 是「原封不動上傳這個資料夾」—— 那份舊檔就
   跟著發出去了（editor.html 就這樣差點被留下來）。 */
await rm(PUB, { recursive: true, force: true });
await mkdir(PUB, { recursive: true });
/* 行銷那一支（落版單系統.html）併進主程式了，所以 / 就是主程式本身。
   舊書籤（/editor）靠 _redirects 指回來，一個都不會斷。 */
await copyFile(MAIN, join(PUB, 'index.html'));
await copyFile(PICK, join(PUB, '2cell-product-pick.html'));
/* ⚠️ 主程式是用相對網址開這幾支的（浮層裡的 iframe），漏掉哪一支，站上那顆鈕
   就是一頁 404 —— 而本機直接開檔案完全看不出來（檔案就在旁邊）。
   貼紙庫就是這樣漏過一次。 */
for (const f of ['product.html', 'sticker_editor.html', 'sticker-render.js', 'config.js',
                 'supabase-sync.js', '_redirects'])
  await copyFile(join(here, f), join(PUB, f));

/* 品牌 Logo 庫：只搬跑得起來的那兩支。
   ⚠️ 刻意不用「整個資料夾複製」—— logo_page/ 裡面還有它自己的 .git、.netlify、
   schema.sql（資料庫的 DDL）和一支不相干的示範頁（auto.html）。
   那些跟著發出去，等於把另一個專案的內部檔案掛在這個站上。 */
await mkdir(join(PUB, 'logo_page'), { recursive: true });
for (const f of ['index.html', 'config.js'])
  await copyFile(join(here, 'logo_page', f), join(PUB, 'logo_page', f));

console.log('寫出 public/ —— index.html + 2cell-product-pick.html + product.html'
          + ' + sticker_editor.html + logo_page/ / config.js / supabase-sync.js / _redirects');

if (!process.argv.includes('--bundle')) {
  console.log('  （要寄一個檔案給別人才需要合成單檔：node build-single.mjs --bundle）');
  process.exit(0);
}

/* ---- --bundle：合成一支寄得出去的單檔 ------------------------------------ */
const OUT = join(here, 'dm-editor-single.html');
const [main0, pick0, srender] = await Promise.all([
  readFile(MAIN, 'utf8'), readFile(PICK, 'utf8'),
  readFile(join(here, 'sticker-render.js'), 'utf8')]);

/* 貼紙的畫法是**另一支檔案**（貼紙庫和格子裡的畫布共用同一份），而單檔版旁邊
   不會有它 —— 不內嵌的話，寄出去的那一份一打開就是 StickerRender is not defined，
   而那一行在整支程式的最上面：整頁是死的（正是 CLAUDE.md 那條「語法檢查擋不住」）。
   ⚠️ 用 split／join 換，不要 replace()：那個字串裡有 $ 的話會被當成替換樣式，
   跟下面那一段同一個坑。內容裡的 </script 也要跳脫，不然外層的 script 會被關掉。 */
const RENDER_TAG = '<script src="sticker-render.js"></script>';
const RENDER_INLINE = '<script>/* sticker-render.js（單檔版內嵌一份） */\n'
  + srender.replace(/<\/script/gi, '<\\/script') + '\n</script>';
const main = main0.split(RENDER_TAG).join(RENDER_INLINE);
const pick = pick0.split(RENDER_TAG).join(RENDER_INLINE);

if (!main.includes('window.__PICK_HTML')) {
  console.error('design_and_PM.html 裡沒有 setPickFrame()／window.__PICK_HTML —— ' +
                '單檔版靠它才能改用 srcdoc 載。先把那段補回去再 build。');
  process.exit(1);
}
if (!main.includes('<body>')) {
  console.error('找不到 <body>，不知道要把商品版面那一頁插在哪裡。');
  process.exit(1);
}

/* 這個字串要住在 <script> 裡面，所以裡面每一個 </script> 都得跳脫，
   不然瀏覽器會在那裡把外層的 script 關掉。 */
const embedded = JSON.stringify(pick).replace(/<\/script/gi, '<\\/script');

const banner =
`<!-- ==========================================================================
     這是自動產生的單檔版本：design_and_PM.html + 2cell-product-pick.html
     產生方式：node build-single.mjs --bundle
     不要直接改這一支 —— 改正本那兩支，然後重跑一次。
     ========================================================================== -->
<script>window.__PICK_HTML = ${embedded};</script>
`;

/* 用函式當替換內容，不要直接給字串 —— 字串裡的 $' 是 replace() 的替換樣式
   （意思是「比對到的後面那一整段」），而商品版面那一頁裡就有 '$'+b.price 這種
   寫法。給字串的話，$' 會把主程式剩下的兩百多 KB 原封不動塞進那個 JS 字串裡：
   整包 script 從那裡壞掉、DOM 也跟著錯亂，而且錯誤訊息只說「Invalid or
   unexpected token」，完全看不出跟 $ 有關。函式版本不做任何 $ 展開。 */
const out = main.replace('<body>', () => '<body>\n' + banner);

/* 黏完對一下大小。合起來應該約等於兩支相加 —— 差很多就是上面那類意外又發生了，
   與其讓它安靜地產出一支壞檔，不如在這裡停下來。 */
const expected = main.length + pick.length;
if (out.length > expected * 1.2) {
  console.error(`合成後 ${kb(out.length)}，但兩支加起來才 ${kb(expected)} —— `
              + '中間多塞了東西，這支八成是壞的。先查 build-single.mjs 的字串處理。');
  process.exit(1);
}

await writeFile(OUT, out, 'utf8');
console.log(`寫出 ${OUT}`);
console.log(`  主程式 ${kb(main.length)} + 商品版面 ${kb(pick.length)} → 單檔 ${kb(out.length)}`);
console.log('  驗一下：node .claude/skills/run-pm-page/scenario.mjs smoke --file dm-editor-single.html');
