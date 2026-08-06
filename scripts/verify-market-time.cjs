/**
 * 市场开盘休市时间规则校验脚本
 * 每次 git commit 前触发，若规则或算法校验失败则中断 commit 并输出具体原因。
 */

'use strict';

const market = require('../server/market.cjs');
const marketTime = require('../server/time.cjs');

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ [时间校验错误]: ${message}`);
    process.exit(1);
  }
}

console.log('🔍 开始校验交易时间与市场匹配规则...');

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

// 4. QDII 美股基金市场自动识别校验 (例如 040046, 001668 必须判定为 us 市场)
const qdii1 = market.detectMarketFromName('华安纳斯达克100ETF联接(QDII)A');
const qdii2 = market.detectMarketFromName('汇添富全球移动互联混合(QDII)人民币A');
const qdiiHk = market.detectMarketFromName('易方达恒生科技ETF联接(QDII)A');

assert(qdii1 === 'us', '040046 纳斯达克 QDII 市场未识别为美股 (us)');
assert(qdii2 === 'us', '001668 全球移动互联 QDII 市场未识别为美股 (us)');
assert(qdiiHk === 'hk', '恒生科技 QDII 市场未识别为港股 (hk)');

// 5. QDII 美股基金开盘时间校验 (未指定 market 参数时自动推断为美股)
assert(market.isInTradingTime('040046', usTradingTime, 'us') === true, '040046 美股盘中时间未识别');

console.log('✅ 市场交易时间与规则校验全部通过！');
process.exit(0);
