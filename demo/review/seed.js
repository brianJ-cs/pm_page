/* 審核系統雛形的假資料。
 *
 * 欄位照《系統建置資料需求說明書 v3.0》：人員（3.2）、PM 階層與商品對照（3.3）、商品（3.4）。
 * 接上 Supabase 之後這一支就不用了 —— 人員、分類、商品是全國電子推過來的，
 * 檔期、版位、格子是系統自己長出來的。這裡只是讓本機模式有東西可以試。
 *
 * **名字直接寫他在流程裡是誰**（冰箱洗衣機PM、家電課長…），測的時候一眼看得出輪到誰、誰審過；
 * 員工編號和人跟分類的關係沒變，換回真名只改這一份。
 *
 * 故意排進來的情況（每一種都要有一個人可以登入試）：
 *   ・3C課長兼筆電PM：筆電的 PM 同時是課長（蓋章後課長那一層自動略過）
 *   ・部長兼機上盒PM：機上盒的 PM、課長、部長都是她（兩層都略過）
 *   ・版位二有四位 PM、兩位課長（3C課長兼筆電PM、部長兼機上盒PM）
 *   ・冷氣PM請假中，由她的課長家電課長代理（他代蓋的章仍算 PM 那一層）
 *   ・行銷處協理、律師：資料需求書的 role 只准 design／pm／mkt，先填 mkt，部門寫清楚
 *   ・離職PM：已離職（is_active=false），登得進 Google 但進不了系統
 *
 * **日期一律照今天算**（今天＝提明細第一天、職代今天 0 點到三天後 18:00）：
 * 寫死日期的話過幾天打開，代理全部過期、每一關都是延遲，看起來像功能壞掉。
 */
(function (root) {
  'use strict';

  const DAY = 86400000;

  const members = [
    // 商品端（role＝pm；層級不在這裡，在分類對照表裡）
    { employee_id: 'E10001', name: '商品處協理', email: 'exec@example.com', role: 'pm',     department: '商品處',       title: '商品處協理', is_active: true },
    { employee_id: 'E10056', name: '部長兼機上盒PM', email: 'director@example.com',  role: 'pm',     department: '商品部',       title: '商品部主管', is_active: true },
    { employee_id: 'E10118', name: '家電課長', email: 'appliance.manager@example.com',      role: 'pm',     department: '商品部 家電課', title: '商品課長',   is_active: true },
    { employee_id: 'E10131', name: '3C課長兼筆電PM', email: '3c.manager@example.com',   role: 'pm',     department: '商品部 3C課',  title: '商品課長',   is_active: true },
    { employee_id: 'E10234', name: '冰箱洗衣機PM', email: 'fridge.pm@example.com',     role: 'pm',     department: '商品部 家電課', title: '商品主辦',   is_active: true },
    { employee_id: 'E10245', name: '冷氣PM', email: 'aircon.pm@example.com',   role: 'pm',     department: '商品部 家電課', title: '商品主辦',   is_active: true },
    { employee_id: 'E10252', name: '電視PM', email: 'tv.pm@example.com',   role: 'pm',     department: '商品部 3C課',  title: '商品主辦',   is_active: true },
    { employee_id: 'E10260', name: '手機PM', email: 'phone.pm@example.com',   role: 'pm',     department: '商品部 3C課',  title: '商品主辦',   is_active: true },
    { employee_id: 'E10199', name: '離職PM', email: 'former.pm@example.com',    role: 'pm',     department: '商品部 家電課', title: '商品主辦',   is_active: false },
    // 設計
    { employee_id: 'E20002', name: '設計主管', email: 'design.lead@example.com',      role: 'design', department: '行銷企劃部 設計組', title: '設計主管',   is_active: true },
    { employee_id: 'E20011', name: '設計 A', email: 'design.a@example.com',     role: 'design', department: '行銷企劃部 設計組', title: '資深設計師', is_active: true },
    { employee_id: 'E20015', name: '設計 B', email: 'design.b@example.com',    role: 'design', department: '行銷企劃部 設計組', title: '設計師',     is_active: true },
    { employee_id: 'E20019', name: '設計 C', email: 'design.c@example.com',  role: 'design', department: '行銷企劃部 設計組', title: '設計師',     is_active: true },
    // 行銷
    { employee_id: 'E30007', name: '行銷 A', email: 'mkt.a@example.com',    role: 'mkt',    department: '行銷企劃部',   title: '行銷企劃',   is_active: true },
    { employee_id: 'E30012', name: '行銷 B', email: 'mkt.b@example.com',  role: 'mkt',    department: '行銷企劃部',   title: '行銷企劃',   is_active: true },
    // 最終審核的後兩關（role 只能三選一，先掛在 mkt）
    { employee_id: 'E30001', name: '行銷處協理', email: 'mkt.exec@example.com',    role: 'mkt',    department: '行銷處',       title: '行銷處協理', is_active: true },
    { employee_id: 'E40003', name: '律師', email: 'lawyer@example.com', role: 'mkt',    department: '法務室',       title: '律師',       is_active: true },
  ];

  const nameOf = id => (members.find(m => m.employee_id === id) || {}).name || '';

  /* 一個分類一筆、四位負責人。*_name 照需求書一起帶（它就是這樣推過來的），
     但系統一律照 *_id 判斷 —— 名字會改、會同名。 */
  const cat = (category_id, category_name, owner_id, manager_id, director_id, executive_id) => ({
    category_id, category_name,
    owner_id,     owner_name:     nameOf(owner_id),
    manager_id,   manager_name:   nameOf(manager_id),
    director_id,  director_name:  nameOf(director_id),
    executive_id, executive_name: nameOf(executive_id),
  });

  const assignments = [
    cat('101', '冰箱',   'E10234', 'E10118', 'E10056', 'E10001'),
    cat('102', '洗衣機', 'E10234', 'E10118', 'E10056', 'E10001'),
    cat('103', '冷氣',   'E10245', 'E10118', 'E10056', 'E10001'),
    cat('201', '電視',   'E10252', 'E10131', 'E10056', 'E10001'),
    cat('202', '筆電',   'E10131', 'E10131', 'E10056', 'E10001'),
    cat('203', '手機',   'E10260', 'E10131', 'E10056', 'E10001'),
    cat('111', '機上盒', 'E10056', 'E10056', 'E10056', 'E10001'),
  ];

  /* 商品（需求書 3.4 的一小部分欄位）。sku **不得含空格**（實作指南 2.4）：
     圖片比對是拿空格把檔名切成好幾個編號。
     category_id 是 '900' 的是贈品用的配件 —— 贈品不受品類權限限制，任何 PM 都能打它的編號。 */
  const p = (sku, category_id, brand, name, spec, price, info) => ({ sku, category_id, brand, name, spec, price, info: info || '' });
  const products = [
    p('R-HW620RV',    '101', 'HITACHI',   '日立 六門變頻冰箱',       '614L',              62900, '一級能效'),
    p('NR-F607HX',    '101', 'Panasonic', '國際牌 六門變頻冰箱',     '600L',              59900, 'nanoe X 抑菌'),
    p('SR-C61DV',     '101', 'SAMPO',     '聲寶 雙門變頻冰箱',       '580L',              25900),
    p('GR-QBFL87BS',  '101', 'LG',        'LG 對開雙門冰箱',         '870L',              69900, ''),
    p('NA-V190NMS',   '102', 'Panasonic', '國際牌 滾筒洗脫烘',       '19kg',              45900, '溫水洗淨'),
    p('WD-S19VBS',    '102', 'LG',        'LG 蒸氣滾筒洗衣機',       '19kg',              29900),
    p('ES-N17DPS',    '102', 'SAMPO',     '聲寶 直立變頻洗衣機',     '17kg',              15900),
    p('RXV50UVLT',    '103', 'DAIKIN',    '大金 變頻分離式冷氣',     '7–9 坪',            47900, '含標準安裝'),
    p('RAC-50QP',     '103', 'HITACHI',   '日立 變頻冷暖分離式',     '7–9 坪',            45900),
    p('CU-K50FCA2',   '103', 'Panasonic', '國際牌 變頻冷專分離式',   '7–9 坪',            40900),
    p('KM-65X80L',    '201', 'SONY',      'SONY 4K 智慧電視',        '65 吋',             36900),
    p('QA55Q70C',     '201', 'SAMSUNG',   '三星 QLED 4K 電視',       '55 吋',             27900),
    p('65UR8050PSB',  '201', 'LG',        'LG 4K AI 語音電視',       '65 吋',             25900),
    p('UX3405MA',     '202', 'ASUS',      'ASUS Zenbook 14',         'Ultra 7／16G／1TB', 42900),
    p('SFG14-73',     '202', 'Acer',      'Acer Swift Go 14',        'Ultra 5／16G／512G', 33900),
    p('MODERN15H',    '202', 'MSI',       'MSI Modern 15',           'i7／16G／512G',     26900),
    p('IP16-128-BK',  '203', 'Apple',     'iPhone 16',               '128GB 黑',          29900),
    p('SM-S9210',     '203', 'SAMSUNG',   'Galaxy S24',              '256GB',             27900),
    p('PX9-128-GR',   '203', 'Google',    'Pixel 9',                 '128GB',             26990),
    p('MIBOX-S2',     '111', 'Xiaomi',    '小米盒子 S 第二代',       '4K',                1990),
    p('APPLETV-4K',   '111', 'Apple',     'Apple TV 4K',             '64GB',              4990),
    // 贈品用的配件
    p('GF-FAN-12',    '900', 'SAMPO',     '聲寶 12 吋桌扇',          '',                  990),
    p('GF-KETTLE',    '900', 'Panasonic', '國際牌 電熱水壺',         '1.5L',              1290),
    p('GF-BUDS',      '900', 'SAMSUNG',   'Galaxy Buds FE',          '',                  2990),
    p('GF-MOUSE',     '900', 'Logitech',  '羅技 無線滑鼠',           '',                  590),
  ];

  /* 雲端上「所有可用的商品圖」的檔名。一個檔名可以寫好幾個編號，用半形空格隔開。
     故意留幾個沒圖的（SR-C61DV、65UR8050PSB、MODERN15H），製作時會顯示缺圖。 */
  const imageFiles = [
    'R-HW620RV.png', 'R-HW620RV_open.png', 'NR-F607HX.png', 'GR-QBFL87BS.jpg',
    'NA-V190NMS.png', 'WD-S19VBS.png', 'ES-N17DPS.png',
    'RXV50UVLT RAC-50QP.png', 'CU-K50FCA2.png',
    'KM-65X80L.png', 'QA55Q70C.png', 'UX3405MA.png', 'SFG14-73.png',
    'IP16-128-BK.png', 'SM-S9210.png', 'PX9-128-GR.png', 'MIBOX-S2.png', 'APPLETV-4K.png',
    'GF-FAN-12.png', 'GF-KETTLE.png', 'GF-BUDS.png', 'GF-MOUSE.png',
  ];

  /* 最終審核者設定表（實作指南 2.3），行銷維護。 */
  const reviewerSettings = {
    exec_id:        'E10001',   // 商品處協理（預設帶分類表的 executive_id）
    mkt_exec_id:    'E30001',   // 行銷處協理
    lawyer_id:      'E40003',   // 律師
    design_lead_id: 'E20002',   // 設計主管：設計相關延遲通知的 CC 對象
  };

  /* 十個排程階段的天數照報告那一檔（9/16 提明細 … 10/08 出稿）。
     截止＝最後一天 18:00（沿用主程式）。 */
  const STAGE_DAYS = [2, 4, 2, 2, 2, 2, 4, 1, 1, 1];
  const STAGES = ['提明細', '製作', '一校', '一改', '二校', '二改', '蓋章確認', '蓋章修改', '審稿', '出稿'];
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function schedule(firstDay) {
    const out = [];
    let d = new Date(firstDay);
    STAGES.forEach((stage, i) => {
      const start = new Date(d);
      const end = new Date(+d + (STAGE_DAYS[i] - 1) * DAY);
      out.push({ stage, start: ymd(start), end: ymd(end) });
      d = new Date(+end + DAY);
    });
    return out;
  }

  /* 版位與格子：一個品類幾格。格子的 id 是穩定的（c1、c2…），便利貼、紀錄都指著它。 */
  const LAYOUT = [
    { id: 'b1', name: '家電', groups: [['101', 4], ['102', 3], ['103', 3]] },
    { id: 'b2', name: '3C',  groups: [['201', 3], ['202', 3], ['203', 3], ['111', 2]] },
  ];
  function cellsFor(plan_id) {
    const blocks = [], cells = [];
    let n = 0;
    LAYOUT.forEach((b, bi) => {
      blocks.push({ id: b.id, plan_id, name: b.name, order: bi + 1, phase: null, pm_done: {}, masthead_ok: false });
      for (const [category_id, count] of b.groups) {
        for (let i = 1; i <= count; i++) {
          cells.push({
            id: 'c' + (++n), plan_id, block_id: b.id, category_id, idx: i,
            stage: '提明細',     // 提明細 → 製作 → 一校；之後跟著版位走（一改、二校…）
            detail: null,        // { sku, name, spec, price, info, brand }
            note_text: '',       // 說明欄：這一期要補的文字
            gifts: [],           // [{ sku, name }]
            reviewed: false,     // 一校：這一格按了「審核完成」
            fix: false,          // 一校送出時有便利貼 → 進一改
            submitted: null,     // { by, as, at }：提明細完成
            made: null,          // { by, at }：製作完成
          });
        }
      }
    });
    return { blocks, cells };
  }

  function build(now) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const end = new Date(+today + 3 * DAY); end.setHours(18, 0, 0, 0);
    const delegations = [{
      id: 'dl1',
      from_id: 'E10245',          // 原 PM（請假的人）
      to_id: 'E10118',            // 職代
      assigned_by: null,          // 差勤同步帶進來的沒有指定人
      start: today.toISOString(),
      end: end.toISOString(),
      stages: 'all',              // 所有 PM 階段
      source: 'sync',             // sync＝07:00 差勤同步／manual＝系統內指定
    }];

    const p1 = cellsFor('p1');
    const plans = [
      { id: 'p1', name: '10 月家電 3C 對開 DM', type: '全省對開大DM', created_by: 'E30007', schedule: schedule(today) },
      // 第二檔還在行銷手上切版：沒有版位、沒有格子，只有排程
      { id: 'p2', name: '雙 11 全省對開 DM', type: '全省對開大DM', created_by: 'E30012', schedule: schedule(new Date(+today + 14 * DAY)) },
    ];

    return {
      members: members.map(m => ({ ...m })),
      assignments: assignments.map(a => ({ ...a })),
      products: products.map(x => ({ ...x })),
      imageFiles: imageFiles.slice(),
      reviewerSettings: { ...reviewerSettings },
      delegations,
      plans,
      blocks: p1.blocks,
      cells: p1.cells,
      notes: [],
      traces: {},                 // sku → { draft, official }：SKU 設計軌跡（實作指南 8.4）
      announcements: [
        { id: 'n1', date: ymd(new Date(+today + 3 * DAY)), text: '晚上 22:00–23:00 系統維護，這段時間存不了檔。' },
        { id: 'n2', date: ymd(new Date(+today - 2 * DAY)), text: '從這一檔開始改用公司的 Google 帳號登入，舊的「選名字」入口已經拿掉。' },
      ],
      support: { who: '資訊部 系統組', ext: '分機 2231', email: 'it-help@example.com' },
    };
  }

  const api = { build, STAGES, STAGE_DAYS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReviewSeed = api;
})(typeof window !== 'undefined' ? window : globalThis);
