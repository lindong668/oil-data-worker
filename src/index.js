export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const cached = await env.OIL_KV.get("brent_data", "json");
      // 有缓存读缓存（凌晨存的昨日结算价）；无缓存则实时抓
      const data = cached || await fetchAndSave(env, false);
      return new Response(generateHTML(data), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },

  // 凌晨 4 点自动触发：强制抓取，定为昨日结算价
  async scheduled(event, env) {
    await fetchAndSave(env, true);
  }
};

async function fetchAndSave(env, isScheduled) {
  // 直接读取你刚在后台设置的加密变量，无需硬编码
  const apiKey = env.OILPRICEAPI_KEY; 
  if (!apiKey) throw new Error("Missing OILPRICEAPI_KEY in env");
  
  const res = await fetch(`https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD`, {
    headers: { "Authorization": `Token ${apiKey}` }
  });
  const json = await res.json();
  const priceData = json.data;

  const result = {
    price: priceData.price,
    formatted: priceData.formatted,
    timestamp: priceData.timestamp, 
    updatedLocal: new Date().toLocaleString("zh-CN"),
    isSettlement: isScheduled, // 凌晨=true(结算价)，手动=false(实时价)
  };

  // 缓存 2 天，确保白天访问不消耗额外 API 额度
  await env.OIL_KV.put("brent_data", JSON.stringify(result), { expirationTtl: 86400 * 2 });
  return result;
}

function generateHTML(data) {
  const timeStr = data.timestamp ? new Date(data.timestamp).toLocaleString("zh-CN") : "未知";
  // 核心文案区分：凌晨抓=昨日收盘价，手动实时抓=盘中价
  const tag = data.isSettlement 
    ? "✅ 昨日 ICE 结算价（每日凌晨 04:00 更新）" 
    : "⚡ 实时最新价（盘中，手动刷新触发）";
  
  return `
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><title>布伦特原油每日参考价</title></head>
    <body style="font-family: sans-serif; padding: 40px; text-align: center;">
      <h1>布伦特原油 · 每日参考价</h1>
      <h2 style="color:#d35400; font-size: 48px;">${data.formatted || '$--'} <span style="font-size:24px">USD/桶</span></h2>
      <p><strong>${tag}</strong></p>
      <p style="color:#666; font-size:14px;">数据时间（UTC）：${timeStr}</p>
      <p style="color:#999; font-size:12px;">本页默认展示昨日收盘价（ICE结算价），手动刷新可看实时盘中价</p>
    </body></html>
  `;
}
