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
  const target = new Date(date);
  const day = target.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const min = target.getHours() * 60 + target.getMinutes();

  if (market === 'us') {
    // 美股常规盘中开盘：美东 09:30 (夏令时北京 21:30, 冬令时北京 22:30)
    const m = target.getMonth() + 1;
    const isDst = m >= 3 && m <= 10;
    const openHour = isDst ? 21 : 22;
    const openMin = openHour * 60 + 30;

    if (day === 6) { // 周六 → 推进到周一晚
      target.setDate(target.getDate() + 2);
      target.setHours(openHour, 30, 0, 0);
    } else if (day === 0) { // 周日 → 推进到周一晚
      target.setDate(target.getDate() + 1);
      target.setHours(openHour, 30, 0, 0);
    } else if (min < openMin) { // 今日盘中开盘前 (包含夜盘/盘前段)
      target.setHours(openHour, 30, 0, 0);
    } else { // 今日盘中开盘后/收盘后 → 推进到下一个工作日晚
      target.setDate(target.getDate() + (day === 5 ? 3 : 1));
      target.setHours(openHour, 30, 0, 0);
    }
    return target;
  }

  // A 股 / 港股
  const morningOpenMin = 9 * 60 + 30;   // 09:30
  const afternoonOpenMin = 13 * 60;      // 13:00
  const closeMin = market === 'hk' ? 16 * 60 : 15 * 60;

  if (day === 6) { // 周六
    target.setDate(target.getDate() + 2);
    target.setHours(9, 30, 0, 0);
  } else if (day === 0) { // 周日
    target.setDate(target.getDate() + 1);
    target.setHours(9, 30, 0, 0);
  } else if (min < morningOpenMin) { // 早盘前（00:00 - 09:30）
    target.setHours(9, 30, 0, 0);
  } else if (min >= 11 * 60 + 30 && min < afternoonOpenMin) { // 午休（11:30 - 13:00）
    target.setHours(13, 0, 0, 0);
  } else if (min >= morningOpenMin && min < closeMin) { // 盘中（09:30-11:30 或 13:00-15:00）
    // 盘中时下一个节点为午盘 13:00 或 收盘/次日
    if (min < 11 * 60 + 30) {
      target.setHours(13, 0, 0, 0);
    } else {
      target.setDate(target.getDate() + (day === 5 ? 3 : 1));
      target.setHours(9, 30, 0, 0);
    }
  } else { // 盘后（>= 15:00/16:00）
    target.setDate(target.getDate() + (day === 5 ? 3 : 1));
    target.setHours(9, 30, 0, 0);
  }

  return target;
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
