#!/usr/bin/env node
/* Logo 庫從 B 專案搬到 A 專案（一次性）。
 *
 *   node migrate-logos.mjs            先看它打算做什麼（不寫任何東西）
 *   node migrate-logos.mjs --go       真的搬
 *
 * 前提：A 那邊已經跑過 logo_page/schema.sql（表、policy、bucket、25 家 seed）。
 * DDL 不能用 anon key 跑，所以那一步只能在 Supabase 後台的 SQL Editor 做。
 *
 * 為什麼不能單純複製 path：logos.path 是 `<company_id>/<uuid>.<ext>`，而 A 那邊
 * 的 25 家是 schema.sql 自己 seed 出來的，**id 跟 B 不一樣**。所以搬的時候要照
 * 名字把公司對起來，再用 A 的 id 重新組 path。
 *
 * 回收桶裡的（deleted_at 不是 null）不搬 —— 那是被丟掉的東西。
 */

import { readFile } from 'node:fs/promises';

const GO = process.argv.includes('--go');
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
/* 這一支住在 logo_page/ 底下，兩支 config 一支在這裡、一支在上一層 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* 設定從那兩支 config.js 讀，不要在這裡再抄一份金鑰 —— 抄了就會有兩份會過期的東西。 */
async function cfg(path, name){
  const src = await readFile(path, 'utf8');
  const g = {};
  new Function('window', src)(g);
  const c = g[name];
  if (!c || !c.url) throw new Error(`${path} 裡讀不到 ${name}`);
  return c;
}

const api = (c) => ({
  rest: (p) => `${c.url}/rest/v1/${p}`,
  store: (p) => `${c.url}/storage/v1/object/${p}`,
  pub: (p) => `${c.url}/storage/v1/object/public/${p}`,
  h: (extra) => Object.assign({ apikey: c.key, Authorization: 'Bearer ' + c.key }, extra || {})
});

async function jget(a, path){
  const r = await fetch(a.rest(path), { headers: a.h() });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}
async function jpost(a, path, body){
  const r = await fetch(a.rest(path), {
    method: 'POST',
    headers: a.h({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

const norm = s => String(s || '').trim().toLowerCase().replace(/[\s\u3000._-]+/g, '');

(async function main(){
  const bRaw = await cfg(join(HERE, 'config.js'), 'SUPABASE_CONFIG');
  const aRaw = await cfg(join(ROOT, 'config.js'), 'SUPABASE');
  const B = api({ url: bRaw.url.replace(/\/+$/, ''), key: bRaw.anonKey });
  const A = api({ url: aRaw.url.replace(/\/+$/, ''), key: aRaw.anonKey });
  const BUCKET = 'logos';

  console.log(GO ? '=== 真的搬 ===' : '=== 預演（什麼都不寫）===');
  console.log('從', bRaw.url);
  console.log('到', aRaw.url, '\n');

  const bCos = await jget(B, 'companies?select=id,name,alt_name,sort_order,deleted_at,logos(id,path,file_name,deleted_at)');
  const aCos = await jget(A, 'companies?select=id,name,alt_name');
  console.log(`B：${bCos.length} 家公司　A：${aCos.length} 家公司`);

  const aByName = new Map(aCos.map(c => [norm(c.name), c]));
  const aByAlt  = new Map(aCos.filter(c => c.alt_name).map(c => [norm(c.alt_name), c]));
  const findA = (co) => aByName.get(norm(co.name)) || aByAlt.get(norm(co.name))
                     || (co.alt_name ? aByName.get(norm(co.alt_name)) : null) || null;

  let moved = 0, skipped = 0, made = 0;
  for (const co of bCos){
    const live = (co.logos || []).filter(l => !l.deleted_at && l.path);
    if (co.deleted_at){
      if (live.length) console.log(`  跳過（在 B 的回收桶裡）：${co.name || '（沒有名字）'}　${live.length} 張圖`);
      skipped += live.length;
      continue;
    }
    if (!live.length) continue;

    let target = findA(co);
    if (!target){
      console.log(`  A 沒有這家：${co.name} → ${GO ? '新增' : '會新增'}`);
      if (GO){
        const [row] = await jpost(A, 'companies', {
          name: co.name, alt_name: co.alt_name || null,
          sort_order: (co.sort_order || 900), locked: false
        });
        target = row; aByName.set(norm(row.name), row);
      } else {
        target = { id: '<新的 id>' };
      }
      made++;
    }

    for (const l of live){
      const file = l.path.split('/').pop();
      const dest = `${target.id}/${file}`;
      console.log(`  ${co.name}　${l.file_name || file}`);
      console.log(`      ${l.path}`);
      console.log(`   →  ${dest}`);
      if (!GO){ moved++; continue; }

      const src = await fetch(B.pub(`${BUCKET}/${l.path}`));
      if (!src.ok){ console.log(`      ⚠️ 下載失敗 ${src.status}，跳過`); continue; }
      const bytes = Buffer.from(await src.arrayBuffer());

      const up = await fetch(A.store(`${BUCKET}/${dest}`), {
        method: 'POST',
        headers: A.h({ 'Content-Type': src.headers.get('content-type') || 'image/png',
                       'x-upsert': 'true' }),
        body: bytes
      });
      if (!up.ok){ console.log(`      ⚠️ 上傳失敗 ${up.status} ${await up.text()}`); continue; }

      await jpost(A, 'logos', { company_id: target.id, path: dest, file_name: l.file_name || file });
      console.log(`      ✓ ${bytes.length} bytes`);
      moved++;
    }
  }

  console.log(`\n${GO ? '搬好' : '會搬'} ${moved} 張圖`
            + (made ? `，${GO ? '新增' : '會新增'} ${made} 家公司` : '')
            + (skipped ? `，跳過回收桶裡的 ${skipped} 張` : ''));
  if (!GO) console.log('\n確認沒問題就加 --go 真的跑。');
})().catch(e => { console.error('搬家失敗：', e.message); process.exit(1); });
