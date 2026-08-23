#!/usr/bin/env node
/* 商品圖那把鑰匙，兩支程式算出來是不是同一個字串。
 *
 *   node imgkey-parity.mjs
 *
 * 為什麼要有這一支：`imgKey()` 在 product.html 和 2cell-product-pick.html 各有一份
 * （畫布是 srcdoc 塞進去的，載不了共用的 .js，所以那一份沒辦法抽出來共用）。
 * 兩邊算出來只要差一個字，商品目錄那一頁放的圖版面上就找不到 —— 而且**兩邊都不會
 * 有任何錯誤訊息**，圖只是沒出現。這是這個專案裡最安靜的一種壞法，所以值得有一支
 * 專門盯著它的東西。
 *
 * 做法是把兩支檔案裡那幾個函式的原始碼挖出來、真的各跑一遍再比 —— 比字面上長不長得
 * 一樣沒有用：一邊寫 `function imgKey(r){}`、一邊寫 `const imgKey = r => {}`，
 * 本來就長得不一樣，該一樣的是**算出來的東西**。
 *
 * 有差就把每一筆列出來並 exit 1。scenario.mjs 每一次都會先跑它（純 node，不開瀏覽器，
 * 幾十毫秒），所以不會有人忘記。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');

/* 從一整份 HTML 裡挖出某一個函式的定義。從定義開頭掃到花括號收平為止；
   沒有花括號的（單行 arrow）掃到那一句的分號。
   ⚠️ 只夠用來挖這幾個函式：它不認得字串裡的括號和分號，而這幾個函式的字串
   常數只有 '|' 和 ''。挖別的東西之前先確認這件事還成立。 */
function grab(src, name, where){
  const m = new RegExp('(?:function\\s+' + name + '\\s*\\(|(?:const|let|var)\\s+' + name + '\\s*=)')
              .exec(src);
  if (!m) throw new Error(`${where} 裡找不到 ${name}()`);
  let depth = 0, entered = false, i = m.index;
  for (; i < src.length; i++){
    const ch = src[i];
    if (ch === '{'){ depth++; entered = true; }
    else if (ch === '}'){ if (--depth === 0 && entered){ i++; break; } }
    else if (ch === ';' && depth === 0) break;
  }
  const text = src.slice(m.index, i).trim().replace(/^(?:const|let|var)\s+\w+\s*=\s*/, '');
  try { return { fn: new Function('return (' + text + ')')(), text }; }
  catch (err){ throw new Error(`${where} 的 ${name}() 挖出來跑不動：${err.message}`); }
}

/* 這幾筆就是那兩份註解裡講的每一個分支：有規格／有顏色 → 老鑰匙；
   兩個都沒有 → 接 SKU；連 SKU 都沒有 → 接型號；什麼都沒有 → 只好併在一起。 */
const ROWS = [
  { name:'iPhone 17 Pro Max', spec:'256G', color:'黑', sku:'2156742', model:'A3021' },
  { name:'iPhone 17 Pro Max', spec:'512G', color:'',   sku:'2156743', model:'A3021' },
  { name:'洗衣機',            spec:'',     color:'白', sku:'2160001', model:'NA-V150' },
  { name:'變頻冷暖空調',      spec:'',     color:'',   sku:'2161512', model:'CU-UK36BHA2/CS-UK36BA2' },
  { name:'變頻冷暖空調',      spec:'',     color:'',   sku:'',        model:'RAC-28NP1' },
  { name:'變頻冷暖空調',      spec:'',     color:'',   sku:'',        model:'' },
  { name:'空氣清淨機',        spec:'',     color:'',   sku:'  2160777  ', model:'' },   // 前後空白要修掉
  { name:'吸塵器',            spec:'',     color:'',   sku:0,          model:'' },      // 數字 0 不是「有 SKU」
  { name:'吹風機',            spec:'',     color:'',   sku:2160999,    model:'' },      // 數字型 SKU
  { name:'烤箱|大',           spec:'',     color:'',   sku:'2160888',  model:'' },      // 名字裡有分隔符
  { name:'',                  spec:'',     color:'',   sku:'',         model:'' },
  {},
  null,
];

const CASES = [
  ['product.html',            'product.html'],
  ['2cell-product-pick.html', '畫布'],
];

const impls = CASES.map(([file, where]) => ({
  file, where,
  imgKey:     grab(read(file), 'imgKey', where),
  imgKeyBase: grab(read(file), 'imgKeyBase', where),
}));

const bad = [];
const label = r => JSON.stringify(r);

for (const r of ROWS){
  const out = impls.map(m => { try { return String(m.imgKey.fn(r)); } catch (e){ return '✗ ' + e.message; } });
  if (out[0] !== out[1]) bad.push(`imgKey　${label(r)}\n    ${impls[0].file}：${out[0]}\n    ${impls[1].file}：${out[1]}`);
}
/* 讀圖的時候會退回舊鑰匙找一次，所以退法也要一樣 —— 只有 imgKey 一樣、
   imgKeyBase 不一樣的話，症狀是「舊資料的圖不見了」，一樣不會報錯。 */
for (const k of ['a|b|c', 'a|b|c|d', 'a||', 'a|||x', '', 'a']){
  const out = impls.map(m => { try { return String(m.imgKeyBase.fn(k)); } catch (e){ return '✗ ' + e.message; } });
  if (out[0] !== out[1]) bad.push(`imgKeyBase　${JSON.stringify(k)}\n    ${impls[0].file}：${out[0]}\n    ${impls[1].file}：${out[1]}`);
}

/* 主程式裡還有第三份 —— 清除商品圖那一支要在自己手上算一次舊鑰匙（它沒有 imgKeyBase
   這個函式，只有一行 inline）。那一行跟畫布的 imgKeyBase 是同一段字，比字面就夠：
   它本來就是抄過去的，抄錯了同樣不會報錯。 */
const baseBody = impls[1].imgKeyBase.text.replace(/^[^=]*=>\s*/, '').trim();
if (!read('design_and_PM.html').includes(baseBody))
  bad.push(`design_and_PM.html 裡那一行 inline 的舊鑰匙跟 imgKeyBase 對不起來\n    要有這一段：${baseBody}`);

if (bad.length){
  console.error('imgkey ✗ 兩邊算出來不一樣：\n\n  ' + bad.join('\n\n  ') + '\n');
  console.error('  改一邊就要改另一邊 —— 對不起來的時候，商品目錄那一頁放的圖版面上會找不到，');
  console.error('  而且兩邊都不會有任何錯誤訊息，圖只是沒出現。');
  process.exit(1);
}
console.log(`imgkey ok — ${ROWS.length} 筆商品、兩支程式算出來一樣`);
