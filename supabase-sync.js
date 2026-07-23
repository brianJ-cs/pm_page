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

  async function pullAll(table = 'plans') {
    if (!ok()) return null;
    const r = await fetch(`${BASE}/${table}?select=id,data,updated_at`, { headers: headers() });
    if (!r.ok) throw new Error(`pull ${table} ${r.status} ${await r.text()}`);
    return r.json();
  }

  async function upsert(rows, table = 'plans') {
    if (!ok() || !rows.length) return;
    const body = rows.map(x => ({ id: x.id, data: x.data, updated_at: new Date().toISOString() }));
    const r = await fetch(`${BASE}/${table}`, {
      method: 'POST',
      headers: Object.assign(headers(), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`upsert ${table} ${r.status} ${await r.text()}`);
  }

  async function remove(ids, table = 'plans') {
    if (!ok() || !ids.length) return;
    /* id 是使用者取不到名字的內部字串（p1721…、seed-2、imp-…），還是用雙引號包起來，
       免得哪天有人塞進逗號就把 in.() 拆錯。 */
    const list = ids.map(id => '"' + String(id).replace(/"/g, '\\"') + '"').join(',');
    const r = await fetch(`${BASE}/${table}?id=in.(${list})`, { method: 'DELETE', headers: headers() });
    if (!r.ok) throw new Error(`delete ${table} ${r.status} ${await r.text()}`);
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
        if (rows.length) await upsert(rows);
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

  window.PlanSync = { ok, pullAll, upsert, remove, queueUpsert, queueRemove, flush, uploadImage };
})();
