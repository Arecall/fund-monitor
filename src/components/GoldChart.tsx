import { useMemo, useState, useRef, useCallback } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export interface GoldPoint {
  t: number;     // Unix ms
  v: number;     // price
}

export interface GoldChartProps {
  points: GoldPoint[];
  /** 上一交易日收盘价（用于基准线） */
  prevClose?: number | null;
  /** 显示币种/单位 */
  currency: string;
  unit: string;
  /** 数据过少时的提示文案 */
  emptyHint?: string;
  height?: number;
  /**
   * 由父组件传入的"用户选择"范围。不传则从数据跨度推断（旧行为）。
   * 传了以后 X 轴标签格式、窗口、formatWindow 都以这个为准，
   * 避免"用户点 1 月但服务只累积了 5 天 → 图表自动退化成 1 周"。
   */
  range?: 'intraday' | '1W' | '1M';
}

function formatTick(t: number, range: 'intraday' | '1W' | '1M'): string {
  const d = new Date(t);
  if (range === 'intraday') {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatTooltipTime(t: number, range: 'intraday' | '1W' | '1M'): string {
  const d = new Date(t);
  if (range === 'intraday') {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function GoldChart({ points, prevClose, currency, unit, emptyHint, height = 220, range: rangeProp }: GoldChartProps) {
  const prefersReducedMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const padding = { top: 20, right: 14, bottom: 26, left: 56 };
  const width = 720;
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  // 给 Y 轴标签留视觉空间：折线和面积不从 padding.left 开始，避免"折线贴标签"
  // 14px ≈ "4155.00" 这种标签宽 + 安全距离
  const xAxisInset = 14;
  const drawableW = innerW - xAxisInset;
  const wrapWidthPercent = 100;

  // range：优先用父组件传入的用户选择；否则从数据跨度推断（旧 behavior）
  const range = useMemo<'intraday' | '1W' | '1M'>(() => {
    if (rangeProp) return rangeProp;
    if (points.length < 2) return 'intraday';
    const spanMs = points[points.length - 1].t - points[0].t;
    const day = 24 * 60 * 60 * 1000;
    if (spanMs <= day) return 'intraday';
    if (spanMs <= 7 * day) return '1W';
    return '1M';
  }, [points, rangeProp]);

  // Y 轴自适应（基于数据范围，不含 prevClose — 避免把数据挤到顶端/底端）
  const { minV, maxV, range_v } = useMemo(() => {
    if (points.length === 0) {
      return { minV: 0, maxV: 1, range_v: 1 };
    }
    const vals = points.map(p => p.v);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo;
    // 20% margin 之外加最小绝对值——避免国内金价这种 span 只有 0.5 CNY、价格
    // 单位两位小数的小数据集被空 margin 压扁。去掉 mid*0.001 是因为对低价位资产
    // （gold ~899 CNY/g、AFEX 棉花等）0.1% × 几百 = 0.5-0.9 CNY 巨大，会盖过数据本身。
    const margin = Math.max(span * 0.20, 0.05);
    return {
      minV: lo - margin,
      maxV: hi + margin,
      range_v: hi - lo + margin * 2 || 1,
    };
  }, [points]);

  // X 轴窗口：稀疏数据时自动 zoom in（避免数据挤成垂直条遮挡）
  const now = Date.now();
  const { windowStart, windowEnd, isAutoZoomed } = useMemo<{ windowStart: number; windowEnd: number; isAutoZoomed: boolean }>(() => {
    let baseStart: number;
    let baseEnd: number;
    let zoom = false;

    if (range === 'intraday') {
      const today = new Date(now);
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const lastTs = points[points.length - 1]?.t ?? now;
      baseStart = startOfDay;
      baseEnd = Math.max(now, lastTs);
    } else if (range === '1W') {
      baseStart = now - 7  * 24 * 60 * 60 * 1000;
      baseEnd = now;
    } else {
      baseStart = now - 30 * 24 * 60 * 60 * 1000;
      baseEnd = now;
    }

    // 自动 zoom：避免数据挤成垂直条遮挡图表
    //   情况 A：数据跨度 < 基础窗口的 50% → 把窗口压缩到 ~1.6× 数据跨度
    if (points.length >= 2) {
      const dataSpan = points[points.length - 1].t - points[0].t;
      const baseSpan = baseEnd - baseStart;
      if (baseSpan > 0 && dataSpan < baseSpan * 0.5) {
        // 缩窗口：让数据占据图表 ~60%
        const padded = Math.max(dataSpan * 1.6, 60 * 1000); // 最少 1 分钟
        baseStart = baseEnd - padded;
        zoom = true;
      }
    }

    return { windowStart: baseStart, windowEnd: baseEnd, isAutoZoomed: zoom };
  }, [range, now, points]);

  const windowSpan = Math.max(1, windowEnd - windowStart);

  // X 坐标：按绝对时间位置（不是 index）
  const xPos = (i: number): number => {
    if (points.length === 0) return padding.left + xAxisInset;
    if (points.length === 1) return padding.left + xAxisInset + drawableW / 2;
    return padding.left + xAxisInset + ((points[i].t - windowStart) / windowSpan) * drawableW;
  };
  const yPos = (v: number) =>
    padding.top + (1 - (v - minV) / range_v) * innerH;

  // 找 timestamp 对应的最近 index
  const findNearestIdx = useCallback((t: number): number => {
    if (points.length === 0) return -1;
    let best = 0;
    let bestDiff = Math.abs(points[0].t - t);
    for (let i = 1; i < points.length; i++) {
      const diff = Math.abs(points[i].t - t);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }, [points]);

  // Hover：从 SVG 实际像素宽度计算对应 timestamp，找最近节点
  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (points.length < 1) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const vbX = (px / rect.width) * width;
    if (vbX < padding.left + xAxisInset || vbX > padding.left + innerW) {
      setHoverIdx(null);
      return;
    }
    const ratio = (vbX - padding.left - xAxisInset) / drawableW;
    const t = windowStart + ratio * windowSpan;
    const idx = findNearestIdx(t);
    if (idx >= 0) setHoverIdx(idx);
  }, [points, windowStart, windowSpan, findNearestIdx]);

  const onLeave = useCallback(() => setHoverIdx(null), []);

  // X 刻度：5 个均匀分布的 tick，按时间位置
  const xTicks = useMemo(() => {
    if (windowSpan <= 0) return [];
    const N = 5;
    const out: { x: number; label: string }[] = [];
    for (let i = 0; i < N; i++) {
      const ratio = i / (N - 1);
      const t = windowStart + ratio * windowSpan;
      out.push({ x: padding.left + xAxisInset + ratio * drawableW, label: formatTick(t, range) });
    }
    return out;
  }, [windowStart, windowSpan, range]);

  // 跨数据缺口时打断折线 — 避免在长时间无新 tick 时画一条假水平线+垂直跳变
  // 阈值：分时 > 3 min（轮询周期 60s × 3 倍），周/月 > 24 h
  const gapThresholdMs = range === 'intraday' ? 3 * 60 * 1000 : 24 * 60 * 60 * 1000;

  const linePath = useMemo(() => {
    if (points.length === 0) return '';
    const parts: string[] = [];
    let seg = `M ${xPos(0).toFixed(2)} ${yPos(points[0].v).toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      if (points[i].t - points[i - 1].t > gapThresholdMs) {
        parts.push(seg);
        seg = `M ${xPos(i).toFixed(2)} ${yPos(points[i].v).toFixed(2)}`;
      } else {
        seg += ` L ${xPos(i).toFixed(2)} ${yPos(points[i].v).toFixed(2)}`;
      }
    }
    parts.push(seg);
    return parts.join(' ');
  }, [points, minV, maxV, windowStart, windowSpan, gapThresholdMs]);

  const areaPath = useMemo(() => {
    if (points.length === 0) return '';
    const baselineY = (padding.top + innerH).toFixed(2);
    const parts: string[] = [];
    let seg = `M ${xPos(0).toFixed(2)} ${baselineY} L ${xPos(0).toFixed(2)} ${yPos(points[0].v).toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      if (points[i].t - points[i - 1].t > gapThresholdMs) {
        // 关闭当前段到基线，开新段
        seg += ` L ${xPos(i - 1).toFixed(2)} ${baselineY} Z`;
        parts.push(seg);
        seg = `M ${xPos(i).toFixed(2)} ${baselineY} L ${xPos(i).toFixed(2)} ${yPos(points[i].v).toFixed(2)}`;
      } else {
        seg += ` L ${xPos(i).toFixed(2)} ${yPos(points[i].v).toFixed(2)}`;
      }
    }
    // 收尾
    seg += ` L ${xPos(points.length - 1).toFixed(2)} ${baselineY} Z`;
    parts.push(seg);
    return parts.join(' ');
  }, [points, minV, maxV, windowStart, windowSpan, gapThresholdMs]);

  // Y 轴刻度：四等分再取"nice" step（5 的倍数优先；窄区间退到 0.5），并严格夹在 [minV, maxV] 内。
  // 0.5 步长服务于国内金价这种 span 只有 0.5 CNY 的小数据集——整数 step 会让唯一一条
  // 9xx.00 刻度线落在数据正中，看不出波动。
  const yTicks = useMemo(() => {
    const rawStep = range_v / 4;
    let step: number;
    if (rawStep < 1) {
      step = Math.max(0.5, Math.round(rawStep * 2) / 2);  // round 到 0.5
    } else if (rawStep < 5) {
      step = Math.max(1, Math.round(rawStep * 2) / 2);    // 0.5 整数化
    } else {
      step = Math.max(1, Math.round(rawStep / 5) * 5);    // 大区间照旧 5 的倍数
    }
    const startTick = Math.ceil(minV / step) * step;
    const endTick = Math.floor(maxV / step) * step;
    const ticks: number[] = [];
    for (let v = startTick; v <= endTick + 1e-9; v += step) {
      ticks.push(parseFloat(v.toFixed(4)));
    }
    if (ticks.length < 3) {
      // 数据太集中（step 比 range_v 还大）：退回 minV / 中点 / maxV，至少 3 条参考线
      return [minV, (minV + maxV) / 2, maxV].map(v => ({ v, y: yPos(v) }));
    }
    return ticks.map(v => ({ v, y: yPos(v) }));
  }, [maxV, minV, range_v]);

  const last = points[points.length - 1]?.v ?? 0;
  const firstPointVal = points[0]?.v ?? last;
  const change = last - firstPointVal;
  const changePct = firstPointVal > 0 ? (change / firstPointVal) * 100 : 0;
  const dirUp = change > 0;
  const dirDown = change < 0;
  const trendColor = dirUp ? 'var(--color-up)' : dirDown ? 'var(--color-down)' : 'var(--color-flat)';
  const TrendIcon = dirUp ? TrendingUp : dirDown ? TrendingDown : Minus;

  const hoverPoint = hoverIdx != null ? points[hoverIdx] : null;
  const hoverX = hoverIdx != null ? xPos(hoverIdx) : 0;
  const hoverY = hoverPoint ? yPos(hoverPoint.v) : 0;
  const hoverXPct = hoverIdx != null ? (hoverX / width) * wrapWidthPercent : 0;

  // hover 节点的相对第一个点的变化
  const hoverChange = hoverPoint && firstPointVal > 0 ? hoverPoint.v - firstPointVal : 0;
  const hoverChangePct = hoverPoint && firstPointVal > 0 ? (hoverChange / firstPointVal) * 100 : 0;
  const hoverColor = hoverChange > 0 ? 'var(--color-up)' : hoverChange < 0 ? 'var(--color-down)' : 'var(--color-flat)';

  if (points.length < 2) {
    return (
      <div className="text-xs text-slate-500 py-8 text-center bg-slate-50/40 dark:bg-white/[0.02] rounded-xl">
        {emptyHint || '暂无数据'}
      </div>
    );
  }

  return (
    <div>
      {/* 头部统计 — 跟随 hover 更新 */}
      <div className="flex items-center justify-between px-1 mb-2">
        <div className="text-[11px] text-slate-500">
          数据点 <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{points.length}</span>
          · 窗口 <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{formatWindow(windowStart, windowEnd, range)}</span>
          {isAutoZoomed && <span className="ml-1 text-amber-600 dark:text-amber-400">· 自动 zoom</span>}
          {hoverPoint && (
            <span className="ml-2 text-[var(--primary-accent)] dark:text-[#2997ff]">
              · {formatTick(hoverPoint.t, range)} · {hoverPoint.v.toFixed(2)}
            </span>
          )}
          {hoverPoint && (
            <span className="ml-2 text-[var(--primary-accent)] dark:text-[#2997ff]">
              · {formatTick(hoverPoint.t, range)} · {hoverPoint.v.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {hoverPoint ? (
            <>
              <span className="flex items-center gap-1 font-bold tabular-nums" style={{ color: hoverColor }}>
                <TrendIcon size={12} />
                {hoverChangePct > 0 ? '+' : ''}{hoverChangePct.toFixed(2)}%
              </span>
              <span className="text-slate-500 tabular-nums">
                {hoverChange > 0 ? '+' : ''}{hoverChange.toFixed(2)}
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1 font-bold tabular-nums" style={{ color: trendColor }}>
                <TrendIcon size={12} />
                {changePct > 0 ? '+' : ''}{changePct.toFixed(2)}%
              </span>
              <span className="text-slate-500 tabular-nums">
                {change > 0 ? '+' : ''}{change.toFixed(2)}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          className="block select-none touch-none"
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        >
          <defs>
            <linearGradient id="gGoldUp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-up)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--color-up)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gGoldDown" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-down)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gGoldFlat" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-flat)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--color-flat)" stopOpacity="0" />
            </linearGradient>

            {/* 严格边界 clip：折线 / 面积只在 [padding.left+xAxisInset, padding.left+innerW] × [padding.top+2, padding.top+innerH-2] 内可见，杜绝任何越界绘制 */}
            <clipPath id="gGoldChartBounds">
              <rect
                x={padding.left + xAxisInset}
                y={padding.top + 2}
                width={drawableW}
                height={innerH - 4}
              />
            </clipPath>
          </defs>

          {/* Y grid */}
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
                {t.v.toFixed(2)}
              </text>
            </g>
          ))}

          {/* X labels — 按 window 均匀分布 */}
          {xTicks.map((t, i) => (
            <text
              key={i}
              x={t.x}
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

          {/* Baseline at prev close */}
          {prevClose != null && (
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={yPos(prevClose)}
              y2={yPos(prevClose)}
              stroke="currentColor"
              strokeOpacity="0.14"
              strokeDasharray="4 4"
            />
          )}

          {/* Area — mask-reveal: clipPath 从顶端向下 spring 展开，模拟 Apple Stocks "水波纹" 入场 */}
          <defs>
            <clipPath id="gGoldAreaReveal">
              <motion.rect
                key={`reveal-${range}-${points.length}`}
                x={padding.left}
                y={padding.top}
                width={innerW}
                height={innerH}
                initial={prefersReducedMotion ? false : { y: padding.top }}
                animate={{ y: padding.top + innerH }}
                transition={{
                  type: 'spring' as const,
                  bounce: 0,
                  duration: 0.6,
                  delay: 0.15,        // 等线条先走一段
                }}
              />
            </clipPath>
          </defs>

          {/* 面积先被 bounds clip 严格限制在图表区，再被 reveal clip 做"水波纹"入场 */}
          <g clipPath="url(#gGoldChartBounds)">
          <motion.path
            d={areaPath}
            fill={`url(#${dirUp ? 'gGoldUp' : dirDown ? 'gGoldDown' : 'gGoldFlat'})`}
            clipPath="url(#gGoldAreaReveal)"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ type: 'spring' as const, bounce: 0, duration: 0.5, delay: 0.15 }}
          />
          </g>

          {/* Line — spring pathLength，interruptible（spring 默认从当前 presentation 值继续） */}
          <motion.path
            key={`line-${range}-${points.length}`}
            d={linePath}
            fill="none"
            stroke={trendColor}
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            clipPath="url(#gGoldChartBounds)"
            initial={prefersReducedMotion ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{
              type: 'spring' as const,
              bounce: 0,            // critically damped — Apple default
              duration: 0.55,       // response ~ 0.55s（描线稍慢，配合 fill delay 0.15s）
            }}
          />

          {/* Hover crosshair — spring 进入（不是瞬变），符合 Apple "tools respond in the moment" */}
          {hoverPoint && (
            <motion.g
              key={`hover-${hoverIdx}`}
              pointerEvents="none"
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ type: 'spring' as const, bounce: 0, duration: 0.18 }}
            >
              <line
                x1={hoverX}
                x2={hoverX}
                y1={padding.top}
                y2={padding.top + innerH}
                stroke="currentColor"
                strokeOpacity="0.25"
                strokeDasharray="3 3"
              />
              <motion.circle
                cx={hoverX}
                cy={hoverY}
                r="5"
                fill="white"
                stroke={hoverColor}
                strokeWidth="2"
                initial={prefersReducedMotion ? false : { scale: 0.6 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring' as const, bounce: 0.15, duration: 0.22 }}
                style={{ transformOrigin: `${hoverX}px ${hoverY}px` }}
              />
              <circle cx={hoverX} cy={hoverY} r="2.5" fill={hoverColor} />
            </motion.g>
          )}

          {/* End dot — 在 line 描完后才"降落"，spring bounce 0（不 overshoot，Apple 默认） */}
          {points.length > 0 && (
            <motion.g
              key={`dot-${points.length}-${last}`}
              initial={prefersReducedMotion ? false : { scale: 0 }}
              animate={{
                scale: 1,
                opacity: hoverPoint != null && hoverIdx !== points.length - 1 ? 0.3 : 1,
              }}
              transition={{
                type: 'spring' as const,
                bounce: 0,            // critically damped — 不是弹簧 overshoot
                duration: 0.32,
                delay: 0.6,           // 描线结束后 50ms
              }}
              style={{ transformOrigin: `${xPos(points.length - 1)}px ${yPos(last)}px` }}
              pointerEvents="none"
            >
              {/* 外圈轻微"呼吸" — 用 spring loop 模拟实时跳动 */}
              {!prefersReducedMotion && hoverIdx !== points.length - 1 && (
                <motion.circle
                  cx={xPos(points.length - 1)}
                  cy={yPos(last)}
                  r="4"
                  fill={trendColor}
                  animate={{ r: [4, 6.5, 4], opacity: [0.4, 0, 0.4] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}
              <circle cx={xPos(points.length - 1)} cy={yPos(last)} r="4" fill={trendColor} />
              <circle cx={xPos(points.length - 1)} cy={yPos(last)} r="2" fill="white" />
            </motion.g>
          )}
        </svg>

        {/* Tooltip — spring 入场（y: +4→0, opacity 0→1）跟随十字线 */}
        {hoverPoint && (
          <motion.div
            key={`tip-${hoverIdx}`}
            className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-xl bg-white/90 dark:bg-[#1d1d1f]/90 backdrop-blur-md border border-[var(--hairline-border)] shadow-lg text-[11px] min-w-[120px]"
            style={{
              left: `calc(${hoverXPct}% - 60px)`,
              top: `calc(${(hoverY / height) * 100}% + 6px)`,
            }}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring' as const, bounce: 0, duration: 0.22 }}
          >
            <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums mb-1">
              {formatTooltipTime(hoverPoint.t, range)}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">价位</span>
              <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-200">
                {hoverPoint.v.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">涨跌</span>
              <span className="font-mono font-semibold tabular-nums" style={{ color: hoverColor }}>
                {hoverChange > 0 ? '+' : ''}{hoverChange.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">涨跌幅</span>
              <span className="font-mono font-semibold tabular-nums" style={{ color: hoverColor }}>
                {hoverChangePct > 0 ? '+' : ''}{hoverChangePct.toFixed(2)}%
              </span>
            </div>
          </motion.div>
        )}
      </div>

      <div className="text-[10px] text-slate-400 text-center mt-1 font-mono">
        单位: {currency}/{unit}
      </div>
    </div>
  );
}

/** 把"窗口"跨度格式化为可读字符串 */
function formatWindow(start: number, end: number, range: 'intraday' | '1W' | '1M'): string {
  const span = end - start;
  if (range === 'intraday') {
    const hours = Math.round(span / (60 * 60 * 1000));
    if (hours <= 1) return `${Math.round(span / 60000)} 分钟`;
    return `${hours} 小时`;
  }
  // 1W / 1M：用实际窗口跨度（自动 zoom 后可能是 8 天、16 天等），不再硬编码
  const days = Math.round(span / (24 * 60 * 60 * 1000));
  if (days <= 1) {
    const hours = Math.round(span / (60 * 60 * 1000));
    return `${hours} 小时`;
  }
  return `${days} 天`;
}
