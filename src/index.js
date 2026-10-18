export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 首页：HTML 展示（含桶转升）
    if (url.pathname === '/') {
      let html = '<h1>加载中...</h1>';
      const data = await env.OIL_KV.get('oil_data');
      
      if (data) {
        const d = JSON.parse(data);
        const pricePerBarrel = parseFloat(d.data.price);
        const pricePerLiter = (pricePerBarrel / 158.987).toFixed(4);
        const pricePerLiterCny = (pricePerLiter * 7.2).toFixed(2);
        const time = d.data.created_at ? new Date(d.data.created_at).toLocaleString('zh-CN') : '未知';

        html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>布伦特原油价格 - ${pricePerBarrel} USD/桶</title>
<meta name="description" content="布伦特原油实时价格 ${pricePerBarrel} 美元/桶，约合 ${pricePerLiter} 美元/升（${pricePerLiterCny} 元/升估算）">
</head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 20px">
<h1>🛢️ 布伦特原油实时价格</h1>
<table style="width:100%;border-collapse:collapse;margin:20px 0">
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每桶价格</td><td style="padding:8px 0;font-weight:bold;font-size:18px">$${pricePerBarrel} USD</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">每升价格</td><td style="padding:8px 0">$${pricePerLiter} USD（≈ ¥${pricePerLiterCny} 元/升）</td></tr>
<tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">数据时间</td><td style="padding:8px 0">${time}</td></tr>
</table>
<p style="font-size:14px;color:#999">以上为国际原油原料价（1桶=158.987升），非零售汽油价格。数据每24小时自动更新。</p>
<p style="font-size:14px;color:#999"><a href="/update">手动刷新数据</a> · <a href="/data">查看原始JSON</a></p>
</body></html>`;
      } else {
        html = '<h1>暂无数据</h1><p><a href="/update">点击更新数据</a></p>';
      }
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // /data：原始 JSON
    if (url.pathname === '/data') {
      const data = await env.OIL_KV.get('oil_data');
      if (!data) return new Response('暂无数据', { status: 200 });
      return new Response(data, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // /update：拉取真实 API 数据存入 KV
    if (url.pathname === '/update') {
      try {
        const apiUrl = 'https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD';
        const res = await fetch(apiUrl, {
          headers: { 'Authorization': `Token ${env.OILPRICEAPI_KEY}` }
        });
        if (!res.ok) return new Response(`API失败: ${res.status}`, { status: 500 });

        const json = await res.json();
        await env.OIL_KV.put('oil_data', JSON.stringify(json));
        return new Response('OK - 数据已更新');
      } catch (e) {
        return new Response('Error: ' + e.message, { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};
