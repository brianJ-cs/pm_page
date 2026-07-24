#!/usr/bin/env node
/* 把兩支檔案合成一支：node build-single.mjs
 *
 * 平常開發還是改 design_and_PM.html 和 2cell-product-pick.html 這兩支 —— 它們是
 * 正本。這支只是把商品版面那一頁整個塞進主程式裡，產出一個「寄給別人也不會壞」
 * 的單檔版本。分開的兩支檔案少了任何一支，拼板就是一片空白，而且不會報錯。
 *
 * 做法：商品版面那一頁存成 window.__PICK_HTML 這個字串，主程式的 setPickFrame()
 * 看到它就改用 srcdoc 載，不再去要那個相對網址的檔案。
 *
 * 產出的檔案是自動生成的，不要直接改它 —— 改了下次 build 就沒了。
 */

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, 'design_and_PM.html');
const PICK = join(here, '2cell-product-pick.html');
const OUT  = join(here, 'dm-editor-single.html');
const PUB  = join(here, 'public');

const [main, pick] = await Promise.all([readFile(MAIN, 'utf8'), readFile(PICK, 'utf8')]);

if (!main.includes('window.__PICK_HTML')) {
  console.error('design_and_PM.html 裡沒有 setPickFrame()／window.__PICK_HTML —— ' +
                '單檔版靠它才能改用 srcdoc 載。先把那段補回去再 build。');
  process.exit(1);
}

/* 這個字串要住在 <script> 裡面，所以裡面每一個 </script> 都得跳脫，
   不然瀏覽器會在那裡把外層的 script 關掉。 */
const embedded = JSON.stringify(pick).replace(/<\/script/gi, '<\\/script');

const banner =
`<!-- ==========================================================================
     這是自動產生的單檔版本：design_and_PM.html + 2cell-product-pick.html
     產生方式：node build-single.mjs
     不要直接改這一支 —— 改正本那兩支，然後重跑一次。
     ========================================================================== -->
<script>window.__PICK_HTML = ${embedded};</script>
`;

if (!main.includes('<body>')) {
  console.error('找不到 <body>，不知道要把商品版面那一頁插在哪裡。');
  process.exit(1);
}

const out = main.replace('<body>', '<body>\n' + banner);
await writeFile(OUT, out, 'utf8');

const kb = n => (n / 1024).toFixed(0) + ' KB';
console.log(`寫出 ${OUT}`);
console.log(`  主程式 ${kb(main.length)} + 商品版面 ${kb(pick.length)} → 單檔 ${kb(out.length)}`);

/* 順手把要丟上 Netlify 的那一份也擺好。名字改成 ASCII 是有原因的：
   「落版單系統.html」當網址會變成一長串 %E8%90%BD…，_redirects 裡也很難讀。
   Netlify：Build command 填 `node build-single.mjs`、Publish directory 填 `public`。 */
await mkdir(PUB, { recursive: true });
await writeFile(join(PUB, 'editor.html'), out, 'utf8');
await copyFile(join(here, '落版單系統.html'), join(PUB, 'index.html'));
/* 壓力測試 devtool 走自己的門：商品版面本人原封不動擺成 /stress。它是整支
   canvas 加上「壓力測試：價格拖曳」那顆鈕，全螢幕、跟真實檔期完全隔離 ——
   在線上開 /stress 就能示範重壓下的排版，永遠碰不到 localStorage 裡的檔期。 */
await copyFile(join(here, '2cell-product-pick.html'), join(PUB, 'stress.html'));
for (const f of ['config.js', 'supabase-sync.js', '_redirects'])
  await copyFile(join(here, f), join(PUB, f));

console.log(`寫出 ${PUB}${'\\'} —— index.html(行銷) / editor.html(編輯器) / stress.html(壓力測試) / config.js / supabase-sync.js / _redirects`);
console.log('  驗一下：node .claude/skills/run-pm-page/driver.mjs --file dm-editor-single.html?seed=1 --wait 800');
