const BEIJING_TIME_ZONE = 'Asia/Shanghai';
const US_EASTERN_TIME_ZONE = 'America/New_York';

// 2025 - 2027 股市法定节假日日历 (中国 A 股、港股、美股)
// 交易所休市日（不含常规双休周末，周末全天自动判定为休市）
const DOMESTIC_HOLIDAYS = new Set([
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

const HK_HOLIDAYS = new Set([
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

const US_HOLIDAYS = new Set([
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

function isMarketHoliday(market = 'domestic', date = new Date()) {
  const m = market === 'hk' ? 'hk' : (market === 'us' ? 'us' : 'domestic');
  if (m === 'us') {
    const ymd = formatUsEasternYmd(date);
    return US_HOLIDAYS.has(ymd);
  } else if (m === 'hk') {
    const ymd = formatBeijingYmd(date);
    return HK_HOLIDAYS.has(ymd);
  }
  const ymd = formatBeijingYmd(date);
  return DOMESTIC_HOLIDAYS.has(ymd);
}

function isMarketTradingDay(market = 'domestic', date = new Date()) {
  const m = market === 'hk' ? 'hk' : (market === 'us' ? 'us' : 'domestic');
  let weekday;
  if (m === 'us') {
    weekday = getUsEasternDateTimeParts(date).weekday;
  } else {
    const p = getTimeZoneParts(date, BEIJING_TIME_ZONE);
    weekday = p.weekday || new Intl.DateTimeFormat('en-US', { timeZone: BEIJING_TIME_ZONE, weekday: 'short' }).format(date);
  }
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !isMarketHoliday(m, date);
}

function getLastTradingDay(market = 'domestic', date = new Date()) {
  const target = new Date(date);
  for (let i = 0; i < 30; i++) {
    target.setDate(target.getDate() - 1);
    if (isMarketTradingDay(market, target)) {
      return target;
    }
  }
  return target;
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
  if (isMarketHoliday('us', date)) return 'closed';
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

/**
 * 获取指定市场的当前权威交易日（YYYY-MM-DD）。
 * 美股按纽约本地交易日历与夏/冬令时，A股与港股按北京时间交易日历；
 * 若当前为周末或休市日，平滑回溯至最近一个已结算的有效交易日。
 */
function getMarketTradingDay(market = 'domestic', date = new Date()) {
  const m = market === 'hk' ? 'hk' : (market === 'us' ? 'us' : 'domestic');
  if (isMarketTradingDay(m, date)) {
    return m === 'us' ? formatUsEasternYmd(date) : formatBeijingYmd(date);
  }
  const lastDate = getLastTradingDay(m, date);
  return m === 'us' ? formatUsEasternYmd(lastDate) : formatBeijingYmd(lastDate);
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
  isMarketHoliday,
  isMarketTradingDay,
  getLastTradingDay,
  getMarketTradingDay,
};
