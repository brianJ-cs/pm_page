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

  const DEBOUNCE = 600;

  const headers = () => ({
    'apikey': key,
    'Authorization': 'Bearer ' + (CFG.accessToken || key),
    'Content-Type': 'application/json'
  });

  const ok = () => !!BASE;

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
        'x-upsert': 'true'          // 同一個商品換圖＝蓋掉舊的，不要愈積愈多
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
    if (!ok()) return null;
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

  window.PlanSync = { ok, pullAll, pullIndex, pullSome, stampOf, setMerge,
                      pushPresence, pullPresence, dropPresence,
                      upsert, remove, queueUpsert, queueRemove, flush, uploadImage,
                      pullCatalogue, queueCatalogue, setCatalogueMerge, setCatalogueAfter };
})();
