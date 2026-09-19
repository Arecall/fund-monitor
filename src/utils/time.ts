export const BEIJING_TIME_ZONE = 'Asia/Shanghai';
const US_EASTERN_TIME_ZONE = 'America/New_York';
type TimeZoneParts = Record<string, string>;

/** Parse the upstream Beijing wall-clock format: YYYY-MM-DD HH:mm[:ss]. */
export function parseBeijingDateTime(value: string | undefined): number {
  if (!value) return Date.now();
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) return Date.now();

  const [, yearRaw, monthRaw, dayRaw, hourRaw = '0', minuteRaw = '0', secondRaw = '0'] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (![year, month, day, hour, minute, second].every(Number.isFinite) ||
      month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return Date.now();
  }

  // Beijing is permanently UTC+08:00. Validate to reject rollover dates such as 2026-02-30.
  const utc = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const check = new Date(utc + 8 * 60 * 60 * 1000);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return Date.now();
  return utc;
}

export const parseGzTime = parseBeijingDateTime;

export function getBeijingParts(date: Date | number): TimeZoneParts {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: BEIJING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(date)).map(part => [part.type, part.value]));
}

/** Convert a Beijing wall-clock date/time to a Unix timestamp, independent of browser timezone. */
export function beijingWallTimeToTimestamp(year: number, monthZeroBased: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, monthZeroBased, day, hour - 8, minute, 0, 0);
}

export function formatBeijingTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function formatBeijingDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TIME_ZONE,
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}

/** Uses the IANA timezone database, including the actual March/November DST transitions. */
export function isUsEasternDst(date = new Date()): boolean {
  const zone = new Intl.DateTimeFormat('en-US', {
    timeZone: US_EASTERN_TIME_ZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value;
  return zone === 'GMT-04:00';
}

// 2025 - 2027 股市法定节假日日历 (中国 A 股、港股、美股)
// 交易所休市日（不含常规双休周末，周末全天自动判定为休市）
export const DOMESTIC_HOLIDAYS = new Set([
  // 2025
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04',
  '2025-04-04',
  '2025-05-01', '2025-05-02', '2025-05-05',
  '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026
  '2026-01-01', '2026-01-02',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
  '2026-04-06',
  '2026-05-01', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  // 2027
  '2027-01-01',
  '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12',
  '2027-04-05',
  '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09',
  '2027-10-01', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
]);

export const HK_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31', '2025-04-04', '2025-04-18', '2025-04-21',
  '2025-05-01', '2025-05-05', '2025-07-01', '2025-10-01', '2025-10-07', '2025-10-29', '2025-12-25', '2025-12-26',
  // 2026
  '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03', '2026-04-06', '2026-05-01',
  '2026-05-25', '2026-06-19', '2026-07-01', '2026-09-28', '2026-10-01', '2026-10-19', '2026-12-25',
  // 2027
  '2027-01-01', '2027-02-05', '2027-02-08', '2027-02-09', '2027-03-26', '2027-03-29', '2027-04-05',
  '2027-05-13', '2027-06-09', '2027-07-01', '2027-09-16', '2027-10-01', '2027-10-08', '2027-12-27',
]);

export const US_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04',
  '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24',
]);

export function formatBeijingYmd(date: Date | number = new Date()): string {
  const p = getBeijingParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatUsEasternYmd(date: Date | number = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: US_EASTERN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(date));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function isMarketHoliday(market: string = 'domestic', date: Date | number = new Date()): boolean {
  if (market === 'us') {
    return US_HOLIDAYS.has(formatUsEasternYmd(date));
  }
  if (market === 'hk') {
    return HK_HOLIDAYS.has(formatBeijingYmd(date));
  }
  return DOMESTIC_HOLIDAYS.has(formatBeijingYmd(date));
}

export function isMarketTradingDay(market: string = 'domestic', date: Date | number = new Date()): boolean {
  let weekday: string;
  if (market === 'us') {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: US_EASTERN_TIME_ZONE,
      weekday: 'short',
    }).formatToParts(new Date(date));
    weekday = parts.find(p => p.type === 'weekday')?.value || '';
  } else {
    weekday = getBeijingParts(date).weekday;
  }
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !isMarketHoliday(market, date);
}

export function getLastTradingDay(market: string = 'domestic', date: Date | number = new Date()): Date {
  const target = new Date(date);
  for (let i = 0; i < 30; i++) {
    target.setDate(target.getDate() - 1);
    if (isMarketTradingDay(market, target)) {
      return target;
    }
  }
  return target;
}
