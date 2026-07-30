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

import { beijingWallTimeToTimestamp, getBeijingParts, isUsEasternDst } from './time';

export type FundMarket = 'domestic' | 'hk' | 'us' | 'other';

const US_PATTERN = /纳斯达克|纳指|纳100|纳达克|标普|标500|道琼斯|道琼|道指|Nasdaq|NASDAQ|S&P|标普500|SP500|美股|美国|QDII|海外|全球|标100|纳100/i;
const HK_PATTERN = /恒生|港股|香港|中港|沪港深|HK|Hangseng|HSI/i;
const OTHER_PATTERN = /德国|欧洲|日经|东京|英国|伦敦|DAX|FTSE|欧股|富时/i;

export function detectFundMarket(name?: string, code?: string): FundMarket {
  const text = `${name || ''} ${code || ''}`;
  if (US_PATTERN.test(text)) return 'us';
  if (HK_PATTERN.test(text)) return 'hk';
  if (OTHER_PATTERN.test(text)) return 'other';
  // 纯字母 ticker（如 TSLA / AAPL / NVDA）→ 美股
  if (code && /^[A-Za-z]{1,5}$/.test(code.trim())) return 'us';
  // 5 位数字 → 港股（00700 / 09988 等）
  if (code && /^\d{4,5}$/.test(code.trim())) return 'hk';
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

/**
 * 判断指定市场当前是否处于交易/开盘时间内（北京时间）
 * 用于前端判断全局休市状态，休市时停止自动轮询打扰后端
 */
export function isMarketOpen(market: FundMarket, date = new Date()): boolean {
  // 用 Intl 取各目标时区的 weekday 与 hour/minute
  let tz = 'Asia/Shanghai';
  let sessions = [
    [9 * 60 + 30, 11 * 60 + 30],
    [13 * 60, 15 * 60]
  ];

  if (market === 'hk') {
    tz = 'Asia/Hong_Kong';
    sessions = [
      [9 * 60 + 30, 12 * 60],
      [13 * 60, 16 * 60]
    ];
  } else if (market === 'us') {
    tz = 'America/New_York';
    sessions = [
      [9 * 60 + 30, 16 * 60]
    ];
  } else if (market === 'other') {
    // 黄金 / 其它海外：除了周末外，全天大部分时间开盘
    return isWeekday(date, 'Asia/Shanghai');
  }

  return isTradingSession(date, tz, sessions);
}

function isWeekday(date: Date, tz: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).formatToParts(date);
    const day = parts.find(p => p.type === 'weekday')?.value;
    return day !== 'Sat' && day !== 'Sun';
  } catch {
    return true;
  }
}

function isTradingSession(date: Date, tz: string, sessions: number[][]): boolean {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(date);
    const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
    if (m.weekday === 'Sat' || m.weekday === 'Sun') return false;
    const hour = parseInt(m.hour, 10);
    const minute = parseInt(m.minute, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true;
    const nowMin = hour * 60 + minute;
    return sessions.some(([s, e]) => nowMin >= s && nowMin < e);
  } catch {
    return true;
  }
}

/**
 * 计算指定市场下一个常规盘中开盘的 Date 对象（北京时间）
 */
export function getNextOpenTime(market: FundMarket, date = new Date()): Date {
  const bjt = getBeijingParts(date);
  // UTC date is used only as a timezone-neutral calendar container; wall times are
  // converted to Beijing timestamps explicitly before returning.
  const target = new Date(Date.UTC(Number(bjt.year), Number(bjt.month) - 1, Number(bjt.day)));
  const day = target.getUTCDay(); // 北京时间的 0=Sun, 1=Mon, ..., 6=Sat
  const min = Number(bjt.hour) * 60 + Number(bjt.minute);

  if (market === 'us') {
    // 先确定下一北京交易日，再按该日纽约 DST 规则计算北京时间开盘时刻。
    const todayOpenHour = isUsEasternDst(date) ? 21 : 22;
    const todayOpenMin = todayOpenHour * 60 + 30;
    if (day === 6) target.setUTCDate(target.getUTCDate() + 2);
    else if (day === 0) target.setUTCDate(target.getUTCDate() + 1);
    else if (min >= todayOpenMin) target.setUTCDate(target.getUTCDate() + (day === 5 ? 3 : 1));

    const openHour = isUsEasternDst(target) ? 21 : 22;
    return new Date(beijingWallTimeToTimestamp(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), openHour, 30));
  }

  // A 股 / 港股
  const morningOpenMin = 9 * 60 + 30;   // 09:30
  const afternoonOpenMin = 13 * 60;      // 13:00
  const closeMin = market === 'hk' ? 16 * 60 : 15 * 60;

  let targetHour = 9;
  let targetMinute = 30;
  if (day === 6) target.setUTCDate(target.getUTCDate() + 2);
  else if (day === 0) target.setUTCDate(target.getUTCDate() + 1);
  else if (min >= 11 * 60 + 30 && min < afternoonOpenMin) {
    targetHour = 13;
  } else if (min >= morningOpenMin && min < closeMin) {
    // 盘中时下一个节点为午盘 13:00 或下一交易日开盘。
    if (min < 11 * 60 + 30) targetHour = 13;
    else target.setUTCDate(target.getUTCDate() + (day === 5 ? 3 : 1));
  } else if (min >= closeMin) {
    target.setUTCDate(target.getUTCDate() + (day === 5 ? 3 : 1));
  }

  return new Date(beijingWallTimeToTimestamp(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), targetHour, targetMinute));
}

/**
 * 判断给定的自选列表中，是否有任意一个市场处于开盘/交易时间内
 * 如果全部休市（如周末或全休市夜间），返回 false 告知前端暂停自动轮询
 */
export function isAnyMarketOpen(markets: FundMarket[], date = new Date()): boolean {
  if (markets.length === 0) {
    // 默认关注 A 股和美股
    return isMarketOpen('domestic', date) || isMarketOpen('us', date);
  }
  return markets.some(m => isMarketOpen(m, date));
}
