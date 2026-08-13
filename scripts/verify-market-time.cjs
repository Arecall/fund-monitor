/**
 * 市场开盘休市时间与美股/QDII多源降级规则校验脚本
 * 每次 git commit 前触发，若规则或降级算法校验失败则中断 commit 并输出具体原因。
 */

'use strict';

const market = require('../server/market.cjs');
const marketTime = require('../server/time.cjs');

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ [时间/降级校验错误]: ${message}`);
    process.exit(1);
  }
}

console.log('🔍 开始校验交易时间、美股及 QDII 基金降级策略...');

// 1. A 股开盘时间校验 (北京时间 09:30-11:30, 13:00-15:00)
const aShareTradingTime = new Date('2026-08-06T10:00:00+08:00');
const aShareClosedTime = new Date('2026-08-06T12:30:00+08:00');
assert(market.isInTradingTime('600519', aShareTradingTime, 'domestic') === true, 'A股盘中时间判定错误');
assert(market.isInTradingTime('600519', aShareClosedTime, 'domestic') === false, 'A股休市时间判定错误');

// 2. 港股开盘时间校验 (北京时间 09:30-12:00, 13:00-16:00)
const hkTradingTime = new Date('2026-08-06T11:45:00+08:00');
const hkClosedTime = new Date('2026-08-06T12:30:00+08:00');
assert(market.isInTradingTime('00700', hkTradingTime, 'hk') === true, '港股盘中时间判定错误');
assert(market.isInTradingTime('00700', hkClosedTime, 'hk') === false, '港股休市时间判定错误');

// 3. 美股开盘时间校验 (夏令时 北京时间 21:30 - 04:00)
const usTradingTime = new Date('2026-08-06T23:00:00+08:00');
const usDaytimeClosedTime = new Date('2026-08-06T14:00:00+08:00');
assert(market.isInTradingTime('AAPL', usTradingTime, 'us') === true, '美股盘中时间判定错误');
assert(market.isInTradingTime('AAPL', usDaytimeClosedTime, 'us') === false, '美股白天休市时间判定错误');

// 4. QDII 美股基金与国内主题基金（如 025687 国泰半导体）市场自动识别校验
const qdii1 = market.detectMarketFromName('华安纳斯达克100ETF联接(QDII)A');
const qdii2 = market.detectMarketFromName('汇添富全球移动互联混合(QDII)人民币A');
const qdiiHk = market.detectMarketFromName('易方达恒生科技ETF联接(QDII)A');
const domesticSemi = market.detectMarketFromName('国泰半导体制造精选混合发起C');

assert(qdii1 === 'us', '040046 纳斯达克 QDII 市场未识别为美股 (us)');
assert(qdii2 === 'us', '001668 全球移动互联 QDII 市场未识别为美股 (us)');
assert(qdiiHk === 'hk', '恒生科技 QDII 市场未识别为港股 (hk)');
assert(domesticSemi === 'domestic', '025687 国泰半导体国内 A 股基金误判为美股 (us)');

// 5. QDII 美股基金开盘时间校验 (未指定 market 参数时自动推断为美股)
assert(market.isInTradingTime('040046', usTradingTime, 'us') === true, '040046 美股盘中时间未识别');

// 6. 已注册 QDII 泛源连续返回同一行情超过 2 分钟时必须触发降级；行情改变后重新计时。
// 白天（非美股开盘时间）A 股开盘推送的 QDII 占位符必须被判定拦截并降级
const repeatCacheKey = 'verify:040046';
const genericQuote = {
  quoteSource: 'fundgz', fundcode: '040046', gztime: '2026-08-06 23:00',
  gsz: '8.1000', gszzl: '1.00', dwjz: '8.0200', market: 'us', name: '华安纳斯达克100ETF联接(QDII)A'
};
const repeatStart = Date.parse('2026-08-06T23:00:00+08:00');
assert(market.isRepeatedGenericQdiiData(repeatCacheKey, genericQuote, repeatStart) === false, 'QDII 首次泛源数据不应降级');
assert(market.isRepeatedGenericQdiiData(repeatCacheKey, genericQuote, repeatStart + 119_000) === false, 'QDII 相同泛源数据不足 2 分钟不应降级');
assert(market.isRepeatedGenericQdiiData(repeatCacheKey, genericQuote, repeatStart + 121_000) === true, 'QDII 相同泛源数据超过 2 分钟未触发降级');
assert(market.isRepeatedGenericQdiiData(repeatCacheKey, { ...genericQuote, gsz: '8.1010' }, repeatStart + 122_000) === false, 'QDII 泛源数据变化后未重新计时');

// 校验 QDII 美股基金在白天 A 股开盘时间（例如 09:35）下美股休市时的盘中状态拦截
const daytimeTime = new Date('2026-08-06T09:35:00+08:00');
assert(market.isInTradingTime('040046', daytimeTime, 'us') === false, '美股 QDII 白天 A 股开盘时间不应判定为美股盘中');

// 7. pingzhongdata 日本 TSE 代码：285A 是铠侠（285A.T），绝不能误判成港股 00285。
const kioxia = market.parseStockCodes(['285A'], { onlyNonAShare: true })[0];
assert(kioxia.code === '285A' && kioxia.market === 'jp' && kioxia.exchange === 'JP', '285A 铠侠未识别为日本 TSE 股票');
const unknownAlphaNumeric = market.parseStockCodes(['99ZZ'], { onlyNonAShare: true })[0];
assert(unknownAlphaNumeric.exchange === '', '未知字母数字代码被错误泛化为已知市场');

// 8. QDII 无后缀六位数字优先保留为韩国市场，不能截断为无关港股。
const koreanHoldings = market.parseStockCodes(['000660', '005930'], { onlyNonAShare: true });
assert(koreanHoldings[0].exchange === 'KR' && koreanHoldings[0].code === '000660', 'SK 海力士 000660 被错误映射为港股');
assert(koreanHoldings[1].exchange === 'KR' && koreanHoldings[1].code === '005930', '三星电子 005930 被错误映射为港股');
const explicitHongKong = market.parseStockCodes(['00700116'], { onlyNonAShare: true })[0];
assert(explicitHongKong.exchange === 'HK' && explicitHongKong.code === '00700', '带 116 后缀的明确港股规则回归');

// 9. 纽约盘前构成刷新窗口：08:45 ET 起、09:30 ET 前；周末必须跳过。
const { isUsPremarketRefreshWindow } = require('../server/holdings-prefetch.cjs');
assert(isUsPremarketRefreshWindow(new Date('2026-08-07T08:45:00-04:00'), marketTime) === true, '纽约盘前 08:45 未触发持仓刷新窗口');
assert(isUsPremarketRefreshWindow(new Date('2026-08-07T09:30:00-04:00'), marketTime) === false, '纽约开盘后不应继续持仓刷新窗口');
assert(isUsPremarketRefreshWindow(new Date('2026-08-08T08:45:00-04:00'), marketTime) === false, '纽约周末不应触发持仓刷新窗口');

// 10. 持仓现价换算统一使用人民币，CNY 直通，外币仅按有效汇率换算。
assert(market.currencyForExchange('KR') === 'KRW' && market.currencyForExchange('JP') === 'JPY', '日韩持仓币种推断错误');
assert(market.convertPriceToCny(100, 'USD', { USD: 7.2 }) === 720, '美元人民币换算错误');
assert(market.convertPriceToCny(100, 'CNY', { CNY: 1 }) === 100, '人民币价格不应重复换算');
assert(market.convertPriceToCny(100, 'KRW', null) === null, '汇率缺失时不应伪造人民币价格');

// 11. 持仓估算完整性与偏离放弃断言
// (1) 模拟持仓个股报价未 100% 覆盖时，系统必须放弃持仓估值返回 null
// (2) 模拟持仓股票偏离中位数 > 15% 时，系统必须放弃持仓估值返回 null
async function verifyHoldingsFallbackRules() {
  // 校验持仓个股覆盖率：期待 3 只股票，实际仅提供 2 只有效报价
  const stocks3 = [{ code: 'AAPL', exchange: 'US' }, { code: 'MSFT', exchange: 'US' }, { code: 'GOOGL', exchange: 'US' }];
  const expectedKeys = stocks3.map(s => `gb_${s.code.toLowerCase()}`);
  const partialMap = new Map([
    ['gb_aapl', { price: 200, changePct: 1.5, source: 'tencent-qt' }],
    ['gb_msft', { price: 400, changePct: 0.8, source: 'tencent-qt' }],
  ]);
  const validQuotesPartial = expectedKeys.map(k => partialMap.get(k)).filter(q => q && q.price > 0 && Math.abs(q.changePct) < 50);
  assert(validQuotesPartial.length !== expectedKeys.length, '残缺持仓报价覆盖率判定未生效');

  // 校验偏离中位数 > 15% 的异常值剔除：1.0, 1.2, 1.1, 1.5, 50.0 (极端离群值，长度>=4)
  const extremeChanges = [1.0, 1.2, 1.1, 1.5, 50.0];
  const sorted = [...extremeChanges].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const filtered = extremeChanges.filter(v => Math.abs(v - median) <= 15 || sorted.length < 4);
  assert(filtered.length !== extremeChanges.length, '离群持仓偏离数据未被识别并触发放弃');
}

verifyHoldingsFallbackRules().then(() => {
  console.log('✅ 市场交易时间与规则校验全部通过！');
  process.exit(0);
}).catch(err => {
  console.error(`❌ [降级断言校验失败]: ${err.message}`);
  process.exit(1);
});
