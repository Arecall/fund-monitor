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
  marketTimestamp: 0
};

// 缓存过期时间
const FUND_CACHE_TTL = 30 * 1000;         // 基金估值缓存 30秒
const FUND_HISTORY_TTL = 60 * 60 * 1000;  // 基金历史净值缓存 1小时
const FUND_BASIC_TTL = 60 * 60 * 1000;    // 基金基本/资产配置缓存 1小时
const FUND_HOLDINGS_TTL = 60 * 60 * 1000; // 基金持仓缓存 1小时
const MARKET_CACHE_TTL = 10 * 1000;       // 大盘指数缓存 10秒

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
 *   - 6 位纯数字 → A 股基金（fundgz）
 *   - 5 位数字（00700、09988 等）→ 港股（Sina rt_hk）
 *   - 1-5 位字母 → 美股 ticker（Sina gb_）
 *   - 含 "HK"/"hk" 前缀 → 港股
 *   - 含 "US"/"us" 前缀 → 美股
 */
function detectCodeKind(code) {
  if (!code) return 'unknown';
  const c = code.trim().toUpperCase();
  if (/^\d{6}$/.test(c)) return 'fund_a';                 // A 股 6 位
  if (/^(HK|RT_HK)?\d{4,5}$/.test(c)) return 'fund_hk';     // 港股 5 位
  if (/^(US|GB)?[A-Z]{1,5}$/.test(c)) return 'fund_us';     // 美股 ticker
  if (/^[A-Z]{1,5}$/.test(c)) return 'fund_us';             // 默认按美股
  return 'unknown';
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
  // 字段含义参考 Sina 港股接口：name(1)=中文名, open(5), last_close(3), current(6), change(8), change_pct(9), datetime(18)
  const nameEn = parts[0];
  const nameZh = parts[1];
  const prevClose = parseFloat(parts[3]);
  const current = parseFloat(parts[6]);
  const change = parseFloat(parts[7]);
  const changePct = parseFloat(parts[8]);
  const date = parts[17];    // YYYY/MM/DD
  const time = parts[18];    // HH:MM:SS
  if (isNaN(current) || current <= 0) return null;
  return {
    fundcode: code.toUpperCase(),
    name: `${nameZh} (${nameEn})`,
    jzrq: date ? date.replace(/\//g, '-') : '',
    dwjz: isNaN(prevClose) ? '0' : prevClose.toFixed(4),
    gsz: current.toFixed(4),
    gszzl: isNaN(changePct) ? '0' : changePct.toFixed(2),
    gztime: date && time ? `${date.replace(/\//g, '-')} ${time}` : '',
    market: 'hk'
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
  // Sina 美股字段顺序（已实测）：
  //   name(0)=中文名, current(1), change_pct(2), datetime(3)="2026-07-20 17:10:01", change(4),
  //   open(5), high(6), low(7), prev_close(26)
  const nameZh = parts[0];
  const current = parseFloat(parts[1]);
  const changePct = parseFloat(parts[2]);
  const datetime = parts[3] || '';        // "2026-07-20 17:10:01"（已是 ISO-ish）
  const prevClose = parseFloat(parts[26]);
  if (isNaN(current) || current <= 0) return null;
  // 转换日期格式：parts[3] 已是 "YYYY-MM-DD HH:MM:SS"
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
    market: 'us'
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
  return {
    fundcode: code,
    name: parts[0],
    jzrq: parts[7] || '',
    dwjz: parts[3] || '0',
    gsz: gsz.toFixed(4),
    gszzl: parts[6] || '0',
    gztime: parts[7] && parts[1] ? `${parts[7]} ${parts[1]}` : '',
    market: 'domestic'
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
async function getFundValuation(code) {
  const now = Date.now();
  const cached = cache.fund[code];
  if (cached && (now - cached.timestamp < FUND_CACHE_TTL)) {
    return cached.data;
  }

  const kind = detectCodeKind(code);
  let result = null;

  try {
    if (kind === 'fund_hk') {
      result = await fetchHKStockValuation(code);
    } else if (kind === 'fund_us') {
      result = await fetchUSStockValuation(code);
    } else {
      // A 股基金：先试 fundgz，失败回退 Sina fu_
      const url = `http://fundgz.1234567.com.cn/js/${code}.js?rt=${now}`;
      const response = await axios.get(url, {
        headers: { 'Referer': 'http://fund.eastmoney.com/' },
        timeout: 5000,
        maxRedirects: 5
      });
      const text = response.data;
      if (text && text.includes('jsonpgz')) {
        const rawData = parseJsonp(text);
        if (rawData && rawData.gsz && parseFloat(rawData.gsz) > 0) {
          result = {
            fundcode: rawData.fundcode,
            name: rawData.name,
            jzrq: rawData.jzrq,
            dwjz: rawData.dwjz,
            gsz: rawData.gsz,
            gszzl: rawData.gszzl,
            gztime: rawData.gztime
          };
        }
      }
      // fundgz 失败或数据无效 → fallback 到 Sina
      if (!result) {
        console.log(`[fund] fundgz miss for ${code}, fallback to Sina fu_`);
        result = await fetchSinaFundValuation(code);
      }
    }

    if (result) {
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
async function getFundHistory(code, days = 30) {
  if (!/^\d{6}$/.test(code)) return [];
  const now = Date.now();
  const cached = cache.fundHistory[code];
  if (cached && (now - cached.timestamp < FUND_HISTORY_TTL) && cached.days >= days) {
    return cached.data.slice(-days);
  }

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
    if (s.endsWith('116')) {
      // 港股: e.g. "00700116" → "00700.HK"
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
  const aCodes = stockList.filter(s => s.exchange === 'SH' || s.exchange === 'SZ');
  const hkCodes = stockList.filter(s => s.exchange === 'HK');

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
          const changePercent = parseFloat(parts[3]);

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

module.exports = {
  getFundValuation,
  getFundHistory,
  getFundBasicInfo,
  getFundHoldings,
  getMarketIndices,
  detectCodeKind,
  fetchHKStockValuation,
  fetchUSStockValuation,
  fetchSinaFundValuation
};
