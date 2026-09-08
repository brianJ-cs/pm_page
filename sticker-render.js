/* ==========================================================================
   貼紙怎麼畫出來 —— 一份，兩邊共用。
   ・貼紙庫（sticker_editor.html）：畫櫃子裡的縮圖、畫編輯中的那一張
   ・格子裡的畫布（2cell-product-pick.html）：畫貼到版面上的那一張
   以前只有貼紙庫畫得出來，所以貼上去的是一張**烤平的圖** —— 那表示每一格的字
   永遠一樣，而貼紙庫整套「可變文字」在版面上完全用不到。抄一份到畫布那邊也不行：
   貼紙庫改一點版面，版上就跟著錯，而且看不出來。所以抽成這一支。
   零相依、沒有 build：跟 supabase-sync.js 同一種穿法，兩邊都用 <script src> 載。
   ⚠️ 它只管「畫」。存檔、圖層編輯、匯入匯出留在貼紙庫那一支。
   ⚠️ 版面用到的那幾條 CSS（.lyr／.lbl／.ft）兩邊各有一份 —— 那是幾行定位規則，
      改壞了在自己那一頁一眼就看得到；真正會悄悄走鐘的是這裡這幾百行。
   ========================================================================== */
(function(global){
'use strict';
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const r4=v=>Math.round(v*10000)/10000;
/* 圖片圖層的來源：呼叫的人可以直接給一份對照表（版面上那一張貼紙自己帶著），
   給不出來就問宿主（貼紙庫那邊是它自己那份 ASSETS）。 */
function assetOf(assets,k){
  if(assets&&assets[k])return assets[k];
  const f=SR.resolveAsset;
  return (f&&f(k))||'';
}
function rr(x,y,w,h,r){r=Math.max(0,Math.min(r,w/2,h/2));
  return `M${x+r},${y}H${x+w-r}A${r},${r} 0 0 1 ${x+w},${y+r}V${y+h-r}A${r},${r} 0 0 1 ${x+w-r},${y+h}H${x+r}A${r},${r} 0 0 1 ${x},${y+h-r}V${y+r}A${r},${r} 0 0 1 ${x+r},${y}Z`;}
function starPath(cx,cy,rx,ry,n,inner){
  const p=[];for(let i=0;i<n*2;i++){const a=Math.PI*i/n-Math.PI/2,k=i%2?inner:1;
    p.push((cx+Math.cos(a)*rx*k).toFixed(2)+','+(cy+Math.sin(a)*ry*k).toFixed(2));}
  return 'M'+p.join('L')+'Z';}
/* 回傳 svg 內部標記；W/H 為該圖層的實際 px 尺寸 */
function shapeInner(l,W,H){
  const p=l.params||{},sw=l.strokeW||0,s=sw/2,iw=W-sw,ih=H-sw;
  const fill=l.fill==='none'?'none':l.fill;
  const sa=sw?` stroke="${l.stroke}" stroke-width="${sw}" stroke-linejoin="round"`:'';
  const P=d=>`<path d="${d}" fill="${fill}"${sa}/>`;
  const rad=(p.radius!=null?p.radius:.18)*Math.min(iw,ih)/2;
  switch(l.shape){
    case 'rect':return P(rr(s,s,iw,ih,rad*2));
    case 'bar':return P(rr(s,s,iw,ih,rad));
    case 'pill':return P(rr(s,s,iw,ih,Math.min(iw,ih)/2));
    case 'circle':return `<ellipse cx="${W/2}" cy="${H/2}" rx="${iw/2}" ry="${ih/2}" fill="${fill}"${sa}/>`;
    case 'triangle':return P(`M${W/2},${s}L${W-s},${H-s}H${s}Z`);
    case 'diamond':return P(`M${W/2},${s}L${W-s},${H/2}L${W/2},${H-s}L${s},${H/2}Z`);
    case 'hex':return P(`M${W*.25},${s}H${W*.75}L${W-s},${H/2}L${W*.75},${H-s}H${W*.25}L${s},${H/2}Z`);
    case 'chevron':{const t=(p.thick!=null?p.thick:.45)*W;
      return P(`M${s},${s}L${W-s},${H/2}L${s},${H-s}L${s+t},${H-s}L${Math.max(W-s-t,s+t+1)},${H/2}L${s+t},${s}Z`);}
    case 'arrow':{const hd=(p.head!=null?p.head:.4)*W,tw=(p.tail!=null?p.tail:.55);
      return P(`M${s},${H*(.5-tw/2)}H${W-hd}V${s}L${W-s},${H/2}L${W-hd},${H-s}V${H*(.5+tw/2)}H${s}Z`);}
    case 'ribbon':{const n=(p.notch!=null?p.notch:.3)*H;
      return P(`M${s},${s}H${W-s}L${W-s-n},${H/2}L${W-s},${H-s}H${s}L${s+n},${H/2}Z`);}
    case 'tag':{const n=(p.notch!=null?p.notch:.34)*H,r=Math.min(ih*.18,iw*.3);
      return P(`M${n+s},${s}H${W-s-r}A${r},${r} 0 0 1 ${W-s},${s+r}V${H-s-r}A${r},${r} 0 0 1 ${W-s-r},${H-s}H${n+s}L${s},${H/2}Z`)
        +`<circle cx="${n+H*.22}" cy="${H/2}" r="${H*.09}" fill="#fff" opacity=".9"/>`;}
    case 'burst':return P(starPath(W/2,H/2,iw/2,ih/2,p.spikes||16,p.inner||.74));
    case 'star':return P(starPath(W/2,H*.52,iw/2,ih/2,p.spikes||5,p.inner||.42));
    case 'seal':return P(starPath(W/2,H/2,iw/2,ih/2,p.spikes||22,p.inner||.9));
    case 'speech':{const bh=H*.8;
      return P(rr(s,s,iw,bh-sw,bh*.22)+`M${W*.24},${bh-1}L${W*.2},${H-s}L${W*.44},${bh-1}Z`);}
    case 'shield':return P(`M${W/2},${s}L${W-s},${H*.2}V${H*.55}Q${W-s},${H*.85} ${W/2},${H-s}Q${s},${H*.85} ${s},${H*.55}V${H*.2}Z`);
    case 'custom':return `<g transform="scale(${W/100},${H/100})"><path d="${p.path||'M10,10H90V90H10Z'}" fill="${fill}" stroke="${sw?l.stroke:'none'}" stroke-width="${sw?sw:0}" vector-effect="non-scaling-stroke"/></g>`;
  }
  return '';
}
/* ════════ 2. 圖層模型 ════════ */
const FONTS={
  sans:{n:'黑體',css:"-apple-system,'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif"},
  serif:{n:'明體',css:"'Noto Serif TC','Songti TC','PMingLiU','Times New Roman',serif"},
  round:{n:'圓體',css:"'Yuanti TC','Yuanti SC','Noto Sans TC','Microsoft JhengHei',sans-serif"},
  kai:{n:'楷體',css:"'Kaiti TC','DFKai-SB','BiauKai',serif"},
  mono:{n:'等寬',css:"ui-monospace,Menlo,Consolas,'Noto Sans Mono CJK TC',monospace"}
};
/* 每 n 個字插一次換行；已經手動換行的地方各自獨立計算 */
function wrapByCount(txt,n){
  if(!n||n<1)return txt;
  return String(txt).split('\n').map(line=>{
    const out=[];for(let i=0;i<line.length;i+=n)out.push(line.slice(i,i+n));
    return out.join('\n');
  }).join('\n');
}
/* 有 label 的形狀也算「可變文字」，一樣進 sticker_fields */
const hasLabel=l=>l.type==='shape'&&!!l.label;
const contentOf=l=>hasLabel(l)?l.label.content:l.content;
const styleOf=l=>hasLabel(l)?l.label:l;
/* 圖層 → HTML；AW/AH 是整張貼紙的 px 尺寸 */
function layerHTML(l,AW,AH,val,editable,assets){
  if(l.visible===false)return '';
  const W=Math.max(1,l.w*AW),H=Math.max(1,l.h*AH);
  const base=`left:${(l.x*100).toFixed(3)}%;top:${(l.y*100).toFixed(3)}%;width:${(l.w*100).toFixed(3)}%;height:${(l.h*100).toFixed(3)}%;`+
    (l.rot?`transform:rotate(${l.rot}deg);`:'')+(l.opacity!=null&&l.opacity!==1?`opacity:${l.opacity};`:'');
  if(l.type==='shape'){
    const svg=`<svg viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${shapeInner(l,W,H)}</svg>`;
    let lbl='';
    if(l.label){
      const b=l.label,v2=val||{};
      const fsz=(v2.font_size!=null?v2.font_size:b.size)*AH;
      const col2=v2.color||b.color,wt2=Math.max(1,Number(v2.weight||b.weight)||400);
      const al2=v2.align||b.align;
      const fx=(wt2>900&&!b.outline)?((wt2-900)/2100*0.06*fsz):0;
      const txt=wrapByCount(v2.content!=null?v2.content:b.content,b.wrap);
      const ls=[`font-size:${fsz.toFixed(2)}px`,`color:${col2}`,`font-weight:${Math.min(1000,wt2)}`,
        `font-family:${(FONTS[b.font||'sans']||FONTS.sans).css}`,
        `line-height:${b.lh||1.15}`,`letter-spacing:${((b.ls||0)*fsz).toFixed(2)}px`,
        `text-align:${al2}`,
        `justify-content:${al2==='left'?'flex-start':al2==='right'?'flex-end':'center'}`,
        fx?`-webkit-text-stroke:${fx.toFixed(2)}px ${col2};paint-order:stroke fill`:'',
        b.outline?`-webkit-text-stroke:${(b.outline*fsz).toFixed(2)}px ${b.outlineColor||'#fff'};paint-order:stroke fill`:''
      ].filter(Boolean).join(';');
      lbl=`<div class="lbl" data-lid="${l.id}" style="${ls}"><div class="ft"${editable?' contenteditable="true" spellcheck="false"':''}>${esc(txt)}</div></div>`;
    }
    return `<div class="lyr sh" data-lid="${l.id}" style="${base}">${svg}${lbl}</div>`;
  }
  if(l.type==='image')
    return `<div class="lyr im" data-lid="${l.id}" style="${base}"><img src="${assetOf(assets,l.asset)}" alt=""></div>`;
  const v=val||{},size=(v.font_size!=null?v.font_size:l.size)*AH;
  const col=v.color||l.color,wt=v.weight||l.weight,al=v.align||l.align;
  const va=l.valign||'center';
  const flexMain=l.vertical
    ? (va==='top'?'flex-start':va==='bottom'?'flex-end':'center')
    : (al==='left'?'flex-start':al==='right'?'flex-end':'center');
  const flexCross=l.vertical
    ? (al==='left'?'flex-start':al==='right'?'flex-end':'center')
    : (va==='top'?'flex-start':va==='bottom'?'flex-end':'center');
  const wtN=Math.max(1,Number(wt)||400);
  const wtCss=Math.min(1000,wtN);
  // CSS font-weight 上限是 1000，而且多數中文字型只有幾個實體字重；
  // 超過的部分用同色描邊模擬（faux bold），有設描邊時則以描邊優先
  const faux=(wtN>900&&!l.outline)?((wtN-900)/2100*0.06*size):0;
  const st=base+[`font-size:${size.toFixed(2)}px`,`color:${col}`,`font-weight:${wtCss}`,
    faux?`-webkit-text-stroke:${faux.toFixed(2)}px ${col};paint-order:stroke fill`:'',
    `font-family:${(FONTS[l.font||'sans']||FONTS.sans).css}`,
    `align-items:${flexCross}`,`justify-content:${flexMain}`,
    `text-align:${al}`,`line-height:${l.lh||1.05}`,`letter-spacing:${((l.ls||0)*size).toFixed(2)}px`,
    l.vertical?'writing-mode:vertical-rl;text-orientation:upright':'',
    l.italic?'font-style:italic':'',
    l.underline?'text-decoration:underline;text-underline-offset:.14em':'',
    l.bg&&l.bg!=='none'?`background:${l.bg}`:'',
    l.bgPad?`padding:${(l.bgPad*size).toFixed(1)}px`:'',
    l.radius?`border-radius:${(l.radius*Math.min(W,H)).toFixed(1)}px`:'',
    l.shadow?`text-shadow:${((l.shadowX||0)*size).toFixed(2)}px ${((l.shadowY||0)*size).toFixed(2)}px ${((l.shadow||0)*size).toFixed(2)}px ${l.shadowColor||'#00000066'}`:'',
    l.outline?`-webkit-text-stroke:${(l.outline*size).toFixed(2)}px ${l.outlineColor||'#fff'};paint-order:stroke fill`:''
  ].filter(Boolean).join(';');
  return `<div class="lyr tx" data-lid="${l.id}"${l.autoFit?' data-fit="1"':''} style="${st}"><div class="ft"${editable?' contenteditable="true" spellcheck="false"':''}>${esc(v.content!=null?v.content:l.content)}</div></div>`;
}
function renderTemplate(tpl,AW,AH,valsByLayer,editable,assets){
  return tpl.layers.map(l=>layerHTML(l,AW,AH,valsByLayer?valsByLayer[l.id]:null,editable,assets)).join('');
}
const textLayers=tpl=>tpl.layers.filter(l=>l.type==='text'||hasLabel(l));
/* 量一段文字在指定樣式下的實際 px 尺寸（離螢幕量，不會閃） */
let _rule=null;
function measureText(txt,styleCss){
  if(!_rule){_rule=document.createElement('div');
    _rule.style.cssText='position:fixed;left:-9999px;top:-9999px;visibility:hidden;'+
      'white-space:pre;display:inline-block;pointer-events:none';
    document.body.appendChild(_rule);}
  _rule.style.cssText=_rule.style.cssText.split(';').slice(0,6).join(';')+';'+styleCss;
  _rule.textContent=txt||' ';
  const r=_rule.getBoundingClientRect();
  return {w:r.width,h:r.height};
}
/* 形狀跟著字長變大：回傳 true 表示有改動 */
function growShapes(tpl,AW,AH){
  let changed=false;
  tpl.layers.forEach(l=>{
    if(!hasLabel(l))return;
    const b=l.label;
    if(!b.grow||b.grow==='none')return;
    const fsz=b.size*AH;
    if(fsz<1)return;
    const wt=Math.min(1000,Number(b.weight)||400);
    const css=`font-size:${fsz}px;font-weight:${wt};`+
      `font-family:${(FONTS[b.font||'sans']||FONTS.sans).css};`+
      `line-height:${b.lh||1.15};letter-spacing:${((b.ls||0)*fsz).toFixed(3)}px`;
    const txt=wrapByCount(b.content,b.wrap);
    const lines=String(txt).split('\n');
    let mw=0;lines.forEach(ln=>{mw=Math.max(mw,measureText(ln,css).w);});
    const lineH=fsz*(b.lh||1.15);
    const needW=mw+2*(b.padX||0)*fsz;
    const needH=lines.length*lineH+2*(b.padY||0)*fsz;
    const cx=l.x+l.w/2,cy=l.y+l.h/2;                 // 以中心為錨點長大，不會往右飄
    const nw=r4(needW/AW);
    if(Math.abs(nw-l.w)>0.0015){l.w=nw;l.x=r4(cx-nw/2);changed=true;}
    if(b.grow==='wh'){
      const nh=r4(needH/AH);
      if(Math.abs(nh-l.h)>0.0015){l.h=nh;l.y=r4(cy-nh/2);changed=true;}
    }
  });
  return changed;
}
/* 自動縮小以塞進文字框 */
function fitTexts(root){
  root.querySelectorAll('.lyr.tx[data-fit="1"]').forEach(el=>{
    const ft=el.querySelector('.ft');if(!ft)return;
    let size=parseFloat(el.style.fontSize)||12,g=0;
    while(g++<50&&size>2&&(ft.scrollWidth>el.clientWidth+1||ft.scrollHeight>el.clientHeight+1)){
      size*=.94;el.style.fontSize=size.toFixed(2)+'px';
    }
  });
}
/* growShapes 要看實際文字才知道要多寬，這裡把 sticker_fields 的內容暫時套進模板物件。
   tpl 是每次 tplOf() 產生的新物件，改它不會動到 sticker_lib。 */
function applyVals(tpl,vals){
  tpl.layers.forEach(l=>{
    const v=vals[l.id];if(!v)return;
    if(hasLabel(l)){
      if(v.content!=null)l.label.content=v.content;
      if(v.font_size!=null)l.label.size=Number(v.font_size);
      if(v.weight!=null)l.label.weight=Number(v.weight);
    }
  });
  return tpl;
}

/* ── 從模板撈出用到的 asset key ── */
function assetKeysOf(tplStr){
  const out=new Set();
  try{JSON.parse(tplStr).layers.forEach(l=>{if(l.type==='image'&&l.asset)out.add(l.asset);});}catch(e){}
  return out;
}
const SR={
  esc,r4,rr,starPath,shapeInner,FONTS,
  wrapByCount,hasLabel,contentOf,styleOf,textLayers,
  layerHTML,renderTemplate,measureText,growShapes,fitTexts,applyVals,assetKeysOf,
  resolveAsset:null          // 宿主自己那份圖片對照表（貼紙庫用；畫布那邊都是直接給）
};
global.StickerRender=SR;
})(typeof window!=='undefined'?window:this);
