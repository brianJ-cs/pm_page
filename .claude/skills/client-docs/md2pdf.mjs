/* markdown -> PDF，走 headless Chrome 的 Page.printToPDF。
   為什麼不用 reportlab：這台機器的 python 是假殼，而且中文要系統字型。 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [src, dst] = process.argv.slice(2);
if (!src || !dst){ console.error('usage: md2pdf.mjs <in.md> <out.pdf>'); process.exit(2); }

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(p => existsSync(p));
if (!CHROME){ console.error('no Chrome/Edge'); process.exit(2); }

/* ------------------------------------------------------------ markdown --- */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 表格儲存格裡本來就寫著 <br>，逐字跳脫之後要放它回來
const inline = s => esc(s)
  .replace(/&lt;br\s*\/?&gt;/g, '<br>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

function mdToHtml(md){
  const L = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0, para = [], quote = [], ol = null;

  const flushPara = () => { if (para.length){ out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushQuote = () => {
    if (!quote.length) return;
    const body = quote.join('\n').split(/\n\s*\n/)
      .map(b => '<p>' + inline(b.replace(/\n/g, ' ')) + '</p>').join('');
    // 琥珀色留給真正的提醒（⚠️），其餘是附註
    const warn = /⚠/.test(quote.join(' ')) ? ' class="warn"' : '';
    out.push('<blockquote' + warn + '>' + body + '</blockquote>');
    quote = [];
  };
  const flushOl = () => {
    if (!ol) return;
    out.push('<ol>' + ol.map(x => '<li>' + inline(x) + '</li>').join('') + '</ol>');
    ol = null;
  };
  const flushAll = () => { flushPara(); flushQuote(); flushOl(); };

  while (i < L.length){
    const ln = L[i];

    if (/^```/.test(ln)){
      flushAll(); i++;
      const buf = [];
      while (i < L.length && !/^```/.test(L[i])) buf.push(L[i++]);
      i++;
      out.push('<pre>' + esc(buf.join('\n')) + '</pre>');
      continue;
    }
    // 空行不結束編號清單：條目之間本來就空一行
    if (/^\s*$/.test(ln)){ flushPara(); flushQuote(); i++; continue; }
    if (/^---+$/.test(ln)){ flushAll(); out.push('<hr>'); i++; continue; }
    if (/^#{1,4}\s/.test(ln)){
      flushAll();
      const n = ln.match(/^#+/)[0].length;
      out.push('<h' + n + '>' + inline(ln.replace(/^#+\s*/, '')) + '</h' + n + '>');
      i++; continue;
    }
    if (/^>\s?/.test(ln)){ flushPara(); flushOl(); quote.push(ln.replace(/^>\s?/, '')); i++; continue; }

    if (/^\|/.test(ln)){
      flushAll();
      const rows = [];
      while (i < L.length && /^\|/.test(L[i])) rows.push(L[i++]);
      const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(rows[0]);
      const sep = /^\|[\s:|-]+\|$/.test(rows[1] || '');
      const body = rows.slice(sep ? 2 : 1).map(cells);
      out.push('<table><thead><tr>'
        + head.map(c => '<th>' + inline(c) + '</th>').join('')
        + '</tr></thead><tbody>'
        + body.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }

    const m = ln.match(/^(\d+)\.\s+(.*)$/);
    if (m){ flushPara(); flushQuote(); ol = ol || []; ol.push(m[2]); i++; continue; }
    if (ol && /^\s{2,}\S/.test(ln)){ ol[ol.length - 1] += ' ' + ln.trim(); i++; continue; }

    flushQuote(); flushOl();
    para.push(ln.trim()); i++;
  }
  flushAll();
  return out.join('\n');
}

const CSS = [
  ':root{--ink:#1b1f24;--line:#d6dce3;--head:#eef2f6;--warn:#b26a00;--warnbg:#fff8ec}',
  '*{box-sizing:border-box}',
  'body{margin:0;color:var(--ink);background:#fff;',
  '  font-family:"Microsoft JhengHei","微軟正黑體","PingFang TC","Noto Sans TC",sans-serif;',
  '  font-size:10.5pt;line-height:1.75}',
  'h1{font-size:19pt;margin:0 0 4mm;padding-bottom:3mm;border-bottom:2px solid var(--ink);line-height:1.4}',
  'h2{font-size:14pt;margin:9mm 0 3mm;padding-left:3mm;border-left:4px solid var(--ink);line-height:1.4;',
  '   break-after:avoid;page-break-after:avoid}',
  'h3{font-size:11.5pt;margin:6mm 0 2mm;color:#2c3540;break-after:avoid;page-break-after:avoid}',
  'p{margin:0 0 2.5mm;text-align:justify}',
  // 標題正下方那一段是副標（多半是「對應需求條目」），要看得出它不是內文
  'h1 + p{font-size:12pt;line-height:1.55;margin:0 0 5mm;text-align:left}',
  'hr{border:0;border-top:1px solid var(--line);margin:7mm 0}',
  'code{font-family:Consolas,"Courier New",monospace;font-size:.92em;background:#f2f4f7;',
  '     padding:.5mm 1.2mm;border-radius:2px}',
  'pre{font-family:Consolas,"Courier New",monospace;font-size:9pt;line-height:1.6;',
  '    background:#f7f9fb;border:1px solid var(--line);border-left:3px solid #9aa7b4;',
  '    padding:3mm 4mm;margin:0 0 4mm;white-space:pre-wrap;break-inside:avoid;page-break-inside:avoid}',
  'table{width:100%;border-collapse:collapse;margin:0 0 4mm;font-size:9.5pt}',
  'th,td{border:1px solid var(--line);padding:1.8mm 2.5mm;text-align:left;vertical-align:top;line-height:1.65}',
  'th{background:var(--head);font-weight:700;white-space:nowrap}',
  'tr{break-inside:avoid;page-break-inside:avoid}',
  'thead{display:table-header-group}',
  'blockquote{margin:0 0 4mm;padding:2.5mm 4mm;background:#f5f7f9;',
  '           border-left:3px solid #9aa7b4;break-inside:avoid;page-break-inside:avoid}',
  'blockquote.warn{background:var(--warnbg);border-left-color:var(--warn)}',
  'blockquote p{margin:0 0 1.5mm;font-size:9.8pt;color:#3d4650}',
  'blockquote.warn p{color:#4a3a20}',
  'blockquote p:last-child{margin:0}',
  'ol{margin:0 0 4mm;padding-left:6mm}',
  'li{margin:0 0 2mm;text-align:justify}',
  '@page{margin:0}',
].join('\n');

const md = await readFile(resolve(src), 'utf8');
const title = (md.match(/^#\s+(.+)$/m) || [, '文件'])[1].trim();
const html = '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>'
  + esc(title) + '</title><style>' + CSS + '</style></head><body>'
  + mdToHtml(md) + '</body></html>';

const work = join(tmpdir(), 'md2pdf-' + process.pid);
await mkdir(work, { recursive: true });
const htmlPath = join(work, 'doc.html');
await writeFile(htmlPath, html, 'utf8');

/* -------------------------------------------------------------- chrome --- */
// 連線埠要真的是空的：殘留的 Chrome 會佔著，而佔著時新的那一支綁不上，
// 這支程式會去連到上一次那一份文件（或一路等到超時）
async function freePort(from){
  for (let p = from; p < from + 300; p++){
    try {
      const r = await fetch('http://127.0.0.1:' + p + '/json/version',
        { signal: AbortSignal.timeout(300) });
      if (r.ok) continue;               // 有人在用
    } catch { return p; }               // 連不上 = 沒人在用
  }
  throw new Error('找不到空的連線埠');
}
const PORT = await freePort(9700 + (process.pid % 200));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(work, 'profile'),
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 1;
const pending = new Map();
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, no) => pending.set(id, { ok, no }));
};

for (let n = 0; n < 120 && !ws; n++){
  try {
    const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
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
        }
      };
    }
  } catch {}
  if (!ws) await sleep(100);
}
if (!ws){ chrome.kill(); console.error('could not attach to Chrome'); process.exit(2); }

await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(htmlPath).href });
for (let n = 0; n < 100; n++){
  const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
  if (r.result.value === 'complete') break;
  await sleep(100);
}
// 字型沒到齊就印，中文會掉回替代字
await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });

const foot = '<div style="width:100%;font-size:8pt;color:#8a949e;'
  + 'font-family:Microsoft JhengHei,sans-serif;padding:0 14mm;'
  + 'display:flex;justify-content:space-between;">'
  + '<span>' + esc(title) + '</span>'
  + '<span>第 <span class="pageNumber"></span> 頁，共 <span class="totalPages"></span> 頁</span></div>';

const { data } = await send('Page.printToPDF', {
  printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
  marginTop: 0.75, marginBottom: 0.7, marginLeft: 0.67, marginRight: 0.67,
  displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: foot,
});
await writeFile(resolve(dst), Buffer.from(data, 'base64'));

// 驗收要用看的：把同一份 HTML 照 A4 的可用寬度截一張長圖
if (process.env.SHOT){
  await send('Emulation.setDeviceMetricsOverride', {
    width: 700, height: 1000, deviceScaleFactor: 1.5, mobile: false,
  });
  const full = await send('Page.getLayoutMetrics');
  const h = Math.min(Math.ceil(full.cssContentSize.height), 16000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 700, height: h, deviceScaleFactor: 1.5, mobile: false,
  });
  await sleep(300);
  // 一張長圖縮到看不清楚，切成幾段才看得出中文有沒有變方塊
  const slice = 1500;
  for (let y = 0, n = 1; y < h; y += slice, n++){
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y, width: 700, height: Math.min(slice, h - y), scale: 1.5 },
    });
    await writeFile(process.env.SHOT.replace(/\.png$/, '-' + n + '.png'),
      Buffer.from(shot.data, 'base64'));
  }
  console.log('shots: ' + Math.ceil(h / slice) + ' slices, page ' + h + 'px tall');
}

ws.close();
// Chrome 會開一整窩子行程，殺掉啟動的那一支不會把它們帶走 ——
// 跑幾次就堆出十幾個殘留行程，然後開始互搶連線埠
// ⚠️ 不要用 CDP 的 Browser.close：它關掉瀏覽器之後那一則回應永遠不會回來，
// 而這支程式在等它 —— 變成 top-level await 掛住，exit code 13
chrome.kill();
// ⚠️ 也不能靠 taskkill /T 殺行程樹：Chrome 起來之後會 re-exec，
// 真正那一窩在 taskkill 跑到之前就已經不是這個 pid 的小孩了。
// 認人的方式是它自己的 profile 目錄（每次跑都不一樣，不會誤殺使用者的瀏覽器）。
if (process.platform === 'win32'){
  const mark = 'md2pdf-' + process.pid;
  await new Promise(r => {
    const k = spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\""
      + " | Where-Object { $_.CommandLine -like '*" + mark + "*' }"
      + " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], { stdio: 'ignore' });
    k.on('exit', r); k.on('error', r);
  });
}
await rm(work, { recursive: true, force: true }).catch(() => {});
console.log('wrote ' + resolve(dst));
