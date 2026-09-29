#!/usr/bin/env node
/* 審核流程從頭走到尾（主程式，design_and_PM.html）。
 *
 *   node .claude/skills/run-pm-page/review-flow.mjs
 *
 * 一個瀏覽器、一路換人（?user=…，localStorage 同一份），照真的會按的那幾下走：
 *   範例檔期 → 把沒有負責人的兩個品類換成表上的 → 快轉到製作
 *   → 設計用刷子標「標好了」、取消一格、送出標好的、再單獨送一格
 *   → 別的 PM 動不了 → 冷氣PM 貼一則修改、刷「審核完成」、一校完成
 *   → 設計處理便利貼、刷「改好了」、刊頭確認、一改完成 → 二校 → 二改
 *   → 冷氣PM 自己退一格（送出調整）、其他蓋章 → 設計修改 → 冷氣PM 蓋章 N
 *   → 快轉其他版位到蓋章完 → 三位課長 → 部長退件一格 → 設計改 → PM 蓋章 N → 部長重審 → 處長
 *   → 行銷送最終審核 → 商品處協理 → 行銷處協理退件一格 → 設計改 → PM 蓋章 N → 行銷處協理重審
 *   → 律師 → 設計出稿
 * 每一步後面接一個檢查（在頁面裡量 DOM），最後印一張表；有錯 exit 1。
 * 整趟大約 6～8 分鐘（每按一下要等審核那一邊的假延遲和同步）。
 *
 * ⚠️ 用的是 driver.mjs（全新的 Chrome profile），不碰這台電腦的資料，也不連 Supabase
 *    （driver 開的是 file://，config.js 那一份照樣會載，但範例檔期只活在那個臨時 profile 裡）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const args = [];
const labels = [];
const step = (...a) => args.push(...a);
const wait = ms => step('--wait', String(ms));
const click = sel => { step('--click', sel); wait(400); };
const tabTo = k => step('--eval', `document.querySelector('#sideTabs .sc-tab[data-stab=${k}]').click(),1`);
const text = t => { tabTo('review'); step('--click-text', t); wait(2600); };      // 按下去 → 審核那一邊 → 讀回來重畫
const Q = {
  acts: `[...document.querySelectorAll('#rvPanel .rv-act')].map(b=>b.textContent+(b.disabled?'(off)':''))`,
  whys: `[...document.querySelectorAll('#rvPanel .rv-why')].map(w=>w.textContent).join(' | ')`,
  tags: `[...document.querySelectorAll('#board .cell[data-rv]')].map(c=>c.dataset.rv)`,
  stage: `(document.querySelector('#rvPanel .rv-stage')||{}).textContent||''`,
  toast: `[...document.querySelectorAll('.toast,#toast')].map(t=>t.textContent).join(' | ')`,
  todo: `(document.getElementById('todoList')||{}).textContent||''`,
  banner: `(document.getElementById('bannerProg')||{}).textContent||''`,
};
/** 在頁面裡算 got，再用 ok（拿得到 g）判斷。回傳一個字串，外面解開。 */
function check(label, got, ok){
  labels.push(label);
  const t = JSON.stringify(label);
  step('--eval', `(()=>{let g;try{g=(${got});return JSON.stringify({t:${t},ok:!!(${ok}),got:g})}`
               + `catch(e){return JSON.stringify({t:${t},ok:false,got:'THROW '+e.message})}})()`);
}
/* 換人之前等一下：存檔有 300ms 的延遲，還沒存完就換頁會跳「離開頁面？」（driver 會自動按確定，但那一筆就沒存到） */
const as = (user, first) => { wait(900); step('--file', `design_and_PM.html?user=${user}${first ? '&seed=1' : ''}`); wait(2600); };
const openBoard = () => { click('.plan-card .btn.open'); wait(3200); step('--click-text', '商品'); wait(3200); };
const fromTodo = () => { click('#todoList .td-row'); wait(3500); };
const STAMP = '.tool[data-tool=pass]';
const brushAll = () => { click(STAMP); step('--drag', '#board .cell[data-cell-id]', '1000', '420'); wait(3000); click(STAMP); };
const ff = stop => { click('#devBtn'); click('.dev-tab[data-dev=stage]'); step('--click', `[data-ffstop='${stop}']`); wait(4200); step('--key', 'Escape'); wait(300); };
const selectFirst = () => { click('#board .cell[data-cell-id]'); wait(600); };
const dropNote = () => { tabTo('notes'); click('.stick[data-key=fix]'); click('#board .cell[data-cell-id]'); wait(3200); };
const resolveOpenNote = () => { tabTo('notes'); click('#railList .icard:not(.done)'); wait(300); step('--click-text', '標成已處理'); wait(2200); };
const count = (what) => `g.filter(x=>x.includes(${JSON.stringify(what)})).length`;

/* ---------- 0. 範例檔期：沒有負責人的兩個品類換成表上的 ---------- */
as('d1', true);
click('.plan-card .btn.open'); wait(3200);
click('[data-ttool=items]');
const REN = n => `(()=>{const i=document.querySelector('#itemPop .ip-row .ip-name');i.value=${JSON.stringify(n)};i.dispatchEvent(new Event('blur'));return i.value})()`;
click('#view-total .window-node[data-block-id=b4]'); step('--eval', REN('空調')); wait(800);
click('#view-total .window-node[data-block-id=b5]'); step('--eval', REN('小家電')); wait(800);
step('--key', 'Escape'); click('[data-ttool=pick]'); wait(1500);
check('總體：每個品類都有負責人（沒有琥珀虛線）', `document.querySelectorAll('#view-total .nocat').length`, 'g===0');
ff('製作');
step('--click-text', '商品'); wait(3200);
check('快轉到製作：刮鬍刀 14 格都在製作', Q.tags, `${count('製作・等設計製作')}===14`);
check('設計的刷子是「製作：標好了」', `document.querySelector('.tool[data-tool=pass]').title`, `g.includes('製作：標好了')`);
check('還沒標：送出鈕按不下去', Q.acts, `g.some(x=>x.startsWith('送出製作完成：標好的 0 格(off)'))`);

/* ---------- 1. 設計：製作（標好了、取消、送出標好的、單獨送一格） ---------- */
click(STAMP); step('--drag', '#board .cell[data-cell-id]', '1000', '420'); wait(3000);
check('刷子拉一片：14 格標好了（尚未送出）', Q.tags, `${count('尚未送出')}===14`);
click('#board .cell[data-cell-id]'); wait(2600);
check('再點一格＝取消那一格', Q.tags, `${count('尚未送出')}===13 && g[0].includes('等設計製作')`);
click(STAMP);
text('送出製作完成：標好的 13 格');
check('送出標好的 13 格：它們到一校，沒標的那格留著', Q.tags, `${count('一校')}===13 && g[0].includes('製作')`);
selectFirst();
text('送出這一格（製作完成）');
check('單獨送出那一格：14 格都到一校', Q.tags, `${count('一校')}===14`);
step('--key', 'Escape'); wait(300);
click('#board .cell[data-cell-id]'); wait(400);
check('一校的格子設計點不開（上鎖）', Q.toast, `g.includes('設計現在不動它')`);

/* ---------- 2. 別的 PM 動不了 ---------- */
as('pm1'); openBoard();
check('冰箱洗衣機PM 看刮鬍刀：淡掉', `document.querySelector('#board .cell[data-cell-id]').classList.contains('rv-notmine')`, 'g===true');
click('#board .cell[data-cell-id]'); wait(400);
check('冰箱洗衣機PM 點刮鬍刀：講是誰負責的', Q.toast, `g.includes('冷氣PM負責')`);

/* ---------- 3. 冷氣PM：一校 ---------- */
as('pm2'); openBoard();
check('冷氣PM 的刷子是「一校：審核完成」', `document.querySelector('.tool[data-tool=pass]').title`, `g.includes('一校：審核完成')`);
dropNote();
brushAll();
check('刷完：14 格已審', Q.tags, `${count('已審')}===14`);
text('一校完成');
check('一校完成 → 刮鬍刀進一改', Q.stage, `g.startsWith('一改')`);

/* ---------- 4. 設計：一改 ---------- */
as('d1'); openBoard();
check('一改完成先擋著：便利貼、刊頭、每一格都要標', Q.whys, `g.includes('1 張便利貼還沒處理') && g.includes('刊頭還沒確認') && g.includes('14 格還沒標「改好了」')`);
resolveOpenNote();
check('設計的刷子是「一改：改好了」', `document.querySelector('.tool[data-tool=pass]').title`, `g.includes('一改：改好了')`);
brushAll();
text('刊頭確認完成');
check('都好了：一改完成按得下去', Q.acts, `g.includes('一改完成')`);
text('一改完成');
check('一改完成 → 二校', Q.stage, `g.startsWith('二校')`);

/* ---------- 5. 冷氣PM：二校（開關預設關：PM 按完就進二改） ---------- */
as('pm2'); openBoard();
brushAll();
text('二校完成');
check('二校完成 → 二改（主管不審）', Q.stage, `g.startsWith('二改')`);

/* ---------- 6. 設計：二改 ---------- */
as('d1'); openBoard();
brushAll();
text('刊頭與整體版面確認完成');
text('二改完成');
check('二改完成 → 蓋章確認', Q.stage, `g.startsWith('蓋章確認')`);

/* ---------- 7. 冷氣PM：自己退一格、其他蓋章 ---------- */
as('pm2'); openBoard();
dropNote();
selectFirst();
check('貼了調整的那一格：有「送出調整」', Q.acts, `g.some(x=>x.startsWith('送出調整'))`);
text('送出調整（這一格退回設計）');
check('那一格進退件循環', Q.tags, `g[0].includes('退件')`);
/* 印章只是標起來（2026-09-29：全部蓋完不自己送出），「蓋章送出」才真的蓋下去 */
brushAll();
check('印章蓋完：13 格「尚未送出」，還沒真的蓋章', Q.tags, `${count('尚未送出')}===13 && ${count('已蓋章')}===0`);
text('蓋章送出：標好的 13 格');
check('按了蓋章送出：其他 13 格蓋好章', Q.tags, `${count('已蓋章')}===13`);

/* ---------- 8. 設計：退件修改 ---------- */
as('d1'); openBoard();
selectFirst();
text('設計問題：我自己改');
check('設計判斷完：修改完成要先處理退件便利貼', Q.whys, `g.includes('退件便利貼')`);
step('--key', 'Escape'); wait(300);
resolveOpenNote();
selectFirst();
text('修改完成');
check('修改完成 → 等 PM 蓋章', Q.tags, `g[0].includes('等 PM 蓋章')`);

/* ---------- 9. 冷氣PM：蓋章 N（自己退的：就是一般蓋章） ---------- */
as('pm2'); openBoard();
selectFirst();
text('蓋章 2，送回退件的人');
check('蓋章 2 之後：14 格都蓋了', Q.tags, `${count('已蓋章')}===14`);

/* ---------- 10. 其他版位快轉到「蓋章完、等主管審」 ---------- */
as('d1'); click('.plan-card .btn.open'); wait(3200);
ff('蓋章輪主管');

/* ---------- 11. 三位課長 ---------- */
for (const [u, name] of [['pm-appl-mgr', '家電課長'], ['pm-3c-mgr', '3C課長'], ['pm-wash-mgr', '洗衣機課長']]){
  as(u);
  check(`${name}：檔期列表上「輪到你」`, Q.todo, `g.includes('課長審核')`);
  check(`${name}：🔔 有新通知`, `document.getElementById('rvBell').textContent`, `/\\d/.test(g)`);
  fromTodo();
  text('蓋章後課長審核'); wait(6000);   // 家電課長一次送 236 格，2.6 秒還沒跑完（鈕還是「…」）
  check(`${name}：審完那一顆就不見了`, Q.acts, `!g.some(x=>x.startsWith('蓋章後課長審核'))`);
}

/* ---------- 12. 部長退件一格 → 設計改 → PM 蓋章 N → 部長重審 ---------- */
as('pm-director'); fromTodo();
dropNote();
check('部長貼了便利貼：那一格算退件', Q.acts, `g.some(x=>x.includes('蓋章後部長審核') && x.includes('1 格退件'))`);
text('蓋章後部長審核');
check('部長退的那一格進退件循環', Q.tags, `g[0].includes('退件')`);
as('d1'); openBoard();
selectFirst(); text('設計問題：我自己改');
step('--key', 'Escape'); wait(300);
resolveOpenNote();
selectFirst(); text('修改完成');
as('pm2'); openBoard();
selectFirst(); text('送回退件的人');     // 這一格第二次退件，鈕上是「蓋章 3，…」—— 不寫死版號
check('PM 蓋章之後送回部長重審', Q.tags, `g[0].includes('部長') && g[0].includes('重審')`);
as('pm-director'); openBoard();
selectFirst(); text('重審通過');
check('部長重審通過：那一格不在退件裡了', Q.tags, `!g[0].includes('退件')`);

/* ---------- 13. 處長 ---------- */
as('pm-div-head'); fromTodo();
text('蓋章後處長審核');
check('處長審完：商品部確認完成（輪到行銷送最終審核）', Q.acts, `!g.some(x=>x.startsWith('蓋章後處長審核'))`);

/* ---------- 14. 最終審核 ---------- */
as('m1');
check('行銷：輪到你送最終審核', Q.todo, `g.includes('最終審核') || g.includes('審稿')`);
fromTodo();
text('送最終審核');
as('pm-exec'); fromTodo();
text('審稿通過（商品處協理');
as('m3'); fromTodo();
check('行銷處協理看得到便利貼那一疊', `[...document.querySelectorAll('.stick')].filter(s=>s.style.display!=='none').length`, 'g>=1');
dropNote();
check('行銷處協理貼了一則：送出的是退件', Q.acts, `g.some(x=>x.includes('1 格退件'))`);
text('審稿（行銷處協理）');
as('d1'); openBoard();
selectFirst(); text('設計問題：我自己改');
step('--key', 'Escape'); wait(300);
resolveOpenNote();
selectFirst(); text('修改完成');
as('pm2'); openBoard();
selectFirst(); text('送回退件的人');     // 「蓋章 N，送回退件的人」（只寫「蓋章」會按到別的東西）
as('m3'); openBoard();
selectFirst(); text('重審通過');
as('m-lawyer');
check('行銷處協理重審完：輪到律師', Q.todo, `g.includes('審稿')`);
fromTodo();
text('審稿通過（律師');

/* ---------- 15. 出稿 ---------- */
as('d1');
check('設計：輪到你出稿', Q.todo, `g.includes('出稿')`);
fromTodo();
text('出稿完成');
check('出稿完成：橫幅寫已出稿', Q.banner, `g.includes('已出稿')`);
click('#devBtn'); click('.dev-tab[data-dev=log]'); wait(300);
check('紀錄裡有退件、自動略過、出稿', `document.getElementById('devLogList').textContent`,
      `g.includes('主管審核退件') && g.includes('最終審核退件') && g.includes('設計出稿')`);

/* ---------- 跑 ---------- */
console.log(`審核流程：${labels.length} 項檢查，整趟約 6～8 分鐘…`);
const out = [];
const results = [];
let buf = '';
/* 一邊跑一邊印：跑完一條檢查就講一條，卡住的時候看得出卡在哪 */
const onLine = line => {
  if (line.startsWith('dialog ') || line.startsWith('STEP FAILED')) console.log('  ' + line);
  if (!line.startsWith('eval   ')) return;
  let v; try { v = JSON.parse(line.slice(7)); } catch { return; }
  if (typeof v !== 'string') return;
  try { v = JSON.parse(v); } catch { return; }
  if (!v || !v.t) return;
  results.push(v);
  console.log(`[${results.length}/${labels.length}] ${v.ok ? '✓' : '✗'} ${v.t}${v.ok ? '' : `\n    得到 ${JSON.stringify(v.got).slice(0, 300)}`}`);
};
const feed = d => { out.push(String(d)); buf += String(d); const ls = buf.split(/\r?\n/); buf = ls.pop(); ls.forEach(onLine); };
const child = spawn(process.execPath, [join(here, 'driver.mjs'), ...args], { cwd: root });
child.stdout.on('data', feed);
child.stderr.on('data', feed);
child.on('close', code => {
  if (buf) onLine(buf);
  const text = out.join('');
  let fail = 0;
  console.log('\n—— 總表 ——');
  for (const label of labels){
    const r = results.find(x => x.t === label);
    const ok = !!(r && r.ok);
    if (!ok){ fail++; console.log(`✗ ${label}${r ? '' : '（沒跑到：前面的步驟卡住了）'}`); }
  }
  const problems = text.includes('--- page problems') ? text.slice(text.indexOf('--- page problems')) : '';
  if (problems){ console.log('\n' + problems.trim()); fail++; }
  const stepFail = text.split(/\r?\n/).filter(l => l.startsWith('STEP FAILED'));
  console.log(`\n${labels.length - (fail - (problems ? 1 : 0))} 過、${fail - (problems ? 1 : 0)} 錯${problems ? '、頁面有錯誤' : ''}`);
  if (stepFail.length) console.log(stepFail.join('\n'));
  try {
    const todo = readFileSync(join(root, 'review-test-later.md'), 'utf8').split(/\r?\n/).filter(l => /^- \[ \]/.test(l));
    if (todo.length) console.log(`（改版面時審核怎麼跟著走：還有 ${todo.length} 項沒測，見 review-test-later.md）`);
  } catch {}
  process.exit(fail || code ? 1 : 0);
});
