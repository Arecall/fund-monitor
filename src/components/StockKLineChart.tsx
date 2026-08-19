import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Spin } from 'antd';
import { BarChart3 } from 'lucide-react';
import type { StockKLinePoint, StockKLinePeriod } from '../services/api';

interface Candle extends StockKLinePoint {
  label: string;
}

const KLINE_PERIODS: { key: StockKLinePeriod; label: string }[] = [
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
  { key: 'quarter', label: '季K' },
  { key: 'year', label: '年K' },
];

interface StockKLineChartProps {
  code: string;
  market?: string;
  data: StockKLinePoint[];
  period: StockKLinePeriod;
  loading?: boolean;
  onPeriodChange: (period: StockKLinePeriod) => void;
  height?: number;
}

function formatPrice(value: number) {
  if (value >= 1000) return value.toFixed(1);
  if (value >= 100) return value.toFixed(2);
  return value.toFixed(3);
}

function formatKLineVolume(value: number, market?: string) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const unit = market === 'hk' || market === 'us' ? '股' : '手';
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿${unit}`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(2)}万${unit}`;
  return `${value.toFixed(0)}${unit}`;
}

function formatPeriodLabel(date: string, period: StockKLinePeriod) {
  if (period === 'year') return date.slice(0, 4);
  if (period === 'quarter') {
    const [year, month] = date.slice(0, 10).split('-').map(Number);
    return year && month ? `${year} Q${Math.ceil(month / 3)}` : date;
  }
  if (period === 'month') return date.slice(0, 7);
  return date;
}

export function StockKLineChart({
  code,
  market,
  data,
  period,
  loading = false,
  onPeriodChange,
  height = 320,
}: StockKLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width ?? 640;
      setWidth(Math.max(280, nextWidth));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setHoverIndex(null);
  }, [code, period]);

  const bars = useMemo<Candle[]>(() => data
    .filter(bar => (
      Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) && bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0
    ))
    .map(bar => ({ ...bar, label: formatPeriodLabel(bar.date, period) })), [data, period]);

  const geometry = useMemo(() => {
    const padding = { top: 16, right: 56, bottom: 24, left: 8 };
    const volumeHeight = Math.max(52, Math.round(height * 0.2));
    const volumeGap = 12;
    const priceHeight = height - padding.top - padding.bottom - volumeHeight - volumeGap;
    const drawableWidth = Math.max(1, width - padding.left - padding.right);
    const high = Math.max(...bars.map(bar => bar.high), 1);
    const low = Math.min(...bars.map(bar => bar.low), high);
    const rawSpan = Math.max(high - low, high * 0.002);
    const maxPrice = high + rawSpan * 0.08;
    const minPrice = Math.max(0, low - rawSpan * 0.08);
    const span = Math.max(maxPrice - minPrice, 0.0001);
    const maxVolume = Math.max(...bars.map(bar => bar.volume || 0), 1);
    const slotWidth = drawableWidth / Math.max(bars.length, 1);
    const bodyWidth = Math.max(1, Math.min(14, slotWidth * 0.62));
    const x = (index: number) => padding.left + slotWidth * (index + 0.5);
    const priceY = (price: number) => padding.top + ((maxPrice - price) / span) * priceHeight;
    const volumeY = (volume: number) => padding.top + priceHeight + volumeGap + volumeHeight - (Math.max(0, volume) / maxVolume) * volumeHeight;
    return { padding, priceHeight, volumeHeight, volumeGap, drawableWidth, maxPrice, minPrice, bodyWidth, x, priceY, volumeY };
  }, [bars, height, width]);

  const hovered = hoverIndex === null ? null : bars[hoverIndex] ?? null;
  const marketLabel = market === 'us' ? '美股' : market === 'hk' ? '港股' : 'A股';
  const periodLabel = KLINE_PERIODS.find(item => item.key === period)?.label || '日K';

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!bars.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const relative = (event.clientX - rect.left - geometry.padding.left) / geometry.drawableWidth;
    setHoverIndex(Math.max(0, Math.min(bars.length - 1, Math.floor(relative * bars.length))));
  };

  return (
    <section className="rounded-2xl border border-[var(--hairline-border)] bg-white/40 dark:bg-white/[0.02] p-4">
      <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 size={15} className="text-[var(--primary-accent)]" />
          <h4 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100">{periodLabel}线</h4>
          <span className="text-[10px] text-slate-400 font-mono">{marketLabel} · 前复权</span>
        </div>
        <div className="inline-flex rounded-full bg-slate-100/60 dark:bg-white/5 p-1">
          {KLINE_PERIODS.map(item => (
            <button
              key={item.key}
              type="button"
              disabled={loading}
              onClick={() => onPeriodChange(item.key)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                period === item.key ? 'bg-[var(--primary-accent)] text-white shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="relative min-h-[220px]">
        {loading ? (
          <div className="flex h-[320px] items-center justify-center"><Spin size="large" tip="K 线数据加载中..." /></div>
        ) : bars.length < 2 ? (
          <div className="flex h-[320px] flex-col items-center justify-center gap-2 text-sm text-slate-400"><BarChart3 size={22} strokeWidth={1.5} /><span>暂无可用 {periodLabel} 数据</span></div>
        ) : (
          <>
            <svg width={width} height={height} onPointerMove={onPointerMove} onPointerLeave={() => setHoverIndex(null)} className="block touch-none select-none" aria-label={`${code} ${periodLabel}图`}>
              {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
                const y = geometry.padding.top + geometry.priceHeight * ratio;
                const value = geometry.maxPrice - (geometry.maxPrice - geometry.minPrice) * ratio;
                return <g key={ratio}><line x1={geometry.padding.left} x2={width - geometry.padding.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" strokeDasharray="3 4" /><text x={width - geometry.padding.right + 6} y={y + 3.5} className="fill-slate-400 dark:fill-slate-500" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">{formatPrice(value)}</text></g>;
              })}
              {bars.map((bar, index) => {
                const color = bar.close >= bar.open ? 'var(--color-up)' : 'var(--color-down)';
                const x = geometry.x(index);
                const openY = geometry.priceY(bar.open);
                const closeY = geometry.priceY(bar.close);
                const bodyY = Math.min(openY, closeY);
                const volumeTop = geometry.volumeY(bar.volume || 0);
                const volumeBottom = geometry.padding.top + geometry.priceHeight + geometry.volumeGap + geometry.volumeHeight;
                return <g key={`${bar.date}-${index}`} opacity={hoverIndex !== null && hoverIndex !== index ? 0.58 : 1}><line x1={x} x2={x} y1={geometry.priceY(bar.high)} y2={geometry.priceY(bar.low)} stroke={color} strokeWidth="1" /><rect x={x - geometry.bodyWidth / 2} y={bodyY} width={geometry.bodyWidth} height={Math.max(1, Math.abs(closeY - openY))} fill={color} rx="0.5" /><rect x={x - geometry.bodyWidth / 2} y={volumeTop} width={geometry.bodyWidth} height={Math.max(1, volumeBottom - volumeTop)} fill={color} opacity="0.42" rx="0.5" /></g>;
              })}
              <line x1={geometry.padding.left} x2={width - geometry.padding.right} y1={geometry.padding.top + geometry.priceHeight + geometry.volumeGap / 2} y2={geometry.padding.top + geometry.priceHeight + geometry.volumeGap / 2} stroke="currentColor" strokeOpacity="0.12" />
              <text x={geometry.padding.left} y={height - 5} className="fill-slate-400 dark:fill-slate-500" fontSize="10">{bars[0]?.label}</text>
              <text x={width / 2} y={height - 5} textAnchor="middle" className="fill-slate-400 dark:fill-slate-500" fontSize="10">{bars[Math.floor(bars.length / 2)]?.label}</text>
              <text x={width - geometry.padding.right} y={height - 5} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize="10">{bars[bars.length - 1]?.label}</text>
              {hovered && hoverIndex !== null && <line x1={geometry.x(hoverIndex)} x2={geometry.x(hoverIndex)} y1={geometry.padding.top} y2={geometry.padding.top + geometry.priceHeight + geometry.volumeGap + geometry.volumeHeight} stroke="currentColor" strokeOpacity="0.28" strokeDasharray="3 3" />}
            </svg>
            {hovered && <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-xl border border-[var(--hairline-border)] bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:bg-[#1c1c1e]/95"><div className="mb-1 text-[10px] font-mono text-slate-400">{hovered.label}</div><div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono tabular-nums"><span className="text-slate-500">开 <b className="ml-1 text-slate-700 dark:text-slate-200">{formatPrice(hovered.open)}</b></span><span className="text-slate-500">收 <b className="ml-1 text-slate-700 dark:text-slate-200">{formatPrice(hovered.close)}</b></span><span className="text-slate-500">高 <b className="ml-1 text-slate-700 dark:text-slate-200">{formatPrice(hovered.high)}</b></span><span className="text-slate-500">低 <b className="ml-1 text-slate-700 dark:text-slate-200">{formatPrice(hovered.low)}</b></span><span className="col-span-2 text-slate-500">成交量 <b className="ml-1 text-slate-700 dark:text-slate-200">{formatKLineVolume(hovered.volume || 0, market)}</b></span></div></div>}
          </>
        )}
      </div>
    </section>
  );
}
