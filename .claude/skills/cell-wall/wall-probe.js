/* 在 2cell-product-pick.html（單獨開）裡跑：每一種零件往四邊用力拖、往右下拉大，
   量「看得見的邊」有沒有剛好停在邊界線上。由 wall.mjs 塞進 driver 的 --eval。
   ⚠️ 這裡的「看得見的邊」是**自己另外量的**（truth()），不叫程式裡的 visBox ——
   拿被測的那一支來當標準答案，壞掉的時候兩邊一起錯，測試照樣是綠的。
   __MARGIN__ 由 wall.mjs 換成數字或 null（null ＝預設邊界）。 */
(async () => {
  const MARGIN_SET = __MARGIN__;
  const TOL = 1.5;                                   // 排版單位；次像素捨入之外都算錯
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rows = [], covered = new Set(), notes = [];
  const cv = document.createElement('canvas').getContext('2d');

  /* ---- 看得見的邊（排版單位，跟 offsetLeft／MARGIN 同一個座標系） ---- */
  function truth(b){
    const el = bEl(b.id); if(!el) return null;
    const er = el.getBoundingClientRect(); if(!er.width || !el.offsetWidth) return null;
    const sc = er.width / el.offsetWidth;
    const rs = [];
    const box = sel => { const t = el.querySelector(sel); if(!t) return false;
      const r = t.getBoundingClientRect(); if(!r.width || !r.height) return false; rs.push(r); return true; };
    if(b.kind === 'img') box(':scope > img') || box(':scope > .ph');
    else if(b.kind === 'brand') box('.bcrop') || box('.bimg') || box('.bph');
    else if(b.kind === 'sticker'){                   // 畫出來的那幾層，不是外框
      [...el.children].forEach(c => { if(c.matches('.selbox,.rz,.tobtn,.delbtn')) return;
        const r = c.getBoundingClientRect(); if(r.width && r.height) rs.push(r); });
      if(!rs.length) rs.push(er);
    }
    else if(b.kind === 'spec') box('.spec');
    else {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t;
      while((t = w.nextNode())){
        const s = String(t.nodeValue || '').trim(); if(!s) continue;
        const p = t.parentElement; if(!p || p.closest('.selbox,.rz,.tobtn,.delbtn')) continue;
        const cs = getComputedStyle(p); if(cs.display === 'none') continue;
        const rg = document.createRange(); rg.selectNode(t);
        const r = rg.getBoundingClientRect(); if(!r.width) continue;
        cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const m = cv.measureText(s);
        const top = r.top + Math.max(0, m.fontBoundingBoxAscent - m.actualBoundingBoxAscent) * sc;
        const bot = r.bottom - Math.max(0, m.fontBoundingBoxDescent - m.actualBoundingBoxDescent) * sc;
        rs.push({ left:r.left, right:r.right, top, bottom:bot });
      }
    }
    if(!rs.length) return null;
    const L = Math.min(...rs.map(r => r.left)), R = Math.max(...rs.map(r => r.right));
    const T = Math.min(...rs.map(r => r.top)),  B = Math.max(...rs.map(r => r.bottom));
    const X = v => el.offsetLeft + (v - er.left) / sc, Y = v => el.offsetTop + (v - er.top) / sc;
    return { l:X(L), r:X(R), t:Y(T), b:Y(B) };
  }
  const walls = () => ({ l:MARGIN, r:CW - MARGIN, t:MARGIN, b:CH - MARGIN });
  const label = b => b.kind + (b.kind === 'img' && bEl(b.id) && bEl(b.id).classList.contains('noimg') ? '(灰圖)' : '')
                             + (b.kind === 'price' && b.cross ? '(劃線)' : '')
                             + (b.kind === 'brand' && bEl(b.id) && bEl(b.id).querySelector('.bcrop') ? '(裁過)' : '');
  const grab = el => (el.classList.contains('noimg') && el.querySelector(':scope > .ph')) || el;
  /* ⚠️ 移動和放手送給 body，不送 window：真的滑鼠事件的 target 永遠是一個元素，
     有一支提示框的 mousemove 直接叫 e.target.closest —— 送 window 會炸在那裡（測試自己的錯）。 */
  const mouse = (target, type, x, y, alt) => (target === window ? document.body : target).dispatchEvent(new MouseEvent(type,
    { bubbles:true, cancelable:true, button:0, buttons:type === 'mouseup' ? 0 : 1, clientX:x, clientY:y, altKey:!!alt }));

  /* 這一塊的字畫成幾行。拖到牆邊之後多出來的一行＝零件自己被擠窄了（2026-09-14：邊界比框的
     內距＋框線窄的時候，型號、品名一靠右邊的牆就折成兩行）—— 位置可能照樣停在線上，
     所以光看「停在哪」抓不到它，要另外數行數。 */
  function lineCount(b){
    const el = bEl(b.id); if(!el) return 0;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t, n = 0;
    while((t = w.nextNode())){
      if(!String(t.nodeValue || '').trim()) continue;
      // 記號上的字不算版面（選起來那一條 .selbar 也是：它會讓行數憑空多一行）
      if(t.parentElement.closest('.selbox,.rz,.tobtn,.delbtn,.selbar')) continue;
      const rg = document.createRange(); rg.selectNode(t);
      n = Math.max(n, new Set([...rg.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size);
    }
    return n;
  }

  /* ---- 往一邊拖到底 ---- */
  async function dragTest(cname, b, dir){
    activeImg = null; selected.clear(); renderCell();
    const el = bEl(b.id); if(!el) return;
    const lines0 = lineCount(b);
    const g = grab(el), r = g.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const far = { L:[-4000, 0], R:[4000, 0], T:[0, -4000], B:[0, 4000] }[dir];
    mouse(g, 'mousedown', x0, y0);
    for(let i = 1; i <= 4; i++) mouse(window, 'mousemove', x0 + far[0] * i / 4, y0 + far[1] * i / 4, true);
    mouse(window, 'mouseup', x0 + far[0], y0 + far[1], true);
    await sleep(20);
    const side = { L:'l', R:'r', T:'t', B:'b' }[dir];
    const a = truth(b), lines1 = lineCount(b);
    renderOne(curCell, true); await sleep(20);            // 放手之後再完整重排一次：不准被拉走
    const z = truth(b), w = walls(), lines2 = lineCount(b);
    const gap = v => v ? +(v[side] - w[side]).toFixed(2) : null;
    const g1 = gap(a), g2 = gap(z);
    const wrapped = Math.max(lines1, lines2) > lines0;
    rows.push({ case:cname, part:label(b), test:'拖到' + { L:'左', R:'右', T:'上', B:'下' }[dir],
                gap:g1, gapAfter:g2, err: wrapped ? `折行 ${lines0} → ${Math.max(lines1, lines2)} 行` : undefined,
                ok: g1 != null && Math.abs(g1) <= TOL && Math.abs(g2) <= TOL && !wrapped });
  }

  /* ---- 往右下拉大 ---- */
  /* 四個角各拉一次：**抓哪一角就往哪一角長，對角停在原地**。
     2026-09-22 之前不管抓哪一角東西都往右下長（只有寬度在變、左上角是釘死的），
     而原本這一支只量「拉大到右下」—— 那一角剛好是唯一看不出問題的。
     拉完把大小放回去，四個角才是各量各的。 */
  const CORNER_NAME = { nw:'左上', ne:'右上', sw:'左下', se:'右下' };
  async function cornerTest(cname, b, corner){
    activeImg = null; selected.clear();
    if(!bEl(b.id)) return;
    const keep = JSON.stringify({ x:b.x, y:b.y, w:b.w, h:b.h, sc:b.sc, w0:b.w0, rx:b.rx, placed:b.placed });
    /* 先縮一半再擺到中間：四個角都要有地方長。
       不縮的話商品圖本來就快滿格，往哪一角拉都立刻撞牆 —— 每一步都被還原，
       量到的會是「沒有變大」，而那不是這一條要驗的事。 */
    if(typeof setBlockScale === 'function') setBlockScale(b, .5);
    renderOne(curCell, true); await sleep(10);
    const t00 = truth(b);
    if(t00){
      unpin(b);
      b.x = (+b.x || 0) + ((CW - (t00.r - t00.l)) / 2 - t00.l);
      b.y = (+b.y || 0) + ((CH - (t00.b - t00.t)) / 2 - t00.t);
      renderOne(curCell, true); await sleep(20);
    }
    const el0 = bEl(b.id); if(!el0) return;
    const g = grab(el0), gr = g.getBoundingClientRect();
    mouse(g, 'mousedown', gr.left + gr.width / 2, gr.top + gr.height / 2);
    mouse(window, 'mouseup', gr.left + gr.width / 2, gr.top + gr.height / 2);
    renderCell(); await sleep(20);
    const h = bEl(b.id) && bEl(b.id).querySelector(':scope > .rz[data-corner="' + corner + '"]');
    const t0 = truth(b);
    if(!h || !t0){ notes.push(cname + ' ' + label(b) + '：選起來沒有' + CORNER_NAME[corner] + '把手'); return; }
    const ax = corner.includes('w') ? t0.r : t0.l;      // 對角那一點（排版單位）
    const ay = corner.includes('n') ? t0.b : t0.t;
    const hr = h.getBoundingClientRect();
    let x = hr.left + hr.width / 2, y = hr.top + hr.height / 2;
    /* 只拉一小段：這一條量的是「對角有沒有停在原地」，不是牆。拉到撞牆的話，
       滑回邊界線以內那一步本來就會挪動整塊（那是對的），對角當然就跟著動了。 */
    const sx = corner.includes('e') ? 3 : -3, sy = corner.includes('s') ? 3 : -3;
    mouse(h, 'mousedown', x, y);
    for(let i = 0; i < 12; i++){ x += sx; y += sy; mouse(window, 'mousemove', x, y); }
    mouse(window, 'mouseup', x, y);
    await sleep(20);
    const t = truth(b), w = walls();
    if(t){
      const nx = corner.includes('w') ? t.r : t.l;
      const ny = corner.includes('n') ? t.b : t.t;
      const moved = Math.max(Math.abs(nx - ax), Math.abs(ny - ay));
      const over = Math.max(t.r - w.r, t.b - w.b, w.l - t.l, w.t - t.t);
      const grew = (t.r - t.l) > (t0.r - t0.l) + 1;
      rows.push({ case:cname, part:label(b), test:'拉' + CORNER_NAME[corner],
                  gap:+moved.toFixed(2), gapAfter:+over.toFixed(2),
                  err: moved > TOL ? ('對角跑了 ' + moved.toFixed(1)) : (grew ? undefined : '沒有變大'),
                  ok: moved <= TOL && over <= TOL && grew });
    }
    const k = JSON.parse(keep);
    ['x','y','w','h','sc','w0','rx','placed'].forEach(f => {
      if(k[f] === undefined || k[f] === null) delete b[f]; else b[f] = k[f]; });
    renderOne(curCell, true); await sleep(10);
  }

  async function resizeTest(cname, b){
    activeImg = null; selected.clear();
    const el0 = bEl(b.id); if(!el0) return;
    const g = grab(el0), r = g.getBoundingClientRect();
    mouse(g, 'mousedown', r.left + r.width / 2, r.top + r.height / 2);
    mouse(window, 'mouseup', r.left + r.width / 2, r.top + r.height / 2);
    renderCell(); await sleep(20);
    const h = bEl(b.id) && bEl(b.id).querySelector(':scope > .rz[data-corner="se"]');
    if(!h){ notes.push(cname + ' ' + label(b) + '：選起來沒有右下把手'); return; }
    const hr = h.getBoundingClientRect();
    let x = hr.left + hr.width / 2, y = hr.top + hr.height / 2, grow = 0, prev = truth(b);
    mouse(h, 'mousedown', x, y);
    for(let i = 0; i < 160; i++){
      x += 6; y += 6;
      mouse(window, 'mousemove', x, y);
      const now = truth(b);
      if(prev && now) grow = Math.max(grow, now.r - prev.r, now.b - prev.b);
      prev = now;
    }
    mouse(window, 'mouseup', x, y);
    await sleep(20);
    const t = truth(b), w = walls();
    if(!t) return;
    const over = Math.max(t.r - w.r, t.b - w.b, w.l - t.l, w.t - t.t);
    const gap = Math.min(w.r - t.r, w.b - t.b);
    const capped = typeof clampSc === 'function' && scaleOfBlock(b) >= clampSc(1e9) - 1e-3;
    const ok = over <= TOL && (capped || gap <= grow * 1.2 + TOL);
    rows.push({ case:cname, part:label(b), test:'拉大到右下' + (capped ? '（到倍率上限）' : ''),
                gap:+gap.toFixed(2), gapAfter:+over.toFixed(2), ok });
  }

  try{
    /* 一張四周透明的 logo（HITACHI 那一種）、一張真的商品圖 */
    const mk = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h;
                                 draw(c.getContext('2d')); return c.toDataURL('image/png'); };
    const logo  = mk(400, 200, g => { g.fillStyle = '#c00'; g.fillRect(120, 70, 160, 60); });
    const photo = mk(300, 300, g => { g.fillStyle = '#579'; g.fillRect(0, 0, 300, 300); });
    const NAME = 'iPhone 17 Pro Max';
    try{ BRAND[NAME] = 'WALLTEST'; }catch(_){}
    LOGOS = Object.assign({}, LOGOS || {}, { [normBrand('WALLTEST')]: logo });
    if(MARGIN_SET != null) setMargin(MARGIN_SET);

    const CASES = [
      { name:'一價', skus:['2156742'], sticker:true, resize:true, photo:true },
      { name:'二價', skus:['2156742', '2156739'], cross:true },
      { name:'三價', skus:['2156742', '2156739', '2156738'] },
    ];
    for(const C of CASES){
      picked = new Set(C.skus); cell().picked = picked; layoutKey = '';
      renderOne(curCell, true); await sleep(500); renderOne(curCell, true); await sleep(50);
      if(C.photo){ const im = BLOCKS.find(b => b.kind === 'img'); if(im){ IMG[im.key] = photo; renderOne(curCell, true); await sleep(80); } }
      if(C.cross){ const p = BLOCKS.find(b => b.kind === 'price'); if(p){ p.cross = true; renderOne(curCell, true); } }
      if(C.sticker){
        /* svg 這一欄是一張圖的網址（烤好的那一張），不是 svg 原始碼 —— 塞原始碼進去會變成
           <img src="<svg …"> 那種壞掉的 DOM，量出來的是測試自己弄壞的東西。 */
        addStickerBlock({ name:'wall', ratio:.5, svg:'data:image/svg+xml,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" rx="8" fill="#e22"/></svg>') });
        await sleep(30);
      }
      /* 一張真圖、一張灰圖都要有：一價那一格換成真圖，二價以後維持灰圖 */
      const list = BLOCKS.filter(b => !isOff(b) && bEl(b.id));
      const ids = list.map(b => b.id);
      for(const id of ids){
        for(const dir of ['L', 'R', 'T', 'B']){
          const b = BLOCKS.find(x => x.id === id); if(!b) continue;
          covered.add(label(b));
          try{ await dragTest(C.name, b, dir); }catch(e){ rows.push({ case:C.name, part:label(b), test:'拖' + dir, ok:false, err:String(e && e.message || e) }); }
        }
      }
      if(C.resize){
        for(const id of ids){
          const b = BLOCKS.find(x => x.id === id);
          if(!b || !['img', 'price', 'sticker', 'brand'].includes(b.kind)) continue;
          /* 先放回中間附近，才有空間往右下長 */
          const t = truth(b);
          if(t){ unpin(b); b.x = (+b.x || 0) - (t.l - MARGIN); b.y = (+b.y || 0) - (t.t - MARGIN); renderOne(curCell); }
          try{ await resizeTest(C.name, b); }catch(e){ rows.push({ case:C.name, part:label(b), test:'拉大', ok:false, err:String(e && e.message || e) }); }
          /* 四個角只量商品圖：拉大小這件事全部零件共用同一支，量一種就量得到，
             而每多一個角就多跑一趟（40 次 mousemove ＋ 兩次重排）。 */
          if(b.kind === 'img'){
            for(const cn of ['nw', 'ne', 'sw', 'se']){
              try{ await cornerTest(C.name, b, cn); }
              catch(e){ rows.push({ case:C.name, part:label(b), test:'拉' + cn, ok:false, err:String(e && e.message || e) }); }
            }
          }
        }
      }
    }
    return { margin:MARGIN, cw:CW, ch:CH, covered:[...covered], notes, rows };
  }catch(e){
    return { error:String(e && e.stack || e), rows };
  }
})()
