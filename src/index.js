/**
 * oil-data-worker  v6
 * ---------------------------------------------------------------
 * v2 改动（针对「手动刷新拉不到新数据」问题）：
 *  1. 原油：抓取时一并记录 stale（沿用值标记）与 as_of（源观测时间），
 *     并在 /update、/data、首页展示，能区分「没抓到」与「抓到了但源未刷新」。
 *  2. 黄金：加每日抓取闸门 —— 定时任务无条件抓；手动刷新每天最多生效 1 次，
 *     且当天定时任务已抓过就直接跳过，保护 MetalpriceAPI 月度配额。
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
 * 当前保留的数据源：OilPriceAPI（原油实时）、MetalpriceAPI（黄金）、
 *                    ShowAPI 138-46（国内油价，与已删除的 1108 无关）
 * ---------------------------------------------------------------
 */

/* X-Robots-Tag：本站是私有数据后端，所有响应一律禁止搜索引擎收录，
 * 避免内部管理页（/ /history /update）被 Google 索引后公开暴露。 */
const NOINDEX = 'noindex, nofollow, noarchive, noimageindex';
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX };
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX };
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX };

/** 黄金手动刷新每日上限（保护月度配额，1 = 每天最多手动抓 1 次） */
const GOLD_MANUAL_MAX_PER_DAY = 1;

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

/** 北京时间日期串 YYYY-MM-DD（用于「每天一次」的闸门判断） */
function beijingDateString(d = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
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
    lon = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch (e) {
    lon = new Date(d.getTime() + (d.getUTCMonth() > 9 || (d.getUTCMonth() === 9 && d.getUTCDate() >= 25) ? 0 : 1) * 3600 * 1000)
      .toISOString().slice(0, 10);
  }
  const { hour } = londonParts(d);
  if (hour < 1) {
    const dt = new Date(`${lon}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    lon = dt.toISOString().slice(0, 10);
  }
  return lon;
}

/** 北京时间小时数（0-23），用于 cron 内部分支判断 */
function beijingHour(d = new Date()) {
  try {
    return +new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false,
    }).format(d);
  } catch (e) {
    return new Date(d.getTime() + 8 * 3600 * 1000).getUTCHours();
  }
}

/** 伦敦本地时间 HH:MM（仅用于日志，方便你核对闸门行为） */
function londonClock(d = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch (e) {
    return 'n/a';
  }
}

/** 解析伦敦本地时间 → { wd: 0=周日..6=周六, hour: 0-23 } */
function londonParts(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
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

// ============================================================
// 布伦特原油交易时段闸门（省 API 配额的关键）
// ------------------------------------------------------------
// 以「伦敦本地时间」判断，而不是写死北京时间 —— 这样英国在
// 10 月底切换冬令时（BST -> GMT）时会自动跟随，不需要改代码。
//
//  伦敦时间            北京时间(夏令时/冬令时)
//  周日 01:00 开盘     周日 08:00 / 09:00
//  周一~周五 01:00-23:00 交易
//  每天 23:00 休市      06:00 / 07:00（次日）
//  周五 23:00 收盘     周六 06:00 / 07:00
//  周六 全天休市       约 26 小时完全不动
//
// 周末那段是最大的浪费源：不加这道闸门，cron 会在休市的 26 小时里
// 傻傻地抓 26 次，每次都拿到同一个休市价。
// ============================================================
function isBrentTrading(d = new Date()) {
  const { wd, hour } = londonParts(d);
  if (wd === 6) return false;               // 周六 全天休市
  if (wd === 5 && hour >= 23) return false; // 周五 23:00 收盘
  if (wd === 0 && hour < 1) return false;   // 周日 01:00 才开盘
  if (hour >= 23 || hour < 1) return false; // 每日结算休市 23:00-01:00
  return true;
}

// ============================================================
// 收盘补抓窗口（★ 本次新增，最重要的一条）
// ------------------------------------------------------------
// 问题：市场 23:00 休市，但如果最后一次抓取卡在 22:00（休市前 1 小时），
//       拿到的就不是当日最终价，之后又不再抓 —— 当天价格就定错在半路上。
//
// 解决：休市后「再抓一次」，把当日最终价钉死。
//   · 伦敦 00:00 = 休市后 1 小时   → 补抓（本次新增）
//   · 伦敦 01:00 = 休市后 2 小时   → 新交易日开盘，交易时段本来就会抓
//   两个点都覆盖到，确保休市后 1~2 小时内必定有一次抓取。
//
//  周二~周五 00:00 → 拿到「前一交易日当日收盘价」
//  周六     00:00 → 拿到「周五周收盘价」★ 整个周末都显示它，最关键
//  周日     00:00 → 跳过（01:00 才开盘，此时抓到的仍是沿用值，浪费）
//
// 夏令时：伦敦 00:00 = 北京 07:00；冬令时：伦敦 00:00 = 北京 08:00
// ============================================================
function isClosingWindow(d = new Date()) {
  const { wd, hour } = londonParts(d);
  if (wd === 0) return false;   // 周日开盘前不补抓
  return hour === 0;            // 休市后 1 小时
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
      const [oilCached, goldCached, cnCached, wtiCached] = await Promise.all([
        env.OIL_KV.get('oil_data', 'json'),
        env.OIL_KV.get('gold_data', 'json'),
        env.OIL_KV.get('cn_oil_data', 'json'),
        env.OIL_KV.get('wti_data', 'json'),
      ]);

      // 首屏只读缓存，绝不触发抓取（省配额）
      let o = oilCached, g = goldCached, cn = cnCached;
      if (!o) o = (await fetchAndSave(env, false)).data;
      if (!g) g = (await fetchGoldAndSave(env, { bootstrap: true })).data;
      if (!cn) cn = await fetchCnOilAll(env);

      if (!o && !g && !(cn && cn.list && cn.list.length)) {
        return new Response('<h1>暂无数据</h1><p><a href="/update">点击更新</a></p>', { headers: HTML_HEADERS });
      }

      const pricePerBarrel = o ? parseFloat(o.price) : null;
      const pricePerLiter = o ? (pricePerBarrel / 158.987).toFixed(4) : '—';
      const pricePerLiterCny = o ? (pricePerLiter * 7.2).toFixed(2) : '—';

      const oilUTC = o?.timestamp ? new Date(o.timestamp).toISOString() : '';
      const oilAsOf = o?.asOf ? new Date(o.asOf).toISOString() : '';
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
<title>国际原油 & 黄金 & 国内油价 · 每日参考价</title>
<meta name="description" content="布伦特原油 $${pricePerBarrel || '—'} USD/桶，国际黄金 $${g?.priceUsdPerOz || '—'} USD/盎司，国内成品油各省指导价">
</head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px">
<h1>📊 国际原油 & 黄金 · 每日参考价</h1>

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
<p><strong>📅 每日参考价（延迟日更，非盘中实时）</strong></p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每盎司价格</td><td style="padding:8px 0">$${g.priceUsdPerOz} USD/盎司</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每克价格</td><td style="padding:8px 0">≈ ¥${g.priceCnyPerGram} / 克</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据源</td><td style="padding:8px 0">MetalpriceAPI 免费档（延迟约24h）</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">源数据日期</td><td style="padding:8px 0">${goldUTC} <span style="font-size:12px;color:#999">(UTC)</span></td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">上次价格 / 是否变化</td><td style="padding:8px 0">${g.prevPriceUsdPerOz ?? '—'} / ${g.changed === null ? '—' : (g.changed ? '有变化' : '无变化')}</td></tr>
</table>
<p style="font-size:12px;color:#999">ℹ️ 黄金仅在每日定时任务（北京时间 04:00）自动抓取；手动刷新每天最多补抓 1 次，且当天定时任务已抓过则跳过，避免耗尽月度配额。</p>` : ''}

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
<p style="font-size:12px;color:#aaa">以上为国际原料与成品油参考价，非零售汽油价 / 首饰金价。黄金为延迟日更参考价，不代表实时盘中报价。</p>
<p style="font-size:12px;color:#aaa"><a href="https://metalpriceapi.com" target="_blank" rel="noopener">Data provided by MetalpriceAPI</a> · <a href="/update">手动刷新</a> · <a href="/history">📈 布伦特走势</a> · <a href="/history?code=wti">📈 WTI走势</a> · <a href="/data">原始JSON</a></p>

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

    // ---------------- /data ----------------
    if (url.pathname === '/data') {
      const [oil, gold, cn, marker, hist, cnMarker, wti, wtiHist] = await Promise.all([
        env.OIL_KV.get('oil_data', 'json'),
        env.OIL_KV.get('gold_data', 'json'),
        env.OIL_KV.get('cn_oil_data', 'json'),
        env.OIL_KV.get('gold_fetch_marker', 'json'),
        env.OIL_KV.get('brent_history', 'json'),
        env.OIL_KV.get('cn_oil_fetch_marker', 'json'),
        env.OIL_KV.get('wti_data', 'json'),
        env.OIL_KV.get('wti_history', 'json'),
      ]);
      const now = new Date();
      return new Response(JSON.stringify({
        todayBeijing: beijingDateString(),
        // 闸门状态：方便你核对「该抓的时候到底抓没抓」
        tradingWindow: {
          beijingHour: beijingHour(now),
          londonClock: londonClock(now),
          brentTrading: isBrentTrading(now),
          closingWindow: isClosingWindow(now),
          note: 'brentTrading=false 且 closingWindow=false 时 cron 跳过抓取（休市）；手动 /update 不受影响',
        },
        oil,
        wti: wti || null,          // WTI 原油（同一次请求带回，不额外消耗配额）
        gold,
        cn_oil: cn,
        goldFetchMarker: marker || null,
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
      }, null, 2), { headers: JSON_HEADERS });
    }

    // ---------------- /history 报表页 ----------------
    if (url.pathname === '/history') {
      const hKey = url.searchParams.get('code') === 'wti' ? 'wti' : 'brent';
      return new Response(await renderHistoryPage(env, hKey), { headers: HTML_HEADERS });
    }

    // ---------------- /clear-history 清空历史（自建累积，随时可重来）----------------
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
        fetchAndSave(env, false),
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

    // 黄金：每天 04:00 一次。月度配额极珍贵，盘中绝不抓。
    if (h === 4) jobs.push(fetchGoldAndSave(env, { manual: false }));

    // 国内油价：每天 08:00 一次（万维易源 7-8 点更新后再拉）
    if (h === 8) jobs.push(fetchCnOilAll(env));

    // 原油：交易时段每小时抓 + 休市后 1 小时补抓一次（钉死当日最终价）
    const trading = isBrentTrading(now);
    const closing = isClosingWindow(now);

    if (trading || closing) {
      jobs.push(fetchAndSave(env, closing));   // closing=true → 标记为「当日收盘价」
      console.log(`[cron] 原油抓取 — 北京 ${h}:00，伦敦 ${londonClock(now)}，${closing ? '收盘补抓' : '盘中'}`);
    } else {
      console.log(`[cron] 布伦特休市，跳过 — 北京 ${h}:00，伦敦 ${londonClock(now)}`);
    }

    if (!jobs.length) return;
    await Promise.allSettled(jobs);
  }
};

// ================= 原油 =================
// isClosing = true 表示这次是「休市后 1 小时」的收盘补抓，抓到的是当日最终价
async function fetchAndSave(env, isClosing = false) {
  const apiKey = env.OILPRICEAPI_KEY;
  if (!apiKey) throw new Error('Missing OILPRICEAPI_KEY');

  const prev = await env.OIL_KV.get('oil_data', 'json').catch(() => null);

  // 一次请求拿布伦特 + WTI；拿不到批量就自动降级只请求布伦特（见 fetchOilJson）
  const { json, mode } = await fetchOilJson(apiKey);
  const p = pickQuote(json, BRENT_CODE) || ((json && json.data) || {});

  const stale = p.stale === true || json.stale === true;
  const asOf = p.as_of || p.as_of_at || p.created_at || p.timestamp || null;

  const result = {
    price: p.price,
    formatted: p.formatted,
    timestamp: p.created_at || p.timestamp || null,   // 收集时间
    asOf,                                             // 源观测时间
    stale,                                            // true = 沿用值
    updatedLocal: beijingNow(),
    isClosing: !!isClosing,                 // true = 当日收盘价（休市后 1 小时抓取）
    isSettlement: !!isClosing,              // 兼容旧字段，含义同上
    prevPrice: prev && prev.price != null ? prev.price : null,
    changed: prev ? String(prev.price) !== String(p.price) : null,
    sourceMode: mode,                       // 'batch' = 一次拿两个；'single' = 降级只拿布伦特
  };

  await env.OIL_KV.put('oil_data', JSON.stringify(result), { expirationTtl: 86400 * 2 });

  // WTI：白捡的第二个品种，同一次请求里带回来的，不额外消耗配额。
  // 拿不到就跳过，绝不影响布伦特（主流程已存完）。
  let wti = null;
  // 只在批量模式里找 WTI：降级模式压根没请求 WTI，不该有数据。
  // 双保险 —— 即使 pickQuote 兜底逻辑将来有变动，也不会把布伦特当 WTI 存进去。
  const w = mode === 'batch' ? pickQuote(json, WTI_CODE) : null;
  if (w && w.price != null) {
    const prevW = await env.OIL_KV.get('wti_data', 'json').catch(() => null);
    wti = {
      code: WTI_CODE,
      name: 'WTI 原油',
      price: w.price,
      formatted: w.formatted || `$${w.price}`,
      timestamp: w.created_at || w.timestamp || null,
      asOf: w.as_of || w.as_of_at || w.created_at || w.timestamp || null,
      stale: w.stale === true,
      updatedLocal: beijingNow(),
      isClosing: !!isClosing,
      prevPrice: prevW && prevW.price != null ? prevW.price : null,
      changed: prevW ? String(prevW.price) !== String(w.price) : null,
      sourceMode: mode,
    };
    await env.OIL_KV.put('wti_data', JSON.stringify(wti), { expirationTtl: 86400 * 2 });

    // WTI 同样攒走势 —— 与布伦特完全同一套规则、同一时刻写入，零额外额度。
    // 失败也不影响布伦特（各自独立 catch）。
    await recordDailyHistory(env, {
      price: wti.price,
      isClosing: !!isClosing,
      kvKey: 'wti_history',
      label: 'WTI 原油',
    }).catch(() => {});
  }

  // 顺手把本次价格记进历史走势（自建累积，零额外额度）
  await recordDailyHistory(env, {
    price: result.price,
    isClosing: !!isClosing,
    kvKey: 'brent_history',
    label: '布伦特原油',
  }).catch(() => {});

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
async function recordDailyHistory(env, { price, isClosing, kvKey = 'brent_history', label = '布伦特原油' }) {
  const num = Number(price);
  if (!Number.isFinite(num)) return null;

  const now = new Date();
  if (!isBrentTrading(now) && !isClosingWindow(now)) return null;  // 休市沿用量不记录

  const day = tradingDateString(now);
  // 周六周日没有交易，即使补抓拿到的也是沿用值 —— 不建这一天的记录，
  // 否则走势图上会出现「休市日」的点（周五收盘补抓落在周六 00:00，
  // tradingDateString 会往前推回周五，所以不受影响）。
  if (!isWeekdayInLondon(day)) return null;

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

// ================= 黄金（免费档日更，配额极珍贵）=================
async function fetchGoldAndSave(env, { manual = false, bootstrap = false } = {}) {
  const cached = await env.OIL_KV.get('gold_data', 'json').catch(() => null);
  const marker = await env.OIL_KV.get('gold_fetch_marker', 'json').catch(() => null);
  const today = beijingDateString();

  // 手动刷新的闸门：当天已抓过（无论定时任务还是手动）→ 直接跳过
  if (manual && marker && marker.date === today && GOLD_MANUAL_MAX_PER_DAY <= 1) {
    return {
      data: cached,
      prev: cached,
      skipped: true,
      reason: `今日已抓取（${marker.source === 'cron' ? '定时任务 04:00' : marker.source === 'manual' ? '手动' : '初始化'}），跳过以保护月度配额`,
    };
  }

  const apiKey = env.METALPRICEAPI_KEY;
  if (!apiKey) throw new Error('Missing METALPRICEAPI_KEY');

  const res = await fetch(
    `https://api.metalpriceapi.com/v1/latest?api_key=${apiKey}&base=USD&currencies=XAU,CNY`,
    { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 0 } }
  );
  if (!res.ok) throw new Error(`Gold API ${res.status}`);

  const j = await res.json();
  const usdPerOz = +(1 / j.rates.XAU).toFixed(2);
  const cnyPerGram = +(usdPerOz / 31.1034768 * j.rates.CNY).toFixed(2);

  const gold = {
    priceUsdPerOz: usdPerOz,
    priceCnyPerGram: cnyPerGram,
    updatedAt: j.date || new Date().toISOString(),   // 源数据日期
    fetchedLocal: beijingNow(),
    fetchedSource: manual ? 'manual' : (bootstrap ? 'bootstrap' : 'cron'),
    prevPriceUsdPerOz: cached ? cached.priceUsdPerOz : null,
    changed: cached ? cached.priceUsdPerOz !== usdPerOz : null,
  };

  await env.OIL_KV.put('gold_data', JSON.stringify(gold), { expirationTtl: 86400 * 2 });
  await env.OIL_KV.put(
    'gold_fetch_marker',
    JSON.stringify({ date: today, source: gold.fetchedSource }),
    { expirationTtl: 86400 * 3 }
  );

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

async function renderHistoryPage(env, hKey = 'brent') {
  const spec = historySpec(hKey);
  const hist = await env.OIL_KV.get(spec.kvKey, 'json').catch(() => null);
  const rows = hist?.rows || [];
  const L = spec.label;   // 标题里的品种名

  // 页面顶部切换品种的链接
  const switchLink = `<p style="font-size:13px">切换品种：`
    + `<a href="/history">📈 ${HISTORY_SPECS.brent.label}</a> · `
    + `<a href="/history?code=wti">📈 ${HISTORY_SPECS.wti.label}</a>`
    + ` ｜ 当前：<b>${L}</b></p>`;

  if (!rows.length) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>历史报表</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px">
<h1>📈 ${L} · 历史走势</h1>
${switchLink}
<p>暂无数据 —— 历史走势是<b>自建累积</b>的：每次 cron 抓取实时价时顺便记一条，
每天一组开/高/低/收，日积月累形成走势。</p>
<p>第一次抓取后就会出现第一条，之后每天自动增加。中间不会额外消耗 API 额度。</p>
<p>操作：访问 <a href="/update">/update</a> 手动抓一次即可看到首条数据。</p>
<p><a href="/">← 返回首页</a></p></body></html>`;
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
<p><a href="/">← 返回首页</a> · <a href="/update">手动刷新</a> · <a href="/clear-history?code=${hKey}">清空${L}历史</a></p>
</body></html>`;
}
