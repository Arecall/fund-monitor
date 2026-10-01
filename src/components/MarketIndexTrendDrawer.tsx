import React, { useState, useEffect, useMemo, useId, useRef } from 'react';
import { Drawer, Spin, Button, message } from 'antd';
import {
  X,
  TrendingUp,
  TrendingDown,
  Sparkles,
  BookmarkPlus,
  Check,
  BarChart2,
  Activity
} from 'lucide-react';
import {
  fetchMarketIndexTrend,
  type MarketIndexTrendResponse,
  type IndexTimelinePoint
} from '../services/api';

export interface MarketIndexTrendDrawerProps {
  open: boolean;
  onClose: () => void;
  indexCode: string | null;
  onAddToWatchlist?: (code: string) => Promise<boolean>;
  watchlistCodes?: Set<string>;
}

export function MarketIndexTrendDrawer({
  open,
  onClose,
  indexCode,
  onAddToWatchlist,
  watchlistCodes = new Set()
}: MarketIndexTrendDrawerProps) {
  const [data, setData] = useState<MarketIndexTrendResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [addingCode, setAddingCode] = useState<string | null>(null);

  // 走势图交互探针状态
  const [hoverPoint, setHoverPoint] = useState<IndexTimelinePoint | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gradientId = useId().replace(/:/g, '_');

  // 检测移动端
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 加载大盘指数趋势数据
  const loadTrend = async (code: string) => {
    setLoading(true);
    setHoverPoint(null);
    setHoverPos(null);
    try {
      const res = await fetchMarketIndexTrend(code);
      setData(res);
    } catch (err) {
      message.error('加载大盘趋势数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && indexCode) {
      loadTrend(indexCode);
    }
  }, [open, indexCode]);

  const isUp = data ? data.change > 0 : false;
  const isDown = data ? data.change < 0 : false;

  const colorVar = isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : '#8e8e93';
  const colorBgVar = isUp ? 'var(--color-up-bg)' : isDown ? 'var(--color-down-bg)' : 'rgba(142,142,147,0.1)';

  // 处理加自选
  const handleAddEtf = async (code: string) => {
    if (!onAddToWatchlist || addingCode) return;
    setAddingCode(code);
    try {
      await onAddToWatchlist(code);
    } finally {
      setAddingCode(null);
    }
  };

  // 几何坐标与分时走势计算
  const geometry = useMemo(() => {
    if (!data || !data.timeline || data.timeline.length < 2) return null;
    const points = data.timeline;
    const basePrice = data.preClose > 0 ? data.preClose : (points[0]?.v || 1);

    const values = points.map(p => p.v).filter(v => typeof v === 'number' && v > 0);
    if (values.length < 2) return null;

    const maxDev = Math.max(...values.map(v => Math.abs(v - basePrice)), basePrice * 0.003);
    const paddedDev = maxDev * 1.08;

    const minV = basePrice - paddedDev;
    const maxV = basePrice + paddedDev;
    const rangeV = maxV - minV || 1;

    const svgW = isMobile ? 320 : 420;
    const svgH = 180;
    const padTop = 14;
    const padBottom = 20;
    const padLeft = 46;
    const padRight = 46;
    const innerW = svgW - padLeft - padRight;
    const innerH = svgH - padTop - padBottom;

    const pts = points.map((p, i) => ({
      x: padLeft + (i / (points.length - 1)) * innerW,
      y: padTop + (1 - (p.v - minV) / rangeV) * innerH,
      raw: p
    }));

    const baselineY = padTop + (1 - (basePrice - minV) / rangeV) * innerH;

    // 路径线
    const lineD = pts.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`, '');
    const lastPt = pts[pts.length - 1];
    const areaD = `${lineD} L ${lastPt.x.toFixed(1)} ${baselineY} L ${pts[0].x.toFixed(1)} ${baselineY} Z`;

    // 刻度
    const yTicks = [
      { y: padTop, v: maxV, pct: ((maxV - basePrice) / basePrice) * 100 },
      { y: baselineY, v: basePrice, pct: 0 },
      { y: padTop + innerH, v: minV, pct: ((minV - basePrice) / basePrice) * 100 }
    ];

    return {
      pts,
      lineD,
      areaD,
      baselineY,
      lastPt,
      svgW,
      svgH,
      padLeft,
      innerW,
      innerH,
      yTicks,
      basePrice
    };
  }, [data, isMobile]);

  // 鼠标探针跟随
  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geometry || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    if (clientX < geometry.padLeft || clientX > geometry.padLeft + geometry.innerW) {
      setHoverPoint(null);
      setHoverPos(null);
      return;
    }

    const ratio = (clientX - geometry.padLeft) / geometry.innerW;
    const idx = Math.min(
      geometry.pts.length - 1,
      Math.max(0, Math.round(ratio * (geometry.pts.length - 1)))
    );

    const pt = geometry.pts[idx];
    setHoverPoint(pt.raw);
    setHoverPos({ x: pt.x, y: pt.y });
  };

  const handlePointerLeave = () => {
    setHoverPoint(null);
    setHoverPos(null);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={isMobile ? '100%' : 480}
      placement={isMobile ? 'bottom' : 'right'}
      height={isMobile ? '82vh' : undefined}
      destroyOnClose
      styles={{
        header: { display: 'none' },
        body: { padding: 0, overflowX: 'hidden' },
        mask: { backdropFilter: 'blur(6px)', backgroundColor: 'rgba(0, 0, 0, 0.45)' }
      }}
      className="market-index-drawer"
    >
      <div className="flex flex-col h-full bg-slate-50/95 dark:bg-[#131418]/95 backdrop-blur-2xl text-slate-800 dark:text-slate-100 select-none pb-safe">
        {/* 移动端顶部药丸抓手条 */}
        {isMobile && (
          <div className="w-full pt-3 pb-1 flex justify-center cursor-grab active:cursor-grabbing">
            <div className="w-10 h-1 bg-slate-300 dark:bg-slate-700 rounded-full" />
          </div>
        )}

        {/* 顶部 Header：指数名称与状态 */}
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-center justify-between border-b border-[var(--hairline-border)]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-blue-500/10 dark:bg-blue-400/20 text-[var(--primary-accent)] flex items-center justify-center shadow-2xs shrink-0">
              <Activity size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 dark:text-white leading-none">
                  {data?.name || '大盘指数趋势'}
                </h2>
                <span className="font-mono text-[11px] px-1.5 py-0.2 rounded bg-slate-200/80 dark:bg-white/10 text-slate-500 dark:text-slate-400">
                  {data?.symbol || data?.code}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-400">
                <span className="inline-flex items-center gap-1">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      data?.status === 'open' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
                    }`}
                  />
                  {data?.status === 'open' ? '盘中交易中' : '已休市 (权威基准)'}
                </span>
                <span>•</span>
                <span>{data?.market === 'us' ? '美股交易时段' : '15:00 收盘对齐'}</span>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/10 transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 p-12">
            <Spin size="large" />
            <span className="text-xs text-slate-400 font-medium animate-pulse">正在穿透拉取大盘分时深度时序...</span>
          </div>
        ) : !data ? (
          <div className="flex-1 flex items-center justify-center p-8 text-xs text-slate-400">
            暂无该大盘指数时序数据
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {/* 1. 核心点位与四维极值矩阵卡片 */}
            <div className="p-4 rounded-2xl bg-white/80 dark:bg-[#1a1b20]/90 border border-slate-200/80 dark:border-white/[0.06] shadow-sm">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-3xl font-extrabold font-mono tracking-tight tabular-nums text-slate-900 dark:text-white">
                    {data.price.toFixed(2)}
                  </span>
                  <div className={`flex items-center gap-1 font-mono text-xs font-bold px-2 py-0.5 rounded-md ${colorBgVar}`} style={{ color: colorVar }}>
                    {isUp ? <TrendingUp size={12} /> : isDown ? <TrendingDown size={12} /> : null}
                    <span>{isUp ? '+' : ''}{data.change.toFixed(2)}</span>
                    <span>({isUp ? '+' : ''}{data.changePercent.toFixed(2)}%)</span>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 font-mono">
                  全日振幅 <span className="font-semibold text-blue-600 dark:text-blue-400">{data.amplitude.toFixed(2)}%</span>
                </div>
              </div>

              {/* 四维极值关键指标 */}
              <div className="grid grid-cols-4 gap-2 mt-3.5 pt-3 border-t border-slate-100 dark:border-white/[0.04] text-[11px]">
                <div>
                  <span className="text-slate-400 text-[10px]">今开</span>
                  <div className="font-mono font-bold text-slate-700 dark:text-slate-200 mt-0.5 tabular-nums">
                    {data.open.toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px]">昨收基准</span>
                  <div className="font-mono font-bold text-slate-700 dark:text-slate-200 mt-0.5 tabular-nums">
                    {data.preClose.toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px]">最高</span>
                  <div className="font-mono font-bold text-[var(--color-up)] mt-0.5 tabular-nums">
                    {data.high.toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px]">最低</span>
                  <div className="font-mono font-bold text-[var(--color-down)] mt-0.5 tabular-nums">
                    {data.low.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>

            {/* 2. 核心大盘分时走势图 (水上水下着色 + 12px 绝对防遮挡十字准星) */}
            <div className="p-3.5 rounded-2xl bg-white/80 dark:bg-[#1a1b20]/90 border border-slate-200/80 dark:border-white/[0.06] shadow-sm relative overflow-hidden">
              <div className="flex items-center justify-between text-xs mb-2 px-1">
                <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  <BarChart2 size={13} className="text-[var(--primary-accent)]" />
                  日内分时走势
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  昨收零轴绝对锚定
                </span>
              </div>

              {geometry && (
                <div className="relative w-full flex justify-center">
                  <svg
                    ref={svgRef}
                    width={geometry.svgW}
                    height={geometry.svgH}
                    onPointerMove={handlePointerMove}
                    onPointerLeave={handlePointerLeave}
                    style={{ touchAction: 'pan-y' }}
                    className="overflow-visible block select-none"
                  >
                    <defs>
                      <linearGradient id={`indexUp-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-up)" stopOpacity="0.25" />
                        <stop offset="100%" stopColor="var(--color-up)" stopOpacity="0.0" />
                      </linearGradient>
                      <linearGradient id={`indexDown-${gradientId}`} x1="0" y1="1" x2="0" y2="0">
                        <stop offset="0%" stopColor="var(--color-down)" stopOpacity="0.25" />
                        <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0.0" />
                      </linearGradient>
                    </defs>

                    {/* Y 轴刻度参考线与两翼标签 */}
                    {geometry.yTicks.map((tick, i) => (
                      <g key={i}>
                        <line
                          x1={geometry.padLeft}
                          y1={tick.y}
                          x2={geometry.padLeft + geometry.innerW}
                          y2={tick.y}
                          stroke="currentColor"
                          strokeOpacity={i === 1 ? 0.25 : 0.08}
                          strokeDasharray={i === 1 ? '3 3' : '2 2'}
                          strokeWidth={i === 1 ? 1 : 0.75}
                        />
                        {/* 左侧点位 */}
                        <text
                          x={geometry.padLeft - 6}
                          y={tick.y + 3}
                          textAnchor="end"
                          fontSize="9"
                          fill="currentColor"
                          fillOpacity="0.45"
                          className="font-mono tabular-nums"
                        >
                          {tick.v.toFixed(1)}
                        </text>
                        {/* 右侧涨跌幅 */}
                        <text
                          x={geometry.padLeft + geometry.innerW + 6}
                          y={tick.y + 3}
                          textAnchor="start"
                          fontSize="9"
                          fill={tick.pct > 0 ? 'var(--color-up)' : tick.pct < 0 ? 'var(--color-down)' : 'currentColor'}
                          fillOpacity={tick.pct === 0 ? '0.45' : '0.85'}
                          className="font-mono tabular-nums font-semibold"
                        >
                          {tick.pct > 0 ? '+' : ''}{tick.pct.toFixed(2)}%
                        </text>
                      </g>
                    ))}

                    {/* 水上水下阴影填充 */}
                    <path d={geometry.areaD} fill={`url(#${isUp ? `indexUp-${gradientId}` : `indexDown-${gradientId}`})`} />

                    {/* 分时折线主描边 */}
                    <path
                      d={geometry.lineD}
                      fill="none"
                      stroke={colorVar}
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />

                    {/* 终点微光标 */}
                    <circle cx={geometry.lastPt.x} cy={geometry.lastPt.y} r="2.5" fill={colorVar} />
                    <circle cx={geometry.lastPt.x} cy={geometry.lastPt.y} r="1" fill="#ffffff" />

                    {/* 十字准星指示线 */}
                    {hoverPos && (
                      <g>
                        <line
                          x1={hoverPos.x}
                          y1={14}
                          x2={hoverPos.x}
                          y2={geometry.svgH - 20}
                          stroke="currentColor"
                          strokeOpacity="0.3"
                          strokeDasharray="2 2"
                        />
                        <line
                          x1={geometry.padLeft}
                          y1={hoverPos.y}
                          x2={geometry.padLeft + geometry.innerW}
                          y2={hoverPos.y}
                          stroke="currentColor"
                          strokeOpacity="0.3"
                          strokeDasharray="2 2"
                        />
                        <circle cx={hoverPos.x} cy={hoverPos.y} r="3" fill={colorVar} />
                        <circle cx={hoverPos.x} cy={hoverPos.y} r="1.5" fill="white" />
                      </g>
                    )}
                  </svg>

                  {/* 12px 绝对防遮挡跟手探针浮窗 */}
                  {hoverPos && hoverPoint && (
                    <div
                      className="absolute z-30 pointer-events-none transition-transform duration-75"
                      style={{
                        left: `${hoverPos.x}px`,
                        top: `${Math.max(10, Math.min(geometry.svgH - 60, hoverPos.y - 25))}px`,
                        transform: hoverPos.x > geometry.innerW * 0.5 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)'
                      }}
                    >
                      <div className="px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 shadow-xl backdrop-blur-md text-[10px] font-mono whitespace-nowrap">
                        <div className="opacity-70">{hoverPoint.t}</div>
                        <div className="text-xs font-bold mt-0.5">{hoverPoint.v.toFixed(2)}</div>
                        <div className={hoverPoint.v >= geometry.basePrice ? 'text-red-400 dark:text-red-600' : 'text-emerald-400 dark:text-emerald-600'}>
                          {hoverPoint.v >= geometry.basePrice ? '+' : ''}{(((hoverPoint.v - geometry.basePrice) / geometry.basePrice) * 100).toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* X 轴交易时间线刻度 */}
              <div className="flex justify-between text-[10px] text-slate-400 font-mono mt-1 px-8">
                <span>{data.market === 'us' ? '21:30' : '09:30'}</span>
                <span>{data.market === 'us' ? '00:45' : '11:30/13:00'}</span>
                <span>{data.market === 'us' ? '04:00' : '15:00'}</span>
              </div>
            </div>

            {/* 3. 关联代表性场内 ETF 闭环微岛 */}
            <div className="p-4 rounded-2xl bg-white/80 dark:bg-[#1a1b20]/90 border border-slate-200/80 dark:border-white/[0.06] shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  <Sparkles size={13} className="text-amber-500" />
                  关联代表性场内 ETF 标的
                </span>
                <span className="text-[10px] text-slate-400">一键配置加自选</span>
              </div>

              <div className="space-y-2">
                {data.relatedEtfs.length === 0 ? (
                  <div className="text-center py-4 text-xs text-slate-400">暂无关联 ETF 标的</div>
                ) : (
                  data.relatedEtfs.map(etf => {
                    const isAdded = watchlistCodes.has(etf.code);
                    const isEtfUp = etf.changePercent > 0;
                    const isEtfDown = etf.changePercent < 0;
                    return (
                      <div
                        key={etf.code}
                        className="p-2.5 rounded-xl bg-slate-50 dark:bg-white/[0.03] border border-slate-100 dark:border-white/[0.04] flex items-center justify-between hover:bg-slate-100/60 dark:hover:bg-white/[0.06] transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-xs text-slate-800 dark:text-slate-200 truncate">
                              {etf.name}
                            </span>
                            <span className="font-mono text-[10px] text-slate-400">
                              {etf.code}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            {etf.reason}
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <div className="text-right font-mono">
                            <div className="text-xs font-bold text-slate-800 dark:text-slate-200 tabular-nums">
                              {etf.price > 0 ? etf.price.toFixed(3) : '—'}
                            </div>
                            <div className={`text-[10px] font-semibold tabular-nums ${
                              isEtfUp ? 'text-[var(--color-up)]' : isEtfDown ? 'text-[var(--color-down)]' : 'text-slate-400'
                            }`}>
                              {isEtfUp ? '+' : ''}{etf.changePercent.toFixed(2)}%
                            </div>
                          </div>

                          <Button
                            size="small"
                            onClick={() => handleAddEtf(etf.code)}
                            disabled={isAdded || addingCode === etf.code}
                            icon={isAdded ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <BookmarkPlus className="w-3.5 h-3.5 text-blue-500" />}
                            className={`h-7 px-2.5 rounded-lg text-xs flex items-center gap-1 font-medium transition-colors ${
                              isAdded
                                ? 'bg-slate-100 dark:bg-white/10 text-slate-400 border-transparent cursor-default'
                                : 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-200/60 dark:border-blue-900/40 hover:bg-blue-100'
                            }`}
                          >
                            {isAdded ? '已在自选' : '加自选'}
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}
