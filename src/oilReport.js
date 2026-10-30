// ============================================================
// 3 号 · 原油秒级专页  —  B13
// ------------------------------------------------------------
// 新增两个路由（都受 ACCESS_KEY 保护）：
//   /api/oil-tick   现抓新浪/腾讯，秒级返回，【不写 KV】
//   /oil-report     页面：实时卡（3 秒跳）+ 走势曲线 + 历史日线报表
//
// ★ 为什么秒级抓取不写 KV：
//     Workers KV 免费版 1,000 次写入/天。3 秒一拍 = 28,800 次/天，
//    超出配额近 29 倍 —— 写进去当天下午就会静默失败。
//    所以本页的做法是「浏览器每 3 秒问一次，后端现抓现返」：
//       · 新鲜度：秒级（与真·秒级抓取体验一致）
//       · KV 写入：0
//       · 外部请求：每 3 秒 4 条（新浪/腾讯，均无 key 无限流）
//
// ★ 秒级抓取同时解决「开市 / 休市」判定：
//    新浪/腾讯返回带行情时间戳，算出价龄：
//      价龄 ≤ 20 分钟  → 实时
//      价龄 > 20 分钟  → 休市（无人成交）
//    比「看日历判断周末」准得多 —— 美东周五下午北京已是周六凌晨，
//    按日历会误判成休市，实际正在交易。
// ============================================================

import { SEED_BRENT, SEED_WTI } from './seed.js';

/* 布伦特 / WTI 合理价格区间（美元/桶）—— 防止字段错位取到日期段 */
const HF_RANGE = [10, 400];

/* 价龄超过这个秒数视为休市：20 分钟无新成交 */
const CLOSED_AGE_SEC = 1200;

// ------------------------------------------------------------
// 抓取工具
// ------------------------------------------------------------
async function getText(url, timeoutMs, headers) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*',
      }, headers || {}),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* 新浪：var hq_str_hf_OIL="..."   腾讯：v_hf_OIL="..." */
export function parseHfMap(text) {
  const out = {};
  const re = /(?:var\s+hq_str_|v_)([A-Za-z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) out[m[1]] = m[2];
  return out;
}

/* 取一条 hf_ 记录的【价 + 自带时间戳】
 * 第 0 段当前价 / 第 6 段 HH:MM:SS / 第 12 段 YYYY-MM-DD（北京时间） */
function hfPick(map, sym) {
  const raw = map && map[sym];
  if (!raw) return null;
  const p = String(raw).split(',');
  const v = Number(p[0]);
  if (!Number.isFinite(v) || v < HF_RANGE[0] || v > HF_RANGE[1]) return null;
  const t = String(p[6] || '').trim();
  const d = String(p[12] || '').trim();
  let ts = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && /^\d{1,2}:\d{2}:\d{2}$/.test(t)) {
    const ms = Date.parse(d + 'T' + t + '+08:00');
    if (Number.isFinite(ms)) ts = ms;
  }
  return { v: v, ts: ts };
}

function pack(map, note) {
  const b = hfPick(map, 'hf_OIL');
  const w = hfPick(map, 'hf_CL');
  if (!b && !w) throw new Error(note + ' 两个符号都没价');
  return {
    brent: b ? b.v : 0,
    wti: w ? w.v : 0,
    asOfMs: Math.max(b ? b.ts : 0, w ? w.ts : 0),
    note: note,
  };
}

/* 四条源，按实测速度排序（与 2 号 oilLive.js 完全一致）：
 *   新浪 https 6~47ms → 新浪 http 13ms → 腾讯 qt 25ms → 腾讯 sqt 440ms */
async function srcSinaHf() {
  const txt = await getText('https://hq.sinajs.cn/list=hf_OIL,hf_CL', 2500, {
    Referer: 'https://finance.sina.com.cn',
  });
  return pack(parseHfMap(txt), 'sinahf');
}
async function srcSinaHfHttp() {
  const txt = await getText('http://hq.sinajs.cn/list=hf_OIL,hf_CL', 2500, {
    Referer: 'https://finance.sina.com.cn',
  });
  return pack(parseHfMap(txt), 'sinahfhttp');
}
async function srcTencentHf() {
  const txt = await getText('https://qt.gtimg.cn/q=hf_OIL,hf_CL', 2500);
  return pack(parseHfMap(txt), 'txhf');
}
async function srcTencentSqt() {
  const txt = await getText('https://sqt.gtimg.cn/q=hf_OIL,hf_CL', 3000);
  return pack(parseHfMap(txt), 'txsqt');
}

/**
 * 秒级取价：四条并发，按速度优先级合流。
 * 并发不累加耗时（总耗时 = 最慢那条 sqt 约 440ms），
 * 所以「每次都问四条」比「先问粘滞源」更稳，且总能拿到最快那家的价。
 */
export async function fetchTick() {
  const jobs = [
    ['sinahf', srcSinaHf()],
    ['sinahfhttp', srcSinaHfHttp()],
    ['txhf', srcTencentHf()],
    ['txsqt', srcTencentSqt()],
  ];
  const settled = await Promise.all(
    jobs.map(j => j[1].then(r => ({ ok: true, r: r, name: j[0] }),
                            e => ({ ok: false, e: e, name: j[0] })))
  );

  let brent = 0, wti = 0, asOfMs = 0, provider = '';
  const failed = [];
  for (const s of settled) {
    if (!s.ok) { failed.push(s.name); continue; }
    if (!brent && s.r.brent) brent = s.r.brent;
    if (!wti && s.r.wti) wti = s.r.wti;
    if (!asOfMs && s.r.asOfMs) { asOfMs = s.r.asOfMs; provider = s.name; }
  }
  if (!brent && !wti) {
    return { ok: false, error: '四条源全失败', failed: failed };
  }
  if (!asOfMs) asOfMs = Date.now();

  const ageSec = Math.max(0, Math.round((Date.now() - asOfMs) / 1000));
  return {
    ok: true,
    brent: brent,
    wti: wti,
    asOf: new Date(asOfMs).toISOString(),
    ageSec: ageSec,
    provider: provider,
    /* 休市判定：价龄过大 = 无人成交，比看日历准 */
    market: ageSec > CLOSED_AGE_SEC ? 'closed' : 'open',
    failed: failed,
    ts: Date.now(),
  };
}

// ------------------------------------------------------------
// 历史行：KV 优先，KV 为空时回落到内置种子（让页面部署后立刻有内容）
// ------------------------------------------------------------
function seedToRows(seed) {
  return seed.map(function (r) {
    return { day: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], src: 'import' };
  });
}

async function loadRows(env, kvKey, seed) {
  let hist = null;
  try { hist = await env.OIL_KV.get(kvKey, 'json'); } catch (_) {}
  const rows = (hist && hist.rows) ? hist.rows : [];
  if (rows.length) return { rows: rows, fromSeed: false };
  return { rows: seedToRows(seed), fromSeed: true };
}

// ------------------------------------------------------------
// 页面
// ------------------------------------------------------------
const UP = '#22c55e';     /* 涨 */
const DOWN = '#ef4444';   /* 跌 */

const RANGES = [
  { k: '1M', n: 22,  label: '1个月' },
  { k: '3M', n: 65,  label: '3个月' },
  { k: '6M', n: 130, label: '6个月' },
  { k: '1Y', n: 260, label: '1年' },
  { k: 'ALL', n: 0,  label: '全部' },
];

/**
 * 渲染原油专页
 * @param {string} code  'brent' | 'wti'
 * @param {string} keyQS '?key=xxx' 或 ''
 */
export async function renderOilReportPage(env, code, keyQS) {
  const isWti = code === 'wti';
  const [bRes, wRes] = await Promise.all([
    loadRows(env, 'brent_history', SEED_BRENT),
    loadRows(env, 'wti_history', SEED_WTI),
  ]);

  const brentRows = bRes.rows;
  const wtiRows = wRes.rows;
  const fromSeed = bRes.fromSeed || wRes.fromSeed;

  /* 内联给前端的紧凑数据：只取曲线和表格需要的字段 */
  const packRows = function (rows) {
    return rows.map(function (r) {
      return [r.day, r.open, r.high, r.low, r.close, r.volume || 0];
    });
  };
  const dataBrent = JSON.stringify(packRows(brentRows));
  const dataWti = JSON.stringify(packRows(wtiRows));

  /* 服务端先抓一次，首屏就有实时价（不用等第一次 3 秒轮询） */
  let tick = null;
  try { tick = await fetchTick(); } catch (_) {}

  const initBrent = tick && tick.ok ? tick.brent : (brentRows.length ? brentRows[brentRows.length - 1].close : 0);
  const initWti = tick && tick.ok ? tick.wti : (wtiRows.length ? wtiRows[wtiRows.length - 1].close : 0);
  const initAge = tick && tick.ok ? tick.ageSec : null;
  const initMarket = tick && tick.ok ? tick.market : 'unknown';

  const keyParam = keyQS ? keyQS.replace(/^\?/, '&') : '';

  const h = [];
  h.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
  h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  h.push('<meta name="robots" content="noindex,nofollow">');
  h.push('<title>原油行情 · 秒级 · WTI / 布伦特</title>');
  h.push('<style>');
  h.push('*{box-sizing:border-box}');
  h.push('body{margin:0;background:#0b1220;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:16px;line-height:1.5}');
  h.push('.wrap{max-width:1100px;margin:0 auto}');
  h.push('h1{font-size:20px;margin:0 0 4px}');
  h.push('.sub{font-size:12px;color:#64748b;margin-bottom:16px}');
  h.push('.seg{display:inline-flex;background:#111c31;border:1px solid #1e293b;border-radius:10px;overflow:hidden;margin-bottom:14px}');
  h.push('.seg button{background:none;border:0;color:#94a3b8;padding:8px 16px;font-size:14px;cursor:pointer;font-family:inherit}');
  h.push('.seg button.on{background:#2563eb;color:#fff}');
  h.push('.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:18px}');
  h.push('.card{background:#111c31;border:1px solid #1e293b;border-radius:14px;padding:16px}');
  h.push('.card .ttl{font-size:13px;color:#94a3b8;display:flex;justify-content:space-between;align-items:center}');
  h.push('.card .px{font-size:34px;font-weight:700;margin:6px 0;letter-spacing:-0.5px}');
  h.push('.card .ohlc{display:flex;gap:16px;font-size:12px;color:#94a3b8;flex-wrap:wrap}');
  h.push('.card .ohlc b{color:#e2e8f0;font-weight:600}');
  h.push('.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}');
  h.push('.dot.open{background:#22c55e}.dot.closed{background:#f59e0b}.dot.err{background:#ef4444}');
  h.push('.box{background:#111c31;border:1px solid #1e293b;border-radius:14px;padding:16px;margin-bottom:18px}');
  h.push('.box h2{font-size:15px;margin:0 0 12px}');
  h.push('.ranges{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}');
  h.push('.ranges button{background:#0f172a;border:1px solid #1e293b;color:#94a3b8;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit}');
  h.push('.ranges button.on{background:#1d4ed8;border-color:#1d4ed8;color:#fff}');
  h.push('svg{width:100%;height:auto;display:block}');
  h.push('table{width:100%;border-collapse:collapse;font-size:13px}');
  h.push('th{text-align:right;padding:8px 6px;color:#64748b;font-weight:500;border-bottom:1px solid #1e293b;font-size:12px}');
  h.push('th:first-child{text-align:left}');
  h.push('td{padding:7px 6px;text-align:right;border-bottom:1px solid #16213a;font-variant-numeric:tabular-nums}');
  h.push('td:first-child{text-align:left;color:#94a3b8}');
  h.push('.up{color:' + UP + '}.down{color:' + DOWN + '}');
  h.push('.more{display:block;width:100%;background:#0f172a;border:1px solid #1e293b;color:#94a3b8;border-radius:8px;padding:9px;font-size:13px;cursor:pointer;margin-top:10px;font-family:inherit}');
  h.push('.note{font-size:11px;color:#64748b;margin-top:10px;line-height:1.7}');
  h.push('.warn{background:#422006;border:1px solid #78350f;color:#fcd34d;border-radius:10px;padding:10px 12px;font-size:12px;margin-bottom:14px}');
  h.push('a{color:#60a5fa}');
  h.push('</style></head><body><div class="wrap">');

  h.push('<h1>🛢 原油行情 · 秒级</h1>');
  h.push('<div class="sub">布伦特 / WTI 实时报价 · 每 3 秒刷新 · 源：新浪 / 腾讯外盘</div>');

  if (fromSeed) {
    h.push('<div class="warn">⚠ 当前展示的是<b>内置种子数据</b>（尚未写入 KV）。'
      + '执行 <code>/seed-history?code=brent&amp;confirm=1' + keyParam + '</code> 与 '
      + '<code>/seed-history?code=wti&amp;confirm=1' + keyParam + '</code> 后即转为 KV 数据。</div>');
  }

  h.push('<div class="seg" id="seg">'
    + '<button data-c="brent" class="' + (isWti ? '' : 'on') + '">布伦特原油</button>'
    + '<button data-c="wti" class="' + (isWti ? 'on' : '') + '">WTI 原油</button></div>');

  /* ---- 两张实时卡 ---- */
  h.push('<div class="cards">');
  h.push(cardHtml('brent', '布伦特原油', initBrent, brentRows, initMarket, initAge));
  h.push(cardHtml('wti', 'WTI 原油', initWti, wtiRows, initMarket, initAge));
  h.push('</div>');

  /* ---- 走势曲线 ---- */
  h.push('<div class="box"><h2>📈 走势曲线</h2>');
  h.push('<div class="ranges" id="ranges">');
  RANGES.forEach(function (r, i) {
    h.push('<button data-n="' + r.n + '" class="' + (i === 2 ? 'on' : '') + '">' + r.k + '</button>');
  });
  h.push('</div>');
  h.push('<svg id="chart" viewBox="0 0 900 260" preserveAspectRatio="none"></svg>');
  h.push('<div class="note" id="chartRange"></div>');
  h.push('</div>');

  /* ---- 历史报表 ---- */
  h.push('<div class="box"><h2>📋 历史日线报表</h2>');
  h.push('<div style="overflow-x:auto"><table id="tbl"><thead><tr>'
    + '<th>日期</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>涨跌幅</th><th>交易量</th>'
    + '</tr></thead><tbody></tbody></table></div>');
  h.push('<button class="more" id="more">显示全部 ▼</button>');
  h.push('<div class="note">口径：Investing.com 导出的日线（收盘后由 Yahoo 官方日线定格）。'
    + '涨跌幅按「收盘对收盘」计算。表中最后一行为<b>当日</b>，盘中未收盘时高/低/收会随实时价变动。</div>');
  h.push('</div>');

  h.push('<p style="font-size:12px"><a href="/' + keyQS + '">← 返回首页</a> · '
    + '<a href="/history' + keyQS + '">旧版报表</a> · '
    + '<a href="/api/oil-tick' + keyQS + '">tick JSON</a></p>');

  /* ---- 内联脚本（用普通字符串拼接，避免与外层模板冲突）---- */
  h.push('<script>');
  h.push('var DATA={brent:' + dataBrent + ',wti:' + dataWti + '};');
  h.push('var CODE=' + JSON.stringify(isWti ? 'wti' : 'brent') + ';');
  h.push('var KEY=' + JSON.stringify(keyQS ? keyQS.replace(/^\?/, '') : '') + ';');
  h.push('var RANGE=130;');
  h.push('var LIVE={brent:' + (initBrent || 0) + ',wti:' + (initWti || 0) + '};');
  h.push('var SHOW=60,ALL=false;');
  h.push(inlineScript());
  h.push('</script>');

  h.push('</div></body></html>');
  return h.join('');
}

/* 一张实时卡的 HTML */
function cardHtml(code, title, price, rows, market, age) {
  const last = rows.length ? rows[rows.length - 1] : null;
  const o = last ? last.open : null;
  const hi = last ? last.high : null;
  const lo = last ? last.low : null;
  const prev = rows.length > 1 ? rows[rows.length - 2].close : null;
  const cur = price || (last ? last.close : 0);
  let diff = null;
  if (prev != null && cur) diff = +(((cur - prev) / prev) * 100).toFixed(2);
  const cls = diff == null ? '' : (diff >= 0 ? 'up' : 'down');
  const sign = diff == null ? '—' : (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%';
  const mktText = market === 'closed' ? '休市' : (market === 'open' ? '实时' : '—');
  const mktCls = market === 'closed' ? 'closed' : (market === 'open' ? 'open' : 'err');
  const ageText = age == null ? '' : ' · ' + (age < 60 ? age + '秒前' : Math.round(age / 60) + '分钟前');

  return '<div class="card" id="card-' + code + '">'
    + '<div class="ttl"><span>' + title + '</span>'
    + '<span><i class="dot ' + mktCls + '" id="dot-' + code + '"></i>'
    + '<span id="mkt-' + code + '">' + mktText + '</span>'
    + '<span id="age-' + code + '" style="color:#64748b">' + ageText + '</span></span></div>'
    + '<div class="px" id="px-' + code + '">$' + (cur ? cur.toFixed(2) : '—') + '</div>'
    + '<div class="ohlc">'
    + '<span>开 <b id="o-' + code + '">' + (o != null ? o.toFixed(2) : '—') + '</b></span>'
    + '<span>高 <b id="h-' + code + '">' + (hi != null ? hi.toFixed(2) : '—') + '</b></span>'
    + '<span>低 <b id="l-' + code + '">' + (lo != null ? lo.toFixed(2) : '—') + '</b></span>'
    + '<span class="' + cls + '" id="d-' + code + '">' + sign + '</span>'
    + '</div></div>';
}

/* 内联 JS：3 秒轮询 + 曲线绘制 + 品种/区间切换 + 表格渲染 */
function inlineScript() {
  return [
    'function fmtVol(v){',
    '  if(!v)return "—";',
    '  if(v>=1e6)return (v/1e6).toFixed(2)+"M";',
    '  if(v>=1e3)return (v/1e3).toFixed(1)+"K";',
    '  return String(v);',
    '}',
    'function rowsOf(c){return DATA[c]||[]}',
    'function lastRow(c){var r=rowsOf(c);return r.length?r[r.length-1]:null}',
    /* 实时价叠加到最后一行：高/低取 max/min，收=最新价 */
    'function effRow(c){',
    '  var r=lastRow(c);if(!r)return null;',
    '  var p=LIVE[c];if(!p)return {day:r[0],open:r[1],high:r[2],low:r[3],close:r[4],volume:r[5]};',
    '  return {day:r[0],open:r[1],high:Math.max(r[2],p),low:Math.min(r[3],p),close:p,volume:r[5]};',
    '}',
    /* ---- 曲线 ---- */
    'function drawChart(){',
    '  var rows=rowsOf(CODE).slice();',
    '  if(RANGE>0)rows=rows.slice(-RANGE);',
    '  if(!rows.length){document.getElementById("chart").innerHTML="";return}',
    '  var W=900,H=260,PAD=14;',
    '  var vals=rows.map(function(r){return r[4]});',
    '  var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals);',
    '  var sp=(mx-mn)||1;',
    '  var pts=rows.map(function(r,i){',
    '    var x=PAD+(W-PAD*2)*(rows.length===1?0.5:i/(rows.length-1));',
    '    var y=H-PAD-(H-PAD*2)*((r[4]-mn)/sp);',
    '    return [x,y];',
    '  });',
    '  var up=vals[vals.length-1]>=vals[0];',
    '  var col=up?"' + UP + '":"' + DOWN + '";',
    '  var line=pts.map(function(p,i){return (i?"L":"M")+p[0].toFixed(1)+","+p[1].toFixed(1)}).join(" ");',
    '  var area=line+" L"+pts[pts.length-1][0].toFixed(1)+","+(H-PAD)+" L"+pts[0][0].toFixed(1)+","+(H-PAD)+" Z";',
    '  var g="<defs><linearGradient id=\\"g1\\" x1=\\"0\\" y1=\\"0\\" x2=\\"0\\" y2=\\"1\\">"',
    '       +"<stop offset=\\"0%\\" stop-color=\\""+col+"\\" stop-opacity=\\"0.28\\"/>"',
    '       +"<stop offset=\\"100%\\" stop-color=\\""+col+"\\" stop-opacity=\\"0\\"/></linearGradient></defs>";',
    '  g+="<path d=\\""+area+"\\" fill=\\"url(#g1)\\"/>";',
    '  g+="<path d=\\""+line+"\\" fill=\\"none\\" stroke=\\""+col+"\\" stroke-width=\\"2\\"/>";',
    '  g+="<circle cx=\\""+pts[pts.length-1][0].toFixed(1)+"\\" cy=\\""+pts[pts.length-1][1].toFixed(1)+"\\" r=\\"3.5\\" fill=\\""+col+"\\"/>";',
    '  document.getElementById("chart").innerHTML=g;',
    '  document.getElementById("chartRange").textContent=rows[0][0]+"  →  "+rows[rows.length-1][0]',
    '    +"   ｜  区间 "+rows.length+" 个交易日，高 "+mx.toFixed(2)+" / 低 "+mn.toFixed(2);',
    '}',
    /* ---- 表格 ---- */
    'function drawTable(){',
    '  var rows=rowsOf(CODE).slice().reverse();',
    '  var total=rows.length;',
    '  var show=ALL?rows:rows.slice(0,SHOW);',
    '  var h="";',
    '  for(var i=0;i<show.length;i++){',
    '    var r=show[i];',
    '    var idx=total-1-i;',
    '    var prev=idx>0?rows[i+1]:null;',
    '    var isLast=(i===0);',
    '    var close=isLast&&LIVE[CODE]?LIVE[CODE]:r[4];',
    '    var hi=isLast&&LIVE[CODE]?Math.max(r[2],LIVE[CODE]):r[2];',
    '    var lo=isLast&&LIVE[CODE]?Math.min(r[3],LIVE[CODE]):r[3];',
    '    var d=null;',
    '    if(prev&&prev[4])d=+(((close-prev[4])/prev[4])*100).toFixed(2);',
    '    var cls=d==null?"":(d>=0?"up":"down");',
    '    var sign=d==null?"—":((d>=0?"+":"")+d.toFixed(2)+"%");',
    '    h+="<tr><td>"+r[0]+(isLast?" <span style=\\"color:#f59e0b;font-size:11px\\">当日</span>":"")+"</td>"',
    '      +"<td>"+r[1].toFixed(2)+"</td><td>"+hi.toFixed(2)+"</td><td>"+lo.toFixed(2)+"</td>"',
    '      +"<td><b>"+close.toFixed(2)+"</b></td><td class=\\""+cls+"\\">"+sign+"</td>"',
    '      +"<td style=\\"color:#64748b\\">"+fmtVol(r[5])+"</td></tr>";',
    '  }',
    '  document.querySelector("#tbl tbody").innerHTML=h;',
    '  var btn=document.getElementById("more");',
    '  btn.style.display=total>SHOW?"block":"none";',
    '  btn.textContent=ALL?"收起 ▲":"显示全部（共 "+total+" 个交易日）▼";',
    '}',
    /* ---- 卡片 ---- */
    'function drawCard(c){',
    '  var r=effRow(c);if(!r)return;',
    '  var p=LIVE[c]||r.close;',
    '  document.getElementById("px-"+c).textContent="$"+p.toFixed(2);',
    '  document.getElementById("o-"+c).textContent=(r.open!=null?r.open.toFixed(2):"—");',
    '  document.getElementById("h-"+c).textContent=(r.high!=null?r.high.toFixed(2):"—");',
    '  document.getElementById("l-"+c).textContent=(r.low!=null?r.low.toFixed(2):"—");',
    '  var rows=rowsOf(c);',
    '  var prev=rows.length>1?rows[rows.length-2][4]:null;',
    '  var d=prev?+(((p-prev)/prev)*100).toFixed(2):null;',
    '  var el=document.getElementById("d-"+c);',
    '  el.className=d==null?"":(d>=0?"up":"down");',
    '  el.textContent=d==null?"—":((d>=0?"+":"")+d.toFixed(2)+"%");',
    '}',
    /* ---- 轮询 ---- */
    'var timer=null,hidden=false;',
    'function tick(){',
    '  var u="/api/oil-tick"+(KEY?"?"+KEY:"");',
    '  return fetch(u,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){',
    '    if(!j||!j.ok)return;',
    '    if(j.brent)LIVE.brent=j.brent;',
    '    if(j.wti)LIVE.wti=j.wti;',
    '    var age=j.ageSec;',
    '    var ageTxt=" · "+(age<60?age+"秒前":Math.round(age/60)+"分钟前");',
    '    var closed=j.market==="closed";',
    '    ["brent","wti"].forEach(function(c){',
    '      document.getElementById("age-"+c).textContent=ageTxt;',
    '      document.getElementById("mkt-"+c).textContent=closed?"休市":"实时";',
    '      var dot=document.getElementById("dot-"+c);',
    '      dot.className="dot "+(closed?"closed":"open");',
    '      drawCard(c);',
    '    });',
    '    drawChart();drawTable();',
    '  }).catch(function(){});',
    '}',
    'function start(){if(timer)return;timer=setInterval(function(){if(!hidden)tick()},3000);tick()}',
    'function stop(){if(timer){clearInterval(timer);timer=null}}',
    'document.addEventListener("visibilitychange",function(){',
    '  hidden=document.hidden;',
    '  if(hidden){stop()}else{start()}',
    '});',
    /* ---- 事件 ---- */
    'document.getElementById("seg").addEventListener("click",function(e){',
    '  var b=e.target.closest("button");if(!b)return;',
    '  CODE=b.getAttribute("data-c");',
    '  var bs=this.querySelectorAll("button");',
    '  for(var i=0;i<bs.length;i++)bs[i].className=(bs[i]===b?"on":"");',
    '  ALL=false;drawChart();drawTable();',
    '});',
    'document.getElementById("ranges").addEventListener("click",function(e){',
    '  var b=e.target.closest("button");if(!b)return;',
    '  RANGE=parseInt(b.getAttribute("data-n"),10)||0;',
    '  var bs=this.querySelectorAll("button");',
    '  for(var i=0;i<bs.length;i++)bs[i].className=(bs[i]===b?"on":"");',
    '  drawChart();',
    '});',
    'document.getElementById("more").addEventListener("click",function(){',
    '  ALL=!ALL;drawTable();',
    '});',
    'drawChart();drawTable();start();',
  ].join('\n');
}
