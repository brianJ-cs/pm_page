#!/usr/bin/env node
/* 常走的那幾條路，一行帶過：node scenario.mjs <名字> [driver 的其他參數...]
 *
 * driver.mjs 是「一步一個參數」的，很好用但是很長 —— 光是「開到拼板、塞好假資料、
 * 放大、打開某一格、點中某一個零件」就是十幾個參數，每驗一次就要重打一次。
 * 這一支把那些固定的前置動作收成名字，後面再接自己要驗的東西。
 *
 *   node scenario.mjs smoke                     四個畫面走一輪，看有沒有炸
 *   node scenario.mjs board --shot out/b.png    開到拼板、塞滿假檔期
 *   node scenario.mjs cell --shot out/c.png     ↑ 再放大、打開一格（面板開著）
 *   node scenario.mjs blk --assert "..."        ↑ 再點中格子裡的第一個價格
 *
 * 後面接的參數原封不動交給 driver.mjs，所以 --eval / --shot / --click 都能用。
 * 額外多認一個 --assert <js>：跟 --eval 一樣，但在畫布 iframe 裡面跑
 * （畫布的變數是 let/const，外面 evaluate 讀不到，只能透過 contentDocument 問 DOM）。
 *
 * 換檔案：--file "dm-editor-single.html?seed=1"（預設是 design_and_PM.html?seed=1）
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(here, 'driver.mjs');

/* ---- 幾段在頁面裡跑的小程式 ---------------------------------------------
   都包成 IIFE：driver 的 --eval 是同一個 global scope，`const d = ...` 連兩次
   就會 "Identifier 'd' has already been declared"。 */

/* 拼板的縮放沒有按鈕，只有滾輪。合成一個 wheel 事件送給 #boardOverview，
   放大到看得見格子裡的東西為止（rAF 會合併重畫，但比例是每一發都算的）。 */
const ZOOM_IN = `(()=>{
  const ov=document.getElementById('boardOverview');
  const c=ov.querySelector('.cell'); if(!c) return 'no cell';
  for(let i=0;i<9;i++){
    const r=c.getBoundingClientRect();
    ov.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true,cancelable:true,
      clientX:r.left+r.width/2, clientY:r.top+r.height/2}));
  }
  return 'zoomed';
})()`;

/* 挑一格「畫面上看得到、而且已經有畫布」的，掛上 id 讓 --click 指得到。
   第一格通常被放大推到畫面外，不能寫死。 */
const PICK_CELL = `(()=>{
  const t=[...document.querySelectorAll('#boardOverview .cell')].find(c=>{
    const r=c.getBoundingClientRect();
    return r.top>150 && r.bottom<850 && r.left>460 && r.right<1180 && c.querySelector('.ccanvas');
  });
  if(!t) return 'no visible cell';
  t.id='TESTCELL';
  return 'TESTCELL ready';
})()`;

/* 點中畫布裡的一個零件。不能用 driver 的 --click：那是照選擇器在每個 frame 裡找，
   會先找到別格畫布裡的同名元素（那些格子 pointer-events 是關的，點下去只會換格）。
   這裡從外面算好座標，直接把 mousedown/mouseup 派進那一格的 document。 */
const clickBlk = sel => `(()=>{
  const f=document.querySelector('#TESTCELL .ccanvas'); if(!f) return 'no canvas';
  const d=f.contentDocument, el=d.querySelector(${JSON.stringify(sel)});
  if(!el) return 'no ' + ${JSON.stringify(sel)};
  const r=el.getBoundingClientRect();
  const o={bubbles:true,cancelable:true,button:0,buttons:1,
           clientX:r.left+r.width/2, clientY:r.top+r.height/2};
  el.dispatchEvent(new MouseEvent('mousedown',o));
  d.defaultView.dispatchEvent(new MouseEvent('mouseup',Object.assign({},o,{buttons:0})));
  return 'clicked ' + ${JSON.stringify(sel)};
})()`;

/* --assert：在畫布裡面問。畫布的 BLOCKS/selected 是 let，外面讀不到，
   所以問的一律是 DOM（.blk 幾個、#props 上面寫什麼）。 */
const inCanvas = js => `(()=>{
  const f=document.querySelector('#TESTCELL .ccanvas'); if(!f) return 'no canvas';
  const d=f.contentDocument;
  return (${js});
})()`;

/* ---- 場景 ---------------------------------------------------------------- */
const OPEN_PLAN = ['--wait','700', '--click','.plan-card .btn.open', '--wait','900'];
const TO_BOARD  = ['--click-text','拼板', '--wait','1200'];

/* 壓力測試那顆按鈕會塞滿假檔期（每一格都有商品）。便利貼要關掉 ——
   開著的話點格子會先打開便利貼，點不到底下的畫布。 */
const FILL = ['--click-text','壓力測試：塞滿假檔期', '--wait','2500',
              '--click-text','顯示便利貼', '--wait','800'];

const SCENES = {
  smoke: [...OPEN_PLAN, '--click-text','落版', '--wait','1000',
                        '--click-text','拼板', '--wait','1300',
                        '--click-text','總體', '--wait','800'],
  board: [...OPEN_PLAN, ...TO_BOARD, ...FILL],
  cell:  [...OPEN_PLAN, ...TO_BOARD, ...FILL,
          '--eval', ZOOM_IN, '--wait','1500',
          '--eval', PICK_CELL, '--click','#TESTCELL', '--wait','1500'],
};
SCENES.blk = [...SCENES.cell, '--eval', clickBlk('.blk.price'), '--wait','900'];

/* ---- 組參數 -------------------------------------------------------------- */
const argv = process.argv.slice(2);
const name = argv[0];
if (!name || !SCENES[name]) {
  console.error('用法：node scenario.mjs <' + Object.keys(SCENES).join('|') + '> [driver 參數...]');
  process.exit(2);
}

const rest = argv.slice(1);
let file = 'design_and_PM.html?seed=1';
const tail = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--file') { file = rest[++i]; continue; }
  if (rest[i] === '--assert') { tail.push('--eval', inCanvas(rest[++i])); continue; }
  tail.push(rest[i]);
}

const args = [DRIVER, '--file', file, ...SCENES[name], ...tail];
spawn(process.execPath, args, { stdio: 'inherit' })
  .on('exit', code => process.exit(code ?? 1));
