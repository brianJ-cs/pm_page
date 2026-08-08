#!/usr/bin/env node
/* 本機預覽：node dev.mjs　（或 netlify dev —— 它會自己叫這一支）
 *
 * 以前要先自己跑一次 build-single.mjs 才有 public/，忘了跑就看到舊的畫面。
 * 這支把那件事收起來：開起來先複製一次，之後你存檔它就自己再複製一次，
 * 所以「改完重整瀏覽器」就會是新的，不必回頭下指令。
 *
 * 一樣沒有相依套件 —— Node 內建的 http 就夠了。_redirects 也是照著讀的，
 * 所以本機看到的路由跟 Netlify 上一模一樣（/ 和 /editor）。
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PUB  = join(here, 'public');
const PORT = +(process.env.PORT || 8080);
const NO_SYNC = !!process.env.PM_NO_SYNC;

/* 這幾支是正本。任何一支存檔就重跑一次複製。 */
const SOURCES = ['design_and_PM.html', '2cell-product-pick.html',
                 'config.js', 'supabase-sync.js', '_redirects'];

function build(why){
  const r = spawnSync(process.execPath, [join(here, 'build-single.mjs')], { cwd: here });
  if (r.status !== 0){
    process.stdout.write(String(r.stderr || ''));
    console.log('build 失敗 —— 先用上一次的 public/ 繼續跑');
    return;
  }
  console.log(`${new Date().toTimeString().slice(0,8)}  ${why}`);
}
build('public/ 準備好了');

/* 存檔通常會連著觸發好幾次（編輯器寫檔的方式），等它停下來再複製一次就好。 */
let t = 0;
for (const f of SOURCES){
  try {
    watch(join(here, f), () => {
      clearTimeout(t);
      t = setTimeout(() => build(`${f} 變了 → 重新複製`), 120);
    });
  } catch (_){ /* 檔案不在就算了，build 那邊會抱怨 */ }
}

/* ---- 路由：照 _redirects 走，看到的跟線上一樣 ---------------------------- */
let routes = [];
async function loadRoutes(){
  try {
    routes = (await readFile(join(PUB, '_redirects'), 'utf8')).split(/\r?\n/)
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
      .map(l => l.split(/\s+/))
      .filter(p => p.length >= 2 && p[2] !== '301' && p[2] !== '302')
      .map(([from, to]) => ({ from, to }));
  } catch (_){ routes = []; }
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
               '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
               '.ico':'image/x-icon', '.mp3':'audio/mpeg' };

createServer(async (req, res) => {
  await loadRoutes();
  let path = decodeURIComponent(req.url.split('?')[0]);
  const hit = routes.find(r => r.from === path);
  if (hit) path = hit.to;
  if (path.endsWith('/')) path += 'index.html';

  /* public/ 以外的東西一律不給 —— 這台機器上那個資料夾旁邊還放著 CLAUDE.md、
     past guides/、備份，本機預覽不該讓它們也變成網址（線上發的也只有 public/）。 */
  const file = normalize(join(PUB, path));
  if (!file.startsWith(PUB)){ res.writeHead(403).end('nope'); return; }

  /* PM_NO_SYNC=1 → 發一份空的 config.js，PlanSync.ok() 就會回 false，整支走純
     localStorage。config.js 裡是真的 Supabase 金鑰，開著測會直接動到公司在用的
     資料（跑一次「壓力測試：塞滿假檔期」就是往正式資料庫塞一筆假檔期）。
     自動化測試一律要開這個；自己手動看畫面才關掉它。 */
  if (NO_SYNC && path === '/config.js'){
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end('/* PM_NO_SYNC：本機測試用的空設定，不連任何後端 */\n'
          + 'window.SUPABASE = { url:"", anonKey:"", bucket:"" };\n');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
                         'cache-control': 'no-store' });   // 改完重整就要看到新的
    res.end(body);
  } catch (_){
    const have = await readdir(PUB).catch(() => []);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${path}\n\npublic/ 裡有：\n  ` + have.join('\n  '));
  }
}).listen(PORT, () => {
  console.log(`本機預覽  http://localhost:${PORT}/        （行銷頁）`);
  console.log(`          http://localhost:${PORT}/editor  （編輯器）`);
  console.log(NO_SYNC ? '⚠ PM_NO_SYNC：不連 Supabase，資料只留在這台瀏覽器'
                      : '連著正式的 Supabase —— 要測到會寫資料的東西，改用 PM_NO_SYNC=1 node dev.mjs');
  console.log('正本改了就自己重新複製，你只要重整瀏覽器。Ctrl+C 結束。');
});
