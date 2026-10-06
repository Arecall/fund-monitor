import { useEffect, useMemo, useRef, useState, useCallback, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Spin, Tooltip } from 'antd';
import { BarChart3, ZoomIn, ZoomOut, RotateCcw, Maximize2, ChevronLeft } from 'lucide-react';
import type { StockKLinePoint, StockKLinePeriod } from '../services/api';
import { useModalHistory } from '../utils/modalHistory';

export interface StockKLineChartProps {
  code: string;
  name?: string;
  market?: string;
  data: StockKLinePoint[];
  period: StockKLinePeriod;
  loading?: boolean;
  onPeriodChange: (period: StockKLinePeriod) => void;
  height?: number;
  /** 全屏视图模式标识（内部专用，避免全屏递归嵌套） */
  isFullscreenView?: boolean;
}

interface CandleWithMA extends StockKLinePoint {
  globalIndex: number;
  label: string;
  dateStr: string;
  ma1: number | null; // MA5
  ma2: number | null; // MA10
  ma3: number | null; // MA20
  ma4: number | null; // MA30
  ma5: number | null; // MA60
}

const KLINE_PERIODS: { key: StockKLinePeriod; label: string }[] = [
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
  { key: 'quarter', label: '季K' },
  { key: 'year', label: '年K' },
];

const MA_DEFINITIONS = [
  { key: 'ma1' as const, label: 'ma1', period: 5, color: '#1677ff' },   // Sky Blue
  { key: 'ma2' as const, label: 'ma2', period: 10, color: '#fa8c16' },  // Amber/Gold
  { key: 'ma3' as const, label: 'ma3', period: 20, color: '#eb2f96' },  // Pink/Magenta
  { key: 'ma4' as const, label: 'ma4', period: 30, color: '#13c2c2' },  // Teal/Cyan
  { key: 'ma5' as const, label: 'ma5', period: 60, color: '#722ed1' },  // Purple
];

const MIN_VISIBLE_BARS = 12;
const DEFAULT_VISIBLE_BARS = 70;

function formatPrice(value: number) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return value.toFixed(1);
  if (value >= 100) return value.toFixed(2);
  return value.toFixed(2);
}

function formatVolumeDisplay(value: number, market?: string) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const isShares = market === 'hk' || market === 'us';
  const unit = isShares ? '股' : '手';
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿${unit}`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(2)}万${unit}`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return `${value.toFixed(0)}${unit}`;
}

function formatVolumeAxis(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(0)}万`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return `${value.toFixed(0)}`;
}

function formatPeriodLabel(date: string, period: StockKLinePeriod) {
  if (!date) return '';
  if (period === 'year') return date.slice(0, 4);
  if (period === 'quarter') {
    const [year, month] = date.slice(0, 10).split('-').map(Number);
    return year && month ? `${year} Q${Math.ceil(month / 3)}` : date;
  }
  if (period === 'month') return date.slice(0, 7);
  return date.length >= 10 ? date.slice(5, 10) : date;
}

export function StockKLineChart(props: StockKLineChartProps) {
  const {
    code,
    name,
    market,
    data,
    period,
    loading = false,
    onPeriodChange,
    height = 380,
    isFullscreenView = false
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);

  // 全屏大图查看状态机
  const [isFullscreen, setIsFullscreen] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // 智能横屏感知（兼容系统竖屏锁定）
  const [needsVirtualLandscape, setNeedsVirtualLandscape] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < window.innerHeight && (window.innerWidth < 1024 || 'ontouchstart' in window);
  });

  useEffect(() => {
    const handleCheck = () => {
      setNeedsVirtualLandscape(
        window.innerWidth < window.innerHeight && (window.innerWidth < 1024 || 'ontouchstart' in window)
      );
    };
    window.addEventListener('resize', handleCheck);
    window.addEventListener('orientationchange', handleCheck);
    return () => {
      window.removeEventListener('resize', handleCheck);
      window.removeEventListener('orientationchange', handleCheck);
    };
  }, []);

  useModalHistory(isFullscreen, () => setIsFullscreen(false), { id: 'stock-kline-fullscreen-modal' });

  // Zoom & Pan Range: [startIdx, endIdx) in allBars
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

  // Drag interaction state
  const dragRef = useRef<{
    isDragging: boolean;
    startX: number;
    origStart: number;
    origEnd: number;
    pointerId: number;
  } | null>(null);
  const [isGrabbing, setIsGrabbing] = useState(false);

  // 1. Compute Full History with Moving Averages
  const allBars = useMemo<CandleWithMA[]>(() => {
    const valid = data.filter(bar => (
      Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0
    ));

    return valid.map((bar, index) => {
      const calcMA = (p: number) => {
        if (index < p - 1) return null;
        let sum = 0;
        for (let k = index - p + 1; k <= index; k++) {
          sum += valid[k].close;
        }
        return sum / p;
      };

      return {
        ...bar,
        globalIndex: index,
        dateStr: bar.date,
        label: formatPeriodLabel(bar.date, period),
        ma1: calcMA(5),
        ma2: calcMA(10),
        ma3: calcMA(20),
        ma4: calcMA(30),
        ma5: calcMA(60),
      };
    });
  }, [data, period]);

  // 2. Initialize or reset visible range when code, period, or dataset size changes
  useEffect(() => {
    const total = allBars.length;
    if (total === 0) {
      setVisibleRange({ start: 0, end: 0 });
      return;
    }
    const count = Math.min(total, DEFAULT_VISIBLE_BARS);
    setVisibleRange({
      start: Math.max(0, total - count),
      end: total,
    });
    setHoverIndex(null);
    setHoverPrice(null);
  }, [code, period, allBars.length]);

  // 3. Responsive Resize
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width ?? 640;
      setWidth(Math.max(280, nextWidth));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // 4. Sliced visible bars
  const visibleBars = useMemo<CandleWithMA[]>(() => {
    if (allBars.length === 0) return [];
    const start = Math.max(0, Math.min(visibleRange.start, allBars.length - 1));
    const end = Math.max(start + 1, Math.min(visibleRange.end, allBars.length));
    return allBars.slice(start, end);
  }, [allBars, visibleRange]);

  // 5. Chart Layout Geometry
  const geometry = useMemo(() => {
    const padding = { top: 28, right: 58, bottom: 22, left: 10 };
    const volumeHeight = Math.max(50, Math.round(height * 0.22));
    const volumeGap = 20;
    const priceHeight = Math.max(100, height - padding.top - padding.bottom - volumeHeight - volumeGap);
    const drawableWidth = Math.max(1, width - padding.left - padding.right);

    // Visible price range
    let high = 0;
    let low = Infinity;
    let highestLocalIdx = 0;
    let lowestLocalIdx = 0;

    visibleBars.forEach((bar, idx) => {
      if (bar.high > high) {
        high = bar.high;
        highestLocalIdx = idx;
      }
      if (bar.low < low) {
        low = bar.low;
        lowestLocalIdx = idx;
      }
    });

    if (!Number.isFinite(low) || low <= 0) low = 1;
    if (high <= low) high = low * 1.05;

    const rawSpan = Math.max(high - low, high * 0.005);
    const maxPrice = high + rawSpan * 0.08;
    const minPrice = Math.max(0, low - rawSpan * 0.08);
    const priceSpan = Math.max(maxPrice - minPrice, 0.0001);

    // Visible volume range
    const maxVolume = Math.max(...visibleBars.map(bar => bar.volume || 0), 1);

    const slotWidth = drawableWidth / Math.max(visibleBars.length, 1);
    const bodyWidth = Math.max(1.5, Math.min(18, slotWidth * 0.68));

    const x = (localIndex: number) => padding.left + slotWidth * (localIndex + 0.5);
    const priceY = (price: number) => padding.top + ((maxPrice - price) / priceSpan) * priceHeight;
    const volumeY = (volume: number) => padding.top + priceHeight + volumeGap + volumeHeight - (Math.max(0, volume) / maxVolume) * volumeHeight;

    const priceFromY = (y: number) => {
      const ratio = (y - padding.top) / priceHeight;
      return maxPrice - ratio * priceSpan;
    };

    return {
      padding,
      priceHeight,
      volumeHeight,
      volumeGap,
      drawableWidth,
      maxPrice,
      minPrice,
      priceSpan,
      high,
      low,
      highestLocalIdx,
      lowestLocalIdx,
      maxVolume,
      slotWidth,
      bodyWidth,
      x,
      priceY,
      volumeY,
      priceFromY,
    };
  }, [visibleBars, height, width]);

  // 6. Wheel Zoom Handler (Centered on cursor)
  const handleZoom = useCallback((delta: number, clientX?: number) => {
    const total = allBars.length;
    if (total <= MIN_VISIBLE_BARS) return;

    setVisibleRange(prev => {
      const curCount = prev.end - prev.start;
      const factor = delta > 0 ? 1.18 : 0.82;
      const nextCount = Math.max(MIN_VISIBLE_BARS, Math.min(total, Math.round(curCount * factor)));
      if (nextCount === curCount) return prev;

      // Mouse X ratio
      let ratio = 0.5;
      if (clientX !== undefined && svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        ratio = Math.max(0, Math.min(1, (clientX - rect.left - geometry.padding.left) / geometry.drawableWidth));
      }

      const diff = nextCount - curCount;
      let newStart = Math.round(prev.start - diff * (1 - ratio));
      let newEnd = newStart + nextCount;

      if (newStart < 0) {
        newEnd += (0 - newStart);
        newStart = 0;
      }
      if (newEnd > total) {
        newStart -= (newEnd - total);
        newEnd = total;
      }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(total, Math.max(newStart + MIN_VISIBLE_BARS, newEnd));

      return { start: newStart, end: newEnd };
    });
  }, [allBars.length, geometry.drawableWidth, geometry.padding.left]);

  // Non-passive wheel listener on container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) > 2) {
        e.preventDefault();
        e.stopPropagation();
        handleZoom(e.deltaY, e.clientX);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [handleZoom]);

  // 7. Reset Zoom & Pan
  const handleResetZoom = () => {
    const total = allBars.length;
    if (total === 0) return;
    const count = Math.min(total, DEFAULT_VISIBLE_BARS);
    setVisibleRange({
      start: Math.max(0, total - count),
      end: total,
    });
  };

  // 8. Pointer Drag & Hover Handlers
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (visibleBars.length === 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture fails
    }
    let startX = e.clientX;
    const ctm = e.currentTarget.getScreenCTM();
    if (ctm) {
      const pt = e.currentTarget.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      startX = pt.matrixTransform(ctm.inverse()).x;
    }
    dragRef.current = {
      isDragging: false,
      startX,
      origStart: visibleRange.start,
      origEnd: visibleRange.end,
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (visibleBars.length === 0) return;

    let localX = e.clientX;
    let localY = e.clientY;
    const ctm = e.currentTarget.getScreenCTM();
    if (ctm) {
      const pt = e.currentTarget.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const local = pt.matrixTransform(ctm.inverse());
      localX = local.x;
      localY = local.y;
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      localX = e.clientX - rect.left;
      localY = e.clientY - rect.top;
    }

    // Handle Drag / Pan
    if (dragRef.current) {
      const deltaX = localX - dragRef.current.startX;
      if (!dragRef.current.isDragging && Math.abs(deltaX) > 3) {
        dragRef.current.isDragging = true;
        setIsGrabbing(true);
      }

      if (dragRef.current.isDragging) {
        const total = allBars.length;
        const curCount = dragRef.current.origEnd - dragRef.current.origStart;
        const barDelta = Math.round(deltaX / geometry.slotWidth);

        // Drag right (deltaX > 0) -> move into the past (decrease start/end)
        let newStart = dragRef.current.origStart - barDelta;
        let newEnd = newStart + curCount;

        if (newStart < 0) {
          newStart = 0;
          newEnd = curCount;
        }
        if (newEnd > total) {
          newEnd = total;
          newStart = Math.max(0, total - curCount);
        }

        setVisibleRange({ start: newStart, end: newEnd });
        setHoverIndex(null);
        setHoverPrice(null);
        return;
      }
    }

    // Normal Hover Crosshair
    const mouseX = localX;
    const mouseY = localY;

    const relative = (mouseX - geometry.padding.left) / geometry.drawableWidth;
    const localIdx = Math.max(0, Math.min(visibleBars.length - 1, Math.floor(relative * visibleBars.length)));
    setHoverIndex(localIdx);

    if (mouseY >= geometry.padding.top && mouseY <= geometry.padding.top + geometry.priceHeight) {
      setHoverPrice(geometry.priceFromY(mouseY));
    } else {
      setHoverPrice(null);
    }
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    if (dragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(dragRef.current.pointerId);
      } catch {
        // Ignore
      }
      dragRef.current = null;
    }
    setIsGrabbing(false);
  };

  // 9. Active bar for legends (Hovered or latest in visible view)
  const latestVisibleBar = visibleBars.length > 0 ? visibleBars[visibleBars.length - 1] : null;
  const activeBar = hoverIndex !== null ? visibleBars[hoverIndex] ?? latestVisibleBar : latestVisibleBar;

  // 10. MA SVG Paths for Visible Slice
  const maPaths = useMemo(() => {
    return MA_DEFINITIONS.map(def => {
      let pathStr = '';
      let isFirst = true;
      visibleBars.forEach((bar, idx) => {
        const val = bar[def.key];
        if (val !== null && Number.isFinite(val)) {
          const px = geometry.x(idx);
          const py = geometry.priceY(val);
          if (isFirst) {
            pathStr += `M ${px.toFixed(1)} ${py.toFixed(1)}`;
            isFirst = false;
          } else {
            pathStr += ` L ${px.toFixed(1)} ${py.toFixed(1)}`;
          }
        }
      });
      return { ...def, path: pathStr };
    });
  }, [visibleBars, geometry]);

  // 11. Date Scale Ticks (6 to 9 ticks)
  const dateTicks = useMemo(() => {
    if (visibleBars.length === 0) return [];
    const count = Math.min(visibleBars.length, width > 600 ? 8 : 4);
    const ticks: { index: number; label: string; x: number }[] = [];
    const step = (visibleBars.length - 1) / Math.max(1, count - 1);

    for (let i = 0; i < count; i++) {
      const idx = Math.min(visibleBars.length - 1, Math.round(i * step));
      if (visibleBars[idx] && !ticks.some(t => t.index === idx)) {
        ticks.push({
          index: idx,
          label: visibleBars[idx].label,
          x: geometry.x(idx),
        });
      }
    }
    return ticks;
  }, [visibleBars, geometry, width]);

  // 12. Price Grid Ticks
  const priceGridTicks = useMemo(() => {
    const ratios = [0, 0.25, 0.5, 0.75, 1];
    return ratios.map(ratio => {
      const y = geometry.padding.top + geometry.priceHeight * ratio;
      const value = geometry.maxPrice - (geometry.maxPrice - geometry.minPrice) * ratio;
      return { y, value };
    });
  }, [geometry]);

  const marketLabel = market === 'us' ? '美股' : market === 'hk' ? '港股' : 'A股';
  const periodLabel = KLINE_PERIODS.find(item => item.key === period)?.label || '日K';

  // Last bar / Current price reference line (Global latest)
  const latestGlobalBar = allBars.length > 0 ? allBars[allBars.length - 1] : null;
  const lastClose = latestGlobalBar?.close ?? null;
  const prevClose = allBars.length >= 2 ? allBars[allBars.length - 2].close : (latestGlobalBar?.open ?? lastClose);
  const isLastUp = lastClose !== null && prevClose !== null ? lastClose >= prevClose : true;
  const currentPriceColor = isLastUp ? 'var(--color-up)' : 'var(--color-down)';

  const isZoomed = allBars.length > 0 && (visibleRange.end - visibleRange.start < allBars.length || visibleRange.end < allBars.length);

  return (
    <section className={isFullscreenView ? "w-full select-none" : "rounded-2xl border border-[var(--hairline-border)] bg-white/60 dark:bg-white/[0.03] p-3 sm:p-4 shadow-sm backdrop-blur-sm"}>
      {/* Top Header Deck (全屏内嵌时隐藏，由全屏专属主控甲板接管；标准化双甲板架构，对标分时图) */}
      {!isFullscreenView && (
        <div className="flex flex-col gap-2 mb-2.5 px-0.5">
          {/* Deck 1: 元信息与全局视图控制 (两端对齐，全屏按钮右上角绝对锚定) */}
          <div className="flex items-center justify-between gap-1.5 sm:gap-2 min-w-0">
            {/* 左侧：K线标题 + 市场标的复权状态 */}
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <BarChart3 size={15} className="text-[var(--primary-accent)] shrink-0" />
              <h4 className="apple-display-heading text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 truncate">
                {periodLabel}线
              </h4>
              <span className="text-[10px] text-slate-400 font-mono shrink-0">
                {marketLabel} · 前复权
              </span>
              {allBars.length > 0 && (
                <span className="text-[10px] text-slate-400/80 font-mono hidden md:inline shrink-0">
                  (显示 {visibleBars.length}/{allBars.length} 根)
                </span>
              )}
            </div>

            {/* 右侧：缩放控制器组 (桌面端) + 一键全屏查看按钮 (绝对靠右对齐) */}
            <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
              {/* 滚轮缩放与复位组 (移动端隐藏，桌面端展开) */}
              <div className="hidden sm:flex items-center gap-0.5 bg-slate-100/70 dark:bg-white/5 p-0.5 rounded-full border border-[var(--hairline-border)]">
                <Tooltip title="滚轮向上或点击放大 (Zoom In)" placement="top">
                  <button
                    type="button"
                    onClick={() => handleZoom(-1)}
                    disabled={visibleBars.length <= MIN_VISIBLE_BARS}
                    className="p-1 rounded-full text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                    aria-label="放大K线"
                  >
                    <ZoomIn size={13} />
                  </button>
                </Tooltip>
                <Tooltip title="滚轮向下或点击缩小 (Zoom Out)" placement="top">
                  <button
                    type="button"
                    onClick={() => handleZoom(1)}
                    disabled={visibleBars.length >= allBars.length}
                    className="p-1 rounded-full text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                    aria-label="缩小K线"
                  >
                    <ZoomOut size={13} />
                  </button>
                </Tooltip>
                {isZoomed && (
                  <Tooltip title="重置视角 (查看最新K线)" placement="top">
                    <button
                      type="button"
                      onClick={handleResetZoom}
                      className="p-1 rounded-full text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer"
                      aria-label="重置缩放"
                    >
                      <RotateCcw size={13} />
                    </button>
                  </Tooltip>
                )}
              </div>

              {/* 一键全屏大图查看按钮 (尺寸与分时图统一: w-6 h-6 sm:w-7 sm:h-7) */}
              <button
                type="button"
                onClick={() => setIsFullscreen(true)}
                title="全屏查看K线大图"
                aria-label="全屏查看K线大图"
                className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100 bg-slate-100/80 dark:bg-white/5 hover:bg-slate-200/80 dark:hover:bg-white/10 border border-slate-200/60 dark:border-white/10 rounded-full transition-all shrink-0 cursor-pointer"
              >
                <Maximize2 size={12} />
              </button>
            </div>
          </div>

          {/* Deck 2: 维度切换与度量指示层 */}
          <div className="flex items-center justify-between gap-1.5 min-w-0">
            {/* 左侧：K线周期切换胶囊栏 */}
            <div className="inline-flex rounded-full bg-slate-100/80 dark:bg-white/5 p-0.5 sm:p-1 border border-[var(--hairline-border)] shrink-0">
              {KLINE_PERIODS.map(item => (
                <button
                  key={item.key}
                  type="button"
                  disabled={loading}
                  onClick={() => onPeriodChange(item.key)}
                  className={`whitespace-nowrap shrink-0 select-none rounded-full px-2 sm:px-3 py-0.5 sm:py-1 text-[11px] sm:text-xs font-semibold transition-all duration-200 disabled:opacity-50 cursor-pointer ${
                    period === item.key
                      ? 'bg-[var(--primary-accent)] text-white shadow-xs'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              ))}
            </div>

            {/* 右侧微副标：展示当前定位K线或最新K线收盘价与涨跌幅 (消除右侧负空间死白) */}
            {activeBar && (
              <div className="flex items-baseline gap-1 sm:gap-1.5 font-mono text-xs shrink-0 pl-1">
                <span className="font-bold text-slate-800 dark:text-slate-100 text-xs sm:text-sm tabular-nums whitespace-nowrap">
                  {formatPrice(activeBar.close)}
                </span>
                {(() => {
                  const chgAmt = activeBar.close - activeBar.open;
                  const chgPct = activeBar.open > 0 ? (chgAmt / activeBar.open) * 100 : 0;
                  const isUp = chgAmt > 0;
                  const isDown = chgAmt < 0;
                  return (
                    <span
                      className="font-semibold text-[10px] sm:text-[11px] tabular-nums whitespace-nowrap"
                      style={{
                        color: isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : 'var(--color-flat)'
                      }}
                    >
                      {chgPct > 0 ? '+' : ''}{chgPct.toFixed(2)}%
                    </span>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SVG Canvas Area */}
      <div
        ref={containerRef}
        className={`relative min-h-[260px] select-none ${isGrabbing ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        {loading ? (
          <div className="flex h-[380px] items-center justify-center">
            <Spin size="large" tip="K 线与均线计算中..." />
          </div>
        ) : visibleBars.length < 2 ? (
          <div className="flex h-[380px] flex-col items-center justify-center gap-2 text-sm text-slate-400">
            <BarChart3 size={24} strokeWidth={1.5} />
            <span>暂无可用 {periodLabel} 数据</span>
          </div>
        ) : (
          <>
            <svg
              ref={svgRef}
              width={width}
              height={height}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => {
                if (!dragRef.current?.isDragging) {
                  setHoverIndex(null);
                  setHoverPrice(null);
                }
              }}
              className="block touch-none"
              aria-label={`${code} ${periodLabel}图`}
            >
              {/* 1. Main Price Panel Grid Lines & Right Axis Labels */}
              {priceGridTicks.map(({ y, value }, idx) => (
                <g key={idx}>
                  <line
                    x1={geometry.padding.left}
                    x2={width - geometry.padding.right}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    strokeOpacity="0.08"
                    strokeDasharray="2 3"
                  />
                  <text
                    x={width - geometry.padding.right + 6}
                    y={y + 3.5}
                    className="fill-slate-400 dark:fill-slate-500"
                    fontSize="10"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                  >
                    {formatPrice(value)}
                  </text>
                </g>
              ))}

              {/* 2. Top Legend: MA Indicators (Active/Latest) */}
              <g transform={`translate(${geometry.padding.left}, 15)`}>
                <text
                  x={0}
                  y={0}
                  className="fill-slate-400 dark:fill-slate-500 font-bold"
                  fontSize="11"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  MA
                </text>
                {MA_DEFINITIONS.map((def, i) => {
                  const val = activeBar ? activeBar[def.key] : null;
                  const xOffset = 30 + i * (width > 500 ? 76 : 64);
                  return (
                    <text
                      key={def.key}
                      x={xOffset}
                      y={0}
                      fill={def.color}
                      fontSize="10.5"
                      fontWeight="600"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {def.label}:{val !== null ? formatPrice(val) : '—'}
                    </text>
                  );
                })}
              </g>

              {/* 3. Candlesticks (K-lines) */}
              {visibleBars.map((bar, localIndex) => {
                const isUp = bar.close >= bar.open;
                const candleColor = isUp ? 'var(--color-up)' : 'var(--color-down)';
                const cx = geometry.x(localIndex);
                const openY = geometry.priceY(bar.open);
                const closeY = geometry.priceY(bar.close);
                const highY = geometry.priceY(bar.high);
                const lowY = geometry.priceY(bar.low);
                const bodyY = Math.min(openY, closeY);
                const bodyHeight = Math.max(1.2, Math.abs(closeY - openY));

                const isDimmed = hoverIndex !== null && hoverIndex !== localIndex;

                return (
                  <g
                    key={`${bar.dateStr}-${bar.globalIndex}`}
                    opacity={isDimmed ? 0.45 : 1}
                    className="transition-opacity duration-150"
                  >
                    {/* Shadow / Wick line */}
                    <line
                      x1={cx}
                      x2={cx}
                      y1={highY}
                      y2={lowY}
                      stroke={candleColor}
                      strokeWidth="1"
                    />
                    {/* Candle Body */}
                    <rect
                      x={cx - geometry.bodyWidth / 2}
                      y={bodyY}
                      width={geometry.bodyWidth}
                      height={bodyHeight}
                      fill={candleColor}
                      stroke={candleColor}
                      strokeWidth="0.5"
                      rx="0.5"
                    />
                  </g>
                );
              })}

              {/* 4. Moving Average (MA) Curve Polylines */}
              {maPaths.map(def => (
                <path
                  key={def.key}
                  d={def.path}
                  fill="none"
                  stroke={def.color}
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={hoverIndex !== null ? 0.75 : 0.95}
                />
              ))}

              {/* 5. Extreme Points (Highest / Lowest Price Markers in Visible Slice) */}
              {visibleBars.length > 0 && (
                <>
                  {/* Highest Point Marker */}
                  {(() => {
                    const hBar = visibleBars[geometry.highestLocalIdx];
                    if (!hBar) return null;
                    const hx = geometry.x(geometry.highestLocalIdx);
                    const hy = geometry.priceY(hBar.high);
                    const isRightSide = hx > width - geometry.padding.right - 80;
                    const textX = isRightSide ? hx - 8 : hx + 8;
                    const anchor = isRightSide ? 'end' : 'start';
                    const cornerPath = isRightSide
                      ? `M ${hx} ${hy} L ${hx} ${hy - 6} L ${hx - 6} ${hy - 6}`
                      : `M ${hx} ${hy} L ${hx} ${hy - 6} L ${hx + 6} ${hy - 6}`;

                    return (
                      <g className="pointer-events-none">
                        <circle cx={hx} cy={hy} r="1.5" className="fill-slate-600 dark:fill-slate-300" />
                        <path d={cornerPath} fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" />
                        <text
                          x={textX}
                          y={hy - 8}
                          textAnchor={anchor}
                          className="fill-slate-600 dark:fill-slate-300"
                          fontSize="9.5"
                          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                          fontWeight="bold"
                        >
                          {formatPrice(hBar.high)}
                        </text>
                      </g>
                    );
                  })()}

                  {/* Lowest Point Marker */}
                  {(() => {
                    const lBar = visibleBars[geometry.lowestLocalIdx];
                    if (!lBar) return null;
                    const lx = geometry.x(geometry.lowestLocalIdx);
                    const ly = geometry.priceY(lBar.low);
                    const isRightSide = lx > width - geometry.padding.right - 80;
                    const textX = isRightSide ? lx - 8 : lx + 8;
                    const anchor = isRightSide ? 'end' : 'start';
                    const cornerPath = isRightSide
                      ? `M ${lx} ${ly} L ${lx} ${ly + 6} L ${lx - 6} ${ly + 6}`
                      : `M ${lx} ${ly} L ${lx} ${ly + 6} L ${lx + 6} ${ly + 6}`;

                    return (
                      <g className="pointer-events-none">
                        <circle cx={lx} cy={ly} r="1.5" className="fill-slate-600 dark:fill-slate-300" />
                        <path d={cornerPath} fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" />
                        <text
                          x={textX}
                          y={ly + 14}
                          textAnchor={anchor}
                          className="fill-slate-600 dark:fill-slate-300"
                          fontSize="9.5"
                          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                          fontWeight="bold"
                        >
                          {formatPrice(lBar.low)}
                        </text>
                      </g>
                    );
                  })()}
                </>
              )}

              {/* 6. Current Price Reference Dashed Line & Badge */}
              {lastClose !== null && (
                <g className="pointer-events-none">
                  {/* Horizontal Dashed Line */}
                  <line
                    x1={geometry.padding.left}
                    x2={width - geometry.padding.right}
                    y1={geometry.priceY(lastClose)}
                    y2={geometry.priceY(lastClose)}
                    stroke={currentPriceColor}
                    strokeDasharray="3 3"
                    strokeWidth="1"
                    strokeOpacity="0.8"
                  />
                  {/* Right Axis Current Price Badge */}
                  <rect
                    x={width - geometry.padding.right + 2}
                    y={geometry.priceY(lastClose) - 9}
                    width={geometry.padding.right - 4}
                    height={18}
                    rx="3"
                    fill={currentPriceColor}
                  />
                  <text
                    x={width - geometry.padding.right + 4 + (geometry.padding.right - 8) / 2}
                    y={geometry.priceY(lastClose) + 3.5}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize="10"
                    fontWeight="bold"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {formatPrice(lastClose)}
                  </text>
                </g>
              )}

              {/* 7. Volume Panel Separator & Legend */}
              <line
                x1={geometry.padding.left}
                x2={width - geometry.padding.right}
                y1={geometry.padding.top + geometry.priceHeight + geometry.volumeGap / 2}
                y2={geometry.padding.top + geometry.priceHeight + geometry.volumeGap / 2}
                stroke="currentColor"
                strokeOpacity="0.12"
              />

              {/* Volume Legend */}
              <g transform={`translate(${geometry.padding.left}, ${geometry.padding.top + geometry.priceHeight + geometry.volumeGap - 4})`}>
                <text
                  x={0}
                  y={0}
                  className="fill-slate-400 dark:fill-slate-500 font-bold"
                  fontSize="10"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  VOL
                </text>
                <text
                  x={32}
                  y={0}
                  fill="#1677ff"
                  fontSize="10"
                  fontWeight="600"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  volume:{activeBar ? formatVolumeDisplay(activeBar.volume || 0, market) : '—'}
                </text>
              </g>

              {/* Volume Right Y-axis Scale Labels */}
              <text
                x={width - geometry.padding.right + 6}
                y={geometry.padding.top + geometry.priceHeight + geometry.volumeGap + 10}
                className="fill-slate-400 dark:fill-slate-500"
                fontSize="9"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {formatVolumeAxis(geometry.maxVolume)}
              </text>
              <text
                x={width - geometry.padding.right + 6}
                y={geometry.padding.top + geometry.priceHeight + geometry.volumeGap + geometry.volumeHeight / 2 + 3}
                className="fill-slate-400 dark:fill-slate-500"
                fontSize="9"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {formatVolumeAxis(geometry.maxVolume / 2)}
              </text>
              <text
                x={width - geometry.padding.right + 6}
                y={geometry.padding.top + geometry.priceHeight + geometry.volumeGap + geometry.volumeHeight}
                className="fill-slate-400 dark:fill-slate-500"
                fontSize="9"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                0
              </text>

              {/* 8. Volume Bars */}
              {visibleBars.map((bar, localIndex) => {
                const isUp = bar.close >= bar.open;
                const candleColor = isUp ? 'var(--color-up)' : 'var(--color-down)';
                const cx = geometry.x(localIndex);
                const vTop = geometry.volumeY(bar.volume || 0);
                const vBottom = geometry.padding.top + geometry.priceHeight + geometry.volumeGap + geometry.volumeHeight;
                const vHeight = Math.max(1, vBottom - vTop);
                const isDimmed = hoverIndex !== null && hoverIndex !== localIndex;

                return (
                  <rect
                    key={`vol-${bar.dateStr}-${bar.globalIndex}`}
                    x={cx - geometry.bodyWidth / 2}
                    y={vTop}
                    width={geometry.bodyWidth}
                    height={vHeight}
                    fill={candleColor}
                    opacity={isDimmed ? 0.35 : 0.85}
                    rx="0.5"
                  />
                );
              })}

              {/* 9. Bottom X-axis Date Scale Ticks */}
              {dateTicks.map(({ index, label, x }) => {
                const isFirst = index === 0;
                const isLast = index === visibleBars.length - 1;
                const anchor = isFirst ? 'start' : isLast ? 'end' : 'middle';
                return (
                  <text
                    key={`tick-${index}`}
                    x={x}
                    y={height - 4}
                    textAnchor={anchor}
                    className="fill-slate-400 dark:fill-slate-500"
                    fontSize="9.5"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {label}
                  </text>
                );
              })}

              {/* 10. Crosshairs on Hover */}
              {hoverIndex !== null && visibleBars[hoverIndex] && !isGrabbing && (
                <g className="pointer-events-none">
                  {/* Vertical Crosshair Line */}
                  <line
                    x1={geometry.x(hoverIndex)}
                    x2={geometry.x(hoverIndex)}
                    y1={geometry.padding.top}
                    y2={geometry.padding.top + geometry.priceHeight + geometry.volumeGap + geometry.volumeHeight}
                    stroke="currentColor"
                    strokeOpacity="0.3"
                    strokeDasharray="3 3"
                  />

                  {/* Horizontal Crosshair Line in Price Panel */}
                  {hoverPrice !== null && (
                    <>
                      <line
                        x1={geometry.padding.left}
                        x2={width - geometry.padding.right}
                        y1={geometry.priceY(hoverPrice)}
                        y2={geometry.priceY(hoverPrice)}
                        stroke="currentColor"
                        strokeOpacity="0.3"
                        strokeDasharray="3 3"
                      />
                      {/* Price Badge on Right Axis */}
                      <rect
                        x={width - geometry.padding.right + 2}
                        y={geometry.priceY(hoverPrice) - 8}
                        width={geometry.padding.right - 4}
                        height={16}
                        rx="2"
                        className="fill-slate-800 dark:fill-slate-200"
                      />
                      <text
                        x={width - geometry.padding.right + 4 + (geometry.padding.right - 8) / 2}
                        y={geometry.priceY(hoverPrice) + 3.5}
                        textAnchor="middle"
                        className="fill-white dark:fill-slate-900"
                        fontSize="9.5"
                        fontWeight="bold"
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      >
                        {formatPrice(hoverPrice)}
                      </text>
                    </>
                  )}
                </g>
              )}
            </svg>

            {/* Floating HUD Tooltip on Hover */}
            {hoveredDetail(hoverIndex, visibleBars, market, formatPrice, formatVolumeDisplay, isGrabbing)}
          </>
        )}
      </div>

      {/* ── 沉浸式K线全屏大图模态 (支持系统竖屏锁定兼容的虚拟横屏) ── */}
      {!isFullscreenView && isFullscreen && typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          <motion.div
            key="stock-kline-fullscreen-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${name || code} K线图全屏大图`}
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed z-[10001] bg-[#090a0f] text-white flex flex-col overflow-hidden select-none"
            style={{
              ...(needsVirtualLandscape
                ? {
                    top: '50%',
                    left: '50%',
                    width: '100dvh',
                    height: '100dvw',
                    maxWidth: '100dvh',
                    maxHeight: '100dvw',
                    transform: 'translate(-50%, -50%) rotate(90deg)',
                    transformOrigin: 'center center',
                    paddingLeft: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
                    paddingRight: 'calc(env(safe-area-inset-top, 0px) + 16px)',
                    paddingTop: '6px',
                    paddingBottom: '6px',
                  }
                : {
                    top: 0,
                    left: 0,
                    width: '100vw',
                    height: '100vh',
                    transform: 'none',
                    paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 16px)',
                    paddingRight: 'calc(env(safe-area-inset-right, 0px) + 16px)',
                    paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)',
                    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
                  }),
            }}
          >
            {/* ── 顶部 Single Master Landscape Deck (高度锁定 42px) ── */}
            <header className="h-[42px] min-h-[42px] max-h-[42px] flex items-center justify-between gap-3 border-b border-white/10 shrink-0 px-2">
              {/* 左翼：退出控制 + 标的识别 */}
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => setIsFullscreen(false)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/10 hover:bg-white/20 active:bg-white/30 text-white transition-all cursor-pointer shrink-0 select-none"
                  aria-label="退出全屏"
                >
                  <ChevronLeft size={14} />
                  <span>退出</span>
                </button>

                <div className="h-4 w-px bg-white/15 shrink-0" />

                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-bold text-sm text-white truncate max-w-[150px] sm:max-w-[220px]">
                    {name || code}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400 shrink-0 px-1.5 py-0.5 rounded bg-white/5 border border-white/10">
                    {code}
                  </span>
                  <span className="text-[10px] text-slate-400/80 font-mono shrink-0">
                    {marketLabel} · 前复权
                  </span>
                </div>
              </div>

              {/* 中轴：最新收盘价与涨跌幅微岛 */}
              {latestGlobalBar && (
                <div className="flex items-baseline gap-2 font-mono shrink-0">
                  <span className="text-xl sm:text-2xl font-extrabold text-white tabular-nums tracking-tight">
                    ¥{formatPrice(latestGlobalBar.close)}
                  </span>
                  <span
                    className="font-bold text-xs sm:text-sm tabular-nums"
                    style={{ color: currentPriceColor }}
                  >
                    {isLastUp ? '+' : ''}{prevClose !== null && prevClose > 0 ? (((latestGlobalBar.close - prevClose) / prevClose) * 100).toFixed(2) : '0.00'}%
                  </span>
                </div>
              )}

              {/* 右翼：全屏周期切换胶囊栏 */}
              <div className="flex items-center gap-2 shrink-0">
                <div className="inline-flex bg-white/5 border border-white/10 rounded-xl p-0.5">
                  {KLINE_PERIODS.map(item => {
                    const active = item.key === period;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => onPeriodChange(item.key)}
                        className={`relative px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors select-none cursor-pointer ${
                          active ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {active && (
                          <motion.span
                            layoutId="master-deck-kline-active"
                            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                            className="absolute inset-0 rounded-lg shadow-sm"
                            style={{ background: 'var(--primary-accent)' }}
                          />
                        )}
                        <span className="relative z-10 whitespace-nowrap">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </header>

            {/* ── 中间图表画布：净空撑满视口 ── */}
            <div className="flex-1 w-full min-h-0 pt-1 overflow-hidden flex flex-col justify-center">
              <StockKLineChart
                {...props}
                isFullscreenView={true}
                height={Math.max(220, (needsVirtualLandscape ? (typeof window !== 'undefined' ? window.innerWidth : 390) : (typeof window !== 'undefined' ? window.innerHeight : 844)) - 42 - 34 - 16)}
              />
            </div>

            {/* ── 底栏指标条 (Bottom Metrics Strip，高度锁定 34px) ── */}
            <footer className="h-[34px] min-h-[34px] max-h-[34px] flex items-center justify-between border-t border-white/10 px-3 text-[11px] font-mono text-slate-400 shrink-0">
              <div className="flex items-center gap-3 sm:gap-6 tabular-nums overflow-hidden whitespace-nowrap">
                {activeBar ? (
                  <>
                    <span className="text-slate-300 font-bold">{activeBar.dateStr}</span>
                    <span>开 <strong className="text-white">{formatPrice(activeBar.open)}</strong></span>
                    <span>高 <strong className="text-[var(--color-up)]">{formatPrice(activeBar.high)}</strong></span>
                    <span>低 <strong className="text-[var(--color-down)]">{formatPrice(activeBar.low)}</strong></span>
                    <span>收 <strong className="text-white">{formatPrice(activeBar.close)}</strong></span>
                    <span>量 <strong className="text-blue-400">{formatVolumeDisplay(activeBar.volume, market)}</strong></span>
                  </>
                ) : (
                  <span>滑动或悬浮蜡烛查看详细点位与量价指标</span>
                )}
              </div>
              <div className="hidden sm:flex items-center gap-3 text-[10px] text-slate-500">
                <span>MA5: {activeBar?.ma1 ? formatPrice(activeBar.ma1) : '—'}</span>
                <span>MA10: {activeBar?.ma2 ? formatPrice(activeBar.ma2) : '—'}</span>
                <span>MA20: {activeBar?.ma3 ? formatPrice(activeBar.ma3) : '—'}</span>
              </div>
            </footer>
          </motion.div>
        </AnimatePresence>,
        document.body
      )}
    </section>
  );
}

function hoveredDetail(
  hoverIndex: number | null,
  bars: CandleWithMA[],
  market: string | undefined,
  fmtP: (v: number) => string,
  fmtV: (v: number, m?: string) => string,
  isGrabbing: boolean
) {
  if (hoverIndex === null || !bars[hoverIndex] || isGrabbing) return null;
  const bar = bars[hoverIndex];
  const prevBar = hoverIndex > 0 ? bars[hoverIndex - 1] : null;
  const changePct = prevBar && prevBar.close > 0
    ? ((bar.close - prevBar.close) / prevBar.close) * 100
    : 0;
  const isUp = changePct >= 0;

  return (
    <div className="pointer-events-none absolute right-16 top-10 z-20 rounded-xl border border-[var(--hairline-border)] bg-white/95 px-3 py-2.5 shadow-xl backdrop-blur-md dark:bg-[#1c1c1e]/95 text-xs">
      <div className="mb-1.5 flex items-center justify-between gap-3 border-b border-slate-100 dark:border-white/10 pb-1">
        <span className="font-mono font-bold text-slate-700 dark:text-slate-200">{bar.dateStr}</span>
        <span className={`font-mono font-bold ${isUp ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
          {isUp ? '+' : ''}{changePct.toFixed(2)}%
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums">
        <span className="text-slate-400">开盘 <b className="ml-1 text-slate-700 dark:text-slate-200">{fmtP(bar.open)}</b></span>
        <span className="text-slate-400">收盘 <b className="ml-1 text-slate-700 dark:text-slate-200">{fmtP(bar.close)}</b></span>
        <span className="text-slate-400">最高 <b className="ml-1 text-slate-700 dark:text-slate-200">{fmtP(bar.high)}</b></span>
        <span className="text-slate-400">最低 <b className="ml-1 text-slate-700 dark:text-slate-200">{fmtP(bar.low)}</b></span>
        <span className="col-span-2 text-slate-400">成交量 <b className="ml-1 text-slate-700 dark:text-slate-200">{fmtV(bar.volume || 0, market)}</b></span>
      </div>
    </div>
  );
}
