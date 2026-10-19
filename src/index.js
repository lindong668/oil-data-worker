/**
 * oil-data-worker  v2
 * ---------------------------------------------------------------
 * v2 改动（针对「手动刷新拉不到新数据」问题）：
 *  1. 原油：抓取时一并记录 stale（沿用值标记）与 as_of（源观测时间），
 *     并在 /update、/data、首页展示，能区分「没抓到」与「抓到了但源未刷新」。
 *  2. 黄金：加每日抓取闸门 —— 定时任务无条件抓；手动刷新每天最多生效 1 次，
 *     且当天定时任务已抓过就直接跳过，保护 MetalpriceAPI 月度配额。
 *  3. 所有响应加 Cache-Control: no-store，避免中间缓存导致「点了没真发出去」。
 * ---------------------------------------------------------------
 */

const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

/** 黄金手动刷新每日上限（保护月度配额，1 = 每天最多手动抓 1 次） */
const GOLD_MANUAL_MAX_PER_DAY = 1;

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
<p style="font-size:12px;color:#aaa"><a href="https://metalpriceapi.com" target="_blank" rel="noopener">Data provided by MetalpriceAPI</a> · <a href="/update">手动刷新</a> · <a href="/data">原始JSON</a></p>

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
      const [oil, gold, cn, marker] = await Promise.all([
        env.OIL_KV.get('oil_data', 'json'),
        env.OIL_KV.get('gold_data', 'json'),
        env.OIL_KV.get('cn_oil_data', 'json'),
        env.OIL_KV.get('gold_fetch_marker', 'json'),
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
      }, null, 2), { headers: JSON_HEADERS });
    }

    // ---------------- /update ----------------
    if (url.pathname === '/update') {
      const results = await Promise.allSettled([
        fetchAndSave(env, false),
        fetchGoldAndSave(env, { manual: true }),
        fetchCnOilAll(env),
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
        cnDetail = `    省份数 : ${cnR.value.list?.length ?? 0}   数据源 : ${cnR.value.source}`;
      } else if (cnR.status === 'rejected') {
        cnDetail = `    原因 : ${cnR.reason?.message || cnR.reason}`;
      }

      const txt = `${line('原油', oilR)}
${oilDetail}

${line('黄金', goldR)}
${goldDetail}

${line('国内油价', cnR)}
${cnDetail}

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

async function fetchCnOilAll(env) {
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
  return result;
}
