/**
 * sectors.cjs — 行业板块元数据
 *
 * 把基金名/股票 ticker 映射到行业板块。规则：
 *   1. 基金名关键词匹配（混合基金按名字归类）
 *   2. ticker 精确匹配（美股/港股按代码归类）
 *
 * 板块分类（10 个）：
 *   科技 / 金融 / 医疗 / 消费 / 能源 / 工业 / 通信 / 房地产 / 公共事业 / 其他
 */

const SECTORS = ['科技', '金融', '医疗', '消费', '能源', '工业', '通信', '房地产', '公共事业', '其他'];
const SECTOR_COLORS = {
  '科技':     '#0066cc',
  '金融':     '#30d158',
  '医疗':     '#ff453a',
  '消费':     '#ff9f0a',
  '能源':     '#5e5ce6',
  '工业':     '#8e8e93',
  '通信':     '#64d2ff',
  '房地产':   '#ff6482',
  '公共事业': '#bf5af2',
  '其他':     '#86868b',
};

/* 基金名 → 板块（关键词匹配，长的在前避免误匹配） */
const FUND_KEYWORDS = [
  // 科技
  { pattern: /全球移动互联|互联网|科技|信息|电子|半导体|芯片|云计算|软件|数字|AI|人工智能|纳斯达克|纳指/i, sector: '科技' },
  { pattern: /5G|通信|电信/i, sector: '通信' },
  // 金融
  { pattern: /金融|银行|保险|证券|地产.*金融|非银/i, sector: '金融' },
  { pattern: /地产|房地产|物业/i, sector: '房地产' },
  // 医疗
  { pattern: /医药|医疗|健康|生物|制药|医疗器械|创新药|CXO/i, sector: '医疗' },
  // 消费
  { pattern: /消费|食品|饮料|白酒|家电|零售|餐饮|旅游|文娱|传媒|游戏/i, sector: '消费' },
  // 能源
  { pattern: /能源|石油|石化|煤炭|天然气|新能源|光伏|锂电|电池/i, sector: '能源' },
  // 工业
  { pattern: /工业|制造|汽车|机械|钢铁|化工|建材|基建|军工|装备/i, sector: '工业' },
  // 公共事业
  { pattern: /公用|电力|水务|燃气|环保|基建|高速公路|港口|机场/i, sector: '公共事业' },
  // 默认 → 其他
];

/* 美股/港股 ticker → 板块（手动维护，覆盖常见热门股票） */
const STOCK_SECTORS = {
  // === 科技 ===
  AAPL: '科技', MSFT: '科技', GOOGL: '科技', GOOG: '科技', META: '科技', AMZN: '科技',
  NVDA: '科技', AMD: '科技', INTC: '科技', ORCL: '科技', CRM: '科技', ADBE: '科技',
  CSCO: '科技', IBM: '科技', QCOM: '科技', AVGO: '科技', TXN: '科技', MU: '科技',
  NOW: '科技', UBER: '科技', ABNB: '科技', SHOP: '科技', SQ: '科技', PYPL: '科技',
  NFLX: '通信', DIS: '通信', CMCSA: '通信', T: '通信', VZ: '通信',
  TSM: '科技', ASML: '科技', BABA: '科技', JD: '消费', PDD: '消费', BIDU: '科技',
  // === 金融 ===
  JPM: '金融', BAC: '金融', WFC: '金融', C: '金融', GS: '金融', MS: '金融',
  BLK: '金融', AXP: '金融', V: '金融', MA: '金融', BRK_B: '金融',
  // === 医疗 ===
  UNH: '医疗', JNJ: '医疗', PFE: '医疗', ABBV: '医疗', LLY: '医疗', MRK: '医疗',
  TMO: '医疗', ABT: '医疗', DHR: '医疗', MDT: '医疗', BMY: '医疗',
  // === 消费 ===
  KO: '消费', PEP: '消费', WMT: '消费', COST: '消费', MCD: '消费', SBUX: '消费',
  NKE: '消费', TGT: '消费', HD: '消费', LOW: '消费', PG: '消费', CL: '消费',
  // === 能源 ===
  XOM: '能源', CVX: '能源', COP: '能源', SLB: '能源', EOG: '能源', OXY: '能源',
  // === 工业 ===
  BA: '工业', CAT: '工业', GE: '工业', MMM: '工业', HON: '工业', UNP: '工业', DE: '工业',
  // === 通信 ===
  T: '通信', VZ: '通信', TMUS: '通信', CMCSA: '通信',
  // === 房地产 ===
  AMT: '房地产', PLD: '房地产', AMH: '房地产', SPG: '房地产',
  // === 公共事业 ===
  NEE: '公共事业', DUK: '公共事业', SO: '公共事业', AEP: '公共事业', EXC: '公共事业',
  // === 港股（5 位代码）===
  '00700': '科技',   // 腾讯
  '09988': '科技',   // 阿里
  '03690': '科技',   // 美团
  '01024': '科技',   // 快手
  '09618': '科技',   // 京东
  '01810': '科技',   // 小米
  '02318': '金融',   // 平安
  '00939': '金融',   // 建设银行
  '01398': '金融',   // 工商银行
  '00388': '金融',   // 香港交易所
  '02628': '金融',   // 中国人寿
  '00883': '能源',   // 中海油
  '00386': '能源',   // 中石化
  '00857': '能源',   // 中石油
  '00005': '金融',   // 汇丰
  '00762': '通信',   // 中国联通
  '00001': '通信',   // 长和
  '01088': '能源',   // 中国神华
  '00945': '通信',   // 宏利金融
  '01211': '工业',   // 比亚迪股份
  '00981': '科技',   // 中芯国际
  '02015': '科技',   // 理想汽车
  '09888': '科技',   // 百度
  '09999': '科技',   // 网易
};

/* 推断基金板块（按关键词） */
function inferFundSector(fundName) {
  if (!fundName) return '其他';
  for (const { pattern, sector } of FUND_KEYWORDS) {
    if (pattern.test(fundName)) return sector;
  }
  return '其他';
}

/* 推断股票板块（按 ticker） */
function inferStockSector(ticker) {
  if (!ticker) return '其他';
  const t = ticker.toUpperCase();
  return STOCK_SECTORS[t] || '其他';
}

/* 按基金/股票混合列表，返回板块分布 + 每只的归类 */
function classifyHoldings(items) {
  // items: [{ code, name, market, value, ... }]
  return items.map(item => {
    const isStock = item.market === 'us' || item.market === 'hk';
    const sector = isStock
      ? inferStockSector(item.code)
      : inferFundSector(item.name || '');
    return { ...item, sector };
  });
}

/* 聚合：按板块分组，统计市值/占比/涨跌 */
function aggregateBySector(classifiedItems) {
  const groups = new Map();
  for (const item of classifiedItems) {
    const cur = groups.get(item.sector) || {
      sector: item.sector,
      items: [],
      totalValue: 0,
      totalCost: 0,
      totalTodayProfit: 0,
    };
    cur.items.push(item);
    if (typeof item.value === 'number') cur.totalValue += item.value;
    if (typeof item.cost === 'number') cur.totalCost += item.cost;
    if (typeof item.todayProfit === 'number') cur.totalTodayProfit += item.todayProfit;
    groups.set(item.sector, cur);
  }
  const totalValue = [...groups.values()].reduce((s, g) => s + g.totalValue, 0);
  return [...groups.values()]
    .map(g => ({
      ...g,
      weight: totalValue > 0 ? (g.totalValue / totalValue) * 100 : 0,
      totalProfit: g.totalValue - g.totalCost,
    }))
    .sort((a, b) => b.totalValue - a.totalValue);
}

module.exports = {
  SECTORS,
  SECTOR_COLORS,
  inferFundSector,
  inferStockSector,
  classifyHoldings,
  aggregateBySector,
  STOCK_SECTORS,
};
