const BEIJING_TIME_ZONE = 'Asia/Shanghai';
const US_EASTERN_TIME_ZONE = 'America/New_York';

function getTimeZoneParts(date = new Date(), timeZone = BEIJING_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function isUsEasternDst(date = new Date()) {
  const zone = new Intl.DateTimeFormat('en-US', {
    timeZone: US_EASTERN_TIME_ZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value;
  return zone === 'GMT-04:00';
}

function formatBeijingYmd(date = new Date()) {
  const p = getTimeZoneParts(date, BEIJING_TIME_ZONE);
  return `${p.year}-${p.month}-${p.day}`;
}

function formatBeijingYmdHm(date = new Date()) {
  const p = getTimeZoneParts(date, BEIJING_TIME_ZONE);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function getBeijingHour(date = new Date()) {
  const p = getTimeZoneParts(date, BEIJING_TIME_ZONE);
  return Number(p.hour);
}

function getUsEasternDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: US_EASTERN_TIME_ZONE,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function formatUsEasternYmd(date = new Date()) {
  const p = getUsEasternDateTimeParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * 按纽约本地时钟给美股代理选择报价源。交易日历（节假日）仍由上游行情时效兜底；
 * 常规盘严格 09:30–16:00，盘前/盘后用于选择已验证的代理源。
 */
function getUsMarketSession(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: US_EASTERN_TIME_ZONE,
    weekday: 'short',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minute = Number(p.hour) * 60 + Number(p.minute);
  if (p.weekday === 'Sat') return 'closed';
  // 周日 18:00 前按关闭处理；未来 NQ 来源验证后才可能在此窗口启用期货。
  if (p.weekday === 'Sun') return minute >= 18 * 60 ? 'overnight' : 'closed';
  if (minute >= 9 * 60 + 30 && minute < 16 * 60) return 'regular';
  if (minute >= 16 * 60 && minute < 20 * 60) return 'postmarket';
  if (minute >= 4 * 60 && minute < 9 * 60 + 30) return 'premarket';
  return 'overnight';
}

function parseZonedDateTime(value, timeZone, utcOffsets) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw = '0', minuteRaw = '0', secondRaw = '0'] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (![year, month, day, hour, minute, second].every(Number.isFinite) ||
      month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

  for (const offsetHours of utcOffsets) {
    const timestamp = Date.UTC(year, month - 1, day, hour - offsetHours, minute, second);
    const p = getTimeZoneParts(new Date(timestamp), timeZone);
    if (Number(p.year) === year && Number(p.month) === month && Number(p.day) === day &&
        Number(p.hour) === hour && Number(p.minute) === minute) return timestamp;
  }
  return null;
}

function parseBeijingDateTime(value) {
  return parseZonedDateTime(value, BEIJING_TIME_ZONE, [8]);
}

/** 腾讯 us* 报价的时间字段是纽约市场本地时间，须同时处理 EST / EDT。 */
function parseUsEasternDateTime(value) {
  return parseZonedDateTime(value, US_EASTERN_TIME_ZONE, [-4, -5]);
}

module.exports = {
  BEIJING_TIME_ZONE,
  formatBeijingYmd,
  formatBeijingYmdHm,
  getBeijingHour,
  formatUsEasternYmd,
  getUsEasternDateTimeParts,
  getTimeZoneParts,
  isUsEasternDst,
  getUsMarketSession,
  parseBeijingDateTime,
  parseUsEasternDateTime,
};
