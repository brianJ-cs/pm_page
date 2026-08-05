#!/usr/bin/env node
/* 跟 2cellOriginal.html 對帳：同樣的商品，每一個元素**佔格子的百分比**差多少。
 *
 * 為什麼要用百分比：原版的格子永遠是 540×420，所以「品名佔多高」這件事在原版裡
 * 是一個固定比例。現在的畫布格子是落版給的實際公分，px 直接比毫無意義 ——
 * 談定的驗收標準是「預設狀態下，每個元素佔格子的比例要跟原版一樣」，那就量比例。
 *
 * 兩邊挑的是同一批商品（原版存的是列號，現在存的是 SKU，下面 CASES 對好了）。
 * 量的時候把現在的畫布開成 9×7cm ＝ 原版的 540:420，不然拿不同長寬比的格子
 * 去比百分比，差多少都不知道是誰造成的。
 *
 *   node .claude/skills/2cell-parity/parity.mjs              三個價格那一組
 *   node .claude/skills/2cell-parity/parity.mjs --case 1     一個價格
 *   node .claude/skills/2cell-parity/parity.mjs --json       給 diff 用
 *   node .claude/skills/2cell-parity/parity.mjs --cm 17.5,1.6  換個格子形狀（原版沒有對照，只印現況）
 *
 * 差超過 1.5 個百分點就 exit 1。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(here, '..', 'run-pm-page', 'driver.mjs');

const argv = process.argv.slice(2);
const val = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
const jsonOnly = argv.includes('--json');
const nPrice = String(val('--case', '3'));
const cm = String(val('--cm', '9,7')).split(',').map(Number);
const TOL = Number(val('--tol', '1.5'));          // 百分點

/* 同一批商品的兩種寫法。原版的 picked 是 ROWS 的列號，現在的是 SKU 字串。
   一價／二價／三價各挑一組，因為價格數會換一套預設字級（PRICE_COUNT_FS）。 */
const CASES = {
  '1': { rows: [0],       skus: ['2156742'] },
  '2': { rows: [0, 2],    skus: ['2156742', '2156739'] },
  '3': { rows: [0, 2, 5], skus: ['2156742', '2156739', '2156738'] },
};
const pick = CASES[nPrice];
if (!pick){ console.error('--case 只認 1 / 2 / 3'); process.exit(1); }

/* 量測：每一個 .blk 佔格子的百分比。兩邊跑的是同一段程式，這樣就不會有
   「量法不一樣」的嫌疑 —— 差出來的就真的是版面的差。 */
const MEASURE = `(()=>{
  const cell=document.querySelector('.cell');
  const cr=cell.getBoundingClientRect();
  const pc=(v,d)=>+(v/d*100).toFixed(2);
  return JSON.stringify({
    cellPx:[Math.round(cr.width),Math.round(cr.height)],
    aspect:+(cr.width/cr.height).toFixed(3),
    blocks:[...cell.querySelectorAll('.blk')].map(n=>{
      const r=n.getBoundingClientRect();
      return { k:n.className.replace('blk ','').split(' ')[0],
               x:pc(r.left-cr.left,cr.width),  y:pc(r.top-cr.top,cr.height),
               w:pc(r.width,cr.width),         h:pc(r.height,cr.height) };
    })
  });
})()`;

const run = (steps) => new Promise((ok, no) => {
  const p = spawn(process.execPath, [DRIVER, ...steps], { cwd: process.cwd(), stdio: ['ignore','pipe','pipe'] });
  let out = '';
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', () => {});
  p.on('error', no);
  p.on('close', code => ok({ out, code }));
});

/* driver 把 --eval 的結果印成 `eval   "<JSON 字串>"`。找最後那一段就好，
   不要用正規表示式硬拆（參數裡放 regex 會讓整行卡住，run-pm-page 那支有寫）。 */
function grab(out){
  const at = out.lastIndexOf('{\\"cellPx\\"');
  if (at < 0) return null;
  const line = out.slice(out.lastIndexOf('"', at), out.indexOf('\n', at));
  try { return JSON.parse(JSON.parse(line.trim())); } catch { return null; }
}

const origSteps = [
  '--file', '2cellOriginal.html', '--wait', '900',
  '--eval', `(()=>{picked=new Set(${JSON.stringify(pick.rows)});renderCell();return BLOCKS.length})()`,
  '--wait', '600', '--eval', MEASURE
];
const curSteps = [
  '--file', `2cell-product-pick.html?ui=stage&cmw=${cm[0]}&cmh=${cm[1]}`, '--wait', '900',
  '--eval', `(()=>{picked=new Set(${JSON.stringify(pick.skus)});cell().picked=picked;layoutKey='';renderOne(0,true);return BLOCKS.length})()`,
  '--wait', '700', '--eval', MEASURE
];

const [o, c] = await Promise.all([run(origSteps), run(curSteps)]);
const orig = grab(o.out), cur = grab(c.out);
if (!orig || !cur){
  console.error('量不到 —— 先各自跑一次 driver 看畫面：');
  console.error('  node .claude/skills/run-pm-page/driver.mjs --file 2cellOriginal.html --wait 900 --shot out/o.png');
  process.exit(1);
}

/* 同一種 kind 的第 n 個對第 n 個。原版的圖是斜著疊的、現在是排一列，順序都是
   buildBlocks 給的，所以第 n 個對第 n 個是對得上的。 */
const key = bs => { const seen = {}; return bs.map(b => { seen[b.k] = (seen[b.k]||0)+1;
  return { id: b.k + '#' + seen[b.k], ...b }; }); };
const O = key(orig.blocks), C = key(cur.blocks);
const ids = [...new Set([...O.map(b=>b.id), ...C.map(b=>b.id)])];

/* 談定過、故意跟原版不一樣的地方。列在這裡＝不算失敗，但**照樣印出來**：
   「知道為什麼」和「沒看到」是兩件事，藏起來的話下次真的歪掉也不會有人發現。
   格式：元素（* 是任意編號）、哪一個數字、為什麼。 */
const KNOWN = [
  { id:/^price#/, field:'w',
    why:'價格拿掉千分位（commit 61a4dab）—— 原版是 44,900，現在是 44900，字串短了約 2.3% 格寬' },
  { id:/^img#/, field:'x',
    why:'商品圖改成由左往右排開（談定），不是原版那種斜著疊 —— 大小照原版，位置攤開' },
  { id:/^img#/, field:'h',
    why:'預留圖改成正方形（談定）—— 原版寫死 170 高配 190 寬，其實是扁的' },
  { id:/^img#/, field:'y',
    why:'商品圖排開之後同一個 y（原版是每張往下錯 14）' },
  { id:/^(brand|name|model)#/, field:'x',
    why:'左右邊界從原版的 20 改成 10（談定：原版那個留白在實際版面上太寬）—— 靠左的那幾塊因此往左 1.85 個百分點' },
];
const known = (id, field) => KNOWN.find(k => k.id.test(id) && k.field === field);

const rows = ids.map(id => {
  const a = O.find(b=>b.id===id), b = C.find(x=>x.id===id);
  if (!a || !b) return { id, missing: !a ? '原版沒有' : '現在沒有' };
  const d = f => +(b[f]-a[f]).toFixed(2);
  /* 談定過的差異不參與「差最多」的判定，但單獨記下來一起印 ——
     「知道為什麼」和「沒看到」是兩件事。 */
  const notes = ['x','y','w','h'].filter(f => Math.abs(d(f)) > TOL && known(id, f))
                                 .map(f => ({ field:f, diff:d(f), why:known(id,f).why }));
  const judged = ['x','y','w','h'].filter(f => !known(id, f));
  const worst = Math.max(...judged.map(f=>Math.abs(d(f))), 0);
  return { id, orig:{x:a.x,y:a.y,w:a.w,h:a.h}, now:{x:b.x,y:b.y,w:b.w,h:b.h},
           d:{x:d('x'),y:d('y'),w:d('w'),h:d('h')}, worst:+worst.toFixed(2),
           notes, ok: worst <= TOL };
});

const bad = rows.filter(r => r.missing || !r.ok);

if (jsonOnly){
  console.log(JSON.stringify({ case:nPrice, cm, tol:TOL,
    origCell:orig.cellPx, nowCell:cur.cellPx, aspect:[orig.aspect,cur.aspect], rows }, null, 1));
} else {
  console.log(`\n=== 跟原版對帳（${nPrice} 個價格・格子 ${cm[0]}×${cm[1]}cm・容差 ${TOL} 個百分點） ===`);
  console.log(`原版格子 ${orig.cellPx.join('×')}px (${orig.aspect})　現在 ${cur.cellPx.join('×')}px (${cur.aspect})`);
  if (Math.abs(orig.aspect - cur.aspect) > .02)
    console.log('⚠ 兩邊長寬比不一樣，百分比沒有可比性 —— 用 --cm 調成 1.286');
  console.log('\n元素          原版 x,y,w,h %            現在 x,y,w,h %            差最多');
  rows.forEach(r => {
    if (r.missing){ console.log(' ' + r.id.padEnd(12) + r.missing); return; }
    const f = o => [o.x,o.y,o.w,o.h].map(v=>String(v).padStart(6)).join(' ');
    console.log((r.ok ? ' ok  ' : ' FAIL') + ' ' + r.id.padEnd(9)
      + f(r.orig) + '  ' + f(r.now) + '   ' + String(r.worst).padStart(6)
      + (r.notes && r.notes.length ? '   ※' + r.notes.map(n=>n.field+' '+n.diff).join(',') : ''));
  });
  const notes = rows.flatMap(r => (r.notes||[]).map(n => `${r.id} ${n.field}：${n.diff} 個百分點 —— ${n.why}`));
  if (notes.length){
    console.log('\n※ 談定過的差異（不算失敗）：');
    [...new Set(notes.map(n => n.split('—— ')[1]))].forEach(w => console.log('   ' + w));
  }
  console.log(`\n${bad.length ? bad.length + ' 個元素超出容差' : '全部在容差內'}\n`);
}

process.exit(bad.length ? 1 : 0);
