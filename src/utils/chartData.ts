/**
 * Chart data assembly — real historical NAV from the backend, plus
 * intra-day interpolation anchored on today's estimated NAV.
 *
 * 场外公募基金每个交易日只有 1 个官方净值，没有分时 K 线：
 *   - 1D / 1W / 1M → 真实日净值（来自天天基金 Lsjz 接口）
 *   - 分时（intraday）→ 起点=昨日真实 dwjz，终点=今日 gsz（实时估算），
 *                       中间用平滑插值生成连续曲线，并标注为"估算"
 *
 * 走势图的时段按 `market` 切换（决定曲线起止时间），X 轴标签**统一用北京时间**。
 *   - A 股：09:30 - 15:00（北京时间）
 *   - 港股：09:30 - 16:00（北京时间）
 *   - 美股：21:30 - 04:00 次日（北京时间；对应美东 09:30 - 16:00）
 */

import type { FundHistoryPoint } from '../services/api';
import { detectFundMarket, type FundMarket } from './fundMarket';
export type { FundMarket } from './fundMarket';

export type RangeKey = 'intraday' | '1D' | '1W' | '1M';

export interface ChartPoint {
  /** Unix ms timestamp */
  t: number;
  /** Net asset value at this point */
  v: number;
  /** Marker indicating whether this point is a real daily close. */
  real?: boolean;
  /** Optional display time (e.g. for US chart, use NY local time) */
  displayTime?: string;
}

export type DataSource = 'real' | 'estimated' | 'mixed';

export interface ChartSeries {
  points: ChartPoint[];
  source: DataSource;
  note?: string;
  /** Market this series represents (for X-axis label formatting) */
  market?: FundMarket;
}

/** Tiny deterministic PRNG so fallback walks look stable per fund */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Smooth interpolation between two endpoints with low-volatility mid-jitter. */
function interpolate(
  startValue: number,
  endValue: number,
  steps: number,
  volatility: number,
  rand: () => number
): number[] {
  const series: number[] = new Array(steps);
  series[0] = startValue;

  for (let i = 1; i < steps; i++) {
    const shock = (rand() - 0.5) * 2 * volatility;
    series[i] = series[i - 1] * (1 + shock);
  }

  // Bias so series[steps-1] === endValue
  const span = endValue - series[0];
  const natural = series[steps - 1] - series[0];
  if (natural === 0) {
    for (let i = 1; i < steps; i++) series[i] = series[0] + (span * i) / (steps - 1);
    return series;
  }
  const scale = span / natural;
  for (let i = 0; i < steps; i++) {
    series[i] = series[0] + (series[i] - series[0]) * scale;
  }
  return series;
}

/** Convert YYYY-MM-DD to Unix ms at local midnight. */
function dateToTs(date: string): number {
  const parts = date.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

/** Simplify US DST: March–October = summer time (NY = UTC-4), else UTC-5 */
function isUSDST(d: Date): boolean {
  const m = d.getMonth() + 1;
  return m >= 3 && m <= 10;
}

/** Get the intraday window in Beijing time (startTs, endTs) for the given market. */
function getIntradayWindow(
  market: FundMarket,
  now: number
): { startTs: number; endTs: number; xLabelMode: 'local' | 'ny' } {
  const d = new Date(now);
  const today = (y: number, m: number, day: number, h: number, min: number) =>
    new Date(y, m, day, h, min, 0, 0).getTime();

  if (market === 'us') {
    // US session 跨日：今天 21:30 → 明天 04:00（夏令）/ 05:00（冬令）
    const dst = isUSDST(d);
    const startH = dst ? 21 : 22;
    const startM = 30;
    const closeH = dst ? 4 : 5;
    const DAY = 24 * 3600 * 1000;

    const todayStart = today(d.getFullYear(), d.getMonth(), d.getDate(), startH, startM);
    const todayClose = today(d.getFullYear(), d.getMonth(), d.getDate(), closeH, 0);

    let startTs: number;
    let endTs: number;

    if (now < todayClose) {
      // 凌晨 0–close：US session 从昨天 21:30 持续到今天 close
      startTs = todayStart - DAY;
      endTs = Math.min(now, todayClose);
    } else if (now < todayStart) {
      // 白天 close–21:30：最近一个已结束 session（昨天 21:30 → 今天 close）
      startTs = todayStart - DAY;
      endTs = todayClose;
    } else {
      // 21:30–24:00：今天的 US session 正在进行
      startTs = todayStart;
      endTs = now;
    }

    return { startTs, endTs, xLabelMode: 'ny' };
  }
  if (market === 'hk') {
    const startTs = today(d.getFullYear(), d.getMonth(), d.getDate(), 9, 30);
    const endTs = today(d.getFullYear(), d.getMonth(), d.getDate(), 16, 0);
    return { startTs, endTs, xLabelMode: 'local' };
  }
  // A 股 / other
  const startTs = today(d.getFullYear(), d.getMonth(), d.getDate(), 9, 30);
  const endTs = today(d.getFullYear(), d.getMonth(), d.getDate(), 15, 0);
  return { startTs, endTs, xLabelMode: 'local' };
}

/**
 * Build the chart series for the requested range, given the real history
 * (if available) and the current/previous NAV.
 *
 * @param fundName 基金名 — 用于判断市场（美股/QDII/港股/A股）
 * @param fundCode 基金代码
 */
export function buildSeries(
  code: string,
  current: number,
  previous: number,
  range: RangeKey,
  history: FundHistoryPoint[] = [],
  fundName?: string,
  fundCode?: string
): ChartSeries {
  const market = detectFundMarket(fundName, fundCode);
  const rand = mulberry32(hashCode(code + range));
  const now = Date.now();

  // ─── 1D: last 5 trading days of real NAV + today's live tick ───
  if (range === '1D' && history.length >= 1) {
    const slice = history.slice(-5);
    const points: ChartPoint[] = slice.map(p => ({
      t: dateToTs(p.date),
      v: p.dwjz,
      real: true,
    }));
    if (current > 0 && current !== previous) {
      points.push({ t: now, v: current, real: false });
    }
    return {
      points,
      source: 'real',
      market,
      note: '数据来源：东方财富历史单位净值（每个交易日 1 个收盘点）+ 当日实时估值',
    };
  }

  // ─── 1W / 1M: real daily NAV ─────────────────────────────────
  if ((range === '1W' || range === '1M') && history.length >= 2) {
    const slice = range === '1W' ? history.slice(-7) : history.slice(-30);
    const points: ChartPoint[] = slice.map(p => ({
      t: dateToTs(p.date),
      v: p.dwjz,
      real: true,
    }));
    if (current > 0 && current !== previous) {
      points.push({ t: now, v: current, real: false });
    }
    return {
      points,
      source: 'real',
      market,
      note: '数据来源：东方财富历史单位净值（每个交易日 1 个收盘点）+ 当日实时估值',
    };
  }

  // ─── intraday: 按市场时段的插值曲线（X 轴统一北京时间）────
  if (range === 'intraday') {
    const win = getIntradayWindow(market, now);
    let { startTs, endTs } = win;

    // 极端防呆：startTs == endTs 时给 1 分钟宽度
    if (endTs <= startTs) {
      endTs = startTs + 60_000;
    }

    const steps = 240;
    const series = interpolate(previous, current, steps, 0.0006, rand);
    // X 轴统一用北京时间：data point 不再带 displayTime，让 formatTick 直接用 t
    const points: ChartPoint[] = series.map((v, i) => {
      const t = startTs + (i / (steps - 1)) * (endTs - startTs);
      return { t, v };
    });
    if (points.length > 0) {
      points[0] = { t: startTs, v: previous, real: true };
      points[points.length - 1] = { t: endTs, v: current, real: true };
    }
    return {
      points,
      source: 'estimated',
      market,
      note: market === 'us'
        ? `场外基金无分时 K 线，曲线为基于昨日收盘与今日实时估值的插值（仅供趋势参考）。时段：${formatHHMM(startTs)} - ${formatHHMM(endTs)}（北京时间，对应美股 09:30 - 16:00 美东时间）。`
        : '场外基金无分时 K 线，曲线为基于昨日收盘与今日实时估值的插值（仅供趋势参考）',
    };
  }

  // Fallback
  const points: ChartPoint[] = [
    { t: now - 24 * 60 * 60 * 1000, v: previous, real: true },
    { t: now, v: current, real: true },
  ];
  return { points, source: 'estimated', market, note: '数据不足，仅展示两点' };
}

/** X-axis tick label — 统一用北京时间 HH:MM */
export function formatTick(t: number, range: RangeKey): string {
  if (range === 'intraday') {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}`;
}

/** Tooltip — intraday 显示 HH:MM（北京时间），其他显示 YYYY-MM-DD */
export function formatTooltip(t: number, range: RangeKey): string {
  const d = new Date(t);
  if (range === 'intraday') {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 把 Unix ms 转成 "HH:MM"（北京时间） */
function formatHHMM(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function changePct(current: number, previous: number) {
  if (previous <= 0) return 0;
  return ((current - previous) / previous) * 100;
}
