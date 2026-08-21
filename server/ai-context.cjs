/**
 * ai-context.cjs — AI 选股实时行情数据增强与候选池模块
 *
 * 核心设计：
 * 1. 抓取实时大盘、热点领涨行业、主力资金流向及全网财经快讯；
 * 2. 根据所选市场（A股/港股/美股）构建真实股票候选池（含当前价、涨跌幅、板块与市值）；
 * 3. 严格限定 AI 只能从候选池中选拔标的，从根源杜绝模型幻觉与股票代码虚构。
 */

'use strict';

const axios = require('axios');
const marketHelper = require('./market.cjs');

const CACHE_TTL_MS = 60 * 1000; // 缓存 1 分钟，兼顾新鲜度与请求负载
const cache = {
  sectors: null,
  flows: null,
  news: null,
  candidates: {},
  lastFetch: {},
};

/**
 * 获取实时行业板块领涨排行 (Top N)
 */
async function fetchSectorHotspots(limit = 8) {
  const now = Date.now();
  if (cache.sectors && now - (cache.lastFetch.sectors || 0) < CACHE_TTL_MS) {
    return cache.sectors;
  }

  try {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get';
    const params = {
      pn: 1,
      pz: limit,
      po: 1,
      np: 1,
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: 2,
      invt: 2,
      fid: 'f3', // 按涨跌幅降序
      fs: 'm:90+t:2+f:!50',
      fields: 'f12,f14,f2,f3,f62,f104,f105',
    };
    const res = await axios.get(url, { params, timeout: 6000 });
    const diff = res.data?.data?.diff || [];
    const sectors = diff.map(item => ({
      code: item.f12,
      name: item.f14,
      changePct: Number(item.f3) || 0,
      leadStock: item.f104,
      leadStockChange: Number(item.f105) || 0,
      mainInflow: Number(item.f62) || 0,
    }));
    cache.sectors = sectors;
    cache.lastFetch.sectors = now;
    return sectors;
  } catch (err) {
    console.warn('[ai-context] 获取领涨板块失败，使用降级空数据:', err.message);
    return cache.sectors || [];
  }
}

/**
 * 获取主力资金净流入板块排行 (Top N)
 */
async function fetchMarketCapitalFlows(limit = 8) {
  const now = Date.now();
  if (cache.flows && now - (cache.lastFetch.flows || 0) < CACHE_TTL_MS) {
    return cache.flows;
  }

  try {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get';
    const params = {
      pn: 1,
      pz: limit,
      po: 1,
      np: 1,
      ut: 'bd1d9ddb04089700cf9c27f6f7426281',
      fltt: 2,
      invt: 2,
      fid: 'f62', // 按主力净流入降序
      fs: 'm:90+t:2+f:!50',
      fields: 'f12,f14,f2,f3,f62',
    };
    const res = await axios.get(url, { params, timeout: 6000 });
    const diff = res.data?.data?.diff || [];
    const flows = diff.map(item => ({
      code: item.f12,
      name: item.f14,
      changePct: Number(item.f3) || 0,
      mainInflow: Number(item.f62) || 0,
    }));
    cache.flows = flows;
    cache.lastFetch.flows = now;
    return flows;
  } catch (err) {
    console.warn('[ai-context] 获取资金流向失败:', err.message);
    return cache.flows || [];
  }
}

/**
 * 获取最新 7x24 财经要闻快讯摘要 (12~15条)
 */
async function fetchFinancialNewsSummary(limit = 12) {
  const now = Date.now();
  if (cache.news && now - (cache.lastFetch.news || 0) < CACHE_TTL_MS * 2) {
    return cache.news;
  }

  try {
    const url = 'https://np-fastlist.eastmoney.com/comm/web/getFastNewsList';
    const params = {
      client: 'web',
      biz: 'web_724',
      fastColumn: '102',
      pageSize: limit,
    };
    const res = await axios.get(url, { params, timeout: 6000 });
    const list = res.data?.data?.fastNewsList || [];
    const news = list.map(item => ({
      time: item.showTime ? item.showTime.slice(11, 16) : '',
      title: (item.title || item.digest || '').replace(/<[^>]+>/g, '').trim(),
      summary: (item.digest || '').replace(/<[^>]+>/g, '').trim().slice(0, 120),
    })).filter(item => item.title.length > 5);

    cache.news = news;
    cache.lastFetch.news = now;
    return news;
  } catch (err) {
    console.warn('[ai-context] 获取财经快讯失败:', err.message);
    return cache.news || [];
  }
}

/**
 * 抓取各市场真实股票候选池 (防幻觉核心)
 * @param {string[]} markets ['domestic', 'hk', 'us']
 * @param {number} poolSize 每个市场数量
 */
async function buildCandidatePool(markets = ['domestic'], poolSize = 25) {
  const candidates = [];
  const normalizedMarkets = Array.isArray(markets) && markets.length ? markets : ['domestic'];

  for (const m of normalizedMarkets) {
    try {
      if (m === 'domestic') {
        // A股主板/创业板/科创板 活跃与领涨
        const url = 'https://push2.eastmoney.com/api/qt/clist/get';
        const params = {
          pn: 1,
          pz: poolSize,
          po: 1,
          np: 1,
          ut: 'bd1d9ddb04089700cf9c27f6f7426281',
          fltt: 2,
          invt: 2,
          fid: 'f3',
          fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
          fields: 'f12,f14,f2,f3,f20,f62,f100',
        };
        const res = await axios.get(url, { params, timeout: 6000 });
        const diff = res.data?.data?.diff || [];
        diff.forEach(item => {
          if (item.f12 && item.f14 && item.f2 !== '-') {
            candidates.push({
              code: String(item.f12),
              name: String(item.f14),
              market: 'domestic',
              price: Number(item.f2) || 0,
              changePct: Number(item.f3) || 0,
              industry: item.f100 || 'A股综合',
              mainInflow: Number(item.f62) || 0,
            });
          }
        });
      } else if (m === 'hk') {
        // 港股活跃龙头
        const url = 'https://push2.eastmoney.com/api/qt/clist/get';
        const params = {
          pn: 1,
          pz: poolSize,
          po: 1,
          np: 1,
          ut: 'bd1d9ddb04089700cf9c27f6f7426281',
          fltt: 2,
          invt: 2,
          fid: 'f3',
          fs: 'm:128+t:3,m:128+t:4,m:128+t:1,m:128+t:2',
          fields: 'f12,f14,f2,f3,f20,f62,f100',
        };
        const res = await axios.get(url, { params, timeout: 6000 });
        const diff = res.data?.data?.diff || [];
        diff.forEach(item => {
          if (item.f12 && item.f14 && item.f2 !== '-') {
            candidates.push({
              code: String(item.f12).padStart(5, '0'),
              name: String(item.f14),
              market: 'hk',
              price: Number(item.f2) || 0,
              changePct: Number(item.f3) || 0,
              industry: item.f100 || '港股',
              mainInflow: Number(item.f62) || 0,
            });
          }
        });
      } else if (m === 'us') {
        // 美股主流科技与成长龙头
        const url = 'https://push2.eastmoney.com/api/qt/clist/get';
        const params = {
          pn: 1,
          pz: poolSize,
          po: 1,
          np: 1,
          ut: 'bd1d9ddb04089700cf9c27f6f7426281',
          fltt: 2,
          invt: 2,
          fid: 'f3',
          fs: 'm:105,m:106,m:107',
          fields: 'f12,f14,f2,f3,f20,f100',
        };
        const res = await axios.get(url, { params, timeout: 6000 });
        const diff = res.data?.data?.diff || [];
        diff.forEach(item => {
          if (item.f12 && item.f14 && item.f2 !== '-') {
            candidates.push({
              code: String(item.f12).toUpperCase(),
              name: String(item.f14),
              market: 'us',
              price: Number(item.f2) || 0,
              changePct: Number(item.f3) || 0,
              industry: item.f100 || '美股',
            });
          }
        });
      }
    } catch (err) {
      console.warn(`[ai-context] 抓取 ${m} 候选股票池失败:`, err.message);
    }
  }

  // 若部分市场抓取受限，补充权威常备龙头作为候选底池
  const fallbackDomestic = [
    { code: '600519', name: '贵州茅台', market: 'domestic', industry: '白酒/消费' },
    { code: '300750', name: '宁德时代', market: 'domestic', industry: '新能源/电池' },
    { code: '601318', name: '中国平安', market: 'domestic', industry: '非银金融' },
    { code: '002594', name: '比亚迪', market: 'domestic', industry: '新能源汽车' },
    { code: '688981', name: '中芯国际', market: 'domestic', industry: '半导体芯片' },
    { code: '000333', name: '美的集团', market: 'domestic', industry: '家用电器' },
    { code: '600036', name: '招商银行', market: 'domestic', industry: '银行' },
    { code: '300059', name: '东方财富', market: 'domestic', industry: '证券/金融科技' },
  ];
  const fallbackHk = [
    { code: '00700', name: '腾讯控股', market: 'hk', industry: '互联网/社交' },
    { code: '09988', name: '阿里巴巴-W', market: 'hk', industry: '电商/云计算' },
    { code: '03690', name: '美团-W', market: 'hk', industry: '本地生活' },
    { code: '01810', name: '小米集团-W', market: 'hk', industry: '消费电子/智驾' },
    { code: '00981', name: '中芯国际', market: 'hk', industry: '半导体' },
  ];
  const fallbackUs = [
    { code: 'NVDA', name: '英伟达', market: 'us', industry: 'AI芯片/算力' },
    { code: 'AAPL', name: '苹果', market: 'us', industry: '消费电子/生态' },
    { code: 'MSFT', name: '微软', market: 'us', industry: '云计算/大模型' },
    { code: 'TSLA', name: '特斯拉', market: 'us', industry: '智能电动车/Robotaxi' },
    { code: 'GOOGL', name: '谷歌-A', market: 'us', industry: 'AI搜索/广告' },
    { code: 'AMZN', name: '亚马逊', market: 'us', industry: '电商/AWS' },
    { code: 'META', name: 'Meta', market: 'us', industry: '社交/开源AI' },
  ];

  if (normalizedMarkets.includes('domestic')) {
    fallbackDomestic.forEach(fb => {
      if (!candidates.some(c => c.code === fb.code)) candidates.push({ ...fb, price: 0, changePct: 0 });
    });
  }
  if (normalizedMarkets.includes('hk')) {
    fallbackHk.forEach(fb => {
      if (!candidates.some(c => c.code === fb.code)) candidates.push({ ...fb, price: 0, changePct: 0 });
    });
  }
  if (normalizedMarkets.includes('us')) {
    fallbackUs.forEach(fb => {
      if (!candidates.some(c => c.code === fb.code)) candidates.push({ ...fb, price: 0, changePct: 0 });
    });
  }

  return candidates;
}

/**
 * 聚合完整上下文快照 (用于 Prompt 注入与历史审计)
 */
async function buildFullContextSnapshot(markets = ['domestic'], count = 5) {
  const [indices, sectors, flows, news, candidates] = await Promise.all([
    marketHelper.getMarketIndices().catch(() => ({})),
    fetchSectorHotspots(8),
    fetchMarketCapitalFlows(8),
    fetchFinancialNewsSummary(12),
    buildCandidatePool(markets, Math.max(20, count * 5)),
  ]);

  return {
    timestamp: new Date().toISOString(),
    indices,
    sectors,
    flows,
    news,
    candidates,
  };
}

module.exports = {
  fetchSectorHotspots,
  fetchMarketCapitalFlows,
  fetchFinancialNewsSummary,
  buildCandidatePool,
  buildFullContextSnapshot,
};
