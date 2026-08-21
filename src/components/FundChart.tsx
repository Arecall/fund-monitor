import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import { RefreshCw, TrendingUp, TrendingDown, Minus, Database, Info, Clock } from 'lucide-react';
import {
  buildSeries,
  formatTick,
  formatTooltip,
  changePct,
  type RangeKey,
  type ChartPoint,
  type DataSource
} from '../utils/chartData';
import { detectFundMarket, isMarketOpen, type FundMarket } from '../utils/fundMarket';
import { OpenCountdown, deriveMarketStatus } from './RelativeTime';
import { useAppEnv } from '../utils/env';
import { formatVolume as fmtVol, formatTurnover as fmtTurn } from '../utils/format';
import type { FundHistoryPoint } from '../services/api';
import type { MinuteFeed } from '../utils/chartData';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'intraday', label: '分时' },
  { key: '1D',       label: '1日' },
  { key: '1W',       label: '1周' },
  { key: '1M',       label: '1月' },
];

// Apple design fluid interface springs — critically damped by default (bounce 0).
// Reserve slight overshoot only for momentum-driven interactions (hover flick).
const SPRING_TAB   = { type: 'spring' as const, bounce: 0,    duration: 0.36 };  // default UI spring (no overshoot)
const SPRING_FLIP  = { type: 'spring' as const, bounce: 0.12, duration: 0.32 };  // layoutId pill — small bounce on commit
const SPRING_DRAW  = { type: 'spring' as const, stiffness: 100, damping: 20, mass: 0.8 }; // Apple fluid stroke draw
const SPRING_FILL  = { type: 'spring' as const, stiffness: 85,  damping: 19, mass: 0.9 }; // Area sweep reveal
const SPRING_HOVER = { type: 'spring' as const, bounce: 0.15, duration: 0.22 };  // hover dot — slight overshoot OK (momentum)

interface FundChartProps {
  fundCode: string;
  fundName: string;
  current: number;            // gsz
  previous: number;           // dwjz
  /** 个股当日开盘价（用于分时图基准线）；基金无此概念 */
  openPrice?: number;
  /** 个股当日最高/最低价（让分时图 Y 轴聚焦真实盘中区间，避免被昨收/发行价挤压） */
  highPrice?: number;
  lowPrice?: number;
  /** 分钟价格序列；成交量/成交额仅在上游提供真实分钟数据时存在。 */
  minuteFeed?: MinuteFeed | null;
  /** Persisted market classification from the watchlist/API. */
  market?: FundMarket;
  kind?: 'fund' | 'stock';
  height?: number;
  /** Real daily NAV history from the backend, ascending by date */
  history?: FundHistoryPoint[];
  /** Loading state — used to disable the range tabs while history is fetching */
  historyLoading?: boolean;
  /** Optional refresh button state */
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function FundChart({
  fundCode,
  fundName,
  current,
  previous,
  openPrice,
  highPrice,
  lowPrice,
  minuteFeed,
  market,
  kind = 'fund',
  height = 280,
  history = [],
  refreshing = false,
  onRefresh
}: FundChartProps) {
  const { isDev } = useAppEnv();
  const [range, setRange] = useState<RangeKey>('intraday');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showDataNote, setShowDataNote] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const prefersReducedMotion = useReducedMotion();

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 640;
      setWidth(Math.max(280, w));
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // 10 秒定时器，用于在时间跨越 09:30/13:00 等节点时自动重算 series 状态，并随父级 10s 轮询节拍对齐刷新
  const [timeTick, setTimeTick] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTimeTick(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  // 🧪 模拟 2 分钟倒计时开盘功能
  const [mockSecLeft, setMockSecLeft] = useState<number | null>(null);
  useEffect(() => {
    if (mockSecLeft === null) return;
    if (mockSecLeft <= 0) {
      // 倒计时清零！触发模拟开盘切盘动画
      setMockSecLeft(null);
      return;
    }
    const timer = setInterval(() => {
      setMockSecLeft(s => (s !== null && s > 0 ? s - 1 : null));
    }, 1000);
    return () => clearInterval(timer);
  }, [mockSecLeft]);

  // Build the active series
  const series = useMemo(
    () => buildSeries(fundCode, current, previous, range, history, fundName, fundCode, kind, openPrice, highPrice, lowPrice, minuteFeed, market),
    [fundCode, current, previous, range, history, fundName, kind, openPrice, highPrice, lowPrice, minuteFeed, market, timeTick]
  );
  const points = series.points;

  // ─── Geometry ─────────────────────────────────────────────────────
  const padding = { top: 18, right: 52, bottom: 28, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  // Y 轴范围：
  //  - 默认以所有点的极值为画图范围。
  //  - 分时图特例：
  //      (a) 股票 + 已知今日 high/low：直接用 [low, high] 当真实盘中区间，
  //          这样无论起点（昨收/发行价）离多远都不会被挤压。
  //      (b) 否则用"除起点外"的极值，并判定起点是否远离，否则退回全范围。
  const rangeBounds = useMemo(() => {
    if (points.length === 0) {
      return { lo: 0, hi: 1 };
    }
    const allValues = points.map(p => p.v);
    const allLo = Math.min(...allValues);
    const allHi = Math.max(...allValues);
    if (range !== 'intraday' || points.length < 4) {
      return { lo: allLo, hi: allHi };
    }
    // 路径 (a)：股票 + 已知 high/low → 强制用 [low, high] 当作真实盘中区间
    if (kind === 'stock' && highPrice && lowPrice && highPrice > lowPrice) {
      const pad = (highPrice - lowPrice) * 0.04 || highPrice * 0.005;
      return { lo: lowPrice - pad, hi: highPrice + pad };
    }
    // 路径 (b)：通用 — 看起点是否远离其余点
    const first = points[0].v;
    const restLo = Math.min(...points.slice(1).map(p => p.v));
    const restHi = Math.max(...points.slice(1).map(p => p.v));
    const restSpan = restHi - restLo;
    if (restSpan <= 0) return { lo: allLo, hi: allHi };
    const deviation = Math.max(Math.abs(first - restHi), Math.abs(first - restLo));
    if (deviation / restSpan >= 1.5) {
      const pad = (restHi - restLo) * 0.04 || restHi * 0.005;
      return { lo: restLo - pad, hi: restHi + pad };
    }
    return { lo: allLo, hi: allHi };
  }, [points, range, kind, highPrice, lowPrice]);

  const minV = useMemo(() => rangeBounds.lo * 0.999, [rangeBounds]);
  const maxV = useMemo(() => rangeBounds.hi * 1.001, [rangeBounds]);
  const range_v = maxV - minV || 1;

  const x = useCallback((i: number) => {
    if (points.length <= 1) return padding.left;
    return padding.left + (i / (points.length - 1)) * innerW;
  }, [points.length, innerW, padding.left]);

  const y = useCallback((v: number) => {
    return padding.top + (1 - (v - minV) / range_v) * innerH;
  }, [minV, range_v, innerH, padding.top]);

  const linePath = useMemo(() => {
    return points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(p.v).toFixed(2)}`)
      .join(' ');
  }, [points, x, y]);

  // Catmull-Rom 样条曲线：把折线（多段直线）转成平滑曲线，消除锯齿。
  // 仅 3+ 点时有效，否则退化为单段直线。
  const smoothLinePath = useMemo(() => {
    if (points.length < 2) return '';
    if (points.length === 2) return linePath;
    const pts = points.map((p, i) => ({ x: x(i), y: y(p.v) }));
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      // Catmull-Rom → Cubic Bezier 转换（tension = 0.5 / 6）
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return d;
  }, [points, x, y, linePath]);

  const areaPath = useMemo(() => {
    if (points.length === 0) return '';
    const first = `M ${x(0).toFixed(2)} ${(padding.top + innerH).toFixed(2)}`;
    // 顶部跟随平滑曲线（去掉 smoothLinePath 开头的 M 换成 L）
    const top = smoothLinePath.replace(/^M /, 'L ');
    const last = `L ${x(points.length - 1).toFixed(2)} ${(padding.top + innerH).toFixed(2)} Z`;
    return `${first} ${top} ${last}`;
  }, [points, x, smoothLinePath, padding.top, innerH]);

  // 均价折线：有真实分钟成交量时使用 VWAP；A 股缺少成交量时以累计简单均价补全，
  // 并以虚线和 Tooltip 标识为“估算均价”，避免与真实成交量加权均价混淆。
  const vwapSeries = useMemo(() => {
    if ((range !== 'intraday' && range !== '1D') || points.length < 2) {
      return { path: '', last: 0, perPoint: [] as number[], estimated: false };
    }

    const hasVol = points.some(p => typeof p.volume === 'number' && p.volume > 0);
    const averages: number[] = new Array(points.length);
    let weightedSum = 0;
    let volumeSum = 0;
    let priceSum = 0;

    for (let i = 0; i < points.length; i++) {
      if (hasVol) {
        const volume = points[i].volume || 1;
        weightedSum += points[i].v * volume;
        volumeSum += volume;
        averages[i] = volumeSum > 0 ? weightedSum / volumeSum : points[i].v;
      } else {
        priceSum += points[i].v;
        averages[i] = priceSum / (i + 1);
      }
    }

    const pts = points.map((_p, i) => ({ x: x(i), y: y(averages[i]) }));
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return {
      path: d,
      last: averages[averages.length - 1],
      perPoint: averages,
      estimated: !hasVol,
    };
  }, [points, range, x, y]);

  // MA10 均价线（10 周期简单移动平均）
  // 周 ('1W') / 月 ('1M') 维度使用 MA10 均线；分时 ('intraday') 和 1日 ('1D') 维度使用 VWAP。
  // 若某点缺乏后端 ma10 字段或最后一个点为当日实时 tick，则根据已知价格实时补算 MA10。
  const maSeries = useMemo(() => {
    if (range === 'intraday' || range === '1D' || points.length < 2) {
      return { path: '', last: 0, perPoint: [] as number[] };
    }

    const vwaps: number[] = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (typeof p.ma10 === 'number' && p.ma10 > 0) {
        vwaps[i] = p.ma10;
      } else {
        // 取当前点及之前最多 10 个点的均值
        const start = Math.max(0, i - 9);
        const sub = points.slice(start, i + 1);
        const sum = sub.reduce((acc, item) => acc + item.v, 0);
        vwaps[i] = sum / sub.length;
      }
    }

    const pts = points.map((_p, i) => ({ x: x(i), y: y(vwaps[i]) }));
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return { path: d, last: vwaps[vwaps.length - 1], perPoint: vwaps };
  }, [points, range, x, y]);

  // 判断当下时刻该资产所在市场是否开盘及当前市场阶段（美股夜盘/盘前/盘中等）
  const fundMarket = useMemo(() => market ?? detectFundMarket(fundName, fundCode), [market, fundName, fundCode]);
  const isCurrentlyOpen = useMemo(() => isMarketOpen(fundMarket), [fundMarket]);
  const lastPointTime = points.length > 0 ? points[points.length - 1].t : Date.now();
  const marketStatus = useMemo(
    () => deriveMarketStatus(lastPointTime, timeTick, fundMarket),
    [lastPointTime, timeTick, fundMarket]
  );

  // ─── Y-axis ticks ────────────────────────────────────────────────
  const yTicks = useMemo(() => {
    const step = range_v / 4;
    return [maxV, maxV - step, maxV - 2 * step, maxV - 3 * step, minV].map(v => ({
      v,
      y: y(v),
    }));
  }, [maxV, minV, range_v, y]);

  // ─── X-axis ticks ────────────────────────────────────────────────
  const xTicks = useMemo(() => {
    if (points.length < 2) return [];
    if (range === 'intraday') {
      const midIdx = Math.floor((points.length - 1) / 2);
      const lastIdx = points.length - 1;
      return [
        { idx: 0, label: formatTick(points[0].t, range) },
        { idx: midIdx, label: formatTick(points[midIdx].t, range) },
        { idx: lastIdx, label: formatTick(points[lastIdx].t, range) },
      ];
    }
    const N = 5;
    const out: { idx: number; label: string }[] = [];
    for (let i = 0; i < N; i++) {
      const idx = Math.round((i / (N - 1)) * (points.length - 1));
      out.push({ idx, label: formatTick(points[idx].t, range) });
    }
    return out;
  }, [points, range]);

  // ─── Hover ───────────────────────────────────────────────────────
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (points.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < padding.left || px > padding.left + innerW) {
      setHoverIdx(null);
      return;
    }
    const ratio = (px - padding.left) / innerW;
    const idx = Math.round(ratio * (points.length - 1));
    setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
  };
  const onLeave = () => setHoverIdx(null);

  // ─── Derived metrics for the tooltip & header ────────────────────
  const lastPoint = points[points.length - 1];
  const firstPoint = points[0];

  // 基准参考线取值：
  //   - 股票 / 基金分时图（range === 'intraday'）与全盘涨跌幅：基准统一为上一交易日收盘价 (previous)。
  //   - 如果 previous 无效（<= 0），退化为 firstPoint.v。
  const baselineValue = previous > 0 ? previous : (firstPoint?.v || 0);
  const baselineLabel = '昨收';

  const changeAmt = lastPoint ? lastPoint.v - baselineValue : 0;
  const changePercent = lastPoint && baselineValue > 0 ? changePct(lastPoint.v, baselineValue) : 0;
  const isUp = changeAmt > 0;
  const isDown = changeAmt < 0;
  const colorVar = isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : 'var(--color-flat)';
  const colorId = isUp ? 'gUp' : isDown ? 'gDown' : 'gFlat';

  // Hover point value
  const hoverPoint: ChartPoint | null = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverChangeAmt = hoverPoint ? hoverPoint.v - baselineValue : 0;
  const hoverChangePct = hoverPoint && baselineValue > 0 ? changePct(hoverPoint.v, baselineValue) : 0;
  const hoverX = hoverIdx !== null ? x(hoverIdx) : 0;
  const hoverY = hoverPoint ? y(hoverPoint.v) : 0;
  // hover 处的均价：来自 vwapSeries.perPoint（缺 VWAP 时 undefined → 不显示均价行）
  const hoverVwap = hoverIdx !== null && vwapSeries.perPoint.length === points.length
    ? vwapSeries.perPoint[hoverIdx]
    : undefined;
  // hover 处的 MA10：仅 1W/1M 有意义，分时/1日为 undefined
  const hoverMa10 = hoverIdx !== null && (range === '1W' || range === '1M') && maSeries.perPoint.length === points.length
    ? maSeries.perPoint[hoverIdx]
    : undefined;

  // Auto-refresh indicator (the chart pulses subtly when refreshing)
  useEffect(() => {
    if (!refreshing) return;
  }, [refreshing]);

  // 数据日期徽章 — 跟曲线数据所属日期，便于一眼看出"今天 vs 昨天"
  // 盘前不展示：平台线右端点落在今日收盘时刻，会被误读为"今日"。
  // 提前 memoize，避免每次 render 重新分配 Date 对象和字符串
  const dataDateBadge = useMemo(() => {
    if (series.points.length === 0 || series.preMarket) return null;
    const lastTs = series.points[series.points.length - 1].t;
    const today = new Date();
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const sameDay = lastTs >= dayStart && lastTs < dayEnd;
    const d = new Date(lastTs);
    const dataStr = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    return { sameDay, dataStr };
  }, [series.points, series.preMarket]);

  // 是否在盘前等待阶段（处于开盘前的 preMarket 状态且未开盘时启用待开盘遮罩）
  const isPreMarketState = mockSecLeft !== null
    ? mockSecLeft > 0
    : (!isCurrentlyOpen && range === 'intraday' && series.preMarket);
  const showLines = !isPreMarketState;

  // 动态 Key 用于在切换基金或时间范围时触发首次加载物理过渡动画（后续数据刷新不重播）
  const animKey = `${fundCode}-${range}`;

  // ─── Smart Tooltip Positioning (侧边避让，避免遮挡 hover 焦点) ───
  const tooltipWidth = 156;
  const tooltipHeight = 110;
  const isRightSide = hoverX > width / 2;
  const tooltipLeft = isRightSide
    ? Math.max(padding.left + 4, hoverX - tooltipWidth - 14)
    : Math.min(width - padding.right - tooltipWidth - 4, hoverX + 14);
  const tooltipTop = Math.max(
    padding.top + 4,
    Math.min(height - padding.bottom - tooltipHeight - 4, hoverY - tooltipHeight / 2)
  );

  return (
    <div className="w-full" ref={containerRef}>
      {/* Header row */}
      {/* 行1：标题 + 数据源 + 日期 badge — 移动端窄屏会自动收缩 */}
      <div className="flex items-center justify-between gap-2 mb-1.5 px-1 min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200 min-w-0 flex-1">
          <span className="shrink-0">分时走势</span>
          <DataSourceBadge source={series.source} onInfo={() => setShowDataNote(v => !v)} />
          {isPreMarketState && (
            <span
              title={series.note}
              className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200/70 dark:border-blue-800/50 whitespace-nowrap shrink-0 shadow-sm"
            >
              <Clock size={10} className="text-blue-500 animate-pulse" />
              <span className="opacity-90">{marketStatus.label} · </span>
              <OpenCountdown market={fundMarket} showTargetTime={true} />
            </span>
          )}
        </div>
        {dataDateBadge && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap shrink-0 ${
            dataDateBadge.sameDay
              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
          }`}>
            {dataDateBadge.sameDay ? `今日 ${dataDateBadge.dataStr}` : `数据 ${dataDateBadge.dataStr}`}
          </span>
        )}
      </div>
      {/* 行2：刷新状态 + 手动刷新按钮 */}
      <div className="flex items-center justify-between gap-2 mb-3 px-1">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-500 whitespace-nowrap min-w-0">
          <motion.span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              refreshing
                ? 'bg-blue-500'
                : isCurrentlyOpen
                ? 'bg-emerald-500'
                : 'bg-slate-400 dark:bg-slate-500'
            }`}
            animate={prefersReducedMotion || (!refreshing && !isCurrentlyOpen) ? { opacity: 1 } : { opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          />
          <span className="truncate">
            {refreshing
              ? `刷新中…`
              : isCurrentlyOpen
              ? `自动刷新 · ${formatTick(lastPointTime, range)}`
              : isPreMarketState
              ? `${marketStatus.label} · 上次收盘 ${formatTick(lastPointTime, range)}`
              : `已休市 · ${formatTick(lastPointTime, range)}`}
          </span>
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {isDev && (
            <PressableButton
              onClick={() => setMockSecLeft(60)}
              disabled={mockSecLeft !== null}
              title="模拟测试盘前 1 分钟倒计时清零开盘动画（开发环境专属）"
              className="text-[10px] font-bold bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-200/70 dark:border-blue-800/50 px-2.5 py-1 rounded-full flex items-center gap-1 whitespace-nowrap hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 shrink-0"
            >
              <Clock size={11} className={mockSecLeft !== null ? 'animate-spin' : ''} />
              {mockSecLeft !== null ? `倒计时 ${mockSecLeft}s` : '🧪 模拟 1min 开盘倒计时'}
            </PressableButton>
          )}

          <PressableButton
            onClick={() => onRefresh?.()}
            disabled={refreshing}
            className="text-[10px] font-bold bg-white/70 dark:bg-white/5 border border-[var(--hairline-border)] px-2.5 py-1 rounded-full flex items-center gap-1 whitespace-nowrap hover:bg-slate-50 dark:hover:bg-white/10 disabled:opacity-50 shrink-0"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            手动刷新
          </PressableButton>
        </div>
      </div>

      {/* Data-source note (expandable) */}
      <AnimatePresence>
        {showDataNote && series.note && (
          <motion.div
            key="data-note"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -4 }}
            transition={SPRING_TAB}
            className="overflow-hidden mb-2"
          >
            <div className="px-3 py-2 text-[11px] text-slate-600 dark:text-slate-400 bg-blue-50/60 dark:bg-blue-950/20 border border-blue-100/60 dark:border-blue-900/30 rounded-xl flex items-start gap-2">
              <Info size={12} className="mt-0.5 flex-shrink-0 text-blue-500" />
              <span>{series.note}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tab strip */}
      <div className="relative inline-flex bg-slate-100/60 dark:bg-white/5 rounded-full p-1 mb-3 ml-1">
        {RANGES.map(r => {
          const active = r.key === range;
          return (
            <PressableButton
              key={r.key}
              onClick={() => { setRange(r.key); setHoverIdx(null); }}
              className={`relative px-3.5 py-1.5 text-xs font-semibold rounded-full transition-colors ${
                active
                  ? 'text-white'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="fund-chart-tab"
                  transition={SPRING_FLIP}
                  className="absolute inset-0 rounded-full"
                  style={{ background: 'var(--primary-accent)' }}
                />
              )}
              <span className="relative z-10">{r.label}</span>
            </PressableButton>
          );
        })}
      </div>

      {/* Chart */}
      <div className="relative">
        <svg
          width={width}
          height={height}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
          className="block touch-none select-none"
        >
          <defs>
            {/* 面积渐变：顶浓底淡（上面深，下面浅） */}
            <linearGradient id="gUp" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%"   stopColor="var(--color-up)" stopOpacity="0" />
              <stop offset="25%"  stopColor="var(--color-up)" stopOpacity="0.05" />
              <stop offset="60%"  stopColor="var(--color-up)" stopOpacity="0.20" />
              <stop offset="100%" stopColor="var(--color-up)" stopOpacity="0.45" />
            </linearGradient>
            <linearGradient id="gDown" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%"   stopColor="var(--color-down)" stopOpacity="0" />
              <stop offset="25%"  stopColor="var(--color-down)" stopOpacity="0.05" />
              <stop offset="60%"  stopColor="var(--color-down)" stopOpacity="0.20" />
              <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0.45" />
            </linearGradient>
            <linearGradient id="gFlat" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%"   stopColor="var(--color-flat)" stopOpacity="0" />
              <stop offset="50%"  stopColor="var(--color-flat)" stopOpacity="0.10" />
              <stop offset="100%" stopColor="var(--color-flat)" stopOpacity="0.28" />
            </linearGradient>
            {/* 线条下方柔光（光晕） */}
            <filter id="lineGlow" x="-5%" y="-50%" width="110%" height="200%">
              <feGaussianBlur stdDeviation="2.4" />
            </filter>
          </defs>

          {/* Y-grid lines + 左轴价格标签 + 右轴 % 标签（副 Y 轴） */}
          {yTicks.map((t, i) => {
            return (
              <g key={i}>
                <line
                  x1={padding.left}
                  x2={padding.left + innerW}
                  y1={t.y}
                  y2={t.y}
                  stroke="currentColor"
                  strokeOpacity="0.06"
                  strokeDasharray={i === 0 || i === yTicks.length - 1 ? '0' : '2 3'}
                />
                {/* 左轴：价格 */}
                <text
                  x={padding.left - 8}
                  y={t.y + 3}
                  textAnchor="end"
                  fontSize="10"
                  fill="currentColor"
                  fillOpacity="0.45"
                  className="font-mono tabular-nums"
                >
                  {t.v.toFixed(range === 'intraday' ? 4 : 2)}
                </text>
                {/* 右轴：相对基准价的涨跌幅 %（与左轴价格 100% 精确映射对齐） */}
                <text
                  x={padding.left + innerW + 8}
                  y={t.y + 3}
                  textAnchor="start"
                  fontSize="10"
                  fill="currentColor"
                  fillOpacity="0.45"
                  className="font-mono tabular-nums"
                >
                  {(() => {
                    const base = baselineValue > 0 ? baselineValue : (points[0]?.v || 0);
                    if (!base || base <= 0) return '0.00%';
                    const pct = ((t.v - base) / base) * 100;
                    return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
                  })()}
                </text>
              </g>
            );
          })}

          {/* X-axis labels */}
          {xTicks.map((t, i) => (
            <text
              key={i}
              x={x(t.idx)}
              y={padding.top + innerH + 18}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
              fillOpacity="0.45"
              className="font-mono tabular-nums"
            >
              {t.label}
            </text>
          ))}

          {/* Baseline at the open price (today's open for stocks, prev close for funds) —
              clipped to chart so it doesn't draw outside when the reference value
              (prev close / IPO issue price) is far outside the actual trading range. */}
          {baselineValue >= minV && baselineValue <= maxV && (
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={y(baselineValue)}
              y2={y(baselineValue)}
              stroke="currentColor"
              strokeOpacity="0.18"
              strokeDasharray="4 4"
            />
          )}

          {/* 面积填充：从左至右横向流体揭示（Apple Fluid Sweep Reveal），跟随折线笔触展开 */}
          <defs>
            <clipPath id={`fundChartAreaReveal-${fundCode}`}>
              <motion.rect
                key={`area-reveal-${animKey}`}
                x={padding.left}
                y={padding.top}
                height={innerH}
                initial={prefersReducedMotion ? false : { width: 0 }}
                animate={{ width: innerW }}
                transition={SPRING_FILL}
              />
            </clipPath>
          </defs>
          {showLines && (
            <>
              <motion.path
                key={`area-${animKey}`}
                d={areaPath}
                fill={`url(#${colorId})`}
                clipPath={`url(#fundChartAreaReveal-${fundCode})`}
                initial={prefersReducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ type: 'spring' as const, bounce: 0, duration: 0.4 }}
              />

              {/* Line glow — 柔光层（高斯模糊）带笔触动画 */}
              <motion.path
                key={`line-glow-${animKey}`}
                d={smoothLinePath}
                fill="none"
                stroke={colorVar}
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.18"
                filter="url(#lineGlow)"
                initial={prefersReducedMotion ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ ...SPRING_DRAW, duration: 0.6 }}
              />

              {/* Line — Apple 经典的物理弹簧笔触（Path Length Sweep Draw） */}
              <motion.path
                key={`line-${animKey}`}
                d={smoothLinePath}
                fill="none"
                stroke={colorVar}
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={
                  prefersReducedMotion
                    ? false
                    : { pathLength: 0, opacity: 0.2 }
                }
                animate={{ pathLength: 1, opacity: 1 }}
                transition={SPRING_DRAW}
              />
            </>
          )}

          {/* 均价线：真实成交量时为 VWAP；缺量时以虚线展示估算均价。 */}
          {showLines && vwapSeries.path && (
            <motion.path
              key={`vwap-line-${range}`}
              d={vwapSeries.path}
              fill="none"
              stroke="#f59e0b"
              strokeWidth="1.25"
              strokeDasharray={vwapSeries.estimated ? '4 3' : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.85"
              initial={prefersReducedMotion ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.85 }}
              transition={{ ...SPRING_DRAW, delay: prefersReducedMotion ? 0 : 0.1 }}
            />
          )}

          {/* MA10 均线（橙色 10 周期简单移动平均），数据来自后端 history 接口的 ma10 字段。
              仅在 1D / 1W / 1M 区间绘制；分时图不画。前 9 个交易日 ma10=null 自动断开。 */}
          {maSeries.path && (
            <motion.path
              key={`ma10-line-${range}`}
              d={maSeries.path}
              fill="none"
              stroke="#f59e0b"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.85"
              initial={prefersReducedMotion ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.85 }}
              transition={{ ...SPRING_DRAW, delay: prefersReducedMotion ? 0 : 0.1 }}
            />
          )}

          {/* Real data points — visible dots ONLY on daily closes (1D / 1W / 1M).
              STRICTLY skipped during intraday to ensure no intermediate dots are drawn on the intraday line. */}
          {range !== 'intraday' && points.map((p, i) => {
            if (!p.real) return null;
            return (
              <motion.circle
                key={`dot-${i}`}
                cx={x(i)}
                cy={y(p.v)}
                r="3"
                fill="white"
                stroke={colorVar}
                strokeWidth="1.5"
                initial={prefersReducedMotion ? false : { scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ ...SPRING_TAB, delay: prefersReducedMotion ? 0 : 0.2 + i * 0.015 }}
                style={{ transformOrigin: `${x(i)}px ${y(p.v)}px` }}
              />
            );
          })}

          {/* Today's live tick — emphasized ring ONLY on the rightmost (latest) point during intraday. */}
          {range === 'intraday' && points.length > 0 && !isPreMarketState && (() => {
            const last = points[points.length - 1];
            const lx = x(points.length - 1);
            const ly = y(last.v);
            return (
              <motion.g
                key={`live-tick-${animKey}`}
                initial={prefersReducedMotion ? false : { scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring' as const, stiffness: 220, damping: 16, delay: prefersReducedMotion ? 0 : 0.3 }}
                style={{ transformOrigin: `${lx}px ${ly}px` }}
              >
                <motion.circle
                  cx={lx}
                  cy={ly}
                  r="6"
                  fill="none"
                  stroke={colorVar}
                  strokeWidth="1.5"
                  opacity="0.4"
                  animate={prefersReducedMotion ? undefined : { r: [6, 10, 6], opacity: [0.4, 0, 0.4] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                />
                <circle cx={lx} cy={ly} r="4" fill={colorVar} />
                <circle cx={lx} cy={ly} r="2" fill="white" />
              </motion.g>
            );
          })()}

          {/* Hover crosshair — spring entrance (interruptible, velocity-aware) */}
          <AnimatePresence>
            {hoverPoint && (
              <motion.g
                key="crosshair"
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring' as const, bounce: 0, duration: 0.18 }}
              >
                {/* 垂直虚线：贯穿整个图表 */}
                <line
                  x1={hoverX}
                  x2={hoverX}
                  y1={padding.top}
                  y2={padding.top + innerH}
                  stroke="currentColor"
                  strokeOpacity="0.18"
                  strokeDasharray="2 3"
                />
                {/* 水平虚线：贯穿左右轴 */}
                <line
                  x1={padding.left}
                  x2={padding.left + innerW}
                  y1={hoverY}
                  y2={hoverY}
                  stroke="currentColor"
                  strokeOpacity="0.18"
                  strokeDasharray="2 3"
                />
                {/* 左轴价格跟随标签（彩色色块 + 当前价格） */}
                <g>
                  <rect
                    x={padding.left - 44}
                    y={hoverY - 8}
                    width={40}
                    height={16}
                    rx={3}
                    fill={colorVar}
                  />
                  <text
                    x={padding.left - 4}
                    y={hoverY + 3.5}
                    textAnchor="end"
                    fontSize="10"
                    fontWeight="600"
                    fill="white"
                    className="font-mono tabular-nums"
                  >
                    {hoverPoint.v.toFixed(range === 'intraday' ? 4 : 2)}
                  </text>
                </g>
                {/* 右轴 % 跟随标签 */}
                {(() => {
                  const base = baselineValue > 0 ? baselineValue : (points[0]?.v || 0);
                  const pctVal = base > 0 ? ((hoverPoint.v - base) / base) * 100 : 0;
                  return (
                    <g>
                      <rect
                        x={padding.left + innerW + 4}
                        y={hoverY - 8}
                        width={44}
                        height={16}
                        rx={3}
                        fill={colorVar}
                      />
                      <text
                        x={padding.left + innerW + 8}
                        y={hoverY + 3.5}
                        textAnchor="start"
                        fontSize="10"
                        fontWeight="600"
                        fill="white"
                        className="font-mono tabular-nums"
                      >
                        {`${pctVal > 0 ? '+' : ''}${pctVal.toFixed(2)}%`}
                      </text>
                    </g>
                  );
                })()}
                {/* 顶部时间跟随标签（贴 padding.top 上沿） */}
                <g>
                  <rect
                    x={hoverX - 28}
                    y={padding.top - 8}
                    width={56}
                    height={16}
                    rx={3}
                    fill="currentColor"
                    fillOpacity="0.08"
                    stroke="currentColor"
                    strokeOpacity="0.2"
                    strokeWidth="0.5"
                  />
                  <text
                    x={hoverX}
                    y={padding.top + 3.5}
                    textAnchor="middle"
                    fontSize="9"
                    fill="currentColor"
                    fillOpacity="0.7"
                    className="font-mono tabular-nums"
                  >
                    {formatTick(hoverPoint.t, range)}
                  </text>
                </g>
                {/* 底部 X 轴时间跟随标签（贴 X 轴下沿） */}
                <g>
                  <rect
                    x={hoverX - 28}
                    y={padding.top + innerH - 8}
                    width={56}
                    height={16}
                    rx={3}
                    fill={colorVar}
                  />
                  <text
                    x={hoverX}
                    y={padding.top + innerH + 3.5}
                    textAnchor="middle"
                    fontSize="9"
                    fontWeight="600"
                    fill="white"
                    className="font-mono tabular-nums"
                  >
                    {formatTick(hoverPoint.t, range)}
                  </text>
                </g>
                {/* hover 点圆环 */}
                <motion.circle
                  cx={hoverX}
                  cy={hoverY}
                  r="5"
                  fill="white"
                  stroke={colorVar}
                  strokeWidth="2"
                  initial={prefersReducedMotion ? false : { scale: 0.6 }}
                  animate={{ scale: 1 }}
                  transition={SPRING_HOVER}
                  style={{ transformOrigin: `${hoverX}px ${hoverY}px` }}
                />
                <motion.circle
                  cx={hoverX}
                  cy={hoverY}
                  r="2.5"
                  fill={colorVar}
                />
              </motion.g>
            )}
          </AnimatePresence>
        </svg>

        {/* ── 盘前等待开盘 极简金融原生 Standby View Overlay (如图片 #8) ── */}
        {!showLines && (
          <div
            style={{
              position: 'absolute',
              left: padding.left,
              top: padding.top,
              width: innerW,
              height: innerH,
            }}
            className="flex flex-col items-center justify-center pointer-events-none z-10 select-none space-y-1"
          >
            <motion.div
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={SPRING_TAB}
              className="flex flex-col items-center justify-center space-y-1 text-center"
            >
              {/* 极简灰色圆圈时钟图标 */}
              <div className="w-11 h-11 rounded-full border-[1.75px] border-slate-300 dark:border-slate-600 flex items-center justify-center text-slate-400 dark:text-slate-400 mb-1">
                <Clock size={22} strokeWidth={1.5} />
              </div>

              {/* 美股盘前 / 待开盘 */}
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide">
                {marketStatus.label}
              </div>

              {/* 蓝色倒计时 (如 2:56) */}
              <div className="text-xl font-bold font-mono text-[#2563eb] dark:text-[#3b82f6] tabular-nums tracking-tight">
                {mockSecLeft !== null ? (
                  <span>
                    {Math.floor(mockSecLeft / 60)}:{String(mockSecLeft % 60).padStart(2, '0')}
                  </span>
                ) : (
                  <OpenCountdown market={fundMarket} rawCountdown={true} />
                )}
              </div>

              {/* 方便直接触发测试的内嵌按钮（仅开发环境专属） */}
              {isDev && (
                <button
                  type="button"
                  onClick={() => setMockSecLeft(60)}
                  disabled={mockSecLeft !== null}
                  className="pointer-events-auto mt-2 px-2.5 py-1 text-[10px] font-bold rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200/80 dark:border-blue-800/60 hover:bg-blue-100 transition-colors shadow-sm cursor-pointer disabled:opacity-50"
                >
                  {mockSecLeft !== null ? `倒计时中 (${mockSecLeft}s)` : '🧪 触发 1 分钟倒计时切盘测试'}
                </button>
              )}
            </motion.div>
          </div>
        )}

        {/* Tooltip — spring entrance, anchored to source (hover point) */}
        <AnimatePresence>
          {hoverPoint && (
            <motion.div
              key="tooltip"
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.96 }}
              transition={{ type: 'spring' as const, bounce: 0, duration: 0.24 }}
              className="pointer-events-none absolute z-10 px-3 py-2 rounded-xl bg-white/90 dark:bg-[#1d1d1f]/90 backdrop-blur-md border border-[var(--hairline-border)] shadow-lg text-[11px] min-w-[140px]"
              style={{
                left: `${tooltipLeft}px`,
                top: `${tooltipTop}px`,
              }}
            >
              <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums mb-1">
                {formatTooltip(hoverPoint.t, range)}
              </div>
              <div className="space-y-0.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--primary-accent)' }} />
                    最新净值
                  </span>
                  <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                    {hoverPoint.v.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-slate-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                    涨跌
                  </span>
                  <span
                    className="font-mono font-semibold tabular-nums"
                    style={{ color: hoverChangeAmt > 0 ? 'var(--color-up)' : hoverChangeAmt < 0 ? 'var(--color-down)' : undefined }}
                  >
                    {hoverChangeAmt > 0 ? '+' : ''}{hoverChangeAmt.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-slate-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                    涨跌幅
                  </span>
                  <span
                    className="font-mono font-semibold tabular-nums"
                    style={{ color: hoverChangePct > 0 ? 'var(--color-up)' : hoverChangePct < 0 ? 'var(--color-down)' : undefined }}
                  >
                    {hoverChangePct > 0 ? '+' : ''}{hoverChangePct.toFixed(2)}%
                  </span>
                </div>
                {hoverVwap !== undefined && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-slate-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      {vwapSeries.estimated ? '估算均价' : '均价'}
                    </span>
                    <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                      {hoverVwap.toFixed(4)}
                    </span>
                  </div>
                )}
                {hoverMa10 !== undefined && hoverMa10 !== null && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-slate-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      MA10
                    </span>
                    <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                      {hoverMa10.toFixed(4)}
                    </span>
                  </div>
                )}
                {hoverPoint.volume !== undefined && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-slate-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                      成交量
                    </span>
                    <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                      {fmtVol(hoverPoint.volume, fundMarket)}
                    </span>
                  </div>
                )}
                {hoverPoint.turnover !== undefined && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-slate-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                      成交额
                    </span>
                    <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                      {fmtTurn(hoverPoint.turnover)}
                    </span>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer — change summary for the active range */}
      <div className="mt-2 flex items-center gap-3 text-[11px] flex-wrap">
        <span className="flex items-center gap-1 font-semibold" style={{ color: colorVar }}>
          {isUp ? <TrendingUp size={12} /> : isDown ? <TrendingDown size={12} /> : <Minus size={12} />}
          {changeAmt > 0 ? '+' : ''}{changeAmt.toFixed(4)}
        </span>
        <span className="font-semibold" style={{ color: colorVar }}>
          {changePercent > 0 ? '+' : ''}{changePercent.toFixed(2)}%
        </span>
        <span className="text-slate-500">
          区间内 {points[0]?.v.toFixed(4) ?? '—'} → {lastPoint?.v.toFixed(4) ?? '—'}
          {baselineValue > 0 && (
            <span className="ml-2 text-slate-400">· {baselineLabel} {baselineValue.toFixed(4)}</span>
          )}
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────
   DataSourceBadge — surfaces the provenance of the curve so the user
   always knows whether they're looking at real NAV or an interpolation.
   ─────────────────────────────────────────────────────────────────── */

function DataSourceBadge({
  source,
  onInfo
}: {
  source: DataSource;
  onInfo: () => void;
}) {
  const map: Record<DataSource, { label: string; short: string; bg: string; text: string; ring: string }> = {
    real:      { label: '真实数据', short: '真实', bg: 'bg-emerald-50 dark:bg-emerald-950/30',     text: 'text-emerald-700 dark:text-emerald-400', ring: 'border-emerald-200/70 dark:border-emerald-800/50' },
    mixed:     { label: '混合数据', short: '混合', bg: 'bg-amber-50 dark:bg-amber-950/30',         text: 'text-amber-700 dark:text-amber-400',     ring: 'border-amber-200/70 dark:border-amber-800/50' },
    estimated: { label: '估算走势', short: '估算', bg: 'bg-slate-100 dark:bg-slate-800/50',        text: 'text-slate-600 dark:text-slate-400',    ring: 'border-slate-200/70 dark:border-slate-700/50' },
  };
  const m = map[source];
  return (
    <span
      title={m.label}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full border whitespace-nowrap shrink-0 ${m.bg} ${m.text} ${m.ring}`}
    >
      <Database size={9} />
      {/* sm+ 显示完整标签；< sm 屏幕（窄屏）只显示两字简称 */}
      <span className="hidden sm:inline">{m.label}</span>
      <span className="sm:hidden">{m.short}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onInfo(); }}
        className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
        aria-label="数据来源说明"
      >
        <Info size={10} />
      </button>
    </span>
  );
}

function usePointerDown() {
  const [pressed, setPressed] = useState(false);
  return {
    pressed,
    handlers: {
      onPointerDown: useCallback(() => setPressed(true), []),
      onPointerUp:   useCallback(() => setPressed(false), []),
      onPointerCancel: useCallback(() => setPressed(false), []),
    },
  };
}

const PressableButton = (props: HTMLMotionProps<'button'>) => {
  const { pressed, handlers } = usePointerDown();
  const prefersReducedMotion = useReducedMotion();
  const { children, className = '', disabled, type = 'button', ...rest } = props;
  return (
    <motion.button
      type={type}
      disabled={disabled}
      {...rest}
      {...handlers}
      animate={prefersReducedMotion || disabled ? undefined : { scale: pressed ? 0.94 : 1 }}
      transition={SPRING_TAB}
      className={className}
    >
      {children}
    </motion.button>
  );
};
