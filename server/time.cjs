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

function parseBeijingDateTime(value) {
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

  const timestamp = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const p = getTimeZoneParts(new Date(timestamp), BEIJING_TIME_ZONE);
  return Number(p.year) === year && Number(p.month) === month && Number(p.day) === day &&
    Number(p.hour) === hour && Number(p.minute) === minute ? timestamp : null;
}

module.exports = {
  BEIJING_TIME_ZONE,
  formatBeijingYmd,
  formatBeijingYmdHm,
  getTimeZoneParts,
  isUsEasternDst,
  parseBeijingDateTime,
};
