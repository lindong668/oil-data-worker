/* =====================================================================
 * B31：通知开关【直接嵌进数据看板首页】，不再有独立面板页、不再要收藏第二个地址。
 *
 *   · 只导出 renderAlertCard()：一段自包含 HTML+CSS+JS，插在首页 <h1> 下面
 *   · 页面 JS 自动从当前地址栏取 ?key=（首页本来就带），用户不用记任何参数
 *   · 所有读写走既有 /alert-switch、/oil-alert-status、/alert-config、/oil-alert-test
 *   · 关掉 = 后端在 cron 入口直接 return；页面只显示状态，不参与判定
 *   · 不显示、不修改任何密钥；不要求用户填写任何东西
 * ===================================================================== */

export function renderAlertCard() {
  const L = [];
  L.push('<style>');
  L.push('.alc-card{max-width:640px;margin:18px 0 26px;padding:14px 16px;border:1px solid #e3e6ea;border-radius:12px;background:#fff;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1c1f23;box-shadow:0 1px 3px rgba(0,0,0,.04)}');
  L.push('.alc-hd{font-size:16px;font-weight:700;margin-bottom:2px}');
  L.push('.alc-hint{font-size:12px;font-weight:400;color:#999;margin-left:8px}');
  L.push('.alc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #f0f1f3}');
  L.push('.alc-row:last-of-type{border-bottom:0}');
  L.push('.alc-name{font-weight:600;font-size:15px}');
  L.push('.alc-desc{font-size:12px;color:#888;margin-top:2px}');
  L.push('.alc-pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:20px;background:#eef0f3;color:#666;margin-left:6px;vertical-align:middle}');
  L.push('.alc-pill.on{background:#e7f7ec;color:#15803d}');
  L.push('.alc-pill.off{background:#f2f3f5;color:#888}');
  L.push('.alc-sw{position:relative;width:52px;height:29px;flex:0 0 52px}');
  L.push('.alc-sw input{opacity:0;width:0;height:0;position:absolute}');
  L.push('.alc-track{position:absolute;inset:0;background:#d6d9de;border-radius:30px;transition:.2s;cursor:pointer}');
  L.push('.alc-track:before{content:"";position:absolute;width:23px;height:23px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2)}');
  L.push('.alc-sw input:checked + .alc-track{background:#16a34a}');
  L.push('.alc-sw input:checked + .alc-track:before{transform:translateX(23px)}');
  L.push('.alc-sw input:disabled + .alc-track{opacity:.55;cursor:default}');
  L.push('.alc-stat{font-size:12px;color:#666;background:#f7f8fa;border-radius:8px;padding:9px 11px;margin-top:10px;word-break:break-all}');
  L.push('.alc-tip{font-size:12px;color:#8a6d3b;background:#fff8e6;border:1px solid #f5e2b0;border-radius:8px;padding:8px 10px;margin-top:9px;display:none}');
  L.push('.alc-tip.show{display:block}');
  L.push('.alc-btns{display:flex;gap:8px;margin-top:10px}');
  L.push('.alc-btns button{flex:1;border:0;border-radius:9px;padding:10px;font-size:14px;font-weight:600;background:#1c1f23;color:#fff;cursor:pointer}');
  L.push('.alc-btns button.ghost{background:#eef0f3;color:#333;font-weight:500;flex:0 0 88px}');
  L.push('.alc-btns button:active{opacity:.8}');
  L.push('.alc-foot{font-size:12px;color:#aaa;margin-top:9px}');
  L.push('</style>');

  L.push('<div class="alc-card" id="alc-card">');
  L.push('<div class="alc-hd">✉️ 邮件通知开关 <span class="alc-hint">就在这页，不用另存地址</span></div>');
  L.push('<div class="alc-row">');
  L.push('<div><div class="alc-name">福建油价 <span id="alc-p-f" class="alc-pill">读取中</span></div><div class="alc-desc">92 / 95 / 98 / 0号柴油任一变动才发，没调价静默</div></div>');
  L.push('<label class="alc-sw"><input type="checkbox" id="alc-f" disabled><span class="alc-track"></span></label>');
  L.push('</div>');
  L.push('<div class="alc-row">');
  L.push('<div><div class="alc-name">现货黄金 <span id="alc-p-g" class="alc-pill">读取中</span></div><div class="alc-desc">打开后每 3 分钟有变动就发一封，测完记得关</div></div>');
  L.push('<label class="alc-sw"><input type="checkbox" id="alc-g" disabled><span class="alc-track"></span></label>');
  L.push('</div>');
  L.push('<div class="alc-stat" id="alc-stat">读取中…</div>');
  L.push('<div class="alc-tip" id="alc-tip"></div>');
  L.push('<div class="alc-btns"><button id="alc-test">发一封测试邮件</button><button class="ghost" id="alc-refresh">刷新</button></div>');
  L.push('<div class="alc-foot">关掉 = 立刻停发，后台下一拍直接跳过。开关状态存 KV，重新部署不会被清掉。</div>');
  L.push('</div>');

  const J = [];
  J.push('(function(){');
  J.push('var KEY = new URLSearchParams(location.search).get("key") || "";');
  J.push('function alcTip(m){var e=document.getElementById("alc-tip");e.textContent=m;e.className=m?"alc-tip show":"alc-tip";}');
  J.push('function alcApi(p,opt){var s=p.indexOf("?")>=0?"&":"?";return fetch(p+s+"key="+encodeURIComponent(KEY),opt).then(function(r){return r.json();});}');
  J.push('function alcPill(id,on){var e=document.getElementById(id);e.textContent=on?"已开":"已关";e.className="alc-pill "+(on?"on":"off");}');
  J.push('function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c];});}');
  J.push('function alcRender(sw,st,cfg){');
  J.push('  document.getElementById("alc-f").checked=!!sw.fujian;');
  J.push('  document.getElementById("alc-g").checked=!!sw.gold;');
  J.push('  document.getElementById("alc-f").disabled=false;');
  J.push('  document.getElementById("alc-g").disabled=false;');
  J.push('  alcPill("alc-p-f",sw.fujian);alcPill("alc-p-g",sw.gold);');
  J.push('  var c=(st&&st.current)||null;');
  J.push('  var price=c?("92 "+(c.p92||"—")+" / 95 "+(c.p95||"—")+" / 98 "+(c.p98||"—")+" / 0# "+(c.p0||"—")):"—";');
  J.push('  var g=(st&&st.goldAlert)||(sw.goldAlert)||{};');
  J.push('  var cp=(cfg&&cfg.configPresent)||{};');
  J.push('  var ch=(cp.RESEND_API_KEY&&cp.ALERT_MAIL_TO&&cp.ALERT_MAIL_FROM)?\'<span style="color:#15803d">通道已配</span>\':\'<span style="color:#b91c1c">通道未配齐（检查面板 RESEND_API_KEY）</span>\';');
  J.push('  var lines=[];');
  J.push('  lines.push("<b>福建当前价</b>："+esc(price));');
  J.push('  lines.push("<b>油价上次状态</b>："+esc((st&&st.lastStatus)||"—"));');
  J.push('  lines.push("<b>黄金上次发信</b>："+esc(g.lastMailedAt||"—")+"　"+esc(g.lastStatus||""));');
  J.push('  lines.push("<b>油价心跳</b>："+esc((st&&st.lastHeartbeat)||"—"));');
  J.push('  lines.push("<b>发信通道</b>："+ch);');
  J.push('  document.getElementById("alc-stat").innerHTML=lines.join("<br>");');
  J.push('}');
  J.push('function alcLoad(){');
  J.push('  if(!KEY){alcTip("请用你平时那个带 ?key= 的首页地址打开");return;}');
  J.push('  return Promise.all([alcApi("/alert-switch"),alcApi("/oil-alert-status"),alcApi("/alert-config")])');
  J.push('    .then(function(a){var sw=a[0]||{},st=a[1]||{},cfg=a[2]||{};');
  J.push('      alcRender(sw.switches||{},st,cfg);alcTip("");})');
  J.push('    .catch(function(e){alcTip("读取失败："+e.message+"（检查访问密钥）");});');
  J.push('}');
  J.push('function alcToggle(type,on){');
  J.push('  alcTip("正在切换…");');
  J.push('  alcApi("/alert-switch?type="+type+"&on="+(on?"1":"0")).then(function(r){');
  J.push('    alcTip(r.note||"已切换");return alcLoad();})');
  J.push('    .catch(function(e){alcTip("切换失败："+e.message);});');
  J.push('}');
  J.push('document.getElementById("alc-f").addEventListener("change",function(e){alcToggle("fujian",e.target.checked);});');
  J.push('document.getElementById("alc-g").addEventListener("change",function(e){alcToggle("gold",e.target.checked);});');
  J.push('document.getElementById("alc-refresh").addEventListener("click",function(){alcTip("");alcLoad();});');
  J.push('document.getElementById("alc-test").addEventListener("click",function(){');
  J.push('  alcTip("正在发测试邮件…");');
  J.push('  alcApi("/oil-alert-test").then(function(r){');
  J.push('    alcTip(r.ok?"测试邮件已发出，去收件箱（QQ 邮箱看一眼垃圾箱）":("发送失败："+((r.result&&r.result.error)||"通道未配齐")));');
  J.push('    alcLoad();}).catch(function(e){alcTip("请求失败："+e.message);});');
  J.push('});');
  J.push('alcLoad();');
  J.push('})();');

  L.push('<script>');
  L.push(J.join('\n'));
  L.push('</script>');
  return L.join('\n');
}

/* 兼容：旧地址 /alert-panel 不再渲染第二个页面，由 index.js 直接 302 回首页。
   保留这个空导出，避免任何外部引用报错。 */
export function renderAlertPanel() {
  return '<!doctype html><meta charset="utf-8"><title>已移到首页</title><p>开关已移到首页，正在跳转…</p>';
}
