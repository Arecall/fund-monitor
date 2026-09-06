import { useState, useEffect, useMemo, useId } from 'react';
import { Spin, Tag } from 'antd';
import { fetchStockMinute } from '../services/api';
import { buildSeries, buildMonotoneSplinePath, getSessionTimeRatio, minuteResponseToFeed, type MinuteFeed, type FundMarket } from '../utils/chartData';

interface SparklineProps {
  code: string;
  fundName?: string;
  kind?: 'fund' | 'stock';
  market?: string;
  currentPrice: number;
  prevClose: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  isUp: boolean;
  width?: number;
  height?: number;
}

// 模块级全域内存缓存，防止列表重复渲染打爆接口 (TTL = 60s)
const sparklineFeedCache = new Map<string, { feed: MinuteFeed | null; ts: number }>();
const sparklineFeedInflight = new Map<string, Promise<MinuteFeed | null>>();
const SPARKLINE_TTL = 60 * 1000;

function getSparklineKey(code: string, kind: 'fund' | 'stock', market: string) {
  return `${kind}:${market}:${code}`;
}

function loadSparklineFeed(key: string, code: string, kind: 'fund' | 'stock', market: string, baseAnchor?: number) {
  const existing = sparklineFeedInflight.get(key);
  if (existing) return existing;

  const request = fetchStockMinute(code, kind, market)
    .then((res) => {
      return minuteResponseToFeed(res, baseAnchor);
    })
    .catch(() => null)
    .finally(() => {
      sparklineFeedInflight.delete(key);
    });

  sparklineFeedInflight.set(key, request);
  return request;
}

export function Sparkline({
  code,
  fundName = '',
  kind = 'stock',
  market = 'domestic',
  currentPrice,
  prevClose,
  openPrice,
  highPrice,
  lowPrice,
  isUp,
  width = 96,
  height = 28,
}: SparklineProps) {
  const instrumentKey = getSparklineKey(code, kind, market);
  const [feed, setFeed] = useState<MinuteFeed | null>(() => {
    const cached = sparklineFeedCache.get(instrumentKey);
    if (cached && Date.now() - cached.ts < SPARKLINE_TTL) {
      return cached.feed;
    }
    return null;
  });
  const [loading, setLoading] = useState<boolean>(!feed);
  const gradientInstanceId = useId().replace(/:/g, '_');

  useEffect(() => {
    const cached = sparklineFeedCache.get(instrumentKey);
    let isCurrent = true;

    // 组件身份变化或缓存命中时使用缓存
    if (cached && Date.now() - cached.ts < SPARKLINE_TTL) {
      setFeed(cached.feed);
      setLoading(false);
      return () => {
        isCurrent = false;
      };
    }

    setFeed(null);
    setLoading(true);

    const baseAnchor = prevClose > 0 ? prevClose : currentPrice;
    loadSparklineFeed(instrumentKey, code, kind, market, baseAnchor)
      .then((minuteFeed) => {
        if (!isCurrent) return;
        if (minuteFeed) {
          sparklineFeedCache.set(instrumentKey, { feed: minuteFeed, ts: Date.now() });
        }
        setFeed(minuteFeed);
        setLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [instrumentKey, code, kind, market, currentPrice, prevClose]);

  // 复用与详情页 FundChart 完全一致的 buildSeries 引擎，保证图表走势形态 100% 对齐
  const series = useMemo(() => {
    return buildSeries(
      code,
      currentPrice,
      prevClose,
      'intraday',
      [],
      fundName,
      code,
      kind,
      openPrice,
      highPrice,
      lowPrice,
      feed,
      market as FundMarket
    );
  }, [code, currentPrice, prevClose, fundName, kind, openPrice, highPrice, lowPrice, feed, market]);

  // 若当前标的处于盘前阶段，使用 Ant Design 待更新组件展示
  const isPreMarket = Boolean(series.preMarket);

  // 坐标转换计算：与详情页 FundChart 严格对称与时间比例对齐
  const geometry = useMemo(() => {
    if (isPreMarket) return null;
    const points = series.points;
    if (!points || points.length < 2) return null;

    const values = points.map(p => p.v).filter(v => typeof v === 'number' && !isNaN(v) && v > 0);
    if (values.length < 2) return null;

    const basePrice = prevClose > 0 ? prevClose : (points[0]?.v || 1);
    const deviations = points.map(p => Math.abs(p.v - basePrice));
    if (highPrice && highPrice > 0) deviations.push(Math.abs(highPrice - basePrice));
    if (lowPrice && lowPrice > 0) deviations.push(Math.abs(lowPrice - basePrice));
    if (openPrice && openPrice > 0) deviations.push(Math.abs(openPrice - basePrice));
    if (currentPrice && currentPrice > 0) deviations.push(Math.abs(currentPrice - basePrice));

    // 默认最小波动区间为基准价的 ±0.5%，留 5% 呼吸空间，确保上下两翼对称
    const maxDev = Math.max(...deviations, basePrice * 0.005);
    const paddedDev = maxDev * 1.05;

    const minV = basePrice - paddedDev;
    const maxV = basePrice + paddedDev;
    const range_v = maxV - minV || 1;

    const padTop = 3;
    const padBottom = 3;
    const innerH = height - padTop - padBottom;

    const fundMarket = (market || 'domestic') as FundMarket;
    const pts = points.map((p, i) => {
      const rawRatio = getSessionTimeRatio(p.t, fundMarket);
      const ratio = Number.isFinite(rawRatio) ? Math.max(0, Math.min(1, rawRatio)) : (points.length > 1 ? i / (points.length - 1) : 0);
      return {
        x: ratio * width,
        y: padTop + (1 - (p.v - minV) / range_v) * innerH,
      };
    });

    // 单调三次 Hermite 样条曲线（Monotone Cubic Spline）
    const lineD = buildMonotoneSplinePath(pts);
    const lastPt = pts[pts.length - 1];
    const firstPt = pts[0];
    const areaD = `${lineD} L ${lastPt.x.toFixed(1)} ${height} L ${firstPt.x.toFixed(1)} ${height} Z`;

    return { lineD, areaD, lastPt };
  }, [isPreMarket, series, height, width, prevClose, highPrice, lowPrice, openPrice, currentPrice, market]);

  const strokeColor = isUp ? 'var(--color-up)' : 'var(--color-down)';
  const gradId = `sparkGrad-${gradientInstanceId}`;

  if (loading) {
    return (
      <div
        className="inline-flex items-center justify-center select-none"
        style={{ width, height }}
      >
        <Spin size="small" />
      </div>
    );
  }

  if (isPreMarket) {
    return (
      <div className="inline-flex items-center justify-center select-none" style={{ width, height }}>
        <Tag
          bordered={false}
          color="default"
          className="text-[10px] text-slate-400 dark:text-slate-500 bg-slate-100/90 dark:bg-white/5 rounded-full px-2 py-0.5 m-0 font-medium select-none leading-tight"
        >
          待更新
        </Tag>
      </div>
    );
  }

  if (!geometry) return <div className="text-slate-300 dark:text-slate-600 text-[10px]">—</div>;

  return (
    <div className="relative inline-flex items-center justify-center select-none" style={{ width, height }}>
      <svg width={width} height={height} className="overflow-visible block">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* 区域阴影 */}
        <path d={geometry.areaD} fill={`url(#${gradId})`} />

        {/* 主描边折线 */}
        <path
          d={geometry.lineD}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* 右端高亮终点 */}
        <circle
          cx={geometry.lastPt.x}
          cy={geometry.lastPt.y}
          r="2.2"
          fill={strokeColor}
        />
        <circle
          cx={geometry.lastPt.x}
          cy={geometry.lastPt.y}
          r="1"
          fill="white"
        />
      </svg>
    </div>
  );
}
