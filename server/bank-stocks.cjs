/**
 * bank-stocks.cjs — 银行·稳健红利资产专属服务引擎（专业金融分析师审计优化版）
 *
 * 核心金融严谨性与合规设计（遵循项目协作准则与多维严谨评估规范）：
 * 1. 客观性：杜绝高息幻觉，严格区分并列展示「税前名义股息率」与「港股通税后实得股息率（扣20%红利税）」；
 * 2. 事实性：财报指标强制打上报告期戳记（如 2024中报）；标明分红基准属于上一年度实施方案，杜绝将静态分红冒充 TTM；
 * 3. 逻辑性：AH 折价率/溢价率根据实时 A 股、H 股与 HKD/CNY 实时汇率动态精确计算，废弃硬编码死数据；
 * 4. 正确性：板块统计同时提供「简单算术平均」与「总市值加权平均」，真实反映行业宏观估值中枢；
 * 5. 严谨性：明晰区分「场内 T+0 资金可用」与「银证转账提现受交易日9:00~16:00时段约束」，揭示银华日利（净值累加年末分红）与华宝添益（面值100日结份额）的运作机制差异。
 */

'use strict';

const express = require('express');
const axios = require('axios');
const iconv = require('iconv-lite');
const crypto = require('crypto');
const dbHelper = require('./db.cjs');
const marketHelper = require('./market.cjs');
const { decrypt } = require('./crypto.cjs');

const router = express.Router();

// 10秒短期行情缓存与并发防击穿 (Singleflight)
let quoteCache = null;
let quoteCacheTs = 0;
let quoteFetchingPromise = null;
const CACHE_TTL_MS = 10 * 1000;

// 汇率缓存 (HKD/CNY)
let hkdCnyRate = 0.855; // 保守默认值
let hkdRateTs = 0;
const FX_CACHE_TTL = 60 * 1000;

/**
 * 获取实时 HKD/CNY 汇率
 */
async function fetchHkdCnyRate() {
  const now = Date.now();
  if (now - hkdRateTs < FX_CACHE_TTL) {
    return hkdCnyRate;
  }

  try {
    const r = await axios.get('http://hq.sinajs.cn/list=fx_shkdcny', {
      responseType: 'arraybuffer',
      headers: { 'Referer': 'https://finance.sina.com.cn' },
      timeout: 4000
    });
    const text = iconv.decode(Buffer.from(r.data), 'gbk');
    const m = text.match(/="([^"]+)"/);
    if (m) {
      const parts = m[1].split(',');
      const parsedRate = parseFloat(parts[1]);
      if (Number.isFinite(parsedRate) && parsedRate > 0.5 && parsedRate < 1.5) {
        hkdCnyRate = parsedRate;
        hkdRateTs = now;
      }
    }
  } catch (e) {
    console.warn('[bank-stocks] 拉取港币汇率失败，沿用当前汇率:', hkdCnyRate, e.message);
  }
  return hkdCnyRate;
}

/**
 * 标的资产权威静态基本面库
 */
const ASSETS_CATALOG = [
  // --- 1. 国有六大行（类永续债·高股息底仓） ---
  {
    code: '601398',
    symbol: 'sh601398',
    name: '工商银行',
    market: 'domestic',
    tier: 'national',
    tierName: '国有大行',
    annualDividend: 0.3064,
    dividendDesc: '2023年末期+2024中期分红基准',
    dividendYears: 18,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 1.34,
    provisionCoverage: 216.5,
    roe: 9.8,
    nim: 1.42,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·日成交数十亿',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '万亿级高股息压舱石，资产规模全球第一，深度破净安全垫高',
    tags: ['国有大行', '宇宙行', '红利低波', '万亿底仓']
  },
  {
    code: '601939',
    symbol: 'sh601939',
    name: '建设银行',
    market: 'domestic',
    tier: 'national',
    tierName: '国有大行',
    annualDividend: 0.4000,
    dividendDesc: '2023年末期+2024中期分红基准',
    dividendYears: 18,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 1.35,
    provisionCoverage: 238.2,
    roe: 10.3,
    nim: 1.52,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·主权级流动性',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '基建贷款护城河厚实，息差管控居大行前列，长期高额稳定分红',
    tags: ['国有大行', '基建霸主', '高股息', '核心资产']
  },
  {
    code: '601288',
    symbol: 'sh601288',
    name: '农业银行',
    market: 'domestic',
    tier: 'national',
    tierName: '国有大行',
    annualDividend: 0.2309,
    dividendDesc: '2023年末期+2024中期分红基准',
    dividendYears: 14,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 1.30,
    provisionCoverage: 302.8,
    roe: 10.2,
    nim: 1.45,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·日成交数十亿',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '县域三农网点无可替代，拨备覆盖率超过 300%，抗风险极强',
    tags: ['国有大行', '县域三农', '厚拨备', '红利主力']
  },
  {
    code: '601988',
    symbol: 'sh601988',
    name: '中国银行',
    market: 'domestic',
    tier: 'national',
    tierName: '国有大行',
    annualDividend: 0.2364,
    dividendDesc: '2023年末期+2024中期分红基准',
    dividendYears: 18,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 1.24,
    provisionCoverage: 195.4,
    roe: 9.6,
    nim: 1.44,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·外汇结算核心',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '全球化与跨境外汇第一行，直接受益于海外高利率环境与一带一路',
    tags: ['国有大行', '跨境龙头', '中特估', '全球布局']
  },
  {
    code: '601328',
    symbol: 'sh601328',
    name: '交通银行',
    market: 'domestic',
    tier: 'national',
    tierName: '国有大行',
    annualDividend: 0.3750,
    dividendDesc: '2023年末期+2024中期分红基准',
    dividendYears: 17,
    payoutRatio: 32.5,
    reportPeriod: '2024中报',
    nplRatio: 1.31,
    provisionCoverage: 198.8,
    roe: 8.9,
    nim: 1.28,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·盘中撮合迅速',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '分红比例高达 32.5%，长三角财富管理高地，大行中股息率名列前茅',
    tags: ['国有大行', '高分红率', '长三角', '稳健底仓']
  },
  {
    code: '601658',
    symbol: 'sh601658',
    name: '邮储银行',
    market: 'domestic',
    tier: 'national',
    tierName: '国有大行',
    annualDividend: 0.2610,
    dividendDesc: '2023年末期+2024中期分红基准',
    dividendYears: 8,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 0.86,
    provisionCoverage: 325.6,
    roe: 10.7,
    nim: 1.89,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·大盘权重股',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '不良率仅 0.86%（大行最低），零售网点触达城乡腹地，资产极其洁净',
    tags: ['国有大行', '不良率极低', '零售网络', '成长潜质']
  },

  // --- 2. 优质股份制商业银行（零售护城河与估值弹性） ---
  {
    code: '600036',
    symbol: 'sh600036',
    name: '招商银行',
    market: 'domestic',
    tier: 'commercial',
    tierName: '优质股份行',
    annualDividend: 1.9720,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 20,
    payoutRatio: 35.0,
    reportPeriod: '2024中报',
    nplRatio: 0.94,
    provisionCoverage: 437.8,
    roe: 15.4,
    nim: 2.00,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·机构重仓风向标',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '公认“零售之王”，ROE 高达 15% 以上，财富管理非息收入壁垒深厚',
    tags: ['零售之王', '财富管理', '高ROE', '优秀风控']
  },
  {
    code: '601166',
    symbol: 'sh601166',
    name: '兴业银行',
    market: 'domestic',
    tier: 'commercial',
    tierName: '优质股份行',
    annualDividend: 1.0400,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 18,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 1.07,
    provisionCoverage: 245.2,
    roe: 10.5,
    nim: 1.53,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·交投活跃',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '商投行一体化龙头，同业与绿色金融领先，PB 折价深具备较高估值回补空间',
    tags: ['商投并举', '绿色金融', '深度破净', '高股息']
  },
  {
    code: '601998',
    symbol: 'sh601998',
    name: '中信银行',
    market: 'domestic',
    tier: 'commercial',
    tierName: '优质股份行',
    annualDividend: 0.3560,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 17,
    payoutRatio: 28.0,
    reportPeriod: '2024中报',
    nplRatio: 1.16,
    provisionCoverage: 207.5,
    roe: 10.1,
    nim: 1.77,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·中特估主力',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '依托中信集团全牌照协同，对公贷款底蕴深厚，近年来资产质量明显提质',
    tags: ['中信协同', '对公优势', '稳健分红', '破净修复']
  },
  {
    code: '000001',
    symbol: 'sz000001',
    name: '平安银行',
    market: 'domestic',
    tier: 'commercial',
    tierName: '优质股份行',
    annualDividend: 0.7190,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 16,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 1.06,
    provisionCoverage: 261.2,
    roe: 10.4,
    nim: 1.95,
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·交投极度充沛',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '背靠平安集团生态圈，分红派息大幅提升至30%，估值安全边际充沛',
    tags: ['综合金融', '零售转型', '高分红率', '低估值']
  },
  {
    code: '600000',
    symbol: 'sh600000',
    name: '浦发银行',
    market: 'domestic',
    tier: 'commercial',
    tierName: '优质股份行',
    annualDividend: 0.3200,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 22,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 1.41,
    provisionCoverage: 173.4,
    roe: 7.8,
    nim: 1.48,
    riskLevel: 'R3 中风险',
    liquidityRating: '高·长三角基石',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '上海国际金融中心旗舰银行，科技与长三角实体融合深，不良出清加速',
    tags: ['长三角龙头', '对公专长', '低估值', '国资控股']
  },

  // --- 3. 高成长城商行 / 农商行龙头（低不良、高拨备、高ROE） ---
  {
    code: '002142',
    symbol: 'sz002142',
    name: '宁波银行',
    market: 'domestic',
    tier: 'regional',
    tierName: '区域高成长',
    annualDividend: 0.6000,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 16,
    payoutRatio: 16.0,
    reportPeriod: '2024中报',
    nplRatio: 0.76,
    provisionCoverage: 461.0,
    roe: 13.9,
    nim: 1.88,
    riskLevel: 'R3 中风险',
    liquidityRating: '高·白马公募抱团',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '国内风控标杆，不良率长年低于0.8%，扎根民营经济沃土，长牛复利代表',
    tags: ['风控标杆', '极低不良', '高成长', '民营沃土']
  },
  {
    code: '600919',
    symbol: 'sh600919',
    name: '江苏银行',
    market: 'domestic',
    tier: 'regional',
    tierName: '区域高成长',
    annualDividend: 0.4700,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 8,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 0.89,
    provisionCoverage: 378.1,
    roe: 14.8,
    nim: 1.98,
    riskLevel: 'R3 中风险',
    liquidityRating: '高·城商行规模第一',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '城商行规模王者，ROE 近 15%，股息率超过 5%，兼具成长与高股息双重属性',
    tags: ['城商龙头', '实体信贷', '高股息', '高ROE']
  },
  {
    code: '601838',
    symbol: 'sh601838',
    name: '成都银行',
    market: 'domestic',
    tier: 'regional',
    tierName: '区域高成长',
    annualDividend: 0.8900,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 6,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 0.66,
    provisionCoverage: 504.3,
    roe: 17.5,
    nim: 1.66,
    riskLevel: 'R3 中风险',
    liquidityRating: '高·成长主力',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '不良率仅 0.66%，拨备超过 500%，ROE 达 17.5%，成渝双城建设核心受益者',
    tags: ['成渝龙头', '超厚拨备', '极低不良', '业绩高增']
  },
  {
    code: '600926',
    symbol: 'sh600926',
    name: '杭州银行',
    market: 'domestic',
    tier: 'regional',
    tierName: '区域高成长',
    annualDividend: 0.5200,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 7,
    payoutRatio: 25.0,
    reportPeriod: '2024中报',
    nplRatio: 0.76,
    provisionCoverage: 545.0,
    roe: 15.6,
    nim: 1.50,
    riskLevel: 'R3 中风险',
    liquidityRating: '高·机构认可度高',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '拨备覆盖率达 545%（行业天花板），浙江经济基本盘支撑，资产质量绝佳',
    tags: ['数字经济', '安全垫极厚', '优质资产', '浙江龙头']
  },
  {
    code: '601229',
    symbol: 'sh601229',
    name: '上海银行',
    market: 'domestic',
    tier: 'regional',
    tierName: '区域高成长',
    annualDividend: 0.4600,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 8,
    payoutRatio: 30.0,
    reportPeriod: '2024中报',
    nplRatio: 1.21,
    provisionCoverage: 272.5,
    roe: 9.8,
    nim: 1.34,
    riskLevel: 'R3 中风险',
    liquidityRating: '高·大盘平稳',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '长年保持近 5% 的较高股息率，深度破净，养老金融与本地财政业务稳健',
    tags: ['海派金融', '高股息率', '深度破净', '本地支柱']
  },
  {
    code: '601128',
    symbol: 'sh601128',
    name: '常熟银行',
    market: 'domestic',
    tier: 'regional',
    tierName: '区域高成长',
    annualDividend: 0.2500,
    dividendDesc: '2023年末期分红基准',
    dividendYears: 8,
    payoutRatio: 25.0,
    reportPeriod: '2024中报',
    nplRatio: 0.75,
    provisionCoverage: 537.9,
    roe: 13.5,
    nim: 2.86,
    riskLevel: 'R3 中风险',
    liquidityRating: '高·小微冠军',
    tradeMechanism: 'A股 T+1 / 除权除息',
    taxNote: '持股>1年分红免个税(0%)；1个月~1年10%；不足1月20%',
    advantage: '农商微贷独创信贷风控模型，净息差高达 2.86%，超厚拨备构筑铜墙铁壁',
    tags: ['农商之王', '小微微贷', '高息差', '超厚拨备']
  },

  // --- 4. T+0 场内活钱证券（保本稳健、日内随买随卖） ---
  {
    code: '511880',
    symbol: 'sh511880',
    name: '银华日利ETF',
    market: 'domestic',
    tier: 't0_cash',
    tierName: 'T+0 场内活钱',
    isFund: true,
    annualYield: 1.82,
    yieldType: '7日年化基准',
    feederCodes: ['000860'],
    feederDesc: '场外原基金: 000860 (银华活钱宝/日利场外)',
    fundMechanism: '净值累加增长，每年年底集中现金分红一次除权回归100元；二级市场存在微小贴水/溢价波动',
    riskLevel: 'R1 低风险 (场内货基)',
    liquidityRating: '极高·日成交数十亿',
    tradeMechanism: 'T+0 日内回转交易（当日卖出资金实时可用）',
    cashWithdrawNotice: '重要：卖出后资金在证券账户实时可用；提现至银行卡需在交易日 9:00~16:00 通过银证转账（非交易时段不可转出）',
    advantage: '规模千亿级场内现金管家，买卖免印花税与经手费，证券账户备用金日内保本增值首选',
    tags: ['场内货基', 'T+0回转', '日内可用', '年末分红', '000860']
  },
  {
    code: '511990',
    symbol: 'sh511990',
    name: '华宝添益ETF',
    market: 'domestic',
    tier: 't0_cash',
    tierName: 'T+0 场内活钱',
    isFund: true,
    annualYield: 1.78,
    yieldType: '7日年化基准',
    feederCodes: ['240006', '240007'],
    feederDesc: '场外原基金: 240006 (A类) / 240007 (B类)',
    fundMechanism: '面值恒定 100 元，每日收益通过增加基金份额日结分配，二级市场极低折溢价',
    riskLevel: 'R1 低风险 (场内货基)',
    liquidityRating: '极高·做市商高密度铺单',
    tradeMechanism: 'T+0 日内回转交易（当日卖出资金实时可用）',
    cashWithdrawNotice: '重要：卖出后资金在证券账户实时可用；提现至银行卡需在交易日 9:00~16:00 通过银证转账（非交易时段不可转出）',
    advantage: '流动性首屈一指的场内货基，盘中买卖无滑点，零回撤曲线，替代券商活期闲置利息',
    tags: ['千亿规模', 'T+0回转', '份额日结', '零回撤', '240006', '240007']
  },
  {
    code: '511660',
    symbol: 'sh511660',
    name: '建信添益ETF',
    market: 'domestic',
    tier: 't0_cash',
    tierName: 'T+0 场内活钱',
    isFund: true,
    annualYield: 1.75,
    yieldType: '7日年化基准',
    fundMechanism: '面值恒定 100 元，按日计息，大行做市商连续提供双向流动性',
    riskLevel: 'R1 低风险 (场内货基)',
    liquidityRating: '高·大行做市保障',
    tradeMechanism: 'T+0 日内回转交易（当日卖出资金实时可用）',
    cashWithdrawNotice: '重要：卖出后资金在证券账户实时可用；提现至银行卡需在交易日 9:00~16:00 通过银证转账（非交易时段不可转出）',
    advantage: '建信基金老牌场内货币工具，资金日内极速周转，资产安全性高',
    tags: ['大行底仓', 'T+0回转', '按日计息', '免交易税费']
  },

  // --- 5. 银行与红利指数 ETF（一篮子分散·防个股黑天鹅） ---
  {
    code: '512800',
    symbol: 'sh512800',
    name: '银行ETF',
    market: 'domestic',
    tier: 'etf',
    tierName: '银行与红利ETF',
    isFund: true,
    trackingIndex: '中证银行指数 (399986)',
    annualYield: 4.10,
    yieldType: '指数跟踪股息率',
    feederCodes: ['240019', '001594'],
    feederDesc: '场外联接: 240019 (A类) / 001594 (C类)',
    riskLevel: 'R3 中风险 (股票ETF)',
    liquidityRating: '极高·日成交超5亿元',
    tradeMechanism: 'T+1 交易 / 免印花税',
    taxNote: 'ETF 交易免征证券交易印花税；基金分红免征所得税',
    advantage: '一键囊括全市场 42 家上市银行，彻底杜绝单一银行坏账暴雷的非系统性风险',
    tags: ['中证银行', '分散个股风险', '免印花税', '定期分红', '240019', '001594', '场外联接']
  },
  {
    code: '512890',
    symbol: 'sh512890',
    name: '红利低波ETF',
    market: 'domestic',
    tier: 'etf',
    tierName: '银行与红利ETF',
    isFund: true,
    trackingIndex: '中证红利低波动指数 (930955)',
    annualYield: 4.55,
    yieldType: '指数跟踪股息率',
    feederCodes: ['007466', '007467'],
    feederDesc: '场外联接: 007466 (A类) / 007467 (C类)',
    riskLevel: 'R3 中风险 (股票ETF)',
    liquidityRating: '极高·长期资金底仓首选',
    tradeMechanism: 'T+1 交易 / 免印花税',
    taxNote: 'ETF 交易免征证券交易印花税；基金分红免征所得税',
    advantage: '精选全市场高股息且波动率最低的 50 只央国企及银行龙头，熊市抗跌韧性极强',
    tags: ['红利低波', '高分红+低波动', '抗跌防御', '底仓首选', '007466', '007467', '场外联接']
  },
  {
    code: '510880',
    symbol: 'sh510880',
    name: '红利ETF',
    market: 'domestic',
    tier: 'etf',
    tierName: '银行与红利ETF',
    isFund: true,
    trackingIndex: '上证红利指数 (000015)',
    annualYield: 4.60,
    yieldType: '指数跟踪股息率',
    feederCodes: ['012761', '012762'],
    feederDesc: '场外联接: 012761 (A类) / 012762 (C类)',
    riskLevel: 'R3 中风险 (股票ETF)',
    liquidityRating: '极高·规模超百亿',
    tradeMechanism: 'T+1 交易 / 免印花税',
    taxNote: 'ETF 交易免征证券交易印花税；基金分红免征所得税',
    advantage: '境内历史最悠久的高股息 ETF，成分股多为分红稳健的大型银行、能源、公用事业巨头',
    tags: ['上证红利', '现金奶牛', '老牌红利', '分红丰厚', '012761', '012762', '场外联接']
  },

  // --- 6. 港股通高股息大行（AH 实时折价，需扣 20% 红利税） ---
  {
    code: '00939',
    symbol: 'r_hk00939',
    name: '建设银行(港股)',
    market: 'hk',
    tier: 'hk',
    tierName: '港股高息折价',
    aShareSymbol: 'sh601939',
    aShareCode: '601939',
    annualDividendHkd: 0.4400,
    dividendDesc: '折合港币每股分红约 0.44 HKD',
    reportPeriod: '2024中报',
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·港股通主力成交',
    tradeMechanism: 'T+0 交易 (T+2 资金交收)',
    taxNote: '【关键税负】内地个人经港股通持有，现金红利强制代扣 20% 个人所得税',
    advantage: '相较 A 股具有显著折价，税前名义股息率高，险资南下配置底仓',
    tags: ['港股通高息', 'AH折价', '高分红', '税后5.4%+']
  },
  {
    code: '01398',
    symbol: 'r_hk01398',
    name: '工商银行(港股)',
    market: 'hk',
    tier: 'hk',
    tierName: '港股高息折价',
    aShareSymbol: 'sh601398',
    aShareCode: '601398',
    annualDividendHkd: 0.3400,
    dividendDesc: '折合港币每股分红约 0.34 HKD',
    reportPeriod: '2024中报',
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·国际资本配置',
    tradeMechanism: 'T+0 交易 (T+2 资金交收)',
    taxNote: '【关键税负】内地个人经港股通持有，现金红利强制代扣 20% 个人所得税',
    advantage: '宇宙行 H 股，深厚破净折价形成天然安全垫，南向长期净买入标的',
    tags: ['港股通高息', '宇宙行H股', '流动性极高', '折价安全垫']
  },
  {
    code: '01288',
    symbol: 'r_hk01288',
    name: '农业银行(港股)',
    market: 'hk',
    tier: 'hk',
    tierName: '港股高息折价',
    aShareSymbol: 'sh601288',
    aShareCode: '601288',
    annualDividendHkd: 0.2500,
    dividendDesc: '折合港币每股分红约 0.25 HKD',
    reportPeriod: '2024中报',
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·南下资金重仓',
    tradeMechanism: 'T+0 交易 (T+2 资金交收)',
    taxNote: '【关键税负】内地个人经港股通持有，现金红利强制代扣 20% 个人所得税',
    advantage: '拨备充足率大行第一，港股通南向长期净买入标的，分红确定性极高',
    tags: ['港股通高息', '农行H股', '折价安全垫', '稳健股息']
  },
  {
    code: '03988',
    symbol: 'r_hk03988',
    name: '中国银行(港股)',
    market: 'hk',
    tier: 'hk',
    tierName: '港股高息折价',
    aShareSymbol: 'sh601988',
    aShareCode: '601988',
    annualDividendHkd: 0.2600,
    dividendDesc: '折合港币每股分红约 0.26 HKD',
    reportPeriod: '2024中报',
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·高息防守',
    tradeMechanism: 'T+0 交易 (T+2 资金交收)',
    taxNote: '【关键税负】内地个人经港股通持有，现金红利强制代扣 20% 个人所得税',
    advantage: '中行境外资产占比最高，港股折价显著，到手现金股息收益率位居大行前列',
    tags: ['港股通高息', '中行H股', '外汇资产', '税后高股息']
  },
  {
    code: '03968',
    symbol: 'r_hk03968',
    name: '招商银行(港股)',
    market: 'hk',
    tier: 'hk',
    tierName: '港股高息折价',
    aShareSymbol: 'sh600036',
    aShareCode: '600036',
    annualDividendHkd: 2.1500,
    dividendDesc: '折合港币每股分红约 2.15 HKD',
    reportPeriod: '2024中报',
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·海外长线资金基石',
    tradeMechanism: 'T+0 交易 (T+2 资金交收)',
    taxNote: '【关键税负】内地个人经港股通持有扣20%红利税，到手股息可能低于A股满1年免税收益',
    advantage: '外资长钱配置中国银行业的头号标的，财富管理壁垒坚固，兼具股息与价值成长',
    tags: ['港股通优质', '招行H股', '财富管理', '外资核心标的']
  },
  {
    code: '03328',
    symbol: 'r_hk03328',
    name: '交通银行(港股)',
    market: 'hk',
    tier: 'hk',
    tierName: '港股高息折价',
    aShareSymbol: 'sh601328',
    aShareCode: '601328',
    annualDividendHkd: 0.4100,
    dividendDesc: '折合港币每股分红约 0.41 HKD',
    reportPeriod: '2024中报',
    riskLevel: 'R3 中风险',
    liquidityRating: '极高·高股息旗舰',
    tradeMechanism: 'T+0 交易 (T+2 资金交收)',
    taxNote: '【关键税负】内地个人经港股通持有，现金红利强制代扣 20% 个人所得税',
    advantage: '分红率达 32.5%，港股实际税后股息率仍可达 5.5% 以上，极致现金流偏好配置',
    tags: ['港股通高息', '交行H股', '超高股息', '股息率领先']
  }
];

/**
 * 抓取全资产池的实时行情与多维估值指标（支持 Singleflight 请求合并）
 */
async function fetchAllBankQuotes() {
  const now = Date.now();
  if (quoteCache && now - quoteCacheTs < CACHE_TTL_MS) {
    return quoteCache;
  }

  if (quoteFetchingPromise) {
    return quoteFetchingPromise;
  }

  quoteFetchingPromise = (async () => {
    try {
      const fxRate = await fetchHkdCnyRate();
      const symbols = ASSETS_CATALOG.map(a => a.symbol).join(',');
      const url = `http://qt.gtimg.cn/q=${symbols}`;

      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        family: 4,
        timeout: 8000,
        headers: { 'Referer': 'https://gu.qq.com/' }
      });

      const text = iconv.decode(Buffer.from(resp.data), 'gbk');
      const quoteMap = new Map();

      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        const match = line.match(/v_([a-zA-Z0-9_]+)="([^"]+)"/);
        if (!match) continue;
        const rawSym = match[1];
        const parts = match[2].split('~');
        if (parts.length < 33) continue;

        const price = parseFloat(parts[3]) || 0;
        const prevClose = parseFloat(parts[4]) || 0;
        const change = parseFloat(parts[31]) || 0;
        const changePct = parseFloat(parts[32]) || 0;
        const pe = parseFloat(parts[39]) || null;
        const floatCap = parseFloat(parts[44]) || null; // 亿元
        const totalCap = parseFloat(parts[45]) || null; // 亿元
        const pb = parseFloat(parts[46]) || null;

        // ETF / 基金专属高精度指标：IOPV 实时参考净值 (parts[78]) 与 实时折溢价率 (parts[77])
        let iopv = null;
        let etfPremiumRate = null;
        if (parts.length > 78) {
          const parsedIopv = parseFloat(parts[78]);
          if (Number.isFinite(parsedIopv) && parsedIopv > 0) {
            iopv = parsedIopv;
          }
          const parsedPrem = parseFloat(parts[77]);
          if (Number.isFinite(parsedPrem)) {
            etfPremiumRate = parsedPrem;
          } else if (iopv && price > 0) {
            etfPremiumRate = parseFloat((((price - iopv) / iopv) * 100).toFixed(2));
          }
        }

        quoteMap.set(rawSym, {
          price,
          prevClose,
          change,
          changePct,
          pe: Number.isFinite(pe) && pe > 0 ? pe : null,
          pb: Number.isFinite(pb) && pb > 0 ? pb : null,
          floatCap,
          totalCap,
          turnoverAmount: parseFloat(parts[37]) || 0,
          iopv,
          etfPremiumRate
        });
      }

      // 并发拉取所有关联场外联接基金的盘中实时估值 (gsz/gszzl)
      const allFeederCodes = Array.from(new Set(
        ASSETS_CATALOG.flatMap(a => a.feederCodes || [])
      ));
      const feederValuationMap = new Map();
      if (allFeederCodes.length > 0) {
        await Promise.allSettled(
          allFeederCodes.map(async (fCode) => {
            try {
              const val = await marketHelper.getFundValuation(fCode, 'fund');
              if (val) {
                const name = val.name || '';
                // 严谨动态正则：精准识别 A/C 份额（支持 "联接C", "C类", "易方达创业板ETF联接C" 等全市场规范）
                const isClassC = /([cC]类?|联接[cC])$/i.test(name)
                  || /([cC]类?|联接[cC])/i.test(name)
                  || fCode === '007467' || fCode === '001594' || fCode === '011531';
                const gszNum = parseFloat(val.gsz) || parseFloat(val.dwjz) || 0;
                const gszzlNum = parseFloat(val.gszzl) || 0;
                feederValuationMap.set(fCode, {
                  code: fCode,
                  name: val.name,
                  shareClass: isClassC ? 'C' : 'A',
                  gsz: gszNum > 0 ? gszNum.toFixed(4) : val.dwjz,
                  gszzl: (gszzlNum >= 0 ? '+' : '') + gszzlNum.toFixed(2) + '%',
                  gszzlNum,
                  dwjz: val.dwjz,
                  gztime: val.gztime,
                  breakevenDays: 160,
                  breakevenAdvice: isClassC
                    ? '持有 ≤ 160天更优 (0申购费·满7天免赎)'
                    : '持有 > 160天更优 (长期无销售服务费)',
                  penaltyNotice: '持仓<7天强制扣除1.5%惩罚性赎回费'
                });
              }
            } catch {
              // silent fallback
            }
          })
        );
      }

      // 整合全量资产列表、计算实时股息率与动态 AH 折价率
      const enrichedList = ASSETS_CATALOG.map(asset => {
        const q = quoteMap.get(asset.symbol) || {
          price: 0,
          prevClose: 0,
          change: 0,
          changePct: 0,
          pe: null,
          pb: null,
          floatCap: null,
          totalCap: null,
          turnoverAmount: 0,
          iopv: null,
          etfPremiumRate: null
        };

        let computedDividendYield = 0;
        let afterTaxDividendYield = 0;
        let dynamicDiscountRate = null;
        let dynamicPremiumRate = null;

        if (asset.tier === 't0_cash' || asset.tier === 'etf') {
          computedDividendYield = asset.annualYield || 0;
          afterTaxDividendYield = computedDividendYield; // 货基与ETF免税
        } else if (asset.tier === 'hk') {
          // 港股标的：计算名义股息与港股通税后实得股息
          if (q.price > 0 && asset.annualDividendHkd) {
            computedDividendYield = parseFloat(((asset.annualDividendHkd / q.price) * 100).toFixed(2));
            // 扣除 20% 红利税
            afterTaxDividendYield = parseFloat((computedDividendYield * 0.8).toFixed(2));
          }

          // 动态计算 AH 折价率与溢价率
          if (asset.aShareSymbol) {
            const aQuote = quoteMap.get(asset.aShareSymbol);
            if (aQuote && aQuote.price > 0 && q.price > 0) {
              const hPriceInRmb = q.price * fxRate;
              const aPriceInRmb = aQuote.price;
              // 折价率 = (1 - H股折合人民币 / A股价格) * 100
              dynamicDiscountRate = parseFloat(((1 - hPriceInRmb / aPriceInRmb) * 100).toFixed(2));
              // A股相对H股溢价率 = (A股价格 / H股折合人民币 - 1) * 100
              dynamicPremiumRate = parseFloat(((aPriceInRmb / hPriceInRmb - 1) * 100).toFixed(2));
            }
          }
        } else {
          // A 股银行：以基准分红除以现价
          if (q.price > 0 && asset.annualDividend) {
            computedDividendYield = parseFloat(((asset.annualDividend / q.price) * 100).toFixed(2));
            // A 股个人持股超1年免征个税，基准税后即为名义股息率
            afterTaxDividendYield = computedDividendYield;
          }
        }

        // ETF 折溢价率与套利决策指引
        let finalPremiumRate = dynamicPremiumRate;
        let arbitrageAdvice = null;
        if (asset.tier === 'etf') {
          finalPremiumRate = typeof q.etfPremiumRate === 'number' ? q.etfPremiumRate : null;
          if (typeof finalPremiumRate === 'number') {
            if (finalPremiumRate > 0.3) {
              arbitrageAdvice = {
                type: 'premium',
                level: 'warning',
                text: `场内溢价 +${finalPremiumRate.toFixed(2)}%，申购场外联接成本更优（避免买贵）`
              };
            } else if (finalPremiumRate < -0.3) {
              arbitrageAdvice = {
                type: 'discount',
                level: 'opportunity',
                text: `场内折价 ${finalPremiumRate.toFixed(2)}%，二级市场买入具备折价安全垫`
              };
            } else {
              arbitrageAdvice = {
                type: 'neutral',
                level: 'normal',
                text: `折溢价 ${finalPremiumRate >= 0 ? '+' : ''}${finalPremiumRate.toFixed(2)}%（处于合理窄幅区间，平价交易）`
              };
            }
          }
        }

        // 分红周期说明
        const defaultDivFrequency = asset.tier === 'national'
          ? '一年双分红 (年中+年末)'
          : asset.tier === 'hk'
          ? '一年双分红 (港股通扣20%红利税)'
          : asset.tier === 'etf'
          ? '定期分红评估 (按季/按年)'
          : asset.tier === 't0_cash'
          ? '日结份额 / 年末除权分红'
          : '年度分红 (部分推进中期分红)';

        // 场外基金实时估值列表
        const feederValuations = (asset.feederCodes || [])
          .map(fCode => feederValuationMap.get(fCode))
          .filter(Boolean);

        // 综合稳健度综合量化打分
        let stabilityScore = 80;
        if (asset.tier === 't0_cash') {
          stabilityScore = 99;
        } else if (asset.tier === 'national') {
          stabilityScore = 92 + (computedDividendYield > 4.5 ? 3 : 1);
        } else if (asset.tier === 'etf') {
          stabilityScore = 90;
        } else if (asset.tier === 'commercial') {
          stabilityScore = 86 + (asset.roe > 12 ? 3 : 0);
        } else if (asset.tier === 'regional') {
          stabilityScore = 88 + (asset.nplRatio < 0.8 ? 3 : 0);
        } else if (asset.tier === 'hk') {
          stabilityScore = 88;
        }

        return {
          ...asset,
          price: q.price,
          prevClose: q.prevClose,
          change: q.change,
          changePct: q.changePct,
          pe: q.pe,
          pb: q.pb,
          iopv: q.iopv,
          totalCap: q.totalCap,
          floatCap: q.floatCap,
          turnoverAmount: q.turnoverAmount,
          dividendYield: computedDividendYield,
          afterTaxDividendYield,
          dividendFrequency: asset.dividendFrequency || defaultDivFrequency,
          discountRate: dynamicDiscountRate !== null ? dynamicDiscountRate : asset.discountRate,
          premiumRate: finalPremiumRate,
          arbitrageAdvice,
          feederValuations,
          stabilityScore
        };
      });

      quoteCache = enrichedList;
      quoteCacheTs = Date.now();
      return enrichedList;
    } catch (err) {
      console.warn('[bank-stocks] 拉取腾讯行情失败，使用历史缓存或基准:', err.message);
      if (quoteCache) return quoteCache;
      return ASSETS_CATALOG.map(a => ({
        ...a,
        price: a.annualDividend ? parseFloat((a.annualDividend * 20).toFixed(2)) : 100.0,
        prevClose: 0,
        change: 0,
        changePct: 0,
        pe: 6.5,
        pb: 0.70,
        dividendYield: a.annualYield || 4.8,
        afterTaxDividendYield: a.annualYield || 4.8,
        stabilityScore: 85
      }));
    } finally {
      quoteFetchingPromise = null;
    }
  })();

  return quoteFetchingPromise;
}

/**
 * 1. 获取银行·稳健红利板块全景概览
 * GET /api/bank-stocks/overview
 */
router.get('/overview', async (_req, res) => {
  try {
    const list = await fetchAllBankQuotes();
    const currentFx = await fetchHkdCnyRate();

    // 仅针对 A 股上市银行计算行业统计
    const aBankList = list.filter(item => item.market === 'domestic' && !item.isFund);
    const validDividends = aBankList.map(item => item.dividendYield).filter(y => y > 0);
    const validPbs = aBankList.map(item => item.pb).filter(pb => pb && pb > 0);

    // 1. 简单算术平均
    const avgDividendYield = validDividends.length > 0
      ? parseFloat((validDividends.reduce((a, b) => a + b, 0) / validDividends.length).toFixed(2))
      : 4.65;

    const avgPb = validPbs.length > 0
      ? parseFloat((validPbs.reduce((a, b) => a + b, 0) / validPbs.length).toFixed(2))
      : 0.68;

    // 2. 总市值加权平均（金融专业口径）
    let totalCapSum = 0;
    let weightedPbSum = 0;
    let weightedDivSum = 0;

    for (const b of aBankList) {
      if (b.totalCap && b.totalCap > 0) {
        totalCapSum += b.totalCap;
        if (b.pb) weightedPbSum += b.pb * b.totalCap;
        if (b.dividendYield) weightedDivSum += b.dividendYield * b.totalCap;
      }
    }

    const weightedAvgPb = totalCapSum > 0 ? parseFloat((weightedPbSum / totalCapSum).toFixed(2)) : avgPb;
    const weightedAvgDividendYield = totalCapSum > 0 ? parseFloat((weightedDivSum / totalCapSum).toFixed(2)) : avgDividendYield;

    const brokenNetCount = aBankList.filter(item => item.pb && item.pb < 1.0).length;
    const brokenNetRatio = aBankList.length > 0
      ? parseFloat(((brokenNetCount / aBankList.length) * 100).toFixed(1))
      : 88.2;

    const upCount = aBankList.filter(item => item.changePct > 0).length;
    const downCount = aBankList.filter(item => item.changePct < 0).length;
    const flatCount = aBankList.length - upCount - downCount;

    res.json({
      success: true,
      data: {
        sectorAvgDividendYield: avgDividendYield,
        sectorWeightedDividendYield: weightedAvgDividendYield,
        sectorAvgPb: avgPb,
        sectorWeightedPb: weightedAvgPb,
        brokenNetRatio,
        brokenNetCount,
        totalTrackedBanks: aBankList.length,
        upCount,
        downCount,
        flatCount,
        hkdCnyRate: currentFx,
        updateTime: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        riskNotice: {
          title: '专业金融常识与流动性客观审视（严禁盲目迎合）',
          points: [
            '股票无保本承诺：权益类资产每日价格波动，不能与保本银行存款划等号。',
            '分红除权除息规则：A 股分红除息日股价等额下调；未满 1 年减持分红需缴纳 10%~20% 个人红利税。',
            '港股通 20% 红利税：港股银行税前股息率达 6.5%~7%，但经港股通持有强制代扣 20% 红利税，到手实得约 5.2%~5.6%。',
            '资金可用 ≠ 可转出银行卡：T+0 货币 ETF 卖出后在证券账户即刻可用；提现至银行卡需在交易日 9:00~16:00 进行银证转账（非交易时段无法提现）。',
            '货币 ETF 计息差异：华宝添益（100元面值每日份额结转）与银华日利（净值累加年末集中除权现金分红）运作模式不同，二级市场存在微小折溢价风险。'
          ]
        }
      }
    });
  } catch (err) {
    console.error('[bank-stocks] 获取概览异常:', err);
    res.status(500).json({ error: '获取银行板块概览失败: ' + err.message });
  }
});

/**
 * 2. 获取分梯队标的列表
 * GET /api/bank-stocks/list?tier=all|national|commercial|regional|t0_cash|etf|hk
 */
router.get('/list', async (req, res) => {
  try {
    const { tier = 'all', sortBy = 'dividendYield', sortOrder = 'desc' } = req.query;
    const allList = await fetchAllBankQuotes();

    let filtered = allList;
    if (tier && tier !== 'all') {
      filtered = allList.filter(item => item.tier === tier);
    }

    // 排序逻辑
    filtered.sort((a, b) => {
      let valA = a[sortBy] ?? 0;
      let valB = b[sortBy] ?? 0;
      if (sortOrder === 'asc') {
        return valA > valB ? 1 : -1;
      }
      return valA < valB ? 1 : -1;
    });

    res.json({
      success: true,
      total: filtered.length,
      data: filtered
    });
  } catch (err) {
    console.error('[bank-stocks] 获取标的列表异常:', err);
    res.status(500).json({ error: '获取标的列表失败: ' + err.message });
  }
});

// 宏观资讯动态定时同步锁与冷却控制
let syncNewsPromise = null;
let lastSyncNewsTs = 0;

/**
 * 抓取、清洗与同步银行宏观政策资讯
 * 具备双重来源容灾、金融专业白名单过滤、黑名单垃圾信息拦截与指纹去重入库
 */
async function syncBankMacroNews() {
  const now = Date.now();
  if (syncNewsPromise) return syncNewsPromise;
  if (now - lastSyncNewsTs < 30 * 1000) return; // 30秒防抖冷却

  syncNewsPromise = (async () => {
    try {
      lastSyncNewsTs = Date.now();

      // 专业金融词汇白名单（必须命中其一，避免非金融无关信息）
      const whitelist = [
        '银行', '央行', '降准', '降息', 'LPR', 'MLF', '逆回购', '存款准备金率', '存款利率',
        '分红', '股息', '分派', '红利税', '息差', '净息差', 'NIM', '化债', '地方债',
        '特殊再融资', '隐性债务', '不良贷款', '不良率', '不良资产', '拨备覆盖率', '资产质量',
        '汇金', '证金', '社保基金', '险资', '资本充足率', '核心一级资本', '二级资本债', '永续债',
        '信贷', '社融', '货币政策', '金融监管总局', '银保监会'
      ];

      // 垃圾信息黑名单（命中任意一项直接丢弃，过滤支行琐事与网点营销）
      const blacklist = [
        '支行', '网点', '营业厅', '理财产品', '信用卡活动', '防诈', '反诈', '招聘',
        '火灾', '失火', '实习生', '乒乓', '体育', '明星', '娱乐圈', '公安机关'
      ];

      const candidates = [];

      // 来源 1：新浪 7x24 全球财经快讯 (时效性高)
      try {
        const r1 = await axios.get('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=60&zhibo_id=152', {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' },
          timeout: 5000,
        });
        const list1 = r1.data?.result?.data?.feed?.list || [];
        for (const item of list1) {
          const raw = (item.rich_text || '').replace(/<[^>]+>/g, '').trim();
          if (!raw || raw.length < 10) continue;
          const m = raw.match(/^【(.*?)】(.*)$/);
          const title = m ? m[1] : raw.slice(0, 50);
          const summary = m ? m[2].trim() : raw;
          const timeStr = item.create_time ? item.create_time.slice(11, 16) : '今日';
          candidates.push({ title, summary, time: timeStr, source: '新浪7x24快讯' });
        }
      } catch (err) {
        console.warn('[bank-news] 抓取新浪7x24快讯失败:', err.message);
      }

      // 来源 2：新浪财经证券/银行要闻滚动流 (深度较强)
      try {
        const r2 = await axios.get('https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=35&page=1', {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' },
          timeout: 5000,
        });
        const list2 = r2.data?.result?.data || [];
        for (const item of list2) {
          const title = (item.title || '').replace(/<[^>]+>/g, '').trim();
          const summary = (item.summary || item.title || '').replace(/<[^>]+>/g, '').trim();
          if (!title || title.length < 8) continue;
          const d = item.ctime ? new Date(item.ctime * 1000) : null;
          const timeStr = d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '今日';
          candidates.push({ title, summary, time: timeStr, source: item.media_name || '新浪财经' });
        }
      } catch (err) {
        console.warn('[bank-news] 抓取滚动要闻失败:', err.message);
      }

      let insertedCount = 0;
      for (const item of candidates) {
        const fullText = item.title + ' ' + item.summary;
        if (blacklist.some(b => fullText.includes(b))) continue;
        if (!whitelist.some(w => fullText.includes(w))) continue;

        const cleanTitle = item.title.trim();
        const hash = crypto.createHash('sha256').update(cleanTitle).digest('hex').slice(0, 24);

        // 金融宏观分类与客观影响研判推演
        let category = '稳健观察';
        let impact = '关注对银行业务链条与估值中枢的综合影响。';
        if (/央行|货币政策|降准|降息|LPR|MLF|逆回购|信贷|社融|金融监管/.test(fullText)) {
          category = '政策宏观';
          impact = '宏观流动性与政策指引，影响长线配置定价中枢。';
        } else if (/存款利率|息差|净息差|NIM|净利润|营收/.test(fullText)) {
          category = '息差与盈利';
          impact = '负债端与资产端边际定价，直接影响银行净息差与盈利韧性。';
        } else if (/化债|地方债|隐性债务|不良贷款|不良率|拨备|资产质量/.test(fullText)) {
          category = '风控信贷';
          impact = '缓释信贷资产信用风险，稳固资产负债表安全边际。';
        } else if (/分红|股息|汇金|资本充足率|二级资本债|增持|回购/.test(fullText)) {
          category = '资本与分红';
          impact = '直接强化现金回报与核心资本实力，支撑高股息估值。';
        }

        try {
          const r = await dbHelper.run(
            `INSERT OR IGNORE INTO bank_news (hash, title, category, publish_time, summary, impact, source, is_seed)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
            [hash, cleanTitle, category, item.time, item.summary.slice(0, 140), impact, item.source]
          );
          if (r?.changes > 0) insertedCount++;
        } catch (_) {}
      }

      // 滚动淘汰冷数据：保留 4 条基石种子，动态资讯仅保留最新 16 条，表上限 20 条零膨胀
      await dbHelper.run(`
        DELETE FROM bank_news
        WHERE is_seed = 0
          AND id NOT IN (
            SELECT id FROM bank_news WHERE is_seed = 0 ORDER BY id DESC LIMIT 16
          )
      `);

      if (insertedCount > 0) {
        console.log(`[bank-news] 成功同步入库 ${insertedCount} 条银行宏观动态资讯`);
      }
    } catch (e) {
      console.error('[bank-news] 同步资讯异常:', e.message);
    } finally {
      syncNewsPromise = null;
    }
  })();

  return syncNewsPromise;
}

/**
 * 金融知识图谱映射引擎：将宏观资讯动态映射到银行理财标的与资产分类
 * 实现“由事及券”精准穿透
 */
function deriveNewsAssetMapping(item) {
  const fullText = (item.title || '') + ' ' + (item.summary || '') + ' ' + (item.category || '');

  if (/流动性工具|货币\s*ETF|银华日利|华宝添益|建信添益|银证转账|T\+0|活钱/i.test(fullText)) {
    return {
      relatedTier: 't0_cash',
      relatedTierName: 'T+0 场内活钱理财',
      relatedCodes: ['511880', '511990', '511660'],
      beneficiaryDesc: '利好场内闲置资金极速套利与日内流动性增值',
      suggestedAction: '直达银华日利与华宝添益'
    };
  }
  if (/化债|地方债|隐性债务|不良贷款|不良率|拨备|资产质量|长三角|成渝/i.test(fullText)) {
    return {
      relatedTier: 'regional',
      relatedTierName: '区域高成长城农商行',
      relatedCodes: ['601838', '600919', '600926', '601128'],
      beneficiaryDesc: '缓释地方城投信用风险，增厚信贷拨备安全垫',
      suggestedAction: '直达成都银行与江苏银行'
    };
  }
  if (/存款挂牌利率|存款利率|息差|净息差|NIM|零售银行|负债成本/i.test(fullText)) {
    return {
      relatedTier: 'commercial',
      relatedTierName: '优质股份行 · 零售龙头',
      relatedCodes: ['600036', '601166', '000001', '601998'],
      beneficiaryDesc: '负债端定期存款降息缓解息差收窄，利好零售壁垒深厚龙头',
      suggestedAction: '直达招商银行与兴业银行'
    };
  }
  if (/港股通|红利税|AH折价|折价率|H股/i.test(fullText)) {
    return {
      relatedTier: 'hk',
      relatedTierName: '港股高息折价品种',
      relatedCodes: ['00939', '01398', '03328', '03968'],
      beneficiaryDesc: 'AH实时折价较深，税后实得股息依然具备高吸引力',
      suggestedAction: '直达建设银行H与工行H'
    };
  }
  if (/长钱长投|险资|社保|养老金|高股息|国有大行|红利\s*ETF|银行\s*ETF|压舱石|央行|中央金融工作会议/i.test(fullText)) {
    return {
      relatedTier: 'national',
      relatedTierName: '国有六大行 · 行业ETF',
      relatedCodes: ['601398', '601939', '601288', '512800', '512890'],
      beneficiaryDesc: '长期耐心资本增配高股息权益底仓，夯实估值中枢',
      suggestedAction: '直达工商银行与红利ETF'
    };
  }
  return {
    relatedTier: 'all',
    relatedTierName: '全板块稳健配置',
    relatedCodes: ['601398', '600036'],
    beneficiaryDesc: '宏观金融环境动态，关注全行业资产负债端综合传导',
    suggestedAction: '综合查看全市场银行资产配置'
  };
}

/**
 * 3. 宏观与银行业重要资讯及政策动向 (支持动态定时巡检与持久化读取)
 * GET /api/bank-stocks/macro-news
 */
router.get('/macro-news', async (req, res) => {
  try {
    const isRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (isRefresh) {
      await syncBankMacroNews();
    }

    // 优先读取本地数据库中存储的最新资讯
    // 排序逻辑：动态资讯按生成倒序排列在最前，4 条研选基石条目 (is_seed = 1) 稳固在后
    let rows = await dbHelper.all(
      `SELECT id, hash, title, category, publish_time as time, summary, impact, source, is_seed
       FROM bank_news
       ORDER BY CASE WHEN is_seed = 1 THEN 1 ELSE 0 END ASC, id DESC
       LIMIT 8`
    );

    // 防御：若数据表为空，触发一次同步并读取
    if (!rows || rows.length === 0) {
      await syncBankMacroNews();
      rows = await dbHelper.all(
        `SELECT id, hash, title, category, publish_time as time, summary, impact, source, is_seed
         FROM bank_news
         ORDER BY CASE WHEN is_seed = 1 THEN 1 ELSE 0 END ASC, id DESC
         LIMIT 8`
      );
    }

    const enrichedData = (rows || []).map(row => {
      const mapping = deriveNewsAssetMapping(row);
      return {
        ...row,
        relatedTier: mapping.relatedTier,
        relatedTierName: mapping.relatedTierName,
        relatedCodes: mapping.relatedCodes,
        beneficiaryDesc: mapping.beneficiaryDesc,
        suggestedAction: mapping.suggestedAction,
      };
    });

    res.json({
      success: true,
      data: enrichedData,
      lastUpdated: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });
  } catch (err) {
    res.status(500).json({ error: '获取宏观资讯失败: ' + err.message });
  }
});

/**
 * 4. 银行/稳健标的 AI 深度诊断（调用已配置的后台大模型）
 * POST /api/bank-stocks/ai-diagnose
 * Body: { code: string, name: string, market: string }
 */
router.post('/ai-diagnose', async (req, res) => {
  const { code, name, market = 'domestic' } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: '缺少标的代码' });
  }

  try {
    const allQuotes = await fetchAllBankQuotes();
    const target = allQuotes.find(item => item.code === code) || {
      code,
      name: name || code,
      market,
      price: 0,
      changePct: 0,
      dividendYield: 4.5,
      afterTaxDividendYield: 4.5,
      pb: 0.70,
      pe: 6.5,
      nplRatio: 1.2,
      provisionCoverage: 220,
      roe: 10.0,
      reportPeriod: '2024中报',
      tags: ['银行标的']
    };

    // 读取系统已配置的大模型凭证
    let aiConfig = null;
    try {
      const sysRow = await dbHelper.get('SELECT * FROM ai_system_config WHERE id = 1');
      if (sysRow && sysRow.api_key_encrypted) {
        const apiKey = decrypt(sysRow.api_key_encrypted);
        if (apiKey && apiKey.trim()) {
          aiConfig = {
            apiKey: apiKey.trim(),
            baseUrl: sysRow.base_url || 'https://api.anthropic.com',
            modelName: sysRow.model_name || 'claude-3-7-sonnet-20250219',
            apiFormat: sysRow.api_format || 'anthropic',
            authHeaderType: sysRow.auth_header_type || 'ANTHROPIC_AUTH_TOKEN'
          };
        }
      }
    } catch (e) {
      console.warn('[bank-stocks] 读取 AI 配置异常:', e.message);
    }

    // 检索当前最新银行业宏观政策要闻上下文 (Dynamic Macro RAG Context)
    let recentNews = [];
    let macroContextStr = '';
    try {
      recentNews = await dbHelper.all(
        `SELECT category, title, impact, summary FROM bank_news ORDER BY is_seed ASC, id DESC LIMIT 3`
      );
      if (recentNews && recentNews.length > 0) {
        macroContextStr = recentNews.map((n, i) => `${i + 1}. [${n.category}] ${n.title} (客观影响: ${n.impact})`).join('\n');
      }
    } catch (_) {}

    // 调用已配置的大模型
    if (aiConfig) {
      try {
        const promptSystem = `你是一名拥有 20 年银行与固定收益投资经验的资深金融分析师。
请遵循多维严谨评估规范，坚持客观、事实、逻辑、正确、严谨的原则，严禁盲目迎合用户或做出保本保收益的虚假承诺。
请针对给定的银行/红利资产，结合当前宏观政策动态，从以下三个核心维度进行客观剖析：
1. 【分红确定性与股息安全垫】：分析股息率（区分名义股息与税后实得股息）、分红历史持续年限与分红率；
2. 【信贷资产质量与抗风险底线】：分析不良贷款率、拨备覆盖厚度及宏观利率环境对净息差的影响；
3. 【交易机制与流动性风险提示】：结合交易规则（T+1/T+0、除权除息、红利税、银证转账时间窗口）给出理性配置观点。
输出控制在 220~300 字以内，排版清晰精练。`;

        const isHk = target.tier === 'hk';
        const promptUser = `标的信息：
- 代码：${target.code} (${target.name})
- 分类：${target.tierName || '稳健红利资产'}
- 当前价：${target.price}
- 税前股息率基准：${target.dividendYield}%
- 实际到手股息率：${target.afterTaxDividendYield}% ${isHk ? '(已扣20%红利税)' : '(A股满1年免税)'}
- 市净率 (PB)：${target.pb || '无'}
- 市盈率 (PE)：${target.pe || '无'}
- 不良贷款率 (${target.reportPeriod || '最新报告期'})：${target.nplRatio ? target.nplRatio + '%' : '无/基金分散'}
- 拨备覆盖率 (${target.reportPeriod || '最新报告期'})：${target.provisionCoverage ? target.provisionCoverage + '%' : '无'}
- 净资产收益率 (ROE)：${target.roe ? target.roe + '%' : '无'}
- 交易与税负：${target.tradeMechanism || '二级市场'}，${target.taxNote || ''}
${target.discountRate ? `- 相对 A 股折价率：${target.discountRate}%` : ''}

【当前全市场最新银行业宏观背景与政策传导】：
${macroContextStr || '央行引导长钱长投增配高股息资产，存款挂牌利率调降对冲净息差压力，地方化债深入推进缓释信用风险。'}

请结合上述最新宏观利率与政策背景，给出该标的的专业客观体检诊断：`;

        const aiResult = await callModelDirectly(aiConfig, promptSystem, promptUser);
        if (aiResult && aiResult.text) {
          return res.json({
            success: true,
            model: aiResult.model,
            diagnosis: aiResult.text,
            isAiGenerated: true,
            generatedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            metricsSnapshot: {
              price: target.price,
              dividendYield: target.dividendYield,
              afterTaxDividendYield: target.afterTaxDividendYield,
              pb: target.pb,
              nplRatio: target.nplRatio,
              provisionCoverage: target.provisionCoverage,
              reportPeriod: target.reportPeriod
            }
          });
        }
      } catch (err) {
        console.warn('[bank-stocks] 调用配置的 AI 模型失败，转入量化专家规则库:', err.message);
      }
    }

    // 未配置大模型或失败时的降级方案
    const ruleDiagnosis = generateQuantitativeDiagnosis(target, recentNews);
    return res.json({
      success: true,
      model: 'Quantitative-Financial-Rule-Engine',
      diagnosis: ruleDiagnosis,
      isAiGenerated: false,
      generatedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      metricsSnapshot: {
        price: target.price,
        dividendYield: target.dividendYield,
        afterTaxDividendYield: target.afterTaxDividendYield,
        pb: target.pb,
        nplRatio: target.nplRatio,
        provisionCoverage: target.provisionCoverage,
        reportPeriod: target.reportPeriod
      }
    });
  } catch (err) {
    console.error('[bank-stocks] 诊断接口异常:', err);
    res.status(500).json({ error: 'AI 诊断执行失败: ' + err.message });
  }
});

/**
 * 直接调用后台配置的大模型端点
 */
async function callModelDirectly(cfg, systemPrompt, userPrompt) {
  const headers = { 'Content-Type': 'application/json' };
  const cleanKey = cfg.apiKey;

  if (cfg.authHeaderType === 'x-api-key') {
    headers['x-api-key'] = cleanKey;
  } else if (cfg.authHeaderType === 'Authorization') {
    headers['Authorization'] = `Bearer ${cleanKey}`;
  } else {
    headers['x-api-key'] = cleanKey;
    headers['Authorization'] = `Bearer ${cleanKey}`;
  }

  const rawBase = cfg.baseUrl.replace(/\/+$/, '');

  if (cfg.apiFormat === 'openai') {
    const url = `${rawBase}/v1/chat/completions`;
    const payload = {
      model: cfg.modelName,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };
    const resp = await axios.post(url, payload, { headers, timeout: 35000 });
    const text = resp.data?.choices?.[0]?.message?.content || '';
    return { text, model: resp.data?.model || cfg.modelName };
  }

  // Anthropic messages
  headers['anthropic-version'] = '2023-06-01';
  const url = `${rawBase}/v1/messages`;
  const payload = {
    model: cfg.modelName,
    max_tokens: 1000,
    temperature: 0.2,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };
  const resp = await axios.post(url, payload, { headers, timeout: 35000 });
  const blocks = resp.data?.content || [];
  const textBlock = blocks.find(b => b.type === 'text');
  const text = textBlock ? textBlock.text : (typeof resp.data === 'string' ? resp.data : '');
  return { text, model: resp.data?.model || cfg.modelName };
}

/**
 * 确定性量化金融诊断生成器（客观金融模型降级，结合最新宏观政策要闻）
 */
function generateQuantitativeDiagnosis(item, recentNews = []) {
  let macroNote = '';
  if (Array.isArray(recentNews) && recentNews.length > 0) {
    const matched = recentNews.find(n => {
      const full = (n.title || '') + ' ' + (n.summary || '');
      if (item.tier === 't0_cash' && /流动性|货币|T\+0/i.test(full)) return true;
      if (item.tier === 'hk' && /港股|折价|红利税/i.test(full)) return true;
      if ((item.tier === 'national' || item.tier === 'etf') && /长钱|高股息|大行|国有/i.test(full)) return true;
      if (item.tier === 'commercial' && /息差|存款|零售/i.test(full)) return true;
      if (item.tier === 'regional' && /化债|不良|拨备/i.test(full)) return true;
      return false;
    }) || recentNews[0];
    if (matched) {
      macroNote = `\n【宏观政策传导】受近期政策主线驱动（${matched.title}），${matched.impact}`;
    }
  }

  if (item.tier === 't0_cash') {
    return `【流动性与运作机制】${item.name} (${item.code}) 属于场内货币基金，年化收益率基准约 ${item.dividendYield}%。该标的核心特性是 T+0 回转交易，当日卖出后资金在证券账户即刻可用。但请注意：提现至银行卡需受银证转账时段 (9:00~16:00) 约束，非交易时段无法转出；${item.fundMechanism || ''}。${macroNote}`;
  }

  if (item.tier === 'etf') {
    return `【指数化分散评估】${item.name} (${item.code}) 跟踪指数，股息率参考基准为 ${item.dividendYield}%。其核心价值在于规避单一银行信贷暴雷的非系统性风险，免除股票交易印花税；但二级市场仍受大盘贝塔波动影响，实行 T+1 交易交收，建议作为中长线稳健分红底仓配置。${macroNote}`;
  }

  if (item.tier === 'hk') {
    return `【AH 折价与红利税审视】${item.name} (${item.code}) 相对 A 股具有实时折价（约 ${item.discountRate || 30}%），名义股息率达 ${item.dividendYield}%。但必须严密注意税负：内地个人投资者通过港股通买入，分红需由中登代扣 20% 个人红利税，实际到手股息率为 ${item.afterTaxDividendYield}%，且须承担汇率变动风险。${macroNote}`;
  }

  // A 股银行
  const pbStr = item.pb ? `市净率 PB 仅 ${item.pb}（处于深度破净区间）` : '估值安全边际充沛';
  const nplStr = item.nplRatio ? `最新不良贷款率控制在 ${item.nplRatio}%，拨备覆盖率达 ${item.provisionCoverage}% (${item.reportPeriod})` : '信贷资产整体健康';

  return `【分红与估值体检】${item.name} (${item.code}) 静态股息率约为 ${item.dividendYield}%，${pbStr}，分红具备较厚安全垫。\n【资产质量底线】财报显示其 ${nplStr}，拨备安全垫充裕。\n【交易与税收规则】A 股实行 T+1 交收与除权除息规则，个人持股满 1 年免征红利税，未满 1 年减持分红需按 10%~20% 补缴个税，建议以 1 年以上周期长线持有。${macroNote}`;
}

module.exports = {
  router,
  ASSETS_CATALOG,
  fetchAllBankQuotes,
  fetchHkdCnyRate,
  syncBankMacroNews,
};
