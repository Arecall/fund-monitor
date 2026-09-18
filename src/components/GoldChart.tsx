import { useMemo, useState, useRef, useCallback } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export interface GoldPoint {
  t: number;     // Unix ms
  v: number;     // price
}

export interface EffectiveGoldPoint extends GoldPoint {
  /** 标识该点是否为周末/休市前值平线填充点 */
  isClosed?: boolean;
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

/**
 * 周末与非交易日平线前值填充（Forward-Fill）：
 * 在 1W / 1M 宏观走势图下，金融市场周末休市价格处于物理冻结状态。
 * 沿用上一交易日收盘价填充至周六、周日及当前休市节点，
 * 既真实反映休市事实，又使折线与渐变面积完整连贯，杜绝跨周末断层。
 */
function forwardFillGoldPoints(
  rawPoints: GoldPoint[],
  range: 'intraday' | '1W' | '1M',
  now: number
): EffectiveGoldPoint[] {
  if (range === 'intraday' || !Array.isArray(rawPoints) || rawPoints.length < 2) {
    return rawPoints;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const result: EffectiveGoldPoint[] = [];

  for (let i = 0; i < rawPoints.length; i++) {
    const curr = rawPoints[i];
    result.push(curr);

    const next = rawPoints[i + 1];
    if (next) {
      const gapMs = next.t - curr.t;
      // 若两点间隔大于 28 小时（说明跨越了周末或节假日休市），按自然日向前平铺前值
      if (gapMs > 28 * 60 * 60 * 1000) {
        let fillTs = curr.t + DAY_MS;
        while (fillTs < next.t - 4 * 60 * 60 * 1000) {
          result.push({
            t: fillTs,
            v: curr.v,
            isClosed: true,
          });
          fillTs += DAY_MS;
        }
      }
    }
  }

  // 若最新交易日记录距今大于 20 小时（如周五收盘后当前处于周末/周一开盘前休市），
  // 持续延伸填充到当前时刻，避免图表最右侧留下空截断
  if (result.length > 0) {
    const last = result[result.length - 1];
    if (now - last.t > 20 * 60 * 60 * 1000 && now - last.t < 5 * DAY_MS) {
      let fillTs = last.t + DAY_MS;
      while (fillTs <= now - 2 * 60 * 60 * 1000) {
        result.push({
          t: fillTs,
          v: last.v,
          isClosed: true,
        });
        fillTs += DAY_MS;
      }
      result.push({
        t: now,
        v: last.v,
        isClosed: true,
      });
    }
  }

  return result;
}

/**
 * 为连续的数据点段构建平滑贝塞尔样条路径（Monotone / Catmull-Rom Spline）
 * 消除高频锯齿与折角突变，使金价走势呈现如丝般顺滑的专业贵金属终端视觉
 */
function buildSmoothSplinePath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  if (pts.length === 2) {
    return `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)} L ${pts[1].x.toFixed(2)} ${pts[1].y.toFixed(2)}`;
  }

  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 >= pts.length ? pts.length - 1 : i + 2];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export function GoldChart({ points, prevClose, currency, unit, emptyHint, height = 230, range: rangeProp }: GoldChartProps) {
  const prefersReducedMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // 双 Y 轴对称边距：左轴挂绝对价格，右轴挂水上水下涨跌百分比
  const padding = { top: 22, right: 52, bottom: 28, left: 60 };
  const width = 720;
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const xAxisInset = 8;
  const drawableW = innerW - xAxisInset;

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

  // 周末及休市平线前值填充：在宏观周/月日线视图下，将休市价格物理冻结至当前，消除断层
  const now = Date.now();
  const effectivePoints = useMemo<EffectiveGoldPoint[]>(() => {
    return forwardFillGoldPoints(points, range, now);
  }, [points, range, now]);

  // Y 轴自适应（基于数据范围，不含 prevClose — 避免把数据挤到顶端/底端）
  const { minV, maxV, range_v } = useMemo(() => {
    if (effectivePoints.length === 0) {
      return { minV: 0, maxV: 1, range_v: 1 };
    }
    const vals = effectivePoints.map(p => p.v);
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
  }, [effectivePoints]);

  // X 轴窗口：稀疏数据时自动 zoom in（避免数据挤成垂直条遮挡）
  const { windowStart, windowEnd, isAutoZoomed } = useMemo<{ windowStart: number; windowEnd: number; isAutoZoomed: boolean }>(() => {
    let baseStart: number;
    let baseEnd: number;
    let zoom = false;

    if (range === 'intraday') {
      const today = new Date(now);
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const lastTs = effectivePoints[effectivePoints.length - 1]?.t ?? now;
      baseStart = startOfDay;
      baseEnd = Math.max(now, lastTs);
    } else if (range === '1W') {
      baseStart = now - 7  * 24 * 60 * 60 * 1000;
      baseEnd = now;
    } else {
      baseStart = now - 30 * 24 * 60 * 60 * 1000;
      baseEnd = now;
    }

    // 自动 zoom：仅当数据跨度 < 基础窗口的 40% 时触发（避免正常 21 个交易日因周末空隙误触发 zoom）
    if (effectivePoints.length >= 2) {
      const dataSpan = effectivePoints[effectivePoints.length - 1].t - effectivePoints[0].t;
      const baseSpan = baseEnd - baseStart;
      if (baseSpan > 0 && dataSpan < baseSpan * 0.4) {
        // 缩窗口：让数据占据图表 ~60%
        const padded = Math.max(dataSpan * 1.6, 60 * 1000); // 最少 1 分钟
        baseStart = baseEnd - padded;
        zoom = true;
      }
    }

    return { windowStart: baseStart, windowEnd: baseEnd, isAutoZoomed: zoom };
  }, [range, now, effectivePoints]);

  const windowSpan = Math.max(1, windowEnd - windowStart);

  // X 坐标：按绝对时间位置（不是 index）
  const xPos = (i: number): number => {
    if (effectivePoints.length === 0) return padding.left + xAxisInset;
    if (effectivePoints.length === 1) return padding.left + xAxisInset + drawableW / 2;
    return padding.left + xAxisInset + ((effectivePoints[i].t - windowStart) / windowSpan) * drawableW;
  };
  const yPos = (v: number) =>
    padding.top + (1 - (v - minV) / range_v) * innerH;

  // 找 timestamp 对应的最近 index
  const findNearestIdx = useCallback((t: number): number => {
    if (effectivePoints.length === 0) return -1;
    let best = 0;
    let bestDiff = Math.abs(effectivePoints[0].t - t);
    for (let i = 1; i < effectivePoints.length; i++) {
      const diff = Math.abs(effectivePoints[i].t - t);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }, [effectivePoints]);

  // Hover：从 SVG 实际像素宽度计算对应 timestamp，找最近节点
  const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (effectivePoints.length < 1) return;
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
  }, [effectivePoints, windowStart, windowSpan, findNearestIdx]);

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
  // 阈值：分时 > 30 min（轮询周期 60s），周/月已做前值平线填充，仅在发生 > 10 天的无数据异常断档时才打断
  const gapThresholdMs = range === 'intraday' ? 30 * 60 * 1000 : 10 * 24 * 60 * 60 * 1000;

  // ─── 平滑连续样条折线 (Smooth Spline Line Path) ───
  const linePath = useMemo(() => {
    if (effectivePoints.length === 0) return '';
    const segments: { x: number; y: number }[][] = [];
    let curSeg: { x: number; y: number }[] = [{ x: xPos(0), y: yPos(effectivePoints[0].v) }];
    for (let i = 1; i < effectivePoints.length; i++) {
      if (effectivePoints[i].t - effectivePoints[i - 1].t > gapThresholdMs) {
        segments.push(curSeg);
        curSeg = [{ x: xPos(i), y: yPos(effectivePoints[i].v) }];
      } else {
        curSeg.push({ x: xPos(i), y: yPos(effectivePoints[i].v) });
      }
    }
    segments.push(curSeg);
    return segments.map(seg => buildSmoothSplinePath(seg)).join(' ');
  }, [effectivePoints, minV, maxV, windowStart, windowSpan, gapThresholdMs]);

  // ─── 轻雾晨曦羽化面积路径 (Feathered Area Path) ───
  const areaPath = useMemo(() => {
    if (effectivePoints.length === 0) return '';
    const baselineY = padding.top + innerH;
    const segments: { x: number; y: number }[][] = [];
    let curSeg: { x: number; y: number }[] = [{ x: xPos(0), y: yPos(effectivePoints[0].v) }];
    for (let i = 1; i < effectivePoints.length; i++) {
      if (effectivePoints[i].t - effectivePoints[i - 1].t > gapThresholdMs) {
        segments.push(curSeg);
        curSeg = [{ x: xPos(i), y: yPos(effectivePoints[i].v) }];
      } else {
        curSeg.push({ x: xPos(i), y: yPos(effectivePoints[i].v) });
      }
    }
    segments.push(curSeg);
    return segments
      .map(seg => {
        if (seg.length === 0) return '';
        const spline = buildSmoothSplinePath(seg);
        const lastPt = seg[seg.length - 1];
        const firstPt = seg[0];
        return `${spline} L ${lastPt.x.toFixed(2)} ${baselineY.toFixed(2)} L ${firstPt.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;
      })
      .join(' ');
  }, [effectivePoints, minV, maxV, windowStart, windowSpan, gapThresholdMs, padding.top, innerH]);

  // Y 轴刻度：四等分再取"nice" step（5 的倍数优先；窄区间退到 0.5），并严格夹在 [minV, maxV] 内。
  const yTicks = useMemo(() => {
    const rawStep = range_v / 4;
    let step: number;
    if (rawStep < 1) {
      step = Math.max(0.5, Math.round(rawStep * 2) / 2);
    } else if (rawStep < 5) {
      step = Math.max(1, Math.round(rawStep * 2) / 2);
    } else {
      step = Math.max(1, Math.round(rawStep / 5) * 5);
    }
    const startTick = Math.ceil(minV / step) * step;
    const endTick = Math.floor(maxV / step) * step;
    const ticks: number[] = [];
    for (let v = startTick; v <= endTick + 1e-9; v += step) {
      ticks.push(parseFloat(v.toFixed(4)));
    }
    if (ticks.length < 3) {
      return [minV, (minV + maxV) / 2, maxV].map(v => ({ v, y: yPos(v) }));
    }
    return ticks.map(v => ({ v, y: yPos(v) }));
  }, [maxV, minV, range_v]);

  // ─── 金融基准锚点（Benchmark） ───
  // 分时图（intraday）：优先以昨收价 prevClose 为基准；若缺乏则退化为第一点
  // 历史图（1W / 1M）：以区间第一点为基准
  const last = effectivePoints[effectivePoints.length - 1]?.v ?? 0;
  const firstPointVal = effectivePoints[0]?.v ?? last;
  const baselineValue = (range === 'intraday' && prevClose != null && prevClose > 0)
    ? prevClose
    : (firstPointVal > 0 ? firstPointVal : last);
  const baselineLabel = (range === 'intraday' && prevClose != null && prevClose > 0) ? '昨收' : '起点';

  const change = last - baselineValue;
  const changePct = baselineValue > 0 ? (change / baselineValue) * 100 : 0;
  const dirUp = change > 0;
  const dirDown = change < 0;
  const trendColor = dirUp ? 'var(--color-up)' : dirDown ? 'var(--color-down)' : 'var(--color-flat)';
  const TrendIcon = dirUp ? TrendingUp : dirDown ? TrendingDown : Minus;

  const hoverPoint = hoverIdx != null ? effectivePoints[hoverIdx] : null;
  const hoverX = hoverIdx != null ? xPos(hoverIdx) : 0;
  const hoverY = hoverPoint ? yPos(hoverPoint.v) : 0;

  // hover 节点的相对基准变化
  const hoverChange = hoverPoint && baselineValue > 0 ? hoverPoint.v - baselineValue : 0;
  const hoverChangePct = hoverPoint && baselineValue > 0 ? (hoverChange / baselineValue) * 100 : 0;
  const hoverColor = hoverChange > 0 ? 'var(--color-up)' : hoverChange < 0 ? 'var(--color-down)' : 'var(--color-flat)';

  // ─── 计算黄金日内/区间金融关键统计指标（最高、最低、振幅、基准） ───
  const dayStats = useMemo(() => {
    if (!effectivePoints || effectivePoints.length === 0) return null;
    let high = -Infinity;
    let low = Infinity;
    for (let i = 0; i < effectivePoints.length; i++) {
      const v = effectivePoints[i].v;
      if (v > high) high = v;
      if (v < low) low = v;
    }
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    const base = baselineValue > 0 ? baselineValue : (effectivePoints[0]?.v || 1);
    const highPct = ((high - base) / base) * 100;
    const lowPct = ((low - base) / base) * 100;
    const amplitude = ((high - low) / base) * 100;
    return { high, low, highPct, lowPct, amplitude, base, label: baselineLabel };
  }, [effectivePoints, baselineValue, baselineLabel]);

  // ─── 黄金大厂级锚点动态跟手与防遮挡探针定位 (Anchor-Following Anti-Occlusion Tooltip) ───
  // 1. 水平方向紧跟锚点 hoverX 移动，以画布中轴线为界在锚点左右侧切换；
  // 2. 绝对防遮挡：翻转至左侧 translateX(calc(-100% - 12px))，右侧展开 translateX(12px)，
  //    面向锚点一侧严格固定 12px 净空，十字准星、垂直线与定位圆环 100% 外露；
  // 3. 针对 viewBox 自适应缩放，采用百分比锚定 left / top，在任何视口宽度下永不漂移；
  // 4. 垂直方向动态跟随 hoverY，并被安全限制在图表视窗内部。
  const isRightSide = hoverX > (padding.left + innerW * 0.48);
  const estimatedTooltipHeight = 100;
  const rawTooltipY = hoverY - estimatedTooltipHeight * 0.38;
  const minTooltipY = padding.top + 4;
  const maxTooltipY = Math.max(minTooltipY, padding.top + innerH - estimatedTooltipHeight - 4);
  const clampedTooltipY = Math.max(minTooltipY, Math.min(maxTooltipY, rawTooltipY));

  if (effectivePoints.length < 2) {
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
          {effectivePoints.length > points.length && (
            <span className="text-[10px] text-slate-400 font-sans ml-1">
              (含休市平线)
            </span>
          )}
          · 窗口 <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{formatWindow(windowStart, windowEnd, range)}</span>
          {isAutoZoomed && <span className="ml-1 text-amber-600 dark:text-amber-400">· 自动 zoom</span>}
          {hoverPoint && (
            <span className="ml-2 text-[var(--primary-accent)] dark:text-[#2997ff]">
              · {formatTick(hoverPoint.t, range)} · {hoverPoint.v.toFixed(2)}
              {hoverPoint.isClosed && (
                <span className="text-amber-600 dark:text-amber-400 text-[10px] ml-1 font-sans font-normal">
                  (周末休市)
                </span>
              )}
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
            {/* 轻雾晨曦羽化渐变（Apple Atmospheric Gradient）：顶轻底隐，高通透与呼吸感 */}
            <linearGradient id="gGoldUp" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%"   stopColor="var(--color-up)" stopOpacity="0.00" />
              <stop offset="35%"  stopColor="var(--color-up)" stopOpacity="0.03" />
              <stop offset="70%"  stopColor="var(--color-up)" stopOpacity="0.10" />
              <stop offset="100%" stopColor="var(--color-up)" stopOpacity="0.22" />
            </linearGradient>
            <linearGradient id="gGoldDown" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%"   stopColor="var(--color-down)" stopOpacity="0.00" />
              <stop offset="35%"  stopColor="var(--color-down)" stopOpacity="0.03" />
              <stop offset="70%"  stopColor="var(--color-down)" stopOpacity="0.10" />
              <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0.22" />
            </linearGradient>
            <linearGradient id="gGoldFlat" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%"   stopColor="var(--color-flat)" stopOpacity="0.00" />
              <stop offset="50%"  stopColor="var(--color-flat)" stopOpacity="0.04" />
              <stop offset="100%" stopColor="var(--color-flat)" stopOpacity="0.14" />
            </linearGradient>

            {/* 折线下方柔光高斯光晕（霓虹笔触） */}
            <filter id="goldLineGlow" x="-5%" y="-50%" width="110%" height="200%">
              <feGaussianBlur stdDeviation="2.2" />
            </filter>

            {/* 严格边界 clip：折线 / 面积只在有效绘制区域内可见，杜绝越界 */}
            <clipPath id="gGoldChartBounds">
              <rect
                x={padding.left + xAxisInset}
                y={padding.top + 2}
                width={drawableW}
                height={innerH - 4}
              />
            </clipPath>

            {/* 面积水波纹入场 clip */}
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
                  delay: 0.15,
                }}
              />
            </clipPath>
          </defs>

          {/* Y grid + 左轴绝对价格 + 右轴相对基准涨跌百分比（双 Y 轴水上水下着色） */}
          {yTicks.map((t, i) => {
            const pct = baselineValue > 0 ? ((t.v - baselineValue) / baselineValue) * 100 : 0;
            const isPctUp = pct > 0.005;
            const isPctDown = pct < -0.005;
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
                  {t.v.toFixed(2)}
                </text>
                {/* 右轴：相对基准的涨跌百分比 */}
                <text
                  x={padding.left + innerW + 8}
                  y={t.y + 3}
                  textAnchor="start"
                  fontSize="10"
                  fill={isPctUp ? 'var(--color-up)' : isPctDown ? 'var(--color-down)' : 'currentColor'}
                  fillOpacity={isPctUp || isPctDown ? '0.85' : '0.45'}
                  className="font-mono tabular-nums font-medium"
                >
                  {`${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}
                </text>
              </g>
            );
          })}

          {/* X 轴刻度标签 */}
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

          {/* 零轴基准线 (昨收/开盘平衡线)：具备金融心理锚定仪式感 */}
          {baselineValue >= minV && baselineValue <= maxV && (
            <g>
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={yPos(baselineValue)}
                y2={yPos(baselineValue)}
                stroke="currentColor"
                strokeOpacity="0.22"
                strokeDasharray="4 3"
              />
              <rect
                x={padding.left + innerW + 3}
                y={yPos(baselineValue) - 7}
                width={36}
                height={14}
                rx={3}
                fill="currentColor"
                fillOpacity="0.06"
              />
              <text
                x={padding.left + innerW + 21}
                y={yPos(baselineValue) + 3.5}
                textAnchor="middle"
                fontSize="9"
                fill="currentColor"
                fillOpacity="0.75"
                className="font-mono tabular-nums font-semibold"
              >
                0.00%
              </text>
            </g>
          )}

          {/* 面积图：限制在边界内并带有流体展开 */}
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

          {/* 折线下层的柔光光晕层（霓虹笔触） */}
          <motion.path
            key={`gold-glow-${range}-${points.length}`}
            d={linePath}
            fill="none"
            stroke={trendColor}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.18"
            filter="url(#goldLineGlow)"
            clipPath="url(#gGoldChartBounds)"
            initial={prefersReducedMotion ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ type: 'spring' as const, bounce: 0, duration: 0.6 }}
          />

          {/* 表层高保真平滑连续折线 */}
          <motion.path
            key={`gold-line-${range}-${points.length}`}
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
              bounce: 0,
              duration: 0.55,
            }}
          />

          {/* 全向十字准星 HUD (Full Crosshair HUD) */}
          {hoverPoint && (
            <g pointerEvents="none">
              {/* 垂直虚线 */}
              <line
                x1={hoverX}
                x2={hoverX}
                y1={padding.top}
                y2={padding.top + innerH}
                stroke="currentColor"
                strokeOpacity="0.22"
                strokeDasharray="3 3"
              />
              {/* 水平虚线 */}
              <line
                x1={padding.left}
                x2={padding.left + innerW}
                y1={hoverY}
                y2={hoverY}
                stroke="currentColor"
                strokeOpacity="0.22"
                strokeDasharray="3 3"
              />

              {/* 左轴价格胶囊 */}
              <g>
                <rect
                  x={padding.left - 52}
                  y={hoverY - 8}
                  width={48}
                  height={16}
                  rx={3}
                  fill={hoverColor}
                />
                <text
                  x={padding.left - 6}
                  y={hoverY + 3.5}
                  textAnchor="end"
                  fontSize="10"
                  fontWeight="600"
                  fill="white"
                  className="font-mono tabular-nums"
                >
                  {hoverPoint.v.toFixed(2)}
                </text>
              </g>

              {/* 右轴百分比胶囊 */}
              {(() => {
                const pct = baselineValue > 0 ? ((hoverPoint.v - baselineValue) / baselineValue) * 100 : 0;
                return (
                  <g>
                    <rect
                      x={padding.left + innerW + 4}
                      y={hoverY - 8}
                      width={46}
                      height={16}
                      rx={3}
                      fill={hoverColor}
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
                      {`${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}
                    </text>
                  </g>
                );
              })()}

              {/* 底部时间胶囊 */}
              <g>
                <rect
                  x={hoverX - 28}
                  y={padding.top + innerH - 8}
                  width={56}
                  height={16}
                  rx={3}
                  fill={hoverColor}
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

              {/* 锚点同心圆 */}
              <circle
                cx={hoverX}
                cy={hoverY}
                r="5.5"
                fill="white"
                stroke={hoverColor}
                strokeWidth="2"
              />
              <circle cx={hoverX} cy={hoverY} r="2.5" fill={hoverColor} />
            </g>
          )}

          {/* 最新收盘点呼吸脉冲 */}
          {effectivePoints.length > 0 && (
            <motion.g
              key={`gold-dot-${effectivePoints.length}-${last}`}
              initial={prefersReducedMotion ? false : { scale: 0 }}
              animate={{
                scale: 1,
                opacity: hoverPoint != null && hoverIdx !== effectivePoints.length - 1 ? 0.3 : 1,
              }}
              transition={{
                type: 'spring' as const,
                bounce: 0,
                duration: 0.32,
                delay: 0.6,
              }}
              style={{ transformOrigin: `${xPos(effectivePoints.length - 1)}px ${yPos(last)}px` }}
              pointerEvents="none"
            >
              {!prefersReducedMotion && hoverIdx !== effectivePoints.length - 1 && (
                <motion.circle
                  cx={xPos(effectivePoints.length - 1)}
                  cy={yPos(last)}
                  r="4"
                  fill={trendColor}
                  animate={{ r: [4, 6.5, 4], opacity: [0.4, 0, 0.4] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                />
              )}
              <circle cx={xPos(effectivePoints.length - 1)} cy={yPos(last)} r="4" fill={trendColor} />
              <circle cx={xPos(effectivePoints.length - 1)} cy={yPos(last)} r="2" fill="white" />
            </motion.g>
          )}
        </svg>

        {/* ─── Tooltip — 锚点动态跟手防遮挡探针 (Anchor-Following Anti-Occlusion Tooltip) ─── */}
        {hoverPoint && (
          <motion.div
            key="gold-tooltip-wrapper"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring' as const, bounce: 0, duration: 0.18 }}
            className="pointer-events-none absolute z-20"
            style={{
              left: `${(hoverX / width) * 100}%`,
              top: `${(clampedTooltipY / height) * 100}%`,
            }}
          >
            <div
              className="px-3.5 py-2.5 rounded-2xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200/90 dark:border-slate-700/80 shadow-2xl text-[11px] min-w-[168px] w-max whitespace-nowrap select-none"
              style={{
                transform: isRightSide ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
                transition: prefersReducedMotion ? undefined : 'transform 0.14s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              <div className="flex items-center justify-between gap-3 mb-1.5 pb-1 border-b border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                <span className="shrink-0">{formatTooltipTime(hoverPoint.t, range)}</span>
                <span className="px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 font-sans text-[9px] shrink-0">
                  {hoverPoint.isClosed ? '周末休市' : range === 'intraday' ? '分钟点位' : '走势节点'}
                </span>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3.5">
                  <span className="text-slate-500 dark:text-slate-400 text-[10px] shrink-0">即时价位</span>
                  <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100 shrink-0">
                    {hoverPoint.v.toFixed(2)}
                    <span className="text-[10px] font-normal text-slate-400 ml-1 font-sans">{currency}/{unit}</span>
                  </span>
                </div>

                <div className="flex items-center justify-between gap-3.5">
                  <span className="text-slate-500 dark:text-slate-400 text-[10px] shrink-0">相对{baselineLabel}</span>
                  <div
                    className="flex items-center gap-1 font-mono font-semibold text-[11px] shrink-0 tabular-nums"
                    style={{ color: hoverColor }}
                  >
                    <span>{hoverChange > 0 ? '+' : ''}{hoverChange.toFixed(2)}</span>
                    <span>({hoverChangePct > 0 ? '+' : ''}{hoverChangePct.toFixed(2)}%)</span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* ─── 底部日内/区间金融关键指标微岛 (Financial Ribbon) ─── */}
      {dayStats && (
        <div className="mt-2.5 grid grid-cols-4 gap-1.5 sm:gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
          <div className="bg-slate-50/80 dark:bg-slate-800/40 rounded-xl p-2 text-center border border-slate-100/80 dark:border-slate-800/80">
            <div className="text-[10px] text-slate-400 dark:text-slate-500">区间最高</div>
            <div className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200 mt-0.5">
              {dayStats.high.toFixed(2)}
            </div>
            <div className="text-[9px] font-mono text-rose-500 font-semibold mt-0.5">
              +{dayStats.highPct.toFixed(2)}%
            </div>
          </div>

          <div className="bg-slate-50/80 dark:bg-slate-800/40 rounded-xl p-2 text-center border border-slate-100/80 dark:border-slate-800/80">
            <div className="text-[10px] text-slate-400 dark:text-slate-500">区间最低</div>
            <div className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200 mt-0.5">
              {dayStats.low.toFixed(2)}
            </div>
            <div className="text-[9px] font-mono text-emerald-500 font-semibold mt-0.5">
              {dayStats.lowPct > 0 ? '+' : ''}{dayStats.lowPct.toFixed(2)}%
            </div>
          </div>

          <div className="bg-slate-50/80 dark:bg-slate-800/40 rounded-xl p-2 text-center border border-slate-100/80 dark:border-slate-800/80">
            <div className="text-[10px] text-slate-400 dark:text-slate-500">区间振幅</div>
            <div className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200 mt-0.5">
              {dayStats.amplitude.toFixed(2)}%
            </div>
            <div className="text-[9px] text-slate-400 dark:text-slate-500 mt-0.5 font-sans">
              极值波动率
            </div>
          </div>

          <div className="bg-slate-50/80 dark:bg-slate-800/40 rounded-xl p-2 text-center border border-slate-100/80 dark:border-slate-800/80">
            <div className="text-[10px] text-slate-400 dark:text-slate-500">{dayStats.label}基准</div>
            <div className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200 mt-0.5">
              {dayStats.base.toFixed(2)}
            </div>
            <div className="text-[9px] text-slate-400 dark:text-slate-500 mt-0.5 font-mono">
              {currency}/{unit}
            </div>
          </div>
        </div>
      )}

      <div className="text-[10px] text-slate-400 text-center mt-1.5 font-mono">
        计价单位: {currency}/{unit}
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
