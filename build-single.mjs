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

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, 'design_and_PM.html');
const PICK = join(here, '2cell-product-pick.html');
const OUT  = join(here, 'dm-editor-single.html');

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
console.log('  驗一下：node .claude/skills/run-pm-page/driver.mjs --file dm-editor-single.html?seed=1 --wait 800');
