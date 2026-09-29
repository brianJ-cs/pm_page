/* 審核系統的規則：只做判斷和改資料，不碰畫面、不碰儲存。
 *
 * 為什麼單獨一支：實作指南 8.3 要求**每一個動作都在後端驗證權限**。
 * 現在的「後端」是本機模式的 review-store.js；接上 Supabase 之後，同一份判斷要搬去
 * 伺服器端跑（Edge Function，見 WIRING.md）。這一支零相依、沒有 DOM、輸入輸出都是純資料，
 * 所以可以原封不動搬過去，也能直接用 node 測（rules.test.mjs）。
 *
 * 畫面也讀這一支（can() 決定按鈕亮不亮、按不下去時寫什麼）——
 * 但**畫面算出來的不算數**，真的送出時 act() 在後端再判斷一次。
 *
 * 目錄（對照《DM 審核流程實作指南 v1.1》）：
 *   登入             authorize、identity                         8.3
 *   前段             提明細、製作、一校、一改                      4.1–4.4
 *   二校             PM 審完就進二改；設定表開了「二校主管審核」才走 PM → 課長 → 部長   4.5、第 5 節
 *   二改                                                          4.6
 *   蓋章確認         PM 蓋章、蓋章輪（課長 → 部長 → 處長）、商品部確認完成 4.7–4.9
 *   審稿、出稿       商品處協理 → 行銷處協理 → 律師、設計出稿       4.10–4.11
 *   退件循環         三輪共用同一套                               第 6 節
 *   延遲、進度、通知                                               第 7 節
 *   職代、設定表                                                   8.2、2.3
 */
(function (root) {
  'use strict';

  const STAGES = ['提明細', '製作', '一校', '一改', '二校', '二改', '蓋章確認', '蓋章修改', '審稿', '出稿'];
  const stageIx = s => STAGES.indexOf(s);
  // 數字越小越高：L1 處長 ＞ L2 部長 ＞ L3 課長 ＞ L4 PM（實作指南第 1 節）。
  // 照公司「商品部門分類列表」那四欄：商品主辦／商品課主管／商品部主管／商品處主管。
  // ⚠️ 協理不是這四層裡的一層（2026-09-28 改）：商品處協理、行銷處協理、律師只在最終審核出現。
  const LEVEL_NAME = { 4: 'PM', 3: '課長', 2: '部長', 1: '處長' };
  const LEVEL_FIELD = [['owner_id', 4], ['manager_id', 3], ['director_id', 2], ['executive_id', 1]];
  const MGR_FIELD = { 3: 'manager_id', 2: 'director_id', 1: 'executive_id' };
  /* 二校要不要主管審（最終審核者設定表上的一個開關，全系統一個，預設關）。
     關＝PM 審完、按二校完成就進二改，部長只看進度；開＝PM → 課長 → 部長，有退件循環。
     兩條路都留著：公司改主意的時候是按一下，不是改一次程式（2026-09-28 談定）。 */
  const r2Managers = db => !!(db.reviewerSettings && db.reviewerSettings.r2_managers);
  /* 二校的主管只到部長（處長不參與二校）；蓋章輪是課長 → 部長 → 處長 */
  const R2_LEVELS = [3, 2], R3_LEVELS = [3, 2, 1];
  const ROLE_NAME = { design: '設計', pm: 'PM', mkt: '行銷' };
  const NOTE_KINDS = ['修改', '補貼紙', '換品'];   // 8.1
  const PROBLEM_KINDS = ['設計問題', '商品問題'];  // 6.1 第 4 點
  const SEAT_LABEL = { 1: '商品處協理', 2: '行銷處協理', 3: '律師' };   // 4.10
  const DAY = 86400000, HOUR = 3600000;

  /* ======================================================================
     登入、身分
     ====================================================================== */

  /* email 比對不分大小寫：Google 帳號本來就不分，而人員資料是別人手打推過來的。 */
  const normEmail = e => String(e || '').trim().toLowerCase();
  const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  /* 需求書說 is_active 是選填：沒有這個欄位＝在職。只有明確寫 false 才算離職。 */
  const isActive = m => m.is_active !== false;

  function publicMember(m) {
    const { employee_id, name, email, role, department, title } = m;
    return { employee_id, name, email, role, department: department || '', title: title || '', is_active: isActive(m) };
  }

  /* 這個 email 進不進得來。code：invalid_email／not_registered／inactive */
  function authorize(email, db) {
    const e = normEmail(email);
    if (!validEmail(e)) return { ok: false, code: 'invalid_email', email: e };
    const m = db.members.find(x => normEmail(x.email) === e);
    if (!m) return { ok: false, code: 'not_registered', email: e };
    if (!isActive(m)) return { ok: false, code: 'inactive', email: e, member: publicMember(m) };
    return { ok: true, member: m };
  }

  /* 這個人本人在每個分類掛哪幾層。身兼多層算最高那一層（2.2）。管理範圍照分類算、不照版位算。 */
  function ownLevels(empId, db) {
    const out = [];
    for (const a of db.assignments) {
      const levels = LEVEL_FIELD.filter(([f]) => a[f] === empId).map(([, l]) => l);
      if (levels.length) out.push({ category_id: a.category_id, name: a.category_name, levels, top: Math.min(...levels) });
    }
    return out;
  }

  const t = x => +new Date(x);
  /* 取消的、被系統內指定覆寫掉的都不算（8.2：系統內指定可以覆寫外部帶入的預設代理人） */
  function activeDelegations(db, now) {
    return (db.delegations || []).filter(d => !d.cancelled_at && !d.overridden_by && t(d.start) <= now && now < t(d.end));
  }

  function memberById(db, id) {
    const m = db.members.find(x => x.employee_id === id);
    return m ? publicMember(m) : { employee_id: id, name: id || '', email: '', role: '', department: '', title: '', is_active: false };
  }

  /* ---------- 最終審核者設定表（2.3） ---------- */
  /* 商品處協理（最終審核第一關）。以前預設是分類表的 executive_id —— 那一欄是**處長**
     （公司那一頁的「商品處主管」），不是協理（2026-09-28 改）。所以一律由行銷在設定表指定。 */
  function effectiveExec(db) {
    const rs = db.reviewerSettings || {};
    return rs.exec_id || null;
  }
  function seatReviewer(db, k) {
    const rs = db.reviewerSettings || {};
    return k === 1 ? effectiveExec(db) : k === 2 ? rs.mkt_exec_id : k === 3 ? rs.lawyer_id : null;
  }
  function settingsMissing(db) {
    const rs = db.reviewerSettings || {};
    const miss = [];
    const chk = (id, label) => {
      if (!id) { miss.push(`${label}還沒指定`); return; }
      const m = db.members.find(x => x.employee_id === id);
      if (!m) miss.push(`${label}的員工編號不在人員資料裡`);
      else if (!isActive(m)) miss.push(`${label}（${m.name}）已離職`);
    };
    chk(rs.exec_id, '商品處協理');
    chk(rs.mkt_exec_id, '行銷處協理');
    chk(rs.lawyer_id, '律師');
    chk(rs.design_lead_id, '設計主管');
    return miss;
  }

  /* 登入之後畫面要知道的「我是誰」。 */
  function identity(member, db, now) {
    const me = member.employee_id;
    const active = activeDelegations(db, now);
    const acting = active.filter(d => d.to_id === me).map(d => ({
      id: d.id, start: d.start, end: d.end, source: d.source, stages: d.stages,
      from: memberById(db, d.from_id),
      assignedBy: d.assigned_by ? memberById(db, d.assigned_by) : null,
      categories: ownLevels(d.from_id, db).filter(c => c.levels.includes(4)).map(c => ({ category_id: c.category_id, name: c.name })),
    }));
    const coveredBy = active.filter(d => d.from_id === me).map(d => ({
      id: d.id, start: d.start, end: d.end, source: d.source,
      to: memberById(db, d.to_id),
      assignedBy: d.assigned_by ? memberById(db, d.assigned_by) : null,
    }));
    const finalSeats = [1, 2, 3].filter(k => seatReviewer(db, k) === me).map(k => ({ order: k, label: SEAT_LABEL[k] }));
    return {
      member: publicMember(member),
      roleName: ROLE_NAME[member.role] || member.role,
      categories: ownLevels(me, db),
      acting, coveredBy, finalSeats,
      designLead: (db.reviewerSettings || {}).design_lead_id === me,
    };
  }

  /* ======================================================================
     審核流程
     ----------------------------------------------------------------------
     提明細、製作、一校的「審」是一格一格的（cell.stage）；
     一校送出之後整個版位一起走（block.phase）：
       一改 → 二校 → 二改 → 蓋章確認 → 審稿 → 出稿
     蓋章確認之後是**整份 DM** 的事（主管照管理範圍、跨版位等齊；最終審核看整份），
     所以版位的 phase 由 plan 那一層一起推。

     每一輪審核在格子上各記一份，各自計算、互不沿用（5.1）：
       cell.r2   二校輪  { reviewed, hi, hiBy, steps:{3,2}, cycle, past }
       cell.r3   蓋章輪  { stamp, hi, hiBy, steps:{3,2,1}, cycle, past }（1＝處長）
       cell.fin  審稿    { cycle, past, stampN }
     hi＝已審最高層級（數字越小越高）。steps[L]＝{ how:'pass'|'skip', by, at, reason }。

     退件循環（第 6 節）三輪共用：cycle＝{ round, by, level, label, v, state, kind }
       state：judge 設計判斷 → pm_data PM 改資料 → fix 設計修改 → pm_confirm PM 確認／蓋章 N → rereview 退件的人重審
     ====================================================================== */

  const catById = (db, id) => db.assignments.find(a => a.category_id === id);
  /* 品類不在分類表上的格子（主程式那邊標「沒有負責人」）沒有代碼，名字只有格子自己帶著（cat_name） */
  const catName = (db, id, fb) => (catById(db, id) || {}).category_name || fb || id || '沒有負責人的品類';
  const cellById = (db, id) => db.cells.find(c => c.id === id);
  const blockById = (db, id) => db.blocks.find(b => b.id === id);
  const noteById = (db, id) => db.notes.find(n => n.id === id);
  const planById = (db, id) => db.plans.find(p => p.id === id);
  const blockOf = (db, c) => blockById(db, c.block_id);
  const blockCells = (db, b) => db.cells.filter(c => c.block_id === b.id);
  const planCells = (db, pid) => db.cells.filter(c => c.plan_id === pid);
  const planBlocks = (db, pid) => db.blocks.filter(b => b.plan_id === pid);
  const ownerOf = (db, c) => (catById(db, c.category_id) || {}).owner_id;
  const mgrOf = (db, c, L) => (catById(db, c.category_id) || {})[MGR_FIELD[L]];
  const cellLabel = (db, c) => `${catName(db, c.category_id, c.cat_name)} 第 ${c.idx} 格`;
  const designers = db => db.members.filter(m => m.role === 'design' && isActive(m)).map(m => m.employee_id);

  /* 這一輪的審核紀錄 */
  function roundOf(db, c) {
    const b = blockOf(db, c);
    if (!b) return null;
    if (b.phase === '二校') return c.r2 || null;
    if (b.phase === '蓋章確認') return c.r3 || null;
    if (b.phase === '審稿') return c.fin || null;
    return null;
  }
  const cycleOf = (db, c) => { const r = c && roundOf(db, c); return r ? r.cycle : null; };

  /* 版位已經過了一校，這一格還沒補完自己的一校 —— 審核開始後才加進來的格子（版面不鎖）。
     它自己走 提明細 → 製作 → 一校，一校由 PM 單獨按「補完一校」（review.late），之後才跟著版位走。
     在那之前它不能被標「改好了」、不能蓋章，版位也送不出一改、二改、二校 ——
     不然一格沒挑貨、沒做、沒人審過的東西會被整塊帶著走到出稿（2026-09-28 量到過）。
     一校完成的格子一定是 reviewed（block.review1 要每一格都審過），所以沒審過＝還沒補。 */
  function behind(db, c) {
    const b = blockOf(db, c);
    if (!b || !b.phase) return false;
    return c.stage === '提明細' || c.stage === '製作' || (c.stage === '一校' && !c.reviewed);
  }

  /* 一格現在屬於排程上的哪一關（7.1）。蓋章確認期間的退件屬於「蓋章修改」（7.1 第 4 點）。 */
  function stageOf(db, c) {
    const b = blockOf(db, c);
    /* 還沒補完一校的格子照它自己的算，不跟著版位 —— 不然一格空的也寫「一改」。
       還沒有負責人的格子也是停在這裡（送不進審核）。 */
    if (!b || !b.phase || behind(db, c)) return c.stage;
    if (b.phase === '蓋章確認' && c.r3 && c.r3.cycle) return '蓋章修改';
    return b.phase;
  }

  /* 他在這個分類本人算第幾層（身兼多層取最高）；不在這個分類回 null */
  function levelInCat(db, empId, categoryId) {
    const a = catById(db, categoryId);
    if (!a) return null;
    const ls = LEVEL_FIELD.filter(([f]) => a[f] === empId).map(([, l]) => l);
    return ls.length ? Math.min(...ls) : null;
  }
  /* 主管按通過，這一格算審到哪一層。身兼多層的人算他在這個分類最高的那一層（2.2）——
     公司的分類表上常常是這樣（洗衣機的課主管和部主管是同一個人），只記 L 的話
     同一個人要當課長按一次、再當部長按一次。職代不會走到這裡（主管那兩層沒有代理）。 */
  const mgrTop = (db, a, c, L) => Math.min(L, levelInCat(db, a.id, c.category_id) || L);
  const mgrHow = (L, top) => `${LEVEL_NAME[L]}審核通過${top < L ? `（身兼${LEVEL_NAME[top]}，算${LEVEL_NAME[top]}）` : ''}`;

  /* 圖片比對（4.2）：檔名去掉副檔名、用半形空格切開，有一段**完全相同**就算（大小寫視為不同）。 */
  function matchImages(sku, files) {
    return (files || []).filter(f => f.replace(/\.[^.]+$/, '').split(' ').includes(sku));
  }

  /* 做這件事的人。delegFor＝他現在正在代理的原 PM。 */
  function actorOf(db, id, now) {
    const m = db.members.find(x => x.employee_id === id);
    const delegFor = new Set(activeDelegations(db, now).filter(d => d.to_id === id).map(d => d.from_id));
    return { id, m, role: m ? m.role : '', name: m ? m.name : '', delegFor };
  }

  /* 他能不能以 ownerId 這位 PM 的身分做事：本人，或正在代理他。 */
  function pmAs(a, ownerId) {
    if (!ownerId) return null;
    if (a.id === ownerId) return { as: ownerId, acting: false };
    if (a.delegFor.has(ownerId)) return { as: ownerId, acting: true };
    return null;
  }
  const pmOfCell = (db, a, c) => pmAs(a, ownerOf(db, c));
  /* PM 那一層的人：原 PM ＋ 現在代理他的人（通知「PM／當前職代」用） */
  function pmPeople(db, ownerId, now) {
    return [ownerId, ...activeDelegations(db, now).filter(d => d.from_id === ownerId).map(d => d.to_id)];
  }
  /* 這個人以代理人身分做事時算 L4；本人算他在這個分類的最高層（5.2） */
  const levelForPm = (db, a, r, c) => (r.acting ? 4 : (levelInCat(db, a.id, c.category_id) || 4));

  /* 一個版位裡有哪幾位 PM：照格子的分類算（2.2） */
  function blockPms(db, blockId) {
    return [...new Set(db.cells.filter(c => c.block_id === blockId).map(c => ownerOf(db, c)).filter(Boolean))];
  }

  function detailMissing(c) {
    const miss = [];
    if (!c.detail) { miss.push('還沒挑商品'); return miss; }
    if (!String(c.detail.name || '').trim()) miss.push('品名空白');
    if (c.detail.price === '' || c.detail.price == null || !(+c.detail.price > 0)) miss.push('價格空白');
    return miss;
  }

  function review1Missing(db, blockId, ownerId) {
    const miss = [];
    for (const c of db.cells) {
      if (c.block_id !== blockId || ownerOf(db, c) !== ownerId) continue;
      if (c.stage === '提明細') miss.push(`${cellLabel(db, c)}還沒送出提明細`);
      else if (c.stage === '製作') miss.push(`${cellLabel(db, c)}還在製作`);
      else if (!c.reviewed) miss.push(`${cellLabel(db, c)}還沒按審核完成`);
    }
    return miss;
  }
  function review2Missing(db, blockId, ownerId) {
    return db.cells.filter(c => c.block_id === blockId && ownerOf(db, c) === ownerId && (behind(db, c) || !(c.r2 && c.r2.reviewed)))
      .map(c => `${cellLabel(db, c)}${behind(db, c) ? '還沒補完一校' : '還沒按審核完成'}`);
  }
  const openNotes = (db, blockId) => db.notes.filter(n => n.block_id === blockId && n.status === 'open');
  const openOn = (db, c, purposes, by) => db.notes.filter(n => n.cell_id === c.id && n.status === 'open'
    && (!purposes || purposes.includes(n.purpose)) && (!by || n.author === by));

  /* ---------- 二校：誰在等、輪到誰 ---------- */
  const r2PmAllDone = (db, b) => !!b.r2 && blockPms(db, b.id).every(id => b.r2.pm_done[id]);
  /* 部長要等這個版位每一格都過了課長那一關才開始。被部長退件、在循環裡的已經過過課長，不擋。 */
  function gate2(db, b) {
    return blockCells(db, b).every(c => c.r2 && (c.r2.steps[3] || (c.r2.cycle && c.r2.cycle.level === 2)));
  }
  function mgrPendingLevel(db, c) {
    const b = blockOf(db, c);
    if (!r2Managers(db)) return null;
    if (!b || b.phase !== '二校' || !r2PmAllDone(db, b) || !c.r2 || c.r2.cycle) return null;
    if (!c.r2.steps[3] && c.r2.hi > 3) return 3;
    if (!c.r2.steps[2] && c.r2.hi > 2 && gate2(db, b)) return 2;
    return null;
  }

  /* ---------- 蓋章輪：照管理範圍、跨版位等齊（4.8） ---------- */
  const scopeOf = (db, pid, L, mid) => planCells(db, pid).filter(c => mgrOf(db, c, L) === mid);
  /* 課長開始的條件：他管的格子都蓋了章，而且都不在退件循環裡（部長退回來的不算，那時候課長早就審完了） */
  function gate3r3(db, pid, mid) {
    return scopeOf(db, pid, 3, mid).every(c => c.r3 && c.r3.stamp && !(c.r3.cycle && c.r3.cycle.level >= 3));
  }
  /* 部長開始的條件：他管的格子都完成課長這一步 */
  function gate2r3(db, pid, mid) {
    return scopeOf(db, pid, 2, mid).every(c => c.r3 && (c.r3.steps[3] || (c.r3.cycle && c.r3.cycle.level === 2)));
  }
  /* 處長開始的條件：他管的格子都完成部長這一步（被處長自己退回去、在循環裡的已經過過部長，不擋） */
  function gate1r3(db, pid, mid) {
    return scopeOf(db, pid, 1, mid).every(c => c.r3 && (c.r3.steps[2] || (c.r3.cycle && c.r3.cycle.level === 1)));
  }
  const GATE_R3 = { 3: gate3r3, 2: gate2r3, 1: gate1r3 };
  function mgr3PendingLevel(db, c) {
    const b = blockOf(db, c);
    if (!b || b.phase !== '蓋章確認' || !c.r3 || !c.r3.stamp || c.r3.cycle) return null;
    if (!c.r3.steps[3] && c.r3.hi > 3 && gate3r3(db, c.plan_id, mgrOf(db, c, 3))) return 3;
    if (!c.r3.steps[2] && c.r3.hi > 2 && gate2r3(db, c.plan_id, mgrOf(db, c, 2))) return 2;
    if (!c.r3.steps[1] && c.r3.hi > 1 && gate1r3(db, c.plan_id, mgrOf(db, c, 1))) return 1;
    return null;
  }

  /* ---------- 審稿 ---------- */
  const finalOf = plan => plan.final || null;
  /* 現在輪到第幾關：第一個還沒「通過」的 */
  function currentSeat(plan) {
    const f = finalOf(plan);
    if (!f || !f.sent) return null;
    for (const k of [1, 2, 3]) if (!(f.seats[k] && f.seats[k].how === 'pass')) return k;
    return null;
  }

  const isMgrOf = (db, a, c) => mgrOf(db, c, 3) === a.id || mgrOf(db, c, 2) === a.id;

  /* ---------- 便利貼貼下去是什麼意思 ----------
     同一張黃紙，在不同時候是不同的事：
     一校／二校 PM 的＝要改的地方（帶到一改／二改）；主管、協理、律師的＝退件；
     蓋章前 PM 自己的＝要調整（退件，送回者是他自己）；退件循環裡的＝這一輪還要改什麼。 */
  function cyclePurpose(db, a, c, cy) {
    if (cy.state === 'rereview' && a.id === cy.by) return { ok: true, purpose: 'reject', level: cy.level };
    if ((cy.state === 'pm_confirm' || cy.state === 'pm_data') && pmOfCell(db, a, c)) return { ok: true, purpose: 'cycle' };
    if (cy.state !== 'rereview' && a.role === 'design') return { ok: true, purpose: 'cycle' };
    return no('這一格在退件循環裡，現在不是輪到你');
  }
  function notePurpose(db, a, c) {
    const b = blockOf(db, c);
    const ph = b.phase;
    const st = stageOf(db, c);
    /* 還沒補完一校的格子：它自己在一校，PM 貼的就是一校的意見（補完之後帶進版位現在那一關） */
    if (behind(db, c)) {
      if (st !== '一校') return no('一校才開始貼便利貼');
      if (!pmOfCell(db, a, c)) return forbid(`這一格是${ownerName(db, c)}負責的`);
      return { ok: true, purpose: '一校' };
    }
    if (!ph && st === '一校') {
      const r = pmOfCell(db, a, c);
      if (!r) return forbid(`這一格是${ownerName(db, c)}負責的`);
      if (b.pm_done[r.as]) return no('一校已經送出，不能再貼');
      return { ok: true, purpose: '一校' };
    }
    if (ph === '一改' || ph === '二改') {
      if (a.role !== 'design') return forbid(`${ph}的時候由設計新增便利貼`);
      return { ok: true, purpose: ph };
    }
    if (ph === '二校') {
      if (c.r2.cycle) return cyclePurpose(db, a, c, c.r2.cycle);
      const r = pmOfCell(db, a, c);
      if (r && !b.r2.pm_done[r.as]) return { ok: true, purpose: 'r2pm' };
      const L = mgrPendingLevel(db, c);
      if (L && mgrOf(db, c, L) === a.id) return { ok: true, purpose: 'reject', level: L };
      if (r) return no('二校已經送出，不能再貼');
      if (isMgrOf(db, a, c)) return no('還沒輪到你審這一格');
      return forbid('現在不是你審這一格');
    }
    if (ph === '蓋章確認') {
      if (c.r3.cycle) return cyclePurpose(db, a, c, c.r3.cycle);
      const r = pmOfCell(db, a, c);
      if (r && !c.r3.stamp) return { ok: true, purpose: 'reject', level: 4 };
      const L = mgr3PendingLevel(db, c);
      if (L && mgrOf(db, c, L) === a.id) return { ok: true, purpose: 'reject', level: L };
      if (r) return no('已經蓋章，不能再貼');
      if (isMgrOf(db, a, c)) return no('還沒輪到你審（你管的格子要全部蓋完章）');
      return forbid('現在不是你審這一格');
    }
    if (ph === '審稿') {
      if (c.fin.cycle) return cyclePurpose(db, a, c, c.fin.cycle);
      const plan = planById(db, c.plan_id);
      const k = currentSeat(plan);
      if (k && seatReviewer(db, k) === a.id && !(plan.final.seats[k] && plan.final.seats[k].how === 'waiting')) return { ok: true, purpose: 'reject', level: k };
      return no('現在不是你審稿');
    }
    return no(stageIx(st) < stageIx('一校') ? '一校才開始貼便利貼' : `${st}不能貼便利貼`);
  }

  /* 便利貼貼下去那一刻的「狀態」。狀態往前走了（送出、換關、退件換手），那張就不能再刪。 */
  function ctxKey(db, c) {
    const b = blockOf(db, c);
    const o = ownerOf(db, c);
    const r = roundOf(db, c);
    const plan = planById(db, c.plan_id);
    return [b.phase || c.stage, b.pm_done[o] ? 1 : 0, b.r2 && b.r2.pm_done[o] ? 1 : 0,
      r && r.cycle ? r.cycle.v + r.cycle.state : '', r && r.steps ? Object.keys(r.steps).join('') : '',
      c.r3 && c.r3.stamp ? 's' : '', plan && plan.final ? currentSeat(plan) + JSON.stringify(plan.final.seats || {}) : ''].join('|');
  }

  const ok = { ok: true };
  /* blocked＝時機不對或東西沒填（正常，不記紀錄）；forbidden＝沒有權限（記一筆被拒，8.3） */
  function no(reason, extra) { return Object.assign({ ok: false, kind: 'blocked', reason }, extra || {}); }
  function forbid(reason) { return { ok: false, kind: 'forbidden', reason }; }
  const ownerName = (db, c) => memberById(db, ownerOf(db, c)).name;

  function can(db, a, action, p) {
    p = p || {};
    if (!a.m) return forbid('找不到你的人員資料');
    let c, b, n, plan;
    const needCell = () => { c = cellById(db, p.cell_id); return c ? null : no('找不到這一格'); };
    const needBlock = () => { b = blockById(db, p.block_id); return b ? null : no('找不到這個版位'); };
    const needPlan = () => { plan = planById(db, p.plan_id); return plan ? null : no('找不到這份檔期'); };
    let e;
    /* 品類不在分類表上的格子沒有負責人：誰都送不動它（便利貼照樣貼得了，那是對話） */
    if (p.cell_id && !/^note\./.test(action)) {
      const cc = cellById(db, p.cell_id);
      if (cc && !catById(db, cc.category_id)) return no(`「${cc.cat_name || '這個品類'}」不在分類表上，這一格沒有負責人，送不進審核`);
    }
    switch (action) {
      /* ---------- 版面同步（主程式的版面 → 審核那一邊的版位和格子） ----------
         審核開始後版面照樣改得動（2026-09-28 談定不鎖），所以每改一次版面就同步一次。
         誰都可以送：改版面的人本來就不只一種（設計切、行銷切、PM 加減格）。
         ⚠️ 接上後端之後，骨架要由伺服器自己從 plans 那一列讀出來，不收瀏覽器送的 ——
         不然送一份假骨架就能把別人的格子收掉。 */
      case 'plan.sync': {
        const sk = p.skeleton;
        if (!sk || !sk.plan || !sk.plan.id || !Array.isArray(sk.blocks) || !Array.isArray(sk.cells)) return no('版面資料不完整');
        return ok;
      }
      /* ---------- 主程式：這一格挑了什麼貨（挑貨在版面那一邊做，這裡只收結果） ----------
         跟 detail.save 同一套權限（這一格的 PM／職代、還在提明細或退回改資料），
         差在商品資料是整份送來的：主程式的商品目錄還沒有推進審核這一邊。
         ⚠️ 接上後端之後要照 products 表核對一次（價格、品名以後台為準，4.1 第 2 點）。 */
      case 'detail.set': {
        if ((e = needCell())) return e;
        if (!pmOfCell(db, a, c)) return forbid(`這一格是${ownerName(db, c)}負責的`);
        const cy = cycleOf(db, c);
        if (!(c.stage === '提明細' || (cy && cy.state === 'pm_data'))) return no('提明細已經送出，不能再改');
        const d = p.detail;
        if (d !== null) {
          if (!d || typeof d !== 'object') return no('商品資料不完整');
          const sku = String(d.sku || '').trim();
          if (!sku) return no('還沒挑商品');
          if (/\s/.test(sku)) return no('商品編號不能有空格');
          const pr = db.products.find(x => x.sku === sku);
          const own = ownerOf(db, c);
          if (pr && pr.category_id !== c.category_id && ownerOf(db, { category_id: pr.category_id }) !== own) return no(`只能挑${ownerName(db, c)}負責分類的商品`);
        }
        return ok;
      }
      /* ---------- 提明細（以及商品問題退回 PM 改資料） ---------- */
      case 'detail.save':
      case 'gift.add':
      case 'gift.remove':
      case 'detail.submit':
      case 'cycle.dataDone': {
        if ((e = needCell())) return e;
        if (!pmOfCell(db, a, c)) return forbid(`這一格是${ownerName(db, c)}負責的`);
        const cy = cycleOf(db, c);
        const editable = c.stage === '提明細' || (cy && cy.state === 'pm_data');
        if (action === 'detail.submit' && c.stage !== '提明細') return no('提明細已經送出，不能再改');
        if (action === 'cycle.dataDone' && !(cy && cy.state === 'pm_data')) return no('現在不是改商品資料的時候');
        if (!editable) return no('提明細已經送出，不能再改');
        if (action === 'detail.save' && p.patch) {
          if (p.patch.sku) {
            const pr = db.products.find(x => x.sku === p.patch.sku);
            if (!pr || pr.category_id !== c.category_id) return no(`只能挑${catName(db, c.category_id)}的商品`);
          } else if (!c.detail && ['name', 'spec', 'price', 'info'].some(k => k in p.patch)) {
            return no('先挑商品，資料才會帶進來');
          }
        }
        if (action === 'gift.add') {
          const sku = String(p.sku || '').trim();
          if (!sku) return no('請輸入贈品的商品編號');
          if (/\s/.test(sku)) return no('商品編號不能有空格');
          if (!db.products.some(x => x.sku === sku)) return no(`找不到商品編號 ${sku}`);
          if (c.gifts.some(g => g.sku === sku)) return no('這個贈品已經加過了');
        }
        if (action === 'detail.submit' || action === 'cycle.dataDone') {
          const miss = detailMissing(c);
          if (miss.length) return no('還有東西沒填', { missing: miss });
        }
        return ok;
      }
      /* PM 的印章在提明細、蓋章確認也只是「標起來」（2026-09-29，使用者：蓋完就自己送出去不要）——
         標了還能取消，真的送出去是另外按「提明細完成／蓋章送出：標好的 N 格」（那兩下才是 detail.submit、stamp）。 */
      case 'detail.mark': {
        if ((e = needCell())) return e;
        if (!pmOfCell(db, a, c)) return forbid(`這一格是${ownerName(db, c)}負責的`);
        if (c.stage !== '提明細' || cycleOf(db, c)) return no('提明細已經送出');
        return ok;
      }
      case 'stamp.mark': {
        if ((e = needCell())) return e;
        if (!pmOfCell(db, a, c)) return forbid(`只有${ownerName(db, c)}或他的職代能蓋這一格`);
        if (behind(db, c)) return no('這一格是審核開始後才加的，還沒補完一校');
        if (blockOf(db, c).phase !== '蓋章確認' || !c.r3) return no('這一格還沒到蓋章確認');
        if (c.r3.cycle) return no('這一格在退件修改中');
        if (c.r3.stamp) return no('已經蓋過章');
        if (p.done && openOn(db, c, ['reject'], a.id).length) return no('你在這一格貼了要調整的便利貼：送出調整，或先刪掉便利貼再蓋章');
        return ok;
      }
      /* 設計的「標好了」「改好了」（2026-09-28，使用者要的）：跟 PM 一校的「審核完成」同一種做法 ——
         一格一格標、標了還能取消，真的送出去之前都不算數。 */
      case 'make.mark': {
        if ((e = needCell())) return e;
        if (a.role !== 'design') return forbid('製作由設計處理');
        if (c.stage === '提明細') return no(`${ownerName(db, c)}還沒送出提明細`);
        if (c.stage !== '製作') return no('製作已經送出');
        return ok;
      }
      case 'fix.mark': {
        if ((e = needCell())) return e;
        if (a.role !== 'design') return forbid('一改、二改由設計處理');
        const ph = (blockOf(db, c) || {}).phase;
        if (ph !== '一改' && ph !== '二改') return no('這一格不在一改或二改');
        if (behind(db, c)) return no('這一格是審核開始後才加的，還沒補完一校');
        return ok;
      }
      case 'make.submit': {
        if ((e = needCell())) return e;
        if (a.role !== 'design') return forbid('製作由設計處理');
        if (c.stage === '提明細') return no(`${ownerName(db, c)}還沒送出提明細`);
        if (c.stage !== '製作') return no('製作已經送出');
        return ok;
      }
      case 'review.mark': {
        if ((e = needCell())) return e;
        const r = pmOfCell(db, a, c);
        if (!r) return forbid(`這一格是${ownerName(db, c)}負責的`);
        const st = stageOf(db, c);
        if (stageIx(st) < stageIx('一校')) return no('這一格還沒進一校');
        if (behind(db, c)) return no('版位已經過了一校：這一格按「補完一校」');
        if (st !== '一校' || blockOf(db, c).pm_done[r.as]) return no('一校已經送出，不能再改');
        return ok;
      }
      /* 審核開始後才加的格子，自己補完一校（版位不退回一校，review-test-later 那一條）。
         沒有「標了再送」那兩步：版位的一校早就送出了，這一格看過就是看過。 */
      case 'review.late': {
        if ((e = needCell())) return e;
        if (!pmOfCell(db, a, c)) return forbid(`這一格是${ownerName(db, c)}負責的`);
        if (!behind(db, c)) return no('這一格不用補一校');
        if (c.stage !== '一校') return no(c.stage === '提明細' ? '這一格還沒送出提明細' : '這一格還在製作');
        return ok;
      }
      case 'r2.mark': {
        if ((e = needCell())) return e;
        const r = pmOfCell(db, a, c);
        if (!r) return forbid(`這一格是${ownerName(db, c)}負責的`);
        if (behind(db, c)) return no('這一格是審核開始後才加的，還沒補完一校');
        const ph = blockOf(db, c).phase;
        if (ph !== '二校') return no(stageIx(stageOf(db, c)) < stageIx('二校') ? '這一格還沒進二校' : '二校已經送出');
        if (blockOf(db, c).r2.pm_done[r.as]) return no('二校已經送出，不能再改');
        return ok;
      }
      /* ---------- 便利貼 ---------- */
      case 'note.add': {
        if ((e = needCell())) return e;
        if (!NOTE_KINDS.includes(p.kind)) return no('便利貼的種類不對');
        const np = notePurpose(db, a, c);
        if (!np.ok) return np;
        if (!String(p.text || '').trim()) return no('請寫要改什麼');
        return ok;
      }
      case 'note.reply': {
        n = noteById(db, p.note_id);
        if (!n) return no('找不到這張便利貼');
        c = cellById(db, n.cell_id);
        const cy = cycleOf(db, c);
        if (a.role !== 'design' && !pmOfCell(db, a, c) && !isMgrOf(db, a, c) && !(cy && cy.by === a.id) && n.author !== a.id) {
          return forbid('只有這一格的 PM、主管、退件的人和設計能回覆');
        }
        if (!String(p.text || '').trim()) return no('請寫回覆的內容');
        return ok;
      }
      case 'note.resolve': {
        n = noteById(db, p.note_id);
        if (!n) return no('找不到這張便利貼');
        if (a.role !== 'design') return forbid('便利貼由設計標成已處理');
        c = cellById(db, n.cell_id);
        const ph = blockOf(db, c).phase, cy = cycleOf(db, c);
        if (ph === '一改' || ph === '二改') return ok;
        if (cy && cy.state === 'fix') return ok;
        return no('一改、二改或退件修改的時候才能標已處理');
      }
      case 'note.delete': {
        n = noteById(db, p.note_id);
        if (!n) return no('找不到這張便利貼');
        if (n.author !== a.id) return forbid('只能刪自己貼的便利貼');
        if (n.status !== 'open') return no('已經處理的便利貼不能刪');
        if (n.ctx !== ctxKey(db, cellById(db, n.cell_id))) return no('貼上之後已經送出，不能刪');
        return ok;
      }
      /* ---------- 一校、二校、一改、二改（版位） ---------- */
      case 'block.review1': {
        if ((e = needBlock())) return e;
        const r = pmAs(a, p.as_pm);
        if (!r) return forbid('你不是這位 PM，也沒有代理他');
        if (!blockPms(db, b.id).includes(p.as_pm)) return no('這個版位沒有你負責的格子');
        if (b.phase) return no('這個版位的一校已經送出');
        if (b.pm_done[p.as_pm]) return no('已經按過一校完成');
        const miss = review1Missing(db, b.id, p.as_pm);
        if (miss.length) return no('還有格子沒審完', { missing: miss });
        return ok;
      }
      case 'block.r2pm': {
        if ((e = needBlock())) return e;
        const r = pmAs(a, p.as_pm);
        if (!r) return forbid('你不是這位 PM，也沒有代理他');
        if (!blockPms(db, b.id).includes(p.as_pm)) return no('這個版位沒有你負責的格子');
        if (b.phase !== '二校') return no(stageIx(b.phase) < stageIx('二校') ? '這個版位還沒進二校' : '二校已經送出');
        if (b.r2.pm_done[p.as_pm]) return no('已經按過二校完成');
        const miss = review2Missing(db, b.id, p.as_pm);
        if (miss.length) return no('還有格子沒審完', { missing: miss });
        return ok;
      }
      case 'mgr.submit': {
        if ((e = needBlock())) return e;
        if (!r2Managers(db)) return no('二校不需要主管審核（設定表上「二校主管審核」是關的），部長只看進度');
        const L = +p.level;
        if (!R2_LEVELS.includes(L)) return no('層級不對');
        const scope = blockCells(db, b).filter(x => mgrOf(db, x, L) === a.id);
        if (!scope.length) return forbid(`你不是這個版位的${LEVEL_NAME[L]}`);
        if (b.phase !== '二校') return no('這個版位不在二校');
        if (!scope.some(x => mgrPendingLevel(db, x) === L)) return no('現在沒有等你審的格子');
        return ok;
      }
      case 'block.masthead':
      case 'block.fix1':
      case 'block.mh2':
      case 'block.fix2': {
        if ((e = needBlock())) return e;
        const ph = action === 'block.masthead' || action === 'block.fix1' ? '一改' : '二改';
        if (a.role !== 'design') return forbid(`${ph}由設計處理`);
        if (b.phase !== ph) return no(stageIx(b.phase) > stageIx(ph) ? `${ph}已經送出` : `這個版位還沒進${ph}`);
        if (action === 'block.fix1' || action === 'block.fix2') {
          const miss = [];
          const open = openNotes(db, b.id).length;
          if (open) miss.push(`${open} 張便利貼還沒處理`);
          if (ph === '一改' && !b.masthead_ok) miss.push('刊頭還沒確認');
          if (ph === '二改' && !b.mh2_ok) miss.push('刊頭與整體版面還沒確認');
          /* 每一格都要標「改好了」（連一校 OK、沒有便利貼的也要 —— 不然那幾格設計根本沒看過） */
          const late = blockCells(db, b).filter(x => behind(db, x)).length;
          if (late) miss.push(`${late} 格是審核開始後才加的，還沒補完一校`);
          const un = blockCells(db, b).filter(x => !behind(db, x) && !(x.fixMark && x.fixMark[ph])).length;
          if (un) miss.push(`${un} 格還沒標「改好了」`);
          if (miss.length) return no('還不能送出', { missing: miss });
        }
        return ok;
      }
      /* ---------- 蓋章確認 ---------- */
      case 'stamp':
      case 'stamp.reject': {
        if ((e = needCell())) return e;
        if (!pmOfCell(db, a, c)) return forbid(`只有${ownerName(db, c)}或他的職代能蓋這一格`);
        if (behind(db, c)) return no('這一格是審核開始後才加的，還沒補完一校');
        if (blockOf(db, c).phase !== '蓋章確認' || !c.r3) return no('這一格還沒到蓋章確認');
        if (c.r3.cycle) return no('這一格在退件修改中');
        if (c.r3.stamp) return no('已經蓋過章');
        const mine = openOn(db, c, ['reject'], a.id).length;
        if (action === 'stamp' && mine) return no('你在這一格貼了要調整的便利貼：送出調整，或先刪掉便利貼再蓋章');
        if (action === 'stamp.reject' && !mine) return no('先貼一張便利貼，寫要調整什麼');
        return ok;
      }
      case 'mgr3.submit': {
        if ((e = needPlan())) return e;
        const L = +p.level;
        if (!R3_LEVELS.includes(L)) return no('層級不對');
        const scope = scopeOf(db, plan.id, L, a.id);
        if (!scope.length) return forbid(`你不是這份檔期的${LEVEL_NAME[L]}`);
        if (!scope.some(x => mgr3PendingLevel(db, x) === L)) {
          if (L === 3 && !gate3r3(db, plan.id, a.id)) return no('你管的格子還沒全部蓋完章（或有格子在退件修改中）');
          if (L === 2 && !gate2r3(db, plan.id, a.id)) return no('你管的格子還沒全部過課長這一關');
          if (L === 1 && !gate1r3(db, plan.id, a.id)) return no('你管的格子還沒全部過部長這一關');
          return no('現在沒有等你審的格子');
        }
        return ok;
      }
      /* ---------- 審稿、出稿 ---------- */
      case 'final.send': {
        if ((e = needPlan())) return e;
        if (a.role !== 'mkt') return forbid('最終審核由行銷送出');
        const f = finalOf(plan);
        if (!f) return no('商品部還沒確認完成');
        if (f.sent) return no('已經送出最終審核');
        const miss = settingsMissing(db);
        if (miss.length) return no('最終審核者設定表還沒填完', { missing: miss });
        return ok;
      }
      case 'final.submit': {
        if ((e = needPlan())) return e;
        const k = currentSeat(plan);
        if (!k) return no(finalOf(plan) && finalOf(plan).sent ? '最終審核已經全部通過' : '還沒送最終審核');
        if (seatReviewer(db, k) !== a.id) return forbid(`現在輪到${SEAT_LABEL[k]} ${memberById(db, seatReviewer(db, k)).name}`);
        if (plan.final.seats[k] && plan.final.seats[k].how === 'waiting') return no('你退件的格子還在修改，改好會送回給你重審');
        return ok;
      }
      case 'publish': {
        if ((e = needPlan())) return e;
        if (a.role !== 'design') return forbid('出稿由設計處理');
        if (plan.published) return no('已經出稿');
        const bs = planBlocks(db, plan.id);
        if (!bs.length || !bs.every(x => x.phase === '出稿')) return no('律師還沒審核通過');
        return ok;
      }
      /* ---------- 退件循環（三輪共用） ---------- */
      case 'cycle.judge':
      case 'cycle.fixDone': {
        if ((e = needCell())) return e;
        const cy = cycleOf(db, c);
        if (!cy) return no('這一格沒有在退件');
        if (a.role !== 'design') return forbid('退件由設計判斷、修改');
        if (action === 'cycle.judge') {
          if (cy.state !== 'judge') return no('已經判斷過了');
          if (!PROBLEM_KINDS.includes(p.kind)) return no('問題種類不對');
        } else {
          if (cy.state !== 'fix') return no(cy.state === 'judge' ? '先判斷是哪一種問題' : cy.state === 'pm_data' ? 'PM 還在改商品資料' : '修改已經送出');
          const open = openOn(db, c, ['reject', 'cycle']).length;
          if (open) return no('還不能送出', { missing: [`${open} 張退件便利貼還沒標成已處理`] });
        }
        return ok;
      }
      case 'cycle.confirm':
      case 'cycle.back': {
        if ((e = needCell())) return e;
        const cy = cycleOf(db, c);
        if (!cy) return no('這一格沒有在退件');
        if (!pmOfCell(db, a, c)) return forbid(`這一格是${ownerName(db, c)}負責的`);
        if (cy.state !== 'pm_confirm') return no('還沒輪到 PM 確認');
        if (action === 'cycle.back' && !openOn(db, c, ['cycle'], a.id).length) return no('先貼一張便利貼，寫還要改什麼');
        return ok;
      }
      case 'cycle.pass':
      case 'cycle.reject': {
        if ((e = needCell())) return e;
        const cy = cycleOf(db, c);
        if (!cy) return no('這一格沒有在退件');
        if (a.id !== cy.by) return forbid(`只有退件的${memberById(db, cy.by).name}能重審`);
        if (cy.state !== 'rereview') return no('還沒送回來');
        if (action === 'cycle.reject' && !openOn(db, c, ['reject'], a.id).length) return no('先貼一張便利貼，寫要改什麼');
        return ok;
      }
      /* ---------- 設定表、職代 ---------- */
      case 'settings.save': {
        if (a.role !== 'mkt') return forbid('最終審核者設定表由行銷維護');
        const pt = p.patch || {};
        for (const k of ['exec_id', 'mkt_exec_id', 'lawyer_id', 'design_lead_id']) {
          if (!(k in pt) || !pt[k]) continue;
          const m = db.members.find(x => x.employee_id === pt[k]);
          if (!m) return no(`員工編號 ${pt[k]} 不在人員資料裡`);
          if (!isActive(m)) return no(`${m.name}已離職`);
        }
        return ok;
      }
      case 'deleg.add': {
        const from = p.from_id, to = p.to_id;
        const owns = db.assignments.some(x => x.owner_id === from);
        if (!owns) return no('只有商品主辦（PM）可以被代理');
        const boss = db.assignments.some(x => x.owner_id === from && (x.manager_id === a.id || x.director_id === a.id || x.executive_id === a.id));
        if (a.id !== from && !boss) return forbid('只有 PM 自己或他的上層主管能指定職代');
        const tm = db.members.find(x => x.employee_id === to);
        if (!tm || !isActive(tm)) return no('職代要是在職的人');
        if (to === from) return no('不能指定自己當自己的職代');
        if (!(t(p.end) > t(p.start))) return no('結束時間要晚於開始時間');
        return ok;
      }
      case 'deleg.cancel': {
        const d = (db.delegations || []).find(x => x.id === p.id);
        if (!d) return no('找不到這一筆代理');
        if (d.cancelled_at) return no('已經取消了');
        const boss = db.assignments.some(x => x.owner_id === d.from_id && (x.manager_id === a.id || x.director_id === a.id || x.executive_id === a.id));
        if (a.id !== d.from_id && a.id !== d.assigned_by && !boss) return forbid('只有 PM 自己、指定的人或上層主管能取消');
        return ok;
      }
      default:
        return forbid(`不認得的動作：${action}`);
    }
  }

  let seq = 0;
  const uid = (pfx, now) => pfx + now.toString(36) + (++seq).toString(36) + Math.random().toString(36).slice(2, 5);

  /* 8.5：Who、When、What、Target、Result 五欄一定要有。 */
  function pushAudit(db, row, now) {
    db.audit = db.audit || [];
    db.audit.push({
      id: uid('a', now),
      at: new Date(now).toISOString(),
      who: row.who || null,
      who_name: row.who_name || '',
      email: row.email || '',
      what: row.what,
      target: row.target || '',
      result: row.result,
      detail: row.detail || '',
    });
    if (db.audit.length > 3000) db.audit.splice(0, db.audit.length - 3000);
  }
  const logAs = (db, a, now, row) => pushAudit(db, Object.assign({ who: a.id, who_name: a.name, email: a.m ? a.m.email : '', result: '成功' }, row), now);
  const logSys = (db, now, row) => pushAudit(db, Object.assign({ who: null, who_name: '系統', result: '成功' }, row), now);

  /* 站內通知（7.5）。接上 Supabase 之後同一份寫進 notifications 表，另外寄信或推播。 */
  function notify(db, to, text, link, now, kind) {
    db.notifications = db.notifications || [];
    for (const id of [...new Set((to || []).filter(Boolean))]) {
      db.notifications.push({ id: uid('m', now), to: id, at: new Date(now).toISOString(), text, link: link || '', kind: kind || '', read: false });
    }
    if (db.notifications.length > 2000) db.notifications.splice(0, db.notifications.length - 2000);
  }
  const cellLink = c => `#/plan/${c.plan_id}/${c.id}`;

  /* 這一格一路上誰做了什麼（畫面上的「審核經過」）。跟稽核紀錄分開：這一份是給人看這一格的故事。 */
  function hist(c, now, who, name, what, detail) {
    (c.hist = c.hist || []).push({ at: new Date(now).toISOString(), who: who || null, name: name || '系統', what, detail: detail || '' });
  }

  function updateDraft(db, c, now) {
    if (!c.detail) return;
    const sku = c.detail.sku;
    const old = db.traces[sku] || { draft: null, official: null };
    db.traces[sku] = {
      official: old.official,
      draft: {
        v: (old.draft ? old.draft.v : 0) + 1,
        at: new Date(now).toISOString(),
        plan_id: c.plan_id, cell_id: c.id,
        detail: Object.assign({}, c.detail), gifts: c.gifts.map(g => Object.assign({}, g)),
        images: matchImages(sku, db.imageFiles),
      },
    };
  }

  /* ---------- 各輪的「往前推」 ---------- */

  function enterR2(db, b) {
    b.phase = '二校';
    b.r2 = { pm_done: {}, skipLogged: {}, notified: {} };
    for (const c of blockCells(db, b)) {
      c.version = c.version || 1;
      c.r2 = { reviewed: false, hi: null, hiBy: null, steps: {}, cycle: null, past: [] };
    }
  }

  function skipReason(r) { return `已審到${LEVEL_NAME[r.hi]}（${r.hiBy ? r.hiBy.name + r.hiBy.how : ''}）`; }

  /* 二校往前推：該略過的略過（寫原因）、輪到誰就通知誰，部長那一關都好了 → 版位進二改。 */
  /* 二校送出，版位進二改。二校的便利貼（PM 的、開關開著時主管的）還沒處理的都帶進去。 */
  function r2Done(db, b, cells, now, why) {
    b.phase = '二改';
    b.r2.done_at = new Date(now).toISOString();
    for (const c of cells) {
      c.fix2 = db.notes.some(n => n.cell_id === c.id && n.status === 'open');
      hist(c, now, null, '系統', '二校通過，版位進入二改');
    }
    logSys(db, now, { what: '二校完成（版位送出）', target: `版位 ${b.name}`, detail: why });
    notify(db, designers(db), `${b.name} 版位二校通過，進入二改`, `#/plan/${b.plan_id}/${b.id}`, now, 'turn');
  }

  function advance(db, b, now) {
    if (b.phase !== '二校' || !r2PmAllDone(db, b)) return;
    const cells = blockCells(db, b);
    /* 還沒補完一校的格子（沒有二校的紀錄）：主管照樣審其他格，但版位等它 —— 它補完之後
       PM 那一層要再按一次二校完成（review.late 會把那位 PM 的完成收回），會再推一次 */
    const live = cells.filter(c => c.r2 && !behind(db, c));
    const late = live.length < cells.length;
    if (!r2Managers(db)) return late ? undefined : r2Done(db, b, cells, now, '每位 PM 都按了二校完成（二校不需要主管審核）');
    b.r2.notified = b.r2.notified || {};
    const layer = L => {
      for (const c of live) {
        const r = c.r2;
        if (r.cycle || r.steps[L] || r.hi > L) continue;
        const reason = skipReason(r);
        r.steps[L] = { how: 'skip', at: new Date(now).toISOString(), reason };
        hist(c, now, null, '系統', `${LEVEL_NAME[L]}自動略過`, reason);
        logSys(db, now, { what: '自動略過', target: `格 ${cellLabel(db, c)}`, detail: `二校輪 ${LEVEL_NAME[L]}：${reason}` });
      }
      for (const mid of [...new Set(live.map(c => mgrOf(db, c, L)))]) {
        const mine = live.filter(c => mgrOf(db, c, L) === mid);
        const k = `${L}:${mid}`;
        if (!b.r2.skipLogged[k] && mine.every(c => c.r2.steps[L] && c.r2.steps[L].how === 'skip')) {
          b.r2.skipLogged[k] = true;
          logSys(db, now, { what: '主管整層略過', target: `版位 ${b.name}`, detail: `${memberById(db, mid).name}（${LEVEL_NAME[L]}）管的 ${mine.length} 格都已審到更高層` });
        }
        const pend = mine.filter(c => mgrPendingLevel(db, c) === L);
        if (pend.length && !b.r2.notified[k]) {
          b.r2.notified[k] = true;
          notify(db, [mid], `輪到你二校審核：${b.name} 版位 ${pend.length} 格`, `#/plan/${b.plan_id}/${b.id}`, now, 'turn');
        }
      }
    };
    layer(3);
    if (gate2(db, b)) layer(2);
    if (!late && cells.every(c => !c.r2.cycle && c.r2.steps[2])) r2Done(db, b, cells, now, '部長那一關都通過或略過，進入二改');
  }

  function enterR3(db, b) {
    b.phase = '蓋章確認';
    for (const c of blockCells(db, b)) c.r3 = { stamp: null, hi: null, hiBy: null, steps: {}, cycle: null, past: [] };
  }

  /* 蓋章輪往前推（整份 DM）：照每一位主管的管理範圍判斷等齊了沒、該略過的略過、輪到就通知；
     每一格都過了處長那一關、沒有格子在退件 → 商品部確認完成，通知行銷（4.9）。 */
  function advance3(db, planId, now) {
    const plan = planById(db, planId);
    plan.flags = plan.flags || {};
    const cells = planCells(db, planId).filter(c => c.r3 && blockOf(db, c).phase === '蓋章確認');
    if (!cells.length) return;
    for (const L of R3_LEVELS) {
      for (const mid of [...new Set(cells.map(c => mgrOf(db, c, L)))]) {
        const gate = GATE_R3[L](db, planId, mid);
        if (!gate) continue;
        const mine = scopeOf(db, planId, L, mid);
        for (const c of mine) {
          const r = c.r3;
          if (r.cycle || r.steps[L] || r.hi > L) continue;
          const reason = skipReason(r);
          r.steps[L] = { how: 'skip', at: new Date(now).toISOString(), reason };
          hist(c, now, null, '系統', `蓋章輪 ${LEVEL_NAME[L]}自動略過`, reason);
          logSys(db, now, { what: '自動略過', target: `格 ${cellLabel(db, c)}`, detail: `蓋章輪 ${LEVEL_NAME[L]}：${reason}` });
        }
        const k = `r3:${L}:${mid}`;
        if (!plan.flags[k + ':skip'] && mine.every(c => c.r3.steps[L] && c.r3.steps[L].how === 'skip')) {
          plan.flags[k + ':skip'] = true;
          logSys(db, now, { what: '主管整層略過', target: `檔期 ${plan.name}`, detail: `蓋章輪：${memberById(db, mid).name}（${LEVEL_NAME[L]}）管的 ${mine.length} 格都已審到更高層` });
        }
        const pend = mine.filter(c => mgr3PendingLevel(db, c) === L);
        if (pend.length && !plan.flags[k]) {
          plan.flags[k] = true;
          notify(db, [mid], `輪到你蓋章輪審核：${plan.name} ${pend.length} 格`, `#/plan/${planId}`, now, 'turn');
        }
      }
    }
    const all = planCells(db, planId);
    if (!plan.final && all.every(c => c.r3 && !c.r3.cycle && c.r3.steps[1])) {
      plan.final = { confirmed_at: new Date(now).toISOString(), sent: null, seats: {} };
      logSys(db, now, { what: '商品部確認完成', target: `檔期 ${plan.name}`, detail: '每一格都過了處長這一關，沒有格子在退件' });
      notify(db, [plan.created_by], `${plan.name}：商品部確認完成，可以送最終審核了`, `#/plan/${planId}`, now, 'turn');
    }
  }

  /* 審稿往前推：退件的人把他退的格子都重審通過了，他這一關就算通過；三關都通過 → 出稿。 */
  function advanceFinal(db, planId, now) {
    const plan = planById(db, planId);
    const f = finalOf(plan);
    if (!f || !f.sent) return;
    plan.flags = plan.flags || {};
    for (;;) {
      const k = currentSeat(plan);
      if (!k) break;
      const s = f.seats[k];
      const open = planCells(db, planId).some(c => c.fin && c.fin.cycle && c.fin.cycle.level === k);
      if (s && s.how === 'waiting' && !open) { s.how = 'pass'; s.after = 'rereview'; continue; }
      if (!plan.flags['seat:' + k]) {
        plan.flags['seat:' + k] = true;
        notify(db, [seatReviewer(db, k)], `輪到你審稿（${SEAT_LABEL[k]}）：${plan.name}`, `#/plan/${planId}`, now, 'turn');
      }
      break;
    }
    if (!currentSeat(plan) && !f.done_at) {
      f.done_at = new Date(now).toISOString();
      for (const b of planBlocks(db, planId)) b.phase = '出稿';
      logSys(db, now, { what: '最終審核全部通過', target: `檔期 ${plan.name}`, detail: '商品處協理、行銷處協理、律師都通過，進入出稿' });
      notify(db, designers(db), `${plan.name}：最終審核通過，可以出稿`, `#/plan/${planId}`, now, 'turn');
    }
  }

  /* ---------- 真的改資料 ---------- */
  /* 版面 → 審核狀態。對法是 id（主程式送來的已經是「檔期／版位」「檔期／格子」）：
     ・新的格子從提明細開始；新的版位從頭開始
     ・不見的格子、版位**收起來不刪**（db.archive）—— 同一個 id 回來（合併拆開、只有刊頭切回來）接回原本的進度
     ・格子搬到別的版位（兩塊對調內容）：進度跟著格子走
     ・品類換了：負責的人跟著換，已經走過的關不重來
     回傳 null＝什麼都沒變（不記紀錄，版面一天改幾百次）。
     還沒測的情況列在根目錄的 review-test-later.md。 */
  function syncPlan(db, sk, now) {
    now = now || Date.now();           // hist／notify 要一個真的時間（new Date(undefined) 會丟例外）
    db.archive = db.archive || { blocks: [], cells: [] };
    const A = db.archive;
    let plan = planById(db, sk.plan.id);
    const created = !plan;
    if (!plan) { plan = { id: sk.plan.id, created_by: sk.plan.created_by || null }; db.plans.push(plan); }
    const before = JSON.stringify([plan.name, plan.type, plan.schedule]);
    plan.name = sk.plan.name || plan.name || '';
    plan.type = sk.plan.type || plan.type || '';
    if (Array.isArray(sk.plan.schedule)) plan.schedule = sk.plan.schedule;
    if (!plan.created_by && sk.plan.created_by) plan.created_by = sk.plan.created_by;
    const n = { add: 0, back: 0, gone: 0, moved: 0, recat: 0, blocks: 0, notes: 0, carry: 0 };
    const handover = [];               // 換了負責人的格子：[格子, 原本的 PM, 現在的 PM]
    const take = (arr, id) => { const i = arr.findIndex(x => x.id === id); return i < 0 ? null : arr.splice(i, 1)[0]; };

    const wantB = new Set(sk.blocks.map(x => x.id));
    for (const x of sk.blocks) {
      let b = blockById(db, x.id);
      if (!b) {
        b = take(A.blocks, x.id) || { id: x.id, plan_id: plan.id, phase: null, pm_done: {}, masthead_ok: false };
        db.blocks.push(b); n.blocks++;
      }
      b.name = x.name; b.order = x.ord;
    }
    for (const b of planBlocks(db, plan.id)) if (!wantB.has(b.id)) { take(db.blocks, b.id); A.blocks.push(b); n.blocks++; }

    const wantC = new Set(sk.cells.map(x => x.id));
    for (const x of sk.cells) {
      let c = cellById(db, x.id);
      if (!c) {
        c = take(A.cells, x.id);
        if (c) n.back++;
        else {
          c = { id: x.id, plan_id: plan.id, block_id: x.block_id, category_id: x.category_id, idx: x.idx,
                stage: '提明細', detail: null, note_text: '', gifts: [], reviewed: false, fix: false, submitted: null, made: null };
          n.add++;
        }
        db.cells.push(c);
      }
      if (c.block_id !== x.block_id) { c.block_id = x.block_id; n.moved++; }
      if ((c.category_id || null) !== (x.category_id || null)) {
        const was = ownerOf(db, c);
        c.category_id = x.category_id || null; n.recat++;
        const to = ownerOf(db, c);
        if (was && to && was !== to) handover.push([c, was, to]);
      }
      c.cat_name = x.cat_name || '';
      c.idx = x.idx;
    }
    for (const c of planCells(db, plan.id)) if (!wantC.has(c.id)) { take(db.cells, c.id); A.cells.push(c); n.gone++; }

    /* 合併：被吃掉的那一格正在退件的話，退件不能就這樣消失（review-test-later 那一條）——
       留下來那一格接著退（版面不鎖，所以是接過去，不是擋住合併）。還沒處理的便利貼
       主程式在合併那一下已經搬到留下來那一格了（退件要照便利貼改）。
       留下來那一格自己也在退件的話就不接：一格只有一個循環，搬過去的便利貼照樣要處理。 */
    for (const x of sk.cells) {
      const c = cellById(db, x.id);
      if (!c || !Array.isArray(x.absorbed)) continue;
      for (const vid of x.absorbed) {
        const v = A.cells.find(z => z.id === vid);
        if (!v) continue;
        for (const k of ['r2', 'r3', 'fin']) {
          if (!(v[k] && v[k].cycle) || !c[k] || c[k].cycle) continue;
          c[k].cycle = v[k].cycle;
          c.version = Math.max(c.version || 1, v.version || 1);
          v[k].cycle = null;
          hist(c, now, null, '系統', '合併：接過被併掉那一格的退件', `${cellLabel(db, v)}，第 ${c[k].cycle.v} 版`);
          n.carry++;
        }
      }
    }

    /* 換了負責人（品類改名成表上另一個分類）：已經審過的不重來，但兩邊都要知道 ——
       新的人不知道就不會去看，原本的人不知道會以為還是他的。 */
    if (handover.length) {
      const by = {};
      for (const [c, was, to] of handover) {
        (c.owner_changes = c.owner_changes || []).push({ from: was, to, at: new Date(now || Date.now()).toISOString() });
        hist(c, now, null, '系統', '負責的人換了', `${memberById(db, was).name} → ${memberById(db, to).name}`);
        const k = was + '>' + to;
        (by[k] = by[k] || { was, to, cells: [] }).cells.push(c);
      }
      for (const k in by) {
        const { was, to, cells } = by[k];
        const cat = catName(db, cells[0].category_id, cells[0].cat_name);
        const link = cells.length === 1 ? cellLink(cells[0]) : `#/plan/${plan.id}/${cells[0].block_id}`;
        notify(db, [to], `${plan.name}：${cat} ${cells.length} 格換給你負責（原本是${memberById(db, was).name}），已經審過的不重來`, link, now, 'turn');
        notify(db, [was], `${plan.name}：${cat} ${cells.length} 格改由${memberById(db, to).name}負責`, link, now, 'info');
      }
    }

    /* 便利貼：主程式那一份照舊是正本（貼、改字、打勾「處理了」都在那邊做），這裡收一份影本，
       規則要數的（一改送出前每一張都處理了、蓋章前自己貼的調整）才數得到。
       **這一張在流程裡算什麼**（一校的意見、蓋章前的調整、只是聊天）在它第一次同步過來那一刻決定，
       跟直接 note.add 同一支 notePurpose —— 之後只跟著改字、改種類、改處理了沒。
       貼的人當時不能貼（例如還沒輪到他）就算聊天（chat）：話照樣留著，只是不擋任何人。
       ⚠️ 接上後端之後便利貼要搬到後端（見 CLAUDE.md 審核系統第五步），這一段就不用了。 */
    if (Array.isArray(sk.notes)) {
      const iso = new Date(now || Date.now()).toISOString();
      const wantN = new Set(sk.notes.map(x => x.id));
      for (const x of sk.notes) {
        const c = cellById(db, x.cell_id);
        if (!c) continue;
        let nt = noteById(db, x.id);
        if (!nt) {
          const m = db.members.find(mm => mm.employee_id === x.author);
          let np = null;
          if (m) { try { np = notePurpose(db, actorOf(db, x.author, now || Date.now()), c); } catch (e) { np = null; } }
          nt = { id: x.id, plan_id: plan.id, block_id: c.block_id, cell_id: c.id,
                 author: x.author || null, author_name: m ? m.name : '', author_role: m ? m.role : '',
                 kind: x.kind || '留言', text: '', stage: stageOf(db, c),
                 purpose: np && np.ok ? np.purpose : 'chat', level: np && np.ok ? (np.level || null) : null,
                 ctx: ctxKey(db, c), status: 'open', created_at: x.at || iso, replies: [], resolved_by: null, resolved_at: null, mirror: true };
          db.notes.push(nt);
          n.notes++;
        }
        if (nt.text !== (x.text || '') || nt.kind !== (x.kind || nt.kind)) { nt.text = x.text || ''; nt.kind = x.kind || nt.kind; n.notes++; }
        /* 便利貼跟著格子搬家（合併時被併掉那一格的退件便利貼搬到留下來那一格） */
        if (nt.cell_id !== c.id) { nt.cell_id = c.id; nt.block_id = c.block_id; n.notes++; }
        const st = x.done ? 'resolved' : 'open';
        if (nt.status !== st) { nt.status = st; nt.resolved_at = x.done ? iso : null; n.notes++; }
      }
      const drop = db.notes.filter(nt => nt.mirror && nt.plan_id === plan.id && !wantN.has(nt.id));
      if (drop.length) { db.notes = db.notes.filter(nt => !drop.includes(nt)); n.notes += drop.length; }
    }

    const changed = created || n.add || n.back || n.gone || n.moved || n.recat || n.blocks || n.carry
                 || before !== JSON.stringify([plan.name, plan.type, plan.schedule]);
    /* 只有便利貼變了：資料照收，但不記紀錄（貼一張、改一個字就是一次同步） */
    if (!changed) return null;
    const parts = [n.add && `新增 ${n.add} 格`, n.back && `接回 ${n.back} 格`, n.gone && `收起 ${n.gone} 格`,
                   n.moved && `${n.moved} 格換版位`, n.recat && `${n.recat} 格換品類`,
                   handover.length && `${handover.length} 格換負責人`, n.carry && `${n.carry} 個退件接到合併後的格子`].filter(Boolean);
    return { what: created ? '檔期開始審核' : '版面變動，審核跟著調整', target: `檔期 ${plan.name}`,
             detail: parts.join('、') || '檔期資料更新' };
  }

  function apply(db, a, action, p, now) {
    const iso = new Date(now).toISOString();
    const c = p.cell_id ? cellById(db, p.cell_id) : null;
    const b = p.block_id ? blockById(db, p.block_id) : null;
    const plan = p.plan_id ? planById(db, p.plan_id) : (c ? planById(db, c.plan_id) : null);
    const actingNote = r => (r && r.acting ? `代理 ${memberById(db, r.as).name}` : '');
    const cy = c ? cycleOf(db, c) : null;
    const startCycle = (x, round, by, level, label) => {
      x.version = (x.version || 1) + 1;
      const R0 = round === 'r2' ? x.r2 : round === 'r3' ? x.r3 : x.fin;
      R0.cycle = { round, by, level, label, v: x.version, state: 'judge', kind: null, at: iso };
      hist(x, now, by, memberById(db, by).name, `${label}退件`, `進入第 ${x.version} 版`);
      notify(db, designers(db), `${cellLabel(db, x)} 被${label} ${memberById(db, by).name}退件，請判斷問題種類`, cellLink(x), now, 'reject');
    };
    switch (action) {
      case 'plan.sync': return syncPlan(db, p.skeleton, now);
      case 'detail.set': {
        const d = p.detail;
        c.detail = d === null ? null : { sku: String(d.sku).trim(), brand: String(d.brand || ''), name: String(d.name || ''),
          spec: String(d.spec || ''), price: d.price === '' || d.price == null ? '' : Number(d.price), info: String(d.info || '') };
        return null;   // 挑貨一天改幾十次，送出那一下才記
      }
      case 'detail.save': {
        const patch = p.patch || {};
        if (patch.sku) {
          const pr = db.products.find(x => x.sku === patch.sku);
          // 後台有值就帶入，沒有就留空（4.1 第 2 點）
          c.detail = { sku: pr.sku, brand: pr.brand || '', name: pr.name || '', spec: pr.spec || '', price: pr.price == null ? '' : pr.price, info: pr.info || '' };
        }
        for (const k of ['name', 'spec', 'info']) if (k in patch && c.detail) c.detail[k] = String(patch[k]);
        if ('price' in patch && c.detail) c.detail.price = patch.price === '' ? '' : Number(patch.price);
        if ('note_text' in patch) c.note_text = String(patch.note_text);
        return null;   // 打字自動存，不一格一字記紀錄；送出那一下才記
      }
      case 'gift.add': {
        const pr = db.products.find(x => x.sku === String(p.sku).trim());
        c.gifts.push({ sku: pr.sku, name: pr.name });
        return { what: '新增贈品', target: `格 ${cellLabel(db, c)}`, detail: [pr.sku, actingNote(pmOfCell(db, a, c))].filter(Boolean).join('　') };
      }
      case 'gift.remove': {
        c.gifts = c.gifts.filter(g => g.sku !== p.sku);
        return { what: '拿掉贈品', target: `格 ${cellLabel(db, c)}`, detail: p.sku };
      }
      case 'detail.submit': {
        const r = pmOfCell(db, a, c);
        c.stage = '製作';
        c.submitted = { by: a.id, as: r.as, acting: r.acting, at: iso };
        hist(c, now, a.id, a.name, '提明細完成', actingNote(r));
        return { what: '提明細完成', target: `格 ${cellLabel(db, c)}`, detail: actingNote(r) };
      }
      case 'detail.mark': {
        c.detailMark = !!p.done;
        return null;   // 標一下、取消一下不記紀錄（跟挑貨同一條理由），送出那一下才記
      }
      case 'stamp.mark': {
        c.r3.mark = !!p.done;
        return null;
      }
      case 'make.mark': {
        c.madeMark = !!p.done;
        return { what: p.done ? '製作：標好了' : '製作：取消標好了', target: `格 ${cellLabel(db, c)}` };
      }
      case 'fix.mark': {
        const ph = blockOf(db, c).phase;
        c.fixMark = Object.assign({}, c.fixMark, { [ph]: !!p.done });
        return { what: `${ph}：${p.done ? '改好了' : '取消改好了'}`, target: `格 ${cellLabel(db, c)}` };
      }
      case 'make.submit': {
        c.stage = '一校';
        c.made = { by: a.id, at: iso };
        updateDraft(db, c, now);
        hist(c, now, a.id, a.name, '製作完成', `草稿版 v${db.traces[c.detail.sku].draft.v}`);
        return { what: '製作完成', target: `格 ${cellLabel(db, c)}`, detail: `草稿版 v${db.traces[c.detail.sku].draft.v}` };
      }
      case 'review.mark': {
        const r = pmOfCell(db, a, c);
        c.reviewed = !!p.done;
        return { what: p.done ? '一校：審核完成' : '一校：取消審核完成', target: `格 ${cellLabel(db, c)}`, detail: actingNote(r) };
      }
      case 'review.late': {
        const r = pmOfCell(db, a, c);
        const bb = blockOf(db, c);
        c.reviewed = true;
        c.fix = db.notes.some(n => n.cell_id === c.id && n.status === 'open');
        /* 接上版位現在那一輪：那一輪的紀錄從頭開始。二校的話，這位 PM 的「二校完成」收回來 ——
           這一格他還沒審過，版位不能當作他審完了。 */
        if (bb.phase === '二校') {
          c.version = c.version || 1;
          c.r2 = { reviewed: false, hi: null, hiBy: null, steps: {}, cycle: null, past: [] };
          if (bb.r2 && bb.r2.pm_done) delete bb.r2.pm_done[r.as];
        }
        if (bb.phase === '蓋章確認') c.r3 = { stamp: null, hi: null, hiBy: null, steps: {}, cycle: null, past: [] };
        if (bb.phase === '審稿') c.fin = { cycle: null, past: [], stampN: null };
        hist(c, now, a.id, a.name, '補完一校', [actingNote(r), `接上版位的${bb.phase}`].filter(Boolean).join('　'));
        notify(db, designers(db), `${cellLabel(db, c)} 補完一校，接上 ${bb.name} 版位的${bb.phase}`, cellLink(c), now, 'turn');
        return { what: '補完一校', target: `格 ${cellLabel(db, c)}`, detail: [actingNote(r), `接上版位的${bb.phase}`].filter(Boolean).join('　') };
      }
      case 'r2.mark': {
        const r = pmOfCell(db, a, c);
        c.r2.reviewed = !!p.done;
        return { what: p.done ? '二校：審核完成' : '二校：取消審核完成', target: `格 ${cellLabel(db, c)}`, detail: actingNote(r) };
      }
      case 'note.add': {
        const np = notePurpose(db, a, c);
        db.notes.push({
          id: uid('n', now), plan_id: c.plan_id, block_id: c.block_id, cell_id: c.id,
          author: a.id, author_name: a.name, author_role: a.role,
          kind: p.kind, text: String(p.text).trim(), stage: stageOf(db, c), purpose: np.purpose, level: np.level || null,
          ctx: ctxKey(db, c), status: 'open', created_at: iso, replies: [], resolved_by: null, resolved_at: null,
        });
        // 設計新增便利貼 → 對應的 PM／職代（7.5）
        if (a.role === 'design') notify(db, pmPeople(db, ownerOf(db, c), now), `設計在 ${cellLabel(db, c)} 貼了便利貼：${String(p.text).trim()}`, cellLink(c), now, 'note');
        return { what: '新增便利貼', target: `格 ${cellLabel(db, c)}`, detail: `${p.kind}：${String(p.text).trim()}` };
      }
      case 'note.reply': {
        const n = noteById(db, p.note_id);
        n.replies.push({ by: a.id, name: a.name, role: a.role, text: String(p.text).trim(), at: iso });
        const x = cellById(db, n.cell_id);
        if (a.role === 'design') notify(db, pmPeople(db, ownerOf(db, x), now), `設計回覆了 ${cellLabel(db, x)} 的便利貼：${String(p.text).trim()}`, cellLink(x), now, 'note');
        else if (n.author !== a.id) notify(db, [n.author], `${a.name}回覆了你在 ${cellLabel(db, x)} 的便利貼`, cellLink(x), now, 'note');
        return { what: '便利貼留言', target: `格 ${cellLabel(db, x)}`, detail: String(p.text).trim() };
      }
      case 'note.resolve': {
        const n = noteById(db, p.note_id);
        n.status = p.done ? 'resolved' : 'open';
        n.resolved_by = p.done ? a.id : null;
        n.resolved_at = p.done ? iso : null;
        return { what: p.done ? '便利貼標成已處理' : '便利貼改回未處理', target: `格 ${cellLabel(db, cellById(db, n.cell_id))}`, detail: n.text };
      }
      case 'note.delete': {
        const n = noteById(db, p.note_id);
        db.notes = db.notes.filter(x => x.id !== n.id);
        return { what: '刪除便利貼', target: `格 ${cellLabel(db, cellById(db, n.cell_id))}`, detail: n.text };
      }
      case 'block.review1': {
        const r = pmAs(a, p.as_pm);
        b.pm_done[p.as_pm] = { by: a.id, acting: r.acting, at: iso };
        const mine = blockCells(db, b).filter(x => ownerOf(db, x) === p.as_pm);
        for (const x of mine) hist(x, now, a.id, a.name, '一校完成', actingNote(r));
        // 任一 PM 送出需要調整的格子 → 設計（立即）
        const fixN = mine.filter(x => db.notes.some(n => n.cell_id === x.id && n.status === 'open')).length;
        if (fixN) notify(db, designers(db), `${memberById(db, p.as_pm).name}一校送出：${b.name} 版位 ${fixN} 格要改`, `#/plan/${b.plan_id}/${b.id}`, now, 'turn');
        const all = blockPms(db, b.id).every(id => b.pm_done[id]);
        if (all) {
          b.phase = '一改';
          for (const x of blockCells(db, b)) x.fix = db.notes.some(n => n.cell_id === x.id && n.status === 'open');
        }
        return { what: '一校完成', target: `版位 ${b.name}`, detail: [actingNote(r), all ? '每位 PM 都完成，版位進入一改' : ''].filter(Boolean).join('　') };
      }
      case 'block.masthead': b.masthead_ok = !!p.ok; return null;
      case 'block.mh2': b.mh2_ok = !!p.ok; return null;
      case 'block.fix1': {
        for (const x of blockCells(db, b)) { if (x.fix) updateDraft(db, x, now); hist(x, now, a.id, a.name, '一改完成'); }
        enterR2(db, b);
        for (const pid of blockPms(db, b.id)) notify(db, pmPeople(db, pid, now), `${b.name} 版位進入二校，等你審`, `#/plan/${b.plan_id}/${b.id}`, now, 'turn');
        /* 第二版送出也通知部長。開關關著的時候他在二校只看進度 —— 但他要知道第二版出來了 */
        const dirs = [...new Set(blockCells(db, b).map(x => mgrOf(db, x, 2)).filter(Boolean))];
        notify(db, dirs, `${b.name} 版位第二版已送出，進入二校${r2Managers(db) ? '（PM 審完輪到主管）' : '（PM 審核中，你可以查看進度）'}`, `#/plan/${b.plan_id}/${b.id}`, now, 'info');
        return { what: '一改完成', target: `版位 ${b.name}`, detail: '版位進入二校' };
      }
      case 'block.r2pm': {
        const r = pmAs(a, p.as_pm);
        b.r2.pm_done[p.as_pm] = { by: a.id, acting: r.acting, at: iso };
        for (const x of blockCells(db, b)) {
          if (ownerOf(db, x) !== p.as_pm) continue;
          // 二校輪的起點＝這位 PM 在這個分類的最高層；代理的一律算 PM（5.1、5.2）
          const lvl = levelForPm(db, a, r, x);
          x.r2.hi = lvl;
          x.r2.hiBy = { id: a.id, name: a.name, how: r.acting ? `代理${memberById(db, r.as).name}二校完成` : (lvl < 4 ? `身兼${LEVEL_NAME[lvl]}，二校完成` : '二校完成') };
          hist(x, now, a.id, a.name, '二校完成', `${actingNote(r) ? actingNote(r) + '，' : ''}算${LEVEL_NAME[lvl]}`);
        }
        const all = r2PmAllDone(db, b);
        advance(db, b, now);
        return { what: '二校完成', target: `版位 ${b.name}`, detail: [actingNote(r), all ? (r2Managers(db) ? '每位 PM 都完成，輪到主管' : '每位 PM 都完成，進入二改') : ''].filter(Boolean).join('　') };
      }
      case 'mgr.submit': {
        const L = +p.level;
        const pending = blockCells(db, b).filter(x => mgrOf(db, x, L) === a.id && mgrPendingLevel(db, x) === L);
        const rejected = pending.filter(x => openOn(db, x, ['reject'], a.id).length);
        const passed = pending.filter(x => !rejected.includes(x));
        for (const x of passed) {
          x.r2.steps[L] = { how: 'pass', by: a.id, at: iso };
          x.r2.hi = mgrTop(db, a, x, L);
          x.r2.hiBy = { id: a.id, name: a.name, how: mgrHow(L, x.r2.hi) };
          hist(x, now, a.id, a.name, `${LEVEL_NAME[L]}審核通過`);
        }
        for (const x of rejected) {
          startCycle(x, 'r2', a.id, L, LEVEL_NAME[L]);
          logAs(db, a, now, { what: '主管審核退件', target: `格 ${cellLabel(db, x)}`, detail: `二校輪 ${LEVEL_NAME[L]}退件，進入第 ${x.version} 版` });
        }
        advance(db, b, now);
        return passed.length ? { what: '主管審核通過', target: `版位 ${b.name}`, detail: `二校輪 ${LEVEL_NAME[L]}：通過 ${passed.length} 格${rejected.length ? `、退件 ${rejected.length} 格` : ''}` } : null;
      }
      case 'block.fix2': {
        for (const x of blockCells(db, b)) { if (x.fix2) updateDraft(db, x, now); hist(x, now, a.id, a.name, '二改完成'); }
        enterR3(db, b);
        for (const pid of blockPms(db, b.id)) notify(db, pmPeople(db, pid, now), `${b.name} 版位進入蓋章確認，等你蓋章`, `#/plan/${b.plan_id}/${b.id}`, now, 'turn');
        return { what: '二改完成', target: `版位 ${b.name}`, detail: '版位進入蓋章確認' };
      }
      case 'stamp': {
        const r = pmOfCell(db, a, c);
        const lvl = levelForPm(db, a, r, c);
        c.r3.stamp = { by: a.id, as: r.as, acting: r.acting, level: lvl, at: iso };
        c.r3.hi = lvl;
        c.r3.hiBy = { id: a.id, name: a.name, how: r.acting ? `代理${memberById(db, r.as).name}蓋章` : (lvl < 4 ? `身兼${LEVEL_NAME[lvl]}，蓋章` : '蓋章') };
        hist(c, now, a.id, a.name, '蓋章', `${actingNote(r) ? actingNote(r) + '，' : ''}算${LEVEL_NAME[lvl]}`);
        advance3(db, c.plan_id, now);
        // 4.7 第 2 點：蓋章者、是不是職代（原 PM）、蓋章者的層級
        return { what: 'PM 蓋章', target: `格 ${cellLabel(db, c)}`, detail: [actingNote(r), `層級 ${LEVEL_NAME[lvl]}`].filter(Boolean).join('　') };
      }
      case 'stamp.reject': {
        const r = pmOfCell(db, a, c);
        startCycle(c, 'r3', a.id, 4, 'PM');
        logAs(db, a, now, { what: '退件循環：記錄送回者', target: `格 ${cellLabel(db, c)}`, detail: `送回者 ${a.name}（PM${r.acting ? '，' + actingNote(r) : ''}），進入第 ${c.version} 版` });
        return { what: 'PM 蓋章前要調整', target: `格 ${cellLabel(db, c)}`, detail: actingNote(r) };
      }
      case 'mgr3.submit': {
        const L = +p.level;
        const pending = scopeOf(db, plan.id, L, a.id).filter(x => mgr3PendingLevel(db, x) === L);
        const rejected = pending.filter(x => openOn(db, x, ['reject'], a.id).length);
        const passed = pending.filter(x => !rejected.includes(x));
        for (const x of passed) {
          x.r3.steps[L] = { how: 'pass', by: a.id, at: iso };
          x.r3.hi = mgrTop(db, a, x, L);
          x.r3.hiBy = { id: a.id, name: a.name, how: mgrHow(L, x.r3.hi) };
          hist(x, now, a.id, a.name, `蓋章輪 ${LEVEL_NAME[L]}審核通過`);
        }
        for (const x of rejected) {
          startCycle(x, 'r3', a.id, L, LEVEL_NAME[L]);
          logAs(db, a, now, { what: '主管審核退件', target: `格 ${cellLabel(db, x)}`, detail: `蓋章輪 ${LEVEL_NAME[L]}退件，進入第 ${x.version} 版` });
        }
        advance3(db, plan.id, now);
        return passed.length ? { what: '主管審核通過', target: `檔期 ${plan.name}`, detail: `蓋章輪 ${LEVEL_NAME[L]}：通過 ${passed.length} 格${rejected.length ? `、退件 ${rejected.length} 格` : ''}` } : null;
      }
      case 'final.send': {
        plan.final.sent = { by: a.id, at: iso };
        for (const bb of planBlocks(db, plan.id)) bb.phase = '審稿';
        for (const x of planCells(db, plan.id)) x.fin = { cycle: null, past: [], stampN: null };
        advanceFinal(db, plan.id, now);
        return { what: '行銷送最終審核', target: `檔期 ${plan.name}`, detail: `第 1 關 ${SEAT_LABEL[1]} ${memberById(db, seatReviewer(db, 1)).name}` };
      }
      case 'final.submit': {
        const k = currentSeat(plan);
        const cells = planCells(db, plan.id);
        const rejected = cells.filter(x => !x.fin.cycle && openOn(db, x, ['reject'], a.id).length);
        for (const x of rejected) {
          startCycle(x, 'final', a.id, k, SEAT_LABEL[k]);
          logAs(db, a, now, { what: '最終審核退件', target: `格 ${cellLabel(db, x)}`, detail: `${SEAT_LABEL[k]}退件，進入第 ${x.version} 版` });
        }
        plan.final.seats[k] = { how: rejected.length ? 'waiting' : 'pass', by: a.id, at: iso };
        advanceFinal(db, plan.id, now);
        return { what: rejected.length ? '最終審核：部分退件' : '最終審核通過', target: `檔期 ${plan.name}`, detail: `${SEAT_LABEL[k]}${rejected.length ? `退件 ${rejected.length} 格，其餘通過` : '通過整份 DM'}` };
      }
      case 'publish': {
        // 只有出稿時才寫入正式版（8.4 第 3 點）
        for (const x of planCells(db, plan.id)) {
          if (!x.detail) continue;
          const tr = db.traces[x.detail.sku];
          if (tr && tr.draft) tr.official = Object.assign({}, tr.draft, { official_at: iso, plan_id: plan.id });
          hist(x, now, a.id, a.name, '設計出稿');
        }
        plan.published = { by: a.id, at: iso };
        notify(db, [plan.created_by], `${plan.name}：設計已出稿`, `#/plan/${plan.id}`, now, 'turn');
        return { what: '設計出稿', target: `檔期 ${plan.name}`, detail: '所有 SKU 設計軌跡寫成正式版' };
      }
      /* ---------- 退件循環 ---------- */
      case 'cycle.judge': {
        cy.kind = p.kind;
        cy.state = p.kind === '設計問題' ? 'fix' : 'pm_data';
        hist(c, now, a.id, a.name, `判斷為${p.kind}`, p.kind === '商品問題' ? '退回 PM 改商品資料' : '設計自己改');
        if (p.kind === '商品問題') notify(db, pmPeople(db, ownerOf(db, c), now), `${cellLabel(db, c)} 退件是商品問題，請改商品資料`, cellLink(c), now, 'reject');
        return { what: '退件循環：設計判斷問題類型', target: `格 ${cellLabel(db, c)}`, detail: p.kind };
      }
      case 'cycle.dataDone': {
        const r = pmOfCell(db, a, c);
        cy.state = 'fix';
        hist(c, now, a.id, a.name, '商品資料改好了', actingNote(r));
        notify(db, designers(db), `${cellLabel(db, c)} 商品資料改好了，請修改`, cellLink(c), now, 'reject');
        return { what: '退件循環：商品資料改好', target: `格 ${cellLabel(db, c)}`, detail: actingNote(r) };
      }
      case 'cycle.fixDone': {
        cy.state = 'pm_confirm';
        updateDraft(db, c, now);
        hist(c, now, a.id, a.name, '退件修改完成');
        notify(db, pmPeople(db, ownerOf(db, c), now), `${cellLabel(db, c)} 改好了，請${cy.round === 'r2' ? '確認' : '蓋章'}`, cellLink(c), now, 'reject');
        return { what: '退件修改完成', target: `格 ${cellLabel(db, c)}`, detail: `第 ${cy.v} 版` };
      }
      case 'cycle.back': {
        cy.state = 'fix';
        hist(c, now, a.id, a.name, 'PM 退回設計再改');
        notify(db, designers(db), `${cellLabel(db, c)} PM 退回再改`, cellLink(c), now, 'reject');
        return { what: '退件循環：PM 退回設計', target: `格 ${cellLabel(db, c)}`, detail: `第 ${cy.v} 版` };
      }
      case 'cycle.confirm': {
        const r = pmOfCell(db, a, c);
        const rej = memberById(db, cy.by);
        const R0 = roundOf(db, c);
        if (cy.round === 'r2') {
          // 比退件者低一層：退件者一定重審，比他低的層級不重審（6.2）
          R0.hi = cy.level + 1;
          delete R0.steps[cy.level];
          R0.hiBy = { id: a.id, name: a.name, how: '確認退件修改' };
          cy.state = 'rereview';
        } else if (cy.round === 'r3') {
          // PM 蓋章 N
          const lvl = levelForPm(db, a, r, c);
          R0.stamp = { by: a.id, as: r.as, acting: r.acting, level: lvl, at: iso, n: cy.v };
          if (cy.level === 4) {
            // 退件者是 PM 本人：蓋章 N 就是一般蓋章，層級照 5.2 重新算（6.2 最後一段）
            R0.hi = lvl;
            R0.steps = {};
            R0.hiBy = { id: a.id, name: a.name, how: r.acting ? `代理${memberById(db, r.as).name}蓋章` : (lvl < 4 ? `身兼${LEVEL_NAME[lvl]}，蓋章` : '蓋章') };
            R0.past.push(Object.assign({}, cy, { closed_at: iso }));
            R0.cycle = null;
            hist(c, now, a.id, a.name, `蓋章 ${cy.v}`, `${actingNote(r) ? actingNote(r) + '，' : ''}算${LEVEL_NAME[lvl]}`);
            advance3(db, c.plan_id, now);
            return { what: 'PM 蓋章', target: `格 ${cellLabel(db, c)}`, detail: [`蓋章 ${cy.v}`, actingNote(r), `層級 ${LEVEL_NAME[lvl]}`].filter(Boolean).join('　') };
          }
          R0.hi = cy.level + 1;
          delete R0.steps[cy.level];
          R0.hiBy = { id: a.id, name: a.name, how: `蓋章 ${cy.v}` };
          cy.state = 'rereview';
        } else {
          // 最終審核的退件：PM 蓋章 N 之後直接送回退件者（不影響主管審核的層級，6.2）
          c.fin.stampN = { by: a.id, at: iso, n: cy.v };
          cy.state = 'rereview';
        }
        const how = cy.round === 'r2' ? '確認' : `蓋章 ${cy.v}`;
        hist(c, now, a.id, a.name, `${how}，送回${cy.label} ${rej.name}`, actingNote(r));
        notify(db, [cy.by], `${cellLabel(db, c)} 退件改好了，等你重審`, cellLink(c), now, 'reject');
        return { what: '退件循環：送回退件者', target: `格 ${cellLabel(db, c)}`, detail: `${how}，送回${cy.label} ${rej.name}　${actingNote(r)}`.trim() };
      }
      case 'cycle.pass': {
        const R0 = roundOf(db, c);
        if (cy.round === 'r2' || cy.round === 'r3') {
          const L = cy.level;
          R0.steps[L] = { how: 'pass', by: a.id, at: iso };
          R0.hi = mgrTop(db, a, c, L);
          R0.hiBy = { id: a.id, name: a.name, how: `${LEVEL_NAME[L]}重審通過` };
        }
        R0.past.push(Object.assign({}, cy, { closed_at: iso }));
        R0.cycle = null;
        hist(c, now, a.id, a.name, `${cy.label}重審通過`, `第 ${cy.v} 版`);
        if (cy.round === 'r2') advance(db, blockOf(db, c), now);
        else if (cy.round === 'r3') advance3(db, c.plan_id, now);
        else advanceFinal(db, c.plan_id, now);
        return { what: '退件重審通過', target: `格 ${cellLabel(db, c)}`, detail: `${cy.label}，第 ${cy.v} 版` };
      }
      case 'cycle.reject': {
        c.version = (c.version || 1) + 1;
        cy.v = c.version;
        cy.state = 'judge';
        cy.kind = null;
        hist(c, now, a.id, a.name, `${cy.label}再退件`, `進入第 ${c.version} 版`);
        notify(db, designers(db), `${cellLabel(db, c)} 被${cy.label} ${a.name}再退件`, cellLink(c), now, 'reject');
        return { what: cy.round === 'final' ? '最終審核退件' : '主管審核退件', target: `格 ${cellLabel(db, c)}`, detail: `${cy.label}重審再退件，進入第 ${c.version} 版` };
      }
      /* ---------- 設定表、職代 ---------- */
      case 'settings.save': {
        const was = r2Managers(db);
        db.reviewerSettings = Object.assign({}, db.reviewerSettings, p.patch);
        if ('r2_managers' in (p.patch || {})) db.reviewerSettings.r2_managers = !!p.patch.r2_managers;
        /* 關掉的時候，PM 都按完、正在等主管的二校版位不能卡在一個已經不存在的關卡上 */
        if (was && !r2Managers(db)) for (const bb of db.blocks) if (bb.phase === '二校') advance(db, bb, now);
        const keys = Object.keys(p.patch || {}).map(k => k === 'r2_managers' ? `二校主管審核${r2Managers(db) ? '開' : '關'}` : k);
        return { what: '修改最終審核者設定表', target: '設定表', detail: keys.join('、') };
      }
      case 'deleg.add': {
        const d = { id: uid('dl', now), from_id: p.from_id, to_id: p.to_id, assigned_by: a.id, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString(), stages: 'all', source: 'manual', created_at: iso };
        // 系統內指定覆寫外部帶入的預設代理人；請假這件事本身不動（8.2 第 2 點）
        for (const x of db.delegations) {
          if (x.from_id === d.from_id && x.source === 'sync' && !x.cancelled_at && !x.overridden_by && t(x.start) < t(d.end) && t(d.start) < t(x.end)) x.overridden_by = d.id;
        }
        db.delegations.push(d);
        notify(db, [d.to_id], `${a.name}指定你代理 ${memberById(db, d.from_id).name}`, '#/delegates', now, 'deleg');
        return { what: '指定職代', target: `PM ${memberById(db, d.from_id).name}`, detail: `職代 ${memberById(db, d.to_id).name}　${d.start.slice(0, 16)} 到 ${d.end.slice(0, 16)}` };
      }
      case 'deleg.cancel': {
        const d = db.delegations.find(x => x.id === p.id);
        d.cancelled_at = iso;
        d.cancelled_by = a.id;
        if (t(d.end) > now) d.end = iso;
        // 被它覆寫掉的差勤預設代理人放回來
        for (const x of db.delegations) if (x.overridden_by === d.id) delete x.overridden_by;
        return { what: '取消職代', target: `PM ${memberById(db, d.from_id).name}`, detail: `職代 ${memberById(db, d.to_id).name}` };
      }
    }
    return null;
  }

  /* 後端唯一的入口：驗證 → 改資料 → 記紀錄。
     沒有權限的一律記一筆「未授權操作被拒」（8.3）；時機不對、東西沒填只回原因。 */
  function act(db, actorId, action, p, now) {
    const a = actorOf(db, actorId, now);
    const r = can(db, a, action, p || {});
    if (!r.ok) {
      if (r.kind === 'forbidden') {
        pushAudit(db, { who: a.id, who_name: a.name, email: a.m ? a.m.email : '', what: '未授權操作被拒', target: action, result: '失敗', detail: r.reason }, now);
      }
      return r;
    }
    const log = apply(db, a, action, p || {}, now);
    if (log) logAs(db, a, now, log);
    return { ok: true };
  }

  /* ======================================================================
     顯示用
     ====================================================================== */

  const CYCLE_TEXT = {
    judge: () => ['等設計判斷', '設計'],
    pm_data: (db, c) => ['等 PM 改資料', ownerName(db, c)],
    fix: () => ['等設計修改', '設計'],
    pm_confirm: (db, c, cy) => [cy.round === 'r2' ? '等 PM 確認' : '等 PM 蓋章', ownerName(db, c)],
    rereview: (db, c, cy) => [`等${cy.label || LEVEL_NAME[cy.level]} ${memberById(db, cy.by).name}重審`, memberById(db, cy.by).name],
  };

  /* 一格現在的狀態：一句話＋在等誰。畫面、待辦、進度都讀這一支，才不會各說各話。
     tone：todo 等人處理／done 這一步好了／back 退件中／later 下一階段 */
  function cellStatus(db, c) {
    const st = stageOf(db, c);
    const b = blockOf(db, c);
    if (!catById(db, c.category_id)) return { stage: st, text: '沒有負責人', wait: '', tone: 'none' };
    const owner = ownerName(db, c);
    const cy = cycleOf(db, c);
    if (cy) {
      const [text, wait] = CYCLE_TEXT[cy.state](db, c, cy);
      return { stage: st, text: `退件・${text}`, wait, tone: 'back' };
    }
    /* 還沒補完一校的格子講它自己在哪一關，不講版位的（不然一格空的寫「一校 OK，等設計確認」） */
    const late = behind(db, c);
    switch (late ? c.stage : (b.phase || c.stage)) {
      case '提明細': return { stage: st, text: c.detailMark ? '尚未送出' : c.detail ? '填寫中' : '還沒挑貨', wait: owner, tone: 'todo' };
      case '製作': return c.madeMark ? { stage: st, text: '尚未送出', wait: '設計', tone: 'todo' }
                                     : { stage: st, text: '等設計製作', wait: '設計', tone: 'todo' };
      case '一校':
        if (late) return { stage: st, text: '補一校：等 PM 審', wait: owner, tone: 'todo' };
        if (b.pm_done[ownerOf(db, c)]) return { stage: st, text: '已送出，等其他 PM', wait: '其他 PM', tone: 'done' };
        return c.reviewed ? { stage: st, text: '已審', wait: owner, tone: 'done' } : { stage: st, text: '等 PM 審', wait: owner, tone: 'todo' };
      case '一改':
      case '二改': {
        const f = b.phase === '一改' ? c.fix : c.fix2;
        if (c.fixMark && c.fixMark[b.phase]) return { stage: st, text: '改好了', wait: '', tone: 'done' };
        const open = db.notes.some(n => n.cell_id === c.id && n.status === 'open');
        if (f && open) return { stage: st, text: '等設計修改', wait: '設計', tone: 'todo' };
        return { stage: st, text: f ? '改完了，等設計標改好了' : (b.phase === '一改' ? '一校 OK，等設計確認' : '二校 OK，等設計確認'), wait: '設計', tone: 'todo' };
      }
      case '二校': {
        const r2 = c.r2;
        const o = ownerOf(db, c);
        if (!r2) return { stage: st, text: '等 PM 審', wait: owner, tone: 'todo' };
        if (!b.r2.pm_done[o]) return r2.reviewed ? { stage: st, text: '已審', wait: owner, tone: 'done' } : { stage: st, text: '等 PM 審', wait: owner, tone: 'todo' };
        if (!r2PmAllDone(db, b)) return { stage: st, text: '已送出，等其他 PM', wait: '其他 PM', tone: 'done' };
        const L = mgrPendingLevel(db, c);
        if (L) { const m = memberById(db, mgrOf(db, c, L)).name; return { stage: st, text: `等${LEVEL_NAME[L]} ${m}`, wait: m, tone: 'todo' }; }
        if (!r2.steps[2]) return { stage: st, text: '等其他格過課長', wait: '課長', tone: 'done' };
        return { stage: st, text: '二校通過', wait: '', tone: 'done' };
      }
      case '蓋章確認': {
        const r3 = c.r3;
        if (!r3 || !r3.stamp) return { stage: st, text: r3 && r3.mark ? '尚未送出' : '等 PM 蓋章', wait: owner, tone: 'todo' };
        const L = mgr3PendingLevel(db, c);
        if (L) { const m = memberById(db, mgrOf(db, c, L)).name; return { stage: st, text: `等${LEVEL_NAME[L]} ${m}`, wait: m, tone: 'todo' }; }
        if (!r3.steps[3]) return { stage: st, text: '已蓋章，等課長管的格子蓋齊', wait: '其他格', tone: 'done' };
        if (!r3.steps[2]) return { stage: st, text: '等部長管的格子過齊課長', wait: '其他格', tone: 'done' };
        const plan = planById(db, c.plan_id);
        return { stage: st, text: plan.final ? '商品部確認完成' : '蓋章輪通過', wait: plan.final ? '行銷' : '其他格', tone: 'done' };
      }
      case '審稿': {
        const plan = planById(db, c.plan_id);
        const k = currentSeat(plan);
        if (!k) return { stage: st, text: '審稿通過', wait: '', tone: 'done' };
        return { stage: st, text: `等${SEAT_LABEL[k]} ${memberById(db, seatReviewer(db, k)).name}`, wait: memberById(db, seatReviewer(db, k)).name, tone: 'todo' };
      }
      case '出稿': {
        const plan = planById(db, c.plan_id);
        return plan.published ? { stage: st, text: '已出稿', wait: '', tone: 'done', short: true } : { stage: st, text: '等設計出稿', wait: '設計', tone: 'todo' };
      }
      default: return { stage: st, text: '', wait: '', tone: 'later' };
    }
  }

  /* 版位上方那一條審核鏈（二校）：PM → 課長 → 部長 */
  function reviewChain(db, b) {
    if (b.phase !== '二校') return null;
    const cells = blockCells(db, b);
    const pms = blockPms(db, b.id).map(id => ({
      id, name: memberById(db, id).name,
      state: b.r2.pm_done[id] ? 'done' : (review2Missing(db, b.id, id).length ? 'wait' : 'ready'),
      left: review2Missing(db, b.id, id).length,
    }));
    const pmDone = r2PmAllDone(db, b);
    const layer = L => [...new Set(cells.map(c => mgrOf(db, c, L)))].map(id => {
      const mine = cells.filter(c => mgrOf(db, c, L) === id);
      return chainPerson(db, id, mine, L, 'r2', c => mgrPendingLevel(db, c) === L);
    });
    return { pms, pmDone, mgr3: layer(3).map(x => (pmDone || x.state === 'skip' ? x : Object.assign(x, { state: 'wait' }))), mgr2: layer(2), gate2: pmDone && gate2(db, b) };
  }
  function chainPerson(db, id, mine, L, rk, isPending) {
    const pending = mine.filter(isPending).length;
    const rere = mine.filter(c => c[rk] && c[rk].cycle && c[rk].cycle.by === id && c[rk].cycle.state === 'rereview').length;
    const inCycle = mine.filter(c => c[rk] && c[rk].cycle && c[rk].cycle.level === L).length;
    const allSkip = mine.length && mine.every(c => c[rk] && c[rk].steps[L] && c[rk].steps[L].how === 'skip');
    const done = mine.length && mine.every(c => c[rk] && c[rk].steps[L]);
    let state;
    if (allSkip) state = 'skip';
    else if (done) state = 'done';
    else if (pending || rere) state = 'todo';
    else if (inCycle) state = 'back';
    else state = 'wait';
    return { id, name: memberById(db, id).name, state, pending: pending + rere, inCycle, total: mine.length };
  }

  /* 整份 DM 那一條：蓋章輪（PM 蓋章 → 課長 → 部長 → 處長 → 商品部確認完成）＋審稿三關＋出稿 */
  function flowSummary(db, planId) {
    const plan = planById(db, planId);
    const cells = planCells(db, planId);
    const inR3 = cells.filter(c => c.r3);
    if (!inR3.length) return null;
    const stamped = inR3.filter(c => c.r3.stamp).length;
    const layer = L => [...new Set(cells.map(c => mgrOf(db, c, L)))].map(id => {
      const mine = scopeOf(db, planId, L, id);
      const x = chainPerson(db, id, mine, L, 'r3', c => mgr3PendingLevel(db, c) === L);
      if (x.state === 'wait') x.gate = GATE_R3[L](db, planId, id);
      return x;
    });
    const f = finalOf(plan);
    const k = currentSeat(plan);
    const seats = [1, 2, 3].map(n => {
      const id = seatReviewer(db, n);
      const s = f && f.seats[n];
      let state = 'wait';
      if (s && s.how === 'pass') state = 'done';
      else if (s && s.how === 'waiting') state = 'back';
      else if (k === n) state = 'todo';
      return { k: n, label: SEAT_LABEL[n], id, name: id ? memberById(db, id).name : '（還沒指定）', state };
    });
    return {
      total: cells.length, inR3: inR3.length, stamped,
      mgr3: layer(3), mgr2: layer(2), mgr1: layer(1),
      confirmed: !!(f && f.confirmed_at), sent: !!(f && f.sent), seats, current: k,
      finalDone: !!(f && f.done_at), published: plan.published || null,
      settingsMissing: settingsMissing(db),
      creator: memberById(db, plan.created_by),
    };
  }

  /* 一格在排程上的截止時間：那一關最後一天 18:00（7.1） */
  function dueOf(plan, stage) {
    const s = (plan.schedule || []).find(x => x.stage === stage);
    return s ? `${s.end}T18:00:00` : null;
  }

  /* 一份檔期走到哪：最落後的那一關（7.4 第 1 點） */
  function planProgress(db, planId) {
    const plan = planById(db, planId);
    const cells = planCells(db, planId);
    if (!cells.length) {
      const first = plan.schedule[0];
      return { started: false, stage: null, startsAt: first ? first.start : null };
    }
    if (plan.published) return { started: true, stage: '出稿', done: true, due: dueOf(plan, '出稿'), inStage: cells.length, total: cells.length };
    let min = STAGES.length;
    for (const c of cells) min = Math.min(min, stageIx(stageOf(db, c)));
    const stage = STAGES[min];
    const inStage = cells.filter(c => stageOf(db, c) === stage).length;
    return { started: true, stage, due: dueOf(plan, stage), inStage, total: cells.length };
  }

  /* ---------- 這一格現在該誰動手（通知、進度都用） ---------- */
  function responsibleOf(db, c, now) {
    if (!catById(db, c.category_id)) return { ids: [], side: 'none' };   // 沒有負責人：沒有人可以動它
    const b = blockOf(db, c);
    const plan = planById(db, c.plan_id);
    const cy = cycleOf(db, c);
    const owner = ownerOf(db, c);
    if (cy) {
      if (cy.state === 'judge' || cy.state === 'fix') return { ids: designers(db), side: 'design' };
      if (cy.state === 'pm_data' || cy.state === 'pm_confirm') return { ids: pmPeople(db, owner, now), side: 'pm' };
      return { ids: [cy.by], side: 'reviewer' };
    }
    switch (b.phase || c.stage) {
      case '提明細': return { ids: pmPeople(db, owner, now), side: 'pm' };
      case '製作': return { ids: designers(db), side: 'design' };
      case '一校': return b.pm_done[owner] ? { ids: [], side: 'pm' } : { ids: pmPeople(db, owner, now), side: 'pm' };
      case '一改': case '二改': return { ids: designers(db), side: 'design' };
      case '二校': {
        if (!b.r2.pm_done[owner]) return { ids: pmPeople(db, owner, now), side: 'pm' };
        const L = mgrPendingLevel(db, c);
        return { ids: L ? [mgrOf(db, c, L)] : [], side: 'reviewer' };
      }
      case '蓋章確認': {
        if (!c.r3.stamp) return { ids: pmPeople(db, owner, now), side: 'pm' };
        const L = mgr3PendingLevel(db, c);
        if (L) return { ids: [mgrOf(db, c, L)], side: 'reviewer' };
        if (plan.final && !plan.final.sent) return { ids: [plan.created_by], side: 'mkt' };
        return { ids: [], side: 'reviewer' };
      }
      case '審稿': { const k = currentSeat(plan); return { ids: k ? [seatReviewer(db, k)] : [], side: 'reviewer' }; }
      case '出稿': return { ids: plan.published ? [] : designers(db), side: 'design' };
    }
    return { ids: [], side: '' };
  }

  /* 進度確認（7.4）：一個品類一行（同名品類在不同版位分開列）。
     顯示最落後的那一關，提明細、製作加完成比例；寫出在等誰；退件修改、延遲另外標；延遲的排最前面。 */
  function categoryProgress(db, planId, now) {
    const plan = planById(db, planId);
    const rows = [];
    for (const b of planBlocks(db, planId)) {
      const bc = blockCells(db, b);
      /* 沒有代碼的（不在分類表上）照名字分：同一塊裡「平板」和「開學季資訊」是兩行 */
      const keyOf = c => c.category_id || 'name:' + (c.cat_name || '');
      for (const key of [...new Set(bc.map(keyOf))]) {
        const cells = bc.filter(c => keyOf(c) === key);
        const cid = cells[0].category_id || null;
        const unassigned = !catById(db, cid);
        let min = STAGES.length;
        for (const c of cells) min = Math.min(min, stageIx(stageOf(db, c)));
        const stage = STAGES[min];
        const behind = cells.filter(c => stageIx(stageOf(db, c)) === min);
        const done = cells.length - behind.length;
        const due = dueOf(plan, stage);
        const published = !!plan.published;
        const late = !published && due && now > t(due);
        const inCycle = behind.some(c => cycleOf(db, c));
        const st = cellStatus(db, behind[0]);
        let wait = '';
        if (!published) {
          const w = [...new Set(behind.map(c => cellStatus(db, c).wait).filter(Boolean))];
          wait = w.length ? `待${w.slice(0, 2).join('、')}${w.length > 2 ? '等' : ''}` : '';
          if (st.tone === 'done' && !inCycle) wait = st.text;
          if (unassigned) wait = '沒有負責人';
        }
        let text = published ? '已出稿' : stage;
        if (!published && (stage === '提明細' || stage === '製作')) text += `（${done}/${cells.length}）`;
        if (inCycle && (stage === '二校' || stage === '審稿')) text += '（退件修改）';
        if (late) text += '（延遲）';
        rows.push({ block_id: b.id, block_name: b.name, category_id: cid, category_name: catName(db, cid, cells[0].cat_name), unassigned, stage, text, wait, late, due, inCycle, total: cells.length, done, cell_ids: behind.map(c => c.id) });
      }
    }
    rows.sort((x, y) => (y.late ? 1 : 0) - (x.late ? 1 : 0) || stageIx(x.stage) - stageIx(y.stage));
    return rows;
  }

  /* ---------- 時間到了該發的通知（7.3、7.5） ----------
     延遲**只會**顯示和通知，不會讓任何東西自動往下走。
     本機模式每次讀資料時掃一次；接上之後由排程（pg_cron／排程的 Edge Function）每 10 分鐘跑同一支。 */
  const REMIND_STAGES = ['提明細', '製作', '一校', '二校', '一改', '二改'];
  function sweep(db, now) {
    db.sent = db.sent || {};
    db.lateNow = db.lateNow || {};
    let n = 0;
    const lead = db.reviewerSettings ? db.reviewerSettings.design_lead_id : null;
    for (const plan of db.plans) {
      if (plan.published || !planCells(db, plan.id).length) continue;
      const rows = categoryProgress(db, plan.id, now);
      const nowLate = {};
      for (const row of rows) {
        const key = `${plan.id}|${row.block_id}|${row.category_id}|${row.stage}`;
        const cells = row.cell_ids.map(id => cellById(db, id));
        const resp = cells.map(c => responsibleOf(db, c, now));
        const ids = [...new Set([].concat(...resp.map(r => r.ids)))];
        const side = (resp[0] || {}).side;
        /* 沒有負責人的品類（不在分類表上）沒有 PM 也沒有課長：延遲只通知行銷（開檔的人），他才改得了品類 */
        const cc = side === 'design' ? [lead] : side === 'pm' ? [(catById(db, row.category_id) || {}).manager_id].filter(Boolean) : [];
        const link = `#/plan/${plan.id}/${row.cell_ids[0]}`;
        const label = `${row.category_name}（${row.block_name}）${row.stage}`;
        if (row.late) {
          nowLate[key] = true;
          if (!db.sent[key + '|late']) {
            db.sent[key + '|late'] = true;
            let to;
            if (['提明細', '製作'].includes(row.stage)) to = ids.concat([plan.created_by], cc);
            else if (['一校', '二校'].includes(row.stage)) to = ids.concat(cc);
            else if (['一改', '二改'].includes(row.stage)) to = ids.concat([plan.created_by], cc);
            else to = ids.concat([plan.created_by]);
            notify(db, to, `${plan.name}：${label} 延遲了（截止 ${row.due.slice(5, 10).replace('-', '/')} 18:00）`, link, now, 'late');
            logSys(db, now, { what: '單位進入延遲', target: `檔期 ${plan.name}`, detail: label });
            n++;
          }
        } else if (REMIND_STAGES.includes(row.stage) && row.due && now >= t(row.due) - 4 * HOUR && now < t(row.due) && ids.length) {
          if (!db.sent[key + '|soon']) {
            db.sent[key + '|soon'] = true;
            notify(db, ids, `${plan.name}：${label} 再 4 小時截止（今天 18:00）`, link, now, 'soon');
            n++;
          }
        }
      }
      // 延遲後完成（8.5）：上一次掃的時候還延遲、現在不在那一關了
      for (const key of Object.keys(db.lateNow)) {
        if (!key.startsWith(plan.id + '|') || nowLate[key]) continue;
        const [, bid, cid, stage] = key.split('|');
        const still = rows.some(r => r.block_id === bid && r.category_id === cid && r.stage === stage);
        if (!still) {
          logSys(db, now, { what: '延遲後完成', target: `檔期 ${plan.name}`, detail: `${catName(db, cid)}（${(blockById(db, bid) || {}).name}）${stage}` });
          delete db.lateNow[key];
        }
      }
      Object.assign(db.lateNow, nowLate);
      // 出稿日前 2 天：還沒完成的審核者、PM，以及仍在退件循環中的設計和 PM
      const pub = (plan.schedule || []).find(s => s.stage === '出稿');
      if (pub && now >= t(pub.start + 'T00:00:00') - 2 * DAY && !db.sent[plan.id + '|pre2']) {
        db.sent[plan.id + '|pre2'] = true;
        const to = new Set();
        for (const c of planCells(db, plan.id)) for (const id of responsibleOf(db, c, now).ids) to.add(id);
        notify(db, [...to], `${plan.name}：再 2 天就是出稿日（${fmtMd(pub.start)}），還有事情沒完成`, `#/progress/${plan.id}`, now, 'late');
        n++;
      }
    }
    return n;
  }
  const fmtMd = ymd => `${+ymd.slice(5, 7)}/${+ymd.slice(8, 10)}`;

  /* 我的待辦：現在輪到**我**按的每一件事。代理的那一份分開列（acting）。 */
  function todo(db, actorId, now) {
    const a = actorOf(db, actorId, now);
    const items = [];
    const pmIds = [a.id, ...a.delegFor];
    for (const plan of db.plans) {
      const pcells = planCells(db, plan.id);
      if (!pcells.length || plan.published) continue;
      const base = b => ({ plan_id: plan.id, plan_name: plan.name, block_id: b ? b.id : '', block_name: b ? b.name : '' });
      for (const b of planBlocks(db, plan.id)) {
        const bcells = pcells.filter(c => c.block_id === b.id);
        for (const pid of pmIds) {
          const acting = pid !== a.id ? memberById(db, pid) : null;
          const mine = bcells.filter(c => ownerOf(db, c) === pid);
          if (!mine.length) continue;
          const byCat = {};
          for (const c of mine) if (stageOf(db, c) === '提明細') (byCat[c.category_id] = byCat[c.category_id] || []).push(c);
          for (const cid in byCat) {
            items.push(Object.assign(base(b), { stage: '提明細', title: `${catName(db, cid)} 提明細`, detail: `${byCat[cid].length} 格還沒送出`,
              cell_ids: byCat[cid].map(c => c.id), due: dueOf(plan, '提明細'), acting }));
          }
          if (!b.phase && !b.pm_done[pid]) {
            const waiting = mine.filter(c => c.stage === '一校' && !c.reviewed);
            if (waiting.length) {
              items.push(Object.assign(base(b), { stage: '一校', title: `${b.name} 一校`, detail: `${waiting.length} 格等你審`, cell_ids: waiting.map(c => c.id), due: dueOf(plan, '一校'), acting }));
            } else if (!review1Missing(db, b.id, pid).length) {
              items.push(Object.assign(base(b), { stage: '一校', title: `${b.name} 一校`, detail: '都審完了，按「一校完成」送出', cell_ids: [], due: dueOf(plan, '一校'), acting, action: 'block' }));
            }
          }
          const late1 = mine.filter(c => behind(db, c) && c.stage === '一校');
          if (late1.length) {
            items.push(Object.assign(base(b), { stage: '一校', title: `${b.name} 補一校`, detail: `${late1.length} 格是審核開始後才加的，看過按「補完一校」`,
              cell_ids: late1.map(c => c.id), due: dueOf(plan, '一校'), acting }));
          }
          if (b.phase === '二校' && !b.r2.pm_done[pid]) {
            const waiting = mine.filter(c => !behind(db, c) && !(c.r2 && c.r2.reviewed));
            items.push(Object.assign(base(b), { stage: '二校', title: `${b.name} 二校`, detail: waiting.length ? `${waiting.length} 格等你審` : '都審完了，按「二校完成」送出',
              cell_ids: waiting.map(c => c.id), due: dueOf(plan, '二校'), acting, action: waiting.length ? '' : 'block' }));
          }
          if (b.phase === '蓋章確認') {
            const toStamp = mine.filter(c => c.r3 && !c.r3.stamp && !c.r3.cycle);
            if (toStamp.length) items.push(Object.assign(base(b), { stage: '蓋章確認', title: `${b.name} 蓋章`, detail: `${toStamp.length} 格等你蓋章`, cell_ids: toStamp.map(c => c.id), due: dueOf(plan, '蓋章確認'), acting }));
          }
          for (const c of mine) {
            const cy = cycleOf(db, c);
            if (!cy || (cy.state !== 'pm_data' && cy.state !== 'pm_confirm')) continue;
            items.push(Object.assign(base(b), { stage: stageOf(db, c), title: `${cellLabel(db, c)} 退件`,
              detail: cy.state === 'pm_data' ? '設計判斷是商品問題，請改商品資料' : (cy.round === 'r2' ? '設計改好了，確認後送回退件的人' : `設計改好了，請蓋章 ${cy.v}，送回退件的人`),
              cell_ids: [c.id], due: dueOf(plan, stageOf(db, c)), acting, back: true }));
          }
        }
        if (b.phase === '二校') {
          for (const L of [3, 2]) {
            const pend = bcells.filter(c => mgrOf(db, c, L) === a.id && mgrPendingLevel(db, c) === L);
            if (pend.length) items.push(Object.assign(base(b), { stage: '二校', title: `${b.name} 二校 ${LEVEL_NAME[L]}審核`, detail: `${pend.length} 格等你審`, cell_ids: pend.map(c => c.id), due: dueOf(plan, '二校'), acting: null, action: 'block' }));
          }
        }
        if (a.role === 'design') {
          const byCat = {};
          for (const c of bcells) if (c.stage === '製作') (byCat[c.category_id] = byCat[c.category_id] || []).push(c);
          for (const cid in byCat) {
            items.push(Object.assign(base(b), { stage: '製作', title: `${catName(db, cid)} 製作`, detail: `${byCat[cid].length} 格等你做`, cell_ids: byCat[cid].map(c => c.id), due: dueOf(plan, '製作'), acting: null }));
          }
          for (const ph of ['一改', '二改']) {
            if (b.phase !== ph) continue;
            const open = openNotes(db, b.id);
            items.push(Object.assign(base(b), { stage: ph, title: `${b.name} ${ph}`,
              detail: open.length ? `${open.length} 張便利貼要處理` : `便利貼都處理了，確認${ph === '一改' ? '刊頭' : '刊頭與整體版面'}後按「${ph}完成」`,
              cell_ids: [...new Set(open.map(n => n.cell_id))], due: dueOf(plan, ph), acting: null, action: open.length ? '' : 'block' }));
          }
        }
      }
      // 整份 DM 的事
      const planItem = o => items.push(Object.assign(base(null), o));
      for (const c of pcells) {
        const cy = cycleOf(db, c);
        if (!cy) continue;
        if (cy.state === 'rereview' && cy.by === a.id) planItem({ stage: stageOf(db, c), title: `${cellLabel(db, c)} 退件回來了`, detail: `第 ${cy.v} 版改好了，等你重審`, cell_ids: [c.id], due: dueOf(plan, stageOf(db, c)), back: true });
        if (a.role === 'design' && (cy.state === 'judge' || cy.state === 'fix')) {
          planItem({ stage: stageOf(db, c), title: `${cellLabel(db, c)} 退件`,
            detail: cy.state === 'judge' ? `${memberById(db, cy.by).name}退件，先判斷是設計問題還是商品問題` : '照便利貼修改，改好按「修改完成」',
            cell_ids: [c.id], due: dueOf(plan, stageOf(db, c)), back: true });
        }
      }
      for (const L of R3_LEVELS) {
        const pend = pcells.filter(c => mgrOf(db, c, L) === a.id && mgr3PendingLevel(db, c) === L);
        if (pend.length) planItem({ stage: '蓋章確認', title: `蓋章輪 ${LEVEL_NAME[L]}審核`, detail: `你管的 ${pend.length} 格都蓋好章了，等你審`, cell_ids: pend.map(c => c.id), due: dueOf(plan, '蓋章確認'), action: 'plan' });
      }
      const f = finalOf(plan);
      if (a.role === 'mkt' && a.id === plan.created_by && f && !f.sent) {
        const miss = settingsMissing(db);
        planItem({ stage: '審稿', title: '送最終審核', detail: miss.length ? `商品部確認完成了，但設定表還沒填完：${miss[0]}` : '商品部確認完成了，可以送最終審核', cell_ids: [], due: dueOf(plan, '審稿'), action: 'plan' });
      }
      const k = currentSeat(plan);
      if (k && seatReviewer(db, k) === a.id && !(f.seats[k] && f.seats[k].how === 'waiting')) {
        planItem({ stage: '審稿', title: `審稿（${SEAT_LABEL[k]}）`, detail: '整份 DM 等你審：沒問題就通過，有問題在那一格貼便利貼退件', cell_ids: [], due: dueOf(plan, '審稿'), action: 'plan' });
      }
      if (a.role === 'design' && f && f.done_at && !plan.published) planItem({ stage: '出稿', title: '出稿', detail: '最終審核都通過了，可以出稿', cell_ids: [], due: dueOf(plan, '出稿'), action: 'plan' });
    }
    items.sort((x, y) => (y.back ? 1 : 0) - (x.back ? 1 : 0) || (x.due || '').localeCompare(y.due || '') || stageIx(x.stage) - stageIx(y.stage));
    return items;
  }

  /* 給這個人看的整份檔期。PM 挑貨只拿得到自己（和代理的）分類的商品，加上贈品配件。 */
  function planView(db, actorId, planId, now) {
    const a = actorOf(db, actorId, now);
    const plan = planById(db, planId);
    if (!plan) return null;
    const pmCats = new Set(db.assignments.filter(x => x.owner_id === a.id || a.delegFor.has(x.owner_id)).map(x => x.category_id));
    return {
      plan,
      plans: [plan],     // 畫面拿這一份當 db 問 can()／cellStatus()，那幾支是照 plans 找檔期的
      blocks: planBlocks(db, planId),
      cells: planCells(db, planId),
      notes: db.notes.filter(n => n.plan_id === planId),
      products: db.products.filter(x => pmCats.has(x.category_id) || x.category_id === '900'),
      imageFiles: a.role === 'design' ? db.imageFiles : [],
      traces: db.traces,
      assignments: db.assignments.map(x => ({ category_id: x.category_id, category_name: x.category_name, owner_id: x.owner_id, manager_id: x.manager_id, director_id: x.director_id, executive_id: x.executive_id })),
      members: db.members.map(m => ({ employee_id: m.employee_id, name: m.name, role: m.role, is_active: isActive(m) })),
      delegations: activeDelegations(db, now),
      reviewerSettings: Object.assign({}, db.reviewerSettings),
      progress: planProgress(db, planId),
    };
  }

  const api = {
    STAGES, LEVEL_NAME, ROLE_NAME, r2Managers, NOTE_KINDS, PROBLEM_KINDS, SEAT_LABEL,
    normEmail, validEmail, authorize, ownLevels, activeDelegations, identity, publicMember, memberById,
    actorOf, can, act, pushAudit, stageOf, cellStatus, cellLabel, ownerOf, mgrOf, blockPms, openNotes, openOn,
    detailMissing, review1Missing, review2Missing, matchImages, dueOf, planProgress, todo, planView,
    enterR2, enterR3, advance, advance3, advanceFinal, mgrPendingLevel, mgr3PendingLevel, notePurpose,
    reviewChain, flowSummary, cycleOf, roundOf, currentSeat, seatReviewer, effectiveExec, settingsMissing,
    categoryProgress, responsibleOf, sweep, notify, behind,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReviewRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
