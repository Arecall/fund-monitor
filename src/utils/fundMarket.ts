/**
 * 基金市场识别 — 单一来源，避免在多个文件里写出不一致的 regex
 *
 * 优先级：
 *   1) US 关键词（最具体，包括美股大盘指数关键词）
 *   2) HK 关键词
 *   3) 欧洲/其他海外
 *   4) 默认 A 股
 *
 * 注意：US 优先于 HK，因为 QDII 基金通常跟踪美股大盘指数，
 *      即便名称里含有"香港""HK"等字样（如某些跨市场 ETF），
 *      也应该按其跟踪的标的（纳斯达克/标普）分类为美股。
 */

export type FundMarket = 'domestic' | 'hk' | 'us' | 'other';

const US_PATTERN = /纳斯达克|纳指|纳100|纳达克|标普|标500|道琼斯|道琼|道指|Nasdaq|NASDAQ|S&P|标普500|SP500|美股|美国|QDII|海外|全球|标100|纳100/i;
const HK_PATTERN = /恒生|港股|香港|中港|沪港深|HK|Hangseng|HSI/i;
const OTHER_PATTERN = /德国|欧洲|日经|东京|英国|伦敦|DAX|FTSE|欧股|富时/i;

export function detectFundMarket(name?: string, code?: string): FundMarket {
  const text = `${name || ''} ${code || ''}`;
  if (US_PATTERN.test(text)) return 'us';
  if (HK_PATTERN.test(text)) return 'hk';
  if (OTHER_PATTERN.test(text)) return 'other';
  return 'domestic';
}

/** 友好的市场标签 */
export function marketLabel(market: FundMarket): string {
  switch (market) {
    case 'us': return '美股';
    case 'hk': return '港股';
    case 'other': return '海外';
    default: return 'A股';
  }
}
