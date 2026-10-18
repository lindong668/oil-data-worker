export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 首页
    if (url.pathname === '/') {
      const [oilCached, goldCached] = await Promise.all([
        env.OIL_KV.get("oil_data", "json"),
        env.OIL_KV.get("gold_data", "json"),
      ]);

      const o = oilCached || await fetchAndSave(env, false);
      const g = goldCached || await fetchGoldAndSave(env);

      if (!o && !g) {
        return new Response('<h1>暂无数据</h1><p><a href="/update">点击更新</a></p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      const pricePerBarrel = o ? parseFloat(o.price) : null;
      const pricePerLiter = o ? (pricePerBarrel / 158.987).toFixed(4) : '—';
      const pricePerLiterCny = o ? (pricePerLiter * 7.2).toFixed(2) : '—';

      const oilUTC = o?.timestamp ? new Date(o.timestamp).toISOString() : '';
      const goldUTC = g?.updatedAt || '';
      const displayUTC = oilUTC || goldUTC;

      // 原油标签：区分自动(凌晨) 与 手动刷新
      const oilTag = o?.isSettlement
        ? "✅ 每日参考价（凌晨 04:00 自动抓取，结算参考）"
        : "⚡ 最新参考价（手动刷新，盘中最新）";

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>国际原油 & 黄金每日参考价</title>
<meta name="description" content="布伦特原油 $${pricePerBarrel || '—'} USD/桶，国际黄金 $${g?.priceUsdPerOz || '—'} USD/盎司，每日参考价">
</head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px">
<h1>📊 国际原油 & 黄金 · 每日参考价</h1>

${o ? `
<h2 style="margin-top:32px">🛢️ 布伦特原油</h2>
<p><strong>${oilTag}</strong></p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每桶价格</td><td style="padding:8px 0">$${pricePerBarrel} USD</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每升价格</td><td style="padding:8px 0">$${pricePerLiter} USD（≈ ¥${pricePerLiterCny} 元/升）</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据更新地时间</td><td style="padding:8px 0">${oilUTC} <span style="font-size:12px;color:#999">(UTC)</span></td></tr>
</table>` : ''}

${g ? `
<h2 style="margin-top:32px">🪙 国际黄金（XAU/USD）</h2>
<p><strong>📅 每日参考价（延迟日更，非盘中实时）</strong></p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每盎司价格</td><td style="padding:8px 0">$${g.priceUsdPerOz} USD/盎司</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每克价格</td><td style="padding:8px 0">≈ ¥${g.priceCnyPerGram} / 克</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据源</td><td style="padding:8px 0">MetalpriceAPI 免费档（延迟约24h）</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据更新地时间</td><td style="padding:8px 0">${goldUTC} <span style="font-size:12px;color:#999">(UTC)</span></td></tr>
</table>` : ''}

<p style="font-size:14px;color:#666">🕐 你的本地时间：<span id="localTime"></span> <span style="font-size:12px;color:#999" id="tz"></span></p>
<p style="font-size:12px;color:#aaa">以上为国际原料参考价，非零售汽油价 / 首饰金价。黄金为延迟日更参考价，不代表实时盘中报价。</p>
<p style="font-size:12px;color:#aaa"><a href="https://metalpriceapi.com" target="_blank" rel="noopener">Data provided by MetalpriceAPI</a> · <a href="/update">手动刷新</a> · <a href="/data">原始JSON</a></p>

<script>
  var d = new Date('${displayUTC}');
  document.getElementById('localTime').innerText = isNaN(d) ? '未知' : d.toLocaleString(undefined, {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  try { document.getElementById('tz').innerText = '(' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')'; } catch(e) {}
</script>
</body></html>`;

      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // /data
    if (url.pathname === '/data') {
      const [oil, gold] = await Promise.all([
        env.OIL_KV.get("oil_data"), env.OIL_KV.get("gold_data"),
      ]);
      return new Response(JSON.stringify({ oil: oil ? JSON.parse(oil) : null, gold: gold ? JSON.parse(gold) : null }, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // /update
    if (url.pathname === '/update') {
      const results = await Promise.allSettled([
        fetchAndSave(env, false), fetchGoldAndSave(env),
      ]);
      const oilOk = results[0].status === 'fulfilled';
      const goldOk = results[1].status === 'fulfilled';
      return new Response(`OK - 原油:${oilOk ? '成功' : '失败'} / 黄金:${goldOk ? '成功' : '失败'}`, { status: oilOk || goldOk ? 200 : 500 });
    }

    return new Response('Not Found', { status: 404 });
  },

  // 凌晨 4 点自动触发
  async scheduled(event, env) {
    await Promise.allSettled([fetchAndSave(env, true), fetchGoldAndSave(env)]);
  }
};

// ---------- 原油 ----------
async function fetchAndSave(env, isScheduled) {
  const apiKey = env.OILPRICEAPI_KEY;
  if (!apiKey) throw new Error("Missing OILPRICEAPI_KEY");
  const res = await fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD', {
    headers: { 'Authorization': `Token ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Oil API ${res.status}`);
  const json = await res.json();
  const p = json.data;
  const result = {
    price: p.price,
    formatted: p.formatted,
    timestamp: p.created_at || p.timestamp,
    updatedLocal: new Date().toLocaleString("zh-CN", { timeZone: 'Asia/Shanghai' }),
    isSettlement: isScheduled,   // 凌晨跑=true，手动=false
  };
  await env.OIL_KV.put("oil_data", JSON.stringify(result), { expirationTtl: 86400 * 2 });
  return result;
}

// ---------- 黄金（MetalpriceAPI 免费档，延迟日更）----------
async function fetchGoldAndSave(env) {
  const apiKey = env.METALPRICEAPI_KEY;
  if (!apiKey) throw new Error("Missing METALPRICEAPI_KEY");

  const res = await fetch(
    `https://api.metalpriceapi.com/v1/latest?api_key=${apiKey}&base=USD&currencies=XAU,CNY`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Gold API ${res.status}`);
  const j = await res.json();

  const usdPerOz = 1 / j.rates.XAU;                    // 1盎司美元价
  const cnyPerGram = +(usdPerOz / 31.1034768 * j.rates.CNY).toFixed(2); // 人民币/克

  const gold = {
    priceUsdPerOz: +usdPerOz.toFixed(2),
    priceCnyPerGram: cnyPerGram,
    updatedAt: j.date || new Date().toISOString(),
  };

  await env.OIL_KV.put("gold_data", JSON.stringify(gold), { expirationTtl: 86400 * 2 });
  return gold;
}
