# Canvas 縮放時的兩個閃爍問題

**症狀**

1. 縮放時文字先變成錯誤大小（放大時暴衝、縮小時過小），約 100ms 後跳回正常。
2. 縮放時 PNG 消失一下再出現，滑鼠連續滾動時幾乎一直是空的。

**共同根因**

縮放被當成了「文件狀態」在處理，所以每次縮放都去 Supabase 重查一次；在等待回應的那段時間裡，畫面用的是本地猜出來的錯誤值。

> **一句話結論**：縮放是 view state，不是 document state。`scale` 改變時，除了 `transform` 之外什麼都不該動。

---

## 問題 1：文字字級在縮放時跳動

文字在等待 SELECT 回應的那段時間裡顯示錯誤字級，回應到達後才恢復。以下三個成因會產生不同的波形，**本專案確認是 A**，B 與 C 一併列出供日後排查。

| 成因 | 放大時 | 縮小時 | 回應後 |
| --- | --- | --- | --- |
| A 雙重套用 | 字暴衝（`F·k²`） | 字過小 | 跳回正常 |
| B 反向補償 | 字過小（`F`，不隨縮放） | 字過大 | 跳回正常 |
| C 亂序回應 | 正常 | 正常 | **卡在錯誤字級不恢復** |

### A · 雙重套用 scale（本案例）

外層容器已經有 `transform: scale(k)`，會把底下所有東西（含文字）等比縮放一次。但樂觀更新的程式碼又把 `font_size × k` 寫回 style，於是螢幕上的實際字級變成：

```
螢幕字級 = font_size × k(來自 style) × k(來自 transform) = F·k²
```

- 放大到 2× → 字變成 4 倍，暴衝
- 縮小到 0.5× → 字變成 0.25 倍，糊成一團
- 100ms 後 SELECT 回來，用資料庫的權威值覆寫成 `F`，才「恢復正常」

延遲越長，錯誤畫面停留越久；把延遲調到 0 就看不到，所以本機開發時容易漏掉。

**修法** — 核心原則：transform 底下的任何元素，都不該再自己乘 scale。

```js
// ❌ 錯
el.style.fontSize = (row.font_size * scale) + 'px';

// ✅ 對 — font_size 是世界座標的值，縮放交給 transform
el.style.fontSize = row.font_size + 'px';
```

Canvas 2D 版本是同一個錯誤：

```js
ctx.setTransform(k, 0, 0, k, ox, oy);
ctx.font = `${row.font_size * k}px Inter`;  // ❌ 又乘一次
ctx.font = `${row.font_size}px Inter`;      // ✅
```

### B · 反向補償（想維持螢幕字級）

方向相反的同一類錯誤。為了讓某些文字「不管怎麼縮放，看起來都一樣大」，樂觀更新寫成 `font_size ÷ k`，剛好抵銷掉 transform：

```js
el.style.fontSize = (row.font_size / scale) + 'px';   // ❌
```

螢幕字級變成 `F·k / k = F`，也就是完全不隨縮放變化。放大時字看起來過小、縮小時過大，SELECT 回來後跳回正常——波形跟 A 上下相反。

**修法**：這個需求本身是合理的（尺寸標註、選取框把手、圖層名稱都該維持固定螢幕大小），但實作位置錯了。應該把這類元素放在 transform **外面**的 overlay 層，用螢幕座標定位：

```html
<div class="world" style="transform: translate(...) scale(k)">
  <!-- 文件內容：字級用世界值，不動 -->
</div>
<div class="overlay">
  <!-- 標註、把手：螢幕座標，字級固定，位置 = worldToScreen(x, y) -->
</div>
```

```js
function worldToScreen(x, y) {
  return { x: x * view.k + view.ox, y: y * view.k + view.oy };
}
```

這樣兩層各自單純：world 層永遠用世界單位，overlay 層永遠用螢幕單位，不需要在任何一層裡做補償運算。

### C · 亂序回應（race condition）

沒有樂觀更新，字級純粹由 SELECT 回應決定，但換算時用了「送出當下」捕捉到的 scale：

```js
async function onZoom(k) {
  view.scale = k;
  applyTransform();
  const { data } = await supabase.from('canvas_objects').select('*');
  render(data, k);          // ❌ k 是舊的閉包變數
}
```

單次縮放看不出問題。但連續滾輪時會同時有多筆查詢在飛，網路抖動讓先送的後到，舊回應覆蓋掉新的，**字級就卡在錯誤值不會自己恢復**——這比 A 更難查，因為它沒有「閃一下」的特徵，只有偶發的錯誤畫面。

**修法**：加 request token 擋掉過期回應（細節見文末「防禦層」一節），並且渲染時讀當前狀態而不是閉包捕捉的值：

```js
render(data, view.scale);   // ✅ 讀當下的 view state
```

### 要一起檢查的地方

搜尋專案裡的 `* scale`、`* zoom`、`/ scale`、`* view.k`。這個乘法通常不只出現一次，以下幾個屬性最常被順手乘到：

| 屬性 | 在 transform 底下要不要乘 scale |
| --- | --- |
| `font-size` | 不要 |
| `x` / `y` / `width` / `height` | 不要 |
| `stroke-width` / `border-width` | 不要 |
| `border-radius` | 不要 |
| 滑鼠座標 → 世界座標 | **要**，但方向是除以 `k` |
| transform 外層的 overlay（尺寸標註、選取框把手） | **要**，因為它不在被縮放的層裡 |

### 如果原本乘 scale 是為了「字要清晰」

那個需求要用別的方式滿足，不能改 `font_size`：

- **DOM 文字**：瀏覽器在 `transform: scale()` 下會自動重新柵格化，本來就清晰，不需處理。
- **Canvas 文字**：調 backing store，不是調 `ctx.font`。

  ```js
  const dpr = devicePixelRatio || 1;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, ox, oy);
  ctx.font = `${row.font_size}px Inter`;   // 仍然用世界值
  ```

- **不隨縮放變大的標籤**（像 Figma 的尺寸標註）：放在 transform **外面**的 overlay 層，用螢幕座標定位，而不是在裡面除以 `k`。

---

## 問題 2：PNG 在縮放時重新下載

圖檔存在 Supabase Storage，metadata 走 SQL。縮放觸發重查後，圖片的 `src` 被重設，瀏覽器判定為新資源，於是重新下載；下載完成前元素是空的。

以下四個成因都會造成同樣的畫面，逐一排除：

### S1 · 每次都重簽 signed URL（最常見）

`createSignedUrl()` 每次呼叫都產生新 token，URL 字串不同 → 瀏覽器視為不同資源 → 必定重新下載。

這是「圖檔放上 Supabase 之後才出現、放本機時不會」的典型症狀，也是連續滾輪時流量會飆到幾十 MB 的原因。

**修法 A — 不需權限控管就用 public URL**，URL 永久固定，快取才會生效：

```js
const { data } = supabase.storage.from('assets').getPublicUrl(path);
// data.publicUrl 是穩定字串
```

**修法 B — 需要簽名就在前端快取簽好的 URL**，同一個 path 在有效期內重複使用：

```js
const urlCache = new Map();  // path -> { url, exp }

export async function getSignedUrl(path) {
  const hit = urlCache.get(path);
  if (hit && hit.exp > Date.now() + 60_000) return hit.url;  // 留 60s 安全邊界

  const { data, error } = await supabase.storage
    .from('assets').createSignedUrl(path, 3600);
  if (error) throw error;

  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 3600_000 });
  return data.signedUrl;
}
```

多張圖一次簽用 `createSignedUrls(paths, expiresIn)`，避免 N 次往返。

### S2 · URL 帶 cache-bust 參數

```js
img.src = url + '?t=' + Date.now();   // ❌ 每次都繞過快取
```

原意是「確保拿到最新的圖」，代價是永遠不命中快取。改成只在圖片真的被替換時才會變的值：

```js
img.src = `${url}?v=${row.updated_at}`;   // ✅ 圖沒換就不會變
```

### S3 · 節點被重建

即使 URL 完全沒變，只要 `<img>` 節點被 unmount / 重新建立，就會重新解碼、閃一格。常見寫法：

```jsx
// ❌ key 綁到 scale，每次縮放整棵重建
<ImageLayer key={`${obj.id}-${scale}`} />

// ❌ 每次 render 重寫 innerHTML
world.innerHTML = objects.map(renderObject).join('');
```

修法：

```jsx
// ✅ key 只綁身份，縮放只改外層 transform
const ImageLayer = memo(function ImageLayer({ obj }) {
  return <img src={obj.url} alt="" style={{ left: obj.x, top: obj.y,
                                            width: obj.w, height: obj.h }} />;
}, (a, b) => a.obj === b.obj);

<div className="world" style={{ transform: `translate(${ox}px,${oy}px) scale(${k})` }}>
  {objects.map(o => <ImageLayer key={o.id} obj={o} />)}
</div>
```

重點是讓 `scale` 只影響最外層那一個 style 屬性，不進入子元件的 props。

### S4 · URL 相同、只是重設 src

```js
img.src = sameUrl;   // 其實走記憶體快取，不會閃
```

這種情況瀏覽器不會重新下載。**如果排除到這裡還是閃，問題就不在圖片本身**，而是整個容器被重繪（例如父層 `display` 切換、`will-change` 反覆增減、或整層 remount）。

保險起見還是加個比對：

```js
if (img.dataset.src !== url) {
  img.dataset.src = url;
  img.src = url;
}
```

---

## 根本修法：縮放不碰後端

上面兩個問題各自的修補都有效，但真正該改的是這一層。物件資料在縮放時完全沒變，沒有理由重查。

```js
// ❌ 現在
function setZoom(k) {
  view.scale = k;
  applyTransform();
  fetchObjects();          // 每次縮放一次往返
}

// ✅ 改成
function setZoom(k) {
  view.scale = k;
  applyTransform();        // 只做這件事
}
```

資料的重新載入應該由這些事件觸發，而不是縮放：

- 開啟畫布 / 切換檔案
- 使用者編輯物件（並且用樂觀更新 + 失敗回滾）
- Supabase Realtime 推播他人的變更
- 使用者手動重新整理

改完之後，把模擬延遲拉到 1500ms 都不會閃，因為根本沒有「等待期間顯示錯誤值」這個時間窗。

---

## 防禦層：擋掉過期回應

未來若有真的需要在視窗變動時重查的場景（例如 viewport-based 分頁載入），加 request token，避免舊回應覆蓋新狀態：

```js
let reqId = 0;

async function refresh() {
  const my = ++reqId;
  const { data, error } = await supabase.from('canvas_objects').select('*');
  if (my !== reqId) return;    // 已經有更新的請求，丟棄這筆
  if (error) return handleError(error);
  render(data);
}
```

沒有這道防線時，網路抖動會讓舊結果最後才到、覆蓋掉新的，畫面就卡在錯誤狀態不會自己恢復——那比閃一下更難查。

---

## 驗收：交給 Claude 自動跑

以下三關可以整段貼給 Claude Code / Cowork 執行，不需要人工開 DevTools 目視。三關全綠才算修好。

### 關卡 1 — 靜態掃描（grep）

在專案根目錄執行，任何一項有輸出就是還沒改乾淨：

```bash
# 1a. transform 底下不該出現的 scale 乘除
rg -n --glob '!node_modules' \
   -e '(font[Ss]ize|fontSize)[^;\n]*[*/]\s*(scale|zoom|view\.k|k)\b' \
   -e 'ctx\.font\s*=[^;\n]*[*/]\s*(scale|zoom|k)\b' \
   -e '(strokeWidth|lineWidth|borderRadius)[^;\n]*[*/]\s*(scale|zoom|k)\b' src

# 1b. 縮放時觸發的資料查詢
rg -n -B4 --glob '!node_modules' \
   -e 'from\(.canvas_objects.\)\.select' src \
   | rg -i 'zoom|scale|wheel|pinch'

# 1c. cache-bust 與每次重簽的 signed URL
rg -n --glob '!node_modules' \
   -e '\?t=.*Date\.now\(\)' \
   -e 'createSignedUrl' src

# 1d. React key 綁到縮放狀態
rg -n --glob '!node_modules' 'key=\{[^}]*\b(scale|zoom|k)\b[^}]*\}' src
```

**判定**：1a、1b、1d 必須零輸出。1c 若有 `createSignedUrl`，需確認呼叫點外面有 URL 快取（見問題 2 · S1），且該函式不在縮放路徑上。

### 關卡 2 — 執行期斷言（Playwright）

存成 `tests/zoom.spec.ts`，`npx playwright test` 執行。所有數值都是機器可判定的，不依賴目視：

```ts
import { test, expect } from '@playwright/test';

const APP = 'http://localhost:5173';
const TEXT = '[data-testid="canvas-text"]';   // 換成你的選擇器
const IMG  = '[data-testid="canvas-image"]';

async function zoomTo(page, k: number) {
  await page.evaluate((k) => (window as any).__setZoom(k), k);  // 暴露測試用 hook
  await page.waitForTimeout(50);
}

test.beforeEach(async ({ page }) => {
  await page.goto(APP);
  await page.waitForSelector(TEXT);
});

// A / B：縮放全程螢幕字級 = font_size × k
test('字級不受雙重縮放或反向補償影響', async ({ page }) => {
  const base = await page.$eval(TEXT, el =>
    parseFloat(getComputedStyle(el).fontSize));

  for (const k of [0.4, 0.7, 1, 1.8, 2.6, 3.5]) {
    await zoomTo(page, k);
    const samples: number[] = [];
    // 在 SELECT 往返期間密集取樣，抓出中途的錯誤值
    for (let i = 0; i < 25; i++) {
      samples.push(await page.$eval(TEXT, el =>
        parseFloat(getComputedStyle(el).fontSize)));
      await page.waitForTimeout(20);
    }
    for (const px of samples) {
      expect(px / base).toBeCloseTo(1, 2);   // style 上的字級不隨 k 變動
    }
  }
});

// C：連續縮放後不會卡在舊 scale 換算出來的字級
test('亂序回應不會殘留錯誤字級', async ({ page }) => {
  const base = await page.$eval(TEXT, el =>
    parseFloat(getComputedStyle(el).fontSize));

  for (let i = 0; i < 30; i++) {
    await zoomTo(page, 0.5 + Math.random() * 3);
    await page.waitForTimeout(30);
  }
  await zoomTo(page, 1);
  await page.waitForTimeout(1500);           // 等所有 in-flight 回應落地

  const px = await page.$eval(TEXT, el => parseFloat(getComputedStyle(el).fontSize));
  expect(px).toBeCloseTo(base, 1);
});

// S1–S4：縮放期間不得有任何圖片請求
test('縮放不觸發圖片重新下載', async ({ page }) => {
  await page.waitForTimeout(1000);            // 讓首次載入完成
  const imgReqs: string[] = [];
  page.on('request', r => {
    if (r.resourceType() === 'image') imgReqs.push(r.url());
  });

  for (let i = 0; i < 40; i++) {
    await zoomTo(page, 0.5 + (i % 8) * 0.4);
    await page.waitForTimeout(45);
  }
  await page.waitForTimeout(800);
  expect(imgReqs).toHaveLength(0);
});

// 根本修法：縮放不得打後端
test('縮放不觸發 canvas_objects 查詢', async ({ page }) => {
  await page.waitForTimeout(1000);
  const dbReqs: string[] = [];
  page.on('request', r => {
    if (/\/rest\/v1\/canvas_objects|\/storage\/v1\/object\/sign/.test(r.url()))
      dbReqs.push(r.url());
  });

  for (let i = 0; i < 20; i++) { await zoomTo(page, 1 + i * 0.15); }
  await page.waitForTimeout(800);
  expect(dbReqs).toHaveLength(0);
});

// S1：URL 必須穩定
test('圖片 URL 在多次縮放後保持同一字串', async ({ page }) => {
  const urls = new Set<string>();
  for (let i = 0; i < 10; i++) {
    await zoomTo(page, 0.6 + i * 0.3);
    urls.add(await page.$eval(IMG, (el: any) => el.currentSrc || el.src));
  }
  expect(urls.size).toBe(1);
});

// S3：節點不得被重建
test('圖片 DOM 節點不被重建', async ({ page }) => {
  await page.$eval(IMG, el => ((el as any).__mark = 'keep-me'));
  for (let i = 0; i < 10; i++) await zoomTo(page, 0.6 + i * 0.3);
  const mark = await page.$eval(IMG, el => (el as any).__mark);
  expect(mark).toBe('keep-me');   // undefined 代表節點換過了
});
```

需要在應用裡加一個測試用 hook（正式版可用環境變數關掉）：

```ts
if (import.meta.env.DEV) (window as any).__setZoom = setZoom;
```

### 關卡 3 — 高延遲重跑

把 Supabase client 包一層人工延遲，重跑關卡 2。延遲越長，A/B/C 的錯誤窗口越明顯——如果只有低延遲時會過，代表 bug 還在，只是被本機速度掩蓋：

```ts
const slow = new Proxy(supabase, {
  get: (t, p) => p === 'from'
    ? (...a: any[]) => wrapDelay((t as any).from(...a), 1200)
    : (t as any)[p],
});
```

**判定**：延遲 1200ms 下關卡 2 全數通過。

### 交給 Claude 執行的指令

```
讀 canvas-zoom-bugs.md，依序執行「驗收」三關：
1. 跑關卡 1 的 rg 指令，把每一項的輸出貼出來並判定通過與否
2. 建立 tests/zoom.spec.ts、加上 __setZoom hook、執行 npx playwright test
3. 套用關卡 3 的延遲包裝後重跑
任何一項失敗，對照文件中的成因（A/B/C 或 S1–S4）指出是哪一個，
修好後重跑該關，不要跳過。最後回報三關的通過狀態。
```

---

## 附：兩個模擬檔

- `zoom-font-flicker-lab.html` — 重現字級雙重縮放，附偏差倍率折線圖
- `zoom-image-reload-lab.html` — 重現圖片重載，附可見狀態時間軸與流量統計

兩個檔案都是單檔離線可用，左右分割對照有 bug 與正確的實作，可調整延遲與成因模式。修改自己的程式後，可以拿它們當對照組確認波形是否一致。
