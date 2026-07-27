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
import { detectFundMarket, isMarketOpen } from '../utils/fundMarket';
import type { FundHistoryPoint } from '../services/api';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'intraday', label: '分时' },
  { key: '1D',       label: '1日' },
  { key: '1W',       label: '1周' },
  { key: '1M',       label: '1月' },
];

// Apple design fluid interface springs — critically damped by default (bounce 0).
// Reserve slight overshoot only for momentum-driven interactions (hover flick).
const SPRING_TAB  = { type: 'spring' as const, bounce: 0,    duration: 0.36 };  // default UI spring (no overshoot)
const SPRING_FLIP = { type: 'spring' as const, bounce: 0.12, duration: 0.32 };  // layoutId pill — small bounce on commit
const SPRING_DRAW = { type: 'spring' as const, bounce: 0,    duration: 0.55 };  // line path draw
const SPRING_FILL = { type: 'spring' as const, bounce: 0,    duration: 0.6  };  // area mask-reveal (slightly slower than line)
const SPRING_HOVER= { type: 'spring' as const, bounce: 0.15, duration: 0.22 };  // hover dot — slight overshoot OK (momentum)

interface FundChartProps {
  fundCode: string;
  fundName: string;
  current: number;            // gsz
  previous: number;           // dwjz
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
  kind = 'fund',
  height = 280,
  history = [],
  refreshing = false,
  onRefresh
}: FundChartProps) {
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

  // Build the active series
  const series = useMemo(
    () => buildSeries(fundCode, current, previous, range, history, fundName, fundCode, kind),
    [fundCode, current, previous, range, history, fundName, kind]
  );
  const points = series.points;

  // ─── Geometry ─────────────────────────────────────────────────────
  const padding = { top: 18, right: 16, bottom: 28, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  // Y 轴范围：
  //  - 默认以所有点的极值为画图范围。
  //  - 分时图特例：如果起点（昨收/发行价）与其余点的偏离极大
  //    （例如 A 股新股上市首日：发行价 8.66，开盘 49.50，区间 38–55），
  //    那么把发行价算进 minV 会让真实波动区间被严重挤压。
  //    这时把 Y 轴范围聚焦在"盘中真实成交区间"（除起点外的极值），
  //    让红绿分时曲线饱满地铺满整个图表。
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
    const first = points[0].v;
    const restLo = Math.min(...points.slice(1).map(p => p.v));
    const restHi = Math.max(...points.slice(1).map(p => p.v));
    const restSpan = restHi - restLo;
    // 偏离判定：起点与其余点极值的相对距离超过 1.5 倍盘中波动
    if (restSpan <= 0) return { lo: allLo, hi: allHi };
    const deviation = Math.max(Math.abs(first - restHi), Math.abs(first - restLo));
    if (deviation / restSpan >= 1.5) {
      // 真实波动区间带 4% padding
      const pad = (restHi - restLo) * 0.04 || restHi * 0.005;
      return { lo: restLo - pad, hi: restHi + pad };
    }
    return { lo: allLo, hi: allHi };
  }, [points, range]);

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

  const areaPath = useMemo(() => {
    if (points.length === 0) return '';
    const first = `M ${x(0).toFixed(2)} ${(padding.top + innerH).toFixed(2)}`;
    const top = points
      .map((p, i) => `L ${x(i).toFixed(2)} ${y(p.v).toFixed(2)}`)
      .join(' ');
    const last = `L ${x(points.length - 1).toFixed(2)} ${(padding.top + innerH).toFixed(2)} Z`;
    return `${first} ${top} ${last}`;
  }, [points, x, y, padding.top, innerH]);

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
  const changeAmt = lastPoint.v - firstPoint.v;
  const changePercent = changePct(lastPoint.v, firstPoint.v);
  const isUp = changeAmt > 0;
  const isDown = changeAmt < 0;
  const colorVar = isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : 'var(--color-flat)';
  const colorId = isUp ? 'gUp' : isDown ? 'gDown' : 'gFlat';

  // Hover point value
  const hoverPoint: ChartPoint | null = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverChangeAmt = hoverPoint ? hoverPoint.v - firstPoint.v : 0;
  const hoverChangePct = hoverPoint ? changePct(hoverPoint.v, firstPoint.v) : 0;
  const hoverX = hoverIdx !== null ? x(hoverIdx) : 0;
  const hoverY = hoverPoint ? y(hoverPoint.v) : 0;

  // Auto-refresh indicator (the chart pulses subtly when refreshing)
  useEffect(() => {
    if (!refreshing) return;
  }, [refreshing]);

  // 判断当下时刻该资产所在市场是否开盘
  const fundMarket = useMemo(() => detectFundMarket(fundName, fundCode), [fundName, fundCode]);
  const isCurrentlyOpen = useMemo(() => isMarketOpen(fundMarket), [fundMarket]);
  const lastPointTime = points.length > 0 ? points[points.length - 1].t : Date.now();

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

  return (
    <div className="w-full" ref={containerRef}>
      {/* Header row */}
      {/* 行1：标题 + 数据源 + 日期 badge — 移动端窄屏会自动收缩 */}
      <div className="flex items-center justify-between gap-2 mb-1.5 px-1 min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200 min-w-0 flex-1">
          <span className="shrink-0">分时走势</span>
          <DataSourceBadge source={series.source} onInfo={() => setShowDataNote(v => !v)} />
          {range === 'intraday' && series.preMarket && (
            <span
              title={series.note}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border border-blue-200/70 dark:border-blue-800/50 whitespace-nowrap shrink-0"
            >
              <Clock size={9} />
              盘前 · 等待开盘
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
              : `已休市 · ${formatTick(lastPointTime, range)}`}
          </span>
        </span>
        <PressableButton
          onClick={() => onRefresh?.()}
          disabled={refreshing}
          className="text-[10px] font-bold bg-white/70 dark:bg-white/5 border border-[var(--hairline-border)] px-2.5 py-1 rounded-full flex items-center gap-1 whitespace-nowrap hover:bg-slate-50 dark:hover:bg-white/10 disabled:opacity-50 shrink-0"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          手动刷新
        </PressableButton>
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
            <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--color-up)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--color-up)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gDown" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--color-down)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gFlat" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--color-flat)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--color-flat)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Y-grid lines */}
          {yTicks.map((t, i) => (
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
            </g>
          ))}

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

          {/* Baseline at the open price — clipped to chart so it doesn't draw outside when
              the reference value (prev close / IPO issue price) is far outside the
              actual trading range. */}
          {firstPoint.v >= minV && firstPoint.v <= maxV && (
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={y(firstPoint.v)}
              y2={y(firstPoint.v)}
              stroke="currentColor"
              strokeOpacity="0.14"
              strokeDasharray="4 4"
            />
          )}

          {/* Area fill — mask-reveal from top (Apple Stocks "water-fills-in" effect).
              clipPath rect's `y` springs from padding.top down to padding.top + innerH,
              so the gradient appears to "fall in" behind the freshly-drawn line.
              key on range so switching range re-reveals. */}
          <defs>
            <clipPath id="fundChartAreaReveal">
              <motion.rect
                key={`area-reveal-${range}`}
                x={padding.left}
                y={padding.top}
                width={innerW}
                height={innerH}
                initial={prefersReducedMotion ? false : { y: padding.top }}
                animate={{ y: padding.top + innerH }}
                transition={SPRING_FILL}
              />
            </clipPath>
          </defs>
          <motion.path
            key={`area-${range}`}
            d={areaPath}
            fill={`url(#${colorId})`}
            clipPath="url(#fundChartAreaReveal)"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ type: 'spring' as const, bounce: 0, duration: 0.5 }}
          />

          {/* Line — animates on range change */}
          <motion.path
            key={`line-${range}`}
            d={linePath}
            fill="none"
            stroke={colorVar}
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={
              prefersReducedMotion
                ? false
                : { pathLength: 0, opacity: 0 }
            }
            animate={{ pathLength: 1, opacity: 1 }}
            transition={SPRING_DRAW}
          />

          {/* Real data points — visible dots only on real daily closes.
              Skipped during intraday (every interpolated minute would be
              a dot, which is noise). */}
          {series.source !== 'estimated' && points.map((p, i) => {
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

          {/* Today's live tick — emphasized ring on the rightmost point.
              盘前时跳过脉冲动画：gsz 与昨日 dwjz 相等，脉冲暗示"实时跳动"是误导。
              静态中心点由曲线已能看见，所以这里直接不渲染。 */}
          {points.length > 0 && !series.preMarket && (() => {
            const last = points[points.length - 1];
            if (last.real) return null;
            const lx = x(points.length - 1);
            const ly = y(last.v);
            return (
              <motion.g
                key="live-tick"
                initial={prefersReducedMotion ? false : { scale: 0 }}
                animate={{ scale: 1 }}
                transition={SPRING_TAB}
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
                <line
                  x1={hoverX}
                  x2={hoverX}
                  y1={padding.top}
                  y2={padding.top + innerH}
                  stroke="currentColor"
                  strokeOpacity="0.18"
                />
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
                left: `${Math.min(Math.max(0, hoverX - 70), width - 150)}px`,
                top: `${Math.max(0, hoverY - 76)}px`,
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
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer — change summary for the active range */}
      <div className="mt-2 flex items-center gap-3 text-[11px]">
        <span className="flex items-center gap-1 font-semibold" style={{ color: colorVar }}>
          {isUp ? <TrendingUp size={12} /> : isDown ? <TrendingDown size={12} /> : <Minus size={12} />}
          {changeAmt > 0 ? '+' : ''}{changeAmt.toFixed(4)}
        </span>
        <span className="font-semibold" style={{ color: colorVar }}>
          {changePercent > 0 ? '+' : ''}{changePercent.toFixed(2)}%
        </span>
        <span className="text-slate-500">
          区间内 {points[0].v.toFixed(4)} → {lastPoint.v.toFixed(4)}
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
