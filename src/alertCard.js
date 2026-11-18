/* =====================================================================
 * B32：邮件通知开关【服务端直接渲染进数据看板首页】
 *
 *   · 打开页面就能看见「已开 / 已关」并立刻能点 —— 不依赖任何前端异步请求，
 *     彻底根治 B30/B31 那个「读取中…」永久卡死、按钮一直禁用的毛病。
 *   · 没有独立面板页、没有第二个地址；旧独立面板路由已整个删除。
 *   · 前端 JS 只在【用户点击时】才发请求；请求失败只回滚 + 提示，
 *     绝不把开关禁用、绝不把状态改回「读取中」。
 *   · 卡片里不输出任何密钥，只输出「通道已配 / 未配齐」。
 * ===================================================================== */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[c]);
}

export function renderAlertCard(opts) {
  const o = opts || {};
  const sw = o.switches || { fujian: true, gold: false };
  const cfg = o.config || {};
  const fj = o.fujian || null;
  const gold = o.gold || null;
  const oil = o.oil || null;

  const pill = (id, on) =>
    `<span id="${id}" class="alc-pill ${on ? 'on' : 'off'}">${on ? '已开' : '已关'}</span>`;
  const checked = (on) => (on ? ' checked' : '');

  const price = fj
    ? `92 ${esc(fj.p92 || '—')} / 95 ${esc(fj.p95 || '—')} / 98 ${esc(fj.p98 || '—')} / 0# ${esc(fj.p0 || '—')}`
    : '—';
  const channel = (cfg.RESEND_API_KEY && cfg.ALERT_MAIL_TO && cfg.ALERT_MAIL_FROM)
    ? '<span style="color:#15803d">通道已配</span>'
    : '<span style="color:#b91c1c">通道未配齐（面板 RESEND_API_KEY 别删）</span>';

  const lines = [
    `<b>福建当前价</b>：${price}`,
    `<b>油价上次状态</b>：${esc((oil && oil.lastStatus) || '—')}`,
    `<b>黄金上次发信</b>：${esc((gold && gold.lastMailedAt) || '—')}　${esc((gold && gold.lastStatus) || '')}`,
    `<b>油价心跳</b>：${esc((oil && oil.lastHeartbeat) || '—')}`,
    `<b>发信通道</b>：${channel}`,
  ];

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
  L.push(`<div><div class="alc-name">福建油价 ${pill('alc-p-f', sw.fujian)}</div><div class="alc-desc">92 / 95 / 98 / 0号柴油任一变动才发，没调价静默</div></div>`);
  L.push(`<label class="alc-sw"><input type="checkbox" id="alc-f"${checked(sw.fujian)}><span class="alc-track"></span></label>`);
  L.push('</div>');
  L.push('<div class="alc-row">');
  L.push(`<div><div class="alc-name">现货黄金 ${pill('alc-p-g', sw.gold)}</div><div class="alc-desc">打开后每 3 分钟有变动就发一封，测完记得关</div></div>`);
  L.push(`<label class="alc-sw"><input type="checkbox" id="alc-g"${checked(sw.gold)}><span class="alc-track"></span></label>`);
  L.push('</div>');
  L.push(`<div class="alc-stat" id="alc-stat">${lines.join('<br>')}</div>`);
  L.push('<div class="alc-tip" id="alc-tip"></div>');
  L.push('<div class="alc-btns"><button id="alc-test">发一封测试邮件</button><button class="ghost" id="alc-refresh">刷新</button></div>');
  L.push('<div class="alc-foot">关掉 = 立刻停发，后台下一拍直接跳过。开关状态存 KV，重新部署不会被清掉。</div>');
  L.push('</div>');

  /* 前端：初始不请求任何接口。只在点击时请求；失败回滚，永不禁用、永不「读取中」。 */
  const J = [];
  J.push('(function(){');
  J.push('var KEY=new URLSearchParams(location.search).get("key")||"";');
  J.push('function tip(m){var e=document.getElementById("alc-tip");if(!e)return;e.textContent=m||"";e.className=m?"alc-tip show":"alc-tip";}');
  J.push('function pill(id,on){var e=document.getElementById(id);if(!e)return;e.textContent=on?"已开":"已关";e.className="alc-pill "+(on?"on":"off");}');
  J.push('function api(p){');
  J.push('  var s=p.indexOf("?")>=0?"&":"?";');
  J.push('  var ctl=new AbortController(),t=setTimeout(function(){ctl.abort();},6000);');
  J.push('  return fetch(p+s+"key="+encodeURIComponent(KEY),{signal:ctl.signal})');
  J.push('    .then(function(r){clearTimeout(t);if(!r.ok)throw new Error("HTTP "+r.status);return r.json();});');
  J.push('}');
  J.push('function toggle(type,el,pid){');
  J.push('  var want=el.checked;pill(pid,want);tip("正在切换…");');
  J.push('  api("/alert-switch?type="+type+"&on="+(want?"1":"0"))');
  J.push('    .then(function(r){');
  J.push('      var sw=(r&&r.switches)||{};var on=type==="fujian"?!!sw.fujian:!!sw.gold;');
  J.push('      el.checked=on;pill(pid,on);tip((r&&r.note)||"已切换");');
  J.push('    })');
  J.push('    .catch(function(e){el.checked=!want;pill(pid,!want);tip("切换失败（已还原）："+e.message+"，开关仍可再点");});');
  J.push('}');
  J.push('var f=document.getElementById("alc-f"),g=document.getElementById("alc-g");');
  J.push('if(f)f.addEventListener("change",function(){toggle("fujian",f,"alc-p-f");});');
  J.push('if(g)g.addEventListener("change",function(){toggle("gold",g,"alc-p-g");});');
  J.push('var rf=document.getElementById("alc-refresh");');
  J.push('if(rf)rf.addEventListener("click",function(){');
  J.push('  tip("正在刷新…");');
  J.push('  Promise.all([api("/oil-alert-status"),api("/alert-config")])');
  J.push('    .then(function(a){var st=a[0]||{},cfg=a[1]||{},c=st.current||null,sw=st.switches||{};');
  J.push('      if(sw&&typeof sw.fujian==="boolean"){f.checked=sw.fujian;pill("alc-p-f",sw.fujian);}');
  J.push('      if(sw&&typeof sw.gold==="boolean"){g.checked=sw.gold;pill("alc-p-g",sw.gold);}');
  J.push('      var s=document.getElementById("alc-stat");');
  J.push('      if(s){var cp=(cfg&&cfg.configPresent)||{};');
  J.push('        var ch=(cp.RESEND_API_KEY&&cp.ALERT_MAIL_TO&&cp.ALERT_MAIL_FROM)?\'<span style="color:#15803d">通道已配</span>\':\'<span style="color:#b91c1c">通道未配齐</span>\';');
  J.push('        var price=c?("92 "+(c.p92||"—")+" / 95 "+(c.p95||"—")+" / 98 "+(c.p98||"—")+" / 0# "+(c.p0||"—")):"—";');
  J.push('        s.innerHTML="<b>福建当前价</b>："+price+"<br><b>油价上次状态</b>："+(st.lastStatus||"—")+"<br><b>油价心跳</b>："+(st.lastHeartbeat||"—")+"<br><b>发信通道</b>："+ch;}');
  J.push('      tip("已刷新");');
  J.push('    })');
  J.push('    .catch(function(e){tip("刷新失败（开关状态保持原样）："+e.message);});');
  J.push('});');
  J.push('var tb=document.getElementById("alc-test");');
  J.push('if(tb)tb.addEventListener("click",function(){');
  J.push('  tip("正在发测试邮件…");');
  J.push('  api("/oil-alert-test")');
  J.push('    .then(function(r){tip(r&&r.ok?"测试邮件已发出，去收件箱（QQ 邮箱看一眼垃圾箱）":("发送失败："+((r&&r.result&&r.result.error)||"通道未配齐")));})');
  J.push('    .catch(function(e){tip("请求失败："+e.message);});');
  J.push('});');
  J.push('})();');

  L.push('<script>');
  L.push(J.join('\n'));
  L.push('</script>');
  return L.join('\n');
}
