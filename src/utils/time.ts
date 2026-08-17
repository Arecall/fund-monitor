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
