#!/usr/bin/env node
/* 發佈到 Netlify 的兩條線：node deploy.mjs review ／ node deploy.mjs dev
 *
 *   review  給人看的那一份。網址固定，只有你想讓他們看到新東西的時候才發。
 *   dev     自己改自己看的那一份。網址也固定，隨便發。
 *
 * 兩條都是 draft（沒有 --prod），所以正式站不會動到。
 *
 * ---- 為什麼要有這支腳本，而不是直接打 netlify deploy ----------------------
 * 因為 --no-build。那個旗標是「不要在雲端跑 build」（省 build 額度），代價是
 * Netlify 原封不動上傳 public/ —— 它不會幫你重新產生。所以只要漏掉
 * `node build-single.mjs`，發出去的就是上一版，而且**沒有任何錯誤訊息**。
 * 這支就是把「先 build、再 deploy」綁在一起，讓那件事不可能忘記。
 *
 *   node deploy.mjs review --demo   ← 改發 out/demo（不接後端那一份，給外人試用）
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/* 站台寫死在這裡，不靠 netlify link。`netlify status` 在這台機器上報的是別人的
   專案（jocular-clafoutis），而這個資料夾沒有 .netlify/state.json —— 不指名的話
   一發就發到別人的站上去。 */
const SITE = 'b7412c61-ca3f-4474-853b-babbbbae366f';   // famous-buttercream-edc32c

const ALIASES = {
  review: '給人看的（網址固定，想讓他們看到新東西才發）',
  dev:    '自己看的（網址固定，隨便發）',
};

const argv = process.argv.slice(2);
const alias = argv.find(a => !a.startsWith('-'));
const demo = argv.includes('--demo');

if (!alias || !ALIASES[alias]) {
  console.error('用法：node deploy.mjs <review|dev> [--demo]\n');
  for (const [k, v] of Object.entries(ALIASES)) console.error(`  ${k.padEnd(7)} ${v}`);
  console.error('\n  --demo   發 out/demo（config.js 是佔位符，整支走 localStorage，碰不到公司資料）');
  process.exit(1);
}

const dir = demo ? join(here, 'out', 'demo') : join(here, 'public');

// 先 build 再 deploy —— 這一步就是這支腳本存在的理由（見上面的註解）
if (demo) {
  if (!existsSync(join(dir, 'config.js'))) {
    console.error('out/demo 還沒建好。先跑一次 node build-single.mjs，再把 config.js 換成佔位符。');
    process.exit(1);
  }
  console.log('→ 發 out/demo（沿用現有內容，不重新 build —— 那一份的 config.js 是手工換過的）');
} else {
  console.log('→ node build-single.mjs');
  execFileSync(process.execPath, [join(here, 'build-single.mjs')], { stdio: 'inherit' });
}

const args = ['deploy', '--no-build', '--dir', dir, '--site', SITE, '--alias', alias,
              '--message', `${alias}${demo ? ' (demo)' : ''} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`];

console.log('→ netlify ' + args.join(' ') + '\n');
try {
  execFileSync('netlify', args, { stdio: 'inherit', shell: true });
} catch (e) {
  process.exit(e.status || 1);
}

console.log(`\n網址（固定不變，可以一直用同一個連結）：`);
console.log(`  https://${alias}--famous-buttercream-edc32c.netlify.app/editor`);
