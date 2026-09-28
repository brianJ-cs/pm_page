/* 審核系統雛形的資料層。
 *
 * 畫面**只**透過 window.ReviewStore 做事，而且每一支都是非同步的 ——
 * 本機模式也一樣，所以接上 Supabase 的時候畫面一行都不用改。
 *
 *   ReviewStore.auth.getSession()        有沒有登入（只看這台瀏覽器手上的權杖）
 *   ReviewStore.auth.signIn()            用 Google 登入；取消回 { cancelled:true }
 *   ReviewStore.auth.signOut()
 *   ReviewStore.auth.usePicker(fn)       本機模式才用：模擬的 Google 帳號選擇窗由畫面提供
 *   ReviewStore.api.publicBoard()        登入頁右邊那一欄（進行中的檔期、公告、找誰）—— 不用登入
 *   ReviewStore.api.whoami({ fresh })    **伺服器端**判斷：這個帳號進不進得來、他是誰
 *   ReviewStore.api.myLogins(n)          自己最近的登入紀錄
 *   ReviewStore.api.todo()               我的待辦
 *   ReviewStore.api.plans()              檔期清單（含走到哪）
 *   ReviewStore.api.plan(id)             一份檔期的全部內容（照身分過濾過）
 *   ReviewStore.api.act(action, payload) **唯一**改資料的路：驗證、改、記紀錄都在伺服器端
 *   ReviewStore.now()                    伺服器的「現在」（本機模式可以撥時鐘）
 *   ReviewStore.onChange(cb)             別的分頁登入／登出／改了資料
 *   ReviewStore.dev.*                    測試用（換人、改在職、撥時鐘、快轉、看紀錄、重設）
 *
 * ⚠️ **「是誰」只由登入狀態決定**：沒有任何一支收「我是某某」的參數。
 *    畫面說自己是誰不算數 —— 這就是實作指南 8.3「權限在後端驗證」。
 * ⚠️ **紀錄由伺服器端寫**（act／whoami 裡面），不是畫面自己寫：畫面寫得到的紀錄，也改得掉。
 *
 * 接 Supabase 的時候見最下面那一段和 WIRING.md：rules.js 整支搬到 Edge Function，
 * 這裡的每一支換成一個 fetch，回傳的形狀不變。
 */
(function () {
  'use strict';

  const R = window.ReviewRules, Seed = window.ReviewSeed;
  const cfg = window.REVIEW_BACKEND || { mode: 'local' };

  /* ======================================================================
     本機模式：資料存在這台瀏覽器，伺服器端那一半由這裡扮演
     ====================================================================== */
  const DB_KEY = 'review_demo_db_v5';
  const SESSION_KEY = 'review_demo_session_v1';
  const OTHER_KEY = 'review_demo_accounts_v1';   // 自己打過的 email，選帳號時像 Google 一樣記著
  const CLOCK_KEY = 'review_demo_clock_v1';      // 撥時鐘：跟真的時間差幾毫秒
  const DB_V = 5;

  const wait = ms => new Promise(r => setTimeout(r, ms));
  /* 故意慢一點：接上之後這一段就是去伺服器問的時間，
     現在就讓畫面把「確認中」「送出中」那個樣子做出來，不然接上那天才發現按了沒反應。 */
  const latency = (lo, hi) => wait(lo + Math.random() * (hi - lo));

  function readJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無痕、配額滿：這一趟就不存 */ } }
  function drop(k) { try { localStorage.removeItem(k); } catch { } }

  const clockOffset = () => +(readJSON(CLOCK_KEY) || 0);
  const now = () => Date.now() + clockOffset();

  function loadDb() {
    const d = readJSON(DB_KEY);
    if (d && d.v === DB_V) return d;
    try { localStorage.removeItem('review_demo_db_v1'); localStorage.removeItem('review_demo_db_v2'); localStorage.removeItem('review_demo_db_v3'); localStorage.removeItem('review_demo_db_v4'); } catch { }   // 舊版的形狀，丟掉
    const fresh = Object.assign({ v: DB_V, audit: [] }, Seed.build(now()));
    writeJSON(DB_KEY, fresh);
    return fresh;
  }
  const saveDb = d => writeJSON(DB_KEY, d);
  /* 時間到了該發的通知（延遲、截止前 4 小時、出稿日前 2 天）。
     接上之後是伺服器端的排程每 10 分鐘跑一次；本機模式沒有排程，就在每次讀資料的時候掃。 */
  function sweepSave(d) { R.sweep(d, now()); saveDb(d); }

  const REJECT_TEXT = {
    invalid_email: '不是有效的 email',
    not_registered: '不在人員名單裡',
    inactive: '人員資料標為離職',
  };

  function session() {
    const s = readJSON(SESSION_KEY);
    return s && typeof s.email === 'string' ? s : null;
  }

  function setSession(email, via) {
    const s = {
      email: R.normEmail(email),
      access_token: 'local-' + Math.random().toString(36).slice(2),
      created_at: new Date().toISOString(),
      via,                                     // google／dev（測試捷徑）
    };
    writeJSON(SESSION_KEY, s);
    return s;
  }

  /* 伺服器端每一支要登入的都先過這一關：權杖在不在、人還在不在職。
     離職的人手上還有權杖也不算數（人員資料一改，下一個請求就擋下來）。 */
  function requireMember(d) {
    const s = session();
    if (!s) return { ok: false, code: 'no_session' };
    const r = R.authorize(s.email, d);
    if (!r.ok) return r;
    return { ok: true, member: r.member };
  }

  let picker = null;

  const local = {
    mode: 'local',
    now,

    auth: {
      async getSession() { return session(); },

      usePicker(fn) { picker = fn; },

      async signIn() {
        if (!picker) throw new Error('本機模式要先 usePicker() 提供模擬的帳號選擇窗');
        const email = await picker();
        if (!email) return { cancelled: true };
        const e = R.normEmail(email);
        const d = loadDb();
        if (!d.members.some(m => R.normEmail(m.email) === e)) {
          const others = readJSON(OTHER_KEY) || [];
          if (!others.includes(e)) writeJSON(OTHER_KEY, [e, ...others].slice(0, 8));
        }
        setSession(e, 'google');
        return { ok: true };
      },

      async signOut() {
        const s = session();
        if (s) {
          const d = loadDb();
          const m = d.members.find(x => R.normEmail(x.email) === s.email);
          R.pushAudit(d, { who: m && m.employee_id, who_name: m && m.name, email: s.email, what: '登出', target: '帳號', result: '成功' }, now());
          saveDb(d);
        }
        drop(SESSION_KEY);
      },
    },

    api: {
      /* 登入頁右邊那一欄。**不用登入就讀得到**，所以只給名字、走到哪、截止時間 ——
         格子裡的商品、價格一個都不給（見最下面 SUPABASE 那一段的 public view）。 */
      async publicBoard() {
        const d = loadDb();
        return {
          plans: d.plans.map(p => Object.assign({ id: p.id, name: p.name, type: p.type, schedule: p.schedule }, R.planProgress(d, p.id))),
          announcements: d.announcements.slice(),
          support: Object.assign({}, d.support),
        };
      },

      /* fresh＝剛按完登入（要寫一筆「登入」）；重新整理只是確認權杖還算數，不重複記。
         被拒不管哪一種都記 —— 「未授權請求被拒」本來就是要留的紀錄（8.3）。 */
      async whoami({ fresh = false } = {}) {
        const s = session();
        if (!s) return { ok: false, code: 'no_session' };
        const d = loadDb();
        const r = R.authorize(s.email, d);
        if (!r.ok) {
          R.pushAudit(d, {
            who: r.member && r.member.employee_id, who_name: r.member && r.member.name,
            email: s.email, what: '登入被拒', target: '帳號', result: '失敗', detail: REJECT_TEXT[r.code] || r.code,
          }, now());
          saveDb(d);
          drop(SESSION_KEY);   // 伺服器不認這個權杖，這台瀏覽器就不該再拿著它
          return r;
        }
        if (fresh) {
          R.pushAudit(d, {
            who: r.member.employee_id, who_name: r.member.name, email: s.email,
            what: '登入', target: '帳號', result: '成功', detail: s.via === 'dev' ? '測試捷徑' : 'Google',
          }, now());
          saveDb(d);
        }
        return { ok: true, identity: R.identity(r.member, d, now()) };
      },

      async myLogins(n = 5) {
        const s = session();
        if (!s) return [];
        return loadDb().audit.filter(a => a.email === s.email && a.target === '帳號').slice(-n).reverse();
      },

      async todo() {
        await latency(120, 240);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        sweepSave(d);
        return { ok: true, items: R.todo(d, r.member.employee_id, now()) };
      },

      async plans() {
        await latency(80, 180);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        return { ok: true, plans: d.plans.map(p => Object.assign({ id: p.id, name: p.name, type: p.type, schedule: p.schedule }, R.planProgress(d, p.id))) };
      },

      async plan(id) {
        await latency(120, 240);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        sweepSave(d);
        const v = R.planView(d, r.member.employee_id, id, now());
        return v ? Object.assign({ ok: true, flow: R.flowSummary(d, id) }, v) : { ok: false, code: 'not_found' };
      },

      /* 進度確認（7.4）：所有人都看得到整份 DM，只看、不能操作 */
      async progress(id) {
        await latency(120, 220);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        sweepSave(d);
        const plan = d.plans.find(p => p.id === id);
        if (!plan) return { ok: false, code: 'not_found' };
        return { ok: true, plan: { id: plan.id, name: plan.name, type: plan.type, schedule: plan.schedule },
          rows: R.categoryProgress(d, id, now()), progress: R.planProgress(d, id), flow: R.flowSummary(d, id) };
      },

      async notifications() {
        await latency(60, 140);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        sweepSave(d);
        const mine = (d.notifications || []).filter(n => n.to === r.member.employee_id);
        return { ok: true, items: mine.slice(-60).reverse(), unread: mine.filter(n => !n.read).length };
      },

      async markRead(ids) {
        await latency(40, 90);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        const set = ids ? new Set(ids) : null;
        for (const n of d.notifications || []) if (n.to === r.member.employee_id && (!set || set.has(n.id))) n.read = true;
        saveDb(d);
        return { ok: true };
      },

      /* 最終審核者設定表（2.3）：誰都看得到，行銷才改得動（改走 act('settings.save')） */
      async settings() {
        await latency(80, 160);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        return {
          ok: true, settings: Object.assign({}, d.reviewerSettings),
          effectiveExec: R.effectiveExec(d), missing: R.settingsMissing(d),
          executives: [...new Set(d.assignments.map(a => a.executive_id))],
          members: d.members.filter(m => m.is_active !== false).map(R.publicMember),
        };
      },

      /* 職代（8.2）：全部列出來（原 PM、職代、指定人、期間、來源），以及「我能替誰指定」 */
      async delegations() {
        await latency(80, 160);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        const me = r.member.employee_id;
        const t0 = now();
        const nm = id => (d.members.find(m => m.employee_id === id) || { name: id || '' }).name;
        const pms = [...new Set(d.assignments.map(a => a.owner_id))];
        const canFor = pms.filter(pid => pid === me || d.assignments.some(a => a.owner_id === pid && (a.manager_id === me || a.director_id === me || a.executive_id === me)));
        const actor = R.actorOf(d, me, t0);
        const list = (d.delegations || []).map(x => {
          let status = 'active';
          if (x.cancelled_at) status = 'cancelled';
          else if (x.overridden_by) status = 'overridden';
          else if (+new Date(x.end) <= t0) status = 'ended';
          else if (+new Date(x.start) > t0) status = 'future';
          const cats = d.assignments.filter(a => a.owner_id === x.from_id).map(a => a.category_name);
          return Object.assign({}, x, {
            status, from_name: nm(x.from_id), to_name: nm(x.to_id), by_name: x.assigned_by ? nm(x.assigned_by) : '', categories: cats,
            canCancel: status !== 'cancelled' && status !== 'ended' && R.can(d, actor, 'deleg.cancel', { id: x.id }).ok,
          });
        }).sort((a, b) => b.start.localeCompare(a.start));
        return {
          ok: true, list,
          canFor: canFor.map(id => ({ id, name: nm(id), categories: d.assignments.filter(a => a.owner_id === id).map(a => a.category_name) })),
          people: d.members.filter(m => m.is_active !== false && m.role === 'pm').map(R.publicMember),
        };
      },

      /* 唯一改資料的路。畫面送的只有「做什麼、對哪一格」，是誰做的由登入狀態決定。 */
      async act(action, payload) {
        await latency(180, 380);
        const d = loadDb();
        const r = requireMember(d);
        if (!r.ok) return r;
        const res = R.act(d, r.member.employee_id, action, payload || {}, now());
        saveDb(d);   // 被拒也要存：那一筆「未授權操作被拒」的紀錄
        return res;
      },
    },

    onChange(cb) {
      window.addEventListener('storage', e => {
        if (e.key === SESSION_KEY) cb('session');
        else if (e.key === DB_KEY) cb('db');
        else if (e.key === CLOCK_KEY) cb('clock');
        else if (e.key === null) cb('reset');     // 別的分頁 localStorage.clear()
      });
    },

    /* 測試用。接上 Supabase 之後這一段不存在（正式站上沒有「換人」「快轉」這回事）。 */
    dev: {
      /* 模擬選擇窗裡列的帳號＝「這台電腦登入過的 Google 帳號」：
         名單上每一位（含已離職的）＋自己打過的 email。 */
      accounts() {
        const d = loadDb();
        const people = d.members.map(m => ({ name: m.name, email: m.email }));
        const others = (readJSON(OTHER_KEY) || []).map(e => ({ name: '', email: e }));
        return people.concat(others);
      },
      people() { return loadDb().members.map(R.publicMember); },
      async signInAs(key) {
        const d = loadDb();
        const k = String(key || '').trim();
        const m = d.members.find(x => x.employee_id === k || R.normEmail(x.email) === R.normEmail(k));
        setSession(m ? m.email : k, 'dev');
        return local.api.whoami({ fresh: true });
      },
      setActive(employee_id, on) {
        const d = loadDb();
        const m = d.members.find(x => x.employee_id === employee_id);
        if (!m) return;
        m.is_active = !!on;
        R.pushAudit(d, { what: on ? '人員恢復在職（測試）' : '人員標為離職（測試）', target: `人員 ${m.name}`, result: '成功' }, now());
        saveDb(d);
      },

      clockOffset,
      shiftClock(ms) { writeJSON(CLOCK_KEY, ms ? clockOffset() + ms : 0); },

      /* 快轉：把整份檔期推到某一關，不必每次從頭點。照「每個人都按了」的樣子補資料，
         所以快轉之後的畫面跟真的一路按過來的一樣（便利貼、草稿版、誰按的都有）。 */
      fastForward(planId, target) {
        const d = loadDb();
        // 快轉的站：前四站直接補資料；二校之後改用**真的動作**（R.act）照每個人按的樣子走，
        // 所以略過、退件、紀錄都跟一路點過來的一模一樣。
        const ORDER = ['提明細', '製作', '一校', '一改', '二校', '二校主管', '二改', '蓋章確認', '蓋章輪主管', '商品部確認完成', '審稿', '出稿'];
        const T = ORDER.indexOf(target);
        const t = now();
        const iso = new Date(t).toISOString();
        if (target === '提明細') {
          const fresh = Seed.build(t);
          d.blocks = d.blocks.filter(b => b.plan_id !== planId).concat(fresh.blocks.filter(b => b.plan_id === planId));
          d.cells = d.cells.filter(c => c.plan_id !== planId).concat(fresh.cells.filter(c => c.plan_id === planId));
          d.notes = d.notes.filter(n => n.plan_id !== planId);
          d.traces = {};
        }
        const cells = d.cells.filter(c => c.plan_id === planId);
        const blocks = d.blocks.filter(x => x.plan_id === planId);
        if (target === '提明細') { const pl = d.plans.find(p => p.id === planId); delete pl.final; delete pl.published; delete pl.flags; d.notifications = []; d.sent = {}; d.lateNow = {}; }
        const owner = c => R.ownerOf(d, c);
        const designer = 'E20011';
        const hist = (c, who, what) => (c.hist = c.hist || []).push({ at: iso, who, name: (d.members.find(m => m.employee_id === who) || {}).name || '系統', what, detail: '快轉' });
        for (const c of cells) {
          if (T >= 1 && c.stage === '提明細') {
            const prods = d.products.filter(x => x.category_id === c.category_id);
            const pr = prods[(c.idx - 1) % prods.length];
            c.detail = { sku: pr.sku, brand: pr.brand, name: pr.name, spec: pr.spec, price: pr.price, info: pr.info };
            if (c.idx === 1 && c.category_id === '103') c.gifts = [{ sku: 'GF-FAN-12', name: '聲寶 12 吋桌扇' }];
            if (c.idx === 1 && c.category_id === '203') c.gifts = [{ sku: 'GF-BUDS', name: 'Galaxy Buds FE' }];
            c.stage = '製作';
            c.submitted = { by: owner(c), as: owner(c), acting: false, at: iso };
            hist(c, owner(c), '提明細完成');
          }
          if (T >= 2 && c.stage === '製作') {
            c.stage = '一校';
            c.made = { by: designer, at: iso };
            const old = d.traces[c.detail.sku];
            d.traces[c.detail.sku] = { official: old ? old.official : null, draft: { v: (old && old.draft ? old.draft.v : 0) + 1, at: iso, plan_id: planId, cell_id: c.id, detail: Object.assign({}, c.detail), gifts: c.gifts.slice(), images: R.matchImages(c.detail.sku, d.imageFiles) } };
            hist(c, designer, '製作完成');
          }
        }
        const SAMPLE = [
          ['修改', c => `價格改成活動價 ${Math.max(0, (+c.detail.price || 0) - 1000).toLocaleString()}`],
          ['補貼紙', () => '補一張「一級能效」貼紙'],
          ['換品', () => '換成同系列另一個容量，型號我晚點補在留言'],
        ];
        for (const b of blocks) {
          const bc = cells.filter(c => c.block_id === b.id);
          if (T >= 3 && !b.phase) {
            bc.forEach((c, i) => {
              c.reviewed = true;
              if (i % 3 === 1 && !d.notes.some(n => n.cell_id === c.id)) {
                const [kind, text] = SAMPLE[i % SAMPLE.length];
                const m = d.members.find(x => x.employee_id === owner(c));
                d.notes.push({ id: 'n' + t.toString(36) + i + b.id, plan_id: planId, block_id: b.id, cell_id: c.id, author: m.employee_id, author_name: m.name, author_role: 'pm', kind, text: text(c), stage: '一校', purpose: '一校', level: null, ctx: '', status: 'open', created_at: iso, replies: [], resolved_by: null, resolved_at: null });
              }
              hist(c, owner(c), '一校完成');
            });
            for (const pid of R.blockPms(d, b.id)) b.pm_done[pid] = b.pm_done[pid] || { by: pid, acting: false, at: iso };
            b.phase = '一改';
            for (const c of bc) c.fix = d.notes.some(n => n.cell_id === c.id && n.status === 'open');
          }
          if (T >= 4 && b.phase === '一改') {
            for (const n of d.notes) if (n.block_id === b.id && n.status === 'open') { n.status = 'resolved'; n.resolved_by = designer; n.resolved_at = iso; }
            b.masthead_ok = true;
            for (const c of bc) hist(c, designer, '一改完成');
            R.enterR2(d, b);
          }
          if (T >= 5 && b.phase === '二校') {
            R.blockPms(d, b.id).forEach((pid, k) => {
              const mine = bc.filter(c => owner(c) === pid);
              mine.forEach(c => R.act(d, pid, 'r2.mark', { cell_id: c.id, done: true }, t));
              if (k === 0 && mine[1]) R.act(d, pid, 'note.add', { cell_id: mine[1].id, kind: '修改', text: '規格字級放大一點（二改再改就好）' }, t);
              R.act(d, pid, 'block.r2pm', { block_id: b.id, as_pm: pid }, t);
            });
          }
          if (T >= 6 && b.phase === '二校') {
            for (const L of [3, 2]) {
              for (const mid of new Set(bc.map(c => R.mgrOf(d, c, L)))) R.act(d, mid, 'mgr.submit', { block_id: b.id, level: L }, t);
            }
          }
        }
        const plan = d.plans.find(p => p.id === planId);
        if (T >= 7) for (const b of blocks) {
          if (b.phase !== '二改') continue;
          for (const n of d.notes) if (n.block_id === b.id && n.status === 'open') { n.status = 'resolved'; n.resolved_by = designer; n.resolved_at = iso; }
          R.act(d, designer, 'block.mh2', { block_id: b.id, ok: true }, t);
          R.act(d, designer, 'block.fix2', { block_id: b.id }, t);
        }
        if (T >= 8) for (const c of cells) if (c.r3 && !c.r3.stamp && !c.r3.cycle) R.act(d, owner(c), 'stamp', { cell_id: c.id }, t);
        if (T >= 9) for (const L of [3, 2]) for (const mid of new Set(cells.map(c => R.mgrOf(d, c, L)))) R.act(d, mid, 'mgr3.submit', { plan_id: planId, level: L }, t);
        if (T >= 10 && plan.final && !plan.final.sent) R.act(d, plan.created_by, 'final.send', { plan_id: planId }, t);
        if (T >= 11) for (let k = 0; k < 3; k++) { const st = R.currentSeat(plan); if (st) R.act(d, R.seatReviewer(d, st), 'final.submit', { plan_id: planId }, t); }
        R.pushAudit(d, { what: '快轉（測試）', target: `檔期 ${planId}`, result: '成功', detail: `到${target}` }, t);
        saveDb(d);
      },

      /* 07:00 差勤同步失敗（8.2 第 7 點、7.5）：通知系統管理者，以及當天有請假紀錄的 PM 的課長。
         人員資料裡沒有「系統管理者」這個人，本機模式只發給課長。 */
      syncFail() {
        const d = loadDb();
        const t0 = now();
        const leave = (d.delegations || []).filter(x => x.source === 'sync' && +new Date(x.start) <= t0 && t0 < +new Date(x.end)).map(x => x.from_id);
        const bosses = [...new Set(d.assignments.filter(a => leave.includes(a.owner_id)).map(a => a.manager_id))];
        R.notify(d, bosses, '今天 07:00 差勤同步失敗，請手動確認請假的 PM 有沒有職代', '#/delegates', t0, 'sync');
        R.pushAudit(d, { what: '差勤同步失敗（測試）', target: '差勤同步', result: '失敗', detail: '通知 ' + bosses.length + ' 位課長' }, t0);
        saveDb(d);
        return bosses.length;
      },
      allAudit() { return loadDb().audit.slice().reverse(); },
      reset() { drop(DB_KEY); drop(OTHER_KEY); drop(SESSION_KEY); drop(CLOCK_KEY); },
    },
  };

  /* ======================================================================
     SUPABASE：接線的時候照這裡填，畫面不必改
     ----------------------------------------------------------------------
     還沒接。每一支對應哪一個端點先寫下來，方法名稱和回傳的形狀跟上面本機那一份一模一樣。

     auth.getSession()   讀 Supabase 存在這台瀏覽器的權杖（登入轉回來時網址 hash 帶著）
     auth.signIn()       location = `${url}/auth/v1/authorize?provider=google&redirect_to=<這一頁>`
                         整頁轉走，所以永遠不會 resolve；轉回來之後頁面照常 boot，
                         發現有權杖就叫 whoami({ fresh:true })（第一次見到這個權杖＝剛登入）
     auth.signOut()      POST /auth/v1/logout
     api.publicBoard()   GET /rest/v1/public_board（一個 view：檔期名稱、走到哪、截止時間、公告、找誰）
                         ⚠️ 給 anon 讀，所以**只能有這幾欄**；檔期名稱算不算機密要問公司
     api.whoami()        POST /functions/v1/review（{ op:'whoami', fresh }）
                         用 JWT 的 email 查 members，查不到／離職就回 { ok:false, code } 並寫 audit_log；
                         查到回 identity（rules.js 的 identity）。見 WIRING.md
     api.myLogins(n)     GET /rest/v1/audit_log?email=eq.<自己>&target=eq.帳號&order=at.desc&limit=n
     api.todo()          POST /functions/v1/review（{ op:'todo' }）
     api.plans()         同上（{ op:'plans' }）
     api.plan(id)        同上（{ op:'plan', id }）→ rules.planView
     api.act(a, p)       同上（{ op:'act', action:a, payload:p }）→ rules.act
                         Edge Function 用 JWT 認人，讀資料、跑 rules.js、寫回去，
                         整段包在一個交易裡（兩個人同時按同一個版位的一校完成，只能有一個人讓它換關）
     api.progress(id)    同上（{ op:'progress', id }）→ rules.categoryProgress
     api.notifications() GET /rest/v1/notifications?to=eq.<自己>&order=at.desc&limit=60（RLS：只讀得到自己的）
     api.markRead(ids)   PATCH /rest/v1/notifications?id=in.(…)（RLS：只改得到自己的 read 欄位）
     api.settings()      GET /rest/v1/reviewer_settings；改走 act('settings.save')
     api.delegations()   GET /rest/v1/delegations；指定、取消走 act('deleg.add'／'deleg.cancel')
     延遲通知            排程的 Edge Function，每 10 分鐘跑一次 rules.sweep
     now()               伺服器時間（沒有撥時鐘）
     onChange(cb)        Supabase Realtime 訂 cells／blocks／notes，或跟主程式一樣 5 秒輪詢
     ====================================================================== */
  const notWired = name => async () => { throw new Error(`Supabase 模式還沒接線：${name}`); };
  const supabase = {
    mode: 'supabase',
    now: () => Date.now(),
    auth: {
      getSession: notWired('auth.getSession'),
      signIn: notWired('auth.signIn'),
      signOut: notWired('auth.signOut'),
      usePicker() { },
    },
    api: {
      publicBoard: notWired('api.publicBoard'), whoami: notWired('api.whoami'), myLogins: notWired('api.myLogins'),
      todo: notWired('api.todo'), plans: notWired('api.plans'), plan: notWired('api.plan'), act: notWired('api.act'),
      progress: notWired('api.progress'), notifications: notWired('api.notifications'), markRead: notWired('api.markRead'),
      settings: notWired('api.settings'), delegations: notWired('api.delegations'),
    },
    onChange() { },
    dev: null,
  };

  window.ReviewStore = cfg.mode === 'supabase' ? supabase : local;
})();
