const axios = require('axios');
const iconv = require('iconv-lite');

// 内存缓存字典，避免短时间内高频轮询打爆天天基金和新浪接口
// 结构: { key: { data, timestamp } }
const cache = {
  fund: {},
  fundHistory: {},
  fundBasic: {},
  fundHoldings: {},
  market: null,
  marketTimestamp: 0,
  gold: null,
};

// 名称搜索单独存（结构: { 'fund:<q>': { data: [...], timestamp } }）
const searchCache = {};

// 缓存过期时间
const FUND_CACHE_TTL = 30 * 1000;         // 基金估值缓存 30秒
const FUND_HISTORY_TTL = 60 * 60 * 1000;  // 基金历史净值缓存 1小时
const FUND_BASIC_TTL = 60 * 60 * 1000;    // 基金基本/资产配置缓存 1小时
const FUND_HOLDINGS_TTL = 60 * 60 * 1000; // 基金持仓缓存 1小时
const MARKET_CACHE_TTL = 10 * 1000;       // 大盘指数缓存 10秒
const SEARCH_CACHE_TTL = 5 * 60 * 1000;   // 名称搜索缓存 5分钟
const GOLD_CACHE_TTL = 30 * 1000;         // 金价缓存 30秒

/**
 * 转换 JSONP 为 JSON 对象
 */
function parseJsonp(jsonpStr) {
  try {
    const startIdx = jsonpStr.indexOf('(');
    const endIdx = jsonpStr.lastIndexOf(')');
    if (startIdx !== -1 && endIdx !== -1) {
      const jsonStr = jsonpStr.substring(startIdx + 1, endIdx);
      return JSON.parse(jsonStr);
    }
  } catch (e) {
    console.error('解析JSONP失败:', e);
  }
  return null;
}

/**
 * 智能识别 code 类型并路由到对应数据源
 *   - 6 位 + 60/68/00/30/8 开头 → A 股个股（Sina sh/sz/bj）
 *   - 6 位其他 → A 股基金（fundgz）
 *   - 5 位数字（00700、09988 等）→ 港股（Sina rt_hk）
 *   - 1-5 位字母 → 美股 ticker（Sina gb_）
 *   - 含 "HK"/"hk" 前缀 → 港股
 *   - 含 "US"/"us" 前缀 → 美股
 */
function detectCodeKind(code) {
  if (!code) return 'unknown';
  const c = code.trim().toUpperCase();
  if (/^\d{6}$/.test(c)) {
    // A 股个股：仅 60/68/68 严格前缀 → 个股；00/30/8 模糊（基金常见）→ 当基金
    if (/^(60|68)/.test(c)) return 'stock_a';
    return 'fund_a';                                          // 其他 6 位按基金处理
  }
  if (/^(HK|RT_HK)?\d{4,5}$/.test(c)) return 'fund_hk';     // 港股 5 位
  if (/^(US|GB)?[A-Z]{1,5}$/.test(c)) return 'fund_us';     // 美股 ticker
  if (/^[A-Z]{1,5}$/.test(c)) return 'fund_us';             // 默认按美股
  return 'unknown';
}

/**
 * 判断给定的基金/股票代码当前是否在交易时段内。
 * 用于非交易时段停止邮件提醒的场景。
 *
 * 交易时段（不含节假日 — 交易所休市日历每年变动，按真实时段过滤即可）：
 *   - A 股 (stock_a / fund_a):  周一-周五 北京 9:30-11:30, 13:00-15:00
 *   - 港股 (fund_hk):         周一-周五 香港 9:30-12:00, 13:00-16:00
 *   - 美股 (fund_us / QDII):  周一-周五 纽约 9:30-16:00（Intl 自动夏/冬令时）
 *   - 其它/未知:               默认全天 true（保守，不阻断未知品种）
 *
 * @param {string} code  基金/股票代码
 * @param {Date}   [now] 可选：当前时间（便于测试；默认 new Date()）
 * @param {string} [market] 可选：显式传入 market ('domestic'|'hk'|'us'|'other')
 * @returns {boolean}
 */
function isInTradingTime(code, now, market) {
  let kind = detectCodeKind(code || '');
  if (market === 'us') kind = 'fund_us';
  else if (market === 'hk') kind = 'fund_hk';
  else if (market === 'domestic') kind = 'fund_a';

  if (kind === 'unknown') return true;

  let tz, sessions;
  if (kind === 'stock_a' || kind === 'fund_a') {
    tz = 'Asia/Shanghai';
    sessions = [
      [9 * 60 + 30, 11 * 60 + 30],   // 9:30-11:30  上午
      [13 * 60,    15 * 60],          // 13:00-15:00 下午
    ];
  } else if (kind === 'fund_hk') {
    tz = 'Asia/Hong_Kong';
    sessions = [
      [9 * 60 + 30, 12 * 60],        // 9:30-12:00
      [13 * 60,    16 * 60],          // 13:00-16:00
    ];
  } else if (kind === 'fund_us') {
    tz = 'America/New_York';
    sessions = [
      [9 * 60 + 30, 16 * 60],         // 9:30-16:00
    ];
  } else {
    return true;
  }

  const date = now || new Date();
  // 用 Intl 取目标时区的 weekday + hour/minute；hourCycle h23 保证 00-23 而非 "24:00"
  let weekday, hourStr, minuteStr;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    weekday = m.weekday;
    hourStr = m.hour;
    minuteStr = m.minute;
  } catch {
    return true;   // Intl 不可用时保守放行
  }

  // 周六周日 → 非交易
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true;

  const nowMin = hour * 60 + minute;
  return sessions.some(([s, e]) => nowMin >= s && nowMin < e);
}

/**
 * A 股个股实时行情（Sina hq.sinajs.cn）
 *   - sh6xxxxx / sh68xxx  → 上海主板 / 科创板
 *   - sz00xxxx / sz30xxx  → 深圳主板 / 创业板
 *   - bj8xxxxx             → 北交所
 *   字段：name(0,GBK) | open(1) | prev_close(2) | current(3) | high(4) | low(5) |
 *         bid1(6) | ask1(7) | volume(8) | turnover(9) | ... | date(30) | time(31)
 */
async function fetchASHareStockValuation(code) {
  const c = code.toUpperCase();
  let symbol = c;
  if (/^\d{6}$/.test(c)) {
    if (c.startsWith('60') || c.startsWith('68')) symbol = 'sh' + c;
    else if (c.startsWith('00') || c.startsWith('30')) symbol = 'sz' + c;
    else if (c.startsWith('8')) symbol = 'bj' + c;
    else return null;
  } else {
    return null;
  }
  const url = `http://hq.sinajs.cn/list=${symbol.toLowerCase()}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Referer': 'http://finance.sina.com.cn' },
    timeout: 5000
  });
  const text = iconv.decode(Buffer.from(response.data), 'gbk');
  const m = text.match(/="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split(',');
  if (parts.length < 32) return null;
  const name = parts[0];
  if (!name) return null;
  const open = parseFloat(parts[1]);
  const prevClose = parseFloat(parts[2]);
  const current = parseFloat(parts[3]);
  if (isNaN(current) || current <= 0) return null;
  const high = parseFloat(parts[4]);
  const low = parseFloat(parts[5]);
  const volume = parseFloat(parts[8]);          // 手
  const turnover = parseFloat(parts[9]);       // 元
  const date = parts[30];
  const time = parts[31];
  const change = isNaN(prevClose) ? 0 : current - prevClose;
  const changePct = isNaN(prevClose) || prevClose <= 0 ? 0 : (change / prevClose) * 100;
  // 昨收/今开/最新（数据规整为统一字段）
  // 顶层额外平铺 open（个股今开），便于前端直接读取而无需进 stockSpecific
  const openVal = isNaN(open) ? null : open;
  return {
    fundcode: c,
    name,
    jzrq: date || '',                          // 日期字段复用为交易日期
    dwjz: isNaN(prevClose) ? '0' : prevClose.toFixed(4),  // 昨收
    gsz: current.toFixed(4),                   // 现价
    gszzl: changePct.toFixed(2),               // 涨跌幅%
    gztime: date && time ? `${date} ${time}` : (date || ''),
    market: c.startsWith('BJ') || symbol.startsWith('bj') ? 'other' : 'domestic',
    open: openVal === null ? undefined : openVal.toFixed(4),
    stockSpecific: {
      open: openVal,
      high: isNaN(high) ? null : high,
      low: isNaN(low) ? null : low,
      volume: isNaN(volume) ? null : volume,
      turnover: isNaN(turnover) ? null : turnover,
      change: isNaN(change) ? 0 : change,
    }
  };
}

/**
 * 通过 Sina 行情接口获取港股实时数据
 *   接口：hq.sinajs.cn/list=rt_hk{code}
 *   返回：fundcode=code, name=中文名, gsz=现价, dwjz=昨收, gszzl=涨跌幅(%), gztime=行情时间
 */
async function fetchHKStockValuation(code) {
  const symbol = code.toLowerCase().replace(/^rt_hk/, '').replace(/^hk/, '');
  const url = `http://hq.sinajs.cn/list=rt_hk${symbol}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Referer': 'http://finance.sina.com.cn' },
    timeout: 5000
  });
  const text = iconv.decode(Buffer.from(response.data), 'gbk');
  // var hq_str_rt_hk00700="TENCENT,腾讯控股,465.600,461.600,481.800,465.600,477.800,16.200,3.510,..."
  const m = text.match(/="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split(',');
  if (parts.length < 10) return null;
  // Sina 港股 rt_hk 接口字段顺序（实测 00700）：
  //   parts[0]=nameEn, parts[1]=nameZh, parts[2]=prevClose,
  //   parts[3]=open, parts[4]=high, parts[5]=low, parts[6]=current,
  //   parts[7]=change, parts[8]=changePct, parts[9]=bid1, parts[10]=ask1,
  //   parts[11]=turnover(元), parts[12]=volume(股), parts[17]=date, parts[18]=time
  const nameEn = parts[0];
  const nameZh = parts[1];
  const prevClose = parseFloat(parts[2]);
  const openVal = parseFloat(parts[3]);
  const highVal = parseFloat(parts[4]);
  const lowVal  = parseFloat(parts[5]);
  const current = parseFloat(parts[6]);
  const change = parseFloat(parts[7]);
  const changePct = parseFloat(parts[8]);
  const turnoverVal = parseFloat(parts[11]);
  const volumeVal = parseFloat(parts[12]);
  const date = parts[17];    // YYYY/MM/DD
  const time = parts[18];    // HH:MM:SS
  if (isNaN(current) || current <= 0) return null;
  return {
    fundcode: code.toUpperCase(),
    name: `${nameZh} (${nameEn})`,
    jzrq: date ? date.replace(/\//g, '-') : '',
    dwjz: isNaN(prevClose) || prevClose <= 0 ? '0' : prevClose.toFixed(4),
    gsz: current.toFixed(4),
    gszzl: isNaN(changePct) ? '0' : changePct.toFixed(2),
    gztime: date && time ? `${date.replace(/\//g, '-')} ${time}` : '',
    market: 'hk',
    open: isNaN(openVal) || openVal <= 0 ? undefined : openVal.toFixed(4),
    stockSpecific: {
      open: isNaN(openVal) || openVal <= 0 ? null : openVal,
      high: isNaN(highVal) || highVal <= 0 ? null : highVal,
      low:  isNaN(lowVal)  || lowVal  <= 0 ? null : lowVal,
      volume: isNaN(volumeVal) || volumeVal < 0 ? null : volumeVal,
      turnover: isNaN(turnoverVal) || turnoverVal < 0 ? null : turnoverVal,
      change: isNaN(change) ? 0 : change,
    }
  };
}

/**
 * 通过 Sina 行情接口获取美股实时数据
 *   接口：hq.sinajs.cn/list=gb_{ticker}
 *   返回字段：name(0)=中文, open(5), prev_close(7), current(1), change(4), change_pct(2), datetime(25)
 */
async function fetchUSStockValuation(ticker) {
  const symbol = ticker.toLowerCase().replace(/^gb_/, '').replace(/^us/, '');
  const url = `http://hq.sinajs.cn/list=gb_${symbol}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Referer': 'http://finance.sina.com.cn' },
    timeout: 5000
  });
  const text = iconv.decode(Buffer.from(response.data), 'gbk');
  // var hq_str_gb_aapl="苹果,333.7400,0.14,..."
  const m = text.match(/="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split(',');
  if (parts.length < 26) return null;
  // Sina 美股字段顺序（已实测 AAPL）：
  //   name(0)=中文名, current(1), change_pct(2), datetime(3)="2026-07-20 17:10:01", change(4),
  //   open(5), high(6), low(7), bid(8), ask(9),
  //   volume(10), shares_outstanding(11), turnover(12) ... , prev_close(26)
  // 注：美股 Sina 不一定返回 turnover（接口对部分美股可能为 0）
  const nameZh = parts[0];
  const current = parseFloat(parts[1]);
  const changePct = parseFloat(parts[2]);
  const datetime = parts[3] || '';        // "2026-07-20 17:10:01"（已是 ISO-ish）
  const change = parseFloat(parts[4]);
  const openVal = parseFloat(parts[5]);
  const highVal = parseFloat(parts[6]);
  const lowVal  = parseFloat(parts[7]);
  const volumeVal = parseFloat(parts[10]);
  const turnoverVal = parseFloat(parts[12]);
  let prevClose = parts.length > 26 ? parseFloat(parts[26]) : NaN;
  if ((isNaN(prevClose) || prevClose <= 0) && !isNaN(current) && !isNaN(change)) {
    prevClose = current - change;
  }
  if (isNaN(current) || current <= 0) return null;
  // 转换日期格式：parts[3] 已是 "YYYY-MM-DD HH:MM:SS" 或美式格式
  let gztime = '';
  let jzrq = '';
  if (datetime) {
    const m = datetime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/);
    if (m) {
      jzrq = `${m[1]}-${m[2]}-${m[3]}`;
      gztime = `${jzrq} ${m[4]}`;
    } else {
      // 降级使用当前美股日期与时间
      const nowNy = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      }).formatToParts(new Date());
      const p = Object.fromEntries(nowNy.map(x => [x.type, x.value]));
      jzrq = `${p.year}-${p.month}-${p.day}`;
      gztime = `${jzrq} ${p.hour}:${p.minute}`;
    }
  }
  return {
    fundcode: ticker.toUpperCase(),
    name: nameZh,
    jzrq,
    dwjz: isNaN(prevClose) ? '0' : prevClose.toFixed(4),
    gsz: current.toFixed(4),
    gszzl: isNaN(changePct) ? '0' : changePct.toFixed(2),
    gztime,
    market: 'us',
    open: isNaN(openVal) || openVal <= 0 ? undefined : openVal.toFixed(4),
    stockSpecific: {
      open: isNaN(openVal) || openVal <= 0 ? null : openVal,
      high: isNaN(highVal) || highVal <= 0 ? null : highVal,
      low:  isNaN(lowVal)  || lowVal  <= 0 ? null : lowVal,
      volume: isNaN(volumeVal) || volumeVal < 0 ? null : volumeVal,
      turnover: isNaN(turnoverVal) || turnoverVal < 0 ? null : turnoverVal,
      change: isNaN(change) ? 0 : change,
    }
  };
}

/**
 * 腾讯 qt.gtimg.cn — 个股总市值/流通市值/换手率
 *   接口：http://qt.gtimg.cn/q=<symbol>
 *     A 股: q=sh688825 / q=sz000001 / q=bj830xxx
 *     港股: q=hk00700
 *     美股: q=usAAPL
 *   返回 GBK 编码 JSONP: v_<sym>="0~name~code~current~prevClose~open~volume~...~floatMC~totalMC~turnoverRate"
 *
 *   实测字段索引（A 股 sh688825 / 港股 hk00700 / 美股 AAPL 三者一致）：
 *     [3]=current [4]=prevClose [5]=open
 *     [33]=high [34]=low
 *     [36]=volume [37]=turnover [38]=换手率(%)
 *     [44]=流通市值(亿) [45]=总市值(亿)
 *
 *   港股 Tencent qt 不返回换手率（parts[38]=0），返回 null
 *
 *   选择腾讯而非东方财富的原因：
 *   - 东方财富 push2.eastmoney.com 在国内网络环境 IPv6 hang up 严重，family:4 也常失败
 *   - 腾讯 qt.gtimg.cn 同时提供 OHLCV + 总市值/换手率，单接口拿到全字段
 *   - 数值与新浪一致（已交叉验证 688825：流通市值 2206.49亿 / 总市值 32771.63亿 / 换手率 66.40%）
 *
 *   失败时返回 null（不阻塞主流程，分时图/卡片仍可用）
 */
const _tencentExtraCache = {};
const TENCENT_EXTRA_TTL = 60 * 1000; // 1 分钟缓存（总市值/换手率变动较慢）

async function fetchTencentExtraStockInfo(code, market) {
  const c = code.toUpperCase();
  const cacheKey = `${market}:${c}`;
  const now = Date.now();
  const cached = _tencentExtraCache[cacheKey];
  if (cached && now - cached.ts < TENCENT_EXTRA_TTL) {
    return cached.value;
  }

  let sym;
  if (market === 'domestic') {
    if (c.startsWith('60') || c.startsWith('68')) sym = 'sh' + c;
    else if (c.startsWith('00') || c.startsWith('30')) sym = 'sz' + c;
    else if (c.startsWith('8')) sym = 'bj' + c;
    else sym = null;
  } else if (market === 'hk') {
    sym = 'hk' + c.padStart(5, '0');
  } else if (market === 'us') {
    sym = 'us' + c;
  } else {
    sym = null;
  }
  if (!sym) {
    _tencentExtraCache[cacheKey] = { ts: now, value: null };
    return null;
  }

  const url = `http://qt.gtimg.cn/q=${sym}`;
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'Referer': 'https://gu.qq.com/' },
      family: 4,
      timeout: 8000,
    });
    const text = iconv.decode(Buffer.from(r.data), 'gbk');
    // 形如: v_sh688825="1~N长鑫~688825~49.00~...~66.40~116.23~~55.03~38.11~195.38~2206.49~32771.63~..."
    const m = text.match(/="([^"]+)"/);
    if (!m) {
      _tencentExtraCache[cacheKey] = { ts: now, value: null };
      return null;
    }
    const parts = m[1].split('~');
    if (parts.length < 46) {
      _tencentExtraCache[cacheKey] = { ts: now, value: null };
      return null;
    }
    // [44]=流通市值(亿)  [45]=总市值(亿)  [38]=换手率(%)
    const floatMC = parseFloat(parts[44]);
    const totalMC = parseFloat(parts[45]);
    const tr = parseFloat(parts[38]);
    // 港股 Tencent 返回 parts[38]=0（不返回换手率），A 股/US 应在 0-100 之间
    const turnoverRate = Number.isFinite(tr) && tr > 0 && tr < 100 ? tr : null;
    const value = {
      totalMarketCap: Number.isFinite(totalMC) && totalMC > 0 ? totalMC * 1e8 : null,
      floatMarketCap: Number.isFinite(floatMC) && floatMC > 0 ? floatMC * 1e8 : null,
      turnoverRate,
    };
    _tencentExtraCache[cacheKey] = { ts: now, value };
    return value;
  } catch (e) {
    console.warn(`[tencentExtra] ${c} (${market}) 失败:`, e.message);
    _tencentExtraCache[cacheKey] = { ts: now, value: null };
    return null;
  }
}

/**
 * 个股分钟级 K 线（真实逐分钟数据，用于分时图 hover 显示真实成交量/额）
 *
 * A 股 — Sina CN_MarketDataService.getKLineData：
 *   https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData
 *     ?symbol=sh688825&scale=1&datalen=240
 *   返回 JSONP: =([{day,open,high,low,close,volume,amount}, ...])
 *   volume 单位：股  amount 单位：元
 *
 * 港股 — 腾讯 appstock/app/minute/query：
 *   https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=hk00700
 *   返回 JSON: { data: { hk00700: { data: { data: ["HHMM price volume amount", ...] } } } }
 *   volume 单位：股  amount 单位：港币元
 *
 * 美股 — 腾讯 / 新浪 暂无公开分钟接口 → 返回 null，让前端 fallback 到合成数据
 *
 * 缓存 30 秒（分钟数据实时变化，但 30s 内重读基本一致，避免打爆上游）
 */
const _minuteCache = {};
const MINUTE_CACHE_TTL = 30 * 1000;

async function fetchStockMinuteData(code, market) {
  const c = code.toUpperCase();
  const cacheKey = `${market}:${c}`;
  const now = Date.now();
  const cached = _minuteCache[cacheKey];
  if (cached && now - cached.ts < MINUTE_CACHE_TTL) {
    return cached.data;
  }

  let result = null;
  try {
    if (market === 'domestic') {
      // Sina 分钟 K 线
      let symbol;
      if (c.startsWith('60') || c.startsWith('68')) symbol = `sh${c}`;
      else if (c.startsWith('00') || c.startsWith('30')) symbol = `sz${c}`;
      else if (c.startsWith('8') || c.startsWith('BJ')) symbol = `bj${c}`;
      else return null;
      const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=1&datalen=240`;
      const r = await axios.get(url, {
        headers: { 'Referer': 'https://finance.sina.com.cn' },
        timeout: 8000,
        validateStatus: s => s === 200,
      });
      const text = typeof r.data === 'string' ? r.data : '';
      // Sina 响应：/*<script>...*/\n=([...]);\n（注意结尾是 `]);` 不是 `])`）
      const m = text.match(/=\(\[([\s\S]+?)\]\)\s*;?\s*$/);
      if (!m) return null;
      const arr = JSON.parse(`[${m[1]}]`);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      result = arr.map(d => ({
        time: d.day,                              // "2026-07-27 09:31:00"
        open: parseFloat(d.open),
        high: parseFloat(d.high),
        low: parseFloat(d.low),
        close: parseFloat(d.close),
        volume: parseFloat(d.volume) || 0,        // 股
        amount: parseFloat(d.amount) || 0,        // 元
      }));
    } else if (market === 'hk') {
      // 腾讯分钟数据
      const sym = `hk${c.padStart(5, '0')}`;
      const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${sym}`;
      const r = await axios.get(url, {
        timeout: 8000,
        family: 4,
      });
      const arr = r.data?.data?.[sym]?.data?.data;
      if (!Array.isArray(arr) || arr.length === 0) return null;
      // 格式：["HHMM price volume amount", ...]，每分钟一行
      result = arr.map(line => {
        const [hm, price, volume, amount] = line.split(' ');
        if (!hm || !price) return null;
        // HHMM → 当日 Date
        const hh = parseInt(hm.slice(0, 2), 10);
        const mm = parseInt(hm.slice(2, 4), 10);
        // 港股是上午 9:30-12:00 + 下午 13:00-16:00 (北京时间)，合到 ISO 字符串
        const today = new Date();
        const yyyy = today.getFullYear();
        const M = String(today.getMonth() + 1).padStart(2, '0');
        const d = String(today.getDate()).padStart(2, '0');
        return {
          time: `${yyyy}-${M}-${d} ${hm.slice(0, 2)}:${hm.slice(2, 4)}:00`,
          open: parseFloat(price),
          high: parseFloat(price),
          low: parseFloat(price),
          close: parseFloat(price),
          volume: parseFloat(volume) || 0,
          amount: parseFloat(amount) || 0,
        };
      }).filter(Boolean);
    }
    // 美股暂无分钟接口，跳过
  } catch (e) {
    console.warn(`[minute] ${c} (${market}) 失败:`, e.message);
  }

  _minuteCache[cacheKey] = { ts: now, data: result };
  return result;
}

/**
 * 东方财富 f10/lsjz —— A 股基金（包括 QDII）的官方净值历史
 *   返回最近 1 条记录，dwjz 即"上一个交易日公布的单位净值"
 *   QDII 的官方净值在海外市场收盘后第二天上午公布，比实时估算更可靠但滞后
 *   字段：FSRQ(日期), DWJZ(单位净值), JZZZL(日增长率%), LJJZ(累计净值)
 */
async function fetchEastMoneyLSJZ(code) {
  const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1`;
  const response = await axios.get(url, {
    headers: { 'Referer': 'http://fundf10.eastmoney.com/' },
    timeout: 5000
  });
  const data = response.data;
  if (!data || data.ErrCode !== 0 || !data.Data || !data.Data.LSJZList || data.Data.LSJZList.length === 0) {
    return null;
  }
  const row = data.Data.LSJZList[0];
  const dwjz = parseFloat(row.DWJZ);
  if (isNaN(dwjz) || dwjz <= 0) return null;
  const changePct = parseFloat(row.JZZZL || '0');
  const navDate = row.FSRQ || '';
  // lsjz 只返回净值，不能据此判断 QDII 市场；补查 pingzhongdata 的基金名称。
  // 这是实时源失效时的兜底路径，额外请求只在该低频分支发生。
  const basic = await getFundBasicInfo(code);
  const name = basic?.name || `基金 ${code}`;
  let market = 'domestic';
  if (/纳斯达克|标普|美股|美国|拜登|道琼斯|罗素|费城半导体/i.test(name)) market = 'us';
  else if (/港股|恒生|中华/i.test(name)) market = 'hk';

  return {
    fundcode: code,
    name,
    jzrq: navDate,
    dwjz: dwjz.toFixed(4),
    // ⚠️ 此路径没有"实时现价"——只有上一交易日官方净值。
    // gsz 字段名保留以兼容旧调用方，但语义上等于 dwjz。
    // 调用方必须检查 `navOnly === true` 并据此跳过基于 gsz 的涨跌判断。
    gsz: dwjz.toFixed(4),
    gszzl: isNaN(changePct) ? '0' : changePct.toFixed(2),
    gztime: navDate ? `${navDate} 15:00` : '',
    market,
    navOnly: true
  };
}

/**
 * 腾讯 K 线历史数据（A 股 / 港股 / 美股 通用）
 *   返回标准化格式：[{ date, open, high, low, close, volume }]
 *   A 股：web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,30,qfq
 *   美股：... /usfqkline/get?param=us.TSLA,day,,,30,qfq
 *   港股：... /hkfqkline/get?param=hk00700,day,,,30,qfq
 */
async function fetchStockKLineHistory(code, days = 30) {
  const c = code.trim();
  let symbol, url;
  if (/^\d{6}$/.test(c)) {
    if (c.startsWith('60') || c.startsWith('68')) { symbol = 'sh' + c; }
    else if (c.startsWith('00') || c.startsWith('30')) { symbol = 'sz' + c; }
    else return [];
    url = 'http://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
  } else if (/^[A-Za-z]{1,5}$/.test(c)) {
    symbol = 'us.' + c.toUpperCase();
    url = 'http://web.ifzq.gtimg.cn/appstock/app/usfqkline/get';
  } else if (/^\d{4,5}$/.test(c)) {
    symbol = 'hk' + c.padStart(5, '0');
    url = 'http://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get';
  } else {
    return [];
  }

  const fullUrl = `${url}?param=${symbol},day,,,${days},qfq`;
  try {
    const r = await axios.get(fullUrl, { timeout: 8000 });
    const d = r.data;
    if (!d || d.code !== 0 || !d.data) return [];
    const key = Object.keys(d.data).find(k => k !== 'qt') || Object.keys(d.data)[0];
    if (!key || key === 'qt') return [];
    const arr = d.data[key]?.day || d.data[key]?.qfqday || [];
    return arr.map((k) => {
      const [date, open, close, high, low, volume] = k;
      return {
        date,
        open: parseFloat(open) || 0,
        high: parseFloat(high) || 0,
        low: parseFloat(low) || 0,
        close: parseFloat(close) || 0,
        volume: parseFloat(volume) || 0,
      };
    });
  } catch (e) {
    console.error(`[kline] ${code} 失败:`, e.message);
    return [];
  }
}

/**
 * QDII 基金专用：基于 Top 10 持仓的实时加权估算
 *   1. 抓 pingzhongdata 拿到前 10 重仓股代码（如 NVDA, GOOGL, ...）
 *   2. 用 Sina US/HK API 拉每只实时涨跌
 *   3. 等权计算：estimate = lastNav × (1 + mean(top10 changes))
 *   缺点：等权不准确（实际权重不等），但能跟踪海外市场实时节奏
 */
async function fetchHoldingsBasedEstimate(code) {
  // 1. 抓持仓
  const pingUrl = `http://fund.eastmoney.com/pingzhongdata/${code}.js`;
  let pingText;
  try {
    const r = await axios.get(pingUrl, {
      headers: { 'Referer': 'http://fundf10.eastmoney.com/' },
      timeout: 5000,
      responseType: 'arraybuffer'
    });
    // pingzhongdata 实际是 UTF-8 编码（之前误判为 GBK 导致乱码）
    // 但响应带 UTF-8 BOM (efbbbf)，先剥掉再用 UTF-8 解码
    let buf = Buffer.from(r.data);
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      buf = buf.slice(3);
    }
    pingText = iconv.decode(buf, 'utf-8');
  } catch {
    return null;
  }

  // 提取 stockCodes（格式如 ["NVDA105","GOOGL105",...]，最后 1-3 位是市场号：105=US/HK, 106=HK, 0=深, 1=沪）
  const m = pingText.match(/stockCodes\s*=\s*\[([^\]]+)\]/);
  if (!m) return null;
  const codesRaw = m[1].match(/"([^"]+)"/g)?.map(s => s.slice(1, -1)) || [];
  if (codesRaw.length === 0) return null;

  // 解析：去掉末尾市场号，提取基础代码
  const stocks = codesRaw.map(raw => {
    let code, market;
    if (raw.endsWith('105')) { code = raw.slice(0, -3); market = 'us'; }      // US/HK (Sina 105 = gb_)
    else if (raw.endsWith('106')) { code = raw.slice(0, -3); market = 'hk'; } // HK (106 = rt_hk)
    else if (raw.endsWith('1')) { code = raw.slice(0, -1); market = 'sh'; }
    else if (raw.endsWith('0')) { code = raw.slice(0, -1); market = 'sz'; }
    else { code = raw; market = 'us'; }
    return { code, market };
  });

  // 2. 拉每只实时价（Sina）
  const symbols = stocks.map(s => s.market === 'us' ? `gb_${s.code.toLowerCase()}` : `rt_hk${s.code}`).join(',');
  let sinaText;
  try {
    const r = await axios.get(`http://hq.sinajs.cn/list=${symbols}`, {
      responseType: 'arraybuffer',
      headers: { 'Referer': 'http://finance.sina.com.cn' },
      timeout: 6000
    });
    sinaText = iconv.decode(Buffer.from(r.data), 'gbk');
  } catch {
    return null;
  }

  // 3. 提取每只的涨跌幅
  //   US stock Sina 字段：parts[1]=现价, parts[2]=涨跌幅%(已带正负号), parts[3]=datetime, parts[26]=昨收
  //   HK stock Sina 字段：parts[1]=中文名, parts[2]=现价, parts[3]=昨收, parts[6]=现价, parts[7]=涨跌额, parts[8]=涨跌幅%
  //   ⚠️ 历史 bug：启发式 `Math.abs(parts[2]) < 50` 会把港股「价格」(如港铁 32.84) 误读为 +
  //   32.84% 涨跌幅。修复：先看 Sina 行前缀（gb_ / rt_hk / 无前缀），按市场选正确字段；
  //   旧/不匹配数据才回退到 parts[2] 启发式。
  const changes = [];
  for (const line of sinaText.split('\n')) {
    const m2 = line.match(/(?:var\s+)?hq_str_([a-z0-9_]+)="([^"]*)"/);
    if (!m2) continue;
    const symbol = m2[1];              // e.g. 'gb_sndk' / 'rt_hk00066' / 'sh600519'
    const data = m2[2];
    if (!data) continue;               // Sina 对未识别的代码返回空串
    const parts = data.split(',');
    if (parts.length < 5) continue;

    let changePct = NaN;
    const isUS = symbol.startsWith('gb_') || symbol.startsWith('usr_');
    const isHK = symbol.startsWith('rt_hk') || symbol.startsWith('hk');

    if (isHK) {
      // HK：用 parts[8]=涨跌幅%。parts[2]=现价（不能信）
      if (parts.length > 8 && !isNaN(parseFloat(parts[8]))) {
        changePct = parseFloat(parts[8]);
      } else if (parts.length > 7) {
        // 兜底：parts[6](现价) vs parts[5](昨收)
        const c = parseFloat(parts[6]);
        const y = parseFloat(parts[5]);
        if (!isNaN(c) && !isNaN(y) && y > 0) changePct = ((c - y) / y) * 100;
      }
    } else if (isUS) {
      // US：用 parts[2]=涨跌幅%（已含正负号）
      const v = parseFloat(parts[2]);
      if (!isNaN(v)) changePct = v;
    } else {
      // A 股 / 其他（旧 fu_ 格式）— 老启发式
      if (!isNaN(parseFloat(parts[2])) && Math.abs(parseFloat(parts[2])) < 50) {
        changePct = parseFloat(parts[2]);
      } else if (parts.length > 8 && !isNaN(parseFloat(parts[8]))) {
        changePct = parseFloat(parts[8]);
      }
    }

    if (!isNaN(changePct) && Math.abs(changePct) < 50) {
      changes.push(changePct);
    }
  }
  if (changes.length === 0) return null;

  // 4. 等权平均 + 拉官方名称
  // 异常剔除：单只 change% 偏离 median 超过 15 个百分点（例如港铁 -0.85% / 真实
  // +12% 美股区间里有只 +50% 的极端值会污染均值）。这是防御性 — 应在字段读取层
  // 已经做了市场区分，这里再做一次统计兜底。
  const sorted = [...changes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const filtered = changes.filter(v => Math.abs(v - median) <= 15 || sorted.length < 4);
  const avgChange = filtered.reduce((a, b) => a + b, 0) / filtered.length;
  const nameMatch = pingText.match(/fS_name\s*=\s*"([^"]+)"/);
  const fundName = nameMatch ? nameMatch[1] : `基金 ${code}`;

  // 5. 取最新官方净值作为基准
  const nav = await fetchEastMoneyLSJZ(code);
  if (!nav) return null;
  const lastNav = parseFloat(nav.dwjz);
  if (isNaN(lastNav) || lastNav <= 0) return null;

  const estimatedGsz = lastNav * (1 + avgChange / 100);
  const now = new Date();
  // 美股时间（NY）：当前 7-21 10:35 北京，美股昨晚已收（夏令 04:00 北京收盘）
  // 7-21 北京白天：基于昨晚美股收盘后的官方净值 + 今日盘前/盘中变动
  // 7-21 北京晚上 21:30+：今日美股盘中
  const gzTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // 推断主体市场：若前 10 重仓股中有美股/港股，设置对应 market 属性
  const hasUs = stocks.some(s => s.market === 'us');
  const hasHk = stocks.some(s => s.market === 'hk');
  const detectedMarket = hasUs ? 'us' : (hasHk ? 'hk' : 'domestic');

  return {
    fundcode: code,
    name: fundName,
    jzrq: nav.jzrq,                              // 基准净值日期（最近官方）
    dwjz: nav.dwjz,
    gsz: estimatedGsz.toFixed(4),
    gszzl: avgChange.toFixed(2),
    gztime: gzTime,
    market: detectedMarket,
    estimate: true,                                // 标记这是基于持仓的估算
    holdingsCount: changes.length,
    officialNavDate: nav.jzrq
  };
}

/**
 * Sina 基金接口（fu_ 前缀）—— fundgz 失败时的兜底
 *   字段：[0]名称 [1]时间 [2]现价 [3]昨收 [4]参考净值 [5]涨跌额 [6]涨跌幅% [7]日期 [8..] 累计
 *   适合 A 股基金（含 QDII），但 QDII 估值可能比 A 股晚一天（跟踪美股）
 */
async function fetchSinaFundValuation(code) {
  const url = `http://hq.sinajs.cn/list=fu_${code}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Referer': 'http://finance.sina.com.cn' },
    timeout: 5000
  });
  const text = iconv.decode(Buffer.from(response.data), 'gbk');
  const m = text.match(/="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split(',');
  if (parts.length < 8) return null;
  // parts[2] = 估值，parts[3] = 昨收，parts[6] = 涨跌幅，parts[7] = 日期
  // 优先用 parts[2]（现价），回退到 parts[9]（某些基金用累计净值作现价）
  let gsz = parseFloat(parts[2]);
  if (isNaN(gsz) || gsz <= 0) gsz = parseFloat(parts[9] || '');
  if (isNaN(gsz) || gsz <= 0) return null;
  const name = parts[0] || '';
  const isUsQDII = /纳斯达克|标普|美股|美国|拜登|道琼斯|罗素|费城半导体/i.test(name);
  const isHkQDII = /港股|恒生|中华/i.test(name);
  const market = isUsQDII ? 'us' : (isHkQDII ? 'hk' : 'domestic');
  return {
    fundcode: code,
    name,
    jzrq: parts[7] || '',
    dwjz: parts[3] || '0',
    gsz: gsz.toFixed(4),
    gszzl: parts[6] || '0',
    gztime: parts[7] && parts[1] ? `${parts[7]} ${parts[1]}` : '',
    market
  };
}

/**
 * 代理获取基金/股票估算价格（统一入口）
 *   - A 股基金：6 位数字
 *   - 港股：5 位数字（自动加 rt_hk 前缀调 Sina）
 *   - 美股：1-5 位字母 ticker（自动加 gb_ 前缀调 Sina）
 *
 *   A 股基金数据源 fallback 链：
 *     1. fundgz.1234567.com.cn（最常见）
 *     2. Sina fu_（覆盖 QDII 等 fundgz 没有的基金）
 */
async function getFundValuation(code, kindOverride) {
  const now = Date.now();
  const cached = cache.fund[code];
  if (cached && (now - cached.timestamp < FUND_CACHE_TTL)) {
    return cached.data;
  }

  // 前端可指定 kind（按 tab 强制走某条路径）；否则按 code 格式自动判
  const kind = kindOverride || detectCodeKind(code);
  let result = null;

  try {
    // kindOverride='stock' 是前端的"股票 tab"标识，需要再按 code 格式细分到具体 fetcher
    if (kindOverride === 'stock') {
      const subKind = detectCodeKind(code);
      if (subKind === 'stock_a' || subKind === 'fund_a') {
        result = await fetchASHareStockValuation(code);
      } else if (subKind === 'fund_hk') {
        result = await fetchHKStockValuation(code);
      } else if (subKind === 'fund_us') {
        result = await fetchUSStockValuation(code);
      }
    } else if (kind === 'stock_a') {
      result = await fetchASHareStockValuation(code);
    } else if (kind === 'fund_hk') {
      result = await fetchHKStockValuation(code);
    } else if (kind === 'fund_us') {
      result = await fetchUSStockValuation(code);
    } else {
      // kind === 'fund_a'：6 位数字
      // 1. 优先直接调 fundgz (A股基金主接口)
      const url = `http://fundgz.1234567.com.cn/js/${code}.js?rt=${now}`;
      try {
        const response = await axios.get(url, {
          headers: { 'Referer': 'http://fund.eastmoney.com/' },
          timeout: 5000,
          maxRedirects: 5
        });
        const text = response.data;
        if (text && text.includes('jsonpgz')) {
          const rawData = parseJsonp(text);
          if (rawData && rawData.gsz && parseFloat(rawData.gsz) > 0) {
            const name = rawData.name || '';
            let market = 'domestic';
            if (/纳斯达克|标普|美股|美国|拜登|道琼斯|罗素|费城半导体/i.test(name)) market = 'us';
            else if (/港股|恒生|中华/i.test(name)) market = 'hk';

            result = {
              fundcode: rawData.fundcode,
              name,
              jzrq: rawData.jzrq,
              dwjz: rawData.dwjz,
              gsz: rawData.gsz,
              gszzl: rawData.gszzl,
              gztime: rawData.gztime,
              market
            };
          }
        }
      } catch {}

      // 仅在 fundgz 未命中时，尝试测试是否为 A 股个股（如深市 002050）
      if (!result) {
        try {
          result = await fetchASHareStockValuation(code);
          if (result) console.log(`[fund] ${code} matched as A-share stock (fundgz miss, Sina fallback)`);
        } catch {}
      }
      // 第 2 级 fallback
      if (!result) {
        console.log(`[fund] fundgz miss for ${code}, fallback to Sina fu_`);
        result = await fetchSinaFundValuation(code);
      }
      // 数据陈旧检查：Sina fu_ 对 QDII 经常返回 1-2 周前的数据，超过 7 天视为无效
      if (result && result.gztime) {
        const dataTime = Date.parse(result.gztime.replace(' ', 'T'));
        if (Number.isFinite(dataTime) && Date.now() - dataTime > 7 * 24 * 60 * 60 * 1000) {
          console.log(`[fund] ${code} Sina data stale (${result.gztime}), trying EastMoney f10/lsjz`);
          result = null;
        }
      }
      // 第 3 级 fallback：东方财富官方净值
      if (!result) {
        console.log(`[fund] Sina fu_ miss/stale for ${code}, fallback to EastMoney f10/lsjz`);
        result = await fetchEastMoneyLSJZ(code);
      }
      // 第 4 级 fallback：基于持仓成分股的实时加权估算（QDII 专属，跟踪海外市场实时节奏）
      if (!result || result.navOnly) {
        console.log(`[fund] ${code} trying holdings-based estimate`);
        const estimate = await fetchHoldingsBasedEstimate(code);
        if (estimate) {
          // 优先用估算（实时）覆盖官方净值（滞后）
          result = estimate;
        }
      }
    }

    if (result) {
      // 股票结果额外拼上腾讯的总市值/换手率（异步，非阻塞：失败时 result 仍可用）
      // 注意：fund_a / fund_hk / fund_us 也会进来，但只有 stockSpecific 存在时才追加
      if (result.stockSpecific && result.market && result.market !== 'other') {
        try {
          const extra = await fetchTencentExtraStockInfo(code, result.market);
          if (extra) {
            result.stockSpecific.totalMarketCap = extra.totalMarketCap;
            result.stockSpecific.floatMarketCap = extra.floatMarketCap;
            result.stockSpecific.turnoverRate = extra.turnoverRate;
          }
        } catch {}
      }
      cache.fund[code] = { data: result, timestamp: now };
      return result;
    }
  } catch (error) {
    console.error(`后端抓取 ${code} (${kind}) 失败:`, error.message);
  }

  // 抓取失败时降级返回旧缓存
  if (cached) return cached.data;
  return null;
}

/**
 * 代理获取基金历史单位净值（东方财富 Lsjz 接口）
 *
 * 场外公募基金每个交易日只公布一个官方净值，没有分时 K 线。
 * 1D / 1W / 1M 区间的曲线用这些历史日净值构造；分时（intraday）
 * 区间需要靠估算接口的 gsz + 模拟走线，UI 上会标注为"估算"。
 *
 * @param {string} code 6位基金代码
 * @param {number} days 取最近 N 天
 * @returns {Array<{date:string, dwjz:number}>} 按日期升序
 */
async function getFundHistory(code, days = 30, kindOverride) {
  const now = Date.now();
  const cached = cache.fundHistory[code];
  if (cached && (now - cached.timestamp < FUND_HISTORY_TTL) && cached.days >= days) {
    return cached.data.slice(-days);
  }

  // 路由 1：kindOverride='stock' 显式指定为股票 → 调 K 线接口
  // 路由 2：美股字母 ticker / 4-5 位港股代码 / A 股个股严格代码(60/68/8开头) → 调 K 线接口
  const c = code.trim().toUpperCase();
  const isUSStock = /^[A-Za-z]{1,5}$/.test(c);
  const isHKStock = /^\d{4,5}$/.test(c);
  const isAShareStock = /^\d{6}$/.test(c) && /^(60|68|8)/.test(c);

  if (kindOverride === 'stock' || isUSStock || isHKStock || isAShareStock) {
    const kline = await fetchStockKLineHistory(code, days);
    const data = kline.map(k => ({ date: k.date, dwjz: k.close })).filter(r => r.dwjz > 0);
    if (data.length > 0) {
      cache.fundHistory[code] = { data, timestamp: now, days: data.length };
      return data.slice(-days);
    }
  }

  // 6 位数字且未匹配到 A 股个股 → 确定为场外公募基金，直接调 f10/lsjz 拿真实日单位净值
  if (!/^\d{6}$/.test(code)) return [];

  // 拉取足够多的记录以覆盖 days 区间
  const pageSize = Math.max(30, Math.min(days + 5, 90));
  const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${pageSize}`;

  try {
    const response = await axios.get(url, {
      headers: {
        'Referer': 'http://fundf10.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 8000
    });

    const list = response.data?.Data?.LSJZList;
    if (!Array.isArray(list)) {
      console.warn(`[history] 基金 ${code} 返回空数据`);
      if (cached) return cached.data.slice(-days);
      return [];
    }

    const data = list
      .map((row) => ({
        date: row.FSRQ,                        // 净值日期 YYYY-MM-DD
        dwjz: parseFloat(row.DWJZ) || 0        // 单位净值
      }))
      .filter((r) => r.dwjz > 0)
      // 接口按日期倒序返回，这里升序排以便前端按时序绘图
      .sort((a, b) => a.date.localeCompare(b.date));

    cache.fundHistory[code] = { data, timestamp: now, days: data.length };
    return data.slice(-days);
  } catch (error) {
    console.error(`[history] 抓取基金 ${code} 历史净值失败:`, error.message);
    if (cached) return cached.data.slice(-days);
    return [];
  }
}

/**
 * 解析 pingzhongdata 脚本中的 JS 变量赋值。
 * 输入形如: var fS_name = "易方达蓝筹精选混合"; var stockCodes = ["a","b"];
 * 输出: { fS_name: "易方达蓝筹精选混合", stockCodes: ["a","b"], ... }
 */
function parsePingzhongData(jsText) {
  const out = {};
  // 1. 去掉 BOM
  let s = jsText.replace(/^﻿/, '');
  // 2. 去掉所有 /* ... */ 块注释
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // 3. 按 `;` 切分
  const segments = s.split(';').map(x => x.trim()).filter(Boolean);
  for (const seg of segments) {
    // 4. 匹配 var NAME = VALUE
    const m = seg.match(/^var\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/);
    if (!m) continue;
    const name = m[1];
    const raw = m[2].trim();
    try {
      out[name] = JSON.parse(raw);
    } catch {
      // Fallback: replace single-quoted strings with double-quoted for JSON.parse
      try {
        const fixed = raw
          .replace(/'/g, '"')
          .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        out[name] = JSON.parse(fixed);
      } catch {
        out[name] = raw;
      }
    }
  }
  return out;
}

/**
 * 把 pingzhongdata 里的 stockCodes 解析成可读结构。
 * 输入形如: ["6005191","0008580","00700116"]
 *   后缀：1 = 上证 sh, 0 = 深证 sz, 116 = 港股 116.00700
 * 输出: [{ code: "600519", market: "sh", name: null, exchange: "SH" }, ...]
 */
function parseStockCodes(codes) {
  if (!Array.isArray(codes)) return [];
  return codes.map(raw => {
    const s = String(raw);
    // 后缀规则（来自 pingzhongdata 的 stockCodes）：
    //   105 = 美股 / 港股（Sina 用 105 表示 gb_ 前缀）
    //   106 = 港股（Sina 用 106 表示 rt_hk 前缀）
    //   116 = 港股（早期/特殊格式）
    //   1   = 上证 sh
    //   0   = 深证 sz
    // 历史 bug：只判了 116 和单字符后缀，导致 105/106 后缀只剥 1 位，
    //   "NVDA105" 被错误切成 "NVDA10"，"00700106" 被切成 "0070010"。
    if (s.endsWith('105')) {
      // 美股: "NVDA105" → "NVDA"
      const code = s.slice(0, -3).toUpperCase();
      return { code, market: 'us', exchange: 'US', name: null };
    }
    if (s.endsWith('106') || s.endsWith('116')) {
      // 港股: "00700106" → "00700"
      const code = s.slice(0, -3);
      return { code, market: 'hk', exchange: 'HK', name: null };
    }
    const suffix = s.slice(-1);
    const code = s.slice(0, -1);
    const market = suffix === '1' ? 'sh' : suffix === '0' ? 'sz' : '';
    return { code, market, exchange: market.toUpperCase(), name: null };
  });
}

/**
 * 从新浪行情接口拉取多只股票的实时名称和价格。
 * 港股走另一个接口（hq.sinajs.cn 不支持港股）。
 */
async function fetchStockQuotes(stockList) {
  if (!stockList.length) return new Map();
  const aCodes  = stockList.filter(s => s.exchange === 'SH' || s.exchange === 'SZ');
  const hkCodes = stockList.filter(s => s.exchange === 'HK');
  const usCodes = stockList.filter(s => s.exchange === 'US');

  const out = new Map();

  // A 股：hq.sinajs.cn
  if (aCodes.length > 0) {
    const symbols = aCodes.map(s => `${s.market}${s.code}`).join(',');
    try {
      const r = await axios.get(`http://hq.sinajs.cn/list=${symbols}`, {
        responseType: 'arraybuffer',
        headers: { 'Referer': 'http://finance.sina.com.cn' },
        timeout: 6000
      });
      const text = iconv.decode(Buffer.from(r.data), 'gbk');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        const m = line.match(/var hq_str_([a-z]{2}\d+)="([^"]+)"/);
        if (!m) continue;
        const sym = m[1];
        const parts = m[2].split(',');
        if (parts.length < 4) continue;
        const name = parts[0];
        const price = parseFloat(parts[1]);
        const prevClose = parseFloat(parts[2]);
        const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
        out.set(sym, { name, price, changePct });
      }
    } catch (e) {
      console.warn('[holdings] sina A股行情失败:', e.message);
    }
  }

  // 港股：试一下新浪港股接口 (hqfq.sinajs.cn)
  if (hkCodes.length > 0) {
    const symbols = hkCodes.map(s => `rt_hk${s.code}`).join(',');
    try {
      const r = await axios.get(`http://hq.sinajs.cn/list=${symbols}`, {
        responseType: 'arraybuffer',
        headers: { 'Referer': 'http://finance.sina.com.cn' },
        timeout: 6000
      });
      const text = iconv.decode(Buffer.from(r.data), 'gbk');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        const m = line.match(/var hq_str_(rt_hk\d+)="([^"]+)"/);
        if (!m) continue;
        const sym = m[1];
        const parts = m[2].split(',');
        if (parts.length < 4) continue;
        const name = parts[1];         // 港股 name 在 index 1
        const price = parseFloat(parts[2]);
        const prevClose = parseFloat(parts[3]);
        const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
        out.set(sym, { name, price, changePct });
      }
    } catch (e) {
      console.warn('[holdings] sina 港股行情失败:', e.message);
    }
  }

  // 美股：hq.sinajs.cn/list=gb_<ticker>
  //   美股字段顺序与 A 股不同：parts[0]=中文名  parts[1]=现价  parts[2]=涨跌幅%
  //   parts[3]=datetime "YYYY-MM-DD HH:MM:SS"  parts[4]=涨跌额  parts[26]=昨收
  if (usCodes.length > 0) {
    const symbols = usCodes.map(s => `gb_${s.code.toLowerCase()}`).join(',');
    try {
      const r = await axios.get(`http://hq.sinajs.cn/list=${symbols}`, {
        responseType: 'arraybuffer',
        headers: { 'Referer': 'http://finance.sina.com.cn' },
        timeout: 6000
      });
      const text = iconv.decode(Buffer.from(r.data), 'gbk');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        const m = line.match(/var hq_str_(gb_[a-z]+)="([^"]+)"/);
        if (!m) continue;
        const sym = m[1];
        const parts = m[2].split(',');
        if (parts.length < 5) continue;
        const name = parts[0];
        const price = parseFloat(parts[1]);
        // 美股 parts[2] 已是带符号的涨跌幅%，直接用
        const changePct = parseFloat(parts[2]);
        out.set(sym, {
          name,
          price: Number.isFinite(price) ? price : null,
          changePct: Number.isFinite(changePct) ? changePct : null,
        });
      }
    } catch (e) {
      console.warn('[holdings] sina 美股行情失败:', e.message);
    }
  }

  return out;
}

/**
 * 获取基金基本信息（来自天天基金 pingzhongdata）：
 *   基金名 / 基金经理 / 资产配置 / 阶段收益率 / 持仓股票代码
 * 不含基金描述正文（免费 API 拿不到完整简介）。
 */
async function getFundBasicInfo(code) {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Date.now();
  const cached = cache.fundBasic[code];
  if (cached && (now - cached.timestamp < FUND_BASIC_TTL)) {
    return cached.data;
  }

  const url = `http://fund.eastmoney.com/pingzhongdata/${code}.js`;
  try {
    const r = await axios.get(url, {
      headers: {
        'Referer': 'http://fundf10.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 8000,
      maxRedirects: 5
    });

    // pingzhongdata 返回 UTF-8 文本（Content-Type: application/javascript）
    const text = r.data;
    const parsed = parsePingzhongData(text);

    // 取最新一期的资产配置
    // 按 series 数组顺序固定：股票占净比 / 债券占净比 / 现金占净比 / 净资产
    let stockRatio = null, bondRatio = null, cashRatio = null, reportDate = null;
    const alloc = parsed.Data_assetAllocation;
    if (alloc && Array.isArray(alloc.series) && Array.isArray(alloc.categories)) {
      const last = alloc.categories.length - 1;
      const sStock = alloc.series.find(s => s.name && s.name.includes('股票'));
      const sBond  = alloc.series.find(s => s.name && s.name.includes('债券'));
      const sCash  = alloc.series.find(s => s.name && s.name.includes('现金'));
      if (sStock && Array.isArray(sStock.data)) stockRatio = sStock.data[last];
      if (sBond  && Array.isArray(sBond.data))  bondRatio  = sBond.data[last];
      if (sCash  && Array.isArray(sCash.data))  cashRatio  = sCash.data[last];
      reportDate = alloc.categories[last];
    }

    // 当前基金经理（数组，取第一个）
    const mgr = (parsed.Data_currentFundManager || [])[0];

    const data = {
      code,
      name: parsed.fS_name || code,
      manager: mgr ? {
        name: mgr.name,
        workTime: mgr.workTime,
        star: mgr.star,
        fundSize: mgr.fundSize,
        pic: mgr.pic,
        power: mgr.power ? {
          avr: mgr.power.avr,
          data: mgr.power.data,        // 经验/收益/抗风险/稳定性/择时
          categories: mgr.power.categories
        } : null
      } : null,
      assetAllocation: {
        stock: stockRatio, bond: bondRatio, cash: cashRatio, reportDate
      },
      returns: {
        m1:  parsed.syl_1y !== undefined ? parseFloat(parsed.syl_1y) : null,
        m3:  parsed.syl_3y !== undefined ? parseFloat(parsed.syl_3y) : null,
        m6:  parsed.syl_6y !== undefined ? parseFloat(parsed.syl_6y) : null,
        y1:  parsed.syl_1n !== undefined ? parseFloat(parsed.syl_1n) : null
      },
      // 当前净资产规模（来自 Data_fluctuationScale，最后一条记录 = 最新季报）
      //   series[i].y   = 规模（亿）
      //   series[i].mom = 较上期环比（%）
      //   categories[i]  = 报告期 YYYY-MM-DD
      scale: (() => {
        const fs = parsed.Data_fluctuationScale;
        if (!fs || !Array.isArray(fs.categories) || !Array.isArray(fs.series) || fs.series.length === 0) {
          return { size: null, changePct: null, reportDate: null };
        }
        const lastIdx = fs.series.length - 1;
        const y = fs.series[lastIdx]?.y;
        const mom = fs.series[lastIdx]?.mom;
        return {
          size: typeof y === 'number' ? y : null,
          changePct: typeof mom === 'string' ? parseFloat(mom.replace('%', '')) : null,
          reportDate: fs.categories[lastIdx] || null,
        };
      })(),
      raw: {
        stockCodes: parsed.stockCodes || [],
        zqCodes: parsed.zqCodes || ''
      }
    };

    cache.fundBasic[code] = { data, timestamp: now };
    return data;
  } catch (e) {
    console.error(`[basic] 抓取基金 ${code} 基本信息失败:`, e.message);
    if (cached) return cached.data;
    return null;
  }
}

/**
 * 获取基金前十大重仓股票（来自 pingzhongdata 的 stockCodes + 新浪实时行情）。
 * 自由 API 不提供单只股票的占比；列表中只展示股票代码、名称、当日涨跌幅。
 */
async function getFundHoldings(code) {
  if (!/^\d{6}$/.test(code)) return [];
  const now = Date.now();
  const cached = cache.fundHoldings[code];
  if (cached && (now - cached.timestamp < FUND_HOLDINGS_TTL)) {
    return cached.data;
  }

  const basic = await getFundBasicInfo(code);
  if (!basic) return [];

  const stocks = parseStockCodes(basic.raw.stockCodes);
  if (!stocks.length) {
    cache.fundHoldings[code] = { data: [], timestamp: now };
    return [];
  }

  const quotes = await fetchStockQuotes(stocks);
  const merged = stocks.map(s => {
    let quoteKey, displayCode;
    if (s.exchange === 'HK') {
      quoteKey = `rt_hk${s.code}`;
      displayCode = `${s.code}.HK`;
    } else if (s.exchange === 'US') {
      quoteKey = `gb_${s.code.toLowerCase()}`;
      displayCode = s.code;
    } else {
      quoteKey = `${s.market}${s.code}`;
      displayCode = `${s.code}`;
    }
    const q = quotes.get(quoteKey);
    return {
      code: s.code,
      exchange: s.exchange,
      displayCode,
      name: q ? q.name : '—',
      price: q ? q.price : null,
      changePct: q ? q.changePct : null
    };
  });

  cache.fundHoldings[code] = { data: merged, timestamp: now };
  return merged;
}

/**
 * 代理获取大盘指数 (新浪财经接口)
 */
async function getMarketIndices() {
  const now = Date.now();
  if (cache.market && (now - cache.marketTimestamp < MARKET_CACHE_TTL)) {
    return cache.market;
  }

  const indexCodes = ['s_sh000001', 's_sz399001', 's_sz399006', 's_sh000688', 's_hkHSI', 'gb_ixic', 'gb_gspc'];
  const url = `http://hq.sinajs.cn/list=${indexCodes.join(',')}`;

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer', // 新浪是 GBK 编码，需获取 Buffer 后解码
      headers: {
        'Referer': 'http://finance.sina.com.cn'
      },
      timeout: 5000
    });

    // 使用 iconv-lite 解码 GBK
    const text = iconv.decode(Buffer.from(response.data), 'gbk');
    const lines = text.split('\n');
    const indices = [];

    // 时间状态粗估
    const date = new Date();
    const hour = date.getHours();
    const min = date.getMinutes();
    const day = date.getDay();
    const isWeekend = day === 0 || day === 6;

    const isChinaTradingTime = !isWeekend && (
      (hour === 9 && min >= 30) ||
      (hour > 9 && hour < 11) ||
      (hour === 11 && min <= 30) ||
      (hour >= 13 && hour < 15)
    );

    for (const line of lines) {
      if (!line.trim()) continue;

      const match = line.match(/var hq_str_(.+?)="(.+?)"/);
      if (match) {
        const code = match[1];
        const dataStr = match[2];
        const parts = dataStr.split(',');

        if (parts.length >= 4) {
          const name = parts[0];
          const price = parseFloat(parts[1]);
          const change = parseFloat(parts[2]);
          // Sina 不同市场数据格式不同：
          //   - s_sh/s_sz: parts[3] 是涨跌幅(%)
          //   - s_hk:      parts[3] 是涨跌幅(%)
          //   - gb_ (美股): parts[3] 是时间戳 "YYYY-MM-DD HH:MM:SS"，
          //     parseFloat 会拿到年份；parts[4] 也不是涨跌幅（是别的字段，比如 open/last close 之类）
          // 最可靠：changePercent = change / (price - change) * 100，从 change + price 反推
          let changePercent;
          if (code.startsWith('gb_')) {
            const prevClose = price - change;
            changePercent = prevClose !== 0 ? (change / prevClose) * 100 : 0;
          } else {
            changePercent = parseFloat(parts[3]);
          }

          let status = 'closed';
          if (code.startsWith('s_sh') || code.startsWith('s_sz')) {
            status = isChinaTradingTime ? 'open' : 'closed';
          } else if (code.startsWith('s_hk')) {
            const isHkTrading = !isWeekend && (
              (hour === 9 && min >= 30) ||
              (hour > 9 && hour < 12) ||
              (hour === 12 && min === 0) ||
              (hour >= 13 && hour < 16)
            );
            status = isHkTrading ? 'open' : 'closed';
          } else if (code.startsWith('gb_')) {
            const isUsTrading = !isWeekend && (
              (hour >= 21 || hour < 5) ||
              (hour === 21 && min >= 30)
            );
            status = isUsTrading ? 'open' : 'closed';
          }

          indices.push({
            code,
            name,
            price,
            change,
            changePercent,
            status
          });
        }
      }
    }

    cache.market = indices;
    cache.marketTimestamp = now;
    return indices;
  } catch (error) {
    console.error('后端抓取大盘指数失败:', error.message);
    if (cache.market) return cache.market; // 降级返回旧大盘
    return [];
  }
}

/**
 * 把上游搜索结果规范化为统一的 SearchResult 数组
 * @param {Array} items - 各上游的原始结果
 * @returns {Array<{code, name, market, kind}>}
 */
function normalizeSearchResults(items) {
  const dedup = new Map();
  for (const it of items) {
    if (!it || !it.code || !it.name) continue;
    // 过滤掉明显无效的 code：太短、含奇怪字符、纯数字但长度不对
    const code = String(it.code).trim().toUpperCase();
    if (!/^(\d{4,6}|[A-Z]{1,5})$/.test(code)) continue;
    const name = String(it.name).replace(/<[^>]+>/g, '').trim();
    if (!name) continue;
    const key = `${it.market}:${code}`;
    if (dedup.has(key)) continue;
    dedup.set(key, {
      code,
      name: name.slice(0, 60),
      market: it.market,
      kind: it.kind,
    });
  }
  return Array.from(dedup.values()).slice(0, 10);
}

/**
 * 东财基金搜索: fundsuggest.eastmoney.com
 *   GET /FundSearch/api/FundSearchAPI.ashx?m=1&key=<q>
 *   返回 { Datas: [{ CODE, NAME, CATEGORYDESC, FundType }] }
 */
async function searchFundsEastMoney(q) {
  const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, { timeout: 5000 });
  const list = (data && data.Datas) || [];
  return list.map((it) => {
    const code = String(it.CODE || '').trim();
    if (!/^\d{6}$/.test(code)) return null;
    return {
      code,
      name: String(it.NAME || '').trim(),
      market: 'domestic',
      kind: 'fund',
    };
  }).filter(Boolean);
}

/**
 * 东财股票搜索: searchapi.eastmoney.com/api/suggest/get
 *   type=14 A股 / 20 港股 / 22 美股 — 但接口会混排其它市场，所以用 JYS 字段精确归类
 *   返回 { QuotationCodeTable: { Data: [{ Code, Name, JYS, ... }] } }
 */
async function searchStocksEastMoney(q, type) {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=${type}&count=10`;
  const { data } = await axios.get(url, { timeout: 5000 });
  const list = (data && data.QuotationCodeTable && data.QuotationCodeTable.Data) || [];
  return list.map((it) => {
    const code = String(it.Code || '').trim().toUpperCase();
    if (!code) return null;
    const jys = String(it.JYS || '').toUpperCase();
    let market;
    if (jys === 'SH' || jys === 'SZ') market = 'domestic';
    else if (jys === 'HK') market = 'hk';
    else if (jys === 'US' || jys === 'NASDAQ' || jys === 'NYSE' || jys === 'AMEX') market = 'us';
    else {
      // 兜底：根据 code 格式推断
      if (/^\d{6}$/.test(code) && (code.startsWith('60') || code.startsWith('68') || code.startsWith('00') || code.startsWith('30'))) market = 'domestic';
      else if (/^\d{4,5}$/.test(code)) market = 'hk';
      else if (/^[A-Z]{1,5}$/.test(code)) market = 'us';
      else market = 'other';
    }
    return {
      code,
      name: String(it.Name || '').trim(),
      market,
      kind: 'stock',
    };
  }).filter(Boolean);
}

/**
 * 新浪 suggest3 接口（混合基金 + 股票）
 *   GET /suggest/type=11,12,13,14,15&key=<q>
 *   返回 JS 字符串: var suggest_type_...="code1,name1,exchange1,...;code2,name2,...";
 *   11/13/14 = 沪深基金; 12 = 港股; 15 = 美股(带前缀 gb_)
 */
async function searchSinaSuggest(q) {
  const url = `http://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(q)}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 5000,
      responseType: 'arraybuffer',
      headers: { Referer: 'https://finance.sina.com.cn' },
    });
    const text = iconv.decode(data, 'gbk');
    // 形如: var suggest_value="...;...;";
    const m = text.match(/"([^"]+)"/);
    if (!m) return [];
    const rows = m[1].split(';').filter(Boolean);
    return rows.map((row) => {
      const cols = row.split(',');
      if (cols.length < 4) return null;
      const code = String(cols[1] || cols[0] || '').trim().toUpperCase();
      const name = String(cols[3] || cols[2] || '').trim();
      const exchange = String(cols[2] || '').toLowerCase();
      if (!code || !name) return null;
      let market = 'domestic';
      if (exchange === 'hk' || /^\d{4,5}$/.test(code)) market = 'hk';
      else if (exchange.startsWith('gb') || /^[A-Z]{1,5}$/.test(code)) market = 'us';
      // 新浪返回的 kind 通过 type 参数决定；这里取默认 'fund'，由调用方按 kind 过滤
      return { code, name, market, kind: 'fund' };
    }).filter(Boolean);
  } catch (e) {
    console.error('[searchSinaSuggest] 失败:', e.message);
    return [];
  }
}

/**
 * 公开接口：根据名字搜索代码
 * @param {string} query - 用户输入的关键字
 * @param {'fund'|'stock'} kind - 当前 tab 类型
 */
async function searchByName(query, kind = 'fund') {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = `search:${kind}:${q.toLowerCase()}`;
  const cached = searchCache[key];
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
    return cached.value;
  }

  const tasks = [];
  if (kind === 'fund') {
    tasks.push(searchFundsEastMoney(q));
  } else {
    tasks.push(
      searchStocksEastMoney(q, '14'),
      searchStocksEastMoney(q, '20'),
      searchStocksEastMoney(q, '22')
    );
  }
  // 双源：新浪也跑一次（kind 过滤后保留匹配项）
  tasks.push(searchSinaSuggest(q));

  const settled = await Promise.allSettled(tasks);
  const all = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') continue;
    const isSina = i === tasks.length - 1;
    for (const item of r.value) {
      if (isSina && item.kind !== kind) continue; // 新浪的 kind 默认为 fund，需过滤
      all.push(item);
    }
  }

  const final = normalizeSearchResults(all);
  searchCache[key] = { ts: Date.now(), value: final };
  return final;
}

/* ─────── 金价接口（国际 COMEX / 国内 SGE Au99.99 / 伦敦 XAU spot） ─────── */

// 解析一行 Sina hq_str 返回的 parts 数组
function parseSinaLine(text, re) {
  const m = text.match(re);
  if (!m || !m[1]) return null;
  const parts = m[1].split(',');
  return parts.length > 1 ? parts : null;
}

/**
 * 一次拉国际 (COMEX Gold 连续合约)、国内 (上海黄金交易所 Au99.99 实物)、
 * 伦敦 (XAU 远期现货) 三组实时报价，统一返回。
 * 字段：
 *   international: COMEX GC, USD/oz, 'hf_GC'        — 纽约黄金连续合约
 *   domestic:       SGE Au99.99, RMB/g, 'SGE_AU9999' — 上海黄金交易所实物
 *   london:         XAU spot, USD/oz, 'hf_XAU'       — 伦敦金远期现货 (LBMA 风格)
 * 每个返回 { price, prevClose, change, changePct, high, low, currency, unit, name, source, time }，
 * 任一符号失败仍返回其他可拿到的字段（局部为 null）。
 */
async function getGoldPrices() {
  if (cache.gold && Date.now() - cache.gold.timestamp < GOLD_CACHE_TTL) {
    return cache.gold.data;
  }

  const fallback = () => cache.gold ? cache.gold.data : {
    international: null, domestic: null, london: null,
    updatedAt: new Date().toISOString(), error: null,
  };

  try {
    const url = `http://hq.sinajs.cn/list=hf_GC,SGE_AU9999,hf_XAU`;
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'Referer': 'http://finance.sina.com.cn' },
      timeout: 6000
    });
    const text = iconv.decode(Buffer.from(response.data), 'gbk');

    // 国际：hf_GC COMEX 黄金连续合约
    // parts[0]=现价 [4]=最高 [5]=最低 [6]=时间 [7]=昨收 [12]=日期 [13]=中文名
    const intlParts = parseSinaLine(text, /hq_str_hf_GC="([^"]*)"/);
    const international = intlParts && intlParts[0] ? {
      price:        parseFloat(intlParts[0]) || null,
      prevClose:    parseFloat(intlParts[7]) || null,
      high:         parseFloat(intlParts[4]) || null,
      low:          parseFloat(intlParts[5]) || null,
      time:         intlParts[6] || '',
      date:         intlParts[12] || '',
      currency:     'USD',
      unit:         'oz',
      name:         'COMEX 黄金（纽约）',
      source:       'Sina/COMEX',
      symbol:       'hf_GC',
    } : null;

    // 国内：SGE_AU9999 上海黄金交易所 Au99.99
    // parts[3]=卖价/开盘 [6]=今日最高 [7]=52w高 [8]=今日最低
    // parts[9]=昨收 [10]=均价 [11]=现价 [16]=日期时间 [17]=涨跌幅%
    const domParts = parseSinaLine(text, /hq_str_SGE_AU9999="([^"]*)"/);
    let domPrice = domParts && domParts[11] ? parseFloat(domParts[11]) : NaN;
    const domPrevClose = domParts && domParts[9] ? parseFloat(domParts[9]) : NaN;
    // 休市或盘后为空时，自动回退到昨收或 parts[3]
    if ((isNaN(domPrice) || domPrice <= 0) && domParts) {
      domPrice = !isNaN(domPrevClose) && domPrevClose > 0 ? domPrevClose : (parseFloat(domParts[3]) || NaN);
    }
    const domestic = domParts && !isNaN(domPrice) && domPrice > 0 ? {
      price:        domPrice,
      prevClose:    !isNaN(domPrevClose) && domPrevClose > 0 ? domPrevClose : null,
      high:         domParts[6] ? parseFloat(domParts[6]) || null : null,
      low:          domParts[8] ? parseFloat(domParts[8]) || null : null,
      time:         domParts[16] ? domParts[16].split(' ')[1] || '' : '',
      date:         domParts[16] ? domParts[16].split(' ')[0] || '' : '',
      serverChangePct: domParts[17] ? parseFloat(domParts[17]) || null : null,
      currency:     'CNY',
      unit:         'g',
      name:         '上海黄金 Au99.99',
      source:       'Sina/SGE',
      symbol:       'SGE_AU9999',
    } : null;

    // 伦敦：hf_XAU 伦敦金远期现货
    // parts[0]=现价 [1]=昨收 [4]=高 [5]=低 [6]=时间 [12]=日期 [13]=中文名
    const ldParts = parseSinaLine(text, /hq_str_hf_XAU="([^"]*)"/);
    const london = ldParts && ldParts[0] ? {
      price:        parseFloat(ldParts[0]) || null,
      prevClose:    parseFloat(ldParts[1]) || null,
      high:         parseFloat(ldParts[4]) || null,
      low:          parseFloat(ldParts[5]) || null,
      time:         ldParts[6] || '',
      date:         ldParts[12] || '',
      currency:     'USD',
      unit:         'oz',
      name:         '伦敦金 (LBMA Spot)',
      source:       'Sina/LBMA',
      symbol:       'hf_XAU',
    } : null;

    // 算 change / changePct（统一 client-side 拿到数据）
    for (const q of [international, domestic, london]) {
      if (!q) continue;
      if (q.price != null && q.prevClose != null && q.prevClose > 0) {
        q.change = q.price - q.prevClose;
        q.changePct = (q.change / q.prevClose) * 100;
      } else {
        q.change = null;
        q.changePct = null;
      }
    }

    const data = {
      international,
      domestic,
      london,
      updatedAt: new Date().toISOString(),
      error: null,
    };

    cache.gold = { timestamp: Date.now(), data };
    return data;
  } catch (e) {
    console.error('[gold] fetch failed:', e.message);
    return { ...fallback(), error: e.message };
  }
}

module.exports = {
  getFundValuation,
  getFundHistory,
  getFundBasicInfo,
  getFundHoldings,
  getMarketIndices,
  detectCodeKind,
  isInTradingTime,
  fetchHKStockValuation,
  fetchUSStockValuation,
  fetchSinaFundValuation,
  fetchASHareStockValuation,
  fetchStockMinuteData,
  searchByName,
  getGoldPrices,
};
