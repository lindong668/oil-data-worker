// ============================================================
// 3 号 B18 — 自建开收盘判定（实测法，不依赖时区推算）
// ------------------------------------------------------------
// ★ 为什么要有这个文件
//
//   原来（B12 及以前）开收盘是「按交易所本地时区硬编码推算」：
//     isBrentTrading() → 伦敦 wd===6 休市、周日 hour>=23 开盘、hour<23 收盘
//     isWtiTrading()   → 芝加哥 wd===6 休市、周日 hour>=17 开盘、hour!==16 交易
//   这套是「我们相信市场应该是开着的」，不是「我们看到市场确实在成交」。
//
//   三个绕不开的坑：
//     ① 交易所假日（耶稣受难日 / 圣诞 / 元旦）代码完全不知道，照抓不误
//     ② 临时停盘、提前收盘，推算不出来
//     ③ 源一挂，当日开/高/低/收就整个没了 —— 我们手里没有自己的底账
//
// ★ 本文件的思路：反过来，用「价格有没有真的动」判定
//
//   市场开着 → 不断有新成交 → 价格会变
//   市场关着 → 源返回的永远是沿用值 → 价格冻结
//
//   所以：价格冻结多久 ≈ 市场关了多久。这条不依赖时区，
//   冬夏令时自动跟随（我们根本不看时钟）、假日自动识别（不开市就是不开市）。
//
// ★ 存哪：D1（SQLite）
//   为什么不存 KV —— 免费版 1,000 次写入/天，3 分钟粒度 960 次/天直接爆。
//   D1 免费版 10 万 rows written/天，960 行只占 1%。
//
// ★ 优雅降级：env.DB 没绑定时全部静默跳过，不影响现有任何功能。
//   没建 D1 也能正常部署，只是没有自建底账。
// ============================================================

// ---- 阈值（分钟）----
// 冻结 <= TRADING   → 判定交易中
// 冻结 TRADING~CLOSED → 防抖区，保持上一状态（不翻转）
// 冻结 > CLOSED     → 判定休市
// 冻结 > DAYEND     → 认定是「日收盘 / 周末」，不是日内结算窗口
const FROZEN_TRADING = 5;
const FROZEN_CLOSED = 25;
const FROZEN_DAYEND = 120;

// 价格「真变化」阈值：源有微小抖动，休市时也可能跳 0.01%
const CHANGE_EPS = 0.0001;

// ============================================================
// ★ B22：时间单位统一为「秒」
// ------------------------------------------------------------
// B18/B21 埋了个坑：三张表两种单位
//     tick_min.ts          秒
//     session_state.last_change_ts   毫秒  ← 不一样
//     session_log.open_ts/close_ts   秒
// 结果是去 D1 Studio 查的时候有的要 /1000 有的不要，迟早出错。
// 本版起全部统一成 Unix 秒，并在建表时自动把老库的毫秒数据转成秒。
// ============================================================

/** 毫秒和秒的分界：1e11 秒 = 公元 5138 年，1e11 毫秒 = 1973 年 */
const MS_THRESHOLD = 100000000000;

/** Unix 秒 → 可读时间字符串。offsetHours=8 即北京时间。 */
export function fmtTs(sec, offsetHours = 0) {
  const s = Number(sec);
  if (!isFinite(s) || s <= 0) return null;
  const d = new Date(s * 1000 + offsetHours * 3600000);
  // Workers 运行时 TZ 恒为 UTC，toISOString 一定是 UTC 基准，加偏移即可得目标时区
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ---- 建表（首次调用时执行，之后 IF NOT EXISTS 直接跳过）----
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tick_min (
     code TEXT NOT NULL,
     ts   INTEGER NOT NULL,
     price REAL NOT NULL,
     src  TEXT,
     PRIMARY KEY (code, ts)
   ) WITHOUT ROWID;`,
  `CREATE TABLE IF NOT EXISTS session_state (
     code TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     last_change_ts INTEGER NOT NULL,
     last_price REAL,
     cur_day TEXT,
     day_open REAL, day_high REAL, day_low REAL, day_close REAL,
     day_src TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS session_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     code TEXT NOT NULL,
     day TEXT NOT NULL,
     open_ts INTEGER, close_ts INTEGER,
     open_price REAL, close_price REAL,
     high REAL, low REAL,
     src TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS idx_session_log_code_day ON session_log(code, day);`,
  // ★ tick_min 是 WITHOUT ROWID 且主键就是 (code, ts)，再建一个 (code,ts) 索引
  //   纯属重复 —— 白占一倍存储、每次写入还要多维护一份。这里主动删掉
  //   （老库已建过的会被 DROP，新库 IF NOT EXISTS 直接跳过）。
  `DROP INDEX IF EXISTS idx_tick_min_code_ts;`,
  // ★ B22 迁移：老库 last_change_ts 是毫秒，统一转成秒。
  //   条件 > 1e11 保证只命中毫秒值（秒级现值约 1.7e9，永远 < 1e11）；
  //   已经是秒的行不会被碰，所以重复执行安全；没匹配行时 rows written = 0。
  `UPDATE session_state SET last_change_ts = CAST(last_change_ts / 1000 AS INTEGER)
     WHERE last_change_ts > ${MS_THRESHOLD};`,
];

// ---- 保留策略（天）----
// 分钟采样只用于「判定开收盘 + 当日兜底 OHLC」，用完就该扔。
// 留 7 天足够覆盖一个完整交易周 + 周末，再多就是纯占空间。
export const KEEP_TICK_DAYS = 7;
// 会话日志一行一天，极小（2 品种 × 365 ≈ 730 行/年），留 2 年做历史核对。
export const KEEP_LOG_DAYS = 730;

let schemaReady = false;

async function ensureSchema(env) {
  if (!env || !env.DB) return false;
  if (schemaReady) return true;
  try {
    for (const sql of SCHEMA) await env.DB.prepare(sql).run();
    schemaReady = true;
    return true;
  } catch (e) {
    return false;
  }
}

export function _resetSchemaCache() { schemaReady = false; }

/** 两个价格是否算「真的变了」 */
export function isRealChange(oldP, newP) {
  if (!oldP || !newP) return true;
  const a = Math.abs(Number(newP) - Number(oldP));
  return a / Math.abs(Number(oldP)) > CHANGE_EPS;
}

/**
 * 由状态推出当前会话判定（纯函数，好测）。
 * ★ B22：nowSec 和 st.last_change_ts 都是「秒」（B21 及以前这里用毫秒）
 * @param {number} nowSec 当前 Unix 秒
 * @returns {{state:'open'|'closed', frozenMin:number, dayEnd:boolean}}
 */
export function judgeFromState(st, nowSec) {
  const frozenMin = st && st.last_change_ts
    ? Math.floor((nowSec - Number(st.last_change_ts)) / 60)
    : 9999;
  let state;
  if (frozenMin <= FROZEN_TRADING) state = 'open';
  else if (frozenMin > FROZEN_CLOSED) state = 'closed';
  else state = (st && st.state) || 'closed';   // 防抖区：保持上一状态
  return { state, frozenMin, dayEnd: frozenMin > FROZEN_DAYEND };
}

/** 取某品种当前状态行 */
export async function getState(env, code) {
  if (!env || !env.DB) return null;
  try {
    return await env.DB.prepare(
      'SELECT * FROM session_state WHERE code = ?'
    ).bind(code).first();
  } catch (e) { return null; }
}

/**
 * 记一个采样点，并顺带判定开/收盘。
 *
 * 每次调用：1 次读 + 1~2 次写（都极小）。
 * 3 分钟粒度 · 2 品种 = 960 采样/天 ≈ 1,920 rows written = D1 免费额度的 1.9%。
 *
 * @returns {null|{state, frozenMin, dayEnd, event:'open'|'close'|'none'}}
 *   event='open'  本次检测到重新开盘（上一拍 closed，这拍价格动了）
 *   event='close' 本次检测到日收盘（冻结超过 DAYEND 且当天还没记过）
 */
export async function recordSample(env, code, price, src, now = new Date()) {
  if (!(await ensureSchema(env))) return null;
  const p = Number(price);
  if (!isFinite(p) || p <= 0) return null;
  const nowSec = Math.floor(now.getTime() / 1000);
  // 分钟取整，同一分钟重复调用覆盖同一行（幂等，不重复计费行数）
  const minSec = Math.floor(nowSec / 60) * 60;

  const st = await getState(env, code);
  const changed = !st || isRealChange(st.last_price, p);

  // ★ B22 兼容：万一还有老库残留的毫秒行，读进来先归一到秒，
  //   否则冻结时长会算成巨大负数/天文数字，判定直接错乱。
  const normTs = (v) => {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return n > MS_THRESHOLD ? Math.floor(n / 1000) : Math.floor(n);
  };

  // 写分钟采样（tick_min.ts 一直是秒，不变）
  try {
    await env.DB.prepare(
      'INSERT INTO tick_min (code, ts, price, src) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(code, ts) DO UPDATE SET price = excluded.price, src = excluded.src'
    ).bind(code, minSec, p, src || null).run();
  } catch (e) { /* 采样失败不阻断判定 */ }

  // ★ 两个时长要分开算（B22：全部用秒，除以 60 得分钟）：
  //   frozenBefore = 本次之前已经冻结多久（用来判断「是不是真的收盘过」）
  //   j.state      = 本次之后的状态（价格刚动过就该是 open，不能还报 closed）
  const frozenBefore = st && st.last_change_ts
    ? Math.floor((nowSec - normTs(st.last_change_ts)) / 60)
    : 9999;
  const effTs = changed ? nowSec : (st ? normTs(st.last_change_ts) : nowSec);
  const j = judgeFromState({ ...(st || {}), last_change_ts: effTs }, nowSec);
  let event = 'none';

  // ---- 重新开盘 ----
  // ★ 光看「上一拍 state=closed」不够：首次运行时 st 就是 closed，
  //   第二个采样点会被误判成重新开盘，把真正的开盘价冲掉。
  //   必须要求「确实冻结过 FROZEN_CLOSED 分钟以上」才算真收盘过，
  //   之后再有真变化，才是新一天开盘。
  if (changed && st && st.state === 'closed' && frozenBefore > FROZEN_CLOSED) {
    event = 'open';
  }

  // 状态行 upsert（★ B22：last_change_ts 一律写秒）
  const prevDay = st && st.cur_day ? st.cur_day : dayOf(nowSec, code);
  const next = {
    code,
    state: j.state,
    last_change_ts: changed ? nowSec : (st ? normTs(st.last_change_ts) : nowSec),
    last_price: p,
    cur_day: event === 'open' ? dayOf(nowSec, code) : prevDay,
    day_open:  (event === 'open' || !st) ? p : Number(st.day_open ?? p),
    day_high:  (event === 'open' || !st) ? p : Math.max(Number(st.day_high ?? p), p),
    day_low:   (event === 'open' || !st) ? p : Math.min(Number(st.day_low ?? p), p),
    day_close: p,
    day_src: src || (st && st.day_src) || null,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO session_state
         (code,state,last_change_ts,last_price,cur_day,day_open,day_high,day_low,day_close,day_src)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET
         state=excluded.state, last_change_ts=excluded.last_change_ts,
         last_price=excluded.last_price, cur_day=excluded.cur_day,
         day_open=excluded.day_open, day_high=excluded.day_high,
         day_low=excluded.day_low, day_close=excluded.day_close,
         day_src=excluded.day_src`
    ).bind(
      next.code, next.state, next.last_change_ts, next.last_price, next.cur_day,
      next.day_open, next.day_high, next.day_low, next.day_close, next.day_src
    ).run();
  } catch (e) { return null; }

  // ---- 日收盘：冻结超过 DAYEND，且当天还没记过 log ----
  // ★ st 必须已存在：首次运行（st 为 null）时 frozenMin 是 9999，
  //   若不加这个条件会当场误判成「收盘」并写一条空头 log。
  if (j.dayEnd && next.cur_day && st) {
    try {
      const dup = await env.DB.prepare(
        'SELECT id FROM session_log WHERE code = ? AND day = ? LIMIT 1'
      ).bind(code, next.cur_day).first();
      if (!dup) {
        await env.DB.prepare(
          `INSERT INTO session_log (code,day,open_ts,close_ts,open_price,close_price,high,low,src)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).bind(
          code, next.cur_day,
          // ★ B22：last_change_ts 已是秒，直接用（B21 这里还多除了一次 1000）
          next.last_change_ts, nowSec,
          next.day_open, next.day_close, next.day_high, next.day_low, next.day_src
        ).run();
        event = 'close';
      }
    } catch (e) { /* 记 log 失败不影响主流程 */ }
  }

  return { ...j, event };
}

/** 交易日（用市场本地日历，与现有报表口径保持一致） */
/** @param {number} nowSec Unix 秒（★ B22：B21 及以前这里收毫秒） */
function dayOf(nowSec, code) {
  const d = new Date(nowSec * 1000);
  const tz = code === 'wti' ? 'America/Chicago' : 'Europe/London';
  try {
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    if (s) return s;
  } catch (e) { /* 兜底 */ }
  return d.toISOString().slice(0, 10);
}

/**
 * 从自建分钟数据聚合出某交易日的 OHLC —— 源挂了就靠它兜底。
 * @returns {null|{day,open,high,low,close,samples,src:'self'}}
 */
export async function aggregateFromMinutes(env, code, day) {
  if (!(await ensureSchema(env))) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT open_price, close_price, high, low FROM session_log WHERE code = ? AND day = ? LIMIT 1'
    ).bind(code, day).first();
    if (row && row.open_price != null) {
      return {
        day, open: row.open_price, high: row.high, low: row.low,
        close: row.close_price, samples: 0, src: 'self',
      };
    }
    // log 还没有 → 退回按「当天」的分钟数据现算。
    // ★ 不能 SELECT 全部 ts：保留 7 天的话 open 会变成 7 天前那一笔。
    //   按 day 换算一个 ±14h 的 UTC 窗口，覆盖伦敦/芝加哥的时区偏移即可。
    const w = dayWindow(day);
    const rows = await env.DB.prepare(
      'SELECT price FROM tick_min WHERE code = ? AND ts >= ? AND ts < ? ORDER BY ts'
    ).bind(code, w.from, w.to).all();
    const all = (rows && rows.results) || [];
    if (!all.length) return null;
    let o = all[0].price, h = all[0].price, l = all[0].price, c = all[all.length - 1].price;
    for (const r of all) {
      const v = Number(r.price);
      if (v > h) h = v;
      if (v < l) l = v;
    }
    return { day, open: o, high: h, low: l, close: c, samples: all.length, src: 'self' };
  } catch (e) { return null; }
}

/** 'YYYY-MM-DD' → 覆盖该市场本地日的 UTC 秒窗口（前开后闭，多留 14h 余量） */
export function dayWindow(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  const base = m
    ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000
    : Math.floor(Date.now() / 1000);
  return { from: base - 14 * 3600, to: base + 38 * 3600 };
}

/**
 * 清掉某品种超过保留天数的分钟数据（防止无限膨胀）。
 * DELETE 也算 rows written，所以别天天跑 —— 建议每周一次。
 */
export async function pruneMinutes(env, code, keepDays = KEEP_TICK_DAYS) {
  if (!(await ensureSchema(env))) return 0;
  try {
    const cut = Math.floor(Date.now() / 1000) - keepDays * 86400;
    const r = await env.DB.prepare(
      'DELETE FROM tick_min WHERE code = ? AND ts < ?'
    ).bind(code, cut).run();
    return (r && r.meta && r.meta.changes) || 0;
  } catch (e) { return 0; }
}

/** 清掉超过保留天数的会话日志（一行一天，量极小，主要防多年累积） */
export async function pruneLogs(env, keepDays = KEEP_LOG_DAYS) {
  if (!(await ensureSchema(env))) return 0;
  try {
    const cut = new Date(Date.now() - keepDays * 86400000)
      .toISOString().slice(0, 10);
    const r = await env.DB.prepare(
      'DELETE FROM session_log WHERE day < ?'
    ).bind(cut).run();
    return (r && r.meta && r.meta.changes) || 0;
  } catch (e) { return 0; }
}

/**
 * ★ 自动保留：由收盘定格那条 cron 每天带一次，不用你手动点。
 *   D1 满了不会自动清，写不进去就是硬失败，所以必须自己兜。
 *   DELETE 没匹配到行时 rows written = 0，天天跑也不花额度。
 */
export async function runRetention(env) {
  if (!(await ensureSchema(env))) return null;
  const out = {};
  for (const c of ['brent', 'wti']) {
    out[c] = {
      ticks: await pruneMinutes(env, c, KEEP_TICK_DAYS),
    };
  }
  out.logs = await pruneLogs(env, KEEP_LOG_DAYS);
  return out;
}

/** 给前端/调试看：当前判定 + 最近会话 */
export async function sessionSnapshot(env, code, now = new Date()) {
  if (!(await ensureSchema(env))) return null;
  const st = await getState(env, code);
  if (!st) return null;
  // ★ B22：judgeFromState 收秒
  const nowSec = Math.floor(now.getTime() / 1000);
  const j = judgeFromState(st, nowSec);
  let logs = [];
  try {
    const r = await env.DB.prepare(
      'SELECT day,open_ts,close_ts,open_price,close_price,high,low FROM session_log WHERE code = ? ORDER BY id DESC LIMIT 5'
    ).bind(code).all();
    logs = (r && r.results) || [];
  } catch (e) { /* 忽略 */ }
  return {
    code,
    state: j.state,
    frozenMin: j.frozenMin,
    dayEnd: j.dayEnd,
    lastPrice: st.last_price,
    curDay: st.cur_day,
    // ★ B22：全部补可读时间，省得去 Studio 写 SQL
    now: { utc: fmtTs(nowSec, 0), beijing: fmtTs(nowSec, 8) },
    lastChange: { utc: fmtTs(st.last_change_ts, 0), beijing: fmtTs(st.last_change_ts, 8) },
    day: {
      open: st.day_open, high: st.day_high, low: st.day_low, close: st.day_close,
    },
    recent: logs.map(l => ({
      day: l.day,
      openTs: l.open_ts, closeTs: l.close_ts,
      openUtc: fmtTs(l.open_ts, 0), openBeijing: fmtTs(l.open_ts, 8),
      closeUtc: fmtTs(l.close_ts, 0), closeBeijing: fmtTs(l.close_ts, 8),
      open: l.open_price, close: l.close_price, high: l.high, low: l.low,
    })),
  };
}

/**
 * 库容量体检：给 /db-stats 用。
 * 返回各表行数 + 粗估体积，让你一眼看到离 5 GB 上限还有多远。
 */
export async function dbStats(env) {
  if (!(await ensureSchema(env))) return null;
  const q = async (sql) => {
    try {
      const r = await env.DB.prepare(sql).first();
      return r ? Number(r.n || 0) : 0;
    } catch (e) { return -1; }
  };
  const ticks = await q('SELECT COUNT(*) AS n FROM tick_min');
  const logs = await q('SELECT COUNT(*) AS n FROM session_log');
  const states = await q('SELECT COUNT(*) AS n FROM session_state');
  // 粗估：WITHOUT ROWID 行约 40 字节 + 页开销，按 64 字节/行保守计
  const bytes = Math.max(0, ticks) * 64 + Math.max(0, logs) * 96 + Math.max(0, states) * 160;

  // ---- ★ B22：可读时间 ----
  // 以前要在 D1 Studio 手写 SQL 才能看清时间，而且三张表单位还不统一
  // （tick 是秒、state 是毫秒），一不留神就写错。这里直接算好返回。
  const nowSec = Math.floor(Date.now() / 1000);

  // tick_min 的采样时间跨度
  let tickRange = null;
  try {
    const r = await env.DB.prepare(
      'SELECT MIN(ts) AS a, MAX(ts) AS b, COUNT(*) AS n FROM tick_min'
    ).first();
    if (r && r.a != null && r.b != null) {
      tickRange = {
        count: Number(r.n || 0),
        fromUtc: fmtTs(r.a, 0), fromBeijing: fmtTs(r.a, 8),
        toUtc: fmtTs(r.b, 0), toBeijing: fmtTs(r.b, 8),
        spanHours: Math.round((Number(r.b) - Number(r.a)) / 36) / 100,
        freshnessSec: nowSec - Number(r.b),
      };
    }
  } catch (e) { /* 表不存在等，忽略 */ }

  // session_state 每行：状态 + 上次价格变动的可读时间
  let stateRows = [];
  try {
    const r = await env.DB.prepare(
      'SELECT code,state,last_change_ts,last_price,cur_day,' +
      'day_open,day_high,day_low,day_close,day_src FROM session_state'
    ).all();
    stateRows = ((r && r.results) || []).map(x => ({
      code: x.code,
      state: x.state,
      curDay: x.cur_day,
      lastPrice: x.last_price,
      lastChangeUtc: fmtTs(x.last_change_ts, 0),
      lastChangeBeijing: fmtTs(x.last_change_ts, 8),
      frozenMin: Math.floor((nowSec - Number(x.last_change_ts)) / 60),
      day: {
        open: x.day_open, high: x.day_high, low: x.day_low,
        close: x.day_close, src: x.day_src,
      },
    }));
  } catch (e) { /* 忽略 */ }

  // session_log 最近 10 条：实测开收盘时刻
  let recentSessions = [];
  try {
    const r = await env.DB.prepare(
      'SELECT code,day,open_ts,close_ts,open_price,close_price,high,low,src ' +
      'FROM session_log ORDER BY id DESC LIMIT 10'
    ).all();
    recentSessions = ((r && r.results) || []).map(l => ({
      code: l.code,
      day: l.day,
      src: l.src,
      openUtc: fmtTs(l.open_ts, 0), openBeijing: fmtTs(l.open_ts, 8),
      closeUtc: fmtTs(l.close_ts, 0), closeBeijing: fmtTs(l.close_ts, 8),
      open: l.open_price, close: l.close_price, high: l.high, low: l.low,
    }));
  } catch (e) { /* 忽略 */ }

  return {
    ok: true,
    // ★ 统一说明：所有 ts / *_ts 字段一律 Unix 秒
    timeUnit: 'unix_seconds',
    now: { unixSec: nowSec, utc: fmtTs(nowSec, 0), beijing: fmtTs(nowSec, 8) },
    rows: { tick_min: ticks, session_log: logs, session_state: states },
    estBytes: bytes,
    estMB: Math.round((bytes / 1048576) * 100) / 100,
    limitGB: 5,
    usedPct: Math.round((bytes / (5 * 1073741824)) * 10000) / 10000,
    keepTickDays: KEEP_TICK_DAYS,
    tickRange,
    states: stateRows,
    recentSessions,
    note: 'tick_min 每天自动清到保留窗口；触及 5GB 后写入会直接失败（D1 不会自动删）。' +
          '所有 *_ts 均为 Unix 秒，Utc/Beijing 为换算好的可读时间。',
  };
}

export const _thresholds = { FROZEN_TRADING, FROZEN_CLOSED, FROZEN_DAYEND, CHANGE_EPS };
