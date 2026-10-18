export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 首页：HTML 展示（含桶转升 + 结算/实时标注）
    if (url.pathname === '/') {
      const cached = await env.OIL_KV.get("oil_data", "json");
      const data = cached || await fetchAndSave(env, false);
      
      let html = '<h1>加载中...</h1>';
      if (data) {
        const pricePerBarrel = parseFloat(data.price);
        const pricePerLiter = (pricePerBarrel / 158.987).toFixed(4);
        const pricePerLiterCny = (pricePerLiter * 7.2).toFixed(2);
        // ✅ 修复：优先用 created_at，兼容 timestamp
        const time = data.timestamp 
          ? new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) 
          : (data.updatedLocal || '未知');

        const tag = data.isSettlement 
          ? "✅ 昨日 ICE 结算价（每日凌晨 04:00 自动更新）" 
          : "⚡ 实时最新价（盘中，手动刷新触发）";

        html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>布伦特原油价格 - ${pricePerBarrel} USD/桶</title>
<meta name="description" content="布伦特原油每日参考价 ${pricePerBarrel} 美元/桶，约合 ${pricePerLiter} 美元/升（${pricePerLiterCny} 元/升估算）">
</head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 20px">
<h1>🛢️ 布伦特原油 · 每日参考价</h1>
<h2 style="color:#d35400; font-size: 36px;">$${pricePerBarrel} <span style="font-size:18px">USD/桶</span></h2>
<p><strong>${tag}</strong></p>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每升价格</td><td style="padding:8px 0">$${pricePerLiter} USD（≈ ¥${pricePerLiterCny} 元/升）</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据时间</td><td style="padding:8px 0">${time}</td></tr>
</table>
<p style="font-size:14px;color:#999">以上为国际原油原料价（1桶=158.987升），非零售汽油价格。默认展示昨日收盘价，手动刷新可看实时盘中价。</p>
<p style="font-size:14px;color:#999"><a href="/update">手动刷新实时价</a> · <a href="/data">查看原始JSON</a></p>
</body></html>`;
      } else {
        html = '<h1>暂无数据</h1><p><a href="/update">点击更新数据</a></p>';
      }
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // /data：原始 JSON
    if (url.pathname === '/data') {
      const data = await env.OIL_KV.get("oil_data");
      if (!data) return new Response('暂无数据', { status: 200 });
      return new Response(data, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // /update：手动拉取实时价
    if (url.pathname === '/update') {
      await fetchAndSave(env, false);
      return new Response('OK - 实时数据已更新（盘中价）');
    }

    return new Response('Not Found', { status: 404 });
  },

  // 凌晨 4 点自动触发
  async scheduled(event, env) {
    await fetchAndSave(env, true);
  }
};

async function fetchAndSave(env, isScheduled) {
  const apiKey = env.OILPRICEAPI_KEY; 
  if (!apiKey) throw new Error("Missing OILPRICEAPI_KEY in env");
  
  const apiUrl = 'https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD';
  const res = await fetch(apiUrl, {
    headers: { 'Authorization': `Token ${apiKey}` }
  });
  if (!res.ok) throw new Error(`API失败: ${res.status}`);
  
  const json = await res.json();
  const priceData = json.data;

  const result = {
    price: priceData.price,
    formatted: priceData.formatted,
    // ✅ 修复：用 created_at（API 实际返回的字段），兜底 timestamp
    timestamp: priceData.created_at || priceData.timestamp,
    updatedLocal: new Date().toLocaleString("zh-CN", { timeZone: 'Asia/Shanghai' }),
    isSettlement: isScheduled,
  };

  await env.OIL_KV.put("oil_data", JSON.stringify(result), { expirationTtl: 86400 * 2 });
  return result;
}
