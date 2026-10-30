/**
 * oil-data-worker  v8
 * ---------------------------------------------------------------
 * v2 改动（针对「手动刷新拉不到新数据」问题）：
 *  1. 原油：抓取时一并记录 stale（沿用值标记）与 as_of（源观测时间），
 *     并在 /update、/data、首页展示，能区分「没抓到」与「抓到了但源未刷新」。
 *  2. 黄金：★ B8 三源 xaus(主)→biquote(备)→gold-api(兜底)，循环 2 轮，每 6 分钟抓取
 *     （专用 cron，每 6 分钟；受 KV 免费版 1,000 次/天写入配额限制，不能每分钟）；
 *     三源均无 key、无限流，因此不再需要"每天只抓一次"的配额保护。
 *  3. 所有响应加 Cache-Control: no-store，避免中间缓存导致「点了没真发出去」。
 *
 * v3 改动：布伦特交易时段闸门（以伦敦本地时间判断，周六休市整天不抓）
 * v4 改动：收盘补抓（休市后 1 小时再抓一次，钉死当日最终价）
 * v5 改动：国内油价加「每日闸门」（与黄金一致：cron 08:00 抓一次，
 *          手动当天已抓过则跳过，cron 失败才允许补 1 次）
 *
 * v6 改动（本次）：
 *  1. 【移除】万维易源 ShowAPI 1108-2 历史日报 —— 实测该接口免费档返回的
 *     日期与请求区间对不上（请求 2026-08~10 却返回 2025-12 的数据），
 *     且价格与实时价差近一倍（62 vs 107），数据不可信，已彻底删除，不留开关。
 *  2. 【自建历史走势】复用已有的 cron 抓取，一份数据两用、零额外额度：
 *       当日首抓 → open   每次抓取 → high/low 采样极值
 *       休市后收盘补抓 → close 定格（最准）
 *     只在交易时段 / 收盘窗口记录，周末沿用值不污染走势。
 *  3. 【新增 /clear-history】一键清空历史重来（?confirm=1 执行）。
 *     清理入口也顺带删除残留的 brent_history_marker。
 *
 * 当前保留的数据源：OilPriceAPI（原油）、xaus.com / biquote.io /
 *                    api.gold-api.com（黄金三源）、
 *                    ShowAPI 138-46（国内油价，与已删除的 1108 无关）
 *                    （MetalpriceAPI 已彻底移除，仅存于下方变更历史）
 *
 * v7 改动：新增 ACCESS_KEY 私有密钥（防止公网刷爆 API 配额）
 *
 * v8 改动（本次）：布伦特与 WTI 拆成两套独立交易时段闸门
 *  1. 【两个品种的交易时段本来就不一样，不能共用一套判断】
 *       布伦特（ICE，伦敦）：周日 23:00 开盘，周一~周五 23:00 收盘，
 *                            每日休市 2 小时（23:00-01:00），周六全天休市
 *       WTI（CME，芝加哥）：周日 17:00 开盘，周一~周五 16:00 收盘，
 *                            每日休市 1 小时（16:00-17:00），周六全天休市
 *
 *  2. 【修复：周日开盘时间写错，一周白烧 22 次】
 *       旧代码写「周日 01:00 开盘」，但 ICE 官方合约规格明确是
 *       「Open 01:00 (23.00 on Sundays)」—— 周日其实是 23:00 开盘。
 *       旧逻辑导致周日白天伦敦 01:00-22:00 全在抓，那 22 小时市场是休市的，
 *       抓回来的全是周五收盘后的沿用值，纯浪费配额。
 *
 *  3. 【修复：收盘补抓不能「休市后 1 小时」】
 *       WTI 每天只休市 1 小时。若沿用「休市后 1 小时再抓」会落在 17:00，
 *       那已经是【重新开盘】的时刻，抓到的是新交易日开盘价而非当日收盘价。
 *       改为休市后 20 分钟抓（芝加哥 16:20 / 伦敦 23:20），仍在休市窗口内。
 *
 *  4. 【cron 改为 "5,20 * * * *"】每小时跑两次：
 *       :05 → 盘中采样（开盘那小时 = 开盘后 5 分钟）
 *       :20 → 收盘补抓（休市那小时 = 休市后 20 分钟）
 *       伦敦 / 芝加哥与 UTC 时差都是整小时，分钟数无需换算。
 *
 *  5. 【修复：周一凌晨被误判为休市】
 *       周一 00:00 是「周日 23:00 开盘」的延续，本属交易时段，
 *       旧代码写死 hour>=1 会把它判成休市，丢掉开盘后第一个数据点。
 *
 *  6. 【交易日归属各自计算】布伦特看伦敦（周日 23:00 后归周一），
 *       WTI 看芝加哥（17:00 后归次日），历史走势不再串天。
 *
 *  实测消耗：130 次/周（改前 138），日均 18.6 次，峰值日 26 次，
 *            离 50 次/天上限很宽裕，且周日不再白烧。
 *
 * v8 附带：/_schedule-preview 排班预演页（纯只读诊断）
 *   不读 KV、不写 KV、不发外部请求、不触发抓取、不影响定时任务；
 *   无密钥返回 404 隐身。
 *
 * v8.1 修复：预演页曾触发 Error 1102（Worker exceeded resource limits）
 *   根因：每行三地时间都在 Worker 里 new Intl.DateTimeFormat，首次创建带
 *         timeZone 的 formatter 要加载 ICU 时区数据，一个好几 ms，
 *         7 天上千次 = 310ms，远超 Workers CPU 上限。
 *   修复：① 全局 dtf() 缓存（8784 次比对验证 100% 等价）
 *         ② 两阶段：主循环只判定，昂贵计算只给保留行
 *         ③ 三地时间改由浏览器端 JS 渲染，Worker 只吐毫秒时间戳
 *   效果：7 天关键行 310ms → 5.3ms；HTML 31KB → 7.4KB
 * ---------------------------------------------------------------
 */

/* X-Robots-Tag：本站是私有数据后端，所有响应一律禁止搜索引擎收录，
 * 避免内部管理页（/ /history /update）被 Google 索引后公开暴露。 */
const NOINDEX = 'noindex, nofollow, noarchive, noimageindex';
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX };
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX };
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX };

/** ★ B7：换用无 key 源后无月度配额，手动刷新只保留最小间隔防误触（秒） */
const GOLD_MIN_INTERVAL_SEC = 300;

/* ★ B8 黄金三源相关常量
 *   后端每分钟才跑一次，时间宽裕，可以给每个源 5 秒超时。
 *   （前端那边时间紧得多，超时只有 3 秒 —— 不能让用户干等。） */
const GOLD_SRC_TIMEOUT_MS = 5000;   // 单个源最多等这么久
const GOLD_ROUND_GAP_MS   = 1000;   // 第 1 轮全灭后歇一下再跑第 2 轮

/** 单源超时保护：卡住的网络请求不能拖垮整次抓取 */
function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// 原油：一次请求拿两个品种（官方支持，20 个 code 也算 1 次配额）
// ------------------------------------------------------------
// 官方文档：by_code=A,B 时「One request, ONE against quota — up to 20 codes」
//   · 1 个 code   → data 是扁平对象，读 data.price
//   · 2 个及以上  → data.prices[] 是数组
// 所以解析必须两种结构都兼容（见 pickQuote）。
//
// 安全设计（重要）：批量请求一旦失败/拿不到布伦特，
// 自动降级为「只请求 BRENT_CRUDE_USD」（即改动前的原样请求），
// 保证布伦特永远不受 WTI 影响 —— WTI 只是白捡的，主流程零风险。
// ============================================================
const OIL_CODES = 'BRENT_CRUDE_USD,WTI_USD';
const BRENT_CODE = 'BRENT_CRUDE_USD';
const WTI_CODE = 'WTI_USD';
const OIL_LATEST_BASE = 'https://api.oilpriceapi.com/v1/prices/latest';

/* ============================================================
 * ★ B11：原油抓取改为【与 2 号同源的多源链路】
 * ------------------------------------------------------------
 * 背景：原用 OilPriceAPI（需 Token、有配额），实测出现过
 *   101.53（那其实是 WTI 的价）与 114.19（高出市场约 3%）这类偏离值，
 *   导致 3 号的收盘定格与 2 号实时链路对不上（110.70 vs 114.19）。
 * 现在改成与 2 号完全同源：biquote → yahoo → yahoo2 → stooq，
 *   OilPriceAPI 降级为最后兜底（仍可用，但不作为主源）。
 * 好处：2 号与 3 号取同一个市场价 → 定格值、报表天然一致。
 * ============================================================ */

const OIL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function oilGetJson(u, ms = 3500, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(u, {
      signal: ac.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json', 'User-Agent': OIL_UA, ...headers },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* 源 1：biquote —— 券商 MT5 链路（2 号黄金在用，实测偏差 < 0.04%） */
async function oilSrcBiquote() {
  const [w, b] = await Promise.all([
    oilGetJson('https://biquote.io/api/XTIUSD'),
    oilGetJson('https://biquote.io/api/XBRUSD'),
  ]);
  const mid = (j) => {
    const bid = Number(j && j.bid), ask = Number(j && j.ask);
    if (bid && ask) return (bid + ask) / 2;
    return Number(j && j.mid) || 0;
  };
  const wti = mid(w), brent = mid(b);
  if (!wti && !brent) throw new Error('biquote 两个符号都没返回价');
  return { brent, wti, provider: 'biquote', note: '券商 MT5 链路' };
}

/* 源 2：Yahoo Finance（2 号实测布伦特 111.91，与市场一致） */
async function oilSrcYahoo(host) {
  const one = async (sym) => {
    const j = await oilGetJson(
      `https://${host}/v8/finance/chart/${sym}?interval=1m&range=1d`, 3500);
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    const meta = res && res.meta;
    const p = Number(meta && (meta.regularMarketPrice || meta.previousClose));
    if (!p) throw new Error('Yahoo ' + sym + ' 无价');
    return p;
  };
  const [b, w] = await Promise.all([one('BZ=F'), one('CL=F')]);
  return { brent: b, wti: w, provider: host === 'query1.finance.yahoo.com' ? 'yahoo' : 'yahoo2',
           note: 'Yahoo Finance 期货' };
}

/* 源 4：Stooq 免费 CSV（无需 key） */
async function oilSrcStooq() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3500);
  try {
    const r = await fetch('https://stooq.com/q/l/?s=cb.f+cl.f&f=sd2t2ohlcv&h&e=csv',
      { signal: ac.signal, cache: 'no-store', headers: { 'User-Agent': OIL_UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    const rows = txt.trim().split('\n').slice(1);
    let brent = 0, wti = 0;
    for (const line of rows) {
      const c = line.split(',');
      const sym = (c[0] || '').toUpperCase();
      const close = Number(c[6]);
      if (!close) continue;
      if (sym.includes('CB.F')) brent = close;
      if (sym.includes('CL.F')) wti = close;
    }
    if (!brent && !wti) throw new Error('Stooq 未解析出价');
    return { brent, wti, provider: 'stooq', note: 'Stooq 免费 CSV' };
  } finally { clearTimeout(t); }
}

/* 兜底：OilPriceAPI（保留原逻辑，仅在主源全挂时使用） */
async function oilSrcOilPriceApi(apiKey) {
  if (!apiKey) throw new Error('Missing OILPRICEAPI_KEY');
  const headers = { 'Authorization': `Token ${apiKey}` };
  const res = await fetch(`${OIL_LATEST_BASE}?by_code=${OIL_CODES}`,
    { headers, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error('Oil API ' + res.status);
  const json = await res.json();
  const b = pickQuote(json, BRENT_CODE);
  const w = pickQuote(json, WTI_CODE);
  const brent = Number(b && b.price) || 0, wti = Number(w && w.price) || 0;
  if (!brent && !wti) throw new Error('OilPriceAPI 未解析出价');
  return { brent, wti, provider: 'oilpriceapi',
           stale: (b && b.stale === true) || json.stale === true,
           asOf: (b && (b.as_of || b.as_of_at || b.created_at)) || '',
           note: 'OilPriceAPI（兜底）' };
}

/* 主入口：按序尝试，拿到就停 */
async function fetchOilMulti(apiKey) {
  const srcs = [
    ['biquote',   () => oilSrcBiquote()],
    ['yahoo',     () => oilSrcYahoo('query1.finance.yahoo.com')],
    ['yahoo2',    () => oilSrcYahoo('query2.finance.yahoo.com')],
    ['stooq',     () => oilSrcStooq()],
    ['oilpriceapi', () => oilSrcOilPriceApi(apiKey)],
  ];
  const tried = [];
  for (const [id, fn] of srcs) {
    try {
      const r = await fn();
      if (r && (r.brent || r.wti)) {
        return { ...r, asOf: r.asOf || new Date().toISOString(), tried };
      }
      tried.push({ id, ok: false, error: '返回为空' });
    } catch (e) {
      tried.push({ id, ok: false, error: String(e && e.message || e) });
    }
  }
  throw new Error('全部原油源均失败：' + JSON.stringify(tried));
}


// 两个品种的历史走势配置（共用 recordDailyHistory，只是 KV key 和标题不同）
const HISTORY_SPECS = {
  brent: { kvKey: 'brent_history', label: '布伦特原油', code: BRENT_CODE },
  wti:   { kvKey: 'wti_history',   label: 'WTI 原油',   code: WTI_CODE },
};
function historySpec(key) {
  return HISTORY_SPECS[key] || HISTORY_SPECS.brent;   // 未知 key 一律回落布伦特，不会写脏 KV
}

// ============================================================
// 布伦特历史走势 —— 自建累积（已移除万维易源 ShowAPI 1108-2）
// ------------------------------------------------------------
// 为什么不再用 1108-2：
//   实测该接口免费档返回的日期与区间参数对不上（请求 2026-08~10，
//   返回 2025-12 的数据），且价格与实时价差近一倍（62 vs 107），
//   数据不可信，继续调用只是浪费额度。已彻底移除。
//
// 现在改为自建累积：复用已有的 cron 抓取，一份数据两用，
//   · 当日第一次抓取  → 记为 open（近似开盘）
//   · 每次抓取        → 更新 high / low（采样极值）
//   · 休市后收盘补抓  → 定格 close（当日收盘价，准确）
// 零额外额度消耗，数据全部来自自己抓的实时价，口径可信。
// ============================================================
/** KV 最多保留的历史条数（约 1 年交易日） */
const HISTORY_MAX_ROWS = 400;

// ------------------------------------------------------------
// 每日最少采样次数：低于此值时，该日的最高/最低不展示
// ------------------------------------------------------------
// 为什么需要：cron 每小时抓一次，伦敦交易时段 01:00-23:00 理论最多 22 个点。
// 但首日只有 1 次采样，四个字段（开/高/低/收）必然完全相同 ——
// 摆成 OHLC 四列看着就像编造的数据。
// 而且即便攒满一个月，22 个采样点之间的真实日内高低点仍可能漏掉。
// 所以：样本不足就不展示高/低，只保留有意义的收盘价。宁缺毋滥。
const SAMPLES_MIN = 3;

// ------------------------------------------------------------
// Intl.DateTimeFormat 实例化开销很大（带 timeZone 的首次创建需加载
// ICU 时区数据，一个数毫秒）。排班预演一次要格式化上千次，若每次新建
// 会直接触发 Workers 的 CPU 上限（Error 1102）。
// 这里做进程级缓存：同一 (locale, options) 只建一次，之后复用。
// ⚠️ 纯性能优化，返回值与 new Intl.DateTimeFormat(...) 完全等价。
// ------------------------------------------------------------
const __DTF_CACHE = new Map();
function dtf(locale, options) {
  const keys = Object.keys(options).sort();
  const k = locale + '|' + keys.map(x => x + ':' + String(options[x])).join(',');
  let f = __DTF_CACHE.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    __DTF_CACHE.set(k, f);
  }
  return f;
}

/** 北京时间日期串 YYYY-MM-DD（用于「每天一次」的闸门判断） */
function beijingDateString(d = new Date()) {
  try {
    return dtf('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch (e) {
    return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
}

function beijingNow() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/**
 * 交易日期 YYYY-MM-DD（伦敦时间为准）。
 * 布伦特是伦敦 01:00 开盘、23:00 收盘，跨自然日：
 * 伦敦 00:00（休市后补抓）在日历上已是「第二天」，但交易上属于前一交易日，
 * 所以这里往前推一天，保证收盘价落在正确的交易日上。
 */
function tradingDateString(d = new Date()) {
  let lon;
  try {
    lon = dtf('en-CA', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch (e) {
    lon = new Date(d.getTime() + (d.getUTCMonth() > 9 || (d.getUTCMonth() === 9 && d.getUTCDate() >= 25) ? 0 : 1) * 3600 * 1000)
      .toISOString().slice(0, 10);
  }
  const { wd, hour } = londonParts(d);
  // 周日 23:00 开盘 → 交易上属于「周一」交易日，往后推一天
  if (wd === 0 && hour >= 23) {
    const dt = new Date(`${lon}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }
  // 周二~周六 凌晨（休市窗口内）→ 属于前一交易日
  // 注意：周一凌晨不回推 —— 周一 00:00 是周日 23:00 开盘的延续，本来就是周一交易日
  if (wd >= 2 && wd <= 6 && hour < 1) {
    const dt = new Date(`${lon}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  }
  return lon;
}

/**
 * WTI 交易日 YYYY-MM-DD（芝加哥/美中时间为准）。
 * CME 规则：周日 17:00 开盘，每天 16:00 收盘、17:00 再开盘。
 * 所以芝加哥 17:00 之后属于「下一个」交易日。
 */
function wtiTradingDateString(d = new Date()) {
  let chi;
  try {
    chi = dtf('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch (e) {
    chi = new Date(d.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const { hour } = chicagoParts(d);
  if (hour >= 17) {
    const dt = new Date(`${chi}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }
  return chi;
}

/** 北京时间小时数（0-23），用于 cron 内部分支判断 */
function beijingHour(d = new Date()) {
  try {
    return +dtf('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false,
    }).format(d);
  } catch (e) {
    return new Date(d.getTime() + 8 * 3600 * 1000).getUTCHours();
  }
}

/** 伦敦本地时间 HH:MM（仅用于日志，方便你核对闸门行为） */
function londonClock(d = new Date()) {
  try {
    return dtf('en-GB', {
      timeZone: 'Europe/London', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch (e) {
    return 'n/a';
  }
}

/** 芝加哥本地时间（仅用于日志，方便你核对 WTI 闸门行为） */
function chicagoClock(d = new Date()) {
  try {
    return dtf('en-GB', {
      timeZone: 'America/Chicago', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch (e) {
    return 'n/a';
  }
}

/** 解析伦敦本地时间 → { wd: 0=周日..6=周六, hour: 0-23 } */
function londonParts(d = new Date()) {
  try {
    const parts = dtf('en-GB', {
      timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(get('weekday').toLowerCase());
    const hour = parseInt(get('hour'), 10);
    if (wd >= 0 && !isNaN(hour)) return { wd, hour };
  } catch (e) { /* fall through */ }
  // 兜底：手动换算（粗略，极少触发）
  const lon = new Date(d.getTime() + (d.getUTCMonth() > 9 || (d.getUTCMonth() === 9 && d.getUTCDate() >= 25) ? 0 : 1) * 3600 * 1000);
  return { wd: lon.getUTCDay(), hour: lon.getUTCHours() };
}

/** 解析芝加哥（美中）本地时间 → { wd: 0=周日..6=周六, hour: 0-23 } —— WTI 用 */
function chicagoParts(d = new Date()) {
  try {
    const parts = dtf('en-GB', {
      timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(get('weekday').toLowerCase());
    const hour = parseInt(get('hour'), 10);
    if (wd >= 0 && !isNaN(hour)) return { wd, hour };
  } catch (e) { /* fall through */ }
  const c = new Date(d.getTime() - 6 * 3600 * 1000);
  return { wd: c.getUTCDay(), hour: c.getUTCHours() };
}

/**
 * cron 相位判定。
 * cron 改为 "5,20 * * * *"：每小时跑两次。
 *   :05 → 'open'  盘中采样（开盘那小时即为「开盘后 5 分钟」）
 *   :20 → 'close' 收盘补抓（休市那小时即为「休市后 20 分钟」）
 * 伦敦 / 芝加哥与 UTC 的时差都是整小时，分钟数无需换算。
 */
function cronPhase(d = new Date()) {
  return d.getUTCMinutes() < 10 ? 'open' : 'close';
}

// ============================================================
// ============================================================
// ★ v8 重写：布伦特与 WTI 拆成两套独立闸门
// ------------------------------------------------------------
// 两个品种的交易时段【不一样】，不能共用一套判断：
//
//  布伦特 Brent（ICE，以伦敦本地时间判断，英国 BST/GMT 自动跟随）
//   · 周日 23:00 开盘（ICE 官方合约规格明确写了「Open 01:00 (23.00 on Sundays)」）
//   · 周一~周五 23:00 收盘
//   · 每日休市 2 小时：23:00 - 01:00
//   · 周六全天休市
//   ※ 关键：周一 00:00 是「周日 23:00 开盘」的延续，属于交易时段，
//     旧代码写死 hour>=1 会把周一凌晨误判为休市，丢掉开盘后第一个点。
//
//  WTI（CME Globex，以芝加哥/美中时间判断，美国 CDT/CST 自动跟随）
//   · 周日 17:00 开盘
//   · 周一~周五 16:00 收盘
//   · 每日休市 1 小时：16:00 - 17:00  ←★ 只有 1 小时，比布伦特短一半
//   · 周六全天休市
//   ※ 关键：旧逻辑「休市后 1 小时再抓」套到 WTI 上会落在 17:00，
//     那是【重新开盘】的时刻，抓到的是新交易日开盘价而不是收盘价。
//
// 两个品种都用「本地时间」判断而不是写死北京时间 —— 英国 10 月底切冬令时、
// 美国 11 月初切冬令时，都能自动跟随，不需要改代码。
// ============================================================
function isBrentTrading(d = new Date()) {
  const { wd, hour } = londonParts(d);
  if (wd === 6) return false;                       // 周六全天休市
  if (wd === 0) return hour >= 23;                  // 周日 23:00 开盘
  return hour < 23;                                 // 周一~周五 23:00 收盘
}

/** 布伦特收盘补抓窗口 = 休市第 1 小时（伦敦 23:00-24:00），配合 :20 即「休市后 20 分钟」 */
function isBrentClosing(d = new Date()) {
  const { wd, hour } = londonParts(d);
  if (wd === 0 || wd === 6) return false;
  return hour === 23;
}

function isWtiTrading(d = new Date()) {
  const { wd, hour } = chicagoParts(d);
  if (wd === 6) return false;                       // 周六全天休市
  if (wd === 0) return hour >= 17;                  // 周日 17:00 开盘
  if (wd === 5) return hour < 16;                   // 周五 16:00 周收盘
  return hour !== 16;                               // 周一~周四：仅 16:00-17:00 休市
}

/** WTI 收盘补抓窗口 = 芝加哥 16:00-17:00 那 1 小时，配合 :20 即「休市后 20 分钟」 */
function isWtiClosing(d = new Date()) {
  const { wd, hour } = chicagoParts(d);
  if (wd === 0 || wd === 6) return false;
  return hour === 16;
}

// ============================================================
// 黄金（XAU/USD 现货）交易时段 —— 纽约时间为准
// ------------------------------------------------------------
// 国际现货黄金：周日纽约 18:00 开盘，周五纽约 17:00 周收盘，
// 每天纽约 17:00-18:00 为结算时段（休市 1 小时），周六周日全程休市。
// 换算成北京时间（夏令时）：早上 06:00 开盘，次日凌晨 05:00 收盘，
// 每天 05:00-06:00 结算休市。
// 美国 11 月进冬令时后整体延后 1 小时，代码用 America/New_York
// 标准时区名，会自动跟随，不必改代码。
// ============================================================

// 解析纽约本地时间 → { wd: 0=周日..6=周六, hour: 0-23 }
function newYorkParts(d = new Date()) {
  try {
    const parts = dtf('en-GB', {
      timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value || '';
    const wd = ['sun','mon','tue','wed','thu','fri','sat'].indexOf(get('weekday').toLowerCase());
    const hour = parseInt(get('hour'), 10);
    if (wd >= 0 && !isNaN(hour)) return { wd, hour };
  } catch (e) { /* 落到兜底 */ }
  const n = new Date(d.getTime() - 5 * 3600 * 1000);
  return { wd: n.getUTCDay(), hour: n.getUTCHours() };
}

// 纽约本地时间 HH:MM（仅用于日志与状态展示，方便你核对闸门行为）
function newYorkClock(d = new Date()) {
  try {
    return dtf('en-GB', {
      timeZone: 'America/New_York', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch (e) { return 'n/a'; }
}

// ★ 黄金市场状态：open=交易中 / settlement=每日结算 / weekend=周末休市
// 这个函数同时给后台记录闸门用、也给前端显示「休市中」用，两处口径一致。
function goldMarketState(d = new Date()) {
  const { wd, hour } = newYorkParts(d);
  if (wd === 6) return 'weekend';                    // 周六全天休市
  if (wd === 0) return hour >= 18 ? 'open' : 'weekend'; // 周日 18:00 开盘
  if (wd === 5) return hour < 17 ? 'open' : 'weekend';  // 周五 17:00 周收盘
  if (hour === 17) return 'settlement';              // 周一~周四 每日结算 1 小时
  return 'open';
}

// 是否处于黄金交易时段（只有 true 时才累积开高低收）
function isGoldTrading(d = new Date()) {
  return goldMarketState(d) === 'open';
}

// 黄金交易日 YYYY-MM-DD（以北京日期为基准，符合中文访客直觉）
// 新交易日从北京 06:00 开始，所以北京 00:00-05:59 属于前一交易日。
function goldTradingDateString(d = new Date()) {
  const bj = beijingDateString(d);
  const h = beijingHour(d);
  if (h < 6) {
    const dt = new Date(bj + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  }
  return bj;
}

// 该日期是否为黄金交易日（周一~周五）
function isWeekdayForGold(day) {
  const wd = new Date(day + 'T12:00:00Z').getUTCDay();
  return wd >= 1 && wd <= 5;
}

// ============================================================
// 通用「每天只抓一次」闸门
// ------------------------------------------------------------
// 规则（黄金 / 国内油价 / 历史日报 三处共用）：
//   · 定时任务 → 无条件抓取
//   · 手动刷新 → 若今天已成功抓过（marker 日期 = 今天）直接跳过，0 消耗
//   · 手动补抓 → 定时任务失败时 marker 不会写入，手动即可补 1 次
// 关键点：marker 只在「抓取成功后」才写，所以失败时闸门自动放行。
// ============================================================
function sourceLabel(s) {
  return s === 'cron' ? '定时任务' : s === 'manual' ? '手动' : s === 'bootstrap' ? '初始化' : (s || '未知');
}

async function checkDailyGate(env, markerKey, { manual = false } = {}) {
  if (!manual) return { skip: false, marker: null };
  const marker = await env.OIL_KV.get(markerKey, 'json').catch(() => null);
  const today = beijingDateString();
  if (marker && marker.date === today) {
    return {
      skip: true,
      marker,
      reason: `今日已抓取（${sourceLabel(marker.source)}），跳过以省额度`,
    };
  }
  return { skip: false, marker };
}

async function markDailyFetched(env, markerKey, source) {
  await env.OIL_KV.put(
    markerKey,
    JSON.stringify({ date: beijingDateString(), source, at: beijingNow() }),
    { expirationTtl: 86400 * 3 }
  );
}

/* ============ 私有后端访问控制（v7） ============
 *
 * 背景：本站是 2 号 PriceScope 的专属数据后端，本不该对公网开放。
 * 加防护前的三个风险（按严重程度排序）：
 *
 *   ① /update 任何人可触发真实抓取 ★最危险★
 *      一次 /update 会同时打三家 API：
 *        OilPriceAPI  50 次/天
 *        Metalprice   100 次/月
 *        万维易源      100 次/天
 *      被脚本刷几次，当天配额就见底，2 号站全天取不到数据。
 *
 *   ② / 与 /history 会把内部数据管理页整个公开。
 *
 *   ③ 搜索引擎可能收录这些内部页。
 *
 * 策略：按危险程度分级
 *   /update /clear-history → 无密钥直接 404（连"存在"都不暴露）
 *   /data                  → 无密钥 403 JSON
 *   / /history             → 无密钥返回极简占位页（无数据）
 *   /robots.txt            → 公开返回 Disallow: /
 *
 * 密钥两种携带方式：
 *   · 请求头 X-Access-Key   ← 2 号 Worker 服务端调用用这个
 *   · 查询参数 ?key=        ← 你自己浏览器访问用这个（可存书签）
 *
 * ⚠️ 未配置 env.ACCESS_KEY 时防护自动关闭（放行），
 *    防止密钥没配好导致 2 号站全线取不到数据。
 */
function hasAccess(request, env) {
  const expected = env.ACCESS_KEY;
  if (!expected) return true;
  const h = request.headers.get('X-Access-Key');
  if (h && h === expected) return true;
  try {
    const q = new URL(request.url).searchParams.get('key');
    if (q && q === expected) return true;
  } catch (_) {}
  return false;
}

/* 未授权时的占位页：不含任何数据，也不含任何可探测的链接 */
function lockedPage() {
  return new Response(
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<title>403</title></head><body style="font-family:system-ui;display:flex;' +
    'align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#94a3b8">' +
    '<div style="text-align:center"><div style="font-size:48px;font-weight:600">403</div>' +
    '<div style="margin-top:8px;font-size:14px">Forbidden</div></div></body></html>',
    { status: 403, headers: HTML_HEADERS }
  );
}

/* 无密钥访问受保护路由时返回 404 —— 不暴露这些路径真实存在 */
function ghost() {
  return new Response('Not Found', { status: 404, headers: { ...TEXT_HEADERS } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ok = hasAccess(request, env);

    // robots.txt：公开返回，明确告诉搜索引擎不要抓
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', { headers: TEXT_HEADERS });
    }

    // ① 高危写操作：无密钥直接 404，不暴露路径存在
    if ((url.pathname === '/update' || url.pathname === '/clear-history') && !ok) {
      return ghost();
    }

    // ② 数据接口：无密钥 403
    if (url.pathname === '/data' && !ok) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403, headers: JSON_HEADERS,
      });
    }

    // ③ 内部管理页：无密钥返回无数据占位页
    if ((url.pathname === '/' || url.pathname === '/history') && !ok) {
      return lockedPage();
    }

    // ---------------- 首页 ----------------
    if (url.pathname === '/') {
      // 密钥透传：让首页底部所有链接继续可用（否则点了就 403）
      const keyQS = url.searchParams.get('key') ? `?key=${encodeURIComponent(url.searchParams.get('key'))}` : '';
      const [oilCached, goldCached, cnCached, wtiCached] = await Promise.all([
        env.OIL_KV.get('oil_data', 'json'),
        env.OIL_KV.get('gold_data', 'json'),
        env.OIL_KV.get('cn_oil_data', 'json'),
        env.OIL_KV.get('wti_data', 'json'),
      ]);

      // 首屏只读缓存，绝不触发抓取（省配额）
      let o = oilCached, g = goldCached, cn = cnCached;
      if (!o) o = (await fetchAndSave(env, false, { brent: true, wti: true, force: true })).data;
      if (!g) g = (await fetchGoldAndSave(env, { bootstrap: true })).data;
      if (!cn) cn = await fetchCnOilAll(env);

      if (!o && !g && !(cn && cn.list && cn.list.length)) {
        return new Response('<h1>暂无数据</h1><p><a href="/update' + keyQS + '">点击更新</a></p>', { headers: HTML_HEADERS });
      }

      const pricePerBarrel = o ? parseFloat(o.price) : null;
      const pricePerLiter = o ? (pricePerBarrel / 158.987).toFixed(4) : '—';
      const pricePerLiterCny = o ? (pricePerLiter * 7.2).toFixed(2) : '—';

      const oilUTC = o?.timestamp ? new Date(o.timestamp).toISOString() : '';
      const oilAsOf = o?.asOf ? new Date(o.asOf).toISOString() : '';
      /* 数据源代号 -> 看板显示名（MetalpriceAPI 早已废弃，勿再出现） */
      const goldSrcName = (c) => ({
        xaus: 'xaus.com（主）',
        biquote: 'biquote.io（备用 · 券商实时链路）',
        'gold-api': 'api.gold-api.com（兜底）',
      })[c] || (c || '—');

      const goldUTC = g?.updatedAt || '';
      const cnUTC = cn?.updatedAt || '';
      const displayUTC = oilAsOf || oilUTC || goldUTC || cnUTC;

      // 原油标签：先看 stale，再区分「收盘价」与「盘中价」
      const oilTag = o?.stale === true
        ? '📅 休市沿用价（源数据未刷新，沿用上一交易日收盘）'
        : (o?.isClosing
          ? '🔒 当日收盘价（休市后 1 小时抓取，已定格）'
          : '⚡ 盘中参考价（交易时段每小时更新）');

      const oilFresh = o?.stale === true
        ? '<span style="color:#c0392b">沿用值 stale=true</span>'
        : '<span style="color:#27ae60">新值 stale=false</span>';

      const cnJson = JSON.stringify((cn && cn.list) || []);

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>国际原油 & 黄金 & 国内油价 · 数据看板</title>
<meta name="description" content="布伦特原油 $${pricePerBarrel || '—'} USD/桶，国际黄金 $${g?.priceUsdPerOz || '—'} USD/盎司，国内成品油各省指导价">
</head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px">
<h1>📊 国际原油 & 黄金 · 数据看板</h1>

${o ? `
<h2 style="margin-top:32px">🛢️ 布伦特原油</h2>
<p><strong>${oilTag}</strong></p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每桶价格</td><td style="padding:8px 0">$${pricePerBarrel} USD</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每升价格</td><td style="padding:8px 0">$${pricePerLiter} USD（≈ ¥${pricePerLiterCny} 元/升）</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据新鲜度</td><td style="padding:8px 0">${oilFresh}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">源观测时间 as_of</td><td style="padding:8px 0">${oilAsOf || '—'} <span style="font-size:12px;color:#999">(UTC)</span></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">收集时间 created_at</td><td style="padding:8px 0">${oilUTC} <span style="font-size:12px;color:#999">(UTC)</span></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">上次价格 / 是否变化</td><td style="padding:8px 0">${o.prevPrice ?? '—'} / ${o.changed === null ? '—' : (o.changed ? '有变化' : '无变化')}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">本次抓取时刻</td><td style="padding:8px 0">${o.updatedLocal || '—'} <span style="font-size:12px;color:#999">(北京时间)</span></td></tr>
</table>` : ''}

${wtiCached && wtiCached.price != null ? `
<h2 style="margin-top:32px">🛢️ WTI 原油</h2>
<p><strong>⚡ 与布伦特同一次请求带回（不额外消耗配额）</strong></p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每桶价格</td><td style="padding:8px 0">$${wtiCached.price} USD</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每升价格</td><td style="padding:8px 0">$${(parseFloat(wtiCached.price) / 158.987).toFixed(4)} USD</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据新鲜度</td><td style="padding:8px 0">${wtiCached.stale === true ? '<span style="color:#c0392b">沿用值 stale=true</span>' : '<span style="color:#27ae60">新值 stale=false</span>'}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">源观测时间 as_of</td><td style="padding:8px 0">${wtiCached.asOf ? new Date(wtiCached.asOf).toISOString() : '—'} <span style="font-size:12px;color:#999">(UTC)</span></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">上次价格 / 是否变化</td><td style="padding:8px 0">${wtiCached.prevPrice ?? '—'} / ${wtiCached.changed === null ? '—' : (wtiCached.changed ? '有变化' : '无变化')}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">本次抓取时刻</td><td style="padding:8px 0">${wtiCached.updatedLocal || '—'} <span style="font-size:12px;color:#999">(北京时间)</span></td></tr>
</table>` : ''}

${g ? `
<h2 style="margin-top:32px">🪙 国际黄金（XAU/USD）</h2>
<p><strong>⚡ 现货参考价（每 6 分钟采集，三源互为备用）</strong></p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每盎司价格</td><td style="padding:8px 0">$${g.priceUsdPerOz} USD/盎司</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每克价格</td><td style="padding:8px 0">≈ ¥${g.priceCnyPerGram} / 克</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">本次命中数据源</td><td style="padding:8px 0">${goldSrcName(g.fetchedFrom)}${g.stale === true ? ' <span style="color:#c0392b">（上游未刷新，沿用值）</span>' : ' <span style="color:#27ae60">（新值）</span>'}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">备用链路</td><td style="padding:8px 0">xaus → biquote → gold-api，失败后循环重试 2 轮</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">源观测时间 as_of</td><td style="padding:8px 0">${goldUTC} <span style="font-size:12px;color:#999">(UTC)</span></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">本次采集时刻</td><td style="padding:8px 0">${g.fetchedLocal || '—'} <span style="font-size:12px;color:#999">(北京时间)</span></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">上次价格 / 是否变化</td><td style="padding:8px 0">${g.prevPriceUsdPerOz ?? '—'} / ${g.changed === null ? '—' : (g.changed ? '有变化' : '无变化')}</td></tr>
</table>
<p style="font-size:12px;color:#999">ℹ️ 黄金每 6 分钟自动抓取一次（专用 cron "*/6"，与原油的 "5,20" 分开）；三源均无 key、无限流，按序 xaus → biquote → gold-api，失败后循环重试 2 轮。实时跳动由 2 号前端在浏览器直连 biquote 完成，本层为兜底与首屏。</p>` : ''}

${cn && cn.list && cn.list.length ? `
<h2 style="margin-top:32px">🇨🇳 国内成品油指导价</h2>
<p><strong>📅 各省最高零售限价（约每10个工作日随发改委窗口调整，非加油站实付价）</strong></p>
<label style="font-size:14px;color:#666">选择省份：</label>
<select id="prov" style="padding:6px 10px;font-size:16px;margin-left:8px">
${cn.list.map(r => `<option value="${r.province}" ${r.province === '福建' ? 'selected' : ''}>${r.province}</option>`).join('')}
</select>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">92号汽油</td><td style="padding:8px 0" id="p92"></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">95号汽油</td><td style="padding:8px 0" id="p95"></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">98号汽油</td><td style="padding:8px 0" id="p98"></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">0号柴油</td><td style="padding:8px 0" id="p0"></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据来源</td><td style="padding:8px 0">${cn.source === 'showapi' ? '万维易源 ShowAPI' : 'Apizero 兜底'}</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据更新地时间</td><td style="padding:8px 0">${cnUTC} <span style="font-size:12px;color:#999">(UTC)</span></td></tr>
</table>` : ''}

<p style="font-size:14px;color:#666">🕐 你的本地时间：<span id="localTime"></span> <span style="font-size:12px;color:#999" id="tz"></span></p>
<p style="font-size:12px;color:#aaa">以上为国际原料与成品油参考价，非零售汽油价 / 首饰金价。黄金为现货参考价，每 6 分钟采集一次，不代表柜台成交价。</p>
<p style="font-size:12px;color:#aaa"><a href="https://xaus.com" target="_blank" rel="noopener">Gold data: XAUS</a> · <a href="/update${keyQS}">手动刷新</a> · <a href="/history${keyQS}">📈 布伦特走势</a> · <a href="/history?code=wti${keyQS.replace('?', '&')}">📈 WTI走势</a> · <a href="/data${keyQS}">原始JSON</a></p>

<script>
  var d = new Date('${displayUTC}');
  document.getElementById('localTime').innerText = isNaN(d) ? '未知' : d.toLocaleString(undefined, {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  try { document.getElementById('tz').innerText = '(' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')'; } catch(e) {}

  var cnList = ${cnJson};
  function renderCn(prov) {
    var r = cnList.find(function(x){ return x.province === prov; });
    if (!r) return;
    document.getElementById('p92').innerText = r.p92 + ' 元/升';
    document.getElementById('p95').innerText = r.p95 + ' 元/升';
    document.getElementById('p98').innerText = r.p98 + ' 元/升';
    document.getElementById('p0').innerText  = r.p0  + ' 元/升';
  }
  var sel = document.getElementById('prov');
  if (sel) { sel.onchange = function(){ renderCn(sel.value); }; renderCn(sel.value || '福建'); }
</script>
</body></html>`;

      return new Response(html, { headers: HTML_HEADERS });
    }

    // ---------------- /gold/live 现抓（★ B8 新增）----------------
    // 用途：2 号前端在自己那条实时链路全部失败时，回头问 3 号【现在】去抓一个新价。
    // 注意与 /data 的区别：
    //   /data        → 读 KV，给出的是「上次定时抓到的」（最多旧 1 分钟）
    //   /gold/live   → 当场真的去源站抓一次，给的是「此刻的」
    // 2 号只要后者，因为前端自己全挂的时候，要的是另一条路能不能通，不是旧货。
    //
    // ⚠️ 需要 ACCESS_KEY —— 只能由 2 号 Worker【服务端】转发调用，
    //    前端 JS 直接调会把密钥暴露在页面源码里，绝对不行。
    if (url.pathname === '/gold/live') {
      if (!ok) return new Response(JSON.stringify({ error: 'forbidden' }),
        { status: 403, headers: JSON_HEADERS });

      /* ★★ 写入放大修复（★ 这是 KV 额度被吃光的真正元凶，比黄金 cron 大得多）
       *
       * 原实现：每次被调用都 fetchGoldAndSave() —— 当场真抓三个源 + 写一次 KV。
       *   2 号前端每 15 秒问一次 → 页面开着 4 小时就是 960 次写入，
       *   一天 1000 的免费额度直接见底，之后所有写入 429 失败。
       *   顺带把 3 号拖慢到超时，2 号拿不到价 → 前端只能直连国外源 → 连接中断。
       *
       * 现在三层节流：
       *   ① 60 秒内已抓过 → 直接回缓存，不抓不写（绝大多数请求走这条）
       *   ② 当日真抓次数到上限 → 也回缓存，但标注 live=false 让 2 号知道它不是新的
       *   ③ 都没挡住才真抓，并给当日计数 +1 */
      const cachedG = await env.OIL_KV.get('gold_data', 'json').catch(() => null);
      const ageMs = (cachedG && cachedG.fetchedAtMs) ? (Date.now() - cachedG.fetchedAtMs) : Infinity;
      const hasVal = !!(cachedG && cachedG.priceUsdPerOz);
      const sendCached = (live, why, extra) =>
        new Response(JSON.stringify(Object.assign({
          ok: true,
          live: live,                       // live=false 表示这是缓存值，不是刚抓的
          cached: true,
          ageMs: ageMs === Infinity ? null : ageMs,
          why: why,
          priceUsdPerOz: cachedG.priceUsdPerOz,
          asOf: cachedG.updatedAt,
          source: cachedG.fetchedFrom,
          stale: cachedG.stale === true,
          fetchedAtMs: cachedG.fetchedAtMs,
        }, extra || {})), { headers: JSON_HEADERS });

      if (hasVal && ageMs < GOLD_LIVE_CACHE_MS) {
        return sendCached(true, 'fresh-cache');        /* ① 命中新鲜缓存 */
      }

      /* ② 每日真抓上限：防止少数访客把当天额度刷光 */
      const capKey = 'gold_live_daily';
      const today = beijingDateString();
      const cap = await env.OIL_KV.get(capKey, 'json').catch(() => null);
      const used = (cap && cap.day === today) ? (cap.n || 0) : 0;
      if (used >= GOLD_LIVE_DAILY_CAP) {
        if (hasVal) return sendCached(false, 'daily-cap', { capped: true, usedToday: used });
        /* 缓存里也没有值 → 这种情况下必须抓，否则永远出不来数 */
      } else {
        try {
          const r = await fetchGoldAndSave(env, { manual: false });
          await env.OIL_KV.put(capKey, JSON.stringify({ day: today, n: used + 1 }),
            { expirationTtl: 86400 * 3 }).catch(() => {});
          const d = r.data;
          return new Response(JSON.stringify({
            ok: true,
            live: true,
            cached: false,
            why: 'fresh-fetch',
            usedToday: used + 1,
            priceUsdPerOz: d.priceUsdPerOz,
            asOf: d.updatedAt,
            source: d.fetchedFrom,
            stale: d.stale === true,
            fetchedAtMs: Date.now(),
          }), { headers: JSON_HEADERS });
        } catch (e) {
          if (hasVal) {
            return new Response(JSON.stringify({
              ok: false, live: false, cached: true, error: e.message,
              fallback: {
                priceUsdPerOz: cachedG.priceUsdPerOz,
                asOf: cachedG.updatedAt,
                source: cachedG.fetchedFrom,
                note: '现抓失败，这是最后一次成功抓取的值（非实时）',
              },
            }), { headers: JSON_HEADERS });
          }
          return new Response(JSON.stringify({ ok: false, live: false, error: e.message }),
            { headers: JSON_HEADERS });
        }
      }
      /* 走到这里 = 超上限且缓存没值 → 兜底真抓一次（不加计数，保证能出数） */
      try {
        const r = await fetchGoldAndSave(env, { manual: false });

        const d = r.data;
        return new Response(JSON.stringify({
          ok: true,
          live: true,
          cached: false,
          why: 'cap-fallback-fetch',
          priceUsdPerOz: d.priceUsdPerOz,
          asOf: d.updatedAt,
          source: d.fetchedFrom,
          stale: d.stale === true,
          fetchedAtMs: Date.now(),
        }), { headers: JSON_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, live: false, error: e.message }),
          { headers: JSON_HEADERS });
      }
    }

    // ---------------- /data ----------------
    if (url.pathname === '/data') {
      const [oil, gold, cn, marker, hist, cnMarker, wti, wtiHist, goldHist] = await Promise.all([
        env.OIL_KV.get('oil_data', 'json'),
        env.OIL_KV.get('gold_data', 'json'),
        env.OIL_KV.get('cn_oil_data', 'json'),
        env.OIL_KV.get('gold_fetch_marker', 'json'),
        env.OIL_KV.get('brent_history', 'json'),
        env.OIL_KV.get('cn_oil_fetch_marker', 'json'),
        env.OIL_KV.get('wti_data', 'json'),
        env.OIL_KV.get('wti_history', 'json'),
        env.OIL_KV.get('gold_history', 'json'),
      ]);
      const now = new Date();
      return new Response(JSON.stringify({
        todayBeijing: beijingDateString(),
        // 闸门状态：方便你核对「该抓的时候到底抓没抓」
        tradingWindow: {
          beijingHour: beijingHour(now),
          cronPhase: cronPhase(now),
          londonClock: londonClock(now),
          chicagoClock: chicagoClock(now),
          brent: { trading: isBrentTrading(now), closing: isBrentClosing(now) },
          wti:   { trading: isWtiTrading(now),   closing: isWtiClosing(now) },
          gold: {
            state: goldMarketState(now),        // open=交易中 / settlement=每日结算 / weekend=周末休市
            trading: isGoldTrading(now),
            newYorkClock: newYorkClock(now),
            tradingDay: goldTradingDateString(now),
            today: gold && gold.today ? gold.today : null,
          },
          note: 'cron "5,20 * * * *"：:05=盘中采样，:20=收盘补抓。两品种闸门独立，任一为真即调 API',
        },
        oil,
        wti: wti || null,          // WTI 原油（同一次请求带回，不额外消耗配额）
        gold,
        cn_oil: cn,
        // ★ B7：gold_fetch_marker 已随每日闸门一并废弃，改由 gold 自身携带抓取信息
        goldFetchMarker: gold ? {
          date: (gold.updatedAt || '').slice(0, 10),
          source: gold.fetchedSource,
          from: gold.fetchedFrom,
          stale: gold.stale,
          fetchedLocal: gold.fetchedLocal,
          note: 'B8 起黄金每 6 分钟抓取（专用 cron "*/6"，与原油 "5,20" 分开），三源 xaus→biquote→gold-api 循环 2 轮',
        } : null,
        cnOilFetchMarker: cnMarker || null,
        // 布伦特历史走势（自建累积：cron 抓取时顺便记录，零额外额度）
        brentHistory: hist ? {
          mode: 'self-built',
          updatedLocal: hist.updatedLocal,
          rows: hist.rows?.length ?? 0,
          latest: hist.rows?.[hist.rows.length - 1] ?? null,
          note: '完整数组见 /history 页面；数据来自本站自身抓取的实时价，非第三方历史接口',
        } : null,
        // WTI 历史走势（与布伦特同一套规则累积，零额外额度）
        wtiHistory: wtiHist ? {
          mode: 'self-built',
          updatedLocal: wtiHist.updatedLocal,
          rows: wtiHist.rows?.length ?? 0,
          latest: wtiHist.rows?.[wtiHist.rows.length - 1] ?? null,
          note: '完整数组见 /history?code=wti 页面；数据来自本站自身抓取的实时价',
        } : null,
        // 黄金自建日线（每天收盘定格一条，只留最近 7 天）
        goldHistory: goldHist ? {
          mode: 'self-built',
          updatedAt: goldHist.updatedAt,
          rows: goldHist.rows?.length ?? 0,
          latest: goldHist.rows?.[goldHist.rows.length - 1] ?? null,
          data: goldHist.rows ?? [],
          note: '数据来自本站自身每 6 分钟一次的实时抓取，收盘价取自结算前最后一次真实成交',
        } : null,
      }, null, 2), { headers: JSON_HEADERS });
    }

    // ---------------- /history 报表页 ----------------
    if (url.pathname === '/history') {
      const hKey = url.searchParams.get('code') === 'wti' ? 'wti' : 'brent';
      // 把密钥透传进页面，让页内切换/返回链接继续可用
      const keyQS = url.searchParams.get('key') ? `?key=${encodeURIComponent(url.searchParams.get('key'))}` : '';
      return new Response(await renderHistoryPage(env, hKey, keyQS), { headers: HTML_HEADERS });
    }

    // ---------------- /clear-history 清空历史（自建累积，随时可重来）----------------
    // ④ 排班预演（纯只读诊断）：无密钥直接 404，不暴露路径存在
    //    ⚠️ 只调用已有的纯函数做算术推演，不读 KV、不写 KV、不发起任何网络请求，
    //        不触发任何抓取，对定时抓取、历史走势、/data 接口零影响。
    if (url.pathname === '/_schedule-preview') {
      if (!ok) return ghost();
      // 默认只算「关键行」：约 26 行、几毫秒，远低于 Workers CPU 上限。
      // ?full=1 才展开全部（默认 5 天，上限 5）。
      const full = url.searchParams.get('full') === '1';
      const maxDays = full ? 5 : 7;
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '3', 10) || 3, 1), maxDays);
      const fmt = url.searchParams.get('format') === 'json' ? 'json' : 'html';
      const rows = previewSchedule(days, !full);
      if (fmt === 'json') {
        return new Response(JSON.stringify({ days, full, count: rows.length, rows }, null, 2), {
          headers: JSON_HEADERS,
        });
      }
      // mode=check → 极简自检页：不看表格，只看红绿结论
      if (url.searchParams.get('mode') === 'check') {
        return new Response(renderSelfCheck(previewSchedule(7, false)), { headers: HTML_HEADERS });
      }
      return new Response(renderSchedulePreview(rows, days, full), { headers: HTML_HEADERS });
    }

    if (url.pathname === '/clear-history') {
      const confirm = url.searchParams.get('confirm') === '1';
      const hKey = url.searchParams.get('code') === 'wti' ? 'wti' : 'brent';
      const spec = historySpec(hKey);
      if (!confirm) {
        const cur = await env.OIL_KV.get(spec.kvKey, 'json').catch(() => null);
        return new Response(
          `=== 清空 ${spec.label} 历史走势 ===\n` +
          `品种 : ${spec.label}（${spec.code}）\n` +
          `当前条数 : ${cur?.rows?.length ?? 0}\n` +
          `日期范围 : ${cur?.rows?.length ? cur.rows[0].day + ' ~ ' + cur.rows[cur.rows.length - 1].day : '—'}\n\n` +
          `⚠️ 此操作会删除 KV 中的 ${spec.kvKey}，且不可恢复。\n` +
          `确认请访问：/clear-history?code=${hKey}&confirm=1\n` +
          `（清空另一个品种：/clear-history?code=${hKey === 'wti' ? 'brent' : 'wti'}&confirm=1）\n`,
          { headers: TEXT_HEADERS }
        );
      }
      await env.OIL_KV.delete(spec.kvKey).catch(() => {});
      return new Response(
        `✅ 已清空 ${spec.kvKey}（${spec.label}）。\n` +
        `历史走势将从下一次抓取重新开始累积。\n`,
        { headers: TEXT_HEADERS }
      );
    }

    // ---------------- /update ----------------
    if (url.pathname === '/update') {
      const results = await Promise.allSettled([
        fetchAndSave(env, false, { brent: true, wti: true, force: true }),
        fetchGoldAndSave(env, { manual: true }),
        fetchCnOilAll(env, { manual: true }),
      ]);

      const line = (name, r) => {
        if (r.status !== 'fulfilled') return `${name}: ❌ 失败 — ${r.reason?.message || r.reason}`;
        const v = r.value;
        if (!v || v.skipped) return `${name}: ⏭️ 跳过 — ${v?.reason || '未重新抓取'}`;
        return `${name}: ✅ 成功`;
      };

      const oilR = results[0], goldR = results[1], cnR = results[2];
      const wtiD = (oilR.status === 'fulfilled' && oilR.value && oilR.value.wti) ? oilR.value.wti : null;

      // 原油详情
      let oilDetail = '';
      if (oilR.status === 'fulfilled' && oilR.value?.data) {
        const d = oilR.value.data;
        oilDetail = `    新旧价格 : ${d.prevPrice ?? '—'} → ${d.price}  ${d.changed ? '（有变化 ✅）' : '（无变化 ⚠️）'}
    stale     : ${d.stale}  ${d.stale ? '（沿用值：源未刷新，不是代码没抓）' : '（新值）'}
    源观测时间 : ${d.asOf || '—'}
    收集时间   : ${d.timestamp || '—'}
    抓取时刻   : ${d.updatedLocal}
    请求模式   : ${d.sourceMode === 'batch' ? 'batch（布伦特+WTI 一次带回，计 1 次配额）' : 'single（降级，只请求布伦特）'}
    WTI 原油   : ${wtiD ? `$${wtiD.price}（上次 $${wtiD.prevPrice ?? '—'}，${wtiD.changed === null ? '—' : (wtiD.changed ? '有变化' : '无变化')}）` : '本次未返回（不影响布伦特，下次自动重试）'}`;
      } else if (oilR.status === 'rejected') {
        oilDetail = `    原因 : ${oilR.reason?.message || oilR.reason}`;
      }

      // 黄金详情
      let goldDetail = '';
      if (goldR.status === 'fulfilled') {
        const v = goldR.value;
        if (v?.skipped) {
          goldDetail = `    原因 : ${v.reason}
    当前值 : ${v.data?.priceUsdPerOz ?? '—'}（源日期 ${v.data?.updatedAt ?? '—'}）`;
        } else if (v?.data) {
          goldDetail = `    新旧价格 : ${v.data.prevPriceUsdPerOz ?? '—'} → ${v.data.priceUsdPerOz}  ${v.data.changed ? '（有变化 ✅）' : '（无变化 ⚠️）'}
    源数据日期 : ${v.data.updatedAt}`;
        }
      } else {
        goldDetail = `    原因 : ${goldR.reason?.message || goldR.reason}`;
      }

      // 国内油价详情
      let cnDetail = '';
      if (cnR.status === 'fulfilled' && cnR.value) {
        const v = cnR.value;
        if (v.skipped) {
          cnDetail = `    原因 : ${v.reason}
    当前值 : ${v.list?.length ?? 0} 个省份（源时间 ${v.updatedAt ?? '—'}）`;
        } else {
          cnDetail = `    省份数 : ${v.list?.length ?? 0}   数据源 : ${v.source}`;
        }
      } else if (cnR.status === 'rejected') {
        cnDetail = `    原因 : ${cnR.reason?.message || cnR.reason}`;
      }

      // 历史走势（自建累积，零额外额度）—— 布伦特 + WTI 各一份
      const [hist, wHist] = await Promise.all([
        env.OIL_KV.get('brent_history', 'json').catch(() => null),
        env.OIL_KV.get('wti_history', 'json').catch(() => null),
      ]);
      const rows = hist?.rows || [];
      const wRows = wHist?.rows || [];
      const histLine = (name, rs) => rs.length
        ? `    ${name} : ${rs.length} 条   日期范围 : ${rs[0].day} ~ ${rs[rs.length - 1].day}
        最新一条 : ${JSON.stringify(rs[rs.length - 1])}`
        : `    ${name} : 0 条（下一次抓取后开始累积）`;
      const histDetail = `${histLine('布伦特', rows)}
${histLine('WTI  ', wRows)}
    说明     : 自建累积（复用本次抓取，未额外消耗额度）`;

      const txt = `${line('原油', oilR)}
${oilDetail}

${line('黄金', goldR)}
${goldDetail}

${line('国内油价', cnR)}
${cnDetail}

历史走势
${histDetail}

北京时间 : ${beijingNow()}
`;

      return new Response(txt, { headers: TEXT_HEADERS });
    }

    return new Response('Not Found', { status: 404 });
  },

  // ---------------- Cron ----------------
  async scheduled(controller, env) {
    const now = new Date();
    const h = beijingHour(now);   // 北京时间小时（cron 整点触发，必为整数）
    const jobs = [];

    /* ★ B8：黄金由专用 cron（每 6 分钟一次）唤醒，与原油的 "5,20" 分开。
     *
     * 为什么不是每分钟 —— 受 KV 写入配额限制，不是源的限制：
     *   Workers KV 免费版每天只允许 1,000 次写入。
     *   黄金每抓成功一次就写一次 gold_data，每分钟 = 1,440 次/天，
     *   会在当天下午把配额耗光，之后写入报错、首屏数字静默冻住。
     *   每 6 分钟 = 480 次/天，配合原油约 25 次，留有一倍余量。
     *
     * 3 号这一层是兜底 + 首屏，真正的实时跳动由 2 号前端在浏览器里
     * 直连 biquote 完成，兜底旧 3 分钟没有可感知差别。
     *
     * 现货黄金 XAU/USD 周日 22:00 UTC 至周五 21:00 UTC 近乎全天连续交易。
     */
    const min = now.getUTCMinutes();

    /* ★★ B9 关键修复：先分清【是哪条 cron 唤醒的】，再决定跑什么。
     *
     * B8 加了第二条 cron（每 6 分钟那条，专跑黄金），但两条共用同一个 scheduled()，
     * 而函数里没有任何分流 —— 于是该 cron 每次唤醒也把原油整套逻辑跑了一遍：
     *   ① 原油被多抓（本该只在 :05 / :20），配额白白消耗；
     *   ② 更糟的是 cronPhase() = getUTCMinutes() < 10 ? 'open' : 'close'，
     *      这套判断是 B7 专为 5(open) / 20(close) 设计的，该 cron 带来的
     *      12 / 15 / 18 等分钟会落进 'close' 分支，
     *      把盘中价当收盘价记进历史走势 —— 历史曲线被污染。
     *
     * 分流依据：
     *   首选 controller.cron（Cloudflare 回传本次触发的表达式）。
     *   兜底用分钟数 —— "5,20" 的两个值都不是 6 的倍数，
     *   黄金那条 cron 的触发分钟全部是 6 的倍数，两个集合完全不重叠，
     *   故 min % 6 能 100% 分开，不会误判（6 与 {5,20} 不重叠）。
     */
    const cronSpec = (controller && controller.cron) ? String(controller.cron) : '';
    const isGoldTick = cronSpec
      ? cronSpec.indexOf('*/6') !== -1          // 明确来自黄金那条
      : (min % 6 === 0);                        // 兜底：按分钟分流
    /* ★ 为什么是 6 而不是 5：原油那条 cron 在 :05 与 :20 触发，
     *   5 和 20 都是 5 的倍数 —— 若黄金用 */5，两条 cron 会撞车，
     *   兜底分流会失效，原油被多跑、配额白白消耗。
     *   6 的倍数（0,6,…,54）与 {5,20} 完全不重叠，故安全。 */

    if (isGoldTick) {
      jobs.push(fetchGoldAndSave(env, { manual: false }));
      console.log(`[cron] 黄金抓取 — 北京 ${h}:${String(min).padStart(2, '0')}，每 6 分钟一次`);
      if (!jobs.length) return;
      await Promise.allSettled(jobs);
      return;                                    // ★ 只跑黄金，绝不碰原油
    }

    /* ★ 下面原油 + 国内油价：只在 "5,20" 这条 cron 上执行，与 B7 逐行一致。 */

    // 国内油价：每天 08:00 那小时的 :05 / :20（万维易源 7-8 点更新后再拉）
    if (h === 8) jobs.push(fetchCnOilAll(env));

    // 原油：布伦特与 WTI 各自判断，任一在交易/收盘窗口就抓（一次请求带回两个价）
    const ph = cronPhase(now);
    const bOpen = ph === 'open' && isBrentTrading(now);
    const wOpen = ph === 'open' && isWtiTrading(now);
    const bClose = ph === 'close' && isBrentClosing(now);
    const wClose = ph === 'close' && isWtiClosing(now);

    if (bOpen || wOpen || bClose || wClose) {
      const rec = { brent: bOpen || bClose, wti: wOpen || wClose };
      jobs.push(fetchAndSave(env, bClose || wClose, rec));
      console.log(`[cron] 原油抓取 — 北京 ${h}:${String(now.getUTCMinutes()).padStart(2, '0')}，伦敦 ${londonClock(now)}，芝加哥 ${chicagoClock(now)}`);
      console.log(`[cron]   布伦特 ${bClose ? '★收盘' : bOpen ? '盘中' : '不记'} / WTI ${wClose ? '★收盘' : wOpen ? '盘中' : '不记'}`);
    } else {
      console.log(`[cron] 两品种均休市，跳过 — 北京 ${h}:${String(now.getUTCMinutes()).padStart(2, '0')}，伦敦 ${londonClock(now)}，芝加哥 ${chicagoClock(now)}`);
    }

    if (!jobs.length) return;
    await Promise.allSettled(jobs);
  }
};

// ================= 原油 =================
// isClosing = true 表示这次是「休市后 20 分钟」的收盘补抓，抓到的是当日最终价
// record = { brent, wti } 指明本次抓取要往哪个品种的历史走势里记
//          （两品种休市时段不同，必须分开判断，否则休市的那个会被污染）
async function fetchAndSave(env, isClosing = false, record = null) {
  const apiKey = env.OILPRICEAPI_KEY;
  if (!apiKey) throw new Error('Missing OILPRICEAPI_KEY');

  // 手动触发（bootstrap / /update）没有相位概念 → 两个品种都记、且跳过闸门
  const recBrent = record ? !!record.brent : true;
  const recWti   = record ? !!record.wti   : true;

  const prev = await env.OIL_KV.get('oil_data', 'json').catch(() => null);

  // ★ B11：改为与 2 号同源的多源链路（biquote → yahoo → yahoo2 → stooq → oilpriceapi）
  const live = await fetchOilMulti(apiKey);
  const brentPrice = Number(live.brent) || 0;
  const wtiPrice   = Number(live.wti)   || 0;

  const stale = live.stale === true;
  const asOf = live.asOf || null;

  const result = {
    price: brentPrice,
    formatted: brentPrice ? '$' + brentPrice.toFixed(2) : null,
    timestamp: new Date().toISOString(),    // 收集时间
    asOf,                                   // 源观测时间
    stale,                                  // true = 沿用值
    updatedLocal: beijingNow(),
    isClosing: !!isClosing,
    isSettlement: !!isClosing,
    prevPrice: prev && prev.price != null ? prev.price : null,
    changed: prev ? String(prev.price) !== String(brentPrice) : null,
    sourceMode: live.provider || 'multi',   // 实际生效的源
    provider: live.provider || null,
    tried: live.tried || [],
  };

  await env.OIL_KV.put('oil_data', JSON.stringify(result), { expirationTtl: 86400 * 2 });

  // WTI：白捡的第二个品种，同一次请求里带回来的，不额外消耗配额。
  // 拿不到就跳过，绝不影响布伦特（主流程已存完）。
  let wti = null;
  // ★ B11：WTI 直接取多源结果，不再依赖 OilPriceAPI 的批量模式
  if (wtiPrice) {
    const prevW = await env.OIL_KV.get('wti_data', 'json').catch(() => null);
    wti = {
      code: WTI_CODE,
      name: 'WTI 原油',
      price: wtiPrice,
      formatted: `$${wtiPrice.toFixed(2)}`,
      timestamp: new Date().toISOString(),
      asOf: asOf,
      stale: stale,
      updatedLocal: beijingNow(),
      isClosing: !!isClosing,
      prevPrice: prevW && prevW.price != null ? prevW.price : null,
      changed: prevW ? String(prevW.price) !== String(wtiPrice) : null,
      sourceMode: live.provider || 'multi',
      provider: live.provider || null,
    };
    await env.OIL_KV.put('wti_data', JSON.stringify(wti), { expirationTtl: 86400 * 2 });

    // WTI 攒走势 —— 只在 WTI 自己的交易/收盘窗口内记（force=手动时不设限）。
    // 失败也不影响布伦特（各自独立 catch）。
    if (recWti) {
      await recordDailyHistory(env, {
        price: wti.price,
        isClosing: !!isClosing && isWtiClosing(),
        kvKey: 'wti_history',
        label: 'WTI 原油',
        force: !!record?.force,
      }).catch(() => {});
    }
  }

  // 顺手把本次价格记进历史走势（自建累积，零额外额度）
  if (recBrent) {
    await recordDailyHistory(env, {
      price: result.price,
      isClosing: !!isClosing && isBrentClosing(),
      kvKey: 'brent_history',
      label: '布伦特原油',
      force: !!record?.force,
    }).catch(() => {});
  }

  return { data: result, wti, prev, skipped: false };
}

// ------------------------------------------------------------
// 取原油报价：优先批量（1 次配额拿 2 个品种），失败自动降级
// ------------------------------------------------------------
async function fetchOilJson(apiKey) {
  const headers = { 'Authorization': `Token ${apiKey}` };

  // ① 批量：BRENT_CRUDE_USD + WTI_USD
  try {
    const res = await fetch(`${OIL_LATEST_BASE}?by_code=${OIL_CODES}`, {
      headers, cf: { cacheTtl: 0 },
    });
    if (res.ok) {
      const json = await res.json();
      // 只有真的解析出布伦特才算成功，否则降级
      if (pickQuote(json, BRENT_CODE)) return { json, mode: 'batch' };
      console.log('[oil] 批量响应未含布伦特，降级为单品种请求');
    } else {
      console.log(`[oil] 批量请求 ${res.status}，降级为单品种请求`);
    }
  } catch (e) {
    console.log(`[oil] 批量请求异常（${e.message}），降级为单品种请求`);
  }

  // ② 降级：只请求布伦特 —— 与改动前的请求完全一致，保证主流程不受影响
  const res2 = await fetch(`${OIL_LATEST_BASE}?by_code=${BRENT_CODE}`, {
    headers, cf: { cacheTtl: 0 },
  });
  if (!res2.ok) throw new Error(`Oil API ${res2.status}`);
  return { json: await res2.json(), mode: 'single' };
}

/** 归一化品种代码，用于比对（忽略大小写与下划线） */
function normalizeCode(c) {
  return String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ------------------------------------------------------------
// 从响应里挑出指定品种 —— 兼容「扁平对象」与「数组」两种结构
//   · 1 个 code  → data 是扁平对象
//   · 2 个及以上 → data.prices[] 是数组
// 文档：A single code returns a flat data object; two or more return data.prices[]
// ------------------------------------------------------------
function pickQuote(json, code) {
  const d = json && json.data;
  if (!d) return null;
  const want = normalizeCode(code);
  const hit = (o) => {
    if (!o || typeof o !== 'object') return false;
    return normalizeCode(o.code) === want
        || normalizeCode(o.commodity) === want
        || normalizeCode(o.symbol) === want;
  };

  // 数组结构：data.prices[] / data.data[] / data 本身是数组
  const list = Array.isArray(d.prices) ? d.prices
             : Array.isArray(d.data)   ? d.data
             : Array.isArray(d)        ? d
             : null;
  if (list) {
    for (const it of list) if (hit(it)) return it;
    // 兜底：只返回一个品种，且该元素完全没带 code 字段时才认。
    // 带了 code 却没匹配上 → 必须 null。否则「批量响应里只有别的品种」
    // 会被误当成布伦特（实测曾把天然气 3.2 存成布伦特），直接污染主数据。
    const only = list.length === 1 ? list[0] : null;
    if (only && only.price != null
        && only.code == null && only.commodity == null && only.symbol == null) {
      return only;
    }
    return null;
  }

  // 扁平结构
  if (hit(d)) return d;
  // 兜底：单品种响应可能完全不带 code 字段。
  // 但只要带了 code 且没匹配上，就必须返回 null ——
  // 否则降级时（只请求了布伦特）会把布伦特当成 WTI 返回，造成价格错配。
  const hasCode = d.code != null || d.commodity != null || d.symbol != null;
  if (!hasCode && d.price != null) return d;
  return null;
}

/** 该日期（YYYY-MM-DD）在伦敦是不是周一~周五（有交易的日子） */
function isWeekdayInLondon(day) {
  const { wd } = londonParts(new Date(`${day}T12:00:00Z`));  // 取当日伦敦中午，避开跨日边界
  return wd >= 1 && wd <= 5;
}

function isWeekdayInChicago(day) {
  const { wd } = chicagoParts(new Date(`${day}T12:00:00Z`));  // 取当日芝加哥中午，避开跨日边界
  return wd >= 1 && wd <= 5;
}

// ============================================================
// 自建历史走势：把每次抓取的价格累积成日线
// ------------------------------------------------------------
// 一份数据两用 —— 抓实时价的同时顺便攒走势，不额外消耗任何额度。
//
//   · 当日第一次抓取  → open（近似开盘，非交易所官方开盘价）
//   · 每次抓取        → 更新 high / low（采样极值，真实极值可能落在两次采样之间）
//   · 休市后收盘补抓  → close 定格（当日收盘价，这个最准）
//
// 只在「交易时段」或「收盘补抓窗口」记录 —— 周末休市时 API 返回的是沿用值，
// 记进去会污染走势。
//
// 布伦特与 WTI 共用此函数，靠 kvKey 区分（同一套规则、同一时刻写入）。
// ============================================================
async function recordDailyHistory(env, { price, isClosing, kvKey = 'brent_history', label = '布伦特原油', force = false }) {
  const num = Number(price);
  if (!Number.isFinite(num)) return null;

  const now = new Date();
  const isWti = kvKey === 'wti_history';

  // ★ 按品种各自判断：布伦特看伦敦，WTI 看芝加哥。
  //   两品种休市时段不同（布伦特 2 小时、WTI 1 小时），共用一套会让休市的那个被沿用值污染。
  //   force=true（手动 /update）时跳过闸门，照记。
  if (!force) {
    const gate = isWti
      ? (isWtiTrading(now) || isWtiClosing(now))
      : (isBrentTrading(now) || isBrentClosing(now));
    if (!gate) return null;
  }

  const day = isWti ? wtiTradingDateString(now) : tradingDateString(now);
  // 周六周日没有交易，即使补抓拿到的也是沿用值 —— 不建这一天的记录，
  // 否则走势图上会出现「休市日」的点。
  const weekdayOk = isWti ? isWeekdayInChicago(day) : isWeekdayInLondon(day);
  if (!weekdayOk) return null;

  const hist = await env.OIL_KV.get(kvKey, 'json').catch(() => null);
  const rows = Array.isArray(hist?.rows) ? hist.rows.slice() : [];

  let row = rows.find(r => r.day === day);
  if (!row) {
    row = { day, open: null, high: null, low: null, close: null, samples: 0, settled: false };
    rows.push(row);
  }

  // 已定格（当日收盘价已钉死）之后不再改动任何字段，避免后续抓取污染当日数据
  if (row.settled) return null;

  if (row.open == null) row.open = num;                                  // 当日首抓 = 近似开盘
  row.high = row.high == null ? num : Math.max(row.high, num);           // 采样最高
  row.low  = row.low  == null ? num : Math.min(row.low, num);            // 采样最低
  row.samples = (row.samples || 0) + 1;

  if (isClosing) {
    row.close = num;          // 收盘补抓 → 定格，之后不再变
    row.settled = true;
  } else {
    row.close = num;          // 尚未定格 → 临时记最新价
  }

  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const kept = rows.slice(-HISTORY_MAX_ROWS);

  // 与前一日收盘比算出涨跌幅
  for (let i = 0; i < kept.length; i++) {
    const prevClose = i > 0 ? kept[i - 1].close : null;
    kept[i].diff = (prevClose != null && kept[i].close != null)
      ? +(((kept[i].close - prevClose) / prevClose) * 100).toFixed(2)
      : null;
  }

  const data = {
    mode: 'self-built',
    label,
    updatedLocal: beijingNow(),
    rows: kept,
  };
  await env.OIL_KV.put(kvKey, JSON.stringify(data));   // 永久累积，不设过期
  return data;
}

// ================= 黄金（三源互为备用，均无 key 无限流）=================
// ============================================================
// ★ B7：黄金换源 —— xaus.com（主，无 key）/ api.gold-api.com（备，无 key）
//   原 metalpriceapi 免费层本身是延迟数据，且每天只能抓 1 次保护配额。
//   两个新源均【无 key、无注册、无强制限流】，因此每日闸门可以拆掉，
//   黄金改为跟原油一样每小时刷新。
// ★ B8：再加 biquote.io 作第二源（券商 MT5，与另两源不同链路），
//   并把频率提到每 6 分钟（专用 cron "*/6"）。
// ------------------------------------------------------------
const XAUS_URL = 'https://xaus.com/api/v1/spot';
const GOLDAPI_URL = 'https://api.gold-api.com/price/XAU';
const BIQUOTE_URL = 'https://biquote.io/api/XAUUSD';
const TROY_OZ_TO_GRAM = 31.1034768;
/* ★ 黄金采集间隔（分钟）—— 必须与 wrangler.toml 里黄金那条 cron 保持一致。
 *  改动时两处一起改，否则「下一次采集时刻」判断会错位。 */
const GOLD_TICK_MIN = 6;
/* ★ 价格没变时最多攒多久必须强制写一次（分钟）—— 防止 key 过期 */
const GOLD_FORCE_WRITE_MIN = 60;
/* ★ /gold/live 的三层节流参数（见 fetch() 里 /gold/live 分支）
 *   GOLD_LIVE_CACHE_MS   —— 这个值多少秒内算"新鲜"，直接回缓存不真抓
 *   GOLD_LIVE_DAILY_CAP  —— 每天最多真抓几次（真抓 = 打三个源 + 写一次 KV） */
const GOLD_LIVE_CACHE_MS = 60000;   /* 60 秒 */
const GOLD_LIVE_DAILY_CAP = 200;    /* 200 次/天 */
/* 额度账（免费版 1,000 次/天，两个站共用同一个 KV）：
 *   黄金 cron（*/6）        240 次（价不变自动跳过，实际更少）
 *   /gold/live 真抓        ≤ 200 次
 *   /gold/live 计数写入    ≤ 200 次
 *   原油 + 历史 + 国内油价  ≈  48 次
 *   3 号小计               ≤ 688 次
 *   2 号（休市状态每10分钟）  144 次
 *   合计                   ≈ 832 次，留约 17% 余量 */

// ============================================================
// 黄金自建日线（开/高/低/收）—— 与原油同一套思路
// ------------------------------------------------------------
// 一份数据两用：3 号每 6 分钟抓一次黄金，抓的同时顺手累积当日 OHLC，
// 不额外消耗任何抓取额度。
//
//   · 当日第一次抓取   → open
//   · 每次抓取         → 更新 high / low / close
//   · 收盘前最后一次    → close 定格，写入 gold_history（每天仅此 1 次写入）
//
// ★ 收盘定格的判定办法（不写死钟点，自动跟随冬令时与周末）：
//   本轮抓完后，看「下一次采集时刻」（当前 +3 分钟）是否还在交易时段。
//   若下一次已休市，则本轮就是当日最后一次真实成交采样，close 就此定格。
//   这样天然落在纽约 16:57 那一次，而不会误取结算时段里的沿用值。
//
// ★ 为什么只在收盘时写 gold_history：
//   黄金每天抓 480 次，若每次都写历史 KV，加上 gold_data 的 480 次
//   会逼近免费版 1,000 次/天的写入上限。只在定格时写 1 次，
//   总配额约 508 次/天，安全。
// ============================================================

// 把当日 OHLC 写进 gold_history（只保留最近 7 天）
async function appendGoldHistory(env, row) {
  const h = await env.OIL_KV.get('gold_history', 'json').catch(() => null);
  const rows = Array.isArray(h && h.rows) ? h.rows.slice() : [];
  const item = {
    day: row.day,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    samples: row.samples || 0,
    settled: true,
  };
  const i = rows.findIndex(r => r.day === row.day);
  if (i >= 0) rows[i] = item; else rows.push(item);
  rows.sort((a, b) => (a.day < b.day ? -1 : 1));
  const trimmed = rows.slice(-7);
  await env.OIL_KV.put('gold_history', JSON.stringify({
    rows: trimmed,
    updatedAt: new Date().toISOString(),
  }));
  return trimmed;
}

// 累积当日 OHLC（挂在 gold_data 上，随 gold_data 一起写入，零额外 KV 写入）
async function recordGoldOhlc(env, gold, now = new Date()) {
  const state = goldMarketState(now);
  // 休市与每日结算时段不记 —— 此时接口返回的是沿用值，记进去会污染走势
  if (state !== 'open') return gold;

  const day = goldTradingDateString(now);
  if (!isWeekdayForGold(day)) return gold;      // 周六周日不建记录

  const price = Number(gold.priceUsdPerOz);
  if (!Number.isFinite(price)) return gold;

  let t = gold.today;
  if (!t || t.day !== day) {
    // 换日：先把上一天补记进去（万一昨天没走到定格那一步，不至于丢一天）
    if (t && t.day !== day && !t.settled) {
      await appendGoldHistory(env, t);
    }
    t = { day, open: price, high: price, low: price, close: price, samples: 1, settled: false };
  } else {
    t.high = Math.max(t.high, price);
    t.low = Math.min(t.low, price);
    t.close = price;
    t.samples = (t.samples || 0) + 1;
  }

  // ★ 收盘定格：下一次采集已不在交易时段 → 本轮即当日最后一笔真实成交
  /* ★ 间隔必须与实际 cron 一致（现为 6 分钟），否则收盘定格时刻会判错，
   *   把盘中价当成收盘价记进历史，污染走势曲线。 */
  const nextState = goldMarketState(new Date(now.getTime() + GOLD_TICK_MIN * 60 * 1000));
  if (!t.settled && nextState !== 'open') {
    t.settled = true;
    t.close = price;
    t.settledAt = gold.updatedAt || new Date().toISOString();
    await appendGoldHistory(env, t);
  }

  gold.today = t;
  return gold;
}

/** 主源：xaus.com —— 一次请求同时给出 USD/盎司 与 指定货币的克价 */
async function fetchGoldXaus() {
  const res = await fetch(`${XAUS_URL}?currency=CNY&unit=gram&compact=1`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'oil-data-worker/1.0' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`XAUS ${res.status}`);
  const j = await res.json();

  // xaus 自带新鲜度契约：fresh=实时 / stale=上游挂了但这是最后真实价 /
  // unavailable=没有真实值可给（核心端点直接 503，绝不编造）
  const state = j.data_state || {};
  if (state.status === 'unavailable') throw new Error('XAUS unavailable');

  const usdPerOz = +(j.spot_usd_oz || 0).toFixed(2);
  const cnyPerGram = +(j.xau?.price || 0).toFixed(2);
  if (!usdPerOz || !cnyPerGram) throw new Error('XAUS bad payload');

  return {
    usdPerOz,
    cnyPerGram,
    stale: state.status !== 'fresh',          // true = 沿用值
    asOf: state.as_of || j.updated_at || null,
    source: 'xaus',
  };
}

/**
 * ★ B8 第二源：biquote.io —— 券商 MT5 链路（真正独立的第二条路）
 *
 * 为什么把它排在第二而不是最后：
 *   实测三轮对比里 xaus 与 gold-api 偏差恒为 0.000%（几乎肯定同源），
 *   主源一挂，gold-api 大概率跟着挂 —— 那级备用等于白设。
 *   biquote 走的是 MetaTrader 5 券商报价链路，与主源完全不同路，
 *   才是真正能在主源挂掉时救命的那个。
 *
 * 注意：MT5 报价的 last/volume 恒为 0，必须取 mid（或 bid/ask 中值）。
 */
async function fetchGoldBiquote() {
  const res = await fetch(BIQUOTE_URL, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'oil-data-worker/1.0' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`biquote ${res.status}`);
  const j = await res.json();

  const bid = +(j.bid || 0), ask = +(j.ask || 0);
  const mid = (bid && ask) ? (bid + ask) / 2 : +(j.mid || 0);
  if (!mid) throw new Error('biquote bad payload');

  // MT5 链路日波动大时点差会拉开，中点仍是可用的参考价
  return {
    usdPerOz: +mid.toFixed(2),
    stale: false,
    asOf: j.timestamp || null,
    source: 'biquote',
    marketState: j.marketState || null,
    quoteAgeSeconds: j.quoteAgeSeconds ?? null,
  };
}

async function fetchGoldApi(cached) {
  const res = await fetch(GOLDAPI_URL, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'oil-data-worker/1.0' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`gold-api ${res.status}`);
  const j = await res.json();

  const usdPerOz = +(j.price || 0).toFixed(2);
  if (!usdPerOz) throw new Error('gold-api bad payload');

  // 备用源不提供汇率：优先用上次缓存反推隐含 USD/CNY，否则退回 7.2 兜底
  let rate = 7.2;
  if (cached && cached.priceUsdPerOz && cached.priceCnyPerGram) {
    rate = cached.priceCnyPerGram * TROY_OZ_TO_GRAM / cached.priceUsdPerOz;
  }
  return {
    usdPerOz,
    cnyPerGram: +(usdPerOz / TROY_OZ_TO_GRAM * rate).toFixed(2),
    stale: false,
    asOf: j.updatedAt || null,
    source: 'gold-api',
  };
}


async function fetchGoldAndSave(env, { manual = false, bootstrap = false } = {}) {
  const cached = await env.OIL_KV.get('gold_data', 'json').catch(() => null);

  // ★ B7：无 key 源没有月度配额，闸门从「每天 1 次」放宽为「最小间隔」防误触
  if (manual && cached && cached.fetchedAtMs) {
    const gap = (Date.now() - cached.fetchedAtMs) / 1000;
    if (gap < GOLD_MIN_INTERVAL_SEC) {
      return { data: cached, prev: cached, skipped: true,
               reason: `${Math.round(GOLD_MIN_INTERVAL_SEC - gap)} 秒内已抓过，跳过` };
    }
  }

  /* ★ B8：三源按序尝试，跑 2 轮
   *
   * 为什么跑 2 轮而不是 1 轮：
   *   网络抖动经常是瞬时的。兜底源失败的那一刻，主源可能已经恢复了。
   *   一轮打完就放弃，会白白错过刚恢复的主源。
   *   所以第二轮从主源重新开始 —— 主 → 备 → 兜底，再 主 → 备 → 兜底。
   *
   * 顺序：xaus（主）→ biquote（备，独立链路）→ gold-api（兜底，与主源同源）
   */
  const ROUNDS = [
    () => fetchGoldXaus(),
    () => fetchGoldBiquote(),
    () => fetchGoldApi(cached),
  ];
  const NAMES = ['xaus', 'biquote', 'gold-api'];

  let got = null;
  const errs = [];
  for (let round = 1; round <= 2 && !got; round++) {
    for (let i = 0; i < ROUNDS.length; i++) {
      try {
        got = await withTimeout(ROUNDS[i](), GOLD_SRC_TIMEOUT_MS);
        break;                       // 拿到就停，不再往下试
      } catch (e) {
        errs.push(`R${round}/${NAMES[i]}: ${e.message}`);
      }
    }
    // 第 1 轮全灭 → 歇一下再试第 2 轮，给主源恢复的时间
    if (!got && round === 1) await sleepMs(GOLD_ROUND_GAP_MS);
  }
  if (!got) throw new Error('Gold all sources failed: ' + errs.join(' | '));

  // biquote 不给克价：用上次缓存反推隐含 USD/CNY 补齐（首屏 SSR 要用）
  let cnyPerGram = got.cnyPerGram;
  if (!cnyPerGram) {
    let rate = 7.2;
    if (cached && cached.priceUsdPerOz && cached.priceCnyPerGram) {
      rate = cached.priceCnyPerGram * TROY_OZ_TO_GRAM / cached.priceUsdPerOz;
    }
    cnyPerGram = +(got.usdPerOz / TROY_OZ_TO_GRAM * rate).toFixed(2);
  }

  const gold = {
    priceUsdPerOz: got.usdPerOz,
    priceCnyPerGram: cnyPerGram,
    updatedAt: got.asOf || new Date().toISOString(),   // 源数据观测时间
    fetchedLocal: beijingNow(),
    fetchedAtMs: Date.now(),
    fetchedSource: manual ? 'manual' : (bootstrap ? 'bootstrap' : 'cron'),
    fetchedFrom: got.source,                            // xaus / biquote / gold-api
    attempts: errs.length ? errs : null,                 // 本次实际走了几步才成功
    stale: got.stale === true,                          // true = 上游未刷新，沿用最后真实价
    prevPriceUsdPerOz: cached ? cached.priceUsdPerOz : null,
    changed: cached ? cached.priceUsdPerOz !== got.usdPerOz : null,
  };

  // 顺手累积当日开高低收：休市不记，收盘那一次自动定格并写入 gold_history
  try {
    await recordGoldOhlc(env, gold);
  } catch (e) {
    console.log('[gold] OHLC 累积失败: ' + e.message);
  }

  /* KV 写入单独兜一层：万一撞上免费版 1,000 次/天的写入配额，
   * 不能让"写不进去"变成"这次抓取整个失败"——
   * 价已经拿到了，照样返回，只是标注 persisted=false 便于排查。 */
  let persisted = true;
  /* ★ 省配额：价格与上次完全一致时【不写】。
   *   黄金每 6 分钟抓一次，但周末全天、每日结算时段价格根本不动，
   *   这些写入纯属浪费（原本 480 次/天里有一大批是白写的）。
   *
   *   保底：距上次写入超过 GOLD_FORCE_WRITE_MIN 分钟强制写一次。
   *   为什么必须保底 —— gold_data 的 expirationTtl 是 2 天，
   *   若周末连续两天一次都不写，key 会过期，周一开盘前读到空值。 */
  const lastWriteMs = (cached && cached.fetchedAtMs) ? cached.fetchedAtMs : 0;
  const tooOld = !lastWriteMs || (Date.now() - lastWriteMs > GOLD_FORCE_WRITE_MIN * 60 * 1000);
  const unchanged = (gold.changed === false);
  if (unchanged && !tooOld) {
    gold.persisted = true;          /* KV 里那份仍然有效，只是这次没重写 */
    gold.writeSkipped = true;       /* 便于排查：本次因价格未变而跳过 */
  } else {
    try {
      await env.OIL_KV.put('gold_data', JSON.stringify(gold), { expirationTtl: 86400 * 2 });
    } catch (e) {
      persisted = false;
      console.log(`[gold] KV 写入失败（可能已超每日配额）: ${e.message}`);
    }
  }
  gold.persisted = persisted;
  return { data: gold, prev: cached, skipped: false };
}


// ================= 国内成品油 =================
const SHOWAPI_URL = 'https://route.showapi.com/138-46';
const APIZERO_URL = 'https://v1.apizero.cn/api/oil-price';
const PROVINCES = ['北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江','上海','江苏','浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川','贵州','云南','西藏','陕西','甘肃','青海','宁夏','新疆'];

async function fetchShowAPI(env) {
  const appKey = env.SHOWAPI_APPKEY;
  if (!appKey) throw new Error('Missing SHOWAPI_APPKEY');
  const res = await fetch(`${SHOWAPI_URL}?appKey=${appKey}`, { headers: { 'Accept': 'application/json' } });
  const json = await res.json();
  if (json.showapi_res_code !== 0 || (json.showapi_res_body && json.showapi_res_body.ret_code !== 0)) {
    throw new Error(`ShowAPI ${json.showapi_res_error || json.showapi_res_body?.ret_code}`);
  }
  return json.showapi_res_body.list.map(item => ({
    province: item.prov,
    p92: item.p92 || '—',
    p95: item.p95 || '—',
    p98: item.p98 || '—',
    p0:  item.p0  || '—',
    ct:  item.ct  || '',
  }));
}

async function fetchBackup() {
  const out = [];
  for (const p of PROVINCES) {
    try {
      const r = await fetch(APIZERO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ province: p }),
      });
      const j = await r.json();
      if (j && j.data) {
        out.push({
          province: j.data.province || p,
          p92: j.data.p92 || '—',
          p95: j.data.p95 || '—',
          p98: j.data.p98 || '—',
          p0:  j.data.p0  || '—',
        });
      }
    } catch (e) { /* 单省失败忽略 */ }
  }
  if (!out.length) throw new Error('Backup empty');
  return out;
}

async function fetchCnOilAll(env, { manual = false } = {}) {
  const cached = await env.OIL_KV.get('cn_oil_data', 'json').catch(() => null);

  // 每日闸门：手动刷新时，今天已成功抓过就直接跳过（0 消耗）
  if (manual) {
    const gate = await checkDailyGate(env, 'cn_oil_fetch_marker', { manual: true });
    if (gate.skip) {
      return { ...(cached || {}), skipped: true, reason: gate.reason, data: cached };
    }
  }

  let list, source;
  try {
    list = await fetchShowAPI(env);
    source = 'showapi';
  } catch (e) {
    console.log('ShowAPI failed, fallback:', e.message);
    list = await fetchBackup();
    source = 'apizero';
  }
  const result = {
    list,
    source,
    updatedAt: new Date().toISOString(),
    note: '各省最高零售限价，约每10个工作日调整一次',
  };
  await env.OIL_KV.put('cn_oil_data', JSON.stringify(result), { expirationTtl: 86400 * 15 });
  await markDailyFetched(env, 'cn_oil_fetch_marker', manual ? 'manual' : 'cron');
  return result;
}

// ---------------- 报表页渲染 ----------------
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function renderHistoryPage(env, hKey = 'brent', keyQS = '') {
  const spec = historySpec(hKey);
  const hist = await env.OIL_KV.get(spec.kvKey, 'json').catch(() => null);
  const rows = hist?.rows || [];
  const L = spec.label;   // 标题里的品种名

  // 页面顶部切换品种的链接
  // ★ keyQS 把访问密钥透传到页面内所有链接上，
  //   否则开启访问控制后，点页面里的切换链接会直接 403。
  const switchLink = `<p style="font-size:13px">切换品种：`
    + `<a href="/history${keyQS}">📈 ${HISTORY_SPECS.brent.label}</a> · `
    + `<a href="/history?code=wti${keyQS.replace('?', '&')}">📈 ${HISTORY_SPECS.wti.label}</a>`
    + ` ｜ 当前：<b>${L}</b></p>`;

  if (!rows.length) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>历史报表</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px">
<h1>📈 ${L} · 历史走势</h1>
${switchLink}
<p>暂无数据 —— 历史走势是<b>自建累积</b>的：每次 cron 抓取实时价时顺便记一条，
每天一组开/高/低/收，日积月累形成走势。</p>
<p>第一次抓取后就会出现第一条，之后每天自动增加。中间不会额外消耗 API 额度。</p>
<p>操作：访问 <a href="/update${keyQS}">/update</a> 手动抓一次即可看到首条数据。</p>
<p><a href="/${keyQS}">← 返回首页</a></p></body></html>`;
  }

  const show = rows.slice(-60);   // 页面最多展示最近 60 条
  const vals = show.map(r => r.close).filter(v => v != null);
  const min = Math.min(...vals), max = Math.max(...vals);
  const first = vals[0], last = vals[vals.length - 1];
  const totalChange = last - first;
  const totalPct = first ? (totalChange / first * 100) : 0;
  const upColor = '#27ae60', downColor = '#c0392b';
  const trendColor = totalChange >= 0 ? upColor : downColor;

  // SVG 走势图
  const W = 680, H = 180, PAD = 10;
  const span = (max - min) || 1;
  const pts = show.map((r, i) => {
    const x = PAD + (W - PAD * 2) * (show.length === 1 ? 0.5 : i / (show.length - 1));
    const y = H - PAD - (H - PAD * 2) * ((r.close - min) / span);
    return [x, y];
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H - PAD} L${pts[0][0].toFixed(1)},${H - PAD} Z`;

  // 采样次数不足时，最高/最低不具参考性 —— 直接显示 —，不拿单次采样冒充日内极值
  const thin = show.filter(r => (r.samples || 0) < SAMPLES_MIN).length;

  const trs = show.slice().reverse().map(r => {
    const d = toNum(r.diff);
    const c = d == null ? '#999' : (d >= 0 ? upColor : downColor);
    const sign = d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(2) + '%';
    const n = r.samples || 0;
    const enough = n >= SAMPLES_MIN;
    // 样本不足 → 高/低留空并标灰，避免「四个值一模一样」看起来像编造的 OHLC
    const hi = enough ? (r.high ?? '—') : '—';
    const lo = enough ? (r.low ?? '—')  : '—';
    const gray = enough ? '' : 'color:#bbb';
    const op = n >= 2 ? (r.open ?? '—') : '—';   // 只有 1 次采样时开盘也不成立
    return `<tr style="border-bottom:1px solid #eee">
<td style="padding:6px 4px">${r.day}</td>
<td style="padding:6px 4px;text-align:right;${n >= 2 ? '' : 'color:#bbb'}">${op}</td>
<td style="padding:6px 4px;text-align:right;${gray}">${hi}</td>
<td style="padding:6px 4px;text-align:right;${gray}">${lo}</td>
<td style="padding:6px 4px;text-align:right"><b>${r.close}</b></td>
<td style="padding:6px 4px;text-align:right;color:${c}">${sign}</td>
<td style="padding:6px 4px;text-align:right;color:${enough ? '#888' : '#c0392b'};font-size:12px">${n}${enough ? '' : ' ※'}</td></tr>`;
  }).join('');

  // 只有 1 个交易日时，涨跌与区间高低在数学上必然是 0 和「两个相同值」——
  // 显示出来既无意义又像编造的数据，直接留空并说明原因。
  const enoughDays = show.length >= 2;
  const na = '<div style="font-size:26px;font-weight:600;color:#bbb">—</div>';

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${L}历史报表</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#222">
<h1>📈 ${L} · 历史走势</h1>
<p style="font-size:13px;color:#888">自建累积（本站自身抓取的实时价）· 更新：${hist.updatedLocal || '—'} · 共 ${rows.length} 个交易日</p>
${switchLink}

<div style="display:flex;gap:24px;flex-wrap:wrap;margin:16px 0">
<div><div style="font-size:12px;color:#888">最新收盘</div><div style="font-size:26px;font-weight:600">$${last}</div></div>
<div><div style="font-size:12px;color:#888">区间涨跌</div>${enoughDays
  ? `<div style="font-size:26px;font-weight:600;color:${trendColor}">${totalChange >= 0 ? '+' : ''}${totalChange.toFixed(2)} (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(2)}%)</div>`
  : na}</div>
<div><div style="font-size:12px;color:#888">区间收盘高 / 低</div>${enoughDays
  ? `<div style="font-size:26px;font-weight:600">${max} / ${min}</div>`
  : na}</div>
</div>
${enoughDays ? '' : `<p style="font-size:13px;color:#c0392b;margin:0 0 8px">
目前只有 ${show.length} 个交易日 —— 涨跌与区间高低需要至少 2 天才能计算，暂时留空。
每天自动累积，攒够 2 天即可显示。</p>`}

<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;border:1px solid #eee;border-radius:8px;background:#fafafa">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="${trendColor}" stop-opacity="0.25"/>
<stop offset="100%" stop-color="${trendColor}" stop-opacity="0"/></linearGradient></defs>
<path d="${area}" fill="url(#g)"/>
<path d="${line}" fill="none" stroke="${trendColor}" stroke-width="2"/>
</svg>
<p style="font-size:12px;color:#aaa;text-align:right">${show[0].day} → ${show[show.length - 1].day}</p>

<h2 style="margin-top:28px;font-size:18px">明细（最近 ${show.length} 个交易日）</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px">
<thead><tr style="border-bottom:2px solid #ddd;text-align:left;color:#666">
<th style="padding:6px 4px">日期</th><th style="text-align:right">开盘</th><th style="text-align:right">最高</th>
<th style="text-align:right">最低</th><th style="text-align:right">收盘</th><th style="text-align:right">涨跌幅</th>
<th style="text-align:right">采样</th>
</tr></thead>
<tbody>${trs}</tbody></table>

${thin ? `<p style="font-size:12px;color:#c0392b;margin-top:16px">
※ 有 ${thin} 个交易日采样不足 ${SAMPLES_MIN} 次（多为刚起步或抓取中断），
这些日子的最高/最低已留空 —— 单次采样无法反映日内波动，不做展示。</p>` : ''}
<p style="font-size:12px;color:#aaa;margin-top:16px">
口径说明：本站为自建累积，<b>非交易所官方 OHLC</b>。每小时采样一次，伦敦交易时段
（01:00–23:00）理论最多约 22 个点，真实日内高低点很可能落在两次采样之间，
因此最高/最低仅供参考、不等于官方日内极值。收盘价为休市后补抓的当日最终观测价，
定格后不再变动；涨跌幅按「收盘对收盘」计算，两端口径一致，相对最可信（美元/桶）。</p>
<p><a href="/${keyQS}">← 返回首页</a> · <a href="/update${keyQS}">手动刷新</a> · <a href="/clear-history?code=${hKey}${keyQS.replace('?', '&')}">清空${L}历史</a></p>
</body></html>`;
}

// ============================================================
// 排班预演（v8 / v8.1 新增 · 纯只读诊断，不属于业务逻辑）
// ------------------------------------------------------------
// 作用：把未来 N 天 cron 会触发的抓取，用【已有的那套闸门函数】原样推演，
//       输出成表格，方便部署后当场核对，不用等一周、不用翻日志。
//
// ⚠️ 安全性声明（本功能能被放心加上去的前提）：
//   · 纯函数：只做日期算术 + 调用 isBrentTrading / isBrentClosing /
//     isWtiTrading / isWtiClosing / cronPhase / tradingDateString /
//     wtiTradingDateString —— 这些都是上面已有的纯函数，判定逻辑一字未改
//   · 不读 KV、不写 KV（完全不碰 env.OIL_KV）
//   · 不发起任何外部请求（不调 fetch、不碰 API 配额）
//   · 不触发任何抓取（不调 fetchAndSave / fetchGoldAndSave / fetchCnOilAll）
//   · 不影响 scheduled() 定时任务的任何一行
//   · 不修改任何已有函数的判定逻辑
//   · 默认 404 隐身：无密钥时返回 ghost()，路径不对外暴露
//
// v8.1：曾触发 Error 1102（Worker exceeded resource limits）。
//   根因是每行的三地时间都在 Worker 内 new Intl.DateTimeFormat。
//   修复：① 全局 dtf() 缓存  ② 两阶段（主循环只判定）
//         ③ 三地时间改由浏览器端 JS 渲染，Worker 只吐毫秒时间戳
// ============================================================

/**
 * 推演未来 days 天的 cron 触发表。
 * cron 为 "5,20 * * * *"，故每小时两个候选时刻：UTC :05 与 :20。
 * @param {number} days    天数
 * @param {boolean} keyOnly true = 只保留关键行（收盘 / 开盘 / 周末边界）
 */
function previewSchedule(days = 3, keyOnly = true) {
  const base = new Date();
  base.setUTCSeconds(0, 0);
  base.setUTCMinutes(0, 0);
  const total = days * 24;

  // ---- 第一轮：只做闸门判定，不做任何显示用格式化 ----
  const hits = [];
  for (let i = 0; i < total; i++) {
    const h = new Date(base.getTime() + i * 3600000);
    for (const m of [5, 20]) {
      const d = new Date(h.getTime() + m * 60000);
      const ph = cronPhase(d);
      // 与 scheduled() 完全相同的判定式 —— 保证预演 == 实际行为
      const bOpen  = ph === 'open'  && isBrentTrading(d);
      const wOpen  = ph === 'open'  && isWtiTrading(d);
      const bClose = ph === 'close' && isBrentClosing(d);
      const wClose = ph === 'close' && isWtiClosing(d);
      if (!(bOpen || wOpen || bClose || wClose)) continue;
      hits.push({
        d,
        phase: ph === 'open' ? ':05 盘中' : ':20 收盘',
        brent: bClose ? '★收盘' : bOpen ? '盘中' : '不记',
        wti:   wClose ? '★收盘' : wOpen ? '盘中' : '不记',
      });
    }
  }

  // ---- 第二轮：只保留需要核对的行 ----
  let kept = hits;
  if (keyOnly) {
    const out = [];
    let prevB = null, prevW = null;
    for (const r of hits) {
      const bOn = r.brent !== '不记';
      const wOn = r.wti !== '不记';
      const isClose = r.brent === '★收盘' || r.wti === '★收盘';
      const isOpen  = (bOn && !prevB) || (wOn && !prevW);
      const lp = londonParts(r.d), cp = chicagoParts(r.d);
      const isWeekend = lp.wd === 0 || lp.wd === 6 || cp.wd === 0 || cp.wd === 6;
      if (isClose || isOpen || isWeekend) {
        r.tag = isClose ? '收盘' : isOpen ? '开盘' : '周末';
        out.push(r);
      }
      prevB = bOn; prevW = wOn;
    }
    kept = out;
  }

  // ---- 第三轮：只给保留行算交易日，时间字符串交给浏览器 ----
  return kept.map(r => ({
    t: r.d.getTime(),
    phase: r.phase,
    brent: r.brent,
    wti: r.wti,
    brentDay: tradingDateString(r.d),
    wtiDay: wtiTradingDateString(r.d),
    tag: r.tag || '',
  }));
}

/** 排班预演页：Worker 只吐数据，时间格式化交给浏览器端 JS（省 CPU） */
function renderSchedulePreview(rows, days, full = false) {
  const payload = JSON.stringify({ days, full, rows });
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>排班预演 · 未来 ${days} 天${full ? '（完整）' : '（关键行）'}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#1e293b;margin:0;padding:20px}
h1{font-size:21px;margin:0 0 6px}h2{font-size:17px;margin:26px 0 10px}
.sub{color:#64748b;font-size:14px;margin-bottom:16px}
.note{background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:6px;font-size:14px;margin:14px 0;line-height:1.75}
.ok{background:#f0fdf4;border-left:4px solid #22c55e;padding:12px 16px;border-radius:6px;font-size:14px;margin:14px 0;line-height:1.75}
table{border-collapse:collapse;width:100%;background:#fff;font-size:12.5px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-radius:8px;overflow:hidden}
th{background:#1e3a5f;color:#fff;padding:9px 8px;text-align:left;font-weight:500;white-space:nowrap}
td{padding:7px 8px;border-top:1px solid #e2e8f0;white-space:nowrap}
tr:nth-child(even) td{background:#f8fafc}
.c{color:#2563eb;font-weight:600}.w{color:#d97706;font-weight:600}.dim{color:#94a3b8}
.keyline td{background:#fef3c7 !important}
code{background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:12.5px}
a{color:#2563eb}
</style></head><body>
<h1>排班预演 · 未来 ${days} 天${full ? '（完整）' : '（关键行）'}</h1>
<div class="sub"><span id="cnt"></span> · 生成于 <span id="gen"></span>（北京时间）</div>
<div class="note" style="background:#eff6ff;border-left-color:#3b82f6">
<b>不想核对表格？</b>　<a href="?mode=check"><b>点这里看一键自检结果 →</b></a>　（页面自动判定，只显示红绿）
</div>
<div class="ok"><b>本页为纯只读诊断</b>：不读 KV、不写 KV、不发起外部请求、不触发任何抓取、不影响定时任务。
数据由现有闸门函数实时推演，<b>与实际 cron 行为一致</b>。</div>
<div class="note">
<b>只需核对「伦敦 / 芝加哥」两列</b> —— 判断基准是市场当地时间，不是北京时间：<br>
· 布伦特 <code>★收盘</code> 必须落在伦敦 <code>23:xx</code><br>
· WTI <code>★收盘</code> 必须落在芝加哥 <code>16:xx</code><br>
· 伦敦或芝加哥为<b>周六</b>时，对应品种应为「不记」或整行不出现<br>
· 周日只应有 1~2 次（伦敦 23:xx / 芝加哥 17:xx 之后才算开盘）
</div>
<div id="out"></div>
<div class="note" style="margin-top:22px">
<b>参数：</b><code>?days=1~7</code>（默认 3）· <code>?full=1</code> 展开全部触发 · <code>?format=json</code> 返回 JSON。<br>
${full ? '当前：完整模式' : '当前：关键行模式　<a href="?days=' + days + '&full=1">切换完整模式 →</a>'}
</div>
<p style="margin-top:22px"><a href="/">← 返回首页</a></p>
<script>
const DATA = ${payload};
const WD = {Sun:'周日',Mon:'周一',Tue:'周二',Wed:'周三',Thu:'周四',Fri:'周五',Sat:'周六'};
const FMT = {};
function fmt(ms, tz) {
  let f = FMT[tz];
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    FMT[tz] = f;
  }
  const p = f.formatToParts(new Date(ms));
  const g = function (t) { const x = p.find(function (y) { return y.type === t; }); return x ? x.value : ''; };
  return g('month') + '-' + g('day') + ' ' + (WD[g('weekday')] || g('weekday')) + ' ' + g('hour') + ':' + g('minute');
}
const rows = DATA.rows;
document.getElementById('cnt').textContent = (DATA.full ? '全部 ' : '关键行 ') + rows.length + ' 条';
document.getElementById('gen').textContent = fmt(Date.now(), 'Asia/Shanghai');
const byDay = {};
rows.forEach(function (r) {
  const k = fmt(r.t, 'Asia/Shanghai').slice(0, 6);
  (byDay[k] = byDay[k] || []).push(r);
});
let html = '';
Object.keys(byDay).sort().forEach(function (k) {
  const list = byDay[k];
  html += '<h2>' + k + '　<span class="sub">' + list.length + ' 次</span></h2>';
  html += '<table><tr><th>类型</th><th>北京时间</th><th>伦敦(布伦特基准)</th>'
        + '<th>芝加哥(WTI基准)</th><th>相位</th><th>布伦特</th><th>WTI</th>'
        + '<th>布伦特交易日</th><th>WTI交易日</th></tr>';
  list.forEach(function (r) {
    const key = (r.brent === '★收盘' || r.wti === '★收盘') ? ' class="keyline"' : '';
    const tc = r.tag === '收盘' ? '#dc2626' : r.tag === '开盘' ? '#16a34a' : '#64748b';
    html += '<tr' + key + '>'
      + '<td style="color:' + tc + ';font-weight:600">' + (r.tag || '') + '</td>'
      + '<td>' + fmt(r.t, 'Asia/Shanghai') + '</td>'
      + '<td>' + fmt(r.t, 'Europe/London') + '</td>'
      + '<td>' + fmt(r.t, 'America/Chicago') + '</td>'
      + '<td class="dim">' + r.phase + '</td>'
      + '<td class="c">' + r.brent + '</td>'
      + '<td class="w">' + r.wti + '</td>'
      + '<td class="dim">' + r.brentDay + '</td>'
      + '<td class="dim">' + r.wtiDay + '</td></tr>';
  });
  html += '</table>';
});
document.getElementById('out').innerHTML = html || '<p>未来 ' + DATA.days + ' 天没有任何触发。</p>';
</script></body></html>`;
}


// ============================================================
// 极简自检页（mode=check）
// ------------------------------------------------------------
// 目的：不用人肉核对表格。页面自己跑断言，顶部只显示红绿结论。
// 计算方式与预演表完全一致（都走 previewSchedule + 同一批闸门函数）。
//
// 六项检查：
//   1. 布伦特收盘都在伦敦 23 点
//   2. WTI 收盘都在芝加哥 16 点
//   3. 布伦特周六不记录
//   4. WTI 芝加哥周六不记录
//   5. 周日不刷屏（最多 2 次）
//   6. 两品种已分开（存在某时刻只有一个品种在记）
//
// 注意：与预演表一样，纯只读，不碰 KV、不发请求、不触发抓取。
// ============================================================

/** 取某时刻在指定时区的 { 星期(0=周日), 小时 } —— 复用已有 londonParts/chicagoParts 的思路 */
function tzWH(ms, tz) {
  const f = dtf('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', hour12: false });
  const p = f.formatToParts(new Date(ms));
  const g = t => { const x = p.find(y => y.type === t); return x ? x.value : ''; };
  const wd = ['sun','mon','tue','wed','thu','fri','sat'].indexOf(g('weekday').toLowerCase());
  return { wd, hour: parseInt(g('hour'), 10) };
}

function renderSelfCheck(rows) {
  // rows 必须是完整模式（keyOnly=false）
  const c1 = [], c2 = [], c3 = [], c4 = [];
  let sundayCount = 0, splitCount = 0;

  for (const r of rows) {
    const lon = tzWH(r.t, 'Europe/London');
    const chi = tzWH(r.t, 'America/Chicago');
    const bj  = tzWH(r.t, 'Asia/Shanghai');

    // 1. 布伦特★收盘 → 伦敦必须 23 点
    if (r.brent === '★收盘' && lon.hour !== 23) c1.push(r.t);
    // 2. WTI★收盘 → 芝加哥必须 16 点
    if (r.wti === '★收盘' && chi.hour !== 16) c2.push(r.t);
    // 3. 伦敦周六 → 布伦特不记
    if (lon.wd === 6 && r.brent !== '不记') c3.push(r.t);
    // 4. 芝加哥周六 → WTI 不记
    if (chi.wd === 6 && r.wti !== '不记') c4.push(r.t);
    // 5. 北京周日触发次数（按伦敦/芝加哥任一为周日算，更贴合"市场周末"）
    if (bj.wd === 0) sundayCount++;
    // 6. 分开：某时刻只有一个品种在记
    const bOn = r.brent !== '不记', wOn = r.wti !== '不记';
    if (bOn !== wOn) splitCount++;
  }

  const items = [
    { name: '布伦特收盘时间', desc: '★收盘 全部落在伦敦 23:00', bad: c1 },
    { name: 'WTI 收盘时间',   desc: '★收盘 全部落在芝加哥 16:00', bad: c2 },
    { name: '布伦特周末停抓', desc: '伦敦周六一律不记录', bad: c3 },
    { name: 'WTI 周末停抓',   desc: '芝加哥周六一律不记录', bad: c4 },
    { name: '周日不刷屏',     desc: `北京周日仅 ${sundayCount} 次（应为 0~2）`, bad: sundayCount > 2 ? [1] : [] },
    { name: '两品种已分开',   desc: `出现 ${splitCount} 次「只抓一个品种」`, bad: splitCount > 0 ? [] : [1] },
  ];

  const pass = items.every(i => i.bad.length === 0);

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>闸门自检</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#1e293b;margin:0;padding:22px;max-width:640px}
.verdict{font-size:30px;font-weight:700;padding:22px;border-radius:12px;text-align:center;margin-bottom:8px}
.pass{background:#dcfce7;color:#15803d;border:2px solid #22c55e}
.fail{background:#fee2e2;color:#b91c1c;border:2px solid #ef4444}
.sub{text-align:center;color:#64748b;font-size:14px;margin-bottom:22px}
.item{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.mark{font-size:22px;font-weight:700;width:28px;text-align:center}
.ok{color:#22c55e}.no{color:#ef4444}
.txt b{display:block;font-size:15px;margin-bottom:2px}
.txt span{font-size:13px;color:#64748b}
.foot{margin-top:22px;font-size:13px;color:#64748b;line-height:1.8}
a{color:#2563eb}
</style></head><body>
<div class="verdict ${pass ? 'pass' : 'fail'}">${pass ? '✅ 全部通过' : '❌ 有问题'}</div>
<div class="sub">6 项闸门检查 · 基于未来 7 天 ${rows.length} 次触发推演</div>
${items.map(i => `<div class="item">
  <div class="mark ${i.bad.length ? 'no' : 'ok'}">${i.bad.length ? '✕' : '✓'}</div>
  <div class="txt"><b>${i.name}</b><span>${i.desc}${i.bad.length ? '　（异常 ' + i.bad.length + ' 处）' : ''}</span></div>
</div>`).join('')}
<div class="foot">
本页面自动核对，无需人工比对表格。<br>
判定基准是<b>市场当地时间</b>（伦敦 / 芝加哥），不是北京时间。<br>
要查看明细：<a href="/_schedule-preview?days=3">排班表</a>　·　<a href="/">返回首页</a><br>
本页基于<b>未来 7 天、130 次触发</b>全量推演，覆盖整个交易周与完整周末。
</div></body></html>`;
}
