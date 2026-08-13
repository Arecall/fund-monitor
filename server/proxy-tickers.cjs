/**
 * 已验证 QDII 指数代理注册表。
 *
 * 代理估值只能由明确核验过的基金代码开启，绝不能仅凭基金名称中的行业词匹配。
 * 例如国内“半导体”基金不能因上游短暂失败而被错误套用美股 SOXX 涨跌。
 *
 * 腾讯 Qt 是当前部署环境中已验证可用的数据源。NQ 期货源尚未验证，保留配置结构但
 * 必须显式 enabled: true 后才会参与选择；默认使用已验证的 QQQ ETF。
 */

'use strict';

const KNOWN_QDII_PROXIES = Object.freeze({
  '040046': Object.freeze({
    code: '040046',
    market: 'us',
    family: 'nasdaq100',
    label: '纳斯达克100',
    regularProxy: Object.freeze({
      tencentSymbol: 'usQQQ',
      tickerLabel: 'QQQ',
      sourceName: 'Invesco QQQ Trust (Nasdaq-100)',
      type: 'etf',
    }),
    futuresProxy: Object.freeze({
      enabled: false,
      tencentSymbol: null,
      tickerLabel: 'NQ',
      sourceName: 'Nasdaq-100 Futures',
      type: 'future',
    }),
  }),
  '001668': Object.freeze({
    code: '001668',
    market: 'us',
    family: 'global_tech',
    label: '全球移动互联网',
    regularProxy: Object.freeze({
      tencentSymbol: 'usQQQ',
      tickerLabel: 'QQQ',
      sourceName: 'Invesco QQQ Trust (Nasdaq-100)',
      type: 'etf',
    }),
    futuresProxy: Object.freeze({
      enabled: false,
      tencentSymbol: null,
      tickerLabel: 'NQ',
      sourceName: 'Nasdaq-100 Futures',
      type: 'future',
    }),
  }),
});

function normalizeCode(code) {
  return String(code || '').trim();
}

function getKnownProxyConfig(code) {
  return KNOWN_QDII_PROXIES[normalizeCode(code)] || null;
}

function isKnownProxyFund(code) {
  return !!getKnownProxyConfig(code);
}

/**
 * 根据时段与已验证配置选择候选标的。调用方必须继续检查上游报价时效。
 * 未验证期货永远不会被返回，保证 API 不会谎称使用 NQ。
 */
function selectProxyInstruments(config, session) {
  if (!config) return [];
  const result = [];
  const canUseFuture = config.futuresProxy?.enabled && config.futuresProxy.tencentSymbol;
  if ((session === 'overnight' || session === 'premarket') && canUseFuture) {
    result.push(config.futuresProxy);
  }
  // QQQ 在常规盘/盘后优先；扩展时段仅作为已知可用的最后报价候选，仍由时效检查淘汰。
  if (config.regularProxy?.tencentSymbol) result.push(config.regularProxy);
  if ((session === 'regular' || session === 'postmarket') && canUseFuture) {
    result.push(config.futuresProxy);
  }
  return result;
}

module.exports = {
  KNOWN_QDII_PROXIES,
  getKnownProxyConfig,
  isKnownProxyFund,
  selectProxyInstruments,
};