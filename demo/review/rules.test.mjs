// 規則的小測試：node demo/review/rules.test.mjs
// 不開瀏覽器，直接拿假資料跑一遍前段四關，每一步都問「誰能按、按了之後變什麼」。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Seed = require('./seed.js');
const R = require('./rules.js');

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
eq('製作完成', act('E20011', 'make.submit', { cell_id: 'c1' }).ok, true);
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
eq('沒有的一校 OK', R.cellStatus(db, cell('c1')).text, '一校 OK');

// 一改
eq('PM 不能按一改完成', act('E10234', 'block.fix1', { block_id: 'b1' }).kind, 'forbidden');
eq('便利貼沒處理、刊頭沒確認不能送', act('E20011', 'block.fix1', { block_id: 'b1' }).missing, ['1 張便利貼還沒處理', '刊頭還沒確認']);
eq('PM 可以回覆', act('E10234', 'note.reply', { note_id: db.notes[0].id, text: '活動價 49900' }).ok, true);
eq('設計標成已處理', act('E20011', 'note.resolve', { note_id: db.notes[0].id, done: true }).ok, true);
act('E20011', 'block.masthead', { block_id: 'b1', ok: true });
const vBefore = db.traces[cell('c2').detail.sku].draft.v;
eq('一改完成', act('E20011', 'block.fix1', { block_id: 'b1' }).ok, true);
eq('版位進二校', db.blocks.find(b => b.id === 'b1').phase, '二校');
eq('改過的格子草稿版加一', db.traces[cell('c2').detail.sku].draft.v, vBefore + 1);

// 待辦
eq('設計的待辦：沒有一改了', R.todo(db, 'E20011', NOW).filter(i => i.stage === '一改').length, 0);
eq('冰箱洗衣機PM的待辦：版位一進了二校，版位二沒有他的格子', R.todo(db, 'E10234', NOW).map(i => i.title), ['家電 二校']);
eq('電視PM的待辦：電視提明細', R.todo(db, 'E10252', NOW).map(i => i.title), ['電視 提明細']);
eq('進度：最落後的是版位二的提明細', R.planProgress(db, 'p1').stage, '提明細');

// ============ 二校、略過、退件循環、二改（新的一份資料，從頭走到二校） ============
{
  const db2 = Object.assign({ audit: [] }, Seed.build(NOW));
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
  eq('便利貼沒處理、版面沒確認不能送', A('E20011', 'block.fix2', { block_id: 'b1' }).missing, ['1 張便利貼還沒處理', '刊頭與整體版面還沒確認']);
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
    A('E20011', 'block.fix1', { block_id: b.id });
    for (const c of db3.cells.filter(x => x.block_id === b.id)) A(who(c), 'r2.mark', { cell_id: c.id, done: true });
    for (const pid of R.blockPms(db3, b.id)) A(pid === 'E10245' ? 'E10118' : pid, 'block.r2pm', { block_id: b.id, as_pm: pid });
    for (const L of [3, 2]) for (const m of new Set(db3.cells.filter(x => x.block_id === b.id).map(x => R.mgrOf(db3, x, L)))) A(m, 'mgr.submit', { block_id: b.id, level: L });
  }
  eq('兩個版位都進二改', db3.blocks.map(b => b.phase), ['二改', '二改']);
  A('E20011', 'block.mh2', { block_id: 'b1', ok: true });
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
  A('E20011', 'cycle.judge', { cell_id: 'c1', kind: '商品問題' });
  A('E10234', 'detail.save', { cell_id: 'c1', patch: { sku: 'NR-F607HX' } });
  A('E10234', 'cycle.dataDone', { cell_id: 'c1' });
  A('E20011', 'note.resolve', { note_id: R.openOn(db3, C('c1'), ['reject'])[0].id, done: true });
  A('E20011', 'cycle.fixDone', { cell_id: 'c1' });
  A('E10234', 'cycle.confirm', { cell_id: 'c1' });
  eq('蓋章 N 之後：已審最高層級設為課長、送回部長', [C('c1').r3.hi, C('c1').r3.cycle.state, C('c1').r3.cycle.by, C('c1').r3.steps[3].how], [3, 'rereview', 'E10056', 'pass']);
  A('E10056', 'cycle.pass', { cell_id: 'c1' });
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

console.log(`\n${pass} 過、${fail} 錯`);
process.exit(fail ? 1 : 0);
