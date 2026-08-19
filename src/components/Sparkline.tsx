import { useState, useEffect, useMemo } from 'react';
import { Spin } from 'antd';
import { fetchStockMinute } from '../services/api';

interface SparklineProps {
  code: string;
  kind?: 'fund' | 'stock';
  market?: string;
  currentPrice: number;
  prevClose: number;
  isUp: boolean;
  width?: number;
  height?: number;
}

// 模块级全域内存缓存，防止列表重复渲染打爆接口 (TTL = 60s)
const sparklineCache = new Map<string, { points: number[]; ts: number }>();
const SPARKLINE_TTL = 60 * 1000;

export function Sparkline({
  code,
  kind = 'stock',
  market = 'domestic',
  currentPrice,
  prevClose,
  isUp,
  width = 96,
  height = 28,
}: SparklineProps) {
  const [dataPoints, setDataPoints] = useState<number[] | null>(() => {
    const cached = sparklineCache.get(`${code}-${kind}-${market}`);
    if (cached && Date.now() - cached.ts < SPARKLINE_TTL) {
      return cached.points;
    }
    return null;
  });

  const [loading, setLoading] = useState<boolean>(!dataPoints);

  useEffect(() => {
    const cacheKey = `${code}-${kind}-${market}`;
    const cached = sparklineCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SPARKLINE_TTL) {
      setDataPoints(cached.points);
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(!cached);

    fetchStockMinute(code, kind, market)
      .then((res) => {
        if (!isMounted) return;
        if (res && Array.isArray(res.data) && res.data.length > 0) {
          const pts = res.data.map((p) => p.close).filter((v) => typeof v === 'number' && !isNaN(v) && v > 0);
          if (pts.length > 0) {
            sparklineCache.set(cacheKey, { points: pts, ts: Date.now() });
            setDataPoints(pts);
            setLoading(false);
            return;
          }
        }
        // 接口无数据时退化为从昨收到现价的标准 2 点连线
        const fallback = [prevClose > 0 ? prevClose : currentPrice, currentPrice].filter((v) => v > 0);
        sparklineCache.set(cacheKey, { points: fallback, ts: Date.now() });
        setDataPoints(fallback);
        setLoading(false);
      })
      .catch(() => {
        if (!isMounted) return;
        const fallback = [prevClose > 0 ? prevClose : currentPrice, currentPrice].filter((v) => v > 0);
        sparklineCache.set(cacheKey, { points: fallback, ts: Date.now() });
        setDataPoints(fallback);
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [code, kind, market, currentPrice, prevClose]);

  // 坐标转换计算
  const geometry = useMemo(() => {
    const values = dataPoints && dataPoints.length >= 2 ? dataPoints : [prevClose > 0 ? prevClose : currentPrice, currentPrice];
    const validVals = values.filter(v => typeof v === 'number' && !isNaN(v) && v > 0);
    if (validVals.length < 2) return null;

    const minV = Math.min(...validVals);
    const maxV = Math.max(...validVals);
    const span = maxV - minV || (maxV * 0.005 || 1);

    const padTop = 3;
    const padBottom = 3;
    const innerH = height - padTop - padBottom;

    const pts = validVals.map((v, i) => ({
      x: (i / (validVals.length - 1)) * width,
      y: height - padBottom - ((v - minV) / span) * innerH,
    }));

    // 平滑 Bezier 曲线
    let lineD = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    if (pts.length === 2) {
      lineD = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2] || p2;
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        lineD += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
      }
    }

    const lastPt = pts[pts.length - 1];
    const areaD = `${lineD} L ${lastPt.x.toFixed(1)} ${height} L 0 ${height} Z`;

    return { lineD, areaD, lastPt };
  }, [dataPoints, currentPrice, prevClose, width, height]);

  const strokeColor = isUp ? 'var(--color-up)' : 'var(--color-down)';
  const gradId = `sparkGrad-${code.replace(/[^a-zA-Z0-9]/g, '_')}`;

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
