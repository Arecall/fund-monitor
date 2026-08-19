const axios = require('axios');
const http = require('http');
const https = require('https');

// 配置全局 HTTP / HTTPS Agent 实现 TCP 连接复用 (Keep-Alive)，减少 TLS 握手开销
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

const iconv = require('iconv-lite');
const marketTime = require('./time.cjs');
const proxyTickers = require('./proxy-tickers.cjs');
const dbHelper = require('./db.cjs');

// 内存缓存字典，避免短时间内高频轮询打爆天天基金和新浪接口
// 结构: { key: { data, timestamp } }
const cache = {
  fund: {},
  fundHistory: {},
  fundBasic: {},
  fundHoldings: {},
  fundHoldingComposition: {},
  fx: null,
  market: null,
  marketTimestamp: 0,
  gold: null,
  // QDII 腾讯 Qt 代理行情缓存（结构: { ticker: { data, timestamp } }）
  // TTL = PROXY_TICKER_TTL，60s 内复用，避免打爆上游。
  proxyTicker: {},
  // 已注册 QDII 的 fundgz / Sina 泛源数据状态，用于识别持续返回同一行情的上游。
  genericQdiiSource: {},
};

// 名称搜索单独存（结构: { 'fund:<q>': { data: [...], timestamp } }）
const searchCache = {};

// 缓存过期时间
const FUND_CACHE_TTL = 3 * 1000;          // 基金/股票估值缓存 3秒（小于前端 10s 轮询，确保每次轮询穿透拉取上游最新）
const FUND_HISTORY_TTL = 60 * 60 * 1000;  // 基金历史净值缓存 1小时
const FUND_BASIC_TTL = 60 * 60 * 1000;    // 基金基本/资产配置缓存 1小时
const FUND_HOLDINGS_TTL = 60 * 1000;       // 持仓报价缓存 60 秒
const FUND_HOLDING_COMPOSITION_TTL = 24 * 60 * 60 * 1000; // 上游持仓构成每日刷新
const MARKET_CACHE_TTL = 3 * 1000;        // 大盘指数缓存 3秒
const SEARCH_CACHE_TTL = 5 * 60 * 1000;   // 名称搜索缓存 5分钟
const GOLD_CACHE_TTL = 30 * 1000;         // 金价缓存 30秒
const PROXY_TICKER_TTL = 60 * 1000;       // QDII 代理标的腾讯行情缓存 60 秒
const FX_CACHE_TTL = 60 * 60 * 1000;       // 汇率缓存 1 小时
const GENERIC_QDII_REALTIME_FRESH_MS = 2 * 60 * 1000; // 泛源实时估值最多允许滞后 2 分钟

/**
 * 转换 JSONP 为 JSON 对象
 */
function currencyForExchange(exchange) {
  if (exchange === 'HK') return 'HKD';
  if (exchange === 'US') return 'USD';
  if (exchange === 'JP') return 'JPY';
  if (exchange === 'KR') return 'KRW';
  return 'CNY';
}

function convertPriceToCny(price, currency, rates) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const rate = rates?.[currency];
  return Number.isFinite(rate) && rate > 0 ? price * rate : null;
}

async function getFxRates() {
  const now = Date.now();
  if (cache.fx && now - cache.fx.timestamp < FX_CACHE_TTL) return { rates: cache.fx.rates, stale: false };
  try {
    const response = await axios.get('https://open.er-api.com/v6/latest/CNY', { timeout: 6000 });
    const usd = response.data?.rates?.USD;
    const hkd = response.data?.rates?.HKD;
    const jpy = response.data?.rates?.JPY;
    const krw = response.data?.rates?.KRW;
    if (![usd, hkd, jpy, krw].every(rate => Number.isFinite(rate) && rate > 0)) throw new Error('汇率字段不完整');
    const rates = { CNY: 1, USD: 1 / usd, HKD: 1 / hkd, JPY: 1 / jpy, KRW: 1 / krw };
    cache.fx = { rates, timestamp: now };
    return { rates, stale: false };
  } catch (e) {
    if (cache.fx?.rates) return { rates: cache.fx.rates, stale: true };
    console.warn('[fx] 汇率获取失败:', e.message);
    return { rates: null, stale: true };
  }
}

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
/**
 * 解析大陆交易所代码。场内 ETF/LOF 前缀仅在 includeListedEtf=true（用户明确选择股票）
 * 时生效，避免把普通场外基金自动改走交易所行情。
 */
function getMainlandExchangeSymbol(code, { includeListedEtf = false, isStock = true } = {}) {
  const c = String(code || '').trim().toUpperCase().replace(/^(SH|SZ|BJ)/, '');
  if (!/^\d{6}$/.test(c)) return null;
  let exchange = null;
  let instrumentType = 'stock';
  if (isStock) {
    if (/^(60|68)/.test(c)) exchange = 'sh';
    else if (/^(00|30)/.test(c)) exchange = 'sz';
    else if (/^(8|4)/.test(c)) exchange = 'bj';
  }
  if (!exchange && includeListedEtf) {
    if (/^(50|51|52|56|58)/.test(c)) { exchange = 'sh'; instrumentType = 'listed_etf'; }
    else if (/^(15|16|18)/.test(c)) { exchange = 'sz'; instrumentType = 'listed_etf'; }
  }
  if (!exchange) return null;
  return { code: c, exchange, symbol: `${exchange}${c}`, market: exchange === 'bj' ? 'other' : 'domestic', instrumentType };
}

function detectMarketFromName(name) {
  if (!name) return 'domestic';
  const n = String(name);
  if (/港股|恒生|中华|粤港澳|香港/i.test(n)) return 'hk';
  // 注意：单纯的“半导体/芯片/科技”不能作为美股关键字，因为国内有大量 A 股主题基金（如“国泰半导体”、“中证芯片”）
  if (/QDII|美股|美国|纳斯达克|标普|道琼斯|罗素|费城半导体|海外|全球/i.test(n)) return 'us';
  return 'domestic';
}

function isGenericKnownQdiiResult(code, result) {
  if (!result) return false;
  const isUsQdii = result.market === 'us' || detectMarketFromName(result.name) === 'us';
  return isUsQdii
    && !result.estimate
    && !result.proxyTicker
    && (result.quoteSource === 'fundgz' || result.quoteSource === 'sina-fu');
}

function isRepeatedGenericQdiiData(cacheKey, result, now = Date.now()) {
  // 忽略随着打点走动的 gztime 时间戳，只针对价格/涨跌幅/单位净值做签名，
  // 避免上游估值价格死锁但时间走动时重置计数器导致降级判定失效
  const signature = [
    result.quoteSource,
    result.fundcode || '',
    result.gsz || '',
    result.gszzl || '',
    result.dwjz || '',
  ].join('|');
  const previous = cache.genericQdiiSource[cacheKey];

  if (!previous || previous.signature !== signature) {
    cache.genericQdiiSource[cacheKey] = { signature, firstSeenAt: now, lastSeenAt: now };
    return false;
  }

  previous.lastSeenAt = now;
  return now - previous.firstSeenAt > GENERIC_QDII_REALTIME_FRESH_MS;
}

function detectCodeKind(code) {
  if (!code) return 'unknown';
  const c = code.trim().toUpperCase();
  if (/^\d{6}$/.test(c)) {
    // A 股个股：仅 60/68 严格前缀 → 个股；00/30/8 模糊（基金常见）→ 当基金
    if (/^(60|68)/.test(c)) return 'stock_a';
    return 'fund_a';                                          // 所有 6 位数字代码按基金路径处理
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

/** SSE 轮询只给明确注册且已有验证扩展源的 QDII 放宽；普通品种保持原常规盘逻辑。 */
function shouldPollValuationNow(code, market, kind, now = new Date()) {
  if (isInTradingTime(code, now, market)) return true;
  if (kind !== 'fund' || !proxyTickers.isKnownProxyFund(code)) return false;
  const config = proxyTickers.getKnownProxyConfig(code);
  if (config?.market !== 'us' || !config.futuresProxy?.enabled) return false;
  return marketTime.getUsMarketSession(now) !== 'closed';
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
  const resolved = getMainlandExchangeSymbol(code, { includeListedEtf: true });
  if (!resolved) return null;
  const { code: c, symbol } = resolved;
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
  const sinaName = parts[0];
  if (!sinaName) return null;
  // 场内 ETF 的 Sina 名称通常只是盘口简称（如“半导设备”）。优先复用小时级
  // 东财基础资料缓存的 fS_name；缓存冷启动仅后台预热，绝不阻塞 10 秒行情循环。
  let name = sinaName;
  if (resolved.instrumentType === 'listed_etf') {
    const basicCached = cache.fundBasic[c];
    if (basicCached && Date.now() - basicCached.timestamp < FUND_BASIC_TTL && basicCached.data?.name) {
      name = basicCached.data.name;
    } else {
      getFundBasicInfo(c).catch(() => {});
    }
  }
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
 * 通过腾讯 Qt 接口获取港股实时数据（优先首选）
 *   接口：http://qt.gtimg.cn/q=r_hk{code}
 */
async function fetchTencentHKStockValuation(code) {
  const symbol = code.toLowerCase().replace(/^r_hk/, '').replace(/^hk/, '');
  const url = `http://qt.gtimg.cn/q=r_hk${symbol}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Referer': 'https://gu.qq.com/' },
    family: 4,
    timeout: 5000
  });
  const text = iconv.decode(Buffer.from(response.data), 'gbk');
  const m = text.match(/="([^"]+)"/);
  if (!m || !m[1]) return null;
  const parts = m[1].split('~');
  if (parts.length < 38) return null;

  const nameZh = parts[1] || '';
  const nameEn = parts[46] || '';
  const current = parseFloat(parts[3]);
  const openVal = parseFloat(parts[4]);
  const prevClose = parseFloat(parts[5]);
  const highVal = parseFloat(parts[33]);
  const lowVal  = parseFloat(parts[34]);
  const volumeVal = parseFloat(parts[36]);
  const turnoverVal = parseFloat(parts[37]);
  const datetime = parts[30] || ''; // YYYY/MM/DD HH:MM:SS

  if (isNaN(current) || current <= 0) return null;

  let calcChange = !isNaN(prevClose) && prevClose > 0 ? current - prevClose : parseFloat(parts[31]);
  let calcChangePct = !isNaN(prevClose) && prevClose > 0 ? ((current - prevClose) / prevClose) * 100 : parseFloat(parts[32]);
  if (isNaN(calcChange)) calcChange = 0;
  if (isNaN(calcChangePct)) calcChangePct = 0;

  let jzrq = '';
  let gztime = '';
  if (datetime) {
    const formatted = datetime.replace(/\//g, '-');
    gztime = formatted;
    jzrq = formatted.split(' ')[0] || '';
  }

  const displayName = nameEn ? `${nameZh} (${nameEn})` : nameZh;

  return {
    fundcode: code.toUpperCase(),
    name: displayName,
    jzrq,
    dwjz: isNaN(prevClose) || prevClose <= 0 ? '0' : prevClose.toFixed(4),
    gsz: current.toFixed(4),
    gszzl: calcChangePct.toFixed(2),
    gztime,
    market: 'hk',
    open: isNaN(openVal) || openVal <= 0 ? undefined : openVal.toFixed(4),
    stockSpecific: {
      open: isNaN(openVal) || openVal <= 0 ? null : openVal,
      high: isNaN(highVal) || highVal <= 0 ? null : highVal,
      low:  isNaN(lowVal)  || lowVal  <= 0 ? null : lowVal,
      volume: isNaN(volumeVal) || volumeVal < 0 ? null : volumeVal,
      turnover: isNaN(turnoverVal) || turnoverVal < 0 ? null : turnoverVal,
      change: calcChange,
    }
  };
}

/**
 * 通过 Sina 行情接口获取港股实时数据（备选降级）
 *   接口：hq.sinajs.cn/list=rt_hk{code}
 */
async function fetchSinaHKStockValuation(code) {
  const symbol = code.toLowerCase().replace(/^rt_hk/, '').replace(/^hk/, '');
  const url = `http://hq.sinajs.cn/list=rt_hk${symbol}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Referer': 'http://finance.sina.com.cn' },
    timeout: 5000
  });
  const text = iconv.decode(Buffer.from(response.data), 'gbk');
  const m = text.match(/="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split(',');
  if (parts.length < 10) return null;
  const nameEn = parts[0];
  const nameZh = parts[1];
  const prevClose = parseFloat(parts[2]);
  const openVal = parseFloat(parts[3]);
  const highVal = parseFloat(parts[4]);
  const lowVal  = parseFloat(parts[5]);
  const current = parseFloat(parts[6]);
  const date = parts[17];    // YYYY/MM/DD
  const time = parts[18];    // HH:MM:SS
  if (isNaN(current) || current <= 0) return null;

  let calcChange = !isNaN(prevClose) && prevClose > 0 ? current - prevClose : parseFloat(parts[7]);
  let calcChangePct = !isNaN(prevClose) && prevClose > 0 ? ((current - prevClose) / prevClose) * 100 : parseFloat(parts[8]);
  if (isNaN(calcChange)) calcChange = 0;
  if (isNaN(calcChangePct)) calcChangePct = 0;

  return {
    fundcode: code.toUpperCase(),
    name: `${nameZh} (${nameEn})`,
    jzrq: date ? date.replace(/\//g, '-') : '',
    dwjz: isNaN(prevClose) || prevClose <= 0 ? '0' : prevClose.toFixed(4),
    gsz: current.toFixed(4),
    gszzl: calcChangePct.toFixed(2),
    gztime: date && time ? `${date.replace(/\//g, '-')} ${time}` : '',
    market: 'hk',
    open: isNaN(openVal) || openVal <= 0 ? undefined : openVal.toFixed(4),
    stockSpecific: {
      open: isNaN(openVal) || openVal <= 0 ? null : openVal,
      high: isNaN(highVal) || highVal <= 0 ? null : highVal,
      low:  isNaN(lowVal)  || lowVal  <= 0 ? null : lowVal,
      volume: isNaN(volumeVal) || volumeVal < 0 ? null : volumeVal,
      turnover: isNaN(turnoverVal) || turnoverVal < 0 ? null : turnoverVal,
      change: calcChange,
    }
  };
}

/**
 * 港股实时估值统一入口：优先腾讯 Qt 接口，网络超时或失败时无缝降级回退 Sina 接口
 */
async function fetchHKStockValuation(code) {
  try {
    const tencentRes = await fetchTencentHKStockValuation(code);
    if (tencentRes) return tencentRes;
  } catch (e) {
    console.warn(`[TencentHK] Fetch ${code} 失败, 降级至 Sina... (${e.message})`);
  }
  return await fetchSinaHKStockValuation(code);
}

/**
 * 通过 Yahoo Finance v8/chart 免 Cookie 接口拉取美股实时/盘前/盘后数据
 *   接口：https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1m&range=1d
 *   备选降级：若 Yahoo 网络请求失败或超时，自动退化使用 Sina 美股 HQ 接口
 */
async function fetchYahooUSStockValuation(ticker) {
  const rawSymbol = ticker.toUpperCase().replace(/^GB_/, '').replace(/^US/, '');
  const yahooSymbol = encodeURIComponent(rawSymbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`;

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 6000
    });

    const result = response.data?.chart?.result?.[0];
    if (!result || !result.meta) return null;

    const meta = result.meta;
    const current = meta.regularMarketPrice;
    if (typeof current !== 'number' || current <= 0) return null;

    const prevClose = meta.chartPreviousClose || meta.previousClose || current;
    const changePct = prevClose > 0 ? ((current - prevClose) / prevClose) * 100 : 0;
    const change = current - prevClose;

    // 获取最高价/最低价/开盘价/成交量
    const openVal = meta.regularMarketDayLow || meta.regularMarketPrice; // fallback
    const highVal = meta.regularMarketDayHigh;
    const lowVal  = meta.regularMarketDayLow;
    const volumeVal = meta.regularMarketVolume;

    // 取最后交易点时间戳转换为 ISO string/北京时间 string (Asia/Shanghai)
    const marketTimeMs = (meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000;
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(marketTimeMs));
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const jzrq = `${m.year}-${m.month}-${m.day}`;
    const gztime = `${jzrq} ${m.hour}:${m.minute}`;

    return {
      fundcode: rawSymbol,
      name: meta.shortName || meta.longName || rawSymbol,
      jzrq,
      dwjz: prevClose.toFixed(4),
      gsz: current.toFixed(4),
      gszzl: changePct.toFixed(2),
      gztime,
      market: 'us',
      open: typeof meta.regularMarketDayHigh === 'number' ? openVal?.toFixed(4) : undefined,
      stockSpecific: {
        open: typeof openVal === 'number' ? openVal : null,
        high: typeof highVal === 'number' ? highVal : null,
        low: typeof lowVal === 'number' ? lowVal : null,
        volume: typeof volumeVal === 'number' ? volumeVal : null,
        turnover: null,
        change: change,
      }
    };
  } catch (e) {
    console.warn(`[Yahoo] Fetch ${rawSymbol} failed (${e.message}), falling back to Tencent/Sina...`);
    return null;
  }
}

/**
 * 通过腾讯 Qt 接口获取美股实时数据（降级第一优先）
 *   接口：http://qt.gtimg.cn/q=us{ticker}
 */
async function fetchTencentUSStockValuation(ticker) {
  const symbol = ticker.toUpperCase().replace(/^GB_/, '').replace(/^US/, '');
  const url = `http://qt.gtimg.cn/q=us${symbol}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Referer': 'https://gu.qq.com/' },
    family: 4,
    timeout: 5000
  });
  const text = iconv.decode(Buffer.from(response.data), 'gbk');
  const m = text.match(/="([^"]+)"/);
  if (!m || !m[1]) return null;
  const parts = m[1].split('~');
  if (parts.length < 35) return null;

  const nameZh = parts[1] || symbol;
  const current = parseFloat(parts[3]);
  const prevClose = parseFloat(parts[4]);
  const openVal = parseFloat(parts[5]);
  const highVal = parseFloat(parts[33]);
  const lowVal  = parseFloat(parts[34]);
  const volumeVal = parseFloat(parts[36]);
  const turnoverVal = parseFloat(parts[37]);
  const datetime = parts[30] || '';

  if (isNaN(current) || current <= 0) return null;

  let calcChange = !isNaN(prevClose) && prevClose > 0 ? current - prevClose : parseFloat(parts[31]);
  let calcChangePct = !isNaN(prevClose) && prevClose > 0 ? ((current - prevClose) / prevClose) * 100 : parseFloat(parts[32]);
  if (isNaN(calcChange)) calcChange = 0;
  if (isNaN(calcChangePct)) calcChangePct = 0;

  let jzrq = '';
  let gztime = '';
  if (datetime) {
    const formatted = datetime.replace(/\//g, '-');
    gztime = formatted.length > 16 ? formatted.slice(0, 16) : formatted;
    jzrq = formatted.split(' ')[0] || '';
  }

  return {
    fundcode: symbol,
    name: nameZh,
    jzrq,
    dwjz: isNaN(prevClose) || prevClose <= 0 ? '0' : prevClose.toFixed(4),
    gsz: current.toFixed(4),
    gszzl: calcChangePct.toFixed(2),
    gztime,
    market: 'us',
    open: isNaN(openVal) || openVal <= 0 ? undefined : openVal.toFixed(4),
    stockSpecific: {
      open: isNaN(openVal) || openVal <= 0 ? null : openVal,
      high: isNaN(highVal) || highVal <= 0 ? null : highVal,
      low:  isNaN(lowVal)  || lowVal  <= 0 ? null : lowVal,
      volume: isNaN(volumeVal) || volumeVal < 0 ? null : volumeVal,
      turnover: isNaN(turnoverVal) || turnoverVal < 0 ? null : turnoverVal,
      change: calcChange,
    }
  };
}

/**
 * 通过 Sina 接口获取美股实时数据（降级第二优先）
 */
async function fetchSinaUSStockValuation(ticker) {
  const symbol = ticker.toLowerCase().replace(/^gb_/, '').replace(/^us/, '');
  const url = `http://hq.sinajs.cn/list=gb_${symbol}`;
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'Referer': 'http://finance.sina.com.cn' },
      timeout: 5000
    });
    const text = iconv.decode(Buffer.from(response.data), 'gbk');
    const m = text.match(/="([^"]+)"/);
    if (!m) return null;
    const parts = m[1].split(',');
    if (parts.length < 26) return null;
    const nameZh = parts[0];
    const current = parseFloat(parts[1]);
    const changePctRaw = parseFloat(parts[2]);
    const datetime = parts[3] || '';
    const change = parseFloat(parts[4]);
    const openVal = parseFloat(parts[5]);
    const highVal = parseFloat(parts[6]);
    const lowVal  = parseFloat(parts[7]);
    const volumeVal = parseFloat(parts[10]);
    const turnoverVal = parseFloat(parts[12]);

    let prevClose = (!isNaN(current) && !isNaN(change)) ? current - change : parseFloat(parts[26] || '');
    if (isNaN(prevClose) || prevClose <= 0) {
      prevClose = current;
    }

    let changePct = changePctRaw;
    if (isNaN(changePct) && prevClose > 0 && !isNaN(current)) {
      changePct = ((current - prevClose) / prevClose) * 100;
    }
    if (isNaN(current) || current <= 0) return null;
    let gztime = '';
    let jzrq = '';
    if (datetime) {
      const m = datetime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/);
      if (m) {
        jzrq = `${m[1]}-${m[2]}-${m[3]}`;
        gztime = `${jzrq} ${m[4]}`;
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
  } catch (e) {
    return null;
  }
}

/**
 * 获取美股估值（优先 Yahoo Finance 接口，失败降级依次尝试 腾讯 Qt 接口 和 Sina 接口）
 */
async function fetchUSStockValuation(ticker) {
  // 1. 优先尝试 Yahoo Finance 接口
  const yahooRes = await fetchYahooUSStockValuation(ticker);
  if (yahooRes) return yahooRes;

  // 2. 降级第一优先：腾讯 Qt 美股接口
  try {
    const tencentRes = await fetchTencentUSStockValuation(ticker);
    if (tencentRes) return tencentRes;
  } catch (e) {
    console.warn(`[TencentUS] Fetch ${ticker} 失败, 降级至 Sina... (${e.message})`);
  }

  // 3. 降级第二优先：Sina 美股接口
  return await fetchSinaUSStockValuation(ticker);
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
    sym = getMainlandExchangeSymbol(c, { includeListedEtf: true })?.symbol || null;
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
 * 东方财富 push2 — 个股资金流向（主力 / 特大单 / 大单 / 中单 / 小单 净流入）
 *   接口：push2.eastmoney.com/api/qt/stock/get
 *   字段映射：从 f10 资金流向页 stock.min.js 反推
 *   （https://emdatah5.eastmoney.com/dc/Content/js/zjlx/stock.min.js
 *    getSSCJData() 调用 ../ZJLX/getZJLXData，fields=f135~f149,f86）
 *
 *     f43  = 现价 / 100
 *     f60  = 昨收 / 100
 *     f86  = 时间戳（秒）
 *     f135 = 主力流入（元）
 *     f136 = 主力流出（元）
 *     f137 = 主力净流入（元）= f135 - f136
 *     f138 = 超大单流入
 *     f139 = 超大单流出
 *     f140 = 超大单净流入（元）  ← 特大单
 *     f141 = 大单流入
 *     f142 = 大单流出
 *     f143 = 大单净流入（元）    ← 大单
 *     f144 = 中单流入
 *     f145 = 中单流出
 *     f146 = 中单净流入（元）
 *     f147 = 小单流入
 *     f148 = 小单流出
 *     f149 = 小单净流入（元）
 *
 *   自校验：f137 ≈ f140 + f143（主力 = 特大 + 大），f135 - f136 ≈ f137
 *   历史误用：曾用 f103/f107/f105/f104（不是资金流向字段，f107 实测返回 1），
 *   现已对照 f10 资金流向页 stock.min.js 修正
 *
 *   缓存 60 秒（资金流向盘中变化较慢）
 *
 *   港股/美股：东财 push2 字段稀疏且不通用 → 返回 null
 */
const _emFlowCache = {};
const EM_FLOW_TTL = 60 * 1000;

async function fetchEastMoneyFlowStockInfo(code, market) {
  if (market !== 'domestic') return null;   // 仅 A 股有完整的资金流向字段
  const c = code.toUpperCase();
  const cacheKey = `${market}:${c}`;
  const now = Date.now();
  const cached = _emFlowCache[cacheKey];
  if (cached && now - cached.ts < EM_FLOW_TTL) {
    return cached.value;
  }

  let secid;
  if (c.startsWith('60') || c.startsWith('68')) secid = `1.${c}`;
  else if (c.startsWith('00') || c.startsWith('30') || c.startsWith('8') || c.startsWith('BJ')) secid = `0.${c.replace(/^BJ/, '')}`;
  else secid = null;
  if (!secid) {
    _emFlowCache[cacheKey] = { ts: now, value: null };
    return null;
  }

  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f60,f86,f135,f136,f137,f140,f143,f146,f149`;
  // 东财 push2 不稳定，加重试
  let d = null;
  for (let attempt = 0; attempt < 3 && !d; attempt++) {
    try {
      const r = await axios.get(url, {
        family: 4,
        headers: {
          'Referer': 'https://quote.eastmoney.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        },
        timeout: 6000,
      });
      d = r.data?.data;
    } catch (e) {
      console.warn(`[emFlow] ${c} attempt ${attempt + 1} 失败:`, e.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!d) {
    _emFlowCache[cacheKey] = { ts: now, value: null };
    return null;
  }
  const current = parseFloat(d.f43) / 100;          // 元
  const mainNet = parseFloat(d.f137) || 0;          // 主力净流入
  const superLargeNet = parseFloat(d.f140) || 0;    // 特大单净流入
  const largeNet = parseFloat(d.f143) || 0;         // 大单净流入
  const mediumNet = parseFloat(d.f146) || 0;        // 中单净流入
  const smallNet = parseFloat(d.f149) || 0;         // 小单净流入
  // 自校验：主力 = 特大 + 大
  const mainDerived = superLargeNet + largeNet;
  const value = {
    current,
    mainNet,
    superLargeNet,
    largeNet,
    mediumNet,
    smallNet,
    mainDerived,         // ≈ mainNet，调试用
  };
  _emFlowCache[cacheKey] = { ts: now, value };
  return value;
}

/**
 * 东方财富 push2delay — push2 备域名，资金流向稳定
 *
 *   背景：
 *     push2.eastmoney.com 在国内网络环境 socket hang up 严重，family:4 也常失败
 *     腾讯 qt.gtimg.cn `q=ff_` 接口已废弃（v_pv_none_match）
 *     雪球 / 163 资金流向均封锁
 *     唯一稳定可用的备选是 push2delay.eastmoney.com（同样 push2 API，不同 IP 池）
 *   验证：5 次连续请求均 200，100~600ms 返回，数据与 push2 完全一致
 *
 *   字段（与 push2 同 schema，f135~f149 系列资金流向）：
 *     f43  = 现价 / 100
 *     f137 = 主力净流入
 *     f140 = 特大单净流入
 *     f143 = 大单净流入
 *     f146 = 中单净流入
 *     f149 = 小单净流入
 *
 *   缓存 60 秒（与 push2 TTL 对齐）
 */
const _emDelayFlowCache = {};
const EM_DELAY_FLOW_TTL = 60 * 1000;

async function fetchEastMoneyDelayFlowStockInfo(code, market) {
  if (market !== 'domestic') return null;
  const c = code.toUpperCase();
  const cacheKey = `${market}:${c}`;
  const now = Date.now();
  const cached = _emDelayFlowCache[cacheKey];
  if (cached && now - cached.ts < EM_DELAY_FLOW_TTL) {
    return cached.value;
  }

  let secid;
  if (c.startsWith('60') || c.startsWith('68')) secid = `1.${c}`;
  else if (c.startsWith('00') || c.startsWith('30') || c.startsWith('8') || c.startsWith('BJ')) secid = `0.${c.replace(/^BJ/, '')}`;
  else {
    _emDelayFlowCache[cacheKey] = { ts: now, value: null };
    return null;
  }

  const url = `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f60,f86,f137,f140,f143,f146,f149`;
  try {
    const r = await axios.get(url, {
      family: 4,
      headers: {
        'Referer': 'https://quote.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      timeout: 6000,
    });
    const d = r.data?.data;
    if (!d) {
      _emDelayFlowCache[cacheKey] = { ts: now, value: null };
      return null;
    }
    const current = parseFloat(d.f43) / 100;
    const mainNet = parseFloat(d.f137) || 0;
    const superLargeNet = parseFloat(d.f140) || 0;
    const largeNet = parseFloat(d.f143) || 0;
    const mediumNet = parseFloat(d.f146) || 0;
    const smallNet = parseFloat(d.f149) || 0;
    const mainDerived = superLargeNet + largeNet;
    const value = {
      current,
      mainNet,
      superLargeNet,
      largeNet,
      mediumNet,
      smallNet,
      mainDerived,
      _source: 'push2delay',
    };
    _emDelayFlowCache[cacheKey] = { ts: now, value };
    return value;
  } catch (e) {
    console.warn(`[emDelayFlow] ${c} 失败:`, e.message);
    _emDelayFlowCache[cacheKey] = { ts: now, value: null };
    return null;
  }
}

/**
 * 个股资金流向统一入口：push2 优先 → push2delay 备域名兜底
 *   push2.eastmoney.com 经常 socket hang up
 *   push2delay.eastmoney.com 是 push2 的稳定备选域名（不同 IP 池，同 schema）
 *   注：曾尝试用腾讯 ff_ 兜底，但该接口已废弃（v_pv_none_match）
 */
async function fetchStockCapitalFlow(code, market) {
  if (market !== 'domestic') return null;

  // 1. 优先 push2
  try {
    const em = await fetchEastMoneyFlowStockInfo(code, market);
    if (em) return em;
  } catch {}

  // 2. push2 失败 → 切换 push2delay
  try {
    return await fetchEastMoneyDelayFlowStockInfo(code, market);
  } catch (e) {
    console.warn(`[capitalFlow] ${code} 双域名均失败:`, e.message);
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
const MINUTE_CACHE_TTL = 10 * 1000;

async function fetchStockMinuteData(code, market, kind = null) {
  const c = code.toUpperCase();

  // 1. QDII 基金代理标的自动识别与重定向：若为 6 位基金代码且属于美股/港股/QDII 市场，
  //    自动匹配对应代理美股/港股标的（如 QQQ / SPY / SOXX 等），避免获取 0 点导致走势图变成平线。
  let targetTicker = c;
  let targetMarket = market;

  if (/^\d{6}$/.test(c)) {
    const proxyConfig = proxyTickers.getKnownProxyConfig(c);
    if (proxyConfig && proxyConfig.regularProxy?.tencentSymbol) {
      const sym = proxyConfig.regularProxy.tencentSymbol;
      if (sym.startsWith('us')) {
        targetTicker = sym.slice(2);
        targetMarket = 'us';
      } else if (sym.startsWith('hk')) {
        targetTicker = sym.slice(2);
        targetMarket = 'hk';
      }
    } else if (market === 'us' || market === 'hk') {
      const basic = cache.fundBasic[c]?.data;
      const fundName = basic?.name || '';
      if (/纳斯达克|Nasdaq/i.test(fundName)) {
        targetTicker = 'QQQ';
        targetMarket = 'us';
      } else if (/标普|S&P/i.test(fundName)) {
        targetTicker = 'SPY';
        targetMarket = 'us';
      } else if (/芯片|半导体|SOXX/i.test(fundName)) {
        targetTicker = 'SOXX';
        targetMarket = 'us';
      } else if (/全球|科技|互联网/i.test(fundName)) {
        targetTicker = 'QQQ';
        targetMarket = 'us';
      }
    }
  }

  // 缓存 key 必须按原始请求代码 c（如 001668 / 040046）隔绝，不能按代理标的 targetTicker (QQQ) 共享，
  // 避免多个共享同一代理 ETF 的 QDII 基金相互污染对方的缩放分时缓存。
  const cacheKey = `${targetMarket}:${c}:${kind || 'default'}`;
  const now = Date.now();
  const cached = _minuteCache[cacheKey];
  if (cached && now - cached.ts < MINUTE_CACHE_TTL) {
    return cached.data;
  }

  const isStock = kind ? (kind === 'stock') : (detectCodeKind(targetTicker) === 'stock_a');
  let result = null;
  try {
    // 1. 【优先从本地数据库获取】：读取 quote_snapshots 表保存的打点历史
    const dbSnapshots = await fetchSnapshotMinuteData(code, targetMarket);
    // 美股或个股分时图需要连续波动点，若数据库中打点点数 >= 10，认为拥有有效历史轨迹，直接采用
    if (dbSnapshots && dbSnapshots.length >= 10) {
      result = dbSnapshots;
    } else if (targetTicker !== code) {
      const proxySnapshots = await fetchSnapshotMinuteData(targetTicker, targetMarket);
      if (proxySnapshots && proxySnapshots.length >= 10) {
        result = proxySnapshots;
      }
    }

    // 2. 若本地数据库历史打点少于 10 个（例如刚添加或非交易时段只有少量静态打点），
    //    则补充从第三方 API 抓取全量分钟 K 线（美股含 391 个 1 分钟点）
    if (!result || result.length < 10) {
      // 2.1 美股优先使用东财 Trends2 API（覆盖全面，含 391 个全量 1 分钟点，规避腾讯接口美股单点问题）
      if (targetMarket === 'us') {
        try {
          const emUrl = `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=105.${targetTicker}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58`;
          const r = await axios.get(emUrl, { timeout: 3000 });
          const trends = r.data?.data?.trends;
          const emPreClose = parseFloat(r.data?.data?.prePrice || r.data?.data?.preClose || r.data?.data?.preSettlement) || 0;
          if (Array.isArray(trends) && trends.length >= 2) {
            result = trends.map(line => {
              const parts = line.split(',');
              if (parts.length < 3) return null;
              const timeStr = parts[0]; // "2026-08-18 21:30"
              const closePrice = parseFloat(parts[2]);
              const vol = parseFloat(parts[5]) || 0;
              const amt = parseFloat(parts[6]) || 0;
              if (isNaN(closePrice) || closePrice <= 0) return null;
              return {
                time: `${timeStr}:00`,
                open: closePrice,
                high: parseFloat(parts[3]) || closePrice,
                low: parseFloat(parts[4]) || closePrice,
                close: closePrice,
                volume: vol,
                amount: amt,
              };
            }).filter(Boolean);
            if (result && emPreClose > 0) {
              result.preClose = emPreClose;
            }
          }
        } catch (err) {
          console.warn(`[minute] 东财美股 API ${targetTicker} 获取失败:`, err.message);
        }
      }

      // 2.2 腾讯分钟数据 API（覆盖 A 股、港股，以及部分美股）
      if (!result || result.length < 2) {
        let tencentSym = null;
        if (targetMarket === 'domestic') {
          tencentSym = getMainlandExchangeSymbol(targetTicker, { includeListedEtf: true, isStock })?.symbol || null;
        } else if (targetMarket === 'hk') {
          tencentSym = `hk${targetTicker.padStart(5, '0')}`;
        } else if (targetMarket === 'us') {
          tencentSym = `us${targetTicker}`;
        }

        if (tencentSym) {
          try {
            const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tencentSym}`;
            const r = await axios.get(url, { timeout: 3000 });
            const rawArr = r.data?.data?.[tencentSym]?.data?.data;
            if (Array.isArray(rawArr) && rawArr.length >= 2) {
              const today = new Date();
              const yyyy = today.getFullYear();
              const M = String(today.getMonth() + 1).padStart(2, '0');
              const d = String(today.getDate()).padStart(2, '0');

              let prevCumVol = 0;
              let prevCumAmt = 0;

              result = rawArr.map(line => {
                const [hm, priceStr, cumVolStr, cumAmtStr] = line.split(' ');
                if (!hm || !priceStr) return null;

                const p = parseFloat(priceStr);
                const cumVol = parseFloat(cumVolStr) || 0;
                const cumAmt = parseFloat(cumAmtStr) || 0;

                const stepVol = Math.max(0, cumVol - prevCumVol);
                const stepAmt = Math.max(0, cumAmt - prevCumAmt);

                prevCumVol = cumVol;
                prevCumAmt = cumAmt;

                const hh = hm.slice(0, 2);
                const mm = hm.slice(2, 4);

                return {
                  time: `${yyyy}-${M}-${d} ${hh}:${mm}:00`,
                  open: p,
                  high: p,
                  low: p,
                  close: p,
                  volume: stepVol > 0 ? stepVol : (cumVol > 0 ? cumVol / rawArr.length : 100),
                  amount: stepAmt > 0 ? stepAmt : (cumAmt > 0 ? cumAmt / rawArr.length : p * 100),
                };
              }).filter(Boolean);
            }
          } catch (err) {
            console.warn(`[minute] 腾讯 API ${tencentSym} 获取失败，准备 fallback:`, err.message);
          }
        }
      }

      // 2.3 Yahoo Chart API / 新浪美股 K 线兜底
      if (!result && targetMarket === 'us') {
        try {
          const yahooSymbol = encodeURIComponent(targetTicker);
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`;
          const r = await axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/json'
            },
            timeout: 3000
          });
          const chartRes = r.data?.chart?.result?.[0];
          if (chartRes && Array.isArray(chartRes.timestamp)) {
            const timestamps = chartRes.timestamp;
            const quotes = chartRes.indicators?.quote?.[0]?.close || [];
            const volumes = chartRes.indicators?.quote?.[0]?.volume || [];
            result = timestamps.map((ts, i) => {
              const p = quotes[i];
              if (typeof p !== 'number' || isNaN(p)) return null;
              const d = new Date(ts * 1000);
              const yyyy = d.getFullYear();
              const M = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              const hh = String(d.getHours()).padStart(2, '0');
              const mm = String(d.getMinutes()).padStart(2, '0');
              const vol = volumes[i] || 100;
              return {
                time: `${yyyy}-${M}-${day} ${hh}:${mm}:00`,
                open: p,
                high: p,
                low: p,
                close: p,
                volume: vol,
                amount: p * vol,
              };
            }).filter(Boolean);
          }
        } catch (err) {
          console.warn(`[minute] Yahoo Chart API ${targetTicker} 获取失败:`, err.message);
        }
      }

      if (!result && targetMarket === 'us') {
        try {
          const s = targetTicker.toLowerCase();
          const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_mink=/US_MinKService.getMinK?symbol=${s}`;
          const r = await axios.get(url, {
            headers: { 'Referer': 'https://finance.sina.com.cn' },
            timeout: 4000
          });
          const text = typeof r.data === 'string' ? r.data : '';
          const start = text.indexOf('[');
          const end = text.lastIndexOf(']');
          if (start !== -1 && end !== -1) {
            const arr = JSON.parse(text.slice(start, end + 1));
            if (Array.isArray(arr) && arr.length > 0) {
              result = arr.map(item => {
                const p = parseFloat(item.c);
                if (isNaN(p) || p <= 0) return null;
                return {
                  time: item.m,
                  open: parseFloat(item.o) || p,
                  high: parseFloat(item.h) || p,
                  low: parseFloat(item.l) || p,
                  close: p,
                  volume: parseFloat(item.v) || 100,
                  amount: (parseFloat(item.v) || 100) * p,
                };
              }).filter(Boolean);
            }
          }
        } catch (err) {
          console.warn(`[minute] 新浪美股 API ${targetTicker} 获取失败:`, err.message);
        }
      }

      if (!result && targetMarket === 'domestic') {
        const symbol = getMainlandExchangeSymbol(targetTicker, { includeListedEtf: true, isStock })?.symbol || null;
        if (symbol) {
          const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=1&datalen=240`;
          const r = await axios.get(url, {
            headers: { 'Referer': 'https://finance.sina.com.cn' },
            timeout: 6000,
            validateStatus: s => s === 200,
          });
          const text = typeof r.data === 'string' ? r.data : '';
          const m = text.match(/=\(\[([\s\S]+?)\]\)\s*;?\s*$/);
          if (m) {
            const arr = JSON.parse(`[${m[1]}]`);
            if (Array.isArray(arr) && arr.length > 0) {
              result = arr.map(d => ({
                time: d.day,
                open: parseFloat(d.open),
                high: parseFloat(d.high),
                low: parseFloat(d.low),
                close: parseFloat(d.close),
                volume: parseFloat(d.volume) || 0,
                amount: parseFloat(d.amount) || 0,
              }));
            }
          }
        }
      }
    }
    // 3. 当获取到多于 2 个点的全量分钟 K 线时：
    //    若为 QDII 代理标的（targetTicker !== code），需将代理标的（如 QQQ 美金 718 元）的相对涨跌幅，
    //    缩放到该 QDII 基金本身的净值（如 5.4355 元）维度，避免走势图与 Tooltip 标注出现 +13119% 量纲错位。
    if (result && result.length >= 2) {
      if (targetTicker !== code) {
        // 先保存代理标的原生 K 线到 quote_snapshots（以 QQQ 等代理代码归档）
        saveMinuteBarsToDb(targetTicker, result);

        let lastNav = null;
        try {
          const val = cache.fund[c]?.data || (await getFundValuation(c, kind).catch(() => null));
          if (val && val.dwjz) {
            lastNav = parseFloat(val.dwjz);
          }
        } catch {}

        const basePrice = result.preClose || result[0]?.close || result[0]?.open || 0;
        if (lastNav > 0 && basePrice > 0 && Math.abs(basePrice - lastNav) / lastNav > 0.3) {
          const scaledResult = result.map(b => {
            const ratio = b.close / basePrice;
            const scaledClose = parseFloat((lastNav * ratio).toFixed(4));
            const openRatio = (b.open || b.close) / basePrice;
            const highRatio = (b.high || b.close) / basePrice;
            const lowRatio = (b.low || b.close) / basePrice;
            return {
              ...b,
              open: parseFloat((lastNav * openRatio).toFixed(4)),
              high: parseFloat((lastNav * highRatio).toFixed(4)),
              low: parseFloat((lastNav * lowRatio).toFixed(4)),
              close: scaledClose,
            };
          });
          saveMinuteBarsToDb(code, scaledResult);
          result = scaledResult;
        } else {
          saveMinuteBarsToDb(code, result);
        }
      } else {
        saveMinuteBarsToDb(code, result);
      }
    }
  } catch (e) {
    console.warn(`[minute] ${targetTicker} (${targetMarket}) 获取异常:`, e.message);
  }

  _minuteCache[cacheKey] = { ts: now, data: result };
  return result;
}

/**
 * 将第三方 API 获取的全量分钟 K 线数据异步持久化落库至 quote_snapshots
 */
function saveMinuteBarsToDb(code, bars) {
  if (!code || !Array.isArray(bars) || bars.length === 0) return;
  const c = String(code).toUpperCase();
  try {
    for (const b of bars) {
      if (!b.time || typeof b.close !== 'number' || isNaN(b.close) || b.close <= 0) continue;
      // 解析 Beijing 时间字符串为 timestamp
      const timeStr = b.time.includes('T') ? b.time : b.time.replace(' ', 'T') + '+08:00';
      const ts = Date.parse(timeStr);
      if (!ts || isNaN(ts)) continue;
      dbHelper.run(
        `INSERT OR IGNORE INTO quote_snapshots (code, captured_at, gztime, current, pct, raw)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [c, ts, b.time, b.close, null, null]
      ).catch(() => {});
    }
  } catch (e) {
    console.warn(`[saveMinuteBars] ${code} 入库失败:`, e.message);
  }
}

/**
 * 从 SQLite quote_snapshots 读取系统今日抓取的真实快照数据（按时间升序）
 * 适合场外基金或无传统 K 线的品种，用于前端 0 伪造绘制真实盘中变动轨迹
 */
function sanitizeSnapshotSpikes(points, thresholdPct = 1.5) {
  if (!points || points.length < 3) return points;
  const result = [];
  const len = points.length;

  for (let i = 0; i < len; i++) {
    const curr = points[i];
    const prev = result.length > 0 ? result[result.length - 1] : null;
    let next = i < len - 1 ? points[i + 1] : null;

    if (prev && next) {
      let lookAheadIndex = i + 1;
      while (lookAheadIndex < len && lookAheadIndex <= i + 3) {
        const candidate = points[lookAheadIndex];
        const diffWithPrev = Math.abs((candidate.close - prev.close) / prev.close) * 100;
        if (diffWithPrev < thresholdPct) {
          next = candidate;
          break;
        }
        lookAheadIndex++;
      }

      const prevDiff = Math.abs((curr.close - prev.close) / prev.close) * 100;
      const nextDiff = next ? Math.abs((curr.close - next.close) / next.close) * 100 : 0;
      const bridgeDiff = next ? Math.abs((next.close - prev.close) / prev.close) * 100 : 0;

      if (prevDiff > thresholdPct && nextDiff > thresholdPct && bridgeDiff < thresholdPct * 1.2) {
        continue; // 过滤中间孤立针状 Spike
      }
    } else if (prev && !next) {
      // 尾部针状毛刺检测：末点相比倒数第二点发生 > 1.5% 的离群突变
      const prevDiff = Math.abs((curr.close - prev.close) / prev.close) * 100;
      if (prevDiff > thresholdPct) {
        continue; // 过滤末尾突变点
      }
    }

    result.push(curr);
  }

  return result;
}

async function fetchSnapshotMinuteData(code, market = null) {
  try {
    const c = String(code).toUpperCase();
    // 往前查 72 小时，覆盖任意市场（美股/港股/A股）的上一个完整 session，
    // 前端 buildSeries 会按各自 session 窗口（startTs/endTs）做精确过滤。
    // 72h 足以跨过美股周末空档（周五收盘 → 周一白天），避免周一盘中分时图丢失周五 session。
    const since = Date.now() - 72 * 3600 * 1000;
    const rows = await dbHelper.all(
      `SELECT captured_at, gztime, current, pct FROM quote_snapshots
       WHERE (code = ? OR code = ?) AND captured_at >= ?
       ORDER BY captured_at ASC`,
      [code, c, since]
    );

    if (!rows || rows.length === 0) return null;

    const rawPoints = [];
    let lastTimeStr = '';
    for (const r of rows) {
      if (typeof r.current !== 'number' || !Number.isFinite(r.current) || r.current <= 0) continue;
      // 若为 6 位公募/QDII 基金代码，过滤掉因历史代理标的原生报价未缩放写入的污染打点 (> 50 元)
      if (/^\d{6}$/.test(c) && r.current > 50) continue;

      const d = new Date(r.captured_at);
      const bjtHour = marketTime.getBeijingHour(d);

      // 如果为美股/美股基金，过滤掉发生在白天及盘前 05:00 - 21:15 的非常规交易时段打点，只保留交易窗口内的分时点
      const bjtMin = d.getMinutes();
      if (market === 'us' && (bjtHour >= 5 && bjtHour < 21 || (bjtHour === 21 && bjtMin < 15))) {
        continue;
      }

      const timeStr = marketTime.formatBeijingYmdHm(d) + ':00';

      // 去重：同 10 秒以内的重复打点更新覆盖
      const timeKey = timeStr.slice(0, 18);
      const item = {
        time: timeStr,
        open: r.current,
        high: r.current,
        low: r.current,
        close: r.current,
        volume: 0,
        amount: 0
      };
      if (timeKey === lastTimeStr && rawPoints.length > 0) {
        rawPoints[rawPoints.length - 1] = item;
      } else {
        lastTimeStr = timeKey;
        rawPoints.push(item);
      }
    }

    const points = sanitizeSnapshotSpikes(rawPoints);
    return points.length > 0 ? points : null;
  } catch (e) {
    console.warn(`[snapshotMinute] ${code} fetch failed:`, e.message);
    return null;
  }
}

/**
 * 读取上一场美股常规交易时段（北京时间 21:30 - 05:00）捕获的最新真实快照。
 * 用于美股休市/白天非交易时段，防止上游占位符或持仓预估与昨夜收盘估值产生脱节。
 */
async function getLastUsSessionSnapshotFromDb(code) {
  try {
    // 72h 跨周末覆盖：周一白天需回读到周五美股常规盘收盘（约 59h 前），36h 会漏掉。
    const since = Date.now() - 72 * 3600 * 1000;
    const c = String(code).toUpperCase();
    const rows = await dbHelper.all(
      `SELECT raw, captured_at FROM quote_snapshots
       WHERE (code = ? OR code = ?) AND captured_at >= ?
       ORDER BY captured_at DESC`,
      [code, c, since]
    );
    if (!rows || rows.length === 0) return null;
    for (const r of rows) {
      const d = new Date(r.captured_at);
      const h = marketTime.getBeijingHour(d);
      if (h >= 21 || h < 5) {
        if (r.raw) {
          try {
            const parsed = JSON.parse(r.raw);
            if (parsed && parseFloat(parsed.gsz) > 0) return parsed;
          } catch {}
        }
      }
    }
    return null;
  } catch (e) {
    console.warn(`[lastUsSnapshot] ${code} query failed:`, e.message);
    return null;
  }
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
  const market = detectMarketFromName(name);

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
 * 股票 K 线历史数据（A 股 / 港股 / 美股 通用）
 *   美股：第一优先级使用 Yahoo Finance K线历史接口 (v8/finance/chart)，降级回退腾讯
 *   A股/港股：优先使用腾讯 AppStock K线接口
 *   返回标准化格式：[{ date, open, high, low, close, volume }]
 */
async function fetchStockKLineHistory(code, days = 30) {
  const c = code.trim();
  const isUS = /^[A-Za-z]{1,5}$/.test(c);

  // 1. 美股第一优先级：优先使用 Yahoo Finance Chart 接口 (v8/finance/chart) 拉取历史日 K 线
  if (isUS) {
    try {
      const yahooSymbol = encodeURIComponent(c.toUpperCase());
      const rangeParam = days <= 7 ? '1wk' : (days <= 35 ? '1mo' : '3mo');
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=${rangeParam}`;
      const r = await axios.get(yahooUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        timeout: 6000
      });
      const chartRes = r.data?.chart?.result?.[0];
      if (chartRes && Array.isArray(chartRes.timestamp) && chartRes.timestamp.length > 0) {
        const timestamps = chartRes.timestamp;
        const quotes = chartRes.indicators?.quote?.[0] || {};
        const opens = quotes.open || [];
        const highs = quotes.high || [];
        const lows = quotes.low || [];
        const closes = quotes.close || [];
        const volumes = quotes.volume || [];

        const list = timestamps.map((ts, i) => {
          const closeVal = closes[i];
          if (typeof closeVal !== 'number' || isNaN(closeVal)) return null;
          const d = new Date(ts * 1000);
          const dateStr = d.toISOString().slice(0, 10);
          return {
            date: dateStr,
            open: opens[i] || closeVal,
            high: highs[i] || closeVal,
            low: lows[i] || closeVal,
            close: closeVal,
            volume: volumes[i] || 0,
          };
        }).filter(Boolean);

        if (list.length > 0) return list;
      }
    } catch (err) {
      console.warn(`[kline] Yahoo Chart API 美股 ${c} 获取历史日 K 线失败, 准备降级回退新浪:`, err.message);
    }

    // 2. 美股第二优先级（降级备用）：新浪 US_MinKService 全量日 K 线接口（数据完整无极差断层）
    try {
      const s = c.toLowerCase();
      const sinaUrl = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_us_${s}=/US_MinKService.getDailyK?symbol=${s}`;
      const r = await axios.get(sinaUrl, {
        headers: {
          'Referer': 'https://finance.sina.com.cn',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 6000
      });
      const text = r.data;
      const start = typeof text === 'string' ? text.indexOf('[') : -1;
      const end = typeof text === 'string' ? text.lastIndexOf(']') : -1;
      if (start !== -1 && end !== -1) {
        const jsonStr = text.slice(start, end + 1);
        const arr = JSON.parse(jsonStr);
        if (Array.isArray(arr) && arr.length > 0) {
          const list = arr.map(item => ({
            date: item.d,
            open: parseFloat(item.o) || 0,
            high: parseFloat(item.h) || 0,
            low: parseFloat(item.l) || 0,
            close: parseFloat(item.c) || 0,
            volume: parseFloat(item.v) || 0,
          })).filter(k => k.close > 0);
          if (list.length > 0) {
            return list.slice(-days);
          }
        }
      }
    } catch (err) {
      console.warn(`[kline] 新浪 API 美股 ${c} 降级获取历史日 K 线失败, 准备降级回退腾讯:`, err.message);
    }
  }

  // 2. A股/港股，或美股 Yahoo 失败时的降级路径：腾讯 AppStock K线接口
  let symbol, url;
  if (/^\d{6}$/.test(c)) {
    const resolved = getMainlandExchangeSymbol(c, { includeListedEtf: true });
    if (!resolved) return [];
    symbol = resolved.symbol;
    url = 'http://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
  } else if (isUS) {
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
    if (d && d.code === 0 && d.data) {
      const key = Object.keys(d.data).find(k => k !== 'qt') || Object.keys(d.data)[0];
      if (key && key !== 'qt') {
        const arr = d.data[key]?.day || d.data[key]?.qfqday || [];
        if (Array.isArray(arr) && arr.length > 0) {
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
        }
      }
    }
  } catch (e) {
    console.error(`[kline] 腾讯 API ${code} 失败:`, e.message);
  }

  return [];
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

  // 提取前十大 stockCodes，并复用统一的新浪优先 / 腾讯补缺报价链。
  const m = pingText.match(/stockCodes\s*=\s*\[([^\]]+)\]/);
  if (!m) return null;
  const codesRaw = m[1].match(/"([^"]+)"/g)?.map(s => s.slice(1, -1)) || [];
  const stocks = parseStockCodes(codesRaw.slice(0, 10), { onlyNonAShare: true })
    .filter(s => s.exchange === 'US' || s.exchange === 'HK' || s.exchange === 'JP' || s.exchange === 'KR' || s.exchange === 'SH' || s.exchange === 'SZ');
  if (stocks.length < 3) return null;

  const quotes = await fetchStockQuotes(stocks);
  const quoteKey = stock => stock.exchange === 'US'
    ? `gb_${stock.code.toLowerCase()}`
    : stock.exchange === 'JP'
      ? `jp_${stock.code.toLowerCase()}`
      : stock.exchange === 'KR'
        ? `kr_${stock.code}`
        : stock.exchange === 'SH' || stock.exchange === 'SZ'
          ? `${stock.market}${stock.code}`
          : `rt_hk${stock.code}`;
  const expectedKeys = stocks.map(quoteKey);
  const validQuotes = expectedKeys.map(key => quotes.get(key)).filter(quote =>
    quote && Number.isFinite(quote.price) && quote.price > 0
    && Number.isFinite(quote.changePct) && Math.abs(quote.changePct) < 50
  );

  // 美股/港股 QDII 必须由新浪 + 腾讯完整覆盖所有可识别的前十大海外持仓，
  // 否则放弃持仓估算，交给专用代理 ETF 或官方净值路径处理。
  if (validQuotes.length !== expectedKeys.length) {
    console.warn(`[holdings] ${code} 行情覆盖不完整 (${validQuotes.length}/${expectedKeys.length})，放弃持仓估算`);
    return null;
  }
  const changes = validQuotes.map(quote => quote.changePct);

  // 4. 等权平均 + 拉官方名称
  // 异常剔除：单只 change% 偏离 median 超过 15 个百分点（例如港铁 -0.85% / 真实
  // +12% 美股区间里有只 +50% 的极端值会污染均值）。这是防御性 — 应在字段读取层
  // 已经做了市场区分，这里再做一次统计兜底。
  const sorted = [...changes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const filtered = changes.filter(v => Math.abs(v - median) <= 15 || sorted.length < 4);
  // 完整集合中的异常值不能被静默剔除后继续估算，否则仍会变成残缺持仓样本。
  if (filtered.length !== changes.length) {
    console.warn(`[holdings] ${code} 存在异常持仓涨跌幅，放弃持仓估算`);
    return null;
  }
  const avgChange = filtered.reduce((a, b) => a + b, 0) / filtered.length;
  const usedTencent = validQuotes.some(quote => quote.source === 'tencent-qt');
  const nameMatch = pingText.match(/fS_name\s*=\s*"([^"]+)"/);
  const fundName = nameMatch ? nameMatch[1] : `基金 ${code}`;

  // 5. 取最新官方净值作为基准
  const nav = await fetchEastMoneyLSJZ(code);
  if (!nav) return null;
  const lastNav = parseFloat(nav.dwjz);
  if (isNaN(lastNav) || lastNav <= 0) return null;

  const estimatedGsz = lastNav * (1 + avgChange / 100);
  const now = new Date();
  // 所有 gztime 均为北京时间，部署在 UTC 等其它时区的主机也不能偏移。
  const gzTime = marketTime.formatBeijingYmdHm(now);

  // 推断主体市场：若前 10 重仓股中有美股/港股，设置对应 market 属性
  const hasUs = stocks.some(s => s.market === 'us');
  const hasHk = stocks.some(s => s.market === 'hk');
  const hasJp = stocks.some(s => s.market === 'jp');
  const hasKr = stocks.some(s => s.market === 'kr');
  const detectedMarket = hasUs ? 'us' : (hasHk ? 'hk' : (hasJp ? 'jp' : (hasKr ? 'kr' : 'domestic')));

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
    estimateMethod: 'holdings',
    holdingsCount: changes.length,
    holdingsExpectedCount: expectedKeys.length,
    quoteSource: usedTencent ? 'holdings-sina-tencent' : 'holdings-sina',
    officialNavDate: nav.jzrq
  };
}

/**
 * QDII 代理标的估值：当 holdings 数据为空时，按基金名/代码匹配到一个公开 ETF
 *   （如 QQQ / SPY / KWEB），用其盘中涨跌作为基金的近似估值。
 *
 * 适用场景：
 *   - 040046（华安纳斯达克100ETF联接(QDII)A）— 持仓暂时为空（东财 pingzhongdata stockCodes=[]），
 *     历史上 040046 跟踪 Invesco QQQ Trust，所以代理 = usQQQ
 *   - 类似持仓数据暂时下架的 QDII 基金
 *
 * 误差：基金相对代理 ETF 的跟踪误差通常 < 1%，比"昨日官方净值"有意义得多。
 *
 * 数据源：腾讯 qt.gtimg.cn（项目内已验证可用）。
 *   曾尝试 Yahoo Finance v7/finance/quote 和 v8/finance/chart，国内网络 403
 *   稳定复现，已弃用 Yahoo。
 *
 * 缓存：60s 内存复用，避免打爆上游。
 *
 * 失败兜底：任何解析/网络错误都吞掉异常，返回 null（不污染主路径）。
 *
 * @param {string} code 6 位基金代码
 * @param {string} name 基金名（来自 pingzhongdata / 搜索 / LSJZ）
 * @param {number} lastNav 昨日官方单位净值（必须 > 0；调用方从 fetchEastMoneyLSJZ 取）
 * @param {string} navDate  昨日官方净值日期 YYYY-MM-DD
 * @returns {Promise<FundValuation|null>}
 */
async function fetchLegacyProxyTickerValuation(code, name, lastNav, navDate) {
  if (!(lastNav > 0)) return null;

  const match = proxyTickers.matchProxyTicker(name, code);
  if (!match) return null;

  const { tencentSymbol, market, tickerLabel, indexName } = match;
  const now = Date.now();

  // 取代理 ETF 实时涨跌（60s 缓存）
  let changePct = null;
  let proxyGzTime = '';
  const cached = cache.proxyTicker[tencentSymbol];
  if (cached && (now - cached.timestamp < PROXY_TICKER_TTL)) {
    changePct = cached.data?.changePct;
    proxyGzTime = cached.data?.gztime || '';
  } else {
    const url = `http://qt.gtimg.cn/q=${tencentSymbol}`;
    try {
      const r = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { 'Referer': 'https://gu.qq.com/' },
        family: 4,
        timeout: 6000,
      });
      const text = iconv.decode(Buffer.from(r.data), 'gbk');
      // 形如: v_usQQQ="200~纳斯达克100ETF-Invesco~QQQ.OQ~661.73~675.49~...~USD~...~2026-07-29 16:00:01~-13.76~-2.04~..."
      const m = text.match(/v_([A-Za-z0-9]+)="([^"]+)"/);
      if (m && m[2]) {
        const parts = m[2].split('~');
        // 字段索引（实测对齐 fetchStockCapitalFlow / fetchTencentExtraStockInfo 的腾讯字段定义）：
        //   parts[1]  名称
        //   parts[3]  现价
        //   parts[4]  昨收
        //   parts[30] 行情时间 YYYY-MM-DD HH:MM:SS（实测 usQQQ 用此索引；hk02800 类似）
        const price = parseFloat(parts[3]);
        const prevClose = parseFloat(parts[4]);
        if (Number.isFinite(price) && price > 0 && Number.isFinite(prevClose) && prevClose > 0) {
          changePct = ((price - prevClose) / prevClose) * 100;
        }
        if (parts[30]) {
          proxyGzTime = parts[30].replace(/\//g, '-');
        }
      }
    } catch (e) {
      console.warn(`[proxyTicker] tencent quote ${tencentSymbol} 失败:`, e.message);
    }
    // 缓存：失败时缓存 null 以避免短时间内反复打上游
    cache.proxyTicker[tencentSymbol] = {
      data: { changePct: Number.isFinite(changePct) ? changePct : null, gztime: proxyGzTime },
      timestamp: now,
    };
  }

  if (!Number.isFinite(changePct)) return null;

  // 用代理 ETF 的涨跌幅，结合昨日官方 NAV，得到基金的近似盘中估值
  const estimatedGsz = lastNav * (1 + changePct / 100);
  const gzTime = proxyGzTime || marketTime.formatBeijingYmdHm(new Date());

  return {
    fundcode: code,
    name: name || `基金 ${code}`,
    jzrq: navDate || '',
    dwjz: lastNav.toFixed(4),
    gsz: estimatedGsz.toFixed(4),
    gszzl: changePct.toFixed(2),
    gztime: gzTime,
    market,
    estimate: true,
    proxyTicker: tickerLabel,    // 暴露给前端，便于显示"代理标的：QQQ"等标注
    proxyIndexName: indexName,
    proxyTencentSymbol: tencentSymbol,  // 内部留档，便于调试
    officialNavDate: navDate,
  };
}

/** 腾讯 Qt 代理行情。严格匹配请求的 symbol，避免多标的响应误被错误解析。 */
function parseTencentQtQuote(text, expectedSymbol) {
  const escaped = String(expectedSymbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`(?:^|\\n)v_${escaped}="([^"]*)"`));
  if (!match?.[1]) return null;
  const parts = match[1].split('~');
  const price = parseFloat(parts[3]);
  const prevClose = parseFloat(parts[4]);
  const quoteTime = String(parts[30] || '').replace(/\//g, '-');
  // 腾讯 us* 的时间字段是纽约市场本地时间；其它现有腾讯标的按北京时间解析。
  const quoteTimestamp = String(expectedSymbol).toLowerCase().startsWith('us')
    ? marketTime.parseUsEasternDateTime(quoteTime)
    : marketTime.parseBeijingDateTime(quoteTime);
  const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : NaN;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(prevClose) || prevClose <= 0 || !Number.isFinite(changePct) || Math.abs(changePct) >= 20) return null;
  return { symbol: expectedSymbol, name: parts[1] || expectedSymbol, price, prevClose, changePct, quoteTime, quoteTimestamp };
}

async function fetchTencentQtProxyQuote(symbol) {
  const now = Date.now();
  const cached = cache.proxyTicker[symbol];
  if (cached && now - cached.timestamp < PROXY_TICKER_TTL) return cached.data;
  let quote = null;
  try {
    const r = await axios.get(`http://qt.gtimg.cn/q=${encodeURIComponent(symbol)}`, {
      responseType: 'arraybuffer', headers: { Referer: 'https://gu.qq.com/' }, family: 4, timeout: 6000,
    });
    quote = parseTencentQtQuote(iconv.decode(Buffer.from(r.data), 'gbk'), symbol);
  } catch (e) {
    console.warn(`[proxyTicker] tencent quote ${symbol} 失败:`, e.message);
  }
  cache.proxyTicker[symbol] = { data: quote, timestamp: now };
  return quote;
}

const PROXY_QUOTE_FRESH_MS = Object.freeze({
  regular: 5 * 60 * 1000,          // 盘中：5 分钟内为新鲜
  postmarket: 24 * 3600 * 1000,    // 盘后：24 小时内（保持盘后收盘估值）
  premarket: 24 * 3600 * 1000,     // 盘前：24 小时内
  overnight: 24 * 3600 * 1000,     // 隔夜：24 小时内
  closed: 48 * 3600 * 1000,        // 周末/休市：48 小时内
});

function quoteFreshness(quote, session, now = Date.now()) {
  if (!quote?.quoteTimestamp) return { freshness: 'unknown', ageMs: null };
  const ageMs = Math.max(0, now - quote.quoteTimestamp);
  const maxAge = PROXY_QUOTE_FRESH_MS[session] || (24 * 3600 * 1000);
  return { freshness: ageMs <= maxAge ? 'fresh' : 'stale', ageMs };
}

/**
 * 覆盖前面的兼容实现：仅已注册基金可走代理，且只有新鲜上游报价才生成实时估值。
 */
async function fetchProxyTickerValuation(code, name, lastNav, navDate) {
  if (!(lastNav > 0)) return null;
  const config = proxyTickers.getKnownProxyConfig(code);
  if (!config) return null;

  const now = Date.now();
  const session = config.market === 'us' ? marketTime.getUsMarketSession(new Date(now)) : 'regular';
  const instruments = proxyTickers.selectProxyInstruments(config, session);
  let selected = null;
  let fallbackReason = null;
  for (const instrument of instruments) {
    const quote = await fetchTencentQtProxyQuote(instrument.tencentSymbol);
    const { freshness, ageMs } = quoteFreshness(quote, session, now);
    if (freshness === 'fresh') {
      selected = { quote, instrument, freshness, ageMs };
      break;
    }
    fallbackReason = quote ? `${instrument.tickerLabel} 行情${freshness === 'stale' ? '已过期' : '时间未知'}` : `${instrument.tickerLabel} 无可用行情`;
  }
  if (!selected) return null;

  const { quote, instrument, freshness, ageMs } = selected;
  const estimatedGsz = lastNav * (1 + quote.changePct / 100);
  return {
    fundcode: code, name: name || `基金 ${code}`, jzrq: navDate || '', dwjz: lastNav.toFixed(4),
    gsz: estimatedGsz.toFixed(4), gszzl: quote.changePct.toFixed(2), gztime: quote.quoteTime,
    market: config.market, estimate: true, estimateMethod: instrument.type === 'future' ? 'proxy-futures' : 'proxy-etf',
    quoteSource: 'tencent-qt', quoteSourceName: `Tencent Qt / ${instrument.tickerLabel}`,
    quoteSourceSymbol: instrument.tickerLabel, quoteSession: session, quoteTime: quote.quoteTime,
    quoteTimestamp: quote.quoteTimestamp, quoteAgeMs: ageMs, quoteFreshness: freshness,
    proxyTicker: instrument.tickerLabel, proxyIndexName: config.label, proxyTencentSymbol: instrument.tencentSymbol,
    proxyFallbackReason: fallbackReason, officialNavDate: navDate,
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
  const market = detectMarketFromName(name);
  return {
    fundcode: code,
    name,
    jzrq: parts[7] || '',
    dwjz: parts[3] || '0',
    gsz: gsz.toFixed(4),
    gszzl: parts[6] || '0',
    gztime: parts[7] && parts[1] ? `${parts[7]} ${parts[1]}` : '',
    market,
    quoteSource: 'sina-fu'
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
  // 同一 6 位代码可被明确按 stock 或 fund 路由，缓存不能跨路径复用。
  const cacheKey = `${kindOverride || 'auto'}:${String(code).toUpperCase()}`;
  const cached = cache.fund[cacheKey];
  if (cached && (now - cached.timestamp < FUND_CACHE_TTL)) {
    return cached.data;
  }

  // 前端可指定 kind（按 tab 强制走某条路径）；否则按 code 格式自动判
  const kind = (kindOverride === 'fund' ? null : kindOverride) || detectCodeKind(code);
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
            const market = detectMarketFromName(name);

            result = {
              fundcode: rawData.fundcode,
              name,
              jzrq: rawData.jzrq,
              dwjz: rawData.dwjz,
              gsz: rawData.gsz,
              gszzl: rawData.gszzl,
              gztime: rawData.gztime,
              market,
              quoteSource: 'fundgz'
            };
          }
        }
      } catch {}

      // 仅在默认已识别为 A 股个股时探测交易所报价。场内 ETF 必须由显式 kind=stock
      // 进入该路径，避免 Fund tab 的普通基金被无声改成交易所价格语义。
      if (!result && detectCodeKind(code) === 'stock_a') {
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
        const dataTime = marketTime.parseBeijingDateTime(result.gztime);
        if (dataTime != null && Date.now() - dataTime > 7 * 24 * 60 * 60 * 1000) {
          console.log(`[fund] ${code} Sina data stale (${result.gztime}), trying EastMoney f10/lsjz`);
          result = null;
        }
      }
      // 已注册 QDII：普通 fundgz / 新浪基金源最多允许滞后 2 分钟；
      // 1) 即使时间字段仍新鲜，连续超过 2 分钟返回同一行情也视为上游卡住并降级。
      // 2) 白天（非美股交易时间，如 09:30 - 15:00）东财 fundgz / Sina fu_ 经常按 A 股开盘推送全 0 或占位符数据 (例如 09:35 推送 +0.03%/-0.00%)，
      //    必须在此处直接拦截并放弃 generic 源，避免干扰美股 QDII 的持仓估算/代理标的估值。
      if (isGenericKnownQdiiResult(code, result)) {
        const dataTime = marketTime.parseBeijingDateTime(result.gztime);
        const genericFresh = dataTime != null && now - dataTime >= 0
          && now - dataTime <= GENERIC_QDII_REALTIME_FRESH_MS;
        const repeatedData = genericFresh && isRepeatedGenericQdiiData(cacheKey, result, now);

        // 校验白天非美股交易时间段 (美股休市/非盘中时间) 的通用源占位符拦截
        const isUsTrading = isInTradingTime(code, new Date(now), 'us');
        const isDaytimePlaceholder = !isUsTrading && (result.market === 'us' || detectMarketFromName(result.name) === 'us');

        if (!genericFresh || repeatedData || isDaytimePlaceholder) {
          let reason = 'not fresh for over 2 minutes';
          if (isDaytimePlaceholder) reason = 'daytime A-share market open placeholder data (US market closed)';
          else if (repeatedData) reason = 'repeated for over 2 minutes';
          console.log(`[fund] ${code} generic source ${result.quoteSource} ${reason} (${result.gztime || 'no time'}), preferring holdings/proxy`);
          result = null;
        }
      }
      // 第 3 级 fallback：东方财富官方净值
      if (!result) {
        console.log(`[fund] Sina fu_ miss/stale for ${code}, fallback to EastMoney f10/lsjz`);
        result = await fetchEastMoneyLSJZ(code);
      }
      // 第 3.5 级 fallback：对于美股/QDII 基金，在美股非交易阶段（如白天休市）优先读取昨夜美股盘中捕获的最后一帧真实快照，
      // 防止白天基于个股/股指盘前波动的估算与昨夜实际美股走势收盘价脱节。
      // 仅当基金已被识别为美股/QDII 时才启用，避免对 A 股/港股基金误触发快照回放。
      if (!result || result.navOnly) {
        const isUsFund = result?.market === 'us' || detectMarketFromName(result?.name) === 'us';
        const isUsTrading = isInTradingTime(code, new Date(now), 'us');
        if (isUsFund && !isUsTrading) {
          const lastSessionVal = await getLastUsSessionSnapshotFromDb(code);
          if (lastSessionVal) {
            console.log(`[fund] ${code} 美股非交易时段，成功复用上一交易日收盘真实快照 (${lastSessionVal.gztime}: ${lastSessionVal.gsz})`);
            result = lastSessionVal;
          }
        }
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
      // 第 5 级 fallback：代理标的（proxy ticker）路径
      //   适用：东财 pingzhongdata stockCodes 暂时为空、holdings 估算无法执行
      //   的 QDII 基金（如 040046）。按基金名匹配到公开 ETF（QQQ / SPY ...），
      //   用 Yahoo Finance 的实时涨跌 × 昨日官方 NAV，得到盘中近似估值。
      //   误差通常 < 1%，远好于 "navOnly=true" 的昨日净值。
      if (!result || result.navOnly) {
        const fundName = result?.name || '';
        const lastNav = parseFloat(result?.dwjz || '');
        const navDate = result?.jzrq || '';
        console.log(`[fund] ${code} trying proxy-ticker estimate`);
        const proxy = await fetchProxyTickerValuation(code, fundName, lastNav, navDate);
        if (proxy) {
          result = proxy;
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
        // A 股额外追加资金流向（东财优先 → 腾讯兜底）
        if (result.market === 'domestic') {
          try {
            const flow = await fetchStockCapitalFlow(code, result.market);
            if (flow) {
              result.stockSpecific.flow = flow;
            }
          } catch {}
        }
      }

      if (result && !result.navOnly) {
        const cur = parseFloat(result.gsz);
        const p = parseFloat(result.gszzl);
        if (Number.isFinite(cur) && cur > 0) {
          dbHelper.run(
            `INSERT OR REPLACE INTO quote_snapshots (code, captured_at, gztime, current, pct, raw)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [code, now, result.gztime || '', cur, Number.isFinite(p) ? p : null, JSON.stringify(result)]
          ).catch(() => {});
        }
      }

      cache.fund[cacheKey] = { data: result, timestamp: now };
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
      attachMa10(data);
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

    attachMa10(data);
    cache.fundHistory[code] = { data, timestamp: now, days: data.length };
    return data.slice(-days);
  } catch (error) {
    console.error(`[history] 抓取基金 ${code} 历史净值失败:`, error.message);
    if (cached) return cached.data.slice(-days);
    return [];
  }
}

/**
 * 在历史数据数组上原地补 ma10 字段：当前点 + 前 9 个交易日的 dwjz 算术平均。
 * 少于 10 个交易日的早期点 ma10=null（前端据此隐藏 MA10 线起点）。
 * 数据须已按日期升序排列。
 */
function attachMa10(rows) {
  const N = 10;
  for (let i = 0; i < rows.length; i++) {
    if (i < N - 1) { rows[i].ma10 = null; continue; }
    let sum = 0;
    for (let k = i - N + 1; k <= i; k++) sum += rows[k].dwjz;
    rows[i].ma10 = sum / N;
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
function parseStockCodes(codes, opts = {}) {
  // opts.onlyNonAShare: 当基金被识别为 QDII / 海外基金时，禁用 A 股兜底
  // （避免 "000660" 这种港股带 bug 后缀被错切成深证）
  const { onlyNonAShare = false } = opts;
  if (!Array.isArray(codes)) return [];
  return codes.map(raw => {
    const s = String(raw);
    // 后缀规则（来自 pingzhongdata 的 stockCodes）：
    //   105 = 美股 / 港股（Sina 用 105 表示 gb_ 前缀）
    //   106 = 港股（Sina 用 106 表示 rt_hk 前缀）
    //   116 = 港股（早期/特殊格式）
    //   1   = 上证 sh
    //   0   = 深证 sz
    if (s.endsWith('105')) {
      // 美股: "NVDA105" → "NVDA"
      const code = s.slice(0, -3).toUpperCase();
      return { code, market: 'us', exchange: 'US', name: null };
    }
    if (s.endsWith('106') || s.endsWith('116')) {
      // 港股: "00700106" → "00700"
      // 但要排除 ticker 本身是纯字母的情况（东财有时把美股误标 106/116）
      const code = s.slice(0, -3);
      if (/^[A-Za-z]+$/.test(code)) {
        // 例："TSM106" → "TSM"，按美股处理（东财数据 bug：TSM 实际是 NYSE 美股）
        return { code: code.toUpperCase(), market: 'us', exchange: 'US', name: null };
      }
      return { code, market: 'hk', exchange: 'HK', name: null };
    }
    if (s.length === 7 && (s.endsWith('1') || s.endsWith('0'))) {
      // A 股: "6030831" → "603083"，"3005020" → "300502"
      // 7 字符是 pingzhongdata A 股唯一合法格式（A 股基金 + QDII 通过港股通持仓都适用）
      // QDII 也要走这条，否则港股通的 A 股持仓显示不出来
      const suffix = s.slice(-1);
      const code = s.slice(0, -1);
      const market = suffix === '1' ? 'sh' : 'sz';
      return { code, market, exchange: market.toUpperCase(), name: null };
    }
    // 无后缀时按代码形态推测：
    const stripped = s;
    if (/^[A-Za-z]+$/.test(stripped)) {
      return { code: stripped.toUpperCase(), market: 'us', exchange: 'US', name: null };
    }
    // 东京证券交易所的 Growth/新上市股票可使用数字 + 1 个字母，例如铠侠 285A。
    if (/^\d{3,4}[A-Za-z]$/.test(stripped)) {
      return { code: stripped.toUpperCase(), market: 'jp', exchange: 'JP', name: null };
    }
    if (/^\d{3,5}$/.test(stripped)) {
      // 港股代码 1-5 位数字（00066/00700/0285 等），padStart 保证 Sina 识别
      return { code: stripped.padStart(5, '0'), market: 'hk', exchange: 'HK', name: null };
    }
    if (onlyNonAShare && /^\d{6}$/.test(stripped)) {
      // 无后缀的 QDII 六位数字可能是韩国交易所代码（000660.KS、005930.KS）；
      // 不能在解析阶段截成无关的五位港股代码，报价层先按 KR 验证。
      return { code: stripped, market: 'kr', exchange: 'KR', name: null };
    }
    if (!onlyNonAShare && /^\d{6}$/.test(stripped)) {
      // A 股基金兜底：6 位数字按 A 股处理
      const market = (stripped.startsWith('60') || stripped.startsWith('68') || stripped.startsWith('8')) ? 'sh' : 'sz';
      return { code: stripped, market, exchange: market.toUpperCase(), name: null };
    }
    // 其他异常（如 "285A"）→ 原样保留，exchange 空
    return { code: stripped, market: '', exchange: '', name: null };
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
  const jpCodes = stockList.filter(s => s.exchange === 'JP');
  const krCodes = stockList.filter(s => s.exchange === 'KR');
  const wildCodes = stockList.filter(s => !s.exchange);

  const out = new Map();
  const tasks = [];

  // 1. A 股任务
  if (aCodes.length > 0) {
    tasks.push((async () => {
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
    })());
  }

  // 2. 港股任务
  if (hkCodes.length > 0) {
    tasks.push((async () => {
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
          const name = parts[1];
          const price = parseFloat(parts[2]);
          const prevClose = parseFloat(parts[3]);
          const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
          out.set(sym, { name, price, changePct });
        }
      } catch (e) {
        console.warn('[holdings] sina 港股行情失败:', e.message);
      }
    })());
  }

  // 3. 美股任务：优先腾讯 Qt 美股，降级 Sina 美股
  if (usCodes.length > 0) {
    tasks.push((async () => {
      const pendingSina = [];
      try {
        const symbols = usCodes.map(s => `us${s.code.toUpperCase()}`).join(',');
        const r = await axios.get(`http://qt.gtimg.cn/q=${symbols}`, {
          responseType: 'arraybuffer',
          headers: { 'Referer': 'https://gu.qq.com/' },
          family: 4,
          timeout: 6000
        });
        const text = iconv.decode(Buffer.from(r.data), 'gbk');
        for (const line of text.split('\n').filter(Boolean)) {
          const m = line.match(/v_(us[A-Za-z0-9.]+)=(?:"([^"]+)"|'([^']+)')/);
          if (!m) continue;
          const body = m[2] || m[3] || '';
          const parts = body.split('~');
          if (parts.length < 35) continue;
          const sym = m[1];
          const ticker = sym.slice(2).toLowerCase();
          const name = parts[1] || ticker;
          const price = parseFloat(parts[3]);
          const prevClose = parseFloat(parts[4]);
          let changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : parseFloat(parts[32]);
          if (Number.isFinite(price) && price > 0 && Number.isFinite(changePct)) {
            out.set(`gb_${ticker}`, { name, price, changePct, source: 'tencent-qt' });
          }
        }
      } catch (e) {
        console.warn('[holdings] tencent 美股行情失败:', e.message);
      }

      for (const stock of usCodes) {
        const key = `gb_${stock.code.toLowerCase()}`;
        if (!out.has(key)) pendingSina.push(stock);
      }

      if (pendingSina.length > 0) {
        const symbols = pendingSina.map(s => `gb_${s.code.toLowerCase()}`).join(',');
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
            const changePct = parseFloat(parts[2]);
            out.set(sym, {
              name,
              price: Number.isFinite(price) ? price : null,
              changePct: Number.isFinite(changePct) ? changePct : null,
              source: 'sina-gb'
            });
          }
        } catch (e) {
          console.warn('[holdings] sina 美股行情失败:', e.message);
        }
      }
    })());
  }

  // 4. 韩国任务
  if (krCodes.length > 0) {
    tasks.push((async () => {
      const pendingYahoo = [];
      try {
        const symbols = krCodes.map(s => `kr${s.code}`).join(',');
        const r = await axios.get(`http://qt.gtimg.cn/q=${symbols}`, {
          responseType: 'arraybuffer', headers: { Referer: 'https://gu.qq.com/' }, family: 4, timeout: 8000,
        });
        const text = iconv.decode(Buffer.from(r.data), 'gbk');
        for (const line of text.split('\n').filter(Boolean)) {
          const m = line.match(/v_(kr[A-Za-z0-9]+)="([^"]+)"/);
          if (!m?.[2]) continue;
          const parts = m[2].split('~');
          const ticker = m[1].slice(2);
          const price = parseFloat(parts[3]);
          const prevClose = parseFloat(parts[4]);
          const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : NaN;
          if (parts[1] && Number.isFinite(price) && price > 0 && Number.isFinite(changePct)) {
            out.set(`kr_${ticker}`, { name: parts[1], price, changePct, source: 'tencent-qt', resolvedExchange: 'KR' });
          }
        }
      } catch (e) {
        console.warn('[holdings] tencent 韩国行情失败:', e.message);
      }
      for (const stock of krCodes) {
        const key = `kr_${stock.code}`;
        if (!out.has(key)) pendingYahoo.push(stock);
      }
      await Promise.all(pendingYahoo.map(async stock => {
        const ticker = `${stock.code}.KS`;
        try {
          const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 6000,
          });
          const meta = r.data?.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice;
          const prevClose = meta?.chartPreviousClose || meta?.previousClose;
          const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : NaN;
          if (Number.isFinite(price) && price > 0 && Number.isFinite(changePct)) {
            out.set(`kr_${stock.code}`, {
              name: meta.shortName || meta.longName || ticker, price, changePct, source: 'yahoo-finance', resolvedExchange: 'KR',
            });
          }
        } catch (e) {
          console.warn(`[holdings] Yahoo 韩国行情 ${ticker} 失败:`, e.message);
        }
      }));
    })());
  }

  // 5. 日本任务
  if (jpCodes.length > 0) {
    tasks.push((async () => {
      const pendingYahoo = [];
      try {
        const symbols = jpCodes.map(s => `jp${s.code}`).join(',');
        const r = await axios.get(`http://qt.gtimg.cn/q=${symbols}`, {
          responseType: 'arraybuffer', headers: { Referer: 'https://gu.qq.com/' }, family: 4, timeout: 8000,
        });
        const text = iconv.decode(Buffer.from(r.data), 'gbk');
        for (const line of text.split('\n').filter(Boolean)) {
          const m = line.match(/v_(jp[A-Za-z0-9]+)="([^"]+)"/);
          if (!m?.[2]) continue;
          const parts = m[2].split('~');
          const ticker = m[1].slice(2).toUpperCase();
          const price = parseFloat(parts[3]);
          const prevClose = parseFloat(parts[4]);
          const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : NaN;
          if (parts[1] && Number.isFinite(price) && price > 0 && Number.isFinite(changePct)) {
            out.set(`jp_${ticker.toLowerCase()}`, { name: parts[1], price, changePct, source: 'tencent-qt' });
          }
        }
      } catch (e) {
        console.warn('[holdings] tencent 日本行情失败:', e.message);
      }
      for (const stock of jpCodes) {
        const key = `jp_${stock.code.toLowerCase()}`;
        if (!out.has(key)) pendingYahoo.push(stock);
      }
      await Promise.all(pendingYahoo.map(async stock => {
        const ticker = `${stock.code.toUpperCase()}.T`;
        try {
          const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 6000,
          });
          const meta = r.data?.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice;
          const prevClose = meta?.chartPreviousClose || meta?.previousClose;
          const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : NaN;
          if (Number.isFinite(price) && price > 0 && Number.isFinite(changePct)) {
            out.set(`jp_${stock.code.toLowerCase()}`, {
              name: meta.shortName || meta.longName || ticker, price, changePct, source: 'yahoo-finance',
            });
          }
        } catch (e) {
          console.warn(`[holdings] Yahoo 日本行情 ${ticker} 失败:`, e.message);
        }
      }));
    })());
  }

  // 6. 野码任务
  if (wildCodes.length > 0) {
    tasks.push((async () => {
      const wildSyms = wildCodes.map(s => s.code);
      const usTry = wildSyms.filter(c => /^[A-Za-z]+$/.test(c)).map(c => `gb_${c.toLowerCase()}`);
      const hkTry = wildSyms.filter(c => /^\d{5}$/.test(c)).map(c => `rt_hk${c}`);
      const aTry  = wildSyms.filter(c => /^\d{6}$/.test(c)).map(c => `sh${c}`);

      const allTry = [...usTry, ...hkTry, ...aTry].join(',');
      if (allTry) {
        try {
          const r = await axios.get(`http://hq.sinajs.cn/list=${allTry}`, {
            responseType: 'arraybuffer',
            headers: { 'Referer': 'http://finance.sina.com.cn' },
            timeout: 3000
          });
          const text = iconv.decode(Buffer.from(r.data), 'gbk');
          for (const line of text.split('\n').filter(Boolean)) {
            const m = line.match(/var hq_str_([a-z_0-9]+)="([^"]+)"/);
            if (!m) continue;
            const sym = m[1];
            const parts = m[2].split(',');
            if (parts.length < 5) continue;
            let name, price, changePct;
            if (sym.startsWith('gb_')) {
              name = parts[0];
              price = parseFloat(parts[1]);
              changePct = parseFloat(parts[2]);
            } else if (sym.startsWith('rt_hk')) {
              name = parts[1];
              price = parseFloat(parts[6] >= 0 ? parts[6] : parts[2]);
              changePct = parseFloat(parts[8]);
            } else if (/^sh\d{6}$/.test(sym)) {
              name = parts[0];
              price = parseFloat(parts[1]);
              const prevClose = parseFloat(parts[2]);
              changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
            }
            if (name && Number.isFinite(price)) {
              out.set(sym, { name, price, changePct: Number.isFinite(changePct) ? changePct : null });
            }
          }
        } catch (e) {
          console.warn('[holdings] sina 野码行情失败:', e.message);
        }
      }
    })());
  }

  // 并发等待各市场主要接口执行完毕
  await Promise.all(tasks);

  // 7. 腾讯兜底补充未命中小票
  if (stockList.length > 0) {
    const missing = stockList.filter(s => {
      let k;
      if (s.exchange === 'SH' || s.exchange === 'SZ') k = `${s.market}${s.code}`;
      else if (s.exchange === 'HK') k = `rt_hk${s.code}`;
      else if (s.exchange === 'US') k = `gb_${s.code.toLowerCase()}`;
      else {
        const wilds = [`gb_${s.code.toLowerCase()}`, `rt_hk${s.code}`, `sh${s.code}`, `sz${s.code}`, `bj${s.code}`];
        return !wilds.some(wk => out.has(wk));
      }
      const v = out.get(k);
      return !(v && Number.isFinite(v.price) && v.price > 0);
    });

    if (missing.length > 0) {
      const syms = missing.map(s => {
        if (s.exchange === 'SH' || s.exchange === 'SZ') return `${s.market}${s.code}`;
        if (s.exchange === 'HK') return `hk${s.code.padStart(5, '0')}`;
        if (s.exchange === 'US') return `us${s.code.toLowerCase()}`;
        const c = s.code;
        if (/^[A-Za-z]+$/.test(c)) return `us${c.toLowerCase()}`;
        if (/^\d{5}$/.test(c)) return `hk${c}`;
        if (/^\d{6}$/.test(c)) return `sh${c}`;
        return c;
      }).join(',');
      try {
        const r = await axios.get(`http://qt.gtimg.cn/q=${syms}`, {
          responseType: 'arraybuffer',
          headers: { 'Referer': 'https://gu.qq.com/' },
          family: 4,
          timeout: 8000,
        });
        const text = iconv.decode(Buffer.from(r.data), 'gbk');
        for (const line of text.split('\n').filter(Boolean)) {
          const m = line.match(/v_([A-Za-z0-9]+)="([^"]+)"/);
          if (!m || !m[2]) continue;
          const sym = m[1];
          const parts = m[2].split('~');
          if (parts.length < 50) continue;
          let name, price, changePct, quoteKey;
          if (sym.startsWith('sh') || sym.startsWith('sz') || sym.startsWith('bj')) {
            name = parts[1];
            price = parseFloat(parts[3]);
            changePct = parseFloat(parts[33]);
            quoteKey = sym;
          } else if (sym.startsWith('hk')) {
            name = parts[1];
            price = parseFloat(parts[3]);
            changePct = parseFloat(parts[32]);
            quoteKey = `rt_hk${sym.slice(2)}`;
          } else if (sym.startsWith('us')) {
            name = parts[1];
            price = parseFloat(parts[3]);
            const prevClose = parseFloat(parts[4]);
            changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : NaN;
            quoteKey = `gb_${sym.slice(2).toLowerCase()}`;
          }
          if (name && Number.isFinite(price) && price > 0) {
            out.set(quoteKey, {
              name,
              price,
              changePct: Number.isFinite(changePct) ? changePct : null,
              source: 'tencent-qt',
            });
          }
        }
      } catch (e) {
        console.warn('[holdings] tencent 兜底失败:', e.message);
      }
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
 * 获取基金前十大重仓构成。构成每天盘前从上游刷新，实时报价在 getFundHoldings 中单独水合。
 */
async function getFundHoldingComposition(code, { force = false } = {}) {
  if (!/^\d{6}$/.test(code)) return [];
  const now = Date.now();
  const cached = cache.fundHoldingComposition[code];
  if (!force && cached && now - cached.timestamp < FUND_HOLDING_COMPOSITION_TTL) return cached.data;

  if (force) delete cache.fundBasic[code];
  const basic = await getFundBasicInfo(code);
  if (!basic) return cached?.data || [];

  const fundName = basic.name || '';
  const isNonAShareFund = /QDII|海外|全球|港股|美股|纳斯达克|标普|恒生/i.test(fundName);
  const stocks = parseStockCodes(basic.raw.stockCodes, { onlyNonAShare: isNonAShareFund });
  if (stocks.length > 0) cache.fundHoldingComposition[code] = { data: stocks, timestamp: now };
  return stocks.length > 0 ? stocks : (cached?.data || []);
}

async function refreshFundHoldingCompositions(codes, { concurrency = 3 } = {}) {
  const uniqueCodes = [...new Set(codes.filter(code => /^\d{6}$/.test(code)))];
  const results = { total: uniqueCodes.length, success: 0, empty: 0, failed: 0 };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueCodes.length) }, async () => {
    while (cursor < uniqueCodes.length) {
      const code = uniqueCodes[cursor++];
      try {
        const stocks = await getFundHoldingComposition(code, { force: true });
        if (stocks.length > 0) results.success++;
        else results.empty++;
      } catch {
        results.failed++;
      }
    }
  }));
  return results;
}

/**
 * 获取基金前十大重仓股票（上游构成 + 实时行情）。
 * 自由 API 不提供单只股票的占比；列表中只展示股票代码、名称、当日涨跌幅。
 */
async function getFundHoldings(code) {
  if (!/^\d{6}$/.test(code)) return [];
  const now = Date.now();
  const cached = cache.fundHoldings[code];
  if (cached && now - cached.timestamp < FUND_HOLDINGS_TTL) return cached.data;

  const stocks = await getFundHoldingComposition(code);
  if (!stocks.length) {
    cache.fundHoldings[code] = { data: [], timestamp: now };
    return [];
  }

  const [quotes, fx] = await Promise.all([fetchStockQuotes(stocks), getFxRates()]);
  const merged = stocks.map(s => {
    let quoteKey, displayCode;
    if (s.exchange === 'HK') {
      quoteKey = `rt_hk${s.code}`;
      displayCode = `${s.code}.HK`;
    } else if (s.exchange === 'JP') {
      quoteKey = `jp_${s.code.toLowerCase()}`;
      displayCode = `${s.code}.T`;
    } else if (s.exchange === 'KR') {
      quoteKey = `kr_${s.code}`;
      displayCode = `${s.code}.KS`;
    } else if (s.exchange === 'US') {
      quoteKey = `gb_${s.code.toLowerCase()}`;
      displayCode = s.code;
    } else if (s.exchange === 'SH' || s.exchange === 'SZ') {
      quoteKey = `${s.market}${s.code}`;
      displayCode = s.code;
    } else {
      // 野码：尝试多种 quoteKey（fetchStockQuotes 已经塞进所有可能的接口）
      const candidates = [
        `gb_${s.code.toLowerCase()}`,
        `rt_hk${s.code}`,
        `sh${s.code}`,
        `sz${s.code}`,
        `bj${s.code}`,
      ];
      quoteKey = candidates.find(k => quotes.has(k)) || '';
      displayCode = s.code;
    }
    const q = quotes.get(quoteKey);
    const currency = currencyForExchange(s.exchange);
    const price = q ? q.price : null;
    const fxRateToCny = fx.rates?.[currency] ?? null;
    return {
      code: s.code,
      exchange: s.exchange || '',
      displayCode,
      name: q ? q.name : '—',
      price,
      currency,
      priceCny: convertPriceToCny(price, currency, fx.rates),
      fxRateToCny,
      fxStale: fx.stale,
      quoteSource: q?.source || null,
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

    // 状态与 broker 复用同一套目标交易所时区/session 规则，避免服务器本地时区和 DST 偏差。
    const date = new Date();
    const isChinaTradingTime = isInTradingTime('000001', date, 'domestic');

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
            status = isInTradingTime('00700', date, 'hk') ? 'open' : 'closed';
          } else if (code.startsWith('gb_')) {
            status = isInTradingTime('AAPL', date, 'us') ? 'open' : 'closed';
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
async function searchSinaSuggest(q, targetKind = 'fund') {
  const url = `http://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(q)}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 5000,
      responseType: 'arraybuffer',
      headers: { Referer: 'https://finance.sina.com.cn' },
    });
    const text = iconv.decode(data, 'gbk');
    const m = text.match(/"([^"]+)"/);
    if (!m) return [];
    const rows = m[1].split(';').filter(Boolean);
    return rows.map((row) => {
      const cols = row.split(',');
      if (cols.length < 4) return null;
      const code = String(cols[1] || cols[0] || '').trim().toUpperCase();
      const name = String(cols[3] || cols[2] || '').trim();
      const exchange = String(cols[2] || '').toLowerCase();
      const type = String(cols[0] || '').toLowerCase();
      if (!code || !name) return null;
      let market = 'domestic';
      if (exchange === 'hk' || /^\d{4,5}$/.test(code)) market = 'hk';
      else if (exchange.startsWith('gb') || /^[A-Z]{1,5}$/.test(code)) market = 'us';

      // 根据新浪返回的 type 或特征精确判断 kind
      let kind = 'fund';
      if (market === 'hk' || market === 'us' || name.includes('ETF') || name.includes('股票') || type === '11' || type === '12' || type === '15') {
        kind = targetKind; // 尊重目标 Tab
      }
      return { code, name, market, kind };
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
  // 双源：新浪也跑一次
  tasks.push(searchSinaSuggest(q, kind));

  const settled = await Promise.allSettled(tasks);
  const all = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      all.push({ ...item, kind }); // 强制限制为当前 Tab 的 target kind
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
  getFundHoldingComposition,
  refreshFundHoldingCompositions,
  fetchStockQuotes,
  parseStockCodes,
  getMarketIndices,
  detectCodeKind,
  detectMarketFromName,
  currencyForExchange,
  convertPriceToCny,
  getFxRates,
  isRepeatedGenericQdiiData,
  getMainlandExchangeSymbol,
  isInTradingTime,
  shouldPollValuationNow,
  parseTencentQtQuote,
  fetchTencentQtProxyQuote,
  fetchHKStockValuation,
  fetchUSStockValuation,
  fetchSinaFundValuation,
  fetchASHareStockValuation,
  fetchProxyTickerValuation,
  fetchHoldingsBasedEstimate,
  fetchStockMinuteData,
  fetchSnapshotMinuteData,
  fetchEastMoneyFlowStockInfo,
  fetchEastMoneyDelayFlowStockInfo,
  fetchStockCapitalFlow,
  fetchStockKLineHistory,
  searchByName,
  getGoldPrices,
};
