#!/usr/bin/env node
/* Drives the single-file HTML apps in pm_page with headless Chrome.
 *
 * Zero dependencies on purpose: these apps have no build, no package.json and
 * no node_modules, and the driver should not be the thing that introduces one.
 * It speaks the Chrome DevTools Protocol over Node's built-in WebSocket
 * (Node >= 22), which is enough to click, drag, type, evaluate and screenshot.
 *
 * Every step runs in order. Console errors and uncaught exceptions are
 * collected the whole time and printed at the end; the process exits 1 if any
 * were seen, so this doubles as a smoke test in CI-ish usage.
 *
 *   node driver.mjs --file design_and_PM.html --shot out/boot.png
 *   node driver.mjs --file design_and_PM.html \
 *        --click ".plan-card" --shot out/plan.png \
 *        --eval "activeTab"
 *
 * Steps (applied left to right):
 *   --file <path>        load a local .html (repeatable; re-navigates)
 *   --wait <ms>          sleep
 *   --waitfor <sel>      poll until the selector exists (5s cap)
 *   --click <sel>        real mouse press+release at the element's centre
 *   --click-text <text>  click the first element whose textContent contains it
 *   --drag <sel> <dx> <dy>   pointer drag from the element's centre by dx,dy
 *   --type <text>        type into whatever has focus
 *   --key <Key>          press one key (Escape, Enter, Tab, ...)
 *   --eval <js>          evaluate in the page, print the result
 *   --shot <file.png>    screenshot to disk (dirs created)
 *   --headed             show the browser window (debugging the driver)
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => existsSync(p));
if (!CHROME) die('no Chrome/Edge found — edit CHROME[] in driver.mjs');

const PORT = 9333 + (process.pid % 400);
const PROFILE = join(tmpdir(), 'pm-page-driver-' + process.pid);

function die(msg){ console.error('driver: ' + msg); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- CDP ---- */
let ws, nextId = 1, pending = new Map();
const problems = [];

function send(method, params = {}){
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, no) => pending.set(id, { ok, no }));
}

async function connect(){
  // chrome writes the port file only after the http endpoint is up
  for (let i = 0; i < 100; i++){
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find(t => t.type === 'page');
      if (page){
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
        ws.onmessage = ev => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)){
            const { ok, no } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? no(new Error(m.error.message)) : ok(m.result);
            return;
          }
          if (m.method === 'Runtime.exceptionThrown'){
            const d = m.params.exceptionDetails;
            problems.push('EXCEPTION ' + (d.exception?.description || d.text));
          }
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error'){
            problems.push('CONSOLE ' + m.params.args.map(a =>
              a.description ?? a.value ?? a.type).join(' '));
          }
        };
        return;
      }
    } catch {}
    await sleep(100);
  }
  die('could not attach to Chrome on port ' + PORT);
}

/* ------------------------------------------------------------- helpers --- */
async function evaluate(expr){
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

/* Every frame worth searching, with what it takes to turn a rect inside it into
   top-level viewport pixels. The 拼板 cards and the 挑貨 panel each run
   2cell-product-pick.html in an iframe, and the card iframes are scaled down to
   the cell — so an offset alone is not enough, the scale has to come too. */
const FRAMES = `(() => {
  const out = [{ d: document, ox: 0, oy: 0, s: 1 }];
  for (const f of document.querySelectorAll('iframe')){
    let d = null;
    try { d = f.contentDocument; } catch (_){}
    if (!d || !d.body) continue;
    const r = f.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const iw = (f.contentWindow && f.contentWindow.innerWidth) || r.width;
    out.push({ d, ox: r.left, oy: r.top, s: iw ? r.width / iw : 1 });
  }
  return out;
})()`;

/* Having a box is not the same as being clickable. 2cell-product-pick.html keeps
   its 後台 panel collapsed with width:0 + overflow:hidden, and the 40 product
   labels inside it still lay out at full size — so a rect test alone "finds"
   labels in a 拼板 card and clicks a spot that belongs to something else
   entirely. Hit-test the centre and require it to land on the element itself. */
const HITTABLE = `(f, el, r) => {
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > f.d.documentElement.clientWidth
                       || cy > f.d.documentElement.clientHeight) return false;
  const hit = f.d.elementFromPoint(cx, cy);
  return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
}`;

/** Centre of the first match, in CSS pixels, or null. Searches same-origin
    iframes as well as the top document, and only returns something you could
    actually click. */
const centreOf = sel => evaluate(`(() => {
  const hittable = ${HITTABLE};
  for (const f of ${FRAMES})
    for (const el of f.d.querySelectorAll(${JSON.stringify(sel)})){
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || !hittable(f, el, r)) continue;
      return { x: f.ox + (r.left + r.width / 2) * f.s,
               y: f.oy + (r.top + r.height / 2) * f.s };
    }
  return null;
})()`);

async function mouse(type, x, y, extra = {}){
  await send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', clickCount: 1, buttons: extra.buttons ?? 1, ...extra,
  });
}

async function click(sel){
  const c = await centreOf(sel);
  if (!c) throw new Error('click: no visible element for ' + sel);
  await mouse('mousePressed', c.x, c.y);
  await mouse('mouseReleased', c.x, c.y, { buttons: 0 });
  await sleep(120);
}

async function clickText(text){
  /* Containers contain their children's text, so a naive "first element whose
     textContent includes t" clicks the card, not the 開啟 button inside it —
     and lands on dead space. Prefer an exact label, then the smallest box. */
  const c = await evaluate(`(() => {
    const t = ${JSON.stringify(text)};
    const sel = 'button,.tab,.cell,.stick,.lg,.pt-type,.pt-blk,.mini-blk,label,.icard';
    const hittable = ${HITTABLE};
    const hits = [];
    for (const f of ${FRAMES})
      for (const e of f.d.querySelectorAll(sel)){
        const r = e.getBoundingClientRect();
        const txt = (e.textContent || '').trim();
        if (txt.includes(t) && r.width > 0 && r.height > 0 && hittable(f, e, r))
          hits.push({ f, r, txt });
      }
    if (!hits.length) return null;
    hits.sort((a, b) =>
      (a.txt === t ? 0 : 1) - (b.txt === t ? 0 : 1) ||
      a.r.width * a.r.height - b.r.width * b.r.height);
    const h = hits[0];
    return { x: h.f.ox + (h.r.left + h.r.width / 2) * h.f.s,
             y: h.f.oy + (h.r.top + h.r.height / 2) * h.f.s };
  })()`);
  if (!c) throw new Error('click-text: nothing containing ' + JSON.stringify(text));
  await mouse('mousePressed', c.x, c.y);
  await mouse('mouseReleased', c.x, c.y, { buttons: 0 });
  await sleep(120);
}

/** Pointer drag. Steps the move so the app's threshold logic (8px, row steps,
    the seam) actually fires — one big jump is often ignored. */
async function drag(sel, dx, dy){
  const c = await centreOf(sel);
  if (!c) throw new Error('drag: no visible element for ' + sel);
  await mouse('mousePressed', c.x, c.y);
  const steps = 12;
  for (let i = 1; i <= steps; i++){
    await mouse('mouseMoved', c.x + (dx * i) / steps, c.y + (dy * i) / steps);
    await sleep(16);
  }
  await mouse('mouseReleased', c.x + dx, c.y + dy, { buttons: 0 });
  await sleep(200);
}

async function type(text){
  for (const ch of text){
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
  }
  await sleep(80);
}

async function key(name){
  const codes = { Escape:27, Enter:13, Tab:9, Backspace:8 };
  await send('Input.dispatchKeyEvent',
    { type:'keyDown', key:name, code:name, windowsVirtualKeyCode: codes[name] || 0 });
  await send('Input.dispatchKeyEvent',
    { type:'keyUp', key:name, code:name, windowsVirtualKeyCode: codes[name] || 0 });
  await sleep(120);
}

async function shot(file){
  const out = resolve(file);
  await mkdir(dirname(out), { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(out, Buffer.from(data, 'base64'));
  console.log('shot   ' + out);
}

async function load(file){
  /* 網址後面可以帶 ?query（例如 design_and_PM.html?seed=1）：pathToFileURL 會把
     ? 當成檔名的一部分編碼掉，所以先切開，轉完再接回去。 */
  const q = file.indexOf('?');
  const path = q < 0 ? file : file.slice(0, q);
  /* http:// 就照原樣用 —— 要驗 dev.mjs 發出來的那一份（路由、跨頁共用的
     localStorage）就得走真的網址，file:// 上兩支檔案不算同一個來源。 */
  const url = /^https?:\/\//i.test(file)
    ? file
    : pathToFileURL(resolve(path)).href + (q < 0 ? '' : file.slice(q));
  await send('Page.navigate', { url });
  await sleep(700);                       // these pages boot synchronously
  console.log('load   ' + url);
}

async function waitFor(sel, cap = 5000){
  const t0 = Date.now();
  while (Date.now() - t0 < cap){
    if (await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)) return;
    await sleep(100);
  }
  throw new Error('waitfor: never appeared: ' + sel);
}

/* ---------------------------------------------------------------- main --- */
const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help')) die('see the header of this file for steps');

const chrome = spawn(CHROME, [
  argv.includes('--headed') ? '--noop' : '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  // file:// pages are opaque origins: without this the apps get no
  // localStorage (no 檔期 persistence) and the 拼板 iframes stay empty
  '--allow-file-access-from-files',
  '--window-size=1600,1000',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  'about:blank',
].filter(a => a !== '--noop'), { stdio: 'ignore' });

process.on('exit', () => { try { chrome.kill(); } catch {} });

await connect();
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

/* 把外部網址整個擋掉 —— 這台機器連不出去，而 `<link>` 到 fonts.googleapis.com
   的樣式表**會擋住後面那個 inline `<script>`**：整支程式要等那個請求自己放棄
   （量到過 9 秒）才開始跑。在那之前 document.readyState 還是 loading、
   頁面上什麼都沒有、而且 **一個錯誤都不會報** —— parity.mjs 的「量不到」
   就是這樣來的（--wait 900 根本還沒輪到程式執行）。
   擋掉之後請求立刻失敗，樣式表不再擋路，程式照常跑（字型換成系統字）。
   ⚠️ 這也表示測出來的**字型不是正式站上的 Anton** —— 量字寬的東西
   （2cell-parity）比的是兩邊同一個條件，所以還是對得起來；
   要看真正的字型請用 --fonts 放行。 */
if (!argv.includes('--fonts')) {
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: [
    '*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*',
    '*://cdn.jsdelivr.net/*', '*://unpkg.com/*',
  ]});
}
await send('Emulation.setDeviceMetricsOverride',
  { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

/* 預設不連 Supabase。config.js 裡是公司正式環境的金鑰，而測試會按到「示範檔期」
   這種真的會存檔的按鈕 —— 已經往正式資料庫塞過一次假檔期了。
   在每個 document 開始跑之前先把 window.SUPABASE 釘成唯讀的空設定：config.js
   之後那句 window.SUPABASE = {...} 就會靜靜地失敗（非嚴格模式不報錯），
   PlanSync.ok() 回 false，整支走純 localStorage。
   真的要測同步再加 --live。

   ⚠️ LOGO_SUPABASE 也要釘：品牌 Logo 庫是**另一個** Supabase 專案，PlanSync.ok()
   管不到它。拖一張圖到版上那張 logo 上就是直接寫進去（uploadLogo），只釘
   window.SUPABASE 的話那條路在測試裡是活的 —— 已經往正式的 Logo 庫塞過一張
   8×8 的測試圖了。 */
if (!argv.includes('--live')) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    for (const k of ['SUPABASE', 'LOGO_SUPABASE'])
      Object.defineProperty(window, k, {
        value: { url:'', anonKey:'', bucket:'' },
        writable: false, configurable: false,
      });
  `});
}

try {
  for (let i = 0; i < argv.length; i++){
    const step = argv[i];
    const arg = () => argv[++i];
    switch (step){
      case '--headed': case '--live': break;   // 開瀏覽器 / 允許連 Supabase，都在啟動時處理過了
      case '--file':      await load(arg()); break;
      case '--wait':      await sleep(+arg()); break;
      case '--waitfor':   await waitFor(arg()); break;
      case '--click':     { const s = arg(); await click(s); console.log('click  ' + s); break; }
      case '--click-text':{ const t = arg(); await clickText(t); console.log('click  "' + t + '"'); break; }
      case '--drag':      { const s = arg(), dx = +arg(), dy = +arg();
                            await drag(s, dx, dy); console.log(`drag   ${s} ${dx},${dy}`); break; }
      case '--type':      { const t = arg(); await type(t); console.log('type   ' + t); break; }
      case '--key':       { const k = arg(); await key(k); console.log('key    ' + k); break; }
      case '--eval':      { const js = arg();
                            console.log('eval   ' + JSON.stringify(await evaluate(js))); break; }
      case '--shot':      await shot(arg()); break;
      default: die('unknown step: ' + step);
    }
  }
} catch (e){
  problems.push('STEP FAILED ' + e.message);
}

chrome.kill();
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});

if (problems.length){
  console.error('\n--- page problems (' + problems.length + ') ---');
  problems.forEach(p => console.error(p));
  process.exit(1);
}
console.log('\nok — no console errors, no exceptions');
