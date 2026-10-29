/* B11 测试：3号原油多源链路 —— 沙盒无外网，用 mock 验证解析与回退逻辑 */
import fs from 'fs';
const src = fs.readFileSync('./src/index.js','utf8');
let pass=0, fail=0;
const chk=(n,c)=>{ c?pass++:(fail++,console.log('  NG  '+n)); };

console.log('==== B11 多源链路 ====');

/* ---- 结构检查 ---- */
chk('已删掉旧的单源调用（fetchOilJson 不再被 fetchAndSave 使用）',
    !/const \{ json, mode \} = await fetchOilJson\(apiKey\)/.test(src));
chk('fetchAndSave 改用 fetchOilMulti', /const live = await fetchOilMulti\(apiKey\)/.test(src));
chk('源顺序与 2 号一致（biquote → yahoo → yahoo2 → stooq → oilpriceapi）',
    /\['biquote'/.test(src) && /\['yahoo'/.test(src) && /\['yahoo2'/.test(src)
    && /\['stooq'/.test(src) && /\['oilpriceapi'/.test(src));
chk('OilPriceAPI 降级为兜底（排在最后）',
    src.indexOf("['oilpriceapi'") > src.indexOf("['stooq'"));
chk('布伦特与 WTI 都取自同一个 live 结果',
    /const brentPrice = Number\(live\.brent\)/.test(src) && /const wtiPrice\s*=\s*Number\(live\.wti\)/.test(src));
chk('记录实际生效的源（provider）', /provider: live\.provider \|\| null/.test(src));
chk('保留 /clear-history 供重建报表', src.includes('/clear-history'));

/* ---- 真实执行：抽出 oilSrcBiquote 验证取中值 ---- */
const fnRange = (name) => {
  const i = src.indexOf('async function ' + name);
  if (i < 0) throw new Error('未找到 ' + name);
  let depth = 0, j = src.indexOf('{', i);
  let k = j;
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
};

const mkFetch = (map) => async (u) => {
  const s = String(u);
  for (const [key, val] of Object.entries(map)) {
    if (s.includes(key)) {
      if (val instanceof Error) throw val;
      return { ok: true, json: async () => val, text: async () => JSON.stringify(val) };
    }
  }
  throw new Error('未预期的请求: ' + s);
};

/* biquote：取 bid/ask 中值 */
{
  const code = fnRange('oilSrcBiquote');
  const fn = new Function('oilGetJson', 'return ' + code.replace(/^async function oilSrcBiquote\(\)/, 'async function()'));
  globalThis.fetch = mkFetch({
    'XTIUSD': { bid: 102.98, ask: 103.06 },
    'XBRUSD': { bid: 110.64, ask: 110.76 },
  });
  const g = async (u) => {
    const s = String(u);
    const v = s.includes('XTIUSD') ? { bid:102.98, ask:103.06 } : { bid:110.64, ask:110.76 };
    return v;
  };
  const r = await fn(g)();
  chk('★ biquote 布伦特取买卖中值 110.70', Math.abs(r.brent - 110.70) < 0.001);
  chk('★ biquote WTI 取买卖中值 103.02', Math.abs(r.wti - 103.02) < 0.001);
  chk('biquote 标注 provider', r.provider === 'biquote');
}

/* yahoo：解析 meta.regularMarketPrice */
{
  const code = fnRange('oilSrcYahoo');
  const fn = new Function('oilGetJson', 'return ' + code.replace(/^async function oilSrcYahoo\(host\)/, 'async function(host)'));
  const g = async (u) => {
    const s = String(u);
    const p = s.includes('BZ=F') ? 111.91 : 102.55;
    return { chart: { result: [ { meta: { regularMarketPrice: p } } ] } };
  };
  const r = await fn(g)('query1.finance.yahoo.com');
  chk('★ yahoo 解析出布伦特 111.91', Math.abs(r.brent - 111.91) < 0.001);
  chk('★ yahoo 解析出 WTI 102.55', Math.abs(r.wti - 102.55) < 0.001);
  chk('yahoo 标注 provider', r.provider === 'yahoo');
}

/* stooq：解析 CSV */
{
  const code = fnRange('oilSrcStooq');
  const fn = new Function('fetch','OIL_UA', 'return ' + code.replace(/^async function oilSrcStooq\(\)/, 'async function()'));
  const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\nCB.F,2026-10-28,22:00,111.20,112.40,110.90,111.85,12345\nCL.F,2026-10-28,22:00,102.10,103.30,101.80,102.97,23456\n';
  globalThis.fetch = async () => ({ ok: true, text: async () => csv });
  const r = await fn(globalThis.fetch,'UA')();
  chk('★ stooq 解析出布伦特 111.85', Math.abs(r.brent - 111.85) < 0.001);
  chk('★ stooq 解析出 WTI 102.97', Math.abs(r.wti - 102.97) < 0.001);
}

/* 回退：主源失败 → 换下一个 */
{
  const code = fnRange('fetchOilMulti');
  const fn = new Function('oilSrcBiquote','oilSrcYahoo','oilSrcYahoo2','oilSrcStooq','oilSrcOilPriceApi','OIL_CODES','OIL_LATEST_BASE','pickQuote','BRENT_CODE','WTI_CODE',
    'return ' + code.replace(/^async function fetchOilMulti\(apiKey\)/, 'async function(apiKey)'));
  const fail = async () => { throw new Error('源挂了'); };
  const okSrc = async () => ({ brent: 111.85, wti: 102.97, provider: 'stooq' });
  const r = await fn(fail, fail, fail, okSrc, fail)('k');
  chk('★ 前三个源全挂时自动回退到 stooq', r.provider === 'stooq');
  chk('★ 回退后仍取到正确价格', Math.abs(r.brent - 111.85) < 0.001);
  /* 全部失败 → 抛错 */
  let threw = false;
  try { await fn(fail, fail, fail, fail, fail)('k'); } catch (e) { threw = true; }
  chk('★ 全部源失败时抛出错误（不静默写脏数据）', threw);
}

console.log('\n  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
