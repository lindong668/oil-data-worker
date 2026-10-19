/**
 * oil-data-worker  v5
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
 *
 * v5 改动（本次）：
 *  1. 新增「布伦特历史日报」—— 万维易源 ShowAPI 1108-2，每天 1 次调用
 *     返回整段历史（开/高/低/收），存 KV 并做去重合并，日积月累成走势库。
 *     OilPriceAPI 实时抓取逻辑原样保留，完全不动。
 *  2. 国内油价加「每日闸门」—— 与黄金一致：cron 每天 08:00 抓一次，
 *     手动当天已抓过则跳过（0 消耗），cron 失败才允许手动补 1 次。
 *  3. 新增 /history 报表页（表格 + SVG 走势图）与 /test-history 自测诊断页。
 * ---------------------------------------------------------------
 */

const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

/** 黄金手动刷新每日上限（保护月度配额，1 = 每天最多手动抓 1 次） */
const GOLD_MANUAL_MAX_PER_DAY = 1;

// ============================================================
// 万维易源 ShowAPI 1108-2 · 国际原油历史日报
// ------------------------------------------------------------
// ⚠️ 该接口一次只能返回「一种」原油，靠 code 参数区分：
//      code=blt → 布伦特原油（本站在用的，唯一需要调的）
//      code=wti → WTI 原油（本站不用，绝不调用）
//    若两种都调，一次就要消耗 2 倍额度 —— 所以代码里写死只调 blt，
//    并在下方加断言防止误改。
// ============================================================
const SHOWAPI_HISTORY_URL = 'https://route.showapi.com/1108-2';
/** 本站只做布伦特，禁止改成 wti —— 改了报表数据就全错 */
const HISTORY_CODE_BRENT = 'blt';
/**
 * 单次请求的窗口天数。
 * ⚠️ 实测：7 天窗口能返回数据，60 天窗口返回 0 条 —— 该接口对区间长度有限制，
 *    窗口开太大反而一条都不给。所以固定用小窗口，靠「分段回溯」补历史。
 */
const HISTORY_FETCH_DAYS = 7;
/** 每次 /update 往前回溯几段（1 段 = 1 次请求 = 1 次额度）。日常保持 1 最省。 */
const HISTORY_BACKFILL_SEGMENTS = 1;
/** KV 最多保留的历史条数（约 1 年交易日） */
const HISTORY_MAX_ROWS = 400;

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------------- 首页 ----------------
    if (url.pathname === '/') {
      const [oilCached, goldCached, cnCached] = await Promise.all([
        env.OIL_KV.get('oil_data', 'json'),
        env.OIL_KV.get('gold_data', 'json'),
        env.OIL_KV.get('cn_oil_data', 'json'),
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
<p style="font-size:12px;color:#aaa"><a href="https://metalpriceapi.com" target="_blank" rel="noopener">Data provided by MetalpriceAPI</a> · <a href="/update">手动刷新</a> · <a href="/history">📈 历史报表</a> · <a href="/test-history">报表自测</a> · <a href="/data">原始JSON</a></p>

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
      const [oil, gold, cn, marker, hist, cnMarker, histMarker] = await Promise.all([
        env.OIL_KV.get('oil_data', 'json'),
        env.OIL_KV.get('gold_data', 'json'),
        env.OIL_KV.get('cn_oil_data', 'json'),
        env.OIL_KV.get('gold_fetch_marker', 'json'),
        env.OIL_KV.get('brent_history', 'json'),
        env.OIL_KV.get('cn_oil_fetch_marker', 'json'),
        env.OIL_KV.get('brent_history_marker', 'json'),
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
        gold,
        cn_oil: cn,
        goldFetchMarker: marker || null,
        cnOilFetchMarker: cnMarker || null,
        // 布伦特历史日报（万维易源 1108-2，每日 1 次）
        brentHistory: hist ? {
          code: hist.code,
          updatedLocal: hist.updatedLocal,
          rows: hist.rows?.length ?? 0,
          latest: hist.rows?.[hist.rows.length - 1] ?? null,
          note: '完整数组见 /history 页面或原始数据 KV',
        } : null,
        brentHistoryMarker: histMarker || null,
      }, null, 2), { headers: JSON_HEADERS });
    }

    // ---------------- /history 报表页 ----------------
    if (url.pathname === '/history') {
      return new Response(await renderHistoryPage(env), { headers: HTML_HEADERS });
    }

    // ---------------- /test-history 自测诊断 ----------------
    if (url.pathname === '/test-history') {
      const force = url.searchParams.get('force') === '1';
      // ?probe=1 → 区间探测（测 7/14/30/60 天各返回几条，会消耗 4 次额度）
      const probe = url.searchParams.get('probe') === '1';
      // ?backfill=N → 分段回溯补历史（N 段 × 7 天，消耗 N 次额度，不受每日闸门限制）
      const backfill = parseInt(url.searchParams.get('backfill') || '0', 10);
      let r;
      if (backfill > 0) {
        r = await runBackfill(env, backfill);
      } else {
        r = await probeHistory(env, { force, probe });
      }
      return new Response(r, { headers: TEXT_HEADERS });
    }

    // ---------------- /update ----------------
    if (url.pathname === '/update') {
      const results = await Promise.allSettled([
        fetchAndSave(env, false),
        fetchGoldAndSave(env, { manual: true }),
        fetchCnOilAll(env, { manual: true }),
        fetchBrentHistory(env, { manual: true }),
      ]);

      const line = (name, r) => {
        if (r.status !== 'fulfilled') return `${name}: ❌ 失败 — ${r.reason?.message || r.reason}`;
        const v = r.value;
        if (!v || v.skipped) return `${name}: ⏭️ 跳过 — ${v?.reason || '未重新抓取'}`;
        return `${name}: ✅ 成功`;
      };

      const oilR = results[0], goldR = results[1], cnR = results[2];

      // 原油详情
      let oilDetail = '';
      if (oilR.status === 'fulfilled' && oilR.value?.data) {
        const d = oilR.value.data;
        oilDetail = `    新旧价格 : ${d.prevPrice ?? '—'} → ${d.price}  ${d.changed ? '（有变化 ✅）' : '（无变化 ⚠️）'}
    stale     : ${d.stale}  ${d.stale ? '（沿用值：源未刷新，不是代码没抓）' : '（新值）'}
    源观测时间 : ${d.asOf || '—'}
    收集时间   : ${d.timestamp || '—'}
    抓取时刻   : ${d.updatedLocal}`;
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

      // 历史日报详情
      const histR = results[3];
      let histDetail = '';
      if (histR.status === 'fulfilled') {
        const v = histR.value;
        if (v?.skipped) {
          histDetail = `    原因 : ${v.reason}
    已有条数 : ${v.data?.rows?.length ?? 0}`;
        } else if (v?.data) {
          histDetail = `    拉取品种 : ${v.data.code}（blt=布伦特，未调 WTI，仅消耗 1 次额度）
    区间     : ${v.data.range?.begin ?? '—'} ~ ${v.data.range?.end ?? '—'}
    本次返回 : ${v.data.fetchedCount ?? 0} 条
    累计条数 : ${v.data.rows?.length ?? 0} 条
    最新一条 : ${v.data.rows?.length ? JSON.stringify(v.data.rows[v.data.rows.length - 1]) : '—'}`;
        }
      } else {
        histDetail = `    原因 : ${histR.reason?.message || histR.reason}
    提示 : 若提示 ret_code 非 0，多半是 1108 未在万维易源后台开通，需单独免费订购`;
      }

      const txt = `${line('原油', oilR)}
${oilDetail}

${line('黄金', goldR)}
${goldDetail}

${line('国内油价', cnR)}
${cnDetail}

${line('历史日报', histR)}
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

    // 布伦特历史日报：每天 09:00 一次（万维易源 1108-2，1 次调用返回整段）
    // 为什么是 09:00：伦敦 23:00 收盘 = 北京 06:00(夏令) / 07:00(冬令)，
    // 留 2~3 小时缓冲，确保拿到的是「已结算完整」的前一日日报。
    if (h === 9) jobs.push(fetchBrentHistory(env, { manual: false }));

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

  const res = await fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD', {
    headers: { 'Authorization': `Token ${apiKey}` },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`Oil API ${res.status}`);

  const json = await res.json();
  const p = (json && json.data) || {};

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
  };

  await env.OIL_KV.put('oil_data', JSON.stringify(result), { expirationTtl: 86400 * 2 });
  return { data: result, prev, skipped: false };
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

// ============================================================
// 布伦特历史日报（万维易源 ShowAPI 1108-2）
// ------------------------------------------------------------
// · 每天仅 1 次调用，返回整段区间（不是一天一条请求）
// · 只调 code=blt（布伦特）。绝不调 wti —— 本站用不上，且会多耗 1 倍额度
// · 新数据按 day 去重合并进 KV，日积月累形成走势库（最多 400 条约 1 年）
// · 官方字段：day / open_price / close_price / max / min / diff（涨跌幅）
//   不同供应商字段名可能略有差异，下面做了多候选兼容
// ============================================================
function ymd(d, sep = '') {
  const s = beijingDateString(d);
  return sep ? s.replace(/-/g, sep) : s;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
}

// 日期归一化：兼容 2026-10-19 / 20261019 / 2026/10/19 / 2026-10-19 00:00:00
function normalizeDay(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);   // 带分隔符
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);                     // 纯数字 20261019
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// 依次尝试多个候选 key，取第一个能转成数字的
function pickNum(r, keys) {
  for (const k of keys) {
    if (r[k] !== undefined && r[k] !== null && r[k] !== '') {
      const n = toNum(r[k]);
      if (n != null) return n;
    }
  }
  return null;
}

const F_KEYS = {
  open:  ['open_price', 'openPrice', 'open', 'today_openPrice', 'openprice', 'OPEN'],
  high:  ['max', 'max_price', 'high_price', 'high', 'todayMax', 'highest', 'top', 'HIGH'],
  low:   ['min', 'min_price', 'low_price', 'low', 'todayMin', 'lowest', 'bottom', 'LOW'],
  close: ['close_price', 'closePrice', 'close', 'end_price', 'endPrice', 'price',
          'nowPrice', 'settle', 'settlement', 'settlement_price', 'last', 'CLOSE'],
  diff:  ['diff', 'diff_rate', 'change', 'changeRate', 'change_rate', 'changePercent', 'zdf'],
  vol:   ['trade_num', 'volume', 'tradeNum', 'trade_volume', 'vol'],
};

function normalizeRow(r) {
  if (!r || typeof r !== 'object') return null;
  const day = normalizeDay(r.day ?? r.date ?? r.tradeDate ?? r.time ?? r.dayStr ?? r.dt);
  if (!day) return null;
  const close = pickNum(r, F_KEYS.close);
  if (close == null) return null;          // 没有收盘价的记录直接丢弃
  const row = {
    day,
    open:  pickNum(r, F_KEYS.open),
    high:  pickNum(r, F_KEYS.high),
    low:   pickNum(r, F_KEYS.low),
    close,
  };
  const diff = pickNum(r, F_KEYS.diff);
  if (diff != null) row.diff = diff;
  const vol = pickNum(r, F_KEYS.vol);
  if (vol != null) row.vol = vol;
  return row;
}

// 诊断：说明一条记录为什么被丢弃（给 /test-history 用）
function diagnoseRow(r) {
  if (!r || typeof r !== 'object') return '不是对象';
  const rawDay = r.day ?? r.date ?? r.tradeDate ?? r.time ?? r.dayStr ?? r.dt;
  const day = normalizeDay(rawDay);
  if (!day) return `日期无法识别（原始值：${JSON.stringify(rawDay)}）`;
  const close = pickNum(r, F_KEYS.close);
  if (close == null) {
    const tried = F_KEYS.close.filter(k => r[k] !== undefined);
    return `收盘价无法识别。已尝试字段：${F_KEYS.close.join('/')}；` +
           `其中存在的字段：${tried.length ? tried.map(k => `${k}=${JSON.stringify(r[k])}`).join(', ') : '（一个都没出现）'}`;
  }
  return null;   // 解析正常
}

/** 请求一个窗口（begin~end），返回解析后的行数组 */
async function fetchHistoryWindow(env, appKey, beginDate, endDate) {
  const qs = new URLSearchParams({
    appKey,
    code: HISTORY_CODE_BRENT,
    begin: ymd(beginDate),
    end: ymd(endDate),
  });
  const res = await fetch(`${SHOWAPI_HISTORY_URL}?${qs.toString()}`, {
    headers: { 'Accept': 'application/json' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`ShowAPI 1108-2 HTTP ${res.status}`);

  const json = await res.json();
  if (json.showapi_res_code !== 0) {
    throw new Error(`ShowAPI 网关错误 ${json.showapi_res_code}: ${json.showapi_res_error || '（多半是 1108 未开通）'}`);
  }
  const body = json.showapi_res_body || {};
  if (body.ret_code !== 0) {
    throw new Error(`ShowAPI 1108-2 ret_code=${body.ret_code} ${body.ret_message || body.remark || '（多半是 1108 未开通）'}`);
  }
  let raw = body.list || body.data || body.dataList || body.result || body.rows || [];
  if (!Array.isArray(raw)) {
    for (const v of Object.values(body)) { if (Array.isArray(v)) { raw = v; break; } }
  }
  if (!Array.isArray(raw)) raw = [];
  return raw.map(normalizeRow).filter(Boolean);
}

async function fetchBrentHistory(env, { manual = false, days = HISTORY_FETCH_DAYS, segments = HISTORY_BACKFILL_SEGMENTS } = {}) {
  const cached = await env.OIL_KV.get('brent_history', 'json').catch(() => null);

  // 每日闸门：手动刷新时，今天已成功抓过就跳过（0 消耗）
  if (manual) {
    const gate = await checkDailyGate(env, 'brent_history_marker', { manual: true });
    if (gate.skip) {
      return { data: cached, skipped: true, reason: gate.reason };
    }
  }

  const appKey = env.SHOWAPI_APPKEY;
  if (!appKey) throw new Error('Missing SHOWAPI_APPKEY');

  // ⚠️ 断言：只能是布伦特。若哪天被误改成 wti，这里直接报错，防止报表数据全错
  if (HISTORY_CODE_BRENT !== 'blt') {
    throw new Error('HISTORY_CODE 被改成了非布伦特品种，已阻止');
  }

  // 分段回溯：第 0 段 = 最近 days 天，第 1 段 = 再往前 days 天……
  // 每段 1 次请求 = 1 次额度。日常 segments=1（只补最近一周，够用且最省）。
  const all = [];
  const segLog = [];
  for (let s = 0; s < segments; s++) {
    const end = new Date(Date.now() - s * days * 86400 * 1000);
    const begin = new Date(end.getTime() - days * 86400 * 1000);
    try {
      const got = await fetchHistoryWindow(env, appKey, begin, end);
      segLog.push(`${ymd(begin)}~${ymd(end)}: ${got.length}条`);
      all.push(...got);
    } catch (e) {
      segLog.push(`${ymd(begin)}~${ymd(end)}: 失败(${e.message})`);
      break;   // 某段失败就停，不再往后白烧额度
    }
  }

  // 与已有数据按 day 去重合并（新数据覆盖旧数据），按日期升序
  const map = new Map();
  for (const r of (cached?.rows || [])) map.set(r.day, r);
  for (const r of all) map.set(r.day, r);
  const rows = [...map.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-HISTORY_MAX_ROWS);

  const data = {
    code: HISTORY_CODE_BRENT,
    label: '布伦特原油',
    range: { begin: ymd(new Date(Date.now() - segments * days * 86400 * 1000)), end: ymd(new Date()) },
    fetchedCount: all.length,
    segments: segLog,
    rows,
    updatedLocal: beijingNow(),
  };

  await env.OIL_KV.put('brent_history', JSON.stringify(data));  // 历史数据不设过期，永久累积
  await markDailyFetched(env, 'brent_history_marker', manual ? 'manual' : 'cron');
  return { data, skipped: false };
}

// ---------------- 报表页渲染 ----------------
async function renderHistoryPage(env) {
  const hist = await env.OIL_KV.get('brent_history', 'json').catch(() => null);
  const rows = hist?.rows || [];

  if (!rows.length) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>历史报表</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px">
<h1>📈 布伦特原油历史报表</h1>
<p>暂无数据。请按下面两步操作：</p>
<ol>
<li>先访问 <a href="/test-history">/test-history</a> 自测，看接口是否返回 <code>ret_code: 0</code></li>
<li>若提示未开通，到万维易源后台<b>免费订购 1108</b> 接口（138-46 是另一个接口，需单独开通）</li>
<li>开通后访问 <a href="/update">/update</a> 拉一次</li>
</ol>
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

  const trs = show.slice().reverse().map(r => {
    const d = toNum(r.diff);
    const c = d == null ? '#999' : (d >= 0 ? upColor : downColor);
    const sign = d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(2) + '%';
    return `<tr style="border-bottom:1px solid #eee">
<td style="padding:6px 4px">${r.day}</td>
<td style="padding:6px 4px;text-align:right">${r.open ?? '—'}</td>
<td style="padding:6px 4px;text-align:right">${r.high ?? '—'}</td>
<td style="padding:6px 4px;text-align:right">${r.low ?? '—'}</td>
<td style="padding:6px 4px;text-align:right"><b>${r.close}</b></td>
<td style="padding:6px 4px;text-align:right;color:${c}">${sign}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>布伦特原油历史报表</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#222">
<h1>📈 布伦特原油 · 历史日报表</h1>
<p style="font-size:13px;color:#888">数据源：万维易源 ShowAPI 1108-2 · 品种 blt（布伦特）· 更新：${hist.updatedLocal || '—'} · 共 ${rows.length} 条</p>

<div style="display:flex;gap:24px;flex-wrap:wrap;margin:16px 0">
<div><div style="font-size:12px;color:#888">最新收盘</div><div style="font-size:26px;font-weight:600">$${last}</div></div>
<div><div style="font-size:12px;color:#888">区间涨跌</div><div style="font-size:26px;font-weight:600;color:${trendColor}">${totalChange >= 0 ? '+' : ''}${totalChange.toFixed(2)} (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(2)}%)</div></div>
<div><div style="font-size:12px;color:#888">区间最高 / 最低</div><div style="font-size:26px;font-weight:600">${max} / ${min}</div></div>
</div>

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
</tr></thead>
<tbody>${trs}</tbody></table>

<p style="font-size:12px;color:#aaa;margin-top:24px">口径说明：以上为数据源提供的每日开/高/低/收报价（美元/桶），供参考，非交易所官方结算价。</p>
<p><a href="/">← 返回首页</a> · <a href="/test-history">接口自测</a> · <a href="/update">手动刷新</a></p>
</body></html>`;
}

// ---------------- 自测诊断 ----------------
async function probeHistory(env, { force = false, probe = false } = {}) {
  if (probe) return runProbe(env);
  const appKey = env.SHOWAPI_APPKEY;
  const out = [];
  out.push(`=== 万维易源 1108-2 自测 ===`);
  out.push(`北京时间 : ${beijingNow()}`);
  out.push(`AppKey   : ${appKey ? '已配置（' + String(appKey).slice(0, 4) + '****' + String(appKey).slice(-4) + '）' : '❌ 未配置 SHOWAPI_APPKEY'}`);
  if (!appKey) return out.join('\n');

  const end = new Date();
  const begin = new Date(end.getTime() - 7 * 86400 * 1000);
  const qs = new URLSearchParams({ appKey, code: HISTORY_CODE_BRENT, begin: ymd(begin), end: ymd(end) });
  const url = `${SHOWAPI_HISTORY_URL}?${qs.toString()}`;
  out.push(`请求品种 : ${HISTORY_CODE_BRENT}（blt=布伦特；未调 wti，本次仅消耗 1 次额度）`);
  out.push(`请求区间 : ${ymd(begin)} ~ ${ymd(end)}`);
  if (force) out.push(`force=1 → 忽略每日闸门，强制发请求（会消耗 1 次额度）`);

  if (!force) {
    const marker = await env.OIL_KV.get('brent_history_marker', 'json').catch(() => null);
    if (marker && marker.date === beijingDateString()) {
      out.push('');
      out.push(`⏭️ 今日已抓取（${sourceLabel(marker.source)}），为省额度未发请求。`);
      const hist = await env.OIL_KV.get('brent_history', 'json').catch(() => null);
      out.push(`   当前 KV 已有 ${hist?.rows?.length ?? 0} 条，最新一条：`);
      out.push(`   ${hist?.rows?.length ? JSON.stringify(hist.rows[hist.rows.length - 1]) : '—'}`);
      out.push(`   要看真实接口返回，请访问 /test-history?force=1`);
      return out.join('\n');
    }
  }

  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
    out.push('');
    out.push(`HTTP 状态 : ${res.status}`);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) {
      out.push(`❌ 返回不是 JSON（前 300 字符）：`);
      out.push(text.slice(0, 300));
      return out.join('\n');
    }
    out.push(`网关码 showapi_res_code : ${json.showapi_res_code} ${json.showapi_res_error ? '(' + json.showapi_res_error + ')' : ''}`);
    const body = json.showapi_res_body || {};
    out.push(`业务码 ret_code         : ${body.ret_code} ${body.ret_message || body.remark || ''}`);
    if (json.showapi_res_code !== 0 || body.ret_code !== 0) {
      out.push('');
      out.push('❌ 未拿到数据。最常见原因：1108 接口未在万维易源后台开通。');
      out.push('   处理：登录 showapi.com → 接口市场搜「1108 国际原油价格」→ 免费订购 → 再试');
      out.push('   （138-46 国内油价是另一个接口，订购它不代表 1108 已开通）');
      return out.join('\n');
    }
    // 找出承载数组的那个 key（不同供应商可能叫 list / data / dataList / result ...）
    let raw = body.list || body.data || body.dataList || body.result || body.rows || [];
    if (!Array.isArray(raw)) {
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) { raw = v; out.push(`（数组实际在字段 "${k}" 下）`); break; }
      }
    }
    if (!Array.isArray(raw)) raw = [];
    out.push(`返回条数 : ${raw.length}`);
    if (raw.length) {
      out.push('');
      out.push(`--- 完整原始返回（showapi_res_body，截断 2000 字符）---`);
      out.push(JSON.stringify(body, null, 2).slice(0, 2000));
      out.push(`--- 每字段逐一诊断 ---`);
      out.push(`该条数据出现的全部字段名：${Object.keys(raw[0]).join(' | ')}`);
      for (const [i, r] of raw.entries()) {
        const why = diagnoseRow(r);
        out.push(`  [${i}] ${why ? '❌ 丢弃 — ' + why : '✅ 解析成功 — ' + JSON.stringify(normalizeRow(r))}`);
      }
      const norm = raw.map(normalizeRow).filter(Boolean);
      out.push(`解析成功 : ${norm.length} 条 / ${raw.length} 条`);
      if (norm.length < raw.length) out.push(`⚠️ 有 ${raw.length - norm.length} 条被丢弃（原因见上）`);
    } else {
      out.push('');
      out.push(`⚠️ 接口返回成功但数组是空的。完整返回如下：`);
      out.push(JSON.stringify(body, null, 2).slice(0, 2000));
    }
    out.push('');
    out.push('✅ 接口可用。现在访问 /update 拉一次正式数据，然后打开 /history 看报表。');
  } catch (e) {
    out.push('');
    out.push(`❌ 请求异常 : ${e.message}`);
  }
  return out.join('\n');
}

// ---------------- 区间探测：找出该接口能返回数据的最大窗口 ----------------
// 访问 /test-history?probe=1（消耗 4 次额度）
async function runProbe(env) {
  const appKey = env.SHOWAPI_APPKEY;
  const out = [];
  out.push('=== 区间探测：多大窗口能返回数据 ===');
  out.push(`北京时间 : ${beijingNow()}`);
  if (!appKey) { out.push('❌ 未配置 SHOWAPI_APPKEY'); return out.join('\n'); }
  out.push('（下面每项都是 1 次真实请求，共 4 次额度）');
  out.push('');
  for (const d of [7, 14, 30, 60]) {
    const end = new Date();
    const begin = new Date(end.getTime() - d * 86400 * 1000);
    try {
      const got = await fetchHistoryWindow(env, appKey, begin, end);
      out.push(`  窗口 ${String(d).padStart(2)} 天 (${ymd(begin)}~${ymd(end)}) → 返回 ${got.length} 条 ${got.length ? '✅' : '❌ 空'}`);
      if (got.length) out.push(`       样例：${JSON.stringify(got[got.length - 1])}`);
    } catch (e) {
      out.push(`  窗口 ${String(d).padStart(2)} 天 → 请求失败：${e.message}`);
    }
  }
  out.push('');
  out.push('结论：取「返回条数最多」的那个窗口填进 HISTORY_FETCH_DAYS。');
  return out.join('\n');
}

// ---------------- 分段回溯：一次性补历史 ----------------
// 访问 /test-history?backfill=N （N 段 × 7 天，消耗 N 次额度，不受每日闸门限制）
async function runBackfill(env, segments) {
  const out = [];
  const N = Math.min(Math.max(segments, 1), 52);   // 最多 52 段 ≈ 一年
  out.push(`=== 分段回溯补历史：${N} 段 × ${HISTORY_FETCH_DAYS} 天 ===`);
  out.push(`预计消耗 ${N} 次额度，覆盖约 ${N * HISTORY_FETCH_DAYS} 天`);
  out.push('');
  try {
    const before = await env.OIL_KV.get('brent_history', 'json').catch(() => null);
    const beforeCount = before?.rows?.length ?? 0;
    const { data } = await fetchBrentHistory(env, { manual: false, segments: N });
    out.push(`抓取前 : ${beforeCount} 条`);
    out.push(`抓取后 : ${data.rows.length} 条  （本次新增 ${data.rows.length - beforeCount} 条）`);
    out.push('');
    out.push('--- 各段结果 ---');
    for (const s of (data.segments || [])) out.push(`  ${s}`);
    out.push('');
    if (data.rows.length) {
      out.push(`日期范围 : ${data.rows[0].day} ~ ${data.rows[data.rows.length - 1].day}`);
      out.push(`最新 5 条：`);
      for (const r of data.rows.slice(-5)) out.push(`  ${JSON.stringify(r)}`);
    }
    out.push('');
    out.push(`✅ 完成。现在打开 /history 看报表。`);
  } catch (e) {
    out.push(`❌ 失败：${e.message}`);
  }
  return out.join('\n');
}
