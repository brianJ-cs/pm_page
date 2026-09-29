// 規則的小測試：node demo/review/rules.test.mjs（規則本人在根目錄的 review-rules.js，主程式和這個雛形共用）
// 不開瀏覽器，直接拿假資料跑一遍前段四關，每一步都問「誰能按、按了之後變什麼」。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Seed = require('./seed.js');
const R = require('../../review-rules.js');

let fail = 0, pass = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  if (!ok) console.log(`✗ ${name}\n    得到 ${JSON.stringify(got)}\n    應該 ${JSON.stringify(want)}`);
};

const NOW = +new Date('2026-09-27T10:00:00');
const db = Object.assign({ audit: [] }, Seed.build(NOW));
const act = (who, action, p) => R.act(db, who, action, p, NOW);
const cell = id => db.cells.find(c => c.id === id);
// 設計在一改／二改把每一格標「改好了」（2026-09-28：跟 PM 的一校同一種送法，送出前要每一格都標）
const markFix = (d, blockId) => d.cells.filter(c => c.block_id === blockId).forEach(c => R.act(d, 'E20011', 'fix.mark', { cell_id: c.id, done: true }, NOW));

// 登入
eq('在職的進得來', R.authorize('Fridge.PM@example.com', db).ok, true);
eq('離職的進不來', R.authorize('former.pm@example.com', db).code, 'inactive');
eq('沒登記的進不來', R.authorize('x@gmail.com', db).code, 'not_registered');
const lee = R.identity(db.members.find(m => m.employee_id === 'E10118'), db, NOW);
eq('家電課長代理冷氣PM的冷氣', lee.acting.map(a => a.categories.map(c => c.name)), [['冷氣']]);
const huang = R.identity(db.members.find(m => m.employee_id === 'E10131'), db, NOW);
eq('3C課長兼筆電PM在筆電身兼 PM＋課長，算課長', huang.categories.find(c => c.name === '筆電').top, 3);

// 提明細（c1 冰箱 冰箱洗衣機PM、c8 冷氣 冷氣PM→家電課長代理）
eq('別人的格子不能填', act('E10252', 'detail.save', { cell_id: 'c1', patch: { sku: 'R-HW620RV' } }).kind, 'forbidden');
eq('被拒要記一筆', db.audit[db.audit.length - 1].what, '未授權操作被拒');
eq('沒挑貨不能送', act('E10234', 'detail.submit', { cell_id: 'c1' }).missing, ['還沒挑商品']);
eq('只能挑自己分類的', act('E10234', 'detail.save', { cell_id: 'c1', patch: { sku: 'KM-65X80L' } }).ok, false);
eq('挑貨', act('E10234', 'detail.save', { cell_id: 'c1', patch: { sku: 'R-HW620RV' } }).ok, true);
eq('帶入後台資料', cell('c1').detail.price, 62900);
eq('贈品不受分類限制', act('E10234', 'gift.add', { cell_id: 'c1', sku: 'GF-BUDS' }).ok, true);
eq('贈品編號要存在', act('E10234', 'gift.add', { cell_id: 'c1', sku: 'NOPE' }).reason, '找不到商品編號 NOPE');
eq('價格清空就送不出去', (act('E10234', 'detail.save', { cell_id: 'c1', patch: { price: '' } }), act('E10234', 'detail.submit', { cell_id: 'c1' }).missing), ['價格空白']);
act('E10234', 'detail.save', { cell_id: 'c1', patch: { price: 59900 } });
eq('提明細完成', act('E10234', 'detail.submit', { cell_id: 'c1' }).ok, true);
eq('送出後上鎖', act('E10234', 'detail.save', { cell_id: 'c1', patch: { name: 'x' } }).reason, '提明細已經送出，不能再改');
eq('代理人可以填冷氣PM的冷氣', act('E10118', 'detail.save', { cell_id: 'c8', patch: { sku: 'RXV50UVLT' } }).ok, true);
act('E10118', 'detail.submit', { cell_id: 'c8' });
eq('代理送出記成原 PM', cell('c8').submitted, { by: 'E10118', as: 'E10245', acting: true, at: new Date(NOW).toISOString() });
eq('課長自己不能填冰箱洗衣機PM的冰箱', act('E10118', 'detail.save', { cell_id: 'c2', patch: { sku: 'NR-F607HX' } }).kind, 'forbidden');

// 製作
eq('PM 不能按製作完成', act('E10234', 'make.submit', { cell_id: 'c1' }).kind, 'forbidden');
eq('還沒提明細的格子不能製作', act('E20011', 'make.submit', { cell_id: 'c2' }).ok, false);
eq('PM 不能標製作好了', act('E10234', 'make.mark', { cell_id: 'c1', done: true }).kind, 'forbidden');
eq('設計標好了（還沒送）', (act('E20011', 'make.mark', { cell_id: 'c1', done: true }), [cell('c1').stage, R.cellStatus(db, cell('c1')).text]), ['製作', '尚未送出']);
eq('標好了還能取消', (act('E20011', 'make.mark', { cell_id: 'c1', done: false }), R.cellStatus(db, cell('c1')).text), '等設計製作');
eq('製作完成', act('E20011', 'make.submit', { cell_id: 'c1' }).ok, true);
eq('送出之後不能再標', act('E20011', 'make.mark', { cell_id: 'c1', done: false }).reason, '製作已經送出');
eq('記一份草稿版', db.traces['R-HW620RV'].draft.v, 1);
eq('圖片比對：完全相同才算', R.matchImages('R-HW620RV', db.imageFiles), ['R-HW620RV.png']);
eq('圖片比對：一個檔名好幾個編號', R.matchImages('RAC-50QP', db.imageFiles), ['RXV50UVLT RAC-50QP.png']);
eq('圖片比對：大小寫不同不算', R.matchImages('r-hw620rv', db.imageFiles), []);

// 一校：版位一的格子全部推到一校
for (const c of db.cells.filter(x => x.block_id === 'b1' && x.stage === '提明細')) {
  const owner = R.ownerOf(db, c);
  const who = owner === 'E10245' ? 'E10118' : owner;
  const sku = db.products.find(p => p.category_id === c.category_id).sku;
  act(who, 'detail.save', { cell_id: c.id, patch: { sku } });
  act(who, 'detail.submit', { cell_id: c.id });
}
for (const c of db.cells.filter(x => x.block_id === 'b1' && x.stage === '製作')) act('E20015', 'make.submit', { cell_id: c.id });
eq('還沒審完不能一校完成', act('E10234', 'block.review1', { block_id: 'b1', as_pm: 'E10234' }).missing.length, 7);
eq('一校要先貼便利貼才寫得出內容', act('E10234', 'note.add', { cell_id: 'c2', kind: '修改', text: '  ' }).reason, '請寫要改什麼');
act('E10234', 'note.add', { cell_id: 'c2', kind: '修改', text: '價格改活動價' });
for (const c of db.cells.filter(x => x.block_id === 'b1' && R.ownerOf(db, x) === 'E10234')) act('E10234', 'review.mark', { cell_id: c.id, done: true });
eq('冰箱洗衣機PM一校完成', act('E10234', 'block.review1', { block_id: 'b1', as_pm: 'E10234' }).ok, true);
eq('另一位 PM 還沒按，版位不動', db.blocks.find(b => b.id === 'b1').phase, null);
eq('按了之後不能撤回', act('E10234', 'review.mark', { cell_id: 'c1', done: false }).reason, '一校已經送出，不能再改');
eq('不能替別人按一校完成', act('E10234', 'block.review1', { block_id: 'b1', as_pm: 'E10245' }).kind, 'forbidden');
for (const c of db.cells.filter(x => x.block_id === 'b1' && R.ownerOf(db, x) === 'E10245')) act('E10118', 'review.mark', { cell_id: c.id, done: true });
eq('代理人替冷氣PM按一校完成', act('E10118', 'block.review1', { block_id: 'b1', as_pm: 'E10245' }).ok, true);
eq('每位 PM 都按了，版位進一改', db.blocks.find(b => b.id === 'b1').phase, '一改');
eq('有便利貼的進一改', cell('c2').fix, true);
eq('沒有的一校 OK（還要設計標改好了）', R.cellStatus(db, cell('c1')).text, '一校 OK，等設計確認');

// 一改
eq('PM 不能按一改完成', act('E10234', 'block.fix1', { block_id: 'b1' }).kind, 'forbidden');
eq('便利貼沒處理、刊頭沒確認、格子沒標不能送', act('E20011', 'block.fix1', { block_id: 'b1' }).missing, ['1 張便利貼還沒處理', '刊頭還沒確認', '10 格還沒標「改好了」']);
eq('PM 不能標改好了', act('E10234', 'fix.mark', { cell_id: 'c1', done: true }).kind, 'forbidden');
eq('設計標改好了', (act('E20011', 'fix.mark', { cell_id: 'c1', done: true }), R.cellStatus(db, cell('c1')).text), '改好了');
eq('標了還能取消', (act('E20011', 'fix.mark', { cell_id: 'c1', done: false }), R.cellStatus(db, cell('c1')).text), '一校 OK，等設計確認');
eq('PM 可以回覆', act('E10234', 'note.reply', { note_id: db.notes[0].id, text: '活動價 49900' }).ok, true);
eq('設計標成已處理', act('E20011', 'note.resolve', { note_id: db.notes[0].id, done: true }).ok, true);
act('E20011', 'block.masthead', { block_id: 'b1', ok: true });
markFix(db, 'b1');
const vBefore = db.traces[cell('c2').detail.sku].draft.v;
eq('一改完成', act('E20011', 'block.fix1', { block_id: 'b1' }).ok, true);
eq('版位進二校', db.blocks.find(b => b.id === 'b1').phase, '二校');
eq('改過的格子草稿版加一', db.traces[cell('c2').detail.sku].draft.v, vBefore + 1);

// 待辦
eq('設計的待辦：沒有一改了', R.todo(db, 'E20011', NOW).filter(i => i.stage === '一改').length, 0);
eq('冰箱洗衣機PM的待辦：版位一進了二校，版位二沒有他的格子', R.todo(db, 'E10234', NOW).map(i => i.title), ['家電 二校']);
eq('電視PM的待辦：電視提明細', R.todo(db, 'E10252', NOW).map(i => i.title), ['電視 提明細']);
eq('進度：最落後的是版位二的提明細', R.planProgress(db, 'p1').stage, '提明細');

// ============ 二校（預設：主管不審）：PM 都按了二校完成就進二改，部長只看 ============
{
  const dbA = Object.assign({ audit: [] }, Seed.build(NOW));
  const A = (who, action, p) => R.act(dbA, who, action, p, NOW);
  const who = c => { const o = R.ownerOf(dbA, c); return o === 'E10245' ? 'E10118' : o; };
  eq('開關預設是關的', R.r2Managers(dbA), false);
  for (const c of dbA.cells) {
    A(who(c), 'detail.save', { cell_id: c.id, patch: { sku: dbA.products.find(p => p.category_id === c.category_id).sku } });
    A(who(c), 'detail.submit', { cell_id: c.id });
    A('E20011', 'make.submit', { cell_id: c.id });
    A(who(c), 'review.mark', { cell_id: c.id, done: true });
  }
  const b1 = dbA.blocks.find(b => b.id === 'b1');
  for (const pid of R.blockPms(dbA, 'b1')) A(pid === 'E10245' ? 'E10118' : pid, 'block.review1', { block_id: 'b1', as_pm: pid });
  A('E20011', 'block.masthead', { block_id: 'b1', ok: true });
  markFix(dbA, 'b1');
  A('E20011', 'block.fix1', { block_id: 'b1' });
  eq('第二版送出也通知部長', dbA.notifications.some(n => n.to === 'E10056' && n.text.includes('第二版已送出')), true);
  const b1c = dbA.cells.filter(c => c.block_id === 'b1');
  for (const c of b1c) A(who(c), 'r2.mark', { cell_id: c.id, done: true });
  A('E10234', 'note.add', { cell_id: 'c2', kind: '修改', text: '字級放大' });
  eq('部長不能在二校退件', A('E10056', 'note.add', { cell_id: 'c1', kind: '修改', text: 'x' }).ok, false);
  A('E10234', 'block.r2pm', { block_id: 'b1', as_pm: 'E10234' });
  eq('還有一位 PM 沒按：版位還在二校', b1.phase, '二校');
  eq('部長按不動', A('E10056', 'mgr.submit', { block_id: 'b1', level: 2 }).reason, '二校不需要主管審核（設定表上「二校主管審核」是關的），部長只看進度');
  A('E10118', 'block.r2pm', { block_id: 'b1', as_pm: 'E10245' });
  eq('每位 PM 都按了 → 二改', b1.phase, '二改');
  eq('PM 二校的便利貼帶進二改', dbA.cells.find(c => c.id === 'c2').fix2, true);
  eq('沒有任何格子在等主管', b1c.every(c => R.mgrPendingLevel(dbA, c) === null), true);
  // 開關半路關掉：已經在等主管的版位直接放行
  const dbB = Object.assign({ audit: [] }, Seed.build(NOW));
  dbB.reviewerSettings.r2_managers = true;
  const B = (who, action, p) => R.act(dbB, who, action, p, NOW);
  const whoB = c => { const o = R.ownerOf(dbB, c); return o === 'E10245' ? 'E10118' : o; };
  for (const c of dbB.cells.filter(x => x.block_id === 'b1')) {
    B(whoB(c), 'detail.save', { cell_id: c.id, patch: { sku: dbB.products.find(p => p.category_id === c.category_id).sku } });
    B(whoB(c), 'detail.submit', { cell_id: c.id });
    B('E20011', 'make.submit', { cell_id: c.id });
    B(whoB(c), 'review.mark', { cell_id: c.id, done: true });
  }
  for (const pid of R.blockPms(dbB, 'b1')) B(pid === 'E10245' ? 'E10118' : pid, 'block.review1', { block_id: 'b1', as_pm: pid });
  B('E20011', 'block.masthead', { block_id: 'b1', ok: true });
  markFix(dbB, 'b1');
  B('E20011', 'block.fix1', { block_id: 'b1' });
  for (const c of dbB.cells.filter(x => x.block_id === 'b1')) B(whoB(c), 'r2.mark', { cell_id: c.id, done: true });
  for (const pid of R.blockPms(dbB, 'b1')) B(pid === 'E10245' ? 'E10118' : pid, 'block.r2pm', { block_id: 'b1', as_pm: pid });
  eq('開關開著：PM 都按了 → 等課長', dbB.blocks[0].phase, '二校');
  eq('只有行銷能切開關', B('E10234', 'settings.save', { patch: { r2_managers: false } }).kind, 'forbidden');
  B('E30007', 'settings.save', { patch: { r2_managers: false } });
  eq('關掉的那一刻，等主管的版位直接進二改', dbB.blocks[0].phase, '二改');
  eq('切開關有紀錄', dbB.audit.some(a => a.what === '修改最終審核者設定表' && a.detail.includes('二校主管審核關')), true);
}

// ============ 二校（設定表開了「二校主管審核」）：略過、退件循環、二改 ============
{
  const db2 = Object.assign({ audit: [] }, Seed.build(NOW));
  db2.reviewerSettings.r2_managers = true;
  const A = (who, action, p) => R.act(db2, who, action, p, NOW);
  const C = id => db2.cells.find(c => c.id === id);
  const B = id => db2.blocks.find(b => b.id === id);
  const who = c => { const o = R.ownerOf(db2, c); return o === 'E10245' ? 'E10118' : o; };   // 冷氣PM請假，由家電課長代理
  for (const c of db2.cells) {
    A(who(c), 'detail.save', { cell_id: c.id, patch: { sku: db2.products.find(p => p.category_id === c.category_id).sku } });
    A(who(c), 'detail.submit', { cell_id: c.id });
    A('E20011', 'make.submit', { cell_id: c.id });
    A(who(c), 'review.mark', { cell_id: c.id, done: true });
  }
  for (const b of db2.blocks) {
    for (const pid of R.blockPms(db2, b.id)) A(pid === 'E10245' ? 'E10118' : pid, 'block.review1', { block_id: b.id, as_pm: pid });
    A('E20011', 'block.masthead', { block_id: b.id, ok: true });
    markFix(db2, b.id);
    A('E20011', 'block.fix1', { block_id: b.id });
  }
  eq('兩個版位都進二校', db2.blocks.map(b => b.phase), ['二校', '二校']);

  // 版位一：PM 那一段
  const b1c = db2.cells.filter(c => c.block_id === 'b1');
  for (const c of b1c) A(who(c), 'r2.mark', { cell_id: c.id, done: true });
  eq('PM 在二校貼的便利貼', A('E10234', 'note.add', { cell_id: 'c2', kind: '修改', text: '字級放大' }).ok, true);
  eq('那一張是帶去二改的', db2.notes[db2.notes.length - 1].purpose, 'r2pm');
  eq('課長還不能審（PM 還沒都按）', A('E10118', 'note.add', { cell_id: 'c1', kind: '修改', text: 'x' }).reason, '還沒輪到你審這一格');
  A('E10234', 'block.r2pm', { block_id: 'b1', as_pm: 'E10234' });
  A('E10118', 'block.r2pm', { block_id: 'b1', as_pm: 'E10245' });
  eq('代理人按的算 PM', C('c8').r2.hi, 4);
  eq('每一格都等課長', b1c.map(c => R.mgrPendingLevel(db2, c)).every(L => L === 3), true);

  // 課長退件一格
  eq('退件要先貼便利貼', A('E10118', 'note.add', { cell_id: 'c3', kind: '修改', text: '價格錯了' }).ok, true);
  eq('那一張是退件', db2.notes[db2.notes.length - 1].purpose, 'reject');
  A('E10118', 'mgr.submit', { block_id: 'b1', level: 3 });
  eq('被退的那一格進退件循環', C('c3').r2.cycle.state, 'judge');
  eq('版本加一', C('c3').version, 2);
  eq('其他格過了課長', C('c1').r2.steps[3].how, 'pass');
  eq('部長要等齊（有一格還在課長的退件裡）', R.mgrPendingLevel(db2, C('c1')), null);
  eq('部長這時候沒有東西可審', A('E10056', 'mgr.submit', { block_id: 'b1', level: 2 }).reason, '現在沒有等你審的格子');

  // 退件循環：商品問題
  eq('PM 不能替設計判斷', A('E10234', 'cycle.judge', { cell_id: 'c3', kind: '商品問題' }).kind, 'forbidden');
  A('E20011', 'cycle.judge', { cell_id: 'c3', kind: '商品問題' });
  eq('商品問題：資料對 PM 重新打開', A('E10234', 'detail.save', { cell_id: 'c3', patch: { price: 19900 } }).ok, true);
  A('E10234', 'cycle.dataDone', { cell_id: 'c3' });
  eq('退件便利貼沒處理不能送', A('E20011', 'cycle.fixDone', { cell_id: 'c3' }).missing, ['1 張退件便利貼還沒標成已處理']);
  A('E20011', 'note.resolve', { note_id: R.openOn(db2, C('c3'), ['reject'])[0].id, done: true });
  eq('設計修改完成', A('E20011', 'cycle.fixDone', { cell_id: 'c3' }).ok, true);
  eq('PM 退回設計要附便利貼', A('E10234', 'cycle.back', { cell_id: 'c3' }).reason, '先貼一張便利貼，寫還要改什麼');
  A('E10234', 'cycle.confirm', { cell_id: 'c3' });
  eq('課長退的：送回課長重審', [C('c3').r2.cycle.state, C('c3').r2.cycle.by], ['rereview', 'E10118']);
  eq('只有退件的人能重審', A('E10056', 'cycle.pass', { cell_id: 'c3' }).kind, 'forbidden');
  A('E10118', 'cycle.pass', { cell_id: 'c3' });
  eq('重審通過，部長那一關開了', R.mgrPendingLevel(db2, C('c1')), 2);

  // 部長退件一格：改完只回部長，課長不重審（實作指南 6.2 的例子）
  A('E10056', 'note.add', { cell_id: 'c5', kind: '換品', text: '換成滾筒的' });
  A('E10056', 'mgr.submit', { block_id: 'b1', level: 2 });
  A('E20011', 'cycle.judge', { cell_id: 'c5', kind: '設計問題' });
  A('E20011', 'note.resolve', { note_id: R.openOn(db2, C('c5'), ['reject'])[0].id, done: true });
  A('E20011', 'cycle.fixDone', { cell_id: 'c5' });
  A('E10234', 'cycle.confirm', { cell_id: 'c5' });
  eq('部長退的：已審最高層級設為課長', C('c5').r2.hi, 3);
  eq('課長那一關還在（不重審）', C('c5').r2.steps[3].how, 'pass');
  eq('直接送回部長', C('c5').r2.cycle.by, 'E10056');
  eq('版位還在二校', B('b1').phase, '二校');
  A('E10056', 'cycle.pass', { cell_id: 'c5' });
  eq('部長重審通過，版位進二改', B('b1').phase, '二改');
  eq('PM 二校的便利貼帶進二改', C('c2').fix2, true);

  // 版位二：略過規則（實作指南 5.3 的例子）
  for (const c of db2.cells.filter(c => c.block_id === 'b2')) A(who(c), 'r2.mark', { cell_id: c.id, done: true });
  for (const pid of R.blockPms(db2, 'b2')) A(pid, 'block.r2pm', { block_id: 'b2', as_pm: pid });
  const b2 = cat => db2.cells.filter(c => c.block_id === 'b2' && c.category_id === cat);
  eq('筆電：3C課長兼筆電PM身兼課長 → 課長略過', b2('202').map(c => c.r2.steps[3] && c.r2.steps[3].how), ['skip', 'skip', 'skip']);
  eq('電視：只有 PM 審過 → 課長要審', b2('201').map(c => R.mgrPendingLevel(db2, c)), [3, 3, 3]);
  eq('機上盒：部長兼機上盒PM身兼三層 → 課長略過', b2('111').map(c => c.r2.steps[3].how), ['skip', 'skip']);
  eq('部長兼機上盒PM那一層課長整個略過有記', db2.audit.some(a => a.what === '主管整層略過' && a.detail.startsWith('部長兼機上盒PM（課長）')), true);
  A('E10131', 'mgr.submit', { block_id: 'b2', level: 3 });
  eq('機上盒：部長也略過', b2('111').map(c => c.r2.steps[2] && c.r2.steps[2].how), ['skip', 'skip']);
  eq('筆電：部長要審', b2('202').map(c => R.mgrPendingLevel(db2, c)), [2, 2, 2]);
  eq('略過都寫了紀錄', db2.audit.filter(a => a.what === '自動略過').length, 3 + 2 + 2);
  A('E10056', 'mgr.submit', { block_id: 'b2', level: 2 });
  eq('版位二全部通過，進二改', B('b2').phase, '二改');

  // 二改
  eq('便利貼沒處理、版面沒確認不能送', A('E20011', 'block.fix2', { block_id: 'b1' }).missing, ['1 張便利貼還沒處理', '刊頭與整體版面還沒確認', '10 格還沒標「改好了」']);
  eq('一改標的不算二改的', R.cellStatus(db2, C('c1')).text, '二校 OK，等設計確認');
  markFix(db2, 'b1');
  A('E20011', 'note.resolve', { note_id: R.openOn(db2, C('c2'), ['r2pm'])[0].id, done: true });
  A('E20011', 'block.mh2', { block_id: 'b1', ok: true });
  eq('二改完成 → 蓋章確認', (A('E20011', 'block.fix2', { block_id: 'b1' }), B('b1').phase), '蓋章確認');
}

// ============ 蓋章確認、審稿、出稿、延遲、職代（再一份新的資料，從頭走到二改） ============
{
  const db3 = Object.assign({ audit: [] }, Seed.build(NOW));
  const A = (who, action, p) => R.act(db3, who, action, p, NOW);
  const C = id => db3.cells.find(c => c.id === id);
  const plan = db3.plans.find(p => p.id === 'p1');
  const who = c => { const o = R.ownerOf(db3, c); return o === 'E10245' ? 'E10118' : o; };
  for (const c of db3.cells) {
    A(who(c), 'detail.save', { cell_id: c.id, patch: { sku: db3.products.find(p => p.category_id === c.category_id).sku } });
    A(who(c), 'detail.submit', { cell_id: c.id });
    A('E20011', 'make.submit', { cell_id: c.id });
    A(who(c), 'review.mark', { cell_id: c.id, done: true });
  }
  for (const b of db3.blocks) {
    for (const pid of R.blockPms(db3, b.id)) A(pid === 'E10245' ? 'E10118' : pid, 'block.review1', { block_id: b.id, as_pm: pid });
    A('E20011', 'block.masthead', { block_id: b.id, ok: true });
    markFix(db3, b.id);
    A('E20011', 'block.fix1', { block_id: b.id });
    for (const c of db3.cells.filter(x => x.block_id === b.id)) A(who(c), 'r2.mark', { cell_id: c.id, done: true });
    for (const pid of R.blockPms(db3, b.id)) A(pid === 'E10245' ? 'E10118' : pid, 'block.r2pm', { block_id: b.id, as_pm: pid });
    for (const L of [3, 2]) for (const m of new Set(db3.cells.filter(x => x.block_id === b.id).map(x => R.mgrOf(db3, x, L)))) A(m, 'mgr.submit', { block_id: b.id, level: L });
  }
  eq('兩個版位都進二改', db3.blocks.map(b => b.phase), ['二改', '二改']);
  A('E20011', 'block.mh2', { block_id: 'b1', ok: true });
  markFix(db3, 'b1');
  A('E20011', 'block.fix2', { block_id: 'b1' });
  eq('版位一進蓋章確認', db3.blocks.map(b => b.phase), ['蓋章確認', '二改']);

  // 蓋章（4.7）
  eq('別人不能蓋', A('E10252', 'stamp', { cell_id: 'c1' }).kind, 'forbidden');
  eq('PM 蓋章', A('E10234', 'stamp', { cell_id: 'c1' }).ok, true);
  eq('蓋章記層級', C('c1').r3.stamp.level, 4);
  eq('代理人蓋的章算 PM（照冷氣PM算）', (A('E10118', 'stamp', { cell_id: 'c8' }), [C('c8').r3.stamp.level, C('c8').r3.stamp.acting, C('c8').r3.stamp.as]), [4, true, 'E10245']);
  eq('蓋了不能再蓋', A('E10234', 'stamp', { cell_id: 'c1' }).reason, '已經蓋過章');
  // PM 自己要調整：放便利貼，送回者是他自己
  A('E10234', 'note.add', { cell_id: 'c2', kind: '修改', text: '價格要改' });
  eq('貼了要調整的便利貼就不能直接蓋', A('E10234', 'stamp', { cell_id: 'c2' }).reason.startsWith('你在這一格貼了'), true);
  A('E10234', 'stamp.reject', { cell_id: 'c2' });
  eq('PM 自己退件', [C('c2').r3.cycle.by, C('c2').r3.cycle.level], ['E10234', 4]);
  eq('蓋章確認期間的退件屬於蓋章修改', R.stageOf(db3, C('c2')), '蓋章修改');
  // 課長還不能開始：他管的格子還沒蓋齊（而且版位二還沒進蓋章確認）
  eq('課長要等他管的格子都蓋完章', A('E10118', 'mgr3.submit', { plan_id: 'p1', level: 3 }).reason, '你管的格子還沒全部蓋完章（或有格子在退件修改中）');
  // 退件循環：改完 PM 蓋章 N（6.2 最後一段：就是一般蓋章）
  A('E20011', 'cycle.judge', { cell_id: 'c2', kind: '設計問題' });
  A('E20011', 'note.resolve', { note_id: R.openOn(db3, C('c2'), ['reject'])[0].id, done: true });
  A('E20011', 'cycle.fixDone', { cell_id: 'c2' });
  A('E10234', 'cycle.confirm', { cell_id: 'c2' });
  eq('PM 自己退的：蓋章 N 就是一般蓋章，沒有重審', [C('c2').r3.cycle, C('c2').r3.stamp.n, C('c2').r3.hi], [null, 2, 4]);
  for (const c of db3.cells.filter(x => x.block_id === 'b1' && !x.r3.stamp)) A(who(c), 'stamp', { cell_id: c.id });
  eq('家電課長管的格子都蓋完章 → 輪到他', R.mgr3PendingLevel(db3, C('c1')), 3);
  // 版位二進來
  A('E20011', 'block.mh2', { block_id: 'b2', ok: true });
  markFix(db3, 'b2');
  A('E20011', 'block.fix2', { block_id: 'b2' });
  for (const c of db3.cells.filter(x => x.block_id === 'b2')) A(who(c), 'stamp', { cell_id: c.id });
  const b2 = cat => db3.cells.filter(c => c.block_id === 'b2' && c.category_id === cat);
  eq('蓋章輪重新算：筆電 3C課長兼筆電PM身兼課長 → 課長略過', b2('202').map(c => c.r3.steps[3] && c.r3.steps[3].how), ['skip', 'skip', 'skip']);
  eq('二校輪的結果不帶進來：電視還是要課長審', b2('201').map(c => R.mgr3PendingLevel(db3, c)), [3, 3, 3]);
  eq('部長要等她管的格子（整份）都過課長', R.mgr3PendingLevel(db3, b2('202')[0]), null);
  A('E10118', 'mgr3.submit', { plan_id: 'p1', level: 3 });
  eq('部長還在等3C課長兼筆電PM那一邊', A('E10056', 'mgr3.submit', { plan_id: 'p1', level: 2 }).reason, '你管的格子還沒全部過課長這一關');
  A('E10131', 'mgr3.submit', { plan_id: 'p1', level: 3 });
  eq('機上盒：部長也略過', b2('111').map(c => c.r3.steps[2] && c.r3.steps[2].how), ['skip', 'skip']);
  // 部長退件一格：改完 PM 蓋章 N → 直接回部長，課長不重審
  A('E10056', 'note.add', { cell_id: 'c1', kind: '換品', text: '換一台' });
  A('E10056', 'mgr3.submit', { plan_id: 'p1', level: 2 });
  eq('還沒商品部確認完成（有一格在退件）', plan.final || null, null);
  eq('處長要等部長那一關（有一格在部長的退件裡）', A('E10002', 'mgr3.submit', { plan_id: 'p1', level: 1 }).reason, '你管的格子還沒全部過部長這一關');
  A('E20011', 'cycle.judge', { cell_id: 'c1', kind: '商品問題' });
  A('E10234', 'detail.save', { cell_id: 'c1', patch: { sku: 'NR-F607HX' } });
  A('E10234', 'cycle.dataDone', { cell_id: 'c1' });
  A('E20011', 'note.resolve', { note_id: R.openOn(db3, C('c1'), ['reject'])[0].id, done: true });
  A('E20011', 'cycle.fixDone', { cell_id: 'c1' });
  A('E10234', 'cycle.confirm', { cell_id: 'c1' });
  eq('蓋章 N 之後：已審最高層級設為課長、送回部長', [C('c1').r3.hi, C('c1').r3.cycle.state, C('c1').r3.cycle.by, C('c1').r3.steps[3].how], [3, 'rereview', 'E10056', 'pass']);
  A('E10056', 'cycle.pass', { cell_id: 'c1' });
  eq('部長都過了 → 輪到處長（蓋章輪第三層）', R.mgr3PendingLevel(db3, C('c1')), 1);
  eq('處長還沒審，商品部還沒確認完成', plan.final || null, null);
  eq('協理不是那四層：審不了蓋章輪', A('E10001', 'mgr3.submit', { plan_id: 'p1', level: 1 }).kind, 'forbidden');
  A('E10002', 'mgr3.submit', { plan_id: 'p1', level: 1 });
  eq('商品部確認完成', !!plan.final.confirmed_at, true);
  eq('通知行銷', db3.notifications.some(n => n.to === 'E30007' && n.text.includes('商品部確認完成')), true);

  // 審稿（4.10）
  eq('非行銷不能送', A('E10234', 'final.send', { plan_id: 'p1' }).kind, 'forbidden');
  db3.reviewerSettings.lawyer_id = '';
  eq('設定表沒填完不能送', A('E30007', 'final.send', { plan_id: 'p1' }).missing, ['律師還沒指定']);
  eq('設定表只有行銷能改', A('E10234', 'settings.save', { patch: { lawyer_id: 'E40003' } }).kind, 'forbidden');
  A('E30007', 'settings.save', { patch: { lawyer_id: 'E40003' } });
  eq('行銷送最終審核', A('E30007', 'final.send', { plan_id: 'p1' }).ok, true);
  eq('版位進審稿', db3.blocks.map(b => b.phase), ['審稿', '審稿']);
  eq('輪到商品處協理', R.currentSeat(plan), 1);
  eq('律師不能搶先', A('E40003', 'final.submit', { plan_id: 'p1' }).kind, 'forbidden');
  A('E10001', 'final.submit', { plan_id: 'p1' });
  eq('協理通過 → 行銷處協理', R.currentSeat(plan), 2);
  A('E30001', 'note.add', { cell_id: 'c5', kind: '修改', text: '活動規則寫清楚' });
  A('E30001', 'final.submit', { plan_id: 'p1' });
  eq('行銷處協理退件一格：他這一關等重審', [plan.final.seats[2].how, R.currentSeat(plan)], ['waiting', 2]);
  eq('等重審的時候不能再按', A('E30001', 'final.submit', { plan_id: 'p1' }).reason, '你退件的格子還在修改，改好會送回給你重審');
  A('E20011', 'cycle.judge', { cell_id: 'c5', kind: '設計問題' });
  A('E20011', 'note.resolve', { note_id: R.openOn(db3, C('c5'), ['reject'])[0].id, done: true });
  A('E20011', 'cycle.fixDone', { cell_id: 'c5' });
  A('E10234', 'cycle.confirm', { cell_id: 'c5' });
  eq('PM 蓋章 N 後直接送回退件者（不回商品處協理）', [C('c5').fin.cycle.by, !!C('c5').fin.stampN], ['E30001', true]);
  A('E30001', 'cycle.pass', { cell_id: 'c5' });
  eq('重審通過 → 他這一關通過，輪到律師', R.currentSeat(plan), 3);
  A('E40003', 'final.submit', { plan_id: 'p1' });
  eq('律師通過 → 出稿', db3.blocks.map(b => b.phase), ['出稿', '出稿']);

  // 出稿（4.11、8.4）
  const sku = C('c1').detail.sku;
  eq('出稿前沒有正式版', db3.traces[sku].official, null);
  eq('PM 不能出稿', A('E10234', 'publish', { plan_id: 'p1' }).kind, 'forbidden');
  A('E20011', 'publish', { plan_id: 'p1' });
  eq('出稿寫入正式版', db3.traces[sku].official.v, db3.traces[sku].draft.v);
  eq('進度：已出稿', R.planProgress(db3, 'p1').done, true);
}

// ============ 延遲、通知、進度確認 ============
{
  const db4 = Object.assign({ audit: [] }, Seed.build(NOW));
  const plan = db4.plans.find(p => p.id === 'p1');
  const due = +new Date(plan.schedule[0].end + 'T18:00:00');
  R.sweep(db4, due - 3 * 3600000);
  eq('截止前 4 小時提醒 PM', db4.notifications.some(n => n.to === 'E10234' && n.text.includes('再 4 小時截止')), true);
  R.sweep(db4, due + 60000);
  const late = db4.notifications.filter(n => n.text.includes('冰箱（家電）提明細 延遲'));
  eq('提明細延遲：負責人、行銷、CC 課長', [...new Set(late.map(n => n.to))].sort(), ['E10118', 'E10234', 'E30007'].sort());
  eq('延遲只通知一次', (R.sweep(db4, due + 120000), db4.notifications.filter(n => n.text.includes('冰箱（家電）提明細 延遲')).length), late.length);
  eq('代理中的也收到（冷氣PM → 家電課長）', db4.notifications.some(n => n.to === 'E10118' && n.text.includes('冷氣（家電）提明細 延遲')), true);
  const rows = R.categoryProgress(db4, 'p1', due + 60000);
  eq('進度確認：一個品類一行、有完成比例、延遲', rows.find(r => r.category_name === '冰箱').text, '提明細（0/4）（延遲）');
  eq('延遲不會讓任何東西自動往下走', db4.cells.every(c => c.stage === '提明細'), true);
  eq('記一筆進入延遲', db4.audit.some(a => a.what === '單位進入延遲'), true);
  // 延遲後完成
  const A = (w, x, p) => R.act(db4, w, x, p, due + 70000);
  for (const c of db4.cells.filter(x => x.category_id === '101')) { A('E10234', 'detail.save', { cell_id: c.id, patch: { sku: 'R-HW620RV' } }); A('E10234', 'detail.submit', { cell_id: c.id }); }
  R.sweep(db4, due + 80000);
  eq('延遲後完成有記', db4.audit.some(a => a.what === '延遲後完成' && a.detail.startsWith('冰箱')), true);
}

// ============ 職代（8.2） ============
{
  const db5 = Object.assign({ audit: [] }, Seed.build(NOW));
  const A = (w, x, p) => R.act(db5, w, x, p, NOW);
  const s = new Date(NOW).toISOString(), e = new Date(NOW + 2 * 86400000).toISOString();
  eq('不相干的人不能替冰箱洗衣機PM指定', A('E10252', 'deleg.add', { from_id: 'E10234', to_id: 'E10252', start: s, end: e }).kind, 'forbidden');
  eq('PM 自己可以指定', A('E10234', 'deleg.add', { from_id: 'E10234', to_id: 'E10252', start: s, end: e }).ok, true);
  eq('電視PM現在可以填冰箱洗衣機PM的冰箱', A('E10252', 'detail.save', { cell_id: 'c1', patch: { sku: 'R-HW620RV' } }).ok, true);
  eq('上層主管替冷氣PM改職代：覆寫差勤帶進來的', A('E10118', 'deleg.add', { from_id: 'E10245', to_id: 'E10234', start: s, end: e }).ok, true);
  eq('家電課長不再代理冷氣PM', R.act(db5, 'E10118', 'detail.save', { cell_id: 'c8', patch: { sku: 'RXV50UVLT' } }, NOW).kind, 'forbidden');
  const d = db5.delegations.find(x => x.to_id === 'E10234');
  A('E10118', 'deleg.cancel', { id: d.id });
  eq('取消之後，差勤帶進來的放回來', R.act(db5, 'E10118', 'detail.save', { cell_id: 'c8', patch: { sku: 'RXV50UVLT' } }, NOW).ok, true);
  eq('紀錄：指定、取消', ['指定職代', '取消職代'].every(w => db5.audit.some(a => a.what === w)), true);
}

/* 照片上那種「課主管＝部主管」（公司的商品部門分類列表：洗衣機的課主管和部主管是同一個人）。
   實作指南 2.2：身兼多層時，他的動作一律算他在該分類的最高層級 —— 他以課長身分按通過，
   就等於部長也審過了，不能叫同一個人再按一次。 */
{
  const db6 = Object.assign({ audit: [] }, Seed.build(NOW));
  db6.reviewerSettings.r2_managers = true;     // 二校有主管的時候才有這件事
  const wash = db6.assignments.find(a => a.category_id === '102');
  wash.manager_id = 'E10118'; wash.director_id = 'E10118';
  const A = (w, x, p) => R.act(db6, w, x, p, NOW);
  const who = c => { const o = R.ownerOf(db6, c); return o === 'E10245' ? 'E10118' : o; };
  for (const c of db6.cells) {
    A(who(c), 'detail.save', { cell_id: c.id, patch: { sku: db6.products.find(p => p.category_id === c.category_id).sku } });
    A(who(c), 'detail.submit', { cell_id: c.id });
    A('E20011', 'make.submit', { cell_id: c.id });
    A(who(c), 'review.mark', { cell_id: c.id, done: true });
  }
  const b = db6.blocks[0];
  for (const pid of R.blockPms(db6, b.id)) A(pid === 'E10245' ? 'E10118' : pid, 'block.review1', { block_id: b.id, as_pm: pid });
  A('E20011', 'block.masthead', { block_id: b.id, ok: true });
  markFix(db6, b.id);
  A('E20011', 'block.fix1', { block_id: b.id });
  for (const c of db6.cells.filter(x => x.block_id === b.id)) A(who(c), 'r2.mark', { cell_id: c.id, done: true });
  for (const pid of R.blockPms(db6, b.id)) A(pid === 'E10245' ? 'E10118' : pid, 'block.r2pm', { block_id: b.id, as_pm: pid });
  const washCells = db6.cells.filter(c => c.block_id === b.id && c.category_id === '102');
  eq('課主管兼部主管：二校先輪到他當課長', washCells.map(c => R.mgrPendingLevel(db6, c)), [3, 3, 3]);
  A('E10118', 'mgr.submit', { block_id: b.id, level: 3 });
  eq('他按一次就算到部長那一層（部長略過）', washCells.map(c => [c.r2.hi, c.r2.steps[2] && c.r2.steps[2].how]), [[2, 'skip'], [2, 'skip'], [2, 'skip']]);
  eq('冰箱的部長照樣要審（她不是冰箱的課長）', db6.cells.filter(c => c.block_id === b.id && c.category_id === '101').map(c => R.mgrPendingLevel(db6, c)), [2, 2, 2, 2]);
}

/* 蓋章輪的「部長＝處長」：同一個人以部長身分按通過，處長那一層自動略過（2.2、5.3） */
{
  const db8 = Object.assign({ audit: [] }, Seed.build(NOW));
  db8.assignments.find(a => a.category_id === '102').executive_id = 'E10056';
  const A = (w, x, p) => R.act(db8, w, x, p, NOW);
  const who = c => { const o = R.ownerOf(db8, c); return o === 'E10245' ? 'E10118' : o; };
  for (const c of db8.cells) {
    A(who(c), 'detail.save', { cell_id: c.id, patch: { sku: db8.products.find(p => p.category_id === c.category_id).sku } });
    A(who(c), 'detail.submit', { cell_id: c.id });
    A('E20011', 'make.submit', { cell_id: c.id });
    A(who(c), 'review.mark', { cell_id: c.id, done: true });
  }
  for (const b of db8.blocks) {
    for (const pid of R.blockPms(db8, b.id)) A(pid === 'E10245' ? 'E10118' : pid, 'block.review1', { block_id: b.id, as_pm: pid });
    A('E20011', 'block.masthead', { block_id: b.id, ok: true });
    markFix(db8, b.id);
    A('E20011', 'block.fix1', { block_id: b.id });
    for (const c of db8.cells.filter(x => x.block_id === b.id)) A(who(c), 'r2.mark', { cell_id: c.id, done: true });
    for (const pid of R.blockPms(db8, b.id)) A(pid === 'E10245' ? 'E10118' : pid, 'block.r2pm', { block_id: b.id, as_pm: pid });
    A('E20011', 'block.mh2', { block_id: b.id, ok: true });
    markFix(db8, b.id);
    A('E20011', 'block.fix2', { block_id: b.id });
  }
  for (const c of db8.cells) A(who(c), 'stamp', { cell_id: c.id });
  for (const L of [3, 2]) for (const m of new Set(db8.cells.map(c => R.mgrOf(db8, c, L)))) A(m, 'mgr3.submit', { plan_id: 'p1', level: L });
  const wash8 = db8.cells.filter(c => c.category_id === '102');
  eq('部長兼洗衣機處長：部長通過就算到處長，處長略過', wash8.map(c => c.r3.steps[1] && c.r3.steps[1].how), wash8.map(() => 'skip'));
  eq('冰箱的處長照樣要審', db8.cells.filter(c => c.category_id === '101').map(c => R.mgr3PendingLevel(db8, c)), [1, 1, 1, 1]);
}

/* 主程式的版面同步進來（plan.sync）：審核開始後版面照樣改得動，審核狀態要跟上。
   主程式送的 id 是「檔期/版位」「檔期/格子」。 */
{
  const db7 = Object.assign({ audit: [] }, Seed.build(NOW));
  db7.plans = []; db7.blocks = []; db7.cells = [];
  const A = (w, x, p) => R.act(db7, w, x, p, NOW);
  const sched = Seed.build(NOW).plans[0].schedule;
  const sk = (cells, blocks) => ({ skeleton: {
    plan: { id: 'P', name: '主程式的檔期', type: '全省對開大DM', created_by: 'E30007', schedule: sched },
    blocks: blocks || [{ id: 'P/b1', name: '冰箱・洗衣機', ord: 1 }, { id: 'P/b2', name: '平板', ord: 2 }],
    cells } });
  const base = [
    { id: 'P/b1-c0', block_id: 'P/b1', category_id: '101', cat_name: '冰箱', idx: 1 },
    { id: 'P/b1-c1', block_id: 'P/b1', category_id: '101', cat_name: '冰箱', idx: 2 },
    { id: 'P/b1-c2', block_id: 'P/b1', category_id: '102', cat_name: '洗衣機', idx: 1 },
    { id: 'P/b2-c0', block_id: 'P/b2', category_id: null, cat_name: '平板', idx: 1 },
  ];
  eq('第一次同步：檔期、兩個版位、四格都從提明細開始', (A('E20011', 'plan.sync', sk(base)), [db7.plans.length, db7.blocks.length, db7.cells.map(c => c.stage)]), [1, 2, ['提明細', '提明細', '提明細', '提明細']]);
  const n0 = db7.audit.length;
  A('E20011', 'plan.sync', sk(base));
  eq('沒變就不記紀錄', db7.audit.length, n0);
  eq('沒有負責人的格子送不動', A('E10234', 'detail.submit', { cell_id: 'P/b2-c0' }).reason, '「平板」不在分類表上，這一格沒有負責人，送不進審核');
  eq('狀態寫「沒有負責人」', R.cellStatus(db7, db7.cells.find(c => c.id === 'P/b2-c0')).text, '沒有負責人');
  const rows = R.categoryProgress(db7, 'P', NOW);
  eq('進度一個品類一行，沒有負責人的照名字列', rows.map(r => [r.category_name, r.unassigned]), [['冰箱', false], ['洗衣機', false], ['平板', true]]);
  // 冰箱第一格走到製作
  const c0 = db7.cells.find(c => c.id === 'P/b1-c0');
  c0.detail = { sku: 'R-HW620RV', name: '日立', price: 1 };
  A('E10234', 'detail.submit', { cell_id: 'P/b1-c0' });
  // 少一格（c1）、多一格（c3）
  const less = base.filter(c => c.id !== 'P/b1-c1').concat([{ id: 'P/b1-c3', block_id: 'P/b1', category_id: '101', cat_name: '冰箱', idx: 2 }]);
  A('E20011', 'plan.sync', sk(less));
  eq('收起一格、新增一格', [db7.cells.some(c => c.id === 'P/b1-c1'), db7.archive.cells.some(c => c.id === 'P/b1-c1'), db7.cells.find(c => c.id === 'P/b1-c3').stage], [false, true, '提明細']);
  eq('其他格的進度不動', c0.stage, '製作');
  eq('記一筆紀錄', db7.audit[db7.audit.length - 1].detail, '新增 1 格、收起 1 格');
  // 同一個 id 回來（合併拆開）：接回原本的
  db7.archive.cells.find(c => c.id === 'P/b1-c1').stage = '製作';
  A('E20011', 'plan.sync', sk(base.concat([{ id: 'P/b1-c3', block_id: 'P/b1', category_id: '101', cat_name: '冰箱', idx: 3 }])));
  eq('同一格回來接回進度', db7.cells.find(c => c.id === 'P/b1-c1').stage, '製作');
  // 兩塊對調內容：格子搬到另一個版位，進度跟著走
  A('E20011', 'plan.sync', sk(base.map(c => c.id === 'P/b1-c0' ? Object.assign({}, c, { block_id: 'P/b2' }) : c)));
  eq('格子換版位，進度跟著格子', [c0.block_id, c0.stage], ['P/b2', '製作']);
  // 品類換到表上：負責人跟著換
  A('E20011', 'plan.sync', sk(base.map(c => c.id === 'P/b2-c0' ? Object.assign({}, c, { category_id: '203', cat_name: '手機' }) : c)));
  eq('平板改成手機：現在是手機PM的', R.ownerOf(db7, db7.cells.find(c => c.id === 'P/b2-c0')), 'E10260');
  // 版位拿掉：收起來
  A('E20011', 'plan.sync', sk(base.filter(c => c.block_id === 'P/b1'), [{ id: 'P/b1', name: '冰箱・洗衣機', ord: 1 }]));
  eq('版位拿掉連格子收起來', [db7.blocks.map(b => b.id), db7.archive.blocks.map(b => b.id)], [['P/b1'], ['P/b2']]);
  // 版位已經到一改，後來加的格子照自己的關
  const b1 = db7.blocks.find(b => b.id === 'P/b1');
  b1.phase = '一改';
  A('E20011', 'plan.sync', sk(base.filter(c => c.block_id === 'P/b1').concat([{ id: 'P/b1-c9', block_id: 'P/b1', category_id: '101', cat_name: '冰箱', idx: 9 }]), [{ id: 'P/b1', name: '冰箱・洗衣機', ord: 1 }]));
  eq('一改之後才加的格子寫提明細', R.stageOf(db7, db7.cells.find(c => c.id === 'P/b1-c9')), '提明細');
  // 沒有負責人的格子不能讓待辦、延遲通知整支炸掉（主程式的範例檔期就有這種品類）
  A('E20011', 'plan.sync', sk(base));
  const far = NOW + 30 * 86400000;
  let threw = null;
  try { R.sweep(db7, far); R.todo(db7, 'E10234', far); R.categoryProgress(db7, 'P', far); } catch (e) { threw = e.message; }
  eq('有沒有負責人的格子時，待辦和延遲通知照常', threw, null);
  eq('沒有負責人的品類延遲：只通知行銷', [...new Set(db7.notifications.filter(n => n.text.includes('平板')).map(n => n.to))], ['E30007']);
}

/* 主程式：挑好的貨（detail.set）、便利貼影本（plan.sync 帶 notes） */
{
  const db9 = Object.assign({ audit: [] }, Seed.build(NOW));
  db9.plans = []; db9.blocks = []; db9.cells = [];
  const A = (w, x, p) => R.act(db9, w, x, p, NOW);
  const sched = Seed.build(NOW).plans[0].schedule;
  const cells = [
    { id: 'Q/b1-c0', block_id: 'Q/b1', category_id: '101', cat_name: '冰箱', idx: 1 },
    { id: 'Q/b1-c1', block_id: 'Q/b1', category_id: '101', cat_name: '冰箱', idx: 2 },
  ];
  const sync = notes => A('E20011', 'plan.sync', { skeleton: {
    plan: { id: 'Q', name: '便利貼', type: '', created_by: 'E30007', schedule: sched },
    blocks: [{ id: 'Q/b1', name: '冰箱', ord: 1 }], cells, notes } });
  sync([]);
  const C = id => db9.cells.find(c => c.id === id);
  eq('別人不能寫這一格的貨', A('E10252', 'detail.set', { cell_id: 'Q/b1-c0', detail: { sku: 'X1', name: 'x', price: 1 } }).kind, 'forbidden');
  eq('編號有空格不收', A('E10234', 'detail.set', { cell_id: 'Q/b1-c0', detail: { sku: 'A B', name: 'x', price: 1 } }).reason, '商品編號不能有空格');
  eq('別人分類的商品不收', A('E10234', 'detail.set', { cell_id: 'Q/b1-c0', detail: { sku: 'KM-65X80L', name: 'x', price: 1 } }).reason, '只能挑冰箱洗衣機PM負責分類的商品');
  eq('同一位 PM 的另一個分類可以（冰箱PM挑洗衣機）', A('E10234', 'detail.set', { cell_id: 'Q/b1-c1', detail: { sku: 'NA-V190NMS', name: '滾筒', price: 45900 } }).ok, true);
  eq('目錄沒有的編號也收（主程式的目錄還沒推過來）', A('E10234', 'detail.set', { cell_id: 'Q/b1-c0', detail: { sku: 'NEW-1', name: '新冰箱', price: 30000 } }).ok, true);
  eq('寫進去了就送得出去', A('E10234', 'detail.submit', { cell_id: 'Q/b1-c0' }).ok, true);
  eq('送出之後不能再改', A('E10234', 'detail.set', { cell_id: 'Q/b1-c0', detail: { sku: 'NEW-2', name: 'x', price: 1 } }).reason, '提明細已經送出，不能再改');
  eq('一次好幾個（actMany 在資料層）：規則一個一個判斷', [A('E10234', 'detail.submit', { cell_id: 'Q/b1-c1' }).ok, C('Q/b1-c1').stage], [true, '製作']);
  // 走到一校，PM 在第一格貼一則意見（主程式那邊貼的，同步過來）
  for (const c of db9.cells) A('E20011', 'make.submit', { cell_id: c.id });
  sync([{ id: 'nX', cell_id: 'Q/b1-c0', author: 'E10234', kind: '修改', text: '價格改活動價', done: false, at: '' },
        { id: 'nY', cell_id: 'Q/b1-c1', author: 'E20011', kind: '留言', text: '圖還在等', done: false, at: '' }]);
  eq('PM 在一校貼的：算一校的意見', db9.notes.find(n => n.id === 'nX').purpose, '一校');
  eq('設計在一校貼的：只是聊天', db9.notes.find(n => n.id === 'nY').purpose, 'chat');
  for (const c of db9.cells) A('E10234', 'review.mark', { cell_id: c.id, done: true });
  A('E10234', 'block.review1', { block_id: 'Q/b1', as_pm: 'E10234' });
  eq('有意見的那一格進一改', [C('Q/b1-c0').fix, C('Q/b1-c1').fix], [true, true]);
  A('E20011', 'block.masthead', { block_id: 'Q/b1', ok: true });
  eq('一改：便利貼沒處理送不出去', A('E20011', 'block.fix1', { block_id: 'Q/b1' }).missing, ['2 張便利貼還沒處理', '2 格還沒標「改好了」']);
  markFix(db9, 'Q/b1');
  sync([{ id: 'nX', cell_id: 'Q/b1-c0', author: 'E10234', kind: '修改', text: '價格改活動價 29900', done: true, at: '' },
        { id: 'nY', cell_id: 'Q/b1-c1', author: 'E20011', kind: '留言', text: '圖還在等', done: true, at: '' }]);
  eq('主程式那邊打勾「處理了」→ 這邊跟著', db9.notes.map(n => n.status), ['resolved', 'resolved']);
  eq('字跟著改', db9.notes.find(n => n.id === 'nX').text, '價格改活動價 29900');
  eq('都處理了就送得出去', A('E20011', 'block.fix1', { block_id: 'Q/b1' }).ok, true);
  sync([{ id: 'nX', cell_id: 'Q/b1-c0', author: 'E10234', kind: '修改', text: '價格改活動價 29900', done: true, at: '' }]);
  eq('主程式那邊撕掉的，這邊也拿掉', db9.notes.map(n => n.id), ['nX']);
}

/* 審核開始後才加的格子要自己補完一校（不能被整塊帶著走）；合併掉正在退件的那一格，
   退件接到留下來那一格；品類改成別人的，兩邊都要知道（2026-09-28 那一輪找到的） */
{
  const d = Object.assign({ audit: [] }, Seed.build(NOW));
  d.plans = []; d.blocks = []; d.cells = []; d.notes = [];
  const A = (w, x, p) => R.act(d, w, x, p, NOW);
  const sched = Seed.build(NOW).plans[0].schedule;
  const C = id => d.cells.find(c => c.id === id);
  const cellOf = (i, extra) => Object.assign({ id: 'L/b1-c' + i, block_id: 'L/b1', category_id: '101', cat_name: '冰箱', idx: i + 1 }, extra);
  const sync = (cells, notes) => A('E20011', 'plan.sync', { skeleton: {
    plan: { id: 'L', name: '後加的格子', type: '', created_by: 'E30007', schedule: sched },
    blocks: [{ id: 'L/b1', name: '冰箱', ord: 1 }], cells, notes: notes || [] } });
  const pick = id => A('E10234', 'detail.set', { cell_id: id, detail: { sku: 'SKU-' + id.slice(-2), name: '冰箱', price: 1000 } });
  const upTo1 = id => { pick(id); A('E10234', 'detail.submit', { cell_id: id }); A('E20011', 'make.submit', { cell_id: id }); };
  sync([cellOf(0), cellOf(1)]);
  for (const id of ['L/b1-c0', 'L/b1-c1']) { upTo1(id); A('E10234', 'review.mark', { cell_id: id, done: true }); }
  A('E10234', 'block.review1', { block_id: 'L/b1', as_pm: 'E10234' });
  eq('後加：起點版位到一改', d.blocks[0].phase, '一改');

  sync([cellOf(0), cellOf(1), cellOf(2)]);
  eq('一改之後加的：狀態講自己的關，不講版位的', [R.stageOf(d, C('L/b1-c2')), R.cellStatus(d, C('L/b1-c2')).text], ['提明細', '還沒挑貨']);
  eq('設計不能把它標改好了', A('E20011', 'fix.mark', { cell_id: 'L/b1-c2', done: true }).reason, '這一格是審核開始後才加的，還沒補完一校');
  A('E20011', 'block.masthead', { block_id: 'L/b1', ok: true });
  markFix(d, 'L/b1');
  eq('版位等它：一改送不出去', A('E20011', 'block.fix1', { block_id: 'L/b1' }).missing, ['1 格是審核開始後才加的，還沒補完一校']);
  upTo1('L/b1-c2');
  eq('做完了：補一校', [R.stageOf(d, C('L/b1-c2')), R.cellStatus(d, C('L/b1-c2')).text], ['一校', '補一校：等 PM 審']);
  eq('補一校不走刷子', A('E10234', 'review.mark', { cell_id: 'L/b1-c2', done: true }).reason, '版位已經過了一校：這一格按「補完一校」');
  eq('待辦列著補一校', R.todo(d, 'E10234', NOW).some(t => t.title.includes('補一校')), true);
  eq('別人不能替他補', A('E10252', 'review.late', { cell_id: 'L/b1-c2' }).kind, 'forbidden');
  eq('補完一校', A('E10234', 'review.late', { cell_id: 'L/b1-c2' }).ok, true);
  eq('接上版位的一改', [R.stageOf(d, C('L/b1-c2')), R.cellStatus(d, C('L/b1-c2')).text], ['一改', '一校 OK，等設計確認']);
  markFix(d, 'L/b1');
  eq('補完之後一改送得出去', A('E20011', 'block.fix1', { block_id: 'L/b1' }).ok, true);

  // 二校才加：待辦、狀態不炸；二校完成等它；補完之後照樣走
  sync([cellOf(0), cellOf(1), cellOf(2), cellOf(3)]);
  let threw = null;
  try { R.todo(d, 'E10234', NOW); R.cellStatus(d, C('L/b1-c3')); R.categoryProgress(d, 'L', NOW); } catch (e) { threw = e.message; }
  eq('二校才加的格子：待辦、狀態、進度都不炸', threw, null);
  for (const id of ['L/b1-c0', 'L/b1-c1', 'L/b1-c2']) A('E10234', 'r2.mark', { cell_id: id, done: true });
  eq('二校完成要等後加的那一格', A('E10234', 'block.r2pm', { block_id: 'L/b1', as_pm: 'E10234' }).missing, [`${R.cellLabel(d, C('L/b1-c3'))}還沒補完一校`]);
  eq('後加的那一格不能先審二校', A('E10234', 'r2.mark', { cell_id: 'L/b1-c3', done: true }).ok, false);
  upTo1('L/b1-c3');
  A('E10234', 'review.late', { cell_id: 'L/b1-c3' });
  eq('補完一校：接上二校、要審', [R.stageOf(d, C('L/b1-c3')), R.cellStatus(d, C('L/b1-c3')).text], ['二校', '等 PM 審']);
  A('E10234', 'r2.mark', { cell_id: 'L/b1-c3', done: true });
  eq('四格都審了：二校完成 → 二改', (A('E10234', 'block.r2pm', { block_id: 'L/b1', as_pm: 'E10234' }), d.blocks[0].phase), '二改');

  // 蓋章確認：PM 退一格，設計把那一格併進隔壁 → 退件接到留下來那一格，便利貼跟著搬
  A('E20011', 'block.mh2', { block_id: 'L/b1', ok: true });
  markFix(d, 'L/b1');
  A('E20011', 'block.fix2', { block_id: 'L/b1' });
  eq('蓋章確認', d.blocks[0].phase, '蓋章確認');
  A('E10234', 'note.add', { cell_id: 'L/b1-c1', kind: '修改', text: '價格改一下' });
  eq('PM 自己退一格', A('E10234', 'stamp.reject', { cell_id: 'L/b1-c1' }).ok, true);
  const nid = d.notes.find(n => n.cell_id === 'L/b1-c1').id;
  const merged = [cellOf(0, { absorbed: ['L/b1-c1'] }), cellOf(2), cellOf(3)];
  const note0 = { id: nid, cell_id: 'L/b1-c0', author: 'E10234', kind: '修改', text: '價格改一下', done: false, at: '' };
  sync(merged, [note0]);
  const cy0 = C('L/b1-c0').r3.cycle;
  eq('合併掉正在退件的那一格：退件接到留下來那一格', [!!cy0, cy0 && cy0.by, cy0 && cy0.state], [true, 'E10234', 'judge']);
  eq('便利貼跟著搬', d.notes.find(n => n.id === nid).cell_id, 'L/b1-c0');
  eq('紀錄寫得出來', d.audit.some(x => (x.detail || '').includes('退件接到合併後的格子')), true);
  A('E20011', 'cycle.judge', { cell_id: 'L/b1-c0', kind: '設計問題' });
  eq('設計照樣要處理那張便利貼才改得完', A('E20011', 'cycle.fixDone', { cell_id: 'L/b1-c0' }).missing, ['1 張退件便利貼還沒標成已處理']);
  eq('其他格照樣蓋得了章', A('E10234', 'stamp', { cell_id: 'L/b1-c2' }).ok, true);

  // 品類改成表上另一個分類：換人要講（新的人、原本的人都通知）
  sync(merged.map(c => c.id === 'L/b1-c3' ? Object.assign({}, c, { category_id: '203', cat_name: '手機' }) : c), [note0]);
  eq('換人：新的人收到通知', d.notifications.some(x => x.to === 'E10260' && x.text.includes('換給你負責')), true);
  eq('換人：原本的人也收到', d.notifications.some(x => x.to === 'E10234' && x.text.includes('改由')), true);
  eq('換人：紀錄寫幾格', d.audit[d.audit.length - 1].detail.includes('1 格換負責人'), true);
  eq('已經走過的關不重來', R.stageOf(d, C('L/b1-c3')), '蓋章確認');
}

/* 印章在提明細、蓋章確認只是「標起來」（2026-09-29，使用者：全部蓋完就自己送出去不要）——
   標了不算送出、取消得掉；按送出（detail.submit、stamp）才算數，主管那邊送出之後才開始 */
{
  const d = Object.assign({ audit: [] }, Seed.build(NOW));
  d.plans = []; d.blocks = []; d.cells = []; d.notes = [];
  const A = (w, x, p) => R.act(d, w, x, p, NOW);
  const sched = Seed.build(NOW).plans[0].schedule;
  const C = id => d.cells.find(c => c.id === id);
  const ids = ['M/b1-c0', 'M/b1-c1'];
  A('E20011', 'plan.sync', { skeleton: { plan: { id: 'M', name: '印章', type: '', created_by: 'E30007', schedule: sched },
    blocks: [{ id: 'M/b1', name: '冰箱', ord: 1 }], notes: [],
    cells: ids.map((id, i) => ({ id, block_id: 'M/b1', category_id: '101', cat_name: '冰箱', idx: i + 1 })) } });
  for (const id of ids) A('E10234', 'detail.set', { cell_id: id, detail: { sku: 'S' + id.slice(-1), name: '冰箱', price: 1000 } });
  eq('提明細：標起來', [A('E10234', 'detail.mark', { cell_id: 'M/b1-c0', done: true }).ok, C('M/b1-c0').stage, R.cellStatus(d, C('M/b1-c0')).text], [true, '提明細', '尚未送出']);
  eq('提明細：別人不能替他標', A('E10252', 'detail.mark', { cell_id: 'M/b1-c0', done: true }).kind, 'forbidden');
  eq('提明細：標錯取消得掉', (A('E10234', 'detail.mark', { cell_id: 'M/b1-c0', done: false }), R.cellStatus(d, C('M/b1-c0')).text), '填寫中');
  eq('提明細：送出才算數', (A('E10234', 'detail.submit', { cell_id: 'M/b1-c0' }), C('M/b1-c0').stage), '製作');
  eq('提明細：送出之後不能再標', A('E10234', 'detail.mark', { cell_id: 'M/b1-c0', done: false }).ok, false);
  A('E10234', 'detail.submit', { cell_id: 'M/b1-c1' });
  // 一路走到蓋章確認
  for (const id of ids){ A('E20011', 'make.submit', { cell_id: id }); A('E10234', 'review.mark', { cell_id: id, done: true }); }
  A('E10234', 'block.review1', { block_id: 'M/b1', as_pm: 'E10234' });
  A('E20011', 'block.masthead', { block_id: 'M/b1', ok: true }); markFix(d, 'M/b1'); A('E20011', 'block.fix1', { block_id: 'M/b1' });
  for (const id of ids) A('E10234', 'r2.mark', { cell_id: id, done: true });
  A('E10234', 'block.r2pm', { block_id: 'M/b1', as_pm: 'E10234' });
  A('E20011', 'block.mh2', { block_id: 'M/b1', ok: true }); markFix(d, 'M/b1'); A('E20011', 'block.fix2', { block_id: 'M/b1' });
  eq('印章：走到蓋章確認', d.blocks[0].phase, '蓋章確認');
  for (const id of ids) A('E10234', 'stamp.mark', { cell_id: id, done: true });
  eq('蓋章：兩格都標了，還沒送出（格子寫「尚未送出」）', ids.map(id => [!!C(id).r3.stamp, R.cellStatus(d, C(id)).text]), [[false, '尚未送出'], [false, '尚未送出']]);
  eq('蓋章：全部標好也不會自己送給主管', ids.map(id => R.mgr3PendingLevel(d, C(id))), [null, null]);
  eq('蓋章：標錯取消得掉', (A('E10234', 'stamp.mark', { cell_id: 'M/b1-c1', done: false }), R.cellStatus(d, C('M/b1-c1')).text), '等 PM 蓋章');
  A('E10234', 'note.add', { cell_id: 'M/b1-c1', kind: '修改', text: '價格再確認' });
  eq('蓋章：自己貼了調整便利貼的那一格標不了', A('E10234', 'stamp.mark', { cell_id: 'M/b1-c1', done: true }).ok, false);
  d.notes = d.notes.filter(n => n.cell_id !== 'M/b1-c1');
  A('E10234', 'stamp.mark', { cell_id: 'M/b1-c1', done: true });
  for (const id of ids) A('E10234', 'stamp', { cell_id: id });
  eq('蓋章：按送出才蓋下去，主管那邊才開始', [ids.every(id => !!C(id).r3.stamp), ids.some(id => R.mgr3PendingLevel(d, C(id)) != null)], [true, true]);
  eq('蓋章：送出之後撤不掉', A('E10234', 'stamp.mark', { cell_id: 'M/b1-c0', done: false }).reason, '已經蓋過章');
}

console.log(`\n${pass} 過、${fail} 錯`);
/* 主程式那邊「改版面時審核狀態怎麼跟著走」還沒測的那幾件事（使用者 2026-09-28 要的：
   不鎖版面，但要記下來之後測）。每跑一次測試就提醒一次，免得忘了。 */
try {
  const fs = await import('node:fs');
  const md = fs.readFileSync(new URL('../../review-test-later.md', import.meta.url), 'utf8');
  const todo = md.split(/\r?\n/).filter(l => /^- \[ \]/.test(l));
  if (todo.length) console.log(`待測 ${todo.length} 項（見 review-test-later.md）：\n` + todo.map(l => '  ' + l.replace(/^- \[ \] /, '・')).join('\n'));
} catch { /* 沒有那份清單就算了 */ }
process.exit(fail ? 1 : 0);
