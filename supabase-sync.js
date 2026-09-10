/* supabase-sync.js —— 落版單系統 和 編輯器 共用的同步層。
 *
 * 零相依：只用 fetch 打 Supabase 自動生出來的 REST 端點（PostgREST），不引任何 CDN
 * 函式庫 —— 這兩支的重點就是「瀏覽器直接開就是完整的程式」，不想為了同步破壞它。
 *
 * 掛在 window.PlanSync 上。兩支 HTML 的程式碼都包在 IIFE 裡（讀不到彼此的變數），
 * window 是唯一的交會點，所以這裡刻意只暴露這一個名字。
 *
 * 上傳一律走 queueUpsert()：拼板拖一次會存很多次檔，直接送就是打爆 Supabase。
 */
(function () {
  const CFG = window.SUPABASE || {};
  const url = String(CFG.url || '').trim().replace(/\/+$/, '');
  const key = String(CFG.anonKey || '').trim();

  /* 佔位符還沒換掉就當作沒設定。半設定的部署每次存檔都打出一顆 401，比完全沒接更難查。 */
  const configured = /^https?:\/\/.+/.test(url) && key.length > 20 && !/YOUR-/i.test(url + key);
  const BASE = configured ? url + '/rest/v1' : null;

  /* 上傳的 debounce。拼板拖一次會存很多次檔，直接送就是打爆 Supabase ——
     但這一段也直接算進「對方多久看得到」，所以壓到還擋得住連發的最小值。
     一次拖曳大概每 16ms 一次事件，250ms 仍然把一整串收成一發。 */
  const DEBOUNCE = 250;

  const headers = () => ({
    'apikey': key,
    'Authorization': 'Bearer ' + (CFG.accessToken || key),
    'Content-Type': 'application/json'
  });

  /* 唯讀（config.js 的 readOnly）＝示範版。讀得到共用的商品目錄和商品圖，**什麼都不寫**：
     ok() 回 false，所以檔期、便利貼、心跳、貼紙庫、上傳全部走「沒接後端」那條路
     （只存這台瀏覽器），只有 canRead() 那幾條讀的路是通的。
     為什麼不直接給一份空的設定：那樣商品目錄整片空白，示範的人什麼都挑不到。 */
  const readOnly = !!CFG.readOnly;
  const ok = () => !!BASE && !readOnly;
  const canRead = () => !!BASE;

  /* ---------------------------------------------------------------- REST --- */

  /* 「我相信伺服器上那一版是什麼時候的」。三個地方會更新它：整包拉、拉幾筆、
     自己上傳成功。**輪詢（pullIndex）不更新** —— 它是去探的，不是去讀的，
     探到的東西還沒進到本機，先記下來就等於承認沒發生的事。 */
  const stamps = new Map();
  const stampOf = id => stamps.get(id) || null;

  async function pullAll(table = 'plans') {
    if (!ok()) return null;
    const r = await fetch(`${BASE}/${table}?select=id,data,updated_at`, { headers: headers() });
    if (!r.ok) throw new Error(`pull ${table} ${r.status} ${await r.text()}`);
    const rows = (await r.json()).filter(x => table !== 'plans' || isPlanRow(x));
    if (table === 'plans') rows.forEach(x => { stamps.set(x.id, x.updated_at); noteBase(x.id, x.data); });
    return rows;
  }

  /* 輪詢用的：只要 id 和時間，二十個檔期大概 1～2 KB。
     ⚠️ `updated_at` 是**用戶端自己寫上去的**（見 upsert），兩台電腦時鐘差幾秒就會
     排錯順序 —— 所以外面只准比「一不一樣」，不准比「誰比較新」。 */
  async function pullIndex() {
    if (!ok()) return null;
    /* 順便帶「最後是誰改的」：一個短字串而已，卻讓輪詢完全不必去抓開著那一檔的內容
       —— 抓了就會把時間戳記成「看過了」，可是資料根本沒吃進來。
       `lastById` 是給程式比對的（名字可能重複），`lastBy` 是給人看的。 */
    const r = await fetch(
      `${BASE}/plans?select=id,updated_at,lastBy:data->>lastBy,lastById:data->>lastById`,
      { headers: headers() });
    if (!r.ok) throw new Error(`index plans ${r.status} ${await r.text()}`);
    return (await r.json()).filter(isPlanRow);
  }

  /** 只把變了的那幾筆抓回來 —— 整包 143 KB，為了一筆改動全抓太貴。 */
  async function pullSome(ids, table = 'plans') {
    if (!ok() || !ids || !ids.length) return [];
    const list = ids.map(id => '"' + String(id).replace(/"/g, '\\"') + '"').join(',');
    const r = await fetch(`${BASE}/${table}?id=in.(${list})&select=id,data,updated_at`,
                          { headers: headers() });
    if (!r.ok) throw new Error(`pullSome ${table} ${r.status} ${await r.text()}`);
    const rows = (await r.json()).filter(x => table !== 'plans' || isPlanRow(x));
    if (table === 'plans') rows.forEach(x => { stamps.set(x.id, x.updated_at); noteBase(x.id, x.data); });
    return rows;
  }

  async function upsert(rows, table = 'plans') {
    if (!ok() || !rows.length) return;
    /* 一批共用同一個時間戳，而且要記得起來：上傳成功之後這就是「我相信伺服器上的
       那一版」。不記的話下一次輪詢會把自己剛寫的東西當成別人改的。 */
    const stamp = new Date().toISOString();
    const body = rows.map(x => ({ id: x.id, data: x.data, updated_at: stamp }));
    const r = await fetch(`${BASE}/${table}`, {
      method: 'POST',
      headers: Object.assign(headers(), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`upsert ${table} ${r.status} ${await r.text()}`);
    if (table === 'plans') rows.forEach(x => stamps.set(x.id, stamp));
  }

  async function remove(ids, table = 'plans') {
    if (!ok() || !ids.length) return;
    /* id 是使用者取不到名字的內部字串（p1721…、seed-2、imp-…），還是用雙引號包起來，
       免得哪天有人塞進逗號就把 in.() 拆錯。 */
    const list = ids.map(id => '"' + String(id).replace(/"/g, '\\"') + '"').join(',');
    const r = await fetch(`${BASE}/${table}?id=in.(${list})`, { method: 'DELETE', headers: headers() });
    if (!r.ok) throw new Error(`delete ${table} ${r.status} ${await r.text()}`);
    if (table === 'plans') ids.forEach(id => stamps.delete(id));
  }

  /* --------------------------------------------------------- 商品圖上傳 --- */

  /* 圖走 Storage，不走資料表：一張 DM 上百個商品，base64 塞進 plan 會讓每次存檔
     都重傳好幾 MB，localStorage 也會爆。這裡上傳完只把「網址」交回去，
     存進 plan 的就只有那串網址。 */
  const BUCKET = String(CFG.bucket || 'product-images');

  /* Storage 的檔名只吃 ASCII —— 中文品名直接丟會回 InvalidKey。所以拆成兩半：
     看得懂的那半只留 A-Z0-9-（中文會被磨掉），後面接一段雜湊把原名補回來。
     雜湊是固定的，所以同一個商品永遠是同一個檔名，重傳才蓋得掉舊的。 */
  function storageName(name) {
    const raw = String(name).replace(/\.[A-Za-z0-9]+$/, '');       // 去副檔名再算
    const ext = (String(name).match(/\.[A-Za-z0-9]+$/) || ['.png'])[0];
    const ascii = raw.replace(/[^A-Za-z0-9._-]+/g, '-')
                     .replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
    let h = 2166136261;                                            // FNV-1a
    for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (ascii ? ascii + '-' : '') + (h >>> 0).toString(36) + ext;
  }

  async function uploadImage(name, blob) {
    if (!ok()) throw new Error('沒有接後端，圖存不起來');
    const path = storageName(name);
    const r = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + (CFG.accessToken || key),
        'Content-Type': blob.type || 'image/png',
        /* 同一個商品換圖＝蓋掉舊的，不要愈積愈多。
           ⚠️ 副檔名也算在路徑裡：改用 WebP 之後，本來有 `.png` 的那幾支會多留一個
           舊物件（目錄裡存的是網址，指的是新的那一個，所以畫面上是對的）。
           之後每一次都是 `.webp` 蓋 `.webp`，不會繼續長。 */
        'x-upsert': 'true'
      },
      body: blob
    });
    if (!r.ok) throw new Error(`上傳失敗 ${r.status} ${await r.text()}`);
    /* 後面那個 ?v= 是必要的，不是裝飾：同一個商品換第二張圖，檔名一模一樣
       （才蓋得掉舊的），網址不變的話瀏覽器會直接給你快取裡的舊圖 ——
       看起來就像「換不了」。每次換圖給一個新的 v，它才會重抓。 */
    return `${url}/storage/v1/object/public/${BUCKET}/${path}?v=${Date.now()}`;
  }

  /* ------------------------------------------------------------ 排隊上傳 --- */

  /* ---- 條件寫入（CAS）＋ 合併 -------------------------------------------
     以前是「整包蓋上去」：設計搬一列的同時 PM 在挑貨，後存的把另一個人整本 DM
     的工作抹掉 —— 不是一格，是全部。

     現在的寫法：
       1. 樂觀地直接 CAS —— PATCH 帶 `updated_at=eq.<我以為的那一版>`。
          沒人插隊就一次就過，**不必先讀一次**（整包 143 KB，能不讀就不讀）。
       2. 回來是空陣列＝有人插隊了。這時候才把遠端讀回來，交給上層合併，再 CAS 一次。
       3. 重試有上限：一直撞就是真的在搶，與其無限重試不如讓上層講一句。

     合併規則由上層給（setMerge）—— 只有它知道 plan 長什麼樣子。
     這裡只負責「怎麼安全地寫進去」。 */
  const bases = new Map();     // id -> 上次同步成功時的樣子（JSON 字串），三方合併的「祖先」
  let mergeFn = null;          // (mine, base, theirs) => report；**就地改 mine**
  let onMerge = null;          // 合併過就叫一次，讓上層去重畫、去講一句
  const setMerge = (fn, after) => { mergeFn = fn; onMerge = after || null; };
  /* 「這一筆真的躺在伺服器上了」。上層拿它來放掉「我有還沒送出去的東西」那個旗子 ——
     送出去之後就沒有什麼要保護的了，別人的版本可以直接吃進來。
     跟 onMerge 分開：那個只在合併過才叫，這個是每一次寫成功都叫。 */
  let onSaved = null;
  const setSaved = fn => { onSaved = fn; };
  const baseOf = id => { const t = bases.get(id); return t ? JSON.parse(t) : null; };
  const noteBase = (id, data) => { try { bases.set(id, JSON.stringify(data)); } catch (e){} };

  /** 條件寫入。回傳新的 updated_at，或 null＝有人插隊（或這一列還不存在）。 */
  async function casWrite(id, data, expect) {
    const stamp = new Date().toISOString();
    const q = expect ? `?id=eq.${encodeURIComponent(id)}&updated_at=eq.${encodeURIComponent(expect)}`
                     : `?id=eq.${encodeURIComponent(id)}`;
    const r = await fetch(`${BASE}/plans${q}`, {
      method: 'PATCH',
      headers: Object.assign(headers(), { 'Prefer': 'return=representation' }),
      body: JSON.stringify({ data, updated_at: stamp })
    });
    if (!r.ok) throw new Error(`cas ${r.status} ${await r.text()}`);
    const rows = await r.json();
    return rows.length ? stamp : null;
  }

  /** 讀一列回來（合併要用）。不動 stamps —— 那是「我吃進來了」的意思。 */
  async function readOne(id) {
    const r = await fetch(`${BASE}/plans?id=eq.${encodeURIComponent(id)}&select=id,data,updated_at`,
                          { headers: headers() });
    if (!r.ok) throw new Error(`read ${r.status} ${await r.text()}`);
    const rows = await r.json();
    return rows[0] || null;
  }

  /* 一個檔期寫上去。合併失敗（真的兩邊都改同一塊）不是錯誤 —— 上層會被告知。 */
  async function writeOne(plan, report) {
    const id = plan.id;
    // 沒有 base 就是這台機器沒同步過它：當成新的，直接 upsert（POST 會建也會蓋）
    if (!stamps.has(id)){ await upsert([{ id, data: plan }]); noteBase(id, plan); return; }

    for (let tries = 0; tries < 3; tries++){
      const expect = stamps.get(id);
      let stamp = null;
      try { stamp = await casWrite(id, plan, expect); }
      catch (e){ throw e; }
      if (stamp){ stamps.set(id, stamp); noteBase(id, plan); return; }

      /* 有人插隊。把他那一份讀回來合併 —— 合併是就地改 plan，所以使用者手上握著的
         那個物件本身會變成「合併後的」，不會變成孤兒。 */
      const row = await readOne(id);
      if (!row){ await upsert([{ id, data: plan }]); noteBase(id, plan); return; }  // 被刪掉了
      stamps.set(id, row.updated_at);
      if (mergeFn){
        const r = mergeFn(plan, baseOf(id), row.data) || {};
        /* 累加，不是覆蓋：重試三次的話每一次都可能合到東西。
           ⚠️ 要**逐欄搬**，漏一個就掉一件事 —— 掉 notes 只是少一句提示，
           掉 rebuilt 是畫面不會重建（骨架換成他的了，螢幕上還是舊的那一棵）。 */
        if (report){
          report.merged    = (report.merged || 0) + (r.took || 0);
          report.notes     = (report.notes  || 0) + (r.notes || 0);
          report.conflicts = (report.conflicts || []).concat(r.conflicts || []);
          report.rebuilt   = report.rebuilt || !!r.rebuilt;
          report.by        = r.by || report.by;
          /* 「合併前每一格長什麼樣」：重試三次就合三次，要留**最早**那一份 ——
             它才是使用者螢幕上現在那一版，也就是要拿來比對的基準。 */
          report.wasCells  = report.wasCells || r.wasCells;
        }
      }
    }
    /* 三次都被插隊：對方正在連續寫入。放棄這一輪，下一次存檔會再試 ——
       本機那一份已經存好了，不會不見。 */
    throw new Error('cas: 一直被插隊，這一輪先放棄');
  }

  const dirty = new Map();     // id -> plan（送的是當下最新的物件，不是排隊當時的快照）
  const doomed = new Set();    // id -> 要刪掉的
  let timer = 0;
  let chain = Promise.resolve();   // 一次只送一批，不然刪掉的可能被慢一拍的 upsert 救回來
  let warned = false;

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; flush(); }, DEBOUNCE);
  }

  function queueUpsert(plan) {
    if (!ok() || !plan || !plan.id) return;
    doomed.delete(plan.id);
    dirty.set(plan.id, plan);
    schedule();
  }

  function queueRemove(id) {
    if (!ok() || !id) return;
    dirty.delete(id);
    doomed.add(id);
    schedule();
  }

  /* 回傳的 promise 等到這一批真的送完 —— 「提交給設計」要先 await 它再跳頁，
     不然跳過去的編輯器會拉不到剛剛那個檔期。 */
  function flush() {
    clearTimeout(timer); timer = 0;
    if (!ok()) return Promise.resolve();
    const rows = [...dirty.values()].map(p => ({ id: p.id, data: p }));
    const gone = [...doomed];
    dirty.clear(); doomed.clear();
    if (!rows.length && !gone.length) return chain;

    chain = chain.then(async () => {
      try {
        /* 一個一個寫：每一個檔期各自 CAS、各自合併。整批 upsert 沒有辦法只重試
           撞到的那一個。 */
        for (const r of rows){
          const report = {};
          await writeOne(r.data, report);
          if (onMerge && (report.merged || (report.conflicts || []).length)) onMerge(r.id, report);
          /* 合併報告之後才講「存好了」：上層收到這一句就會放掉旗子，
             而合併有可能剛把對方的東西併進來 —— 那一份也是這一次寫進去的。 */
          if (onSaved) onSaved(r.id);
        }
        if (gone.length) await remove(gone);
        warned = false;
      } catch (e) {
        /* 網路斷了不該把人擋住：本機的 localStorage 已經存好了，這裡只是沒同步出去。
           每次斷線只吵一次，不然拖曳一整輪會刷滿 console。 */
        if (!warned) { warned = true; console.warn('同步上傳失敗，這次的變更只存在本機', e); }
      }
    });
    return chain;
  }

  /* ----------------------------------------------------------- 誰在看哪裡 --- */

  /* 「設計 B 正在看版位 3」。**沒有另外開一張表** —— 目前所有東西都只靠 anon key
     打 REST，一旦要 create table 就多一個未必隨時拿得到的權限。所以借 plans 這張表，
     用 `__presence:<userId>` 當 id。
       ・一個人只寫自己那一列 → 心跳之間永遠不會互相覆蓋（這是選「一人一列」而不是
         「大家共用一列」的唯一理由）。
       ・不碰 stamps：`stampOf()` 的意思是「我相信伺服器上那一份檔期是哪一版」，
         心跳不是檔期。
     ⚠️ 代價是 plans 裡混進了不是檔期的列。**所有讀的路徑都要過 isPlanRow()**，
     漏一個就會在檔期列表上冒出一張壞掉的卡。 */
  const PRESENCE_PREFIX = '__presence:';
  const isPlanRow = r => !!r && !!r.id && !String(r.id).startsWith(PRESENCE_PREFIX);

  /** 我在哪裡。body = { name, role, planId, blockId, at }。整列很小，幾百 byte。 */
  async function pushPresence(userId, body) {
    if (!ok() || !userId) return;
    await fetch(`${BASE}/plans`, {
      method: 'POST',
      headers: Object.assign(headers(), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ id: PRESENCE_PREFIX + userId, data: body,
                              updated_at: new Date().toISOString() }])
    }).catch(() => {});      // 心跳掉一拍不算錯，下一拍就補回來了
  }

  /** 別人在哪裡。九個人也才九列，一次幾百 byte。 */
  async function pullPresence() {
    if (!ok()) return [];
    const r = await fetch(`${BASE}/plans?id=like.${PRESENCE_PREFIX}*&select=id,data`,
                          { headers: headers() });
    if (!r.ok) return [];
    const rows = await r.json();
    return rows.map(x => Object.assign({ userId: String(x.id).slice(PRESENCE_PREFIX.length) },
                                       x.data || {}));
  }

  /** 走的時候把自己那一列清掉，不然要等它過期才會消失。 */
  async function dropPresence(userId) {
    if (!ok() || !userId) return;
    await remove([PRESENCE_PREFIX + userId]).catch(() => {});
  }

  /* ------------------------------------------------------- 商品目錄（共用） --- */

  /* 目錄是「全公司一份」，不屬於任何一個檔期，所以住在自己那張表的單一列上。
     整包 jsonb 存：它是參考資料，改的頻率低（多半是一次貼一批），
     為了它去拆成一列一個商品，收益不大、要接的地方卻多很多。 */
  const CAT_ID = 'default';

  /* 目錄跟檔期是同一個問題，而且更嚴重：**全公司只有這一列**。兩個人各自貼一批
     商品進來，後存的把先存的整批抹掉 —— 所以這裡也走條件寫入＋合併，跟 plans 同一套。 */
  let catStamp = null, catBase = null, catMergeFn = null;
  const setCatalogueMerge = fn => { catMergeFn = fn; };

  async function pullCatalogue() {
    if (!canRead()) return null;                       // 示範版（唯讀）也讀
    const r = await fetch(`${BASE}/catalogue?id=eq.${CAT_ID}&select=data,updated_at`,
                          { headers: headers() });
    if (r.status === 404) return null;                 // 表還沒建，當作沒有
    if (!r.ok) throw new Error(`pull catalogue ${r.status} ${await r.text()}`);
    const rows = await r.json();
    if (!rows.length) return null;
    catStamp = rows[0].updated_at;
    try { catBase = JSON.stringify(rows[0].data); } catch (e){ catBase = null; }
    return rows[0].data;
  }

  /** 讀那一列，什麼都不記 —— 合併要的是「對方現在長什麼樣」，不是「我看過了」。 */
  async function readCatalogueRow() {
    const r = await fetch(`${BASE}/catalogue?id=eq.${CAT_ID}&select=data,updated_at`,
                          { headers: headers() });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  }

  async function writeCatalogue(data) {
    if (catStamp == null){                             // 這台機器還沒讀過它：直接建
      await upsert([{ id: CAT_ID, data }], 'catalogue');
      catStamp = null; catBase = null;                 // 下一次 pull 才知道是哪一版
      return {};
    }
    const report = {};
    for (let tries = 0; tries < 3; tries++){
      const stamp = new Date().toISOString();
      const r = await fetch(
        `${BASE}/catalogue?id=eq.${CAT_ID}&updated_at=eq.${encodeURIComponent(catStamp)}`, {
          method: 'PATCH',
          headers: Object.assign(headers(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify({ data, updated_at: stamp })
        });
      if (!r.ok) throw new Error(`cas catalogue ${r.status} ${await r.text()}`);
      if ((await r.json()).length){
        catStamp = stamp;
        try { catBase = JSON.stringify(data); } catch (e){}
        return report;
      }
      /* 有人插隊：讀回來合併（就地改 data），再試一次。
         ⚠️ **不能用 pullCatalogue()** —— 它會順手把 catBase 也換成剛讀到的那一份，
         而那正是「對方」。祖先一旦變成對方，三方合併就會把他新加的東西當成
         「祖先本來就有、我刪掉了」而丟掉。讀要讀得乾淨。 */
      const row = await readCatalogueRow();
      const cur = row && row.data;
      if (row) catStamp = row.updated_at;
      if (catMergeFn && cur){
        const rr = catMergeFn(data, catBase ? JSON.parse(catBase) : null, cur) || {};
        report.took = (report.took || 0) + (rr.took || 0);
        report.conflicts = (report.conflicts || 0) + (rr.conflicts || 0);
      }
    }
    throw new Error('cas catalogue: 一直被插隊，這一輪先放棄');
  }

  let catTimer = 0, catPending = null;
  function queueCatalogue(data) {
    if (!ok()) return;
    catPending = data;
    clearTimeout(catTimer);
    catTimer = setTimeout(async () => {
      const body = catPending; catPending = null;
      try {
        const report = await writeCatalogue(body);
        if (onCatalogueMerged && (report.took || report.conflicts)) onCatalogueMerged(body, report);
      }
      catch (e) { console.warn('商品目錄上傳失敗，這次的變更只存在本機', e); }
    }, DEBOUNCE);
  }
  let onCatalogueMerged = null;
  const setCatalogueAfter = fn => { onCatalogueMerged = fn; };

  /* ------------------------------------------------------- 品牌 Logo 庫 --- */

  /* Logo 庫住在另一個 Supabase 專案（見 config.js 的 LOGO_SUPABASE）。
     這裡**只讀不寫**：拿「品牌名 → 那張 logo 的公開網址」而已。
     為什麼不叫那一頁自己報上來：那樣要等有人打開它才有得用，
     而版面一載進來就該畫得出品牌 logo。

     名字要正規化再比對：商品目錄裡打的是 `HITACHI`，Logo 庫裡可能是 `Hitachi`；
     大小寫、空白、全形空白、`.`／`-`／`_` 都不該算差別。
     `alt_name` 是同一家公司的另一種寫法（Panasonic ↔ 國際牌），
     兩個名字都指到同一張圖 —— 商品那邊寫哪一種都找得到。 */
  const normBrand = v => String(v == null ? '' : v)
    .trim().toLowerCase().replace(/[\s　._\-]+/g, '');

  async function pullLogos() {
    const c = window.LOGO_SUPABASE || {};
    const u = String(c.url || '').trim().replace(/\/+$/, '');
    const k = String(c.anonKey || '').trim();
    if (!/^https?:\/\/.+/.test(u) || k.length < 20) return null;   // 沒設定＝這個功能關著

    const r = await fetch(
      `${u}/rest/v1/companies?select=name,alt_name,deleted_at,logos(path,deleted_at)`,
      { headers: { apikey: k, Authorization: 'Bearer ' + k } });
    if (!r.ok) throw new Error(`pull logos ${r.status} ${await r.text()}`);

    const bucket = c.bucket || 'logos';
    const out = Object.create(null);
    (await r.json()).forEach(co => {
      if (!co || co.deleted_at) return;
      /* 一家公司只會有一張活著的 logo（那邊用 partial unique index 保證的），
         真的有第二張就取第一張 —— 這裡不是決定哪一張才算數的地方。 */
      const live = (co.logos || []).find(l => l && !l.deleted_at && l.path);
      if (!live) return;
      const url = `${u}/storage/v1/object/public/${bucket}/${live.path}`;
      [co.name, co.alt_name].forEach(n => {
        const key = normBrand(n);
        if (key) out[key] = url;
      });
    });
    return out;
  }

  /* 換掉某一家的 logo。**這是這一層唯一會寫進 Logo 庫的路**（其他都只讀）——
     排版的人在版上看得出「這個牌子的圖不對」，而他手上就有對的那一張；
     叫他記得再開一次 Logo 庫、找到那一家、刪掉舊的再傳一次，中間每一步都會忘。

     那邊一家公司只能有一張活著的 logo（partial unique index 保證的），所以
     「換」＝先把舊的那張丟進回收桶、再插新的。順序不能倒過來：先插會撞到那個
     索引；而先收舊的、插不進去的話那一家會變成沒有圖 —— 所以插失敗要把舊的放回來。
     公司找不到就開一家新的：商品目錄裡打得出這個牌子，就表示公司真的存在。 */
  async function uploadLogo(brand, blob, fileName) {
    if (readOnly) throw new Error('示範版不會寫進品牌 Logo 庫');
    const c = window.LOGO_SUPABASE || {};
    const u = String(c.url || '').trim().replace(/\/+$/, '');
    const k = String(c.anonKey || '').trim();
    if (!/^https?:\/\/.+/.test(u) || k.length < 20)
      throw new Error('沒有接上品牌 Logo 庫，這張圖存不起來');

    const want = normBrand(brand);
    if (!want) throw new Error('這一格沒有品牌名，不知道要換哪一家的 logo');

    const bucket = c.bucket || 'logos';
    const H = { apikey: k, Authorization: 'Bearer ' + k };
    const J = Object.assign({ 'Content-Type': 'application/json' }, H);

    const r = await fetch(
      `${u}/rest/v1/companies?select=id,name,alt_name,deleted_at,logos(id,path,deleted_at)`,
      { headers: H });
    if (!r.ok) throw new Error(`讀不到 Logo 庫 ${r.status}`);

    let co = (await r.json()).find(x => x && !x.deleted_at &&
      (normBrand(x.name) === want || normBrand(x.alt_name) === want));
    if (!co) {
      const ins = await fetch(`${u}/rest/v1/companies`, {
        method: 'POST',
        headers: Object.assign({ Prefer: 'return=representation' }, J),
        body: JSON.stringify({ name: String(brand).trim() })
      });
      if (!ins.ok) throw new Error(`開不了「${brand}」這一家 ${ins.status}`);
      co = (await ins.json())[0];
      co.logos = [];
    }

    const ext = blob && blob.type === 'image/webp' ? '.webp'
              : blob && blob.type === 'image/jpeg' ? '.jpg' : '.png';
    /* 路徑照那邊的規矩：`<company_id>/<uuid>.<ext>`（見 logo_page 的 uploadOne）。
       每次一個新的 uuid，所以不必 upsert，也不會有快取拿到舊圖那件事。 */
    const uid = (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
              : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const path = `${co.id}/${uid}${ext}`;

    const up = await fetch(`${u}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': (blob && blob.type) || 'image/png' }, H),
      body: blob
    });
    if (!up.ok) throw new Error(`上傳失敗 ${up.status} ${await up.text()}`);

    const old = (co.logos || []).filter(l => l && !l.deleted_at);
    if (old.length) {
      const bin = await fetch(`${u}/rest/v1/logos?company_id=eq.${co.id}&deleted_at=is.null`, {
        method: 'PATCH', headers: J,
        body: JSON.stringify({ deleted_at: new Date().toISOString() })
      });
      if (!bin.ok) throw new Error(`收不起舊的那一張 ${bin.status}`);
    }

    const ins = await fetch(`${u}/rest/v1/logos`, {
      method: 'POST',
      headers: Object.assign({ Prefer: 'return=representation' }, J),
      body: JSON.stringify({ company_id: co.id, path,
                             file_name: fileName || (String(brand).trim() + ext) })
    });
    if (!ins.ok) {
      const why = `${ins.status} ${await ins.text()}`;
      /* 舊的已經收走了，新的又插不進去 —— 放著不管的話這家公司會整個沒有圖，
         而版上只看得到一個空框，看不出剛剛失敗的是哪一步。 */
      if (old.length) {
        try {
          await fetch(`${u}/rest/v1/logos?id=eq.${old[0].id}`, {
            method: 'PATCH', headers: J, body: JSON.stringify({ deleted_at: null }) });
        } catch (_) {}
      }
      throw new Error(`存不進 Logo 庫 ${why}`);
    }

    /* 兩種寫法都要更新（Panasonic ↔ 國際牌）：商品目錄裡打的是哪一種都算數，
       只補一個的話另一種寫法的商品會繼續指著剛剛被收走的那張圖。 */
    return { url: `${u}/storage/v1/object/public/${bucket}/${path}`,
             company: co.name,
             keys: [normBrand(co.name), normBrand(co.alt_name)].filter(Boolean) };
  }

  /* ------------------------------------------------------------ 貼紙庫 --- */

  /* 貼紙庫本來只活在做貼紙那台瀏覽器的 localStorage 裡：設計 A 做的貼紙設計 B 看不到，
     圖轉成 base64 塞進去，大約 5MB 就滿。現在一張貼紙一列（sticker_lib）、
     分類一個一列（sticker_cats）、圖進 Storage。
     跟商品目錄不一樣，這裡**不是整包**：兩個人各做各的貼紙，寫的是不同的列，
     根本沒有東西要合併。真的撞在同一張上，用後存的那份、讓上層講一句 ——
     貼紙很小，重做很快，逐欄合併不值得。 */
  const STK_BUCKET = 'stickers';
  const STK_COLS = ['name', 'category', 'ratio', 'layer_count', 'text_layers',
                    'template', 'preview', 'updated_by'];
  /* id -> 伺服器上那一列（**含刪掉的**）。刪掉的也要記：本機快取裡還躺著那一張的話，
     不知道它刪過就會當成「還沒傳上去的新貼紙」再傳一次，刪掉的又活回來。 */
  const stkRows = new Map();

  const stickerFileUrl = path => ok() ? `${url}/storage/v1/object/public/${STK_BUCKET}/${path}` : '';

  /* 檔名＝內容的雜湊（sticker_editor 的 addAsset 本來就這樣取名），所以同一個名字
     永遠是同一張圖：傳過就不必再傳，也沒有「換了圖卻拿到快取裡的舊圖」這回事
     （商品圖要加 ?v= 就是因為檔名＝品名，換圖時名字不變）。
     已經有了會回 400 Duplicate —— 那不是失敗，那正是「傳過了」。 */
  async function uploadStickerFile(path, blob) {
    if (!ok()) throw new Error('沒有接後端，貼紙的圖存不起來');
    const r = await fetch(`${url}/storage/v1/object/${STK_BUCKET}/${path}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + (CFG.accessToken || key),
                 'Content-Type': (blob && blob.type) || 'application/octet-stream' },
      body: blob
    });
    if (!r.ok) {
      const t = await r.text();
      if (!/duplicate|already exists/i.test(t)) throw new Error(`貼紙的圖上傳失敗 ${r.status} ${t}`);
    }
    return stickerFileUrl(path);
  }

  /** 整個貼紙庫。先只問 id 和時間，變了的才抓內容：主程式每次拿起貼圖工具都會問一次，
      一張貼紙的模板幾 KB，整包抓太浪費。
      回傳 { rows（含刪掉的）, cats, changed }；表還沒建（404）回 null。 */
  async function pullStickerLib() {
    if (!ok()) return null;
    const r = await fetch(`${BASE}/sticker_lib?select=id,updated_at`, { headers: headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`index sticker_lib ${r.status} ${await r.text()}`);
    const idx = await r.json();
    let changed = false;
    const alive = new Set(idx.map(x => x.id));
    for (const id of [...stkRows.keys()])            // 在後台整列刪掉的（正常流程只會標記）
      if (!alive.has(id)) { stkRows.delete(id); changed = true; }
    const want = idx.filter(x => { const o = stkRows.get(x.id); return !o || o.updated_at !== x.updated_at; })
                    .map(x => x.id);
    for (let i = 0; i < want.length; i += 80) {      // 一次八十個，網址才不會長到被擋
      const list = want.slice(i, i + 80).map(id => '"' + String(id).replace(/"/g, '\\"') + '"').join(',');
      const q = await fetch(`${BASE}/sticker_lib?id=in.(${list})&select=*`, { headers: headers() });
      if (!q.ok) throw new Error(`pull sticker_lib ${q.status} ${await q.text()}`);
      (await q.json()).forEach(row => stkRows.set(row.id, row));
      changed = true;
    }
    let cats = [];
    const c = await fetch(`${BASE}/sticker_cats?select=name,sort&order=sort.asc,name.asc`, { headers: headers() });
    if (c.ok) cats = (await c.json()).map(x => x.name);
    return { rows: [...stkRows.values()], cats, changed };
  }

  /** 寫一張貼紙。回傳 { row, clobbered }。
      clobbered ＝伺服器上那一張在我上次看過之後被別人改過：照樣用我的蓋上去，
      但要讓上層講一句 —— 不然對方剛剛改的東西不見了，兩個人都不知道。
      keepalive ＝頁面正在關（浮層收起來）：只剩一發的機會，不 CAS、不讀回應。 */
  async function writeSticker(row, opt) {
    if (!ok() || !row || !row.id) return null;
    const keepalive = !!(opt && opt.keepalive);
    const body = { id: row.id };
    STK_COLS.forEach(k => { if (row[k] !== undefined) body[k] = row[k]; });
    body.updated_at = new Date().toISOString();
    body.deleted_at = null;                          // 存一次＝它是活的（刪掉又從匯入救回來也走這裡）
    const known = stkRows.get(row.id);
    let out = null, clobbered = false;
    if (known && !keepalive) {
      const r = await fetch(
        `${BASE}/sticker_lib?id=eq.${encodeURIComponent(row.id)}&updated_at=eq.${encodeURIComponent(known.updated_at)}`, {
          method: 'PATCH',
          headers: Object.assign(headers(), { 'Prefer': 'return=representation' }),
          body: JSON.stringify(body)
        });
      if (!r.ok) throw new Error(`write sticker ${r.status} ${await r.text()}`);
      out = (await r.json())[0] || null;
      clobbered = !out;
    }
    if (!out) {
      const r = await fetch(`${BASE}/sticker_lib`, {
        method: 'POST', keepalive,
        headers: Object.assign(headers(), {
          'Prefer': 'resolution=merge-duplicates,' + (keepalive ? 'return=minimal' : 'return=representation') }),
        body: JSON.stringify([body])
      });
      if (!r.ok) throw new Error(`upsert sticker ${r.status} ${await r.text()}`);
      out = keepalive ? body : ((await r.json())[0] || body);
    }
    stkRows.set(out.id, out);
    return { row: out, clobbered };
  }

  /** 刪一張貼紙＝標記，不抹掉（跟 Logo 庫的回收桶同一套）。伺服器上沒有那一張就什麼都不做。 */
  async function removeSticker(id, opt) {
    if (!ok() || !id) return;
    const stamp = new Date().toISOString();
    const r = await fetch(`${BASE}/sticker_lib?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', keepalive: !!(opt && opt.keepalive),
      headers: Object.assign(headers(), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ deleted_at: stamp, updated_at: stamp })
    });
    if (!r.ok) throw new Error(`remove sticker ${r.status} ${await r.text()}`);
    const o = stkRows.get(id);
    if (o) stkRows.set(id, Object.assign({}, o, { deleted_at: stamp, updated_at: stamp }));
  }

  /** 分類清單。只會加（貼紙庫沒有刪分類這件事），所以整份 upsert 就好，順序就是 sort。 */
  async function writeStickerCats(names) {
    if (!ok() || !names || !names.length) return;
    const r = await fetch(`${BASE}/sticker_cats`, {
      method: 'POST',
      headers: Object.assign(headers(), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(names.map((name, sort) => ({ name, sort })))
    });
    if (!r.ok) throw new Error(`write sticker_cats ${r.status} ${await r.text()}`);
  }

  window.PlanSync = { ok, canRead, pullAll, pullIndex, pullSome, stampOf, setMerge, setSaved,
                      pullLogos, uploadLogo, normBrand,
                      pushPresence, pullPresence, dropPresence,
                      upsert, remove, queueUpsert, queueRemove, flush, uploadImage,
                      pullCatalogue, queueCatalogue, setCatalogueMerge, setCatalogueAfter,
                      pullStickerLib, writeSticker, removeSticker, writeStickerCats,
                      uploadStickerFile, stickerFileUrl };
})();
