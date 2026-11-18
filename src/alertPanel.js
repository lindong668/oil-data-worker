/* =====================================================================
 * B30：可视化通知开关面板（纯静态 HTML + 原生 JS，不引任何外部资源）
 *
 * 设计要点：
 *   · 页面本体不含任何数据、不含密钥；所有读写都带 ?key= 调后端接口
 *   · 第一次带 ?key= 打开后，密钥记进 localStorage，之后收藏这个地址即可
 *   · 开关调用 /alert-switch（B29 既有端点），配置调用 /alert-config（B30 新增）
 *   · 关掉 = 后端在 cron 入口直接 return，页面只是把状态显示出来，不参与判定
 * ===================================================================== */

export function renderAlertPanel() {
  const L = [];
  L.push('<!doctype html>');
  L.push('<html lang="zh-CN">');
  L.push('<head>');
  L.push('<meta charset="utf-8">');
  L.push('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
  L.push('<meta name="robots" content="noindex,nofollow,noarchive">');
  L.push('<title>邮件通知开关 · 3号原油后端</title>');
  L.push('<style>');
  L.push('*{box-sizing:border-box}');
  L.push('body{margin:0;padding:16px;background:#f5f6f8;color:#1c1f23;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}');
  L.push('.box{max-width:520px;margin:0 auto}');
  L.push('h1{font-size:20px;margin:0 0 4px}');
  L.push('.sub{color:#777;font-size:13px;margin:0 0 18px}');
  L.push('.card{background:#fff;border-radius:14px;padding:16px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}');
  L.push('.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #f0f1f3}');
  L.push('.row:last-child{border-bottom:0}');
  L.push('.name{font-weight:600;font-size:16px}');
  L.push('.desc{font-size:12px;color:#888;margin-top:2px}');
  L.push('.sw{position:relative;width:54px;height:30px;flex:0 0 54px}');
  L.push('.sw input{opacity:0;width:0;height:0;position:absolute}');
  L.push('.track{position:absolute;inset:0;background:#d6d9de;border-radius:30px;transition:.2s;cursor:pointer}');
  L.push('.track:before{content:"";position:absolute;width:24px;height:24px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2)}');
  L.push('.sw input:checked + .track{background:#16a34a}');
  L.push('.sw input:checked + .track:before{transform:translateX(24px)}');
  L.push('.pill{display:inline-block;font-size:12px;padding:2px 9px;border-radius:20px;background:#eef0f3;color:#666;margin-left:6px}');
  L.push('.pill.on{background:#e7f7ec;color:#15803d}');
  L.push('.pill.off{background:#f2f3f5;color:#888}');
  L.push('.tip{font-size:13px;color:#8a6d3b;background:#fff8e6;border:1px solid #f5e2b0;border-radius:10px;padding:10px 12px;margin-bottom:14px;display:none}');
  L.push('.tip.show{display:block}');
  L.push('.kv{font-size:13px;color:#555}');
  L.push('.kv b{color:#1c1f23;font-weight:600}');
  L.push('pre{margin:8px 0 0;background:#f7f8fa;border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-all;color:#444}');
  L.push('button.act{width:100%;border:0;border-radius:10px;padding:12px;font-size:15px;font-weight:600;background:#1c1f23;color:#fff;cursor:pointer;margin-top:10px}');
  L.push('button.act:active{opacity:.8}');
  L.push('button.act.ghost{background:#eef0f3;color:#333;font-weight:500}');
  L.push('details{margin-top:12px}');
  L.push('summary{font-size:14px;color:#444;cursor:pointer;padding:6px 0}');
  L.push('label{display:block;font-size:12px;color:#777;margin:10px 0 4px}');
  L.push('input.txt{width:100%;border:1px solid #dfe2e6;border-radius:8px;padding:10px;font-size:14px;background:#fff}');
  L.push('.ok{color:#15803d}.bad{color:#b91c1c}');
  L.push('.foot{text-align:center;font-size:12px;color:#aaa;margin:18px 0 6px}');
  L.push('</style>');
  L.push('</head>');
  L.push('<body>');
  L.push('<div class="box">');
  L.push('<h1>邮件通知开关</h1>');
  L.push('<p class="sub">3 号原油后端 · 福建油价 / 现货黄金</p>');
  L.push('<div id="tip" class="tip"></div>');

  L.push('<div class="card">');
  L.push('<div class="row">');
  L.push('<div><div class="name">福建油价 <span id="p-f" class="pill">读取中</span></div><div class="desc">92 / 95 / 98 / 0号柴油任一变动才发，没调价静默</div></div>');
  L.push('<label class="sw"><input type="checkbox" id="sw-f" disabled><span class="track"></span></label>');
  L.push('</div>');
  L.push('<div class="row">');
  L.push('<div><div class="name">现货黄金 <span id="p-g" class="pill">读取中</span></div><div class="desc">打开期间每 3 分钟有变动就发一封，测完记得关</div></div>');
  L.push('<label class="sw"><input type="checkbox" id="sw-g" disabled><span class="track"></span></label>');
  L.push('</div>');
  L.push('<button class="act ghost" id="btn-refresh">刷新状态</button>');
  L.push('</div>');

  L.push('<div class="card">');
  L.push('<div class="kv" id="stat">读取中…</div>');
  L.push('<pre id="raw" style="display:none"></pre>');
  L.push('</div>');

  L.push('<div class="card">');
  L.push('<button class="act" id="btn-test">发一封测试邮件</button>');
  L.push('<details>');
  L.push('<summary>发信设置（存 KV，以后部署不会掉）</summary>');
  L.push('<label>Resend API Key（留空 = 不修改）</label>');
  L.push('<input class="txt" id="cfg-key" type="password" placeholder="re_..." autocomplete="off">');
  L.push('<label>收件邮箱</label>');
  L.push('<input class="txt" id="cfg-to" type="email" placeholder="366190089@qq.com">');
  L.push('<label>发件地址（必须是 Resend 已验证域）</label>');
  L.push('<input class="txt" id="cfg-from" type="text" placeholder="oil@you.599568.xyz">');
  L.push('<button class="act" id="btn-save">保存设置</button>');
  L.push('<div class="kv" id="cfgstat" style="margin-top:10px"></div>');
  L.push('</details>');
  L.push('</div>');

  L.push('<div class="foot">关掉开关后，后台在下一拍直接跳过，不会再发任何邮件</div>');
  L.push('</div>');

  // ---------------- 页面脚本（用数组拼，避免模板字符串与外层冲突） ----------------
  const J = [];
  J.push('(function(){');
  J.push('var qs = new URLSearchParams(location.search);');
  J.push('var KEY = qs.get("key") || localStorage.getItem("oil_alert_key") || "";');
  J.push('if (qs.get("key")) localStorage.setItem("oil_alert_key", qs.get("key"));');
  J.push('function tip(m){ var e=document.getElementById("tip"); e.textContent=m; e.className = m ? "tip show" : "tip"; }');
  J.push('function api(path, opt){');
  J.push('  var sep = path.indexOf("?") >= 0 ? "&" : "?";');
  J.push('  return fetch(path + sep + "key=" + encodeURIComponent(KEY), opt).then(function(r){ return r.json(); });');
  J.push('}');
  J.push('function pill(id, on){ var e=document.getElementById(id); e.textContent = on ? "已开" : "已关"; e.className = "pill " + (on ? "on" : "off"); }');
  J.push('function render(sw, st, cfg){');
  J.push('  document.getElementById("sw-f").checked = !!sw.fujian;');
  J.push('  document.getElementById("sw-g").checked = !!sw.gold;');
  J.push('  document.getElementById("sw-f").disabled = false;');
  J.push('  document.getElementById("sw-g").disabled = false;');
  J.push('  pill("p-f", sw.fujian); pill("p-g", sw.gold);');
  J.push('  var c = (st && st.current) || null;');
  J.push('  var price = c ? ("92 " + (c.p92||"—") + " / 95 " + (c.p95||"—") + " / 98 " + (c.p98||"—") + " / 0# " + (c.p0||"—")) : "—";');
  J.push('  var g = (st && st.goldAlert) || (sw.goldAlert) || {};');
  J.push('  var lines = [];');
  J.push('  lines.push("<b>福建当前价</b>：" + price);');
  J.push('  lines.push("<b>油价上次状态</b>：" + ((st && st.lastStatus) || "—"));');
  J.push('  lines.push("<b>黄金上次发信</b>：" + (g.lastMailedAt || "—") + "　" + (g.lastStatus || ""));');
  J.push('  lines.push("<b>油价心跳</b>：" + ((st && st.lastHeartbeat) || "—"));');
  J.push('  document.getElementById("stat").innerHTML = lines.join("<br>");');
  J.push('  var cp = (cfg && cfg.configPresent) || {};');
  J.push('  var mk = (cfg && cfg.masked) || {};');
  J.push('  document.getElementById("cfgstat").innerHTML =');
  J.push('    "配置来源：<b>" + (cfg && cfg.source ? cfg.source : "—") + "</b><br>" +');
  J.push('    "Key " + (cp.RESEND_API_KEY ? "<span class=ok>已配</span>" : "<span class=bad>缺失</span>") + " " + (mk.resend||"") + "<br>" +');
  J.push('    "收件 " + (cp.ALERT_MAIL_TO ? "<span class=ok>已配</span>" : "<span class=bad>缺失</span>") + " " + (mk.to||"") + "<br>" +');
  J.push('    "发件 " + (cp.ALERT_MAIL_FROM ? "<span class=ok>已配</span>" : "<span class=bad>缺失</span>") + " " + (mk.from||""));');
  J.push('}');
  J.push('function load(){');
  J.push('  if (!KEY){ tip("请先用带 ?key= 的地址打开本页，或填一次访问密钥"); return; }');
  J.push('  return Promise.all([');
  J.push('    api("/alert-switch"),');
  J.push('    api("/oil-alert-status"),');
  J.push('    api("/alert-config")');
  J.push('  ]).then(function(a){');
  J.push('    var sw = a[0] || {}, st = a[1] || {}, cfg = a[2] || {};');
  J.push('    render(sw.switches || {}, st, cfg);');
  J.push('    document.getElementById("raw").textContent = JSON.stringify({switches:sw.switches, goldAlert:sw.goldAlert, note:sw.note}, null, 2);');
  J.push('    tip("");');
  J.push('  }).catch(function(e){ tip("读取失败：" + e.message + "（检查访问密钥）"); });');
  J.push('}');
  J.push('function toggle(type, on){');
  J.push('  tip("正在切换…");');
  J.push('  api("/alert-switch?type=" + type + "&on=" + (on ? "1" : "0")).then(function(r){');
  J.push('    tip(r.note || "已切换");');
  J.push('    return load();');
  J.push('  }).catch(function(e){ tip("切换失败：" + e.message); });');
  J.push('}');
  J.push('document.getElementById("sw-f").addEventListener("change", function(e){ toggle("fujian", e.target.checked); });');
  J.push('document.getElementById("sw-g").addEventListener("change", function(e){ toggle("gold", e.target.checked); });');
  J.push('document.getElementById("btn-refresh").addEventListener("click", function(){ tip(""); load(); });');
  J.push('document.getElementById("btn-test").addEventListener("click", function(){');
  J.push('  tip("正在发测试邮件…");');
  J.push('  api("/oil-alert-test").then(function(r){');
  J.push('    tip(r.ok ? "测试邮件已发出，去收件箱（QQ 邮箱看一眼垃圾箱）" : ("发送失败：" + (r.result && r.result.error || "配置没配齐")));');
  J.push('    load();');
  J.push('  }).catch(function(e){ tip("请求失败：" + e.message); });');
  J.push('});');
  J.push('document.getElementById("btn-save").addEventListener("click", function(){');
  J.push('  var body = {');
  J.push('    resend: document.getElementById("cfg-key").value.trim(),');
  J.push('    to: document.getElementById("cfg-to").value.trim(),');
  J.push('    from: document.getElementById("cfg-from").value.trim()');
  J.push('  };');
  J.push('  if (!body.resend && !body.to && !body.from){ tip("三栏都空着，没有要保存的内容"); return; }');
  J.push('  tip("正在保存…");');
  J.push('  api("/alert-config", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)})');
  J.push('    .then(function(r){ tip(r.ok ? "已存进 KV，以后部署不会再掉" : ("保存失败：" + (r.error||"未知"))); document.getElementById("cfg-key").value=""; load(); })');
  J.push('    .catch(function(e){ tip("保存失败：" + e.message); });');
  J.push('});');
  J.push('load();');
  J.push('})();');

  L.push('<script>');
  L.push(J.join('\n'));
  L.push('</script>');
  L.push('</body>');
  L.push('</html>');
  return L.join('\n');
}
