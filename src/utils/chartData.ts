/**
 * Chart data assembly — real historical NAV from the backend, plus
 * intra-day interpolation anchored on today's estimated NAV.
 *
 * 场外公募基金每个交易日只有 1 个官方净值，没有分时 K 线：
 *   - 1D / 1W / 1M → 真实日净值（来自天天基金 Lsjz 接口）
 *   - 分时（intraday）→ 起点=昨日真实 dwjz，终点=今日 gsz（实时估算），
 *                       两者之间用等时间间隔直线相连（仅反映累计涨跌，
 *                       不伪造随机游走），并标注为"估算"
 *
 * 走势图的时段按 `market` 切换（决定曲线起止时间），X 轴标签**统一用北京时间**。
 *   - A 股：09:30 - 15:00（北京时间）
 *   - 港股：09:30 - 16:00（北京时间）
 *   - 美股：21:30 - 04:00 次日（北京时间；对应美东 09:30 - 16:00）
 */

import type { FundHistoryPoint } from '../services/api';
import { detectFundMarket, type FundMarket } from './fundMarket';
import { beijingWallTimeToTimestamp, getBeijingParts as getSharedBeijingParts, isUsEasternDst } from './time';
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
  /** 10 周期简单移动平均（来自后端历史净值接口）。分时图不设此字段 */
  ma10?: number | null;
  /** 累计成交量（手/股，A 股单位"手"=100股；港美股单位"股"）。仅股票分时图有 */
  volume?: number;
  /** 累计成交额（元）。仅股票分时图有 */
  turnover?: number;
}

export type DataSource = 'real' | 'estimated' | 'mixed';

export interface ChartSeries {
  points: ChartPoint[];
  source: DataSource;
  note?: string;
  /** Market this series represents (for X-axis label formatting) */
  market?: FundMarket;
  /**
   * True when today's session has not opened yet. During pre-market
   * the series is a flat baseline at `previous` (no interpolation),
   * because today's gsz is not yet distinguishable from yesterday's dwjz.
   * Callers may use this flag to suppress animations, badges, or claims
   * that "today's data is present."
   */
  preMarket?: boolean;
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

/**
 * 场外基金分时专用：无真实分钟 K 线，用真实锚点（昨收/今开 → 当前实时估值）
 * 生成等时间间隔的直线。不做随机游走插值——中间值只有线性趋势，
 * 避免把伪造的随机抖动误读为真实盘中走势。
 */
function buildFundIntradayLine(
  startValue: number,
  endValue: number,
  startTs: number,
  endTs: number
): ChartPoint[] {
  const minutes = Math.max(2, Math.round((endTs - startTs) / 60_000));
  const n = Math.min(minutes, 480);
  const pts: ChartPoint[] = [];
  for (let i = 0; i < n; i++) {
    const ratio = i / (n - 1);
    pts.push({
      t: startTs + ratio * (endTs - startTs),
      v: startValue + (endValue - startValue) * ratio,
      real: i === 0,
    });
  }
  // 起点为真实昨收/今开；终点为当前实时估值（real:false → 触发右侧脉冲动画）
  pts[0] = { t: startTs, v: startValue, real: true };
  pts[pts.length - 1] = { t: endTs, v: endValue, real: false };
  return pts;
}

/**
 * 股票分时专用插值：基于今开/最高/最低的真实区间生成有"涨跌走势"的曲线。
 *
 * 与 interpolate 的区别：
 *   1. 不强制端点对齐 linear trend，避免新股首日那种 8.66 → 50.97 的"直线起飞"
 *   2. 波动幅度按 (high − low) 缩放，能填满真实的盘中区间
 *   3. 随机漫步被 clamp 在 [low, high] 之间，保证不会画出无意义的越界
 *
 * 用于 A 股/港股/美股个股的分时图（kind === 'stock' 且 open/high/low 已知）。
 */
function interpolateStockIntraday(
  open: number,
  current: number,
  high: number,
  low: number,
  steps: number,
  rand: () => number
): number[] {
  const series: number[] = new Array(steps);
  // 真实区间下限取 min(low, open, current)，上限取 max(high, open, current)
  const lo = Math.min(low, open, current);
  const hi = Math.max(high, open, current);
  const span = hi - lo;
  // 波动率按区间宽度归一化：让 walk 自然在 [low, high] 区间内飘动
  // 经验值：每步 shock 约 ±(span * 0.08)，配合 weak drift 就能看到明显涨跌
  const jitterScale = span * 0.08;
  const revertRate = 0.08; // 弱回拉，留出更大的随机空间

  // 起点终点：open → current（线性基线）
  series[0] = open;
  for (let i = 1; i < steps - 1; i++) {
    const linearHere = open + (current - open) * (i / (steps - 1));
    const shock = (rand() - 0.5) * 2 * jitterScale;
    const drift = (linearHere - series[i - 1]) * revertRate;
    let v = series[i - 1] + drift + shock;
    // clamp 到真实区间，保证高/低不被穿越
    if (v < lo) v = lo + (lo - v) * 0.3; // 撞下沿时反弹一点
    if (v > hi) v = hi - (v - hi) * 0.3;
    series[i] = v;
  }
  series[0] = open;
  series[steps - 1] = current;
  return series;
}

/** Convert YYYY-MM-DD to Unix ms at local midnight. */
function dateToTs(date: string): number {
  const parts = date.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

/** Get the intraday window in Beijing time (startTs, endTs) for the given market. */
function getIntradayWindow(
  market: FundMarket,
  now: number
): { startTs: number; endTs: number; xLabelMode: 'local' | 'ny'; preMarket: boolean } {
  const d = new Date(now);
  const bjt = getSharedBeijingParts(d);
  const year = Number(bjt.year);
  const month = Number(bjt.month) - 1;
  const day = Number(bjt.day);
  const weekday = bjt.weekday; // 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
  const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
  const today = (y: number, m: number, date: number, h: number, min: number) =>
    beijingWallTimeToTimestamp(y, m, date, h, min);
  const DAY = 24 * 3600 * 1000;

  if (market === 'us') {
    // US session 跨日：今天 21:30 → 明天 04:00（夏令）/ 05:00（冬令）
    const dst = isUsEasternDst(d);
    const startH = dst ? 21 : 22;
    const startM = 30;
    const closeH = dst ? 4 : 5;
    const preH = dst ? 16 : 17; // 盘前 Pre-Market 起始时间：16:00（夏令）/ 17:00（冬令）

    const todayStart = today(year, month, day, startH, startM);
    const todayClose = today(year, month, day, closeH, 0);
    const preMarketStart = today(year, month, day, preH, 0);

    let startTs: number;
    let endTs: number;
    let preMarket = false;

    if (weekday === 'Sat') {
      if (now < todayClose) {
        // 周六凌晨 00:00–04:00：周五夜间 US session 正在进行收尾
        startTs = todayStart - DAY;
        endTs = Math.min(now, todayClose);
        preMarket = false;
      } else {
        // 周六 04:00 之后（已收盘）：展示周五 21:30 → 周六 04:00 的完整走势
        startTs = todayStart - DAY;
        endTs = todayClose;
        preMarket = false;
      }
    } else if (weekday === 'Sun') {
      // 周日全天：展示周五 21:30 → 周六 04:00 的完整走势
      startTs = todayStart - 2 * DAY;
      endTs = todayClose - DAY;
      preMarket = false;
    } else if (weekday === 'Mon') {
      if (now < todayClose) {
        // 周一凌晨 00:00–04:00：周日无常规盘，展示上周五走势
        startTs = todayStart - 3 * DAY;
        endTs = todayClose - 2 * DAY;
        preMarket = false;
      } else if (now < preMarketStart) {
        // 周一白天 04:00–16:00：展示上周五完整走势
        startTs = todayStart - 3 * DAY;
        endTs = todayClose - 2 * DAY;
        preMarket = false;
      } else if (now < todayStart) {
        // 周一下午 16:00–21:30：进入美股【盘前倒计时】阶段
        startTs = todayStart;
        endTs = todayStart + (closeH + 24 - startH) * 3600 * 1000;
        preMarket = true;
      } else {
        // 周一 21:30–24:00：周一常规交易进行中
        startTs = todayStart;
        endTs = now;
        preMarket = false;
      }
    } else {
      // 周二至周五常规工作日
      if (now < todayClose) {
        // 凌晨 00:00–04:00：昨夜 21:30 开始的 session 进行中
        startTs = todayStart - DAY;
        endTs = Math.min(now, todayClose);
        preMarket = false;
      } else if (now < preMarketStart) {
        // 白天 04:00–16:00：展示昨夜完整走势
        startTs = todayStart - DAY;
        endTs = todayClose;
        preMarket = false;
      } else if (now < todayStart) {
        // 下午 16:00–21:30：进入当晚美股【盘前倒计时】阶段
        startTs = todayStart;
        endTs = todayStart + (closeH + 24 - startH) * 3600 * 1000;
        preMarket = true;
      } else {
        // 当晚 21:30–24:00：今夜 session 进行中
        startTs = todayStart;
        endTs = now;
        preMarket = false;
      }
    }

    return { startTs, endTs, xLabelMode: 'ny', preMarket };
  }

  if (market === 'hk') {
    const preStartTs = today(year, month, day, 9, 0); // 港股开市前时段 09:00
    const startTs = today(year, month, day, 9, 30);
    const endTs = today(year, month, day, 16, 0);

    // 确定是否处于开市前倒计时 (09:00 - 09:30 工作日)
    const preMarket = isWeekday && now >= preStartTs && now < startTs;

    if (preMarket) {
      return { startTs, endTs, xLabelMode: 'local', preMarket: true };
    }

    // 若处于非交易时段（周末或早晨 09:00 之前），回溯到最近一个交易日（周五或昨天）的走势窗口
    if (!isWeekday || now < preStartTs) {
      let offsetDays = 1;
      if (weekday === 'Sat') offsetDays = 1;
      else if (weekday === 'Sun') offsetDays = 2;
      else if (weekday === 'Mon') offsetDays = 3;
      else offsetDays = 1; // 周二至周五早晨 09:00 前回溯到昨天

      const tradeDayTs = now - offsetDays * DAY;
      const tradeParts = getSharedBeijingParts(new Date(tradeDayTs));
      const tY = Number(tradeParts.year);
      const tM = Number(tradeParts.month) - 1;
      const tD = Number(tradeParts.day);
      return {
        startTs: today(tY, tM, tD, 9, 30),
        endTs: today(tY, tM, tD, 16, 0),
        xLabelMode: 'local',
        preMarket: false,
      };
    }

    return { startTs, endTs, xLabelMode: 'local', preMarket: false };
  }

  // A 股 / other (国内市场 / 北交所)
  const preStartTs = today(year, month, day, 9, 15); // A 股集合竞价 09:15
  const startTs = today(year, month, day, 9, 30);
  const endTs = today(year, month, day, 15, 0);

  // 确定是否处于盘前倒计时 (09:15 - 09:30 工作日)
  const preMarket = isWeekday && now >= preStartTs && now < startTs;

  if (preMarket) {
    return { startTs, endTs, xLabelMode: 'local', preMarket: true };
  }

  // 若处于非交易时段（周末或早晨 09:15 之前），回溯到最近一个有效交易日（周五或昨天）的时段窗口
  if (!isWeekday || now < preStartTs) {
    let offsetDays = 1;
    if (weekday === 'Sat') offsetDays = 1;
    else if (weekday === 'Sun') offsetDays = 2;
    else if (weekday === 'Mon') offsetDays = 3;
    else offsetDays = 1; // 周二至周五早晨 09:15 前回溯到昨天

    const tradeDayTs = now - offsetDays * DAY;
    const tradeParts = getSharedBeijingParts(new Date(tradeDayTs));
    const tY = Number(tradeParts.year);
    const tM = Number(tradeParts.month) - 1;
    const tD = Number(tradeParts.day);
    return {
      startTs: today(tY, tM, tD, 9, 30),
      endTs: today(tY, tM, tD, 15, 0),
      xLabelMode: 'local',
      preMarket: false,
    };
  }

  return { startTs, endTs, xLabelMode: 'local', preMarket: false };
}

/**
 * Build the chart series for the requested range, given the real history
 * (if available) and the current/previous NAV.
 *
 * @param fundName 基金名 — 用于判断市场（美股/QDII/港股/A股）
 * @param fundCode 基金代码
 */
export interface MinuteBar {
  /** Unix ms */
  t: number;
  /** 每分钟收盘价 */
  v: number;
  /** 该分钟的成交量（股） */
  volume?: number;
  /** 该分钟的成交额（元） */
  turnover?: number;
}

/**
 * 来自 Sina/腾讯的真实分钟 K 线。
 * 优先用真实数据构造分时 series；缺失时 fallback 到合成插值。
 */
export interface MinuteFeed {
  bars: MinuteBar[];
}

/**
 * 过滤实时打点/分钟 K 线中由估值方法突变引起的孤立针状毛刺（Spike Outliers）
 */
function filterSpikeOutliers(points: ChartPoint[], thresholdPct = 1.5): ChartPoint[] {
  if (!points || points.length < 3) return points;
  const result: ChartPoint[] = [];
  const len = points.length;

  for (let i = 0; i < len; i++) {
    const curr = points[i];
    const prev = result.length > 0 ? result[result.length - 1] : undefined;
    let next = i < len - 1 ? points[i + 1] : undefined;

    if (prev && next) {
      let lookAheadIndex = i + 1;
      while (lookAheadIndex < len && lookAheadIndex <= i + 3) {
        const candidate = points[lookAheadIndex];
        const diffWithPrev = Math.abs((candidate.v - prev.v) / prev.v) * 100;
        if (diffWithPrev < thresholdPct) {
          next = candidate;
          break;
        }
        lookAheadIndex++;
      }

      const prevDiff = Math.abs((curr.v - prev.v) / prev.v) * 100;
      const nextDiff = next ? Math.abs((curr.v - next.v) / next.v) * 100 : 0;
      const bridgeDiff = next ? Math.abs((next.v - prev.v) / prev.v) * 100 : 0;

      if (prevDiff > thresholdPct && nextDiff > thresholdPct && bridgeDiff < thresholdPct * 1.2) {
        continue; // 过滤中间孤立针状 Spike
      }
    } else if (prev && !next) {
      // 尾部针状毛刺检测：末点相比倒数第二点发生 > 1.5% 的离群突变
      const prevDiff = Math.abs((curr.v - prev.v) / prev.v) * 100;
      if (prevDiff > thresholdPct) {
        continue; // 过滤末尾突变点
      }
    }

    result.push(curr);
  }

  return result;
}

export function buildSeries(
  code: string,
  current: number,
  previous: number,
  range: RangeKey,
  history: FundHistoryPoint[] = [],
  fundName?: string,
  fundCode?: string,
  kind?: 'fund' | 'stock',
  openPrice?: number,
  highPrice?: number,
  lowPrice?: number,
  minuteFeed?: MinuteFeed | null,
  /** Persisted market classification wins over name-based fallback. */
  marketOverride?: FundMarket
): ChartSeries {
  const market = marketOverride ?? detectFundMarket(fundName, fundCode);
  const rand = mulberry32(hashCode(code + range));
  const now = Date.now();

  // ─── 1D: last 5 trading days of real NAV + today's live tick ───
  if (range === '1D' && history.length >= 1) {
    const slice = history.slice(-5);
    const points: ChartPoint[] = slice.map(p => ({
      t: dateToTs(p.date),
      v: p.dwjz,
      ma10: typeof p.ma10 === 'number' ? p.ma10 : null,
      real: true,
    }));
    if (current > 0 && current !== previous) {
      points.push({ t: now, v: current, ma10: null, real: false });
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
      ma10: typeof p.ma10 === 'number' ? p.ma10 : null,
      real: true,
    }));
    if (current > 0 && current !== previous) {
      points.push({ t: now, v: current, ma10: null, real: false });
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
    const { startTs: rawStartTs, endTs: rawEndTs, preMarket } = win;
    let startTs = rawStartTs;
    let endTs = rawEndTs;

    // 边界处理：
    //   - 开盘前（preMarket 为 true）：今日 session 尚未开始（工作日开盘前）。
    //     用整个今日 session 窗口绘制平台线，启用盘前待开盘遮罩。
    //   - 盘中（startTs ≤ now ≤ endTs）：startTs → now + interpolate
    //   - 已收盘（now ≥ endTs 或 Weekend 休市）：完整 session + interpolate
    if (preMarket) {
      // 完整今日 session 窗口（保留 X 轴标签 09:30–15:00 等）
      endTs = rawEndTs;
    } else if (now < endTs) {
      // 盘中：终点 = now
      endTs = now;
    }
    // else: 已收盘 → endTs 保持 close

    // 极端防呆：startTs == endTs 时给 1 分钟宽度
    if (endTs <= startTs) {
      endTs = startTs + 60_000;
    }

    let points: ChartPoint[];
    let isRealSnapshot = false;
    const isStock = kind === 'stock';
    // 股票分时优先用 open 作为起点（避免发行价 8.66 那种"直线起飞"）
    // 仅当 open 合理（>0 且接近 current 量级）时才使用，否则 fallback 到 previous
    const useStockAnchor = isStock && openPrice && openPrice > 0 && current > 0
      && (Math.abs(openPrice - current) / current) < 1.5; // open 偏离 current 不超过 150%
    const startValue = useStockAnchor ? openPrice! : previous;

    if (preMarket) {
      // 平台线 — 两点首尾由 SVG 连成直线
      points = [
        { t: startTs, v: startValue, real: true },
        { t: endTs,   v: current,   real: false },
      ];
    } else {
      // 优先用真实分钟数据 / 系统采集的打点快照（Sina / 腾讯 / 后端 quote_snapshots）
      const realBars = minuteFeed?.bars || [];
      const hasRealBars = realBars.length >= 2;
      if (hasRealBars) {
        // 把真实分钟数据/打点轨迹映射到 [startTs, endTs] 窗口；当前时间之后的数据截掉
        let candidateBars = realBars.filter(b => b.t >= startTs && b.t <= endTs);
        // 如果严格按 startTs/endTs 过滤为空，但 realBars 本身是上游提供的有效最近交易日分钟数据，
        // 则以 realBars 首尾时间作为真实 session 窗口，防止因节假日或跨天偏差误杀整段真实走势
        if (candidateBars.length === 0 && realBars.length >= 2) {
          candidateBars = realBars;
          startTs = realBars[0].t;
          endTs = realBars[realBars.length - 1].t;
        }

        const filtered = candidateBars.map(b => ({
          t: b.t,
          v: b.v,
          volume: b.volume,
          turnover: b.turnover,
          real: true,
        }));
        // 如果打点首项晚于 startTs，在起点补充昨收/今开基准点
        if (filtered.length > 0 && filtered[0].t > startTs + 60_000) {
          filtered.unshift({ t: startTs, v: startValue, volume: undefined, turnover: undefined, real: true });
        }
        let rawPoints = filtered;
        if (rawPoints.length >= 2) {
          isRealSnapshot = true;
        }
        // 末尾追加"当前实时 tick"（仅在实时盘中且当前估值与末点无暴涨暴跌异动离群时追加）
        if (rawPoints.length > 0) {
          const last = rawPoints[rawPoints.length - 1];
          if (last.t < endTs && current > 0 && current !== last.v) {
            const devPct = Math.abs((current - last.v) / last.v) * 100;
            // 盘中实时更新且偏离不超过 1.5% 时追加；闭市或白天占位估值跳跃时跳过
            if (now < endTs && devPct <= 1.5) {
              rawPoints.push({ t: endTs, v: current, volume: 0, turnover: 0, real: false });
            }
          }
        }
        points = filterSpikeOutliers(rawPoints);
        // 过滤后为空（快照时间在 session 窗口外，如 QDII 基金白天估值 vs 美股夜间 session）
        // 无法重建真实走势，降级为诚实直线
        if (points.length === 0) {
          points = buildFundIntradayLine(startValue, current, startTs, endTs);
        }
      } else {
        // 无真实分钟数据时的兜底：
        //   - 股票且已知真实盘中区间 [low, high]：在区间内生成"有涨跌"的合成曲线
        //     （仅曲线形状为合成，起终点与区间边界是真实的）
        //   - 其余情况（场外基金、无盘中区间的股票）：画"昨收/今开 → 今价"的诚实直线，
        //     不做随机游走插值——场外基金没有分钟级数据，伪造的抖动会被误读为真实盘中走势
        if (useStockAnchor && highPrice && lowPrice && highPrice > lowPrice) {
          const steps = 240;
          const series = interpolateStockIntraday(startValue, current, highPrice, lowPrice, steps, rand);
          // 插值线只表达价格趋势。报价的当日累计成交量/成交额不能拆分伪装成分钟数据。
          points = series.map((v, i) => {
            const ratio = i / (steps - 1);
            return { t: startTs + ratio * (endTs - startTs), v };
          });
          if (points.length > 0) {
            points[0] = { t: startTs, v: startValue, real: true };
            points[points.length - 1] = { t: endTs, v: current, real: true };
          }
        } else {
          points = buildFundIntradayLine(startValue, current, startTs, endTs);
        }
      }
    }
    const stockSourceLabel = market === 'hk' ? '腾讯行情（备用：新浪）' : market === 'us' ? 'Yahoo Finance（备用：腾讯/新浪）' : '腾讯行情';
    const stockNote = market === 'us'
      ? `数据来源：${stockSourceLabel}。分时曲线为基于昨日收盘与今日实时报价的插值（仅供趋势参考，非真实逐笔）。时段：${formatHHMM(startTs)} - ${formatHHMM(endTs)}（北京时间，对应美股 09:30–16:00 美东时间）。`
      : `数据来源：${stockSourceLabel}。分时曲线为基于昨日收盘与今日实时报价的插值（仅供趋势参考，非真实逐笔）。`;
    const fundNote = market === 'us'
      ? `场外基金（QDII）无分时 K 线。估值来源：天天基金实时估值（备用：腾讯 Qt 代理标的加权估算）。直线连接昨日官方净值与当前实时估值，仅反映累计涨跌幅，非分钟级走势。时段：${formatHHMM(startTs)} - ${formatHHMM(endTs)}（北京时间，对应美股 09:30–16:00 美东时间）。`
      : '场外基金无分时 K 线。估值来源：天天基金实时估值接口。直线连接昨日官方净值与当前实时估值，仅反映累计涨跌幅，非分钟级走势。';

    const realNote = isStock
      ? `数据来源：上游分钟行情与实时行情采样点的合并。成交量/成交额仅在上游提供真实分钟数据时展示；实时价格采样约每 10 秒更新一次。`
      : '数据来源：后端实时估值采样点。分时走势由这些价格打点轨迹连线生成；场外基金不具备交易所分钟成交量/成交额。';

    return {
      points,
      source: isRealSnapshot ? 'real' : 'estimated',
      market,
      preMarket,
      note: preMarket
        ? `今日尚未开盘 — 平台线为昨日收盘 ¥${previous.toFixed(4)} 基准，右侧 tick 为当前估值；等待 ${formatHHMM(rawEndTs)} 开盘`
        : (isRealSnapshot ? realNote : (isStock ? stockNote : fundNote)),
    };
  }

  // Fallback
  const points: ChartPoint[] = [
    { t: now - 24 * 60 * 60 * 1000, v: previous, real: true },
    { t: now, v: current, real: true },
  ];
  return { points, source: 'estimated', market, note: '数据不足，仅展示两点' };
}

function getBeijingParts(t: number) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(t));
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

/** X 轴刻度标签：统一用北京时间 HH:MM */
export function formatTick(t: number, range: RangeKey): string {
  const m = getBeijingParts(t);
  if (range === 'intraday') {
    return `${m.hour}:${m.minute}`;
  }
  return `${parseInt(m.month, 10)}/${parseInt(m.day, 10)}`;
}

/** Tooltip：统一用北京时间 */
export function formatTooltip(t: number, range: RangeKey): string {
  const m = getBeijingParts(t);
  if (range === 'intraday') {
    return `${m.hour}:${m.minute}`;
  }
  return `${m.year}-${m.month}-${m.day}`;
}

/** 把 Unix ms 转成 "HH:MM"（北京时间） */
function formatHHMM(t: number): string {
  const m = getBeijingParts(t);
  return `${m.hour}:${m.minute}`;
}

export function changePct(current: number, previous: number) {
  if (previous <= 0) return 0;
  return ((current - previous) / previous) * 100;
}
