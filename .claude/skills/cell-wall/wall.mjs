#!/usr/bin/env node
/* 格子裡的牆：每一種零件拖到四邊、拉大到右下，看得見的邊有沒有剛好停在邊界線上。
 *
 *   node .claude/skills/cell-wall/wall.mjs                 預設邊界 ＋ 邊界 30 各跑一次
 *   node .claude/skills/cell-wall/wall.mjs --margin 12     只跑某一個邊界
 *   node .claude/skills/cell-wall/wall.mjs --all           連過了的也印出來
 *
 * 有任何一項沒停在線上（或跑出去）就 exit 1。
 * 開的是單獨的 2cell-product-pick.html（頂層的 let 讀得到、不碰上層、不碰 Supabase）。
 * 探針在 wall-probe.js：參數直接用陣列交給 driver，不經過 shell —— 那一整段 JS 塞進
 * 命令列的引號，就是 edit-fast 第 8 節講的那十次工具呼叫。 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const DRIVER = join(here, '..', 'run-pm-page', 'driver.mjs');
const probe = readFileSync(join(here, 'wall-probe.js'), 'utf8');

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const mi = argv.indexOf('--margin');
const margins = mi >= 0 ? [Number(argv[mi + 1])] : [null, 30];

let bad = 0;
for (const m of margins){
  const js = probe.split('__MARGIN__').join(m == null ? 'null' : String(m));
  const r = spawnSync(process.execPath, [DRIVER, '--file', '2cell-product-pick.html', '--wait', '800',
                                         '--click', '.cell', '--wait', '300', '--eval', js],
                      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = out.split(/\r?\n/).find(l => l.startsWith('eval   '));
  let res = null;
  try { res = line ? JSON.parse(line.slice(7)) : null; } catch (_) {}
  const title = m == null ? '預設邊界' : '邊界 ' + m;
  if (!res || res.error){
    console.log(`\n=== ${title}：探針沒跑完 ===`);
    console.log(res && res.error ? res.error : out.slice(-3000));
    bad++; continue;
  }
  const fails = res.rows.filter(x => !x.ok);
  bad += fails.length;
  if (r.status !== 0){ bad++; console.log(out.slice(out.indexOf('--- page problems'))); }
  console.log(`\n=== ${title}（MARGIN=${res.margin}，格子 ${res.cw}×${res.ch}）：${res.rows.length - fails.length}/${res.rows.length} 過 ===`);
  console.log('量到的零件：' + res.covered.join('、'));
  res.notes.forEach(n => console.log('注意：' + n));
  const shown = showAll ? res.rows : fails;
  if (shown.length){
    console.log('      格    零件            動作              放手時離線   重排後離線');
    shown.forEach(x => console.log(
      (x.ok ? ' ok  ' : ' FAIL') + ' ' + String(x.case).padEnd(4) + String(x.part).padEnd(16) +
      String(x.test).padEnd(18) + String(x.gap).padStart(8) + String(x.gapAfter).padStart(12) +
      (x.err ? '  ' + x.err : '')));
  }
}
console.log(bad ? `\n${bad} 項沒過` : '\n全部停在線上');
process.exit(bad ? 1 : 0);
