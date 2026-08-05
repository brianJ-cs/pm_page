#!/usr/bin/env node
/* 壓力測試的「量尺」：生一個 60 格的假檔期、開到拼板，然後量四條看得見的規矩。
 *
 * 為什麼要有這一支：壓力測試那張畫面壞得很全面（大小、位置、字級、溢出），
 * 用眼睛看只會得到「everything is fucked」這種沒辦法追蹤的結論。這裡把它變成
 * 四個數字 —— 改一版跑一次，就知道是真的好轉還是只是換一個地方壞。
 *
 * 跑法：
 *   node .claude/skills/stress-board/stress.mjs                 量一次，印表格
 *   node .claude/skills/stress-board/stress.mjs --shot out/s.png  順手截圖
 *   node .claude/skills/stress-board/stress.mjs --json           只印 JSON（給 diff 用）
 *
 * 有任何一條沒過就 exit 1，所以它同時是回歸測試。
 * 後端：走 driver.mjs，它自己會擋掉正式 Supabase（PM_NO_SYNC），不會寫到公司資料。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(here, '..', 'run-pm-page', 'driver.mjs');

const argv = process.argv.slice(2);
const jsonOnly = argv.includes('--json');
const shotIdx = argv.indexOf('--shot');
const shot = shotIdx >= 0 ? argv[shotIdx + 1] : null;

/* 在頁面裡跑的量測。全部只問 DOM —— 畫布裡的 BLOCKS/CELLS 是 let，
   從外面 evaluate 讀不到（run-pm-page 那支 SKILL.md 有寫，踩過）。
   價格數（nPrice）就數 .blk.price 有幾個，那跟畫布內部算的是同一件事。 */
const MEASURE = `(()=>{
  const fs=[...document.querySelectorAll('#boardOverview .ccanvas')];
  const cells=[];
  fs.forEach((f,i)=>{
    const cd=f.contentDocument; if(!cd) return;
    const cell=cd.querySelector('.cell'); if(!cell) return;
    const cr=cell.getBoundingClientRect();
    if(!cr.width||!cr.height) return;
    /* 一律換算成公釐 —— 這是唯一比得起來的尺。
       「同一個版位裡同樣價格數的格子要一樣大」講的是實際大小，不是「佔格寬幾 %」：
       格子寬 3.03cm 和 3.07cm 的兩格，實際一樣大的字，佔比本來就不一樣。
       用佔比當尺會把「其實是對的」判成錯（這支第一版就是這樣，量錯過一次）。
       每公分幾個 px 從網址帶進來的 cmw 反推 —— 那正是上層告訴畫布的實際尺寸。 */
    const q=new URLSearchParams((f.getAttribute('src')||'').split('?')[1]||'');
    const cmw=+q.get('cmw')||0, cmh=+q.get('cmh')||0;
    if(!cmw||!cmh) return;
    const pxPerCm=cr.width/cmw;
    const mm=px=>+(px/pxPerCm*10).toFixed(2);
    let outMax=0;
    cd.querySelectorAll('.blk').forEach(b=>{
      const r=b.getBoundingClientRect();
      outMax=Math.max(outMax, cr.left-r.left, r.right-cr.right, cr.top-r.top, r.bottom-cr.bottom);
    });
    const ps=[...cd.querySelectorAll('.blk.price')];
    const n=cd.querySelector('.blk.name')||cd.querySelector('.blk.brand');
    /* 量畫出來的高，不量 CSS 的 font-size：font-size 是排版座標裡的數字，
       不含 --cs、也不含 --fit —— 拿它當「實際多大」會看不見那道讓步，
       於是每一格其實大小不同，這一條卻是綠的（量錯過一次）。 */
    const fs1=ps.length?ps[0].getBoundingClientRect().height:0;
    let bottomGap=null;
    if(ps.length){
      const low=Math.max(...ps.map(p=>p.getBoundingClientRect().bottom));
      bottomGap=mm(cr.bottom-low);
    }
    const nr=n?n.getBoundingClientRect():null;
    cells.push({
      i, nPrice:ps.length, cm:[cmw,cmh],
      priceMm:mm(fs1),                          // 價格字級，公釐
      overflowMm:mm(Math.max(0,outMax)),
      nameAt: nr ? mm(nr.left-cr.left)+','+mm(nr.top-cr.top) : null,
      bottomGap                                  // 最低的價格離格子下緣幾公釐（負＝掉出去）
    });
  });
  return JSON.stringify({ canvases:fs.length, cells });
})()`;

const steps = [
  '--file', 'design_and_PM.html?seed=1', '--wait', '900',
  '--click', '#stressPlanBtn', '--wait', '2200',
  '--click-text', '拼板', '--wait', '8000',
  '--eval', MEASURE
];
if (shot) steps.push('--shot', shot);

const run = () => new Promise((ok, no) => {
  const p = spawn(process.execPath, [DRIVER, ...steps],
                  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; if (!jsonOnly) process.stderr.write(d); });
  p.stderr.on('data', d => { err += d; });
  p.on('error', no);
  p.on('close', code => ok({ out, err, code }));
});

/* driver 把 --eval 的結果印成 `eval   "…"`（JSON 字串）。這裡只認最後一段
   `{"canvases"` 開頭的東西 —— 不用正規表示式硬拆，找字串位置就夠了。 */
function pick(out){
  const at = out.lastIndexOf('{\\"canvases\\"');
  if (at < 0){
    const raw = out.lastIndexOf('{"canvases"');
    if (raw < 0) return null;
    try { return JSON.parse(out.slice(raw, out.indexOf('\n', raw)).trim()); } catch { return null; }
  }
  const line = out.slice(out.lastIndexOf('"', at), out.indexOf('\n', at));
  try { return JSON.parse(JSON.parse(line.trim())); } catch { return null; }
}

const { out, err, code } = await run();
const data = pick(out);

if (!data){
  console.error('量不到東西 —— driver 的輸出裡沒有那一段 JSON。先自己跑一次 driver 看畫面。');
  if (err.trim()) console.error(err.trim().split('\n').slice(-5).join('\n'));
  process.exit(1);
}

const cells = data.cells || [];
const byN = new Map();
cells.forEach(c => {
  if (!c.nPrice) return;
  if (!byN.has(c.nPrice)) byN.set(c.nPrice, []);
  byN.get(c.nPrice).push(c.priceMm);
});

/* 0.3mm 以內算同一級：螢幕上一個 px 在這種尺寸下就值 0.1mm 上下，
   字級本身又會被瀏覽器捨入 —— 抓太細的話永遠是紅的。 */
const SAME_MM = 0.3;
const overflow = cells.filter(c => c.overflowMm > 0.2);
const groups = [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([n, list]) => {
  const spread = +(Math.max(...list) - Math.min(...list)).toFixed(2);
  /* 級數用「全距有沒有超過容差」判，不要先分桶再數桶 ——
     兩個差 0.28mm 的值可能剛好落在桶的兩邊，就被算成兩級（誤判過一次）。 */
  const u = [...new Set(list.map(v => +v.toFixed(2)))].sort((a, b) => a - b);
  return { nPrice: n, cells: list.length, distinct: spread <= SAME_MM ? 1 : u.length,
           spread, sizesMm: u.slice(0, 6) };
});
/* 落點比對前先量化到 0.5%：5.4 和 5.5 是同一個位置（量到的是螢幕 px 除以格寬，
   本來就有捨入誤差）。不這樣的話這一條永遠是紅的，就沒有人會再看它。 */
const spot = s => s.split(',').map(v => (Math.round(parseFloat(v) * 2) / 2).toFixed(1)).join(',');
/* 落點和貼底也是**同組之內**才該一致 —— 規矩講的是「同一個版位裡同樣價格數的格子」。
   一價那一格的數字本來就比三價的大（PRICE_COUNT_FS），連同讓步倍率也是一組一個，
   所以跨組去比等於在比兩件本來就不該一樣的事（這支第一版就是這樣，冤枉過一次）。 */
const perGroup = n => cells.filter(c => c.nPrice === n);
const groupNs = [...new Set(cells.map(c => c.nPrice).filter(Boolean))].sort();

const nameByGroup = groupNs.map(n => ({
  n, spots: [...new Set(perGroup(n).map(c => c.nameAt).filter(Boolean).map(spot))]
}));
const nameSpots = nameByGroup.flatMap(g => g.spots.map(s => g.n + '價:' + s));
const nameOk = nameByGroup.every(g => g.spots.length <= 1);

const gapByGroup = groupNs.map(n => {
  const v = perGroup(n).map(c => c.bottomGap).filter(x => x != null);
  return { n, spread: v.length ? +(Math.max(...v) - Math.min(...v)).toFixed(2) : 0,
           lo: v.length ? Math.min(...v) : null, hi: v.length ? Math.max(...v) : null };
});
const gaps = cells.map(c => c.bottomGap).filter(v => v != null);
const gapSpread = gapByGroup.length ? Math.max(...gapByGroup.map(g => g.spread)) : 0;

/* 四條規矩。都是 CLAUDE.md 上寫過的，不是這支自己發明的：
   1 不准溢出（寧可字小，也不要壓到隔壁版位）
   2 同一個版位裡同樣價格數的格子，價格一樣大
   3 沒有人動過的品名都在同一個位置（左上那一疊）
   4 價格貼底：離下緣的距離每一格都一樣 */
const checks = [
  { name: '沒有東西溢出格子', ok: overflow.length === 0,
    got: `${overflow.length}/${cells.length} 格溢出，最多 ${overflow.length ? Math.max(...overflow.map(c => c.overflowMm)) : 0}mm` },
  { name: '同價格數＝同字級', ok: groups.every(g => g.distinct === 1),
    got: groups.map(g => `${g.nPrice}價:${g.distinct}級(差${g.spread}mm)`).join('  ') || '沒有價格' },
  { name: '品名落點同組一致', ok: nameOk,
    got: nameByGroup.map(g => `${g.n}價:${g.spots.length}種`).join('  ')
         + '　' + nameSpots.slice(0, 3).join(' / ') + '（mm）' },
  { name: '價格貼底同組一致', ok: gapSpread <= 0.3,
    got: gapByGroup.map(g => `${g.n}價:${g.lo}～${g.hi}mm(差${g.spread})`).join('  ') },
];

if (jsonOnly){
  console.log(JSON.stringify({ canvases: data.canvases, measured: cells.length, groups, checks }, null, 1));
} else {
  console.log('\n=== 壓力測試量測（' + cells.length + ' / ' + data.canvases + ' 格量到） ===');
  checks.forEach(c => console.log((c.ok ? ' ok   ' : ' FAIL ') + c.name.padEnd(18) + c.got));
  console.log('');
}

const failed = checks.filter(c => !c.ok).length;
// driver 自己的 exit code 也要算進來：console 有錯就不算過
process.exit(failed || code ? 1 : 0);
