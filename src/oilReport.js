// ============================================================
// 3 号 · 原油秒级专页  —  B14（重写图表）
// ------------------------------------------------------------
// 路由（受 ACCESS_KEY 保护）：
//   /api/oil-tick   现抓新浪/腾讯，秒级返回，【不写 KV】
//   /oil-report     页面：实时卡（3 秒跳）+ 专业走势图 + 历史日线报表
//
// ★ B14 相对 B13 的变化：
//   1) 走势图重写成 TradingView 风格：
//        · 十字准线（竖线定位日期 / 横线定位价格）
//        · 左侧价格刻度 + 底部日期刻度 + 网格
//        · 顶部 O/H/L/C 图例，随鼠标所在 K 线实时切换
//        · 滚轮缩放（最近可放到约 1 周，最远可拉到全量 21 个月）
//        · 拖拽平移（往回拉看更早的行情）
//        · 1W/1M/3M/6M/1Y/ALL 区间按钮真正生效
//   2) 报表去掉交易量列（用不上）
//   3) 报表支持按【年份 / 月份】筛选
//   4) 配色沿用国际惯例：涨绿 / 跌红
//
// ★ 秒级为什么不写 KV：
//   Workers KV 免费版 1,000 次写入/天。3 秒一拍 = 28,800 次/天，
//   超出配额近 29 倍 —— 当天下午就会静默失败。
//   本页做法：浏览器每 3 秒问一次，后端现抓现返。
//     新鲜度：秒级   KV 写入：0   外部请求：每 3 秒 4 条（均免 key）
//
// ★ 开市/休市判定用价龄（新浪/腾讯自带行情时间戳），不看日历：
//   美东周五下午北京已是周六凌晨，看日历会误判成休市，实际正在交易。
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
  const seedRows = seedToRows(seed);
  /* ★ 取「条数多」的一方，而不是无脑 KV 优先。
   *   3 号早期自建累积往 brent_history 写的是稀疏采样行（可能只有几十条），
   *   无脑 KV 优先会让这几十条遮蔽内置的 455 条真实日线，
   *   表现为：年份下拉只有最近一个月、曲线只能缩到一两月。
   *   种子导入（/seed-history）之后 KV 条数 ≥ 种子，自然切回 KV。 */
  if (rows.length >= seedRows.length) return { rows: rows, fromSeed: false };
  return { rows: seedRows, fromSeed: true };
}

// ------------------------------------------------------------
// 图表绘制器：一份源码，服务端与浏览器共用
// ------------------------------------------------------------
/* 写成字符串，服务端 new Function 求值做首屏渲染，浏览器原样注入，
 * 保证两边画出来的东西完全一致（不会出现 SSR 与客户端不一致的抖动）。 */
export const CHART_SRC = [
'function niceStep(rg,tg){',
'  var raw=rg/tg; if(!(raw>0))return 1;',
'  var mag=Math.pow(10,Math.floor(Math.log(raw)/Math.LN10));',
'  var nm=raw/mag;',
'  var s=nm<1.5?1:(nm<3?2:(nm<7?5:10));',
'  return s*mag;',
'}',
'function niceStepSpan(a,b){return niceStep(Math.abs(b-a)||1,4)}',
'function buildChart(p){',
'  var rows=p.rows||[];',
'  var W=p.W||900,H=p.H||340;',
'  var PL=58,PR=18,PT=14,PB=30;',
'  var PW=W-PL-PR,PH=H-PT-PB;',
'  if(!rows.length||PW<60||PH<60)return "";',
'  var i0=p.i0|0,i1=p.i1|0;',
'  if(i0<0)i0=0; if(i1>rows.length-1)i1=rows.length-1; if(i1<i0)i1=i0;',
'  var n=i1-i0+1;',
'  var mn=Infinity,mx=-Infinity,i,r;',
'  for(i=i0;i<=i1;i++){r=rows[i];if(r[3]<mn)mn=r[3];if(r[2]>mx)mx=r[2];}',
'  if(!isFinite(mn)||!isFinite(mx)){mn=0;mx=1;}',
'  var sp=(mx-mn)||1;',
'  mn-=sp*0.08;mx+=sp*0.08;sp=mx-mn;',
'  var X=function(k){return n===1?PL+PW/2:PL+PW*((k-i0)/(n-1));};',
'  var Y=function(v){return PT+PH*(1-(v-mn)/sp);};',
'  var Yv=function(y){return mn+sp*(1-(y-PT)/PH);};',
'  var d0=Date.parse(rows[i0][0]+"T00:00:00Z"),d1=Date.parse(rows[i1][0]+"T00:00:00Z");',
'  var spanD=Math.round((d1-d0)/86400000); if(!isFinite(spanD))spanD=400;',
'  var MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];',
'  var mo=function(day){return +day.slice(5,7);};',
'  /* 轴刻度：跨度越短越细，逐级退到月 / 季 / 年（国际惯例：英文月份缩写）*/',
'  var fmtD=function(day){',
'    if(spanD<=14)return day.slice(5);',
'    if(spanD<=120)return MON[mo(day)-1]+" "+(+day.slice(8,10));',
'    if(spanD<=400)return MON[mo(day)-1]+" "+day.slice(2,4);',
'    return day.slice(0,4);',
'  };',
'  /* 完整日期：悬停浮标始终给出 YYYY-MM-DD，不缩写 */',
'  var fmtFull=function(day){return MON[mo(day)-1]+" "+(+day.slice(8,10))+", "+day.slice(0,4);};',
'  var first=rows[i0][4],lastC=rows[i1][4];',
'  var up=lastC>=first;',
'  var col=up?"#22c55e":"#ef4444";',
'  var MF="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";',
'  var s="";',
'  var stp=niceStep(sp,4);',
'  var t0=Math.ceil(mn/stp)*stp;',
'  for(var v=t0;v<=mx+1e-9;v+=stp){',
'    var yy=Y(v);',
'    if(yy<PT-1||yy>PT+PH+1)continue;',
'    s+="<line x1=\\""+PL+"\\" y1=\\""+yy.toFixed(1)+"\\" x2=\\""+(PL+PW)+"\\" y2=\\""+yy.toFixed(1)+"\\" stroke=\\"#1b2740\\" stroke-width=\\"1\\"/>";',
'    s+="<text x=\\""+(PL-9)+"\\" y=\\""+(yy+4).toFixed(1)+"\\" fill=\\"#64748b\\" font-size=\\"11\\" text-anchor=\\"end\\" font-family=\\""+MF+"\\">"+v.toFixed(2)+"</text>";',
'  }',
'  var cnt=Math.max(2,Math.min(8,Math.floor(PW/100)));',
'  for(var t=0;t<cnt;t++){',
'    var idx=i0+Math.round((n-1)*(cnt===1?0:t/(cnt-1)));',
'    var xx=X(idx);',
'    var an=(t===0)?"start":((t===cnt-1)?"end":"middle");',
'    s+="<text x=\\""+xx.toFixed(1)+"\\" y=\\""+(H-9)+"\\" fill=\\"#64748b\\" font-size=\\"11\\" text-anchor=\\""+an+"\\" font-family=\\""+MF+"\\">"+fmtD(rows[idx][0])+"</text>";',
'  }',
'  var d="",k;',
'  for(k=i0;k<=i1;k++){d+=(k===i0?"M":"L")+X(k).toFixed(1)+","+Y(rows[k][4]).toFixed(1)+" ";}',
'  var area=d+"L"+X(i1).toFixed(1)+","+(PT+PH)+" L"+X(i0).toFixed(1)+","+(PT+PH)+" Z";',
'  s+="<defs><linearGradient id=\\"cg\\" x1=\\"0\\" y1=\\"0\\" x2=\\"0\\" y2=\\"1\\">"',
'    +"<stop offset=\\"0%\\" stop-color=\\""+col+"\\" stop-opacity=\\"0.30\\"/>"',
'    +"<stop offset=\\"100%\\" stop-color=\\""+col+"\\" stop-opacity=\\"0\\"/></linearGradient></defs>";',
'  s+="<path d=\\""+area+"\\" fill=\\"url(#cg)\\"/>";',
'  s+="<path d=\\""+d+"\\" fill=\\"none\\" stroke=\\""+col+"\\" stroke-width=\\"2\\" stroke-linejoin=\\"round\\" stroke-linecap=\\"round\\"/>";',
'  var ly=Y(lastC);',
'  s+="<line x1=\\""+PL+"\\" y1=\\""+ly.toFixed(1)+"\\" x2=\\""+(PL+PW)+"\\" y2=\\""+ly.toFixed(1)+"\\" stroke=\\""+col+"\\" stroke-width=\\"1\\" stroke-dasharray=\\"4 4\\" opacity=\\"0.5\\"/>";',
'  s+="<circle cx=\\""+X(i1).toFixed(1)+"\\" cy=\\""+ly.toFixed(1)+"\\" r=\\"3.5\\" fill=\\""+col+"\\"/>";',
'  s+="<g><rect x=\\""+(PL-54)+"\\" y=\\""+(ly-9).toFixed(1)+"\\" width=\\"52\\" height=\\"18\\" rx=\\"3\\" fill=\\""+col+"\\"/>"',
'    +"<text x=\\""+(PL-28)+"\\" y=\\""+(ly+4).toFixed(1)+"\\" fill=\\"#08101f\\" font-size=\\"11\\" font-weight=\\"700\\" text-anchor=\\"middle\\" font-family=\\""+MF+"\\">"+lastC.toFixed(2)+"</text></g>";',
'  var hv=p.hover;',
'  if(hv!=null&&hv>=i0&&hv<=i1){',
'    var hx=X(hv);',
'    s+="<line x1=\\""+hx.toFixed(1)+"\\" y1=\\""+PT+"\\" x2=\\""+hx.toFixed(1)+"\\" y2=\\""+(PT+PH)+"\\" stroke=\\"#94a3b8\\" stroke-width=\\"1\\" stroke-dasharray=\\"3 3\\"/>";',
'    var hy=p.hoverY;',
'    if(hy!=null&&hy>=PT&&hy<=PT+PH){',
'      s+="<line x1=\\""+PL+"\\" y1=\\""+hy.toFixed(1)+"\\" x2=\\""+(PL+PW)+"\\" y2=\\""+hy.toFixed(1)+"\\" stroke=\\"#94a3b8\\" stroke-width=\\"1\\" stroke-dasharray=\\"3 3\\"/>";',
'      s+="<g><rect x=\\""+(PL-54)+"\\" y=\\""+(hy-9).toFixed(1)+"\\" width=\\"52\\" height=\\"18\\" rx=\\"3\\" fill=\\"#475569\\"/>"',
'        +"<text x=\\""+(PL-28)+"\\" y=\\""+(hy+4).toFixed(1)+"\\" fill=\\"#f1f5f9\\" font-size=\\"11\\" font-weight=\\"700\\" text-anchor=\\"middle\\" font-family=\\""+MF+"\\">"+Yv(hy).toFixed(2)+"</text></g>";',
'    }',
'    s+="<circle cx=\\""+hx.toFixed(1)+"\\" cy=\\""+Y(rows[hv][4]).toFixed(1)+"\\" r=\\"4.5\\" fill=\\""+col+"\\" stroke=\\"#0b1220\\" stroke-width=\\"2\\"/>";',
'    var hl=fmtFull(rows[hv][0]);',
'    var tw=hl.length*7+14;',
'    var tx=Math.max(PL,Math.min(PL+PW-tw,hx-tw/2));',
'    s+="<g><rect x=\\""+tx.toFixed(1)+"\\" y=\\""+(H-25)+"\\" width=\\""+tw+"\\" height=\\"18\\" rx=\\"3\\" fill=\\"#475569\\"/>"',
'      +"<text x=\\""+(tx+tw/2).toFixed(1)+"\\" y=\\""+(H-12)+"\\" fill=\\"#f1f5f9\\" font-size=\\"11\\" font-weight=\\"700\\" text-anchor=\\"middle\\" font-family=\\""+MF+"\\">"+hl+"</text></g>";',
'  }',
'  return s;',
'}',
].join('\n');

/* 服务端求值一次，用于首屏渲染（Workers 允许 new Function） */
let _buildChart = null;
function buildChartSSR(p) {
  if (_buildChart === null) {
    try { _buildChart = new Function(CHART_SRC + '\nreturn buildChart;')(); }
    catch (_) { _buildChart = false; }
  }
  if (!_buildChart) return '';
  try { return _buildChart(p); } catch (_) { return ''; }
}

// ------------------------------------------------------------
// 页面
// ------------------------------------------------------------
const UP = '#22c55e';     /* 涨 —— 国际惯例：绿涨红跌 */
const DOWN = '#ef4444';   /* 跌 */

/* n = 可见交易日数量；0 表示全部 */
const RANGES = [
  { k: '1W', n: 5 },
  { k: '1M', n: 22 },
  { k: '3M', n: 65 },
  { k: '6M', n: 130 },
  { k: '1Y', n: 260 },
  { k: 'ALL', n: 0 },
];

const CHART_H = 340;
const CHART_W = 900;   /* 首屏占位宽度，浏览器加载后立即按实际宽度重绘 */

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

  /* 首屏图表：叠加实时价后绘制 */
  const effServer = function (packed, live) {
    if (!packed.length) return packed;
    const out = packed.slice();
    if (live) {
      const last = out[out.length - 1].slice();
      last[2] = Math.max(last[2], live);
      last[3] = Math.min(last[3], live);
      last[4] = live;
      out[out.length - 1] = last;
    }
    return out;
  };
  const pb = packRows(brentRows);
  const pw = packRows(wtiRows);
  const curRows = isWti ? effServer(pw, initWti) : effServer(pb, initBrent);
  const initSpan = Math.min(130, curRows.length) || 1;
  const initSvg = buildChartSSR({
    rows: curRows,
    i0: Math.max(0, curRows.length - initSpan),
    i1: curRows.length - 1,
    W: CHART_W,
    H: CHART_H,
    hover: -1,
    hoverY: -1,
  });

  const h = [];
  h.push('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">');
  h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  h.push('<meta name="robots" content="noindex,nofollow">');
  h.push('<title>Crude Oil · Live · Brent / WTI</title>');
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
  h.push('.ranges{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center}');
  h.push('.ranges button{background:#0f172a;border:1px solid #1e293b;color:#94a3b8;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit}');
  h.push('.ranges button.on{background:#1d4ed8;border-color:#1d4ed8;color:#fff}');
  h.push('.ranges .hint{font-size:11px;color:#475569;margin-left:auto}');
  h.push('.legend{display:flex;gap:14px;align-items:baseline;font-size:12px;color:#94a3b8;flex-wrap:wrap;margin-bottom:8px;min-height:20px}');
  h.push('.legend b{color:#e2e8f0;font-weight:600;font-variant-numeric:tabular-nums}');
  h.push('.legend .lg-name{color:#e2e8f0;font-weight:600}');
  h.push('.legend .lg-date{color:#64748b;font-variant-numeric:tabular-nums}');
  h.push('#chart{width:100%;height:' + CHART_H + 'px;display:block;touch-action:pan-y;cursor:crosshair;user-select:none}');
  h.push('table{width:100%;border-collapse:collapse;font-size:13px}');
  h.push('th{text-align:right;padding:8px 6px;color:#64748b;font-weight:500;border-bottom:1px solid #1e293b;font-size:12px}');
  h.push('th:first-child{text-align:left}');
  h.push('td{padding:7px 6px;text-align:right;border-bottom:1px solid #16213a;font-variant-numeric:tabular-nums}');
  h.push('td:first-child{text-align:left;color:#94a3b8}');
  h.push('tbody tr:hover{background:#0f172a}');
  h.push('.up{color:' + UP + '}.down{color:' + DOWN + '}');
  h.push('.filters{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}');
  h.push('.filters select{background:#0f172a;border:1px solid #1e293b;color:#e2e8f0;border-radius:8px;padding:5px 8px;font-size:12px;font-family:inherit}');
  h.push('.filters .cnt{font-size:11px;color:#64748b;margin-left:auto}');
  h.push('.more{display:block;width:100%;background:#0f172a;border:1px solid #1e293b;color:#94a3b8;border-radius:8px;padding:9px;font-size:13px;cursor:pointer;margin-top:10px;font-family:inherit}');
  h.push('.note{font-size:11px;color:#64748b;margin-top:10px;line-height:1.7}');
  h.push('.warn{background:#422006;border:1px solid #78350f;color:#fcd34d;border-radius:10px;padding:10px 12px;font-size:12px;margin-bottom:14px}');
  h.push('a{color:#60a5fa}');
  h.push('</style></head><body><div class="wrap">');

  h.push('<h1>🛢 Crude Oil · Live</h1>');
  h.push('<div class="sub">Brent / WTI live quotes · refreshed every 3s · sources: Sina / Tencent (offshore)</div>');

  if (fromSeed) {
    h.push('<div class="warn">⚠ Showing <b>built-in seed data</b> (not yet written to KV).'
      + ' Run <code>/seed-history?code=brent&amp;confirm=1' + keyParam + '</code> and '
      + '<code>/seed-history?code=wti&amp;confirm=1' + keyParam + '</code> to switch to KV data.</div>');
  }

  h.push('<div class="seg" id="seg">'
    + '<button data-c="brent" class="' + (isWti ? '' : 'on') + '">Brent Crude</button>'
    + '<button data-c="wti" class="' + (isWti ? 'on' : '') + '">WTI Crude</button></div>');

  /* ---- 两张实时卡 ---- */
  h.push('<div class="cards">');
  h.push(cardHtml('brent', 'Brent Crude', initBrent, brentRows, initMarket, initAge));
  h.push(cardHtml('wti', 'WTI Crude', initWti, wtiRows, initMarket, initAge));
  h.push('</div>');

  /* ---- 走势图 ---- */
  h.push('<div class="box"><h2>📈 Price Chart</h2>');
  h.push('<div class="legend" id="legend">' + legendInner(isWti ? 'WTI Crude' : 'Brent Crude', curRows) + '</div>');
  h.push('<div class="ranges" id="ranges">');
  RANGES.forEach(function (r, i) {
    const on = (r.n === 130) ? 'on' : '';
    h.push('<button data-n="' + r.n + '" class="' + on + '">' + r.k + '</button>');
  });
  h.push('<span class="hint">Scroll to zoom · drag to pan · hover or tap for O/H/L/C · pinch &amp; swipe on touch</span>');
  h.push('</div>');
  h.push('<svg id="chart" viewBox="0 0 ' + CHART_W + ' ' + CHART_H + '">' + initSvg + '</svg>');
  h.push('<div class="note" id="chartRange"></div>');
  h.push('</div>');

  /* ---- 历史报表 ---- */
  h.push('<div class="box"><h2>📋 Historical Daily Data</h2>');
  h.push('<div class="filters">'
    + '<select id="fy"></select><select id="fm"></select>'
    + '<span class="cnt" id="tcount"></span></div>');
  h.push('<div style="overflow-x:auto"><table id="tbl"><thead><tr>'
    + '<th>Date</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Change</th>'
    + '</tr></thead><tbody></tbody></table></div>');
  h.push('<button class="more" id="more">Show all ▼</button>');
  h.push('<div class="note">Daily bars exported from Investing.com, settled after close by Yahoo official daily data. '
    + 'Change is close-to-close. The last row is <b>today</b>; while the session is open its high / low / close track the live price.</div>');
  h.push('</div>');

  h.push('<p style="font-size:12px"><a href="/' + keyQS + '">← Home</a> · '
    + '<a href="/history' + keyQS + '">Legacy report</a> · '
    + '<a href="/api/oil-tick' + keyQS + '">tick JSON</a></p>');

  /* ---- 内联脚本 ---- */
  h.push('<script>');
  h.push('var DATA={brent:' + dataBrent + ',wti:' + dataWti + '};');
  h.push('var CODE=' + JSON.stringify(isWti ? 'wti' : 'brent') + ';');
  h.push('var KEY=' + JSON.stringify(keyQS ? keyQS.replace(/^\?/, '') : '') + ';');
  h.push('var LIVE={brent:' + (initBrent || 0) + ',wti:' + (initWti || 0) + '};');
  h.push('var H=' + CHART_H + ';');
  h.push('var V={i0f:0,span:130,atEnd:true,hover:-1,hoverY:-1};');
  h.push('var ALL=false,SEL_Y="all",SEL_M="all",TLIM=30;');
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
  const mktText = market === 'closed' ? 'Closed' : (market === 'open' ? 'Live' : '—');
  const mktCls = market === 'closed' ? 'closed' : (market === 'open' ? 'open' : 'err');
  const ageText = age == null ? '' : ' · ' + (age < 60 ? age + 's ago' : Math.round(age / 60) + 'm ago');

  return '<div class="card" id="card-' + code + '">'
    + '<div class="ttl"><span>' + title + '</span>'
    + '<span><i class="dot ' + mktCls + '" id="dot-' + code + '"></i>'
    + '<span id="mkt-' + code + '">' + mktText + '</span>'
    + '<span id="age-' + code + '" style="color:#64748b">' + ageText + '</span></span></div>'
    + '<div class="px" id="px-' + code + '">$' + (cur ? cur.toFixed(2) : '—') + '</div>'
    + '<div class="ohlc">'
    + '<span>O <b id="o-' + code + '">' + (o != null ? o.toFixed(2) : '—') + '</b></span>'
    + '<span>H <b id="h-' + code + '">' + (hi != null ? hi.toFixed(2) : '—') + '</b></span>'
    + '<span>L <b id="l-' + code + '">' + (lo != null ? lo.toFixed(2) : '—') + '</b></span>'
    + '<span class="' + cls + '" id="d-' + code + '">' + sign + '</span>'
    + '</div></div>';
}

/* 图例内容：某根 K 线的 O/H/L/C + 涨跌 */
function legendInner(name, rows, idx) {
  const i = (idx == null) ? (rows.length - 1) : idx;
  const r = rows[i];
  if (!r) return '<span class="lg-name">' + name + ' · Daily</span>';
  const prev = i > 0 ? rows[i - 1][4] : null;
  const c = r[4];
  let d = null, abs = null;
  if (prev && c) { abs = +(c - prev).toFixed(2); d = +(((c - prev) / prev) * 100).toFixed(2); }
  const cls = d == null ? '' : (d >= 0 ? 'up' : 'down');
  const sign = d == null ? '—'
    : (abs >= 0 ? '+' : '') + abs.toFixed(2) + ' (' + (d >= 0 ? '+' : '') + d.toFixed(2) + '%)';
  return '<span class="lg-name" id="lg-name">' + name + ' · Daily</span>'
    + '<span class="lg-date" id="lg-date">' + r[0] + '</span>'
    + '<span>O <b id="lg-o">' + r[1].toFixed(2) + '</b></span>'
    + '<span>H <b id="lg-h">' + r[2].toFixed(2) + '</b></span>'
    + '<span>L <b id="lg-l">' + r[3].toFixed(2) + '</b></span>'
    + '<span>C <b id="lg-c">' + c.toFixed(2) + '</b></span>'
    + '<span class="' + cls + '" id="lg-chg">' + sign + '</span>';
}

/* 内联 JS：3 秒轮询 + 专业走势图 + 品种/区间/筛选 + 表格渲染 */
function inlineScript() {
  return [
    /* ---- 共用绘图器（与服务端同一份源码）---- */
    CHART_SRC,
    'var PL=58,PR=18,PT=14,PB=30;',
    'function svgEl(){return document.getElementById("chart")}',
    'function effRows(c){',
    '  var r=DATA[c]||[];if(!r.length)return [];',
    '  var p=LIVE[c];if(!p)return r;',
    '  var out=r.slice();var last=out[out.length-1].slice();',
    '  last[2]=Math.max(last[2],p);last[3]=Math.min(last[3],p);last[4]=p;',
    '  out[out.length-1]=last;return out;',
    '}',
    'function clampView(total){',
    '  if(V.span<5)V.span=5;',
    '  if(V.span>total)V.span=total;',
    '  if(V.atEnd)V.i0f=total-V.span;',
    '  if(V.i0f<0)V.i0f=0;',
    '  var mx=Math.max(0,total-V.span);',
    '  if(V.i0f>mx)V.i0f=mx;',
    '}',
    /* ---- 绘图 ---- */
    'function drawChart(){',
    '  var rows=effRows(CODE),total=rows.length;',
    '  if(!total){svgEl().innerHTML="";return}',
    '  clampView(total);',
    '  var i0=Math.round(V.i0f),i1=i0+V.span-1;',
    '  if(i1>total-1){i1=total-1;i0=Math.max(0,i1-V.span+1);V.i0f=i0}',
    '  var svg=svgEl();',
    '  var W=svg.clientWidth||900;',
    '  svg.setAttribute("viewBox","0 0 "+W+" "+H);',
    '  svg.innerHTML=buildChart({rows:rows,i0:i0,i1:i1,W:W,H:H,hover:V.hover,hoverY:V.hoverY});',
    '  var el=document.getElementById("chartRange");',
    '  if(el)el.textContent="Showing "+rows[i0][0]+" → "+rows[i1][0]+"   |   "+(i1-i0+1)+" trading days"',
    '     +"   |   "+(V.atEnd?"following latest":"panned — click a range button to return to latest");',
    '}',
    /* ---- 图例：跟随鼠标所在 K 线 ---- */
    'function drawLegend(){',
    '  var rows=effRows(CODE);if(!rows.length)return;',
    '  var i=V.hover;',
    '  if(i==null||i<0||i>=rows.length)i=rows.length-1;',
    '  var r=rows[i],prev=i>0?rows[i-1][4]:null;',
    '  var set=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v};',
    '  set("lg-date",r[0]);set("lg-o",r[1].toFixed(2));set("lg-h",r[2].toFixed(2));',
    '  set("lg-l",r[3].toFixed(2));set("lg-c",r[4].toFixed(2));',
    '  var d=null,abs=null;',
    '  if(prev&&r[4]){abs=+(r[4]-prev).toFixed(2);d=+(((r[4]-prev)/prev)*100).toFixed(2)}',
    '  var e=document.getElementById("lg-chg");',
    '  if(e){e.className=d==null?"":(d>=0?"up":"down");',
    '    e.textContent=d==null?"—":((abs>=0?"+":"")+abs.toFixed(2)+" ("+(d>=0?"+":"")+d.toFixed(2)+"%)")}',
    '}',
    /* ---- 缩放 / 平移 ---- */
    'function geom(){var W=svgEl().clientWidth||900;return {W:W,PW:W-PL-PR}}',
    'function zoomAt(frac,factor){',
    '  var rows=effRows(CODE),total=rows.length;if(!total)return;',
    '  var span=V.span,ns=Math.round(span*factor);',
    '  ns=Math.max(5,Math.min(total,ns));',
    '  if(ns===span)return;',
    '  if(frac<0)frac=0;if(frac>1)frac=1;',
    '  var anchor=V.i0f+frac*(span-1);',
    '  var ni0=anchor-frac*(ns-1);',
    '  V.span=ns;V.i0f=ni0;V.atEnd=false;',
    '  clampView(total);',
    '  V.atEnd=(Math.round(V.i0f)+V.span>=total);',
    '  clearRangeBtns();drawChart();drawLegend();',
    '}',
    'function panByPx(dx,noDraw){',
    '  var rows=effRows(CODE),total=rows.length;if(!total)return;',
    '  var g=geom();if(g.PW<=0)return;',
    '  V.atEnd=false;',
    '  V.i0f-=dx/g.PW*(V.span-1);',
    '  clampView(total);',
    '  V.atEnd=(Math.round(V.i0f)+V.span>=total);',
    '  if(!noDraw){drawChart();drawLegend();}',
    '}',
    'function clearRangeBtns(){',
    '  var bs=document.querySelectorAll("#ranges button");',
    '  for(var i=0;i<bs.length;i++)bs[i].className="";',
    '}',
    'function setSpan(n){',
    '  var rows=effRows(CODE),total=rows.length;if(!total)return;',
    '  var ns=(!n||n<=0)?total:Math.min(n,total);',
    '  if(ns<5)ns=Math.min(5,total);',
    '  V.span=ns;V.i0f=total-ns;V.atEnd=true;V.hover=-1;V.hoverY=-1;',
    '  drawChart();drawLegend();',
    '}',
    /* ---- 悬停 ---- */
    'function localPos(e){',
    '  var r=svgEl().getBoundingClientRect();',
    '  return {x:e.clientX-r.left,y:e.clientY-r.top};',
    '}',
    'function hoverAt(p){',
    '  var rows=effRows(CODE),total=rows.length;if(!total)return;',
    '  var g=geom(),PW=g.PW,PH=H-PT-PB;',
    '  if(p.x<PL||p.x>PL+PW||p.y<PT||p.y>PT+PH){',
    '    if(V.hover!==-1){V.hover=-1;V.hoverY=-1;drawChart();drawLegend()}',
    '    return;',
    '  }',
    '  var i0=Math.round(V.i0f);',
    '  var span=Math.min(V.span,total);',
    '  var frac=(p.x-PL)/PW;',
    '  var idx=i0+Math.round(frac*(span-1));',
    '  if(idx<0)idx=0;if(idx>total-1)idx=total-1;',
    '  if(idx!==V.hover||Math.abs(p.y-(V.hoverY||0))>0.5){',
    '    V.hover=idx;V.hoverY=p.y;drawChart();drawLegend();',
    '  }',
    '}',
    /* ---- 表格 ---- */
    'function filteredIdx(){',
    '  var all=DATA[CODE]||[],out=[],i,d;',
    '  for(i=all.length-1;i>=0;i--){',
    '    d=all[i][0];',
    '    if(SEL_Y!=="all"&&d.slice(0,4)!==SEL_Y)continue;',
    '    if(SEL_M!="all"&&d.slice(5,7)!==SEL_M)continue;',
    '    out.push(i);',
    '  }',
    '  return out;',
    '}',
    'function drawTable(){',
    '  var all=DATA[CODE]||[];',
    '  var idxs=filteredIdx(),total=all.length;',
    '  var lim=ALL?idxs.length:Math.min(idxs.length,TLIM);',
    '  var h="",i,k,ii,r,prev,close,hi,lo,d,cls,sign;',
    '  for(i=0;i<idxs.length&&i<lim;i++){',
    '    ii=idxs[i];r=all[ii];',
    '    prev=ii>0?all[ii-1][4]:null;',
    '    close=r[4];hi=r[2];lo=r[3];',
    '    if(ii===total-1&&LIVE[CODE]){close=LIVE[CODE];hi=Math.max(hi,close);lo=Math.min(lo,close)}',
    '    d=(prev&&close)?+(((close-prev)/prev)*100).toFixed(2):null;',
    '    cls=d==null?"":(d>=0?"up":"down");',
    '    sign=d==null?"—":((d>=0?"+":"")+d.toFixed(2)+"%");',
    '    h+="<tr><td>"+r[0]+(ii===total-1?" <span style=\\"color:#f59e0b;font-size:11px\\">today</span>":"")+"</td>"',
    '      +"<td>"+r[1].toFixed(2)+"</td><td>"+hi.toFixed(2)+"</td><td>"+lo.toFixed(2)+"</td>"',
    '      +"<td><b>"+close.toFixed(2)+"</b></td><td class=\\""+cls+"\\">"+sign+"</td></tr>";',
    '  }',
    '  document.querySelector("#tbl tbody").innerHTML=h;',
    '  var tc=document.getElementById("tcount");',
    '  if(tc)tc.textContent=idxs.length+" trading days"+(idxs.length>lim?" (latest "+lim+")":"");',
    '  var btn=document.getElementById("more");',
    '  if(btn){',
    '    btn.style.display=(idxs.length>TLIM)?"block":"none";',
    '    btn.textContent=ALL?"Collapse ▲":"Show all ("+idxs.length+" trading days) ▼";',
    '  }',
    '}',
    /* ---- 年份 / 月份下拉 ---- */
    'function buildFilters(){',
    '  var all=DATA[CODE]||[],ys={},ms={},i;',
    '  for(i=0;i<all.length;i++){ys[all[i][0].slice(0,4)]=1;ms[all[i][0].slice(5,7)]=1}',
    '  var yk=Object.keys(ys).sort(),mk=Object.keys(ms).sort();',
    '  var fy=document.getElementById("fy"),fm=document.getElementById("fm");',
    '  var opt=\'<option value="all">All years</option>\';',
    '  for(i=0;i<yk.length;i++)opt+=\'<option value="\'+yk[i]+\'">\'+yk[i]+"</option>";',
    '  fy.innerHTML=opt;',
    '  opt=\'<option value="all">All months</option>\';',
    '  var MN=["01","02","03","04","05","06","07","08","09","10","11","12"];',
    '  for(i=0;i<MN.length;i++){if(!ms[MN[i]])continue;',
    '    opt+=\'<option value="\'+MN[i]+\'">\'+MN[i]+"</option>";}',
    '  fm.innerHTML=opt;',
    '  fy.value=(SEL_Y!="all"&&ys[SEL_Y])?SEL_Y:"all";',
    '  fm.value=(SEL_M!="all"&&ms[SEL_M])?SEL_M:"all";',
    '  SEL_Y=fy.value;SEL_M=fm.value;',
    '}',
    /* ---- 卡片 ---- */
    'function drawCard(c){',
    '  var rows=effRows(c);if(!rows.length)return;',
    '  var r=rows[rows.length-1];',
    '  var p=LIVE[c]||r[4];',
    '  var set=function(id,v){var e=document.getElementById(id);if(e)e.textContent=v};',
    '  set("px-"+c,"$"+p.toFixed(2));',
    '  set("o-"+c,r[1].toFixed(2));set("h-"+c,r[2].toFixed(2));set("l-"+c,r[3].toFixed(2));',
    '  var prev=rows.length>1?rows[rows.length-2][4]:null;',
    '  var d=prev?+(((p-prev)/prev)*100).toFixed(2):null;',
    '  var el=document.getElementById("d-"+c);',
    '  if(el){el.className=d==null?"":(d>=0?"up":"down");',
    '    el.textContent=d==null?"—":((d>=0?"+":"")+d.toFixed(2)+"%")}',
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
    '    var ageTxt=" · "+(age<60?age+"s ago":Math.round(age/60)+"m ago");',
    '    var closed=j.market==="closed";',
    '    ["brent","wti"].forEach(function(c){',
    '      var a=document.getElementById("age-"+c);if(a)a.textContent=ageTxt;',
    '      var m=document.getElementById("mkt-"+c);if(m)m.textContent=closed?"Closed":"Live";',
    '      var dot=document.getElementById("dot-"+c);',
    '      if(dot)dot.className="dot "+(closed?"closed":"open");',
    '      drawCard(c);',
    '    });',
    '    drawChart();drawLegend();drawTable();',
    '  }).catch(function(){});',
    '}',
    'function start(){if(timer)return;timer=setInterval(function(){if(!hidden)tick()},3000);tick()}',
    'function stop(){if(timer){clearInterval(timer);timer=null}}',
    'document.addEventListener("visibilitychange",function(){',
    '  hidden=document.hidden;if(hidden){stop()}else{start()}',
    '});',
    /* ---- 事件绑定 ---- */
    '(function(){',
    '  var svg=svgEl();',
    '  document.getElementById("seg").addEventListener("click",function(e){',
    '    var b=e.target.closest("button");if(!b)return;',
    '    CODE=b.getAttribute("data-c");',
    '    var bs=this.querySelectorAll("button");',
    '    for(var i=0;i<bs.length;i++)bs[i].className=(bs[i]===b?"on":"");',
    '    var nm=document.getElementById("lg-name");',
    '    if(nm)nm.textContent=(CODE==="wti"?"WTI Crude":"Brent Crude")+" · Daily";',
    '    ALL=false;V.hover=-1;V.hoverY=-1;V.atEnd=true;',
    '    buildFilters();drawChart();drawLegend();drawTable();',
    '  });',
    '  document.getElementById("ranges").addEventListener("click",function(e){',
    '    var b=e.target.closest("button");if(!b)return;',
    '    var bs=this.querySelectorAll("button");',
    '    for(var i=0;i<bs.length;i++)bs[i].className=(bs[i]===b?"on":"");',
    '    setSpan(parseInt(b.getAttribute("data-n"),10)||0);',
    '  });',
    '  document.getElementById("more").addEventListener("click",function(){ALL=!ALL;drawTable()});',
    '  document.getElementById("fy").addEventListener("change",function(){SEL_Y=this.value;ALL=false;drawTable()});',
    '  document.getElementById("fm").addEventListener("change",function(){SEL_M=this.value;ALL=false;drawTable()});',
    /* 鼠标：悬停十字线 + 滚轮缩放 + 拖拽平移 */
    '  svg.addEventListener("mousemove",function(e){',
    '    if(drag){var dx=e.clientX-drag.x;drag.x=e.clientX;panByPx(dx);return}',
    '    hoverAt(localPos(e));',
    '  });',
    '  svg.addEventListener("mouseleave",function(){',
    '    if(V.hover!==-1){V.hover=-1;V.hoverY=-1;drawChart();drawLegend()}',
    '  });',
    '  var drag=null;',
    '  svg.addEventListener("mousedown",function(e){',
    '    drag={x:e.clientX};svg.style.cursor="grabbing";e.preventDefault();',
    '  });',
    '  window.addEventListener("mouseup",function(){',
    '    if(drag){drag=null;svg.style.cursor="crosshair"}',
    '  });',
    '  svg.addEventListener("wheel",function(e){',
    '    e.preventDefault();',
    '    var g=geom(),p=localPos(e);',
    '    var frac=(p.x-PL)/g.PW;',
    '    zoomAt(frac,e.deltaY>0?1.2:1/1.2);',
    '  },{passive:false});',
    /* 触屏：横滑平移 / 竖滑让页面滚动 / 单击选中 / 双指捏合缩放 */
    '  var tc=null;',
    '  function tdist(t){var dx=t[0].clientX-t[1].clientX,dy=t[0].clientY-t[1].clientY;',
    '    return Math.sqrt(dx*dx+dy*dy)||1}',
    '  svg.addEventListener("touchstart",function(e){',
    '    if(e.touches.length===1){',
    '      var t=e.touches[0];',
    '      tc={m:1,x:t.clientX,y:t.clientY,sx:t.clientX,sy:t.clientY,',
    '          moved:false,axis:""};',
    '    }else if(e.touches.length===2){',
    '      var cx=(e.touches[0].clientX+e.touches[1].clientX)/2;',
    '      var r0=svg.getBoundingClientRect();',
    '      var g=geom();',
    '      tc={m:2,d:tdist(e.touches),span:V.span,a0:V.i0f,frac:(cx-r0.left-PL)/g.PW};',
    '    }',
    '  },{passive:true});',
    '  svg.addEventListener("touchmove",function(e){',
    '    if(!tc)return;',
    '    if(tc.m===1&&e.touches.length===1){',
    '      var t=e.touches[0],dx=t.clientX-tc.x,dy=t.clientY-tc.y;',
    '      if(!tc.axis){',
    '        var ax=Math.abs(t.clientX-tc.sx),ay=Math.abs(t.clientY-tc.sy);',
    '        if(ax<6&&ay<6)return;',
    '        tc.axis=(ax>=ay)?"x":"y";',
    '      }',
    '      if(tc.axis!=="x")return;',
    '      e.preventDefault();',
    '      tc.x=t.clientX;tc.y=t.clientY;tc.moved=true;',
    '      panByPx(dx,true);',
    '      var r0=svg.getBoundingClientRect();',
    '      hoverAt({x:t.clientX-r0.left,y:t.clientY-r0.top});',
    '    }else if(tc.m===2&&e.touches.length===2){',
    '      e.preventDefault();',
    '      var nd=tdist(e.touches);',
    '      var rows=effRows(CODE),total=rows.length;',
    '      var ns=Math.round(tc.span*(tc.d/nd));',
    '      ns=Math.max(5,Math.min(total,ns));',
    '      var anchor=tc.a0+tc.frac*(tc.span-1);',
    '      V.span=ns;V.i0f=anchor-tc.frac*(ns-1);V.atEnd=false;',
    '      clampView(total);',
    '      V.atEnd=(Math.round(V.i0f)+V.span>=total);',
    '      clearRangeBtns();drawChart();drawLegend();',
    '    }',
    '  },{passive:false});',
    '  svg.addEventListener("touchend",function(e){',
    '    if(!tc)return;',
    '    if(tc.m===1&&!tc.moved){',
    '      var r0=svg.getBoundingClientRect();',
    '      hoverAt({x:tc.sx-r0.left,y:tc.sy-r0.top});',
    '    }',
    '    if(e.touches.length===0)tc=null;',
    '  },{passive:true});',
    '  svg.addEventListener("touchcancel",function(){tc=null},{passive:true});',
    '  var rz=null;',
    '  window.addEventListener("resize",function(){',
    '    if(rz)clearTimeout(rz);',
    '    rz=setTimeout(function(){drawChart()},120);',
    '  });',
    '})();',
    'buildFilters();drawChart();drawLegend();drawTable();start();',
  ].join('\n');
}
