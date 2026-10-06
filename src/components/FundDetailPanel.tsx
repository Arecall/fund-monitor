import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { Card, Tag, Button, BorderBeam, Divider, Spin } from 'antd';
import { motion, AnimatePresence, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import {
  ReceiptText,
  Pencil,
  ChevronDown,
  Star,
  User,
  TrendingUp,
  TrendingDown,
  Briefcase
} from 'lucide-react';
import type {
  FundValuation,
  UserPosition,
  FundHistoryPoint,
  FundBasicInfo,
  FundHoldingStock,
  StockKLinePoint,
  StockKLinePeriod,
  DetailMinutePatch
} from '../services/api';
import { fetchStockKLine, fetchStockMinute, subscribeDetailChartUpdates } from '../services/api';

const KLINE_BAR_COUNTS: Record<StockKLinePeriod, number> = {
  day: 240,
  week: 150,
  month: 80,
  quarter: 40,
  year: 30,
};

function mergeMinutePatch(feed: MinuteFeed | null, patch: DetailMinutePatch, baseAnchor?: number): MinuteFeed | null {
  const { t, v } = patch.point;
  if (!Number.isFinite(t) || !Number.isFinite(v) || v <= 0) return feed;
  // 防御：若明确为基金且有基准，偏离 > 18% 的脏 patch 拒绝合入
  if (typeof baseAnchor === 'number' && baseAnchor > 0 && baseAnchor < 50) {
    if (Math.abs(v - baseAnchor) / baseAnchor > 0.18) return feed;
  }
  const bucket = Math.floor(t / 60_000) * 60_000;
  const bars = [...(feed?.bars || [])];
  const index = bars.findIndex(bar => Math.floor(bar.t / 60_000) * 60_000 === bucket);
  if (index >= 0) {
    // 保留 REST 分钟源已有的真实成交量/成交额，只更新同分钟的最新价格。
    bars[index] = { ...bars[index], t: bucket, v };
  } else if (!bars.length || bucket > bars[bars.length - 1].t) {
    bars.push({ t: bucket, v });
  } else {
    return feed;
  }
  return { bars: bars.slice(-600) };
}

function mergeLiveKLineTail(rows: StockKLinePoint[], fund: FundValuation): StockKLinePoint[] {
  if (!rows.length || fund.navOnly || fund.estimate || fund.quoteSession === 'closed') return rows;
  const close = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
  if (!Number.isFinite(close) || close <= 0) return rows;
  const last = rows[rows.length - 1];
  const quoteHigh = fund.stockSpecific?.high;
  const quoteLow = fund.stockSpecific?.low;
  // 只用报价区间向外扩展当前 REST 末根，避免跨来源报价导致盘中高低点收缩。
  const high = Math.max(last.high, close, typeof quoteHigh === 'number' && quoteHigh > 0 ? quoteHigh : 0);
  const lows = [last.low, close, typeof quoteLow === 'number' && quoteLow > 0 ? quoteLow : Infinity];
  const low = Math.min(...lows);
  if (!Number.isFinite(high) || !Number.isFinite(low) || low <= 0 || high < low) return rows;
  const next = { ...last, close, high, low };
  return [...rows.slice(0, -1), next];
}

const FundChart = lazy(() => import('./FundChart').then(m => ({ default: m.FundChart })));
const StockKLineChart = lazy(() => import('./StockKLineChart').then(m => ({ default: m.StockKLineChart })));
const AlertPanel = lazy(() => import('./AlertPanel').then(m => ({ default: m.AlertPanel })));

import { RelativeTime, parseGzTime, MarketStatusBadge } from './RelativeTime';
import { QuoteSourceBadge } from './QuoteSourceBadge';
import { detectFundMarket, isMarketOpen, type FundMarket } from '../utils/fundMarket';
import { formatMarketCap } from '../utils/format';
import { type MinuteFeed, minuteResponseToFeed } from '../utils/chartData';

const SPRING = {
  panel:  { type: 'spring' as const, bounce: 0.05, duration: 0.4 },
  snap:   { type: 'spring' as const, bounce: 0.18, duration: 0.36 },
};

interface FundDetailPanelProps {
  fund: FundValuation;
  position?: UserPosition;
  history?: FundHistoryPoint[];
  historyLoading?: boolean;
  basic?: FundBasicInfo | null | undefined;
  holdings?: FundHoldingStock[];
  kind?: 'fund' | 'stock';
  /** A 股详情主动请求资金流向时的局部状态。 */
  capitalFlowState?: 'loading' | 'unavailable';
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onEditPosition?: () => void;
  onToast?: (msg: string) => void;
  onOpenNotificationLogs?: () => void;
}

/**
 * Right-side detail panel shown when a fund/stock is selected.
 * For stocks, the fund intro / holdings / fund-specific bits are hidden.
 * On mobile it collapses into a full-height sheet.
 */
export function FundDetailPanel({
  fund,
  position,
  history = [],
  historyLoading = false,
  basic = null,
  holdings = [],
  kind = 'fund',
  capitalFlowState,
  isExpanded = false,
  onToggleExpand: _onToggleExpand,
  onEditPosition,
  onToast,
  onOpenNotificationLogs
}: FundDetailPanelProps) {
  const prefersReducedMotion = useReducedMotion();
  const [chartKey, setChartKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // 真实分钟级数据/系统采样轨迹点（股票来自 Sina/腾讯，基金/无 K 线品种来自后端 quote_snapshots 快照）
  const [minuteData, setMinuteData] = useState<MinuteFeed | null>(null);
  const [minuteLoading, setMinuteLoading] = useState(true);
  const minuteSigRef = useRef<string>('');
  const minuteGenerationRef = useRef(0);
  const minuteBaselineReadyRef = useRef(false);
  const pendingMinutePatchesRef = useRef<DetailMinutePatch[]>([]);
  const minuteRefreshTimerRef = useRef<number | null>(null);
  const [klinePeriod, setKlinePeriod] = useState<StockKLinePeriod>('day');
  const [klineData, setKlineData] = useState<StockKLinePoint[]>([]);
  const [klineLoading, setKlineLoading] = useState(false);
  const [klineVisible, setKlineVisible] = useState(false);
  const klineContainerRef = useRef<HTMLDivElement | null>(null);

  // 切换标的：清空残留曲线与去重签名，进入加载态（手动刷新走 chartKey，不在此重置，避免闪烁）
  useEffect(() => {
    minuteSigRef.current = '';
    setMinuteData(null);
    setMinuteLoading(true);
  }, [fund.fundcode, fund.market, kind]);

  useEffect(() => {
    if (!fund.fundcode) {
      setMinuteData(null);
      setMinuteLoading(false);
      return;
    }

    let cancelled = false;
    const generation = ++minuteGenerationRef.current;
    minuteBaselineReadyRef.current = false;
    pendingMinutePatchesRef.current = [];
    const isCurrent = () => !cancelled && generation === minuteGenerationRef.current;
    const setFeedIfChanged = (next: MinuteFeed | null) => {
      const last = next?.bars[next.bars.length - 1];
      const sig = next ? `${next.bars.length}|${last?.t}|${last?.v}` : '';
      if (sig === minuteSigRef.current) return;
      minuteSigRef.current = sig;
      setMinuteData(next);
    };
    const anchorNav = parseFloat(fund.dwjz) || parseFloat(fund.gsz) || 0;
    const applyPatch = (patch: DetailMinutePatch) => {
      if (!isCurrent() || patch.code.toUpperCase() !== fund.fundcode.toUpperCase()) return;
      if (!minuteBaselineReadyRef.current) {
        const queue = pendingMinutePatchesRef.current;
        queue.push(patch);
        if (queue.length > 100) queue.shift();
        return;
      }
      setMinuteData(previous => {
        const next = mergeMinutePatch(previous, patch, anchorNav);
        const last = next?.bars[next.bars.length - 1];
        const sig = next ? `${next.bars.length}|${last?.t}|${last?.v}` : '';
        if (sig === minuteSigRef.current) return previous;
        minuteSigRef.current = sig;
        return next;
      });
    };
    const refreshBaseline = async () => {
      try {
        const response = await fetchStockMinute(fund.fundcode, kind, fund.market);
        if (!isCurrent()) return;
        let next = minuteResponseToFeed(response, anchorNav);
        for (const patch of pendingMinutePatchesRef.current.sort((a, b) => a.point.t - b.point.t)) {
          next = mergeMinutePatch(next, patch, anchorNav);
        }
        pendingMinutePatchesRef.current = [];
        minuteBaselineReadyRef.current = true;
        setFeedIfChanged(next);
      } finally {
        if (isCurrent()) setMinuteLoading(false);
      }
    };
    const scheduleBaselineRefresh = () => {
      if (minuteRefreshTimerRef.current != null) return;
      minuteRefreshTimerRef.current = window.setTimeout(() => {
        minuteRefreshTimerRef.current = null;
        void refreshBaseline();
      }, 800);
    };

    void refreshBaseline();
    const unsubscribe = subscribeDetailChartUpdates({
      code: fund.fundcode,
      kind,
      market: fund.market,
      onMinutePatch: applyPatch,
      onReady: (ready) => {
        if (ready.reconnected && isCurrent()) scheduleBaselineRefresh();
      },
      onError: () => {
        if (isCurrent()) scheduleBaselineRefresh();
      },
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isCurrent()) scheduleBaselineRefresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (minuteRefreshTimerRef.current != null) {
        window.clearTimeout(minuteRefreshTimerRef.current);
        minuteRefreshTimerRef.current = null;
      }
    };
  }, [fund.fundcode, fund.market, kind, chartKey]);

  // 当基准净值就绪或从占位值变为有效真实净值，且当前分时线尚未生成有效曲线时，自动无感触发一次基线刷新
  const lastKnownDwjzRef = useRef(fund.dwjz);
  useEffect(() => {
    if (lastKnownDwjzRef.current !== fund.dwjz) {
      lastKnownDwjzRef.current = fund.dwjz;
      if (!minuteData || minuteData.bars.length < 2) {
        setChartKey(k => k + 1);
      }
    }
  }, [fund.dwjz, minuteData]);

  useEffect(() => {
    setKlinePeriod('day');
    setKlineData([]);
    setKlineVisible(false);
  }, [fund.fundcode, fund.market, kind]);

  // 视口懒加载：仅当 K 线图区域进入（或即将进入）可视区时才激活数据请求
  useEffect(() => {
    if (kind !== 'stock' || !fund.fundcode) {
      setKlineVisible(false);
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      setKlineVisible(true);
      return;
    }

    const el = klineContainerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setKlineVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' }
    );

    observer.observe(el);

    return () => {
      observer.disconnect();
    };
  }, [fund.fundcode, fund.market, kind]);

  // 历史 K 线继续由 REST 权威提供；实时报价只临时覆盖已存在末根的 close/high/low。
  const liveKlineSignature = [
    kind,
    fund.capturedAt,
    fund.gsz,
    fund.dwjz,
    fund.navOnly,
    fund.estimate,
    fund.quoteSession,
    fund.stockSpecific?.high,
    fund.stockSpecific?.low,
  ].join('|');
  useEffect(() => {
    if (kind !== 'stock') return;
    setKlineData(previous => mergeLiveKLineTail(previous, fund));
  // `liveKlineSignature` 明确列出报价字段，避免完整 fund 对象每次重建触发副作用。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKlineSignature]);

  useEffect(() => {
    if (kind !== 'stock' || !fund.fundcode || !klineVisible) {
      if (!klineVisible) {
        setKlineData([]);
        setKlineLoading(false);
      }
      return;
    }

    let cancelled = false;
    setKlineLoading(true);
    fetchStockKLine(fund.fundcode, KLINE_BAR_COUNTS[klinePeriod], klinePeriod)
      .then((data) => {
        if (!cancelled) setKlineData(data);
      })
      .finally(() => {
        if (!cancelled) setKlineLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fund.fundcode, fund.market, kind, klinePeriod, chartKey, klineVisible]);

  const current = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
  const previous = parseFloat(fund.dwjz);

  // 针对股票 Tick Size 消除 JavaScript 裸浮点运算误差（如 59.11 - 56.88 = 2.229999999999997）
  const cleanChangeAmt = kind === 'stock'
    ? Math.round((current - previous) * 100) / 100
    : Number((current - previous).toFixed(4));
  const cleanChangePct = previous > 0 ? (cleanChangeAmt / previous) * 100 : 0;

  const isUp = cleanChangeAmt > 0;
  const isDown = cleanChangeAmt < 0;
  const dirColor = isUp ? 'text-[var(--color-up)]' : isDown ? 'text-[var(--color-down)]' : 'text-slate-500';

  // 严格金融计价币种推导：股票按上市市场，场外公募基金按份额币种（国内公募QDII绝大部分为人民币份额，仅外币特定份额为$或HK$）
  const currencyPrefix = kind === 'stock'
    ? (fund.market === 'us' ? '$' : fund.market === 'hk' ? 'HK$' : '¥')
    : (() => {
        const lowerName = (fund.name || '').toLowerCase();
        if (lowerName.includes('美元') || lowerName.includes('usd')) return '$';
        if (lowerName.includes('港元') || lowerName.includes('港币') || lowerName.includes('hkd')) return 'HK$';
        return '¥';
      })();

  const openPrice = (fund.open ? parseFloat(fund.open) : undefined) ?? (
    typeof (fund as any).stockSpecific?.open === 'number' && (fund as any).stockSpecific.open > 0
      ? (fund as any).stockSpecific.open
      : undefined
  );
  const highPrice = typeof (fund as any).stockSpecific?.high === 'number' && (fund as any).stockSpecific.high > 0
    ? (fund as any).stockSpecific.high
    : undefined;
  const lowPrice = typeof (fund as any).stockSpecific?.low === 'number' && (fund as any).stockSpecific.low > 0
    ? (fund as any).stockSpecific.low
    : undefined;
  const amplitude = previous > 0 && highPrice != null && lowPrice != null
    ? ((highPrice - lowPrice) / previous) * 100
    : null;

  const todayStr = new Date().toISOString().slice(0, 10);
  const prevCloseDate = fund.jzrq && fund.jzrq !== todayStr ? fund.jzrq : null;

  const formatAssetPrice = (v: number | undefined | null, targetKind?: 'fund' | 'stock', decimals?: number) => {
    if (v == null || !Number.isFinite(v)) return '—';
    if (decimals !== undefined) return v.toFixed(decimals);
    if (targetKind === 'stock') {
      return v < 1 ? v.toFixed(3) : v.toFixed(2);
    }
    return v.toFixed(4);
  };

  // 权威业绩基准 / 底层跟踪指数推导（杜绝海外 QDII 盲目降级为沪深 300 的坏味道）
  const getFundBenchmark = (targetFund: FundValuation) => {
    if (targetFund.proxyTicker) return `穿透 ${targetFund.proxyTicker}`;
    if (targetFund.proxyIndexName) return targetFund.proxyIndexName;
    const name = targetFund.name || '';
    if (name.includes('纳斯达克') || name.includes('纳指')) return '纳斯达克100 (QQQ)';
    if (name.includes('标普500')) return '标普500 (SPY)';
    if (name.includes('恒生科技')) return '恒生科技指数';
    if (name.includes('恒生互联网')) return '恒生互联网科技';
    if (name.includes('恒生指数')) return '恒生指数';
    if (name.includes('半导体') || name.includes('芯片')) return '中证芯片/半导体';
    if (name.includes('沪深300')) return '沪深300';
    if (name.includes('中证500')) return '中证500';
    if (name.includes('中证1000')) return '中证1000';
    if (name.includes('创业板')) return '创业板指';
    if (name.includes('科创')) return '科创50';
    if (targetFund.market === 'us') return '主动管理 (海外权益)';
    if (targetFund.market === 'hk') return '主动管理 (港股权益)';
    return '主动管理 (公募混合)';
  };

  const fundMarket: FundMarket = (fund.market as FundMarket) || detectFundMarket(fund.name, fund.fundcode);
  const isTrading = isMarketOpen(fundMarket);

  /** Parse gztime once so the relative-time hook starts from the right anchor. */
  const gzTs = parseGzTime(fund.gztime);

  const holdingValue = position ? position.shares * current : 0;
  const holdingCost  = position ? position.shares * position.cost : 0;
  const holdingProfit = holdingValue - holdingCost;
  const holdingProfitPct = holdingCost > 0 ? (holdingProfit / holdingCost) * 100 : 0;

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setChartKey(k => k + 1);        // force chart re-mount to redraw the line
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  // 8格核心与深度指标矩阵渲染器（响应式复用：PC在顶栏卡片内展示，移动端下沉至图表下方）
  const renderTradingMatrixGrid = () => (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 sm:gap-x-6 gap-y-2.5 sm:gap-y-3">
      {kind === 'stock' ? (
        <>
          {/* 格子 1：昨收 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">昨收</span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
              {previous > 0 ? formatAssetPrice(previous, kind, 2) : '—'}
            </div>
            {prevCloseDate && <span className="text-[10px] text-slate-400 font-mono">{prevCloseDate}</span>}
          </div>

          {/* 格子 2：今开 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">今开</span>
            <div className={`font-mono font-bold text-sm sm:text-base tabular-nums ${
              openPrice && previous
                ? (openPrice > previous ? 'text-[var(--color-up)]' : openPrice < previous ? 'text-[var(--color-down)]' : 'text-slate-800 dark:text-slate-100')
                : 'text-slate-800 dark:text-slate-100'
            }`}>
              {openPrice != null && openPrice > 0 ? formatAssetPrice(openPrice, kind, 2) : '—'}
            </div>
          </div>

          {/* 格子 3：最高 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">最高</span>
            <div className={`font-mono font-bold text-sm sm:text-base tabular-nums ${
              highPrice && previous && highPrice > previous ? 'text-[var(--color-up)]' : 'text-slate-800 dark:text-slate-100'
            }`}>
              {highPrice != null && highPrice > 0 ? formatAssetPrice(highPrice, kind, 2) : '—'}
            </div>
          </div>

          {/* 格子 4：最低 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">最低</span>
            <div className={`font-mono font-bold text-sm sm:text-base tabular-nums ${
              lowPrice && previous && lowPrice < previous ? 'text-[var(--color-down)]' : 'text-slate-800 dark:text-slate-100'
            }`}>
              {lowPrice != null && lowPrice > 0 ? formatAssetPrice(lowPrice, kind, 2) : '—'}
            </div>
          </div>

          {/* 格子 5：换手率 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">换手率</span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
              {(fund as any).stockSpecific?.turnoverRate != null ? `${(fund as any).stockSpecific.turnoverRate.toFixed(2)}%` : '—'}
            </div>
          </div>

          {/* 格子 6：振幅 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">日内振幅</span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
              {amplitude != null ? `${amplitude.toFixed(2)}%` : '—'}
            </div>
          </div>

          {/* 格子 7：总市值 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">总市值</span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
              {(fund as any).stockSpecific?.totalMarketCap ? formatMarketCap((fund as any).stockSpecific.totalMarketCap, fund.market) : '—'}
            </div>
          </div>

          {/* 格子 8：持有资产 (可点击编辑持仓) */}
          <div className="flex flex-col min-w-0 cursor-pointer group" onClick={onEditPosition}>
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider flex items-center justify-between">
              持有资产 <Pencil size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
            </span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums truncate">
              {position ? `${currencyPrefix}${holdingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '未持仓'}
            </div>
            {position ? (
              <span className={`text-[10px] font-mono truncate ${holdingProfit > 0 ? 'text-[var(--color-up)]' : holdingProfit < 0 ? 'text-[var(--color-down)]' : 'text-slate-400'}`}>
                {position.shares}股 · 盈亏 {holdingProfit >= 0 ? '+' : ''}{currencyPrefix}{holdingProfit.toFixed(2)}
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 font-mono opacity-60">点击录入</span>
            )}
          </div>
        </>
      ) : (
        <>
          {/* 基金格子 1：官方基准净值（权威披露） */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">官方净值</span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
              {fund.dwjz ? parseFloat(fund.dwjz).toFixed(4) : (previous > 0 ? previous.toFixed(4) : '—')}
            </div>
            {(fund.officialNavDate || fund.jzrq) && (
              <span className="text-[10px] text-slate-400 font-mono">
                {fund.officialNavDate || fund.jzrq} 披露
              </span>
            )}
          </div>

          {/* 基金格子 2：今日估算变动 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">估算变动</span>
            <div className={`font-mono font-bold text-sm sm:text-base tabular-nums ${dirColor}`}>
              {cleanChangeAmt >= 0 ? '+' : ''}{formatAssetPrice(cleanChangeAmt, kind, 4)}
            </div>
            <span className={`text-[10px] font-mono ${dirColor}`}>
              {cleanChangePct >= 0 ? '+' : ''}{cleanChangePct.toFixed(2)}%
            </span>
          </div>

          {/* 基金格子 3：基金规模 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">基金规模</span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
              {basic?.scale?.size != null ? `${basic.scale.size}亿` : '—'}
            </div>
            {basic?.scale?.reportDate && (
              <span className="text-[10px] text-slate-400 font-mono">{basic.scale.reportDate}</span>
            )}
          </div>

          {/* 基金格子 4：基金经理 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">基金经理</span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums truncate">
              {basic?.manager?.name || '—'}
            </div>
            {basic?.manager?.workTime && (
              <span className="text-[10px] text-slate-400 font-mono truncate">{basic.manager.workTime}</span>
            )}
          </div>

          {/* 基金格子 5：持有金额 */}
          <div className="flex flex-col min-w-0 cursor-pointer group" onClick={onEditPosition}>
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider flex items-center justify-between">
              持有资产 <Pencil size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
            </span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums truncate">
              {position ? `${currencyPrefix}${holdingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '未持仓'}
            </div>
            {position ? (
              <span className="text-[10px] text-slate-400 font-mono truncate">
                {parseFloat(position.shares.toFixed(4))}份 · @{position.cost.toFixed(4)}
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 font-mono opacity-60">点击录入</span>
            )}
          </div>

          {/* 基金格子 6：估算收益 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">估算收益</span>
            <div className={`font-mono font-bold text-sm sm:text-base tabular-nums truncate ${
              position
                ? (holdingProfit > 0 ? 'text-[var(--color-up)]' : holdingProfit < 0 ? 'text-[var(--color-down)]' : 'text-slate-800 dark:text-slate-100')
                : 'text-slate-800 dark:text-slate-100'
            }`}>
              {position ? `${holdingProfit >= 0 ? '+' : ''}${currencyPrefix}${Math.abs(holdingProfit).toFixed(2)}` : '—'}
            </div>
            {position ? (
              <span className={`text-[10px] font-mono ${holdingProfitPct >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                {holdingProfitPct >= 0 ? '+' : ''}{holdingProfitPct.toFixed(2)}%
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 font-mono opacity-60">无持仓数据</span>
            )}
          </div>

          {/* 基金格子 7：近1月表现 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">近1月表现</span>
            <div className={`font-mono font-bold text-sm sm:text-base tabular-nums truncate ${
              basic?.returns?.m1 != null
                ? (basic.returns.m1 > 0 ? 'text-[var(--color-up)]' : basic.returns.m1 < 0 ? 'text-[var(--color-down)]' : 'text-slate-800 dark:text-slate-100')
                : 'text-slate-800 dark:text-slate-100'
            }`}>
              {basic?.returns?.m1 != null ? `${basic.returns.m1 >= 0 ? '+' : ''}${basic.returns.m1.toFixed(2)}%` : '—'}
            </div>
            {basic?.returns?.y1 != null && (
              <span className="text-[10px] text-slate-400 font-mono truncate">
                近1年 {basic.returns.y1 >= 0 ? '+' : ''}{basic.returns.y1.toFixed(2)}%
              </span>
            )}
          </div>

          {/* 基金格子 8：业绩基准/底层跟踪 */}
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">业绩基准</span>
            <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums truncate" title={getFundBenchmark(fund)}>
              {getFundBenchmark(fund)}
            </div>
            <span className="text-[10px] text-slate-400 font-mono truncate">
              {fund.proxyTicker ? '底层ETF穿透' : (fund.market === 'us' ? '全球海外权益' : fund.market === 'hk' ? '港股互联' : '标的指数')}
            </span>
          </div>
        </>
      )}
    </div>
  );

  return (
    <motion.div
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      transition={SPRING.panel}
      className="apple-card p-3.5 sm:p-5 md:p-6 flex flex-col gap-4 sm:gap-5"
    >
      {/* ── Title row ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="apple-display-heading text-base sm:text-lg font-bold text-slate-900 dark:text-slate-50">
            {fund.name}
          </h3>
          <Tag className="font-mono text-xs border-0 bg-slate-100 dark:bg-white/10 text-slate-500 font-semibold m-0">{fund.fundcode}</Tag>
          {/* 基金显示风险等级；股票显示市场归属 */}
          {kind === 'fund' ? (
            <Tag color="processing" className="font-semibold text-[11px] rounded-full border-0 m-0">
              混合型-中高风险
            </Tag>
          ) : (
            <Tag
              color={fund.market === 'us' ? 'blue' : fund.market === 'hk' ? 'emerald' : 'gold'}
              className="font-semibold text-[11px] rounded-full border-0 m-0"
            >
              {fund.market === 'us' ? '美股' : fund.market === 'hk' ? '港股' : 'A股'}
            </Tag>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="default"
            size="small"
            shape="round"
            icon={<ReceiptText size={13} />}
            onClick={() => onToast?.('交易记录功能开发中')}
            className="flex items-center text-xs border-[var(--hairline-border)] shadow-none"
          >
            交易记录
          </Button>
        </div>
      </div>

      {/* ── Professional Trading Terminal Matrix Banner (方案 B：富途/雪球多维矩阵流) ── */}
      {(() => {
        const unifiedTradingCard = (
          <Card
            size="small"
            className="rounded-2xl border border-[var(--hairline-border)] shadow-xs bg-white/85 dark:bg-[#1c1c1e]/85 backdrop-blur-2xl overflow-hidden"
            styles={{
              body: { padding: 0 }
            }}
          >
            <div className="p-3.5 sm:p-5 flex flex-col gap-2.5 sm:gap-3.5">
              {/* 上部：核心行情主报价区 (移动端极致瘦身至约 64px) */}
              <div className="flex items-start justify-between gap-3 flex-wrap sm:flex-nowrap">
              {/* 左侧：现价 / 净值 与 涨跌幅 */}
              <div className="flex flex-col min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-sans text-xs font-semibold text-slate-400 dark:text-slate-500">
                    {currencyPrefix}
                  </span>
                  <span className="font-mono font-black text-3xl sm:text-4xl tracking-tight text-slate-900 dark:text-slate-50 tabular-nums">
                    {formatAssetPrice(current, kind)}
                  </span>
                  <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 ml-1">
                    {kind === 'stock' ? '现价' : (fund.navOnly ? '官方净值' : fund.proxyTicker ? '代理估值' : '估算净值')}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className={`font-mono font-bold text-lg sm:text-xl tabular-nums ${dirColor}`}>
                    {cleanChangeAmt > 0 ? '+' : ''}{formatAssetPrice(cleanChangeAmt, kind, kind === 'stock' ? 2 : 4)}
                  </span>
                  <span className={`font-mono font-bold text-base sm:text-lg tabular-nums ${dirColor}`}>
                    ({cleanChangePct > 0 ? '+' : ''}{cleanChangePct.toFixed(2)}%)
                  </span>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500 ml-1 font-medium">
                    {kind === 'stock'
                      ? (isTrading ? '盘中撮合成交' : '已收盘')
                      : (fund.navOnly ? '官方披露净值' : isTrading ? '盘中实时估值' : '收盘估值')}
                  </span>
                </div>
              </div>

              {/* 右侧：市场交易状态与更新时间微岛（消除双圆点冲突与折行） */}
              <div className="flex flex-col items-start sm:items-end gap-1.5 shrink-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <MarketStatusBadge gzTs={gzTs} fundName={fund.name} fundCode={fund.fundcode} market={fund.market} className="text-xs" />
                  <QuoteSourceBadge fund={fund} />
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
                  <RelativeTime timestamp={gzTs} prefix="更新于 " />
                  <span className="opacity-40">·</span>
                  <span>{new Date(gzTs).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span>
                  {fund.quoteTime && <><span className="opacity-40">·</span><span title="上游行情时间">上游 {fund.quoteTime}</span></>}
                </div>
              </div>
            </div>

            {/* 仅在桌面端/平板展示 (hidden sm:block)，移动端彻底剥离并下沉至走势图下方 */}
            <div className="hidden sm:block">
              <Divider className="my-0 mb-3 border-slate-100 dark:border-white/10" />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
              {kind === 'stock' ? (
                <>
                  {/* 格子 1：昨收 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">昨收</span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
                      {previous > 0 ? formatAssetPrice(previous, kind, 2) : '—'}
                    </div>
                    {prevCloseDate && <span className="text-[10px] text-slate-400 font-mono">{prevCloseDate}</span>}
                  </div>

                  {/* 格子 2：今开 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">今开</span>
                    <div className={`font-mono font-bold text-sm sm:text-base tabular-nums ${
                      openPrice && previous
                        ? (openPrice > previous ? 'text-[var(--color-up)]' : openPrice < previous ? 'text-[var(--color-down)]' : 'text-slate-800 dark:text-slate-100')
                        : 'text-slate-800 dark:text-slate-100'
                    }`}>
                      {openPrice != null && openPrice > 0 ? formatAssetPrice(openPrice, kind, 2) : '—'}
                    </div>
                  </div>

                  {/* 格子 3：最高 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">最高</span>
                    <div className={`font-mono font-bold text-sm sm:text-base tabular-nums ${
                      highPrice && previous && highPrice > previous ? 'text-[var(--color-up)]' : 'text-slate-800 dark:text-slate-100'
                    }`}>
                      {highPrice != null && highPrice > 0 ? formatAssetPrice(highPrice, kind, 2) : '—'}
                    </div>
                  </div>

                  {/* 格子 4：最低 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">最低</span>
                    <div className={`font-mono font-bold text-sm sm:text-base tabular-nums ${
                      lowPrice && previous && lowPrice < previous ? 'text-[var(--color-down)]' : 'text-slate-800 dark:text-slate-100'
                    }`}>
                      {lowPrice != null && lowPrice > 0 ? formatAssetPrice(lowPrice, kind, 2) : '—'}
                    </div>
                  </div>

                  {/* 格子 5：换手率 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">换手率</span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
                      {(fund as any).stockSpecific?.turnoverRate != null ? `${(fund as any).stockSpecific.turnoverRate.toFixed(2)}%` : '—'}
                    </div>
                  </div>

                  {/* 格子 6：振幅 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">日内振幅</span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
                      {amplitude != null ? `${amplitude.toFixed(2)}%` : '—'}
                    </div>
                  </div>

                  {/* 格子 7：总市值 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">总市值</span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
                      {(fund as any).stockSpecific?.totalMarketCap ? formatMarketCap((fund as any).stockSpecific.totalMarketCap, fund.market) : '—'}
                    </div>
                  </div>

                  {/* 格子 8：持有资产 (可点击编辑持仓) */}
                  <div className="flex flex-col min-w-0 cursor-pointer group" onClick={onEditPosition}>
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider flex items-center justify-between">
                      持有资产 <Pencil size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                    </span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums truncate">
                      {position ? `${currencyPrefix}${holdingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '未持仓'}
                    </div>
                    {position ? (
                      <span className={`text-[10px] font-mono truncate ${holdingProfit > 0 ? 'text-[var(--color-up)]' : holdingProfit < 0 ? 'text-[var(--color-down)]' : 'text-slate-400'}`}>
                        {position.shares}股 · 盈亏 {holdingProfit >= 0 ? '+' : ''}{currencyPrefix}{holdingProfit.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-400 font-mono opacity-60">点击录入</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* 基金格子 1：官方基准净值（权威披露） */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">官方净值</span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
                      {fund.dwjz ? parseFloat(fund.dwjz).toFixed(4) : (previous > 0 ? previous.toFixed(4) : '—')}
                    </div>
                    {(fund.officialNavDate || fund.jzrq) && (
                      <span className="text-[10px] text-slate-400 font-mono">
                        {fund.officialNavDate || fund.jzrq} 披露
                      </span>
                    )}
                  </div>

                  {/* 基金格子 2：今日估算变动（消除同义重复，呈现盘中变动点位与幅度） */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">估算变动</span>
                    <div className={`font-mono font-bold text-sm sm:text-base tabular-nums ${dirColor}`}>
                      {cleanChangeAmt >= 0 ? '+' : ''}{formatAssetPrice(cleanChangeAmt, kind, 4)}
                    </div>
                    <span className={`text-[10px] font-mono ${dirColor}`}>
                      {cleanChangePct >= 0 ? '+' : ''}{cleanChangePct.toFixed(2)}%
                    </span>
                  </div>

                  {/* 基金格子 3：基金规模 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">基金规模</span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums">
                      {basic?.scale?.size != null ? `${basic.scale.size}亿` : '—'}
                    </div>
                    {basic?.scale?.reportDate && (
                      <span className="text-[10px] text-slate-400 font-mono">{basic.scale.reportDate}</span>
                    )}
                  </div>

                  {/* 基金格子 4：基金经理 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">基金经理</span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums truncate">
                      {basic?.manager?.name || '—'}
                    </div>
                    {basic?.manager?.workTime && (
                      <span className="text-[10px] text-slate-400 font-mono truncate">{basic.manager.workTime}</span>
                    )}
                  </div>

                  {/* 基金格子 5：持有金额 */}
                  <div className="flex flex-col min-w-0 cursor-pointer group" onClick={onEditPosition}>
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider flex items-center justify-between">
                      持有资产 <Pencil size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                    </span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums truncate">
                      {position ? `${currencyPrefix}${holdingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '未持仓'}
                    </div>
                    {position ? (
                      <span className="text-[10px] text-slate-400 font-mono truncate">
                        {parseFloat(position.shares.toFixed(4))}份 · @{position.cost.toFixed(4)}
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-400 font-mono opacity-60">点击录入</span>
                    )}
                  </div>

                  {/* 基金格子 6：估算收益 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">估算收益</span>
                    <div className={`font-mono font-bold text-sm sm:text-base tabular-nums truncate ${
                      position
                        ? (holdingProfit > 0 ? 'text-[var(--color-up)]' : holdingProfit < 0 ? 'text-[var(--color-down)]' : 'text-slate-800 dark:text-slate-100')
                        : 'text-slate-800 dark:text-slate-100'
                    }`}>
                      {position ? `${holdingProfit >= 0 ? '+' : ''}${currencyPrefix}${Math.abs(holdingProfit).toFixed(2)}` : '—'}
                    </div>
                    {position ? (
                      <span className={`text-[10px] font-mono ${holdingProfitPct >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                        {holdingProfitPct >= 0 ? '+' : ''}{holdingProfitPct.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-400 font-mono opacity-60">无持仓数据</span>
                    )}
                  </div>

                  {/* 基金格子 7：近1月表现 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">近1月表现</span>
                    <div className={`font-mono font-bold text-sm sm:text-base tabular-nums truncate ${
                      basic?.returns?.m1 != null
                        ? (basic.returns.m1 > 0 ? 'text-[var(--color-up)]' : basic.returns.m1 < 0 ? 'text-[var(--color-down)]' : 'text-slate-800 dark:text-slate-100')
                        : 'text-slate-800 dark:text-slate-100'
                    }`}>
                      {basic?.returns?.m1 != null ? `${basic.returns.m1 >= 0 ? '+' : ''}${basic.returns.m1.toFixed(2)}%` : '—'}
                    </div>
                    {basic?.returns?.y1 != null && (
                      <span className="text-[10px] text-slate-400 font-mono truncate">
                        近1年 {basic.returns.y1 >= 0 ? '+' : ''}{basic.returns.y1.toFixed(2)}%
                      </span>
                    )}
                  </div>

                  {/* 基金格子 8：业绩基准/底层跟踪 */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500 tracking-wider">业绩基准</span>
                    <div className="font-mono font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 tabular-nums truncate" title={getFundBenchmark(fund)}>
                      {getFundBenchmark(fund)}
                    </div>
                    <span className="text-[10px] text-slate-400 font-mono truncate">
                      {fund.proxyTicker ? '底层ETF穿透' : (fund.market === 'us' ? '全球海外权益' : fund.market === 'hk' ? '港股互联' : '标的指数')}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
    );

    return isTrading ? <BorderBeam size={80} duration={8}>{unifiedTradingCard}</BorderBeam> : unifiedTradingCard;
  })()}

      {/* ── Chart card ───────────────────────────────────────── */}
      <section className="rounded-2xl border border-[var(--hairline-border)] bg-white/40 dark:bg-white/[0.02] p-2 sm:p-3.5">
        <Suspense fallback={
          <div className={`${isExpanded ? 'h-[400px]' : 'h-[300px]'} rounded-xl bg-slate-100/50 dark:bg-white/5 flex flex-col items-center justify-center gap-3`}>
            <Spin size="large" tip="正在加载图表模块..." />
          </div>
        }>
          {minuteLoading || historyLoading ? (
            <div className={`${isExpanded ? 'h-[400px]' : 'h-[300px]'} rounded-xl bg-slate-100/50 dark:bg-white/5 flex flex-col items-center justify-center gap-3`}>
              <Spin size="large" tip={kind === 'stock' ? '分时数据加载中...' : '历史走势数据加载中...'} />
            </div>
          ) : (
          <FundChart
          key={`${chartKey}-${(fund as any).dataDate || fund.gztime?.split(' ')[0] || ''}`}
          fundCode={fund.fundcode}
          fundName={fund.name}
          market={fund.market}
          kind={kind}
          current={current}
          previous={previous}
          openPrice={openPrice}
          highPrice={highPrice}
          lowPrice={lowPrice}
          minuteFeed={minuteData}
          height={isExpanded ? 400 : 300}
          history={history}
          historyLoading={historyLoading}
          refreshing={refreshing}
          onRefresh={handleRefresh}
          />
          )}
        </Suspense>
      </section>

      {/* ── 移动端下沉展示：标的概况与深度指标 (sm:hidden，实现分时图首屏直出) ── */}
      <div className="sm:hidden rounded-2xl border border-[var(--hairline-border)] p-3.5 bg-white/85 dark:bg-[#1c1c1e]/85 backdrop-blur-md shadow-2xs space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
            {kind === 'stock' ? '股票核心指标与盘口' : '标的概况与深度档案'}
          </span>
          <span className="text-[10px] text-slate-400 font-mono">
            {kind === 'stock' ? '交易所撮合' : '定期报告披露'}
          </span>
        </div>
        {renderTradingMatrixGrid()}
      </div>

      {/* ── Daily candlestick chart (仅股票，位于分时图下方，视口滚入懒加载) ── */}
      {kind === 'stock' && (
        <div ref={klineContainerRef}>
          {klineVisible ? (
            <Suspense fallback={
              <div className="h-[320px] rounded-2xl border border-[var(--hairline-border)] bg-white/40 dark:bg-white/[0.02] flex items-center justify-center">
                <Spin size="large" tip="正在加载 K 线图模块..." />
              </div>
            }>
              <StockKLineChart
                code={fund.fundcode}
                name={fund.name}
                market={fund.market}
                data={klineData}
                period={klinePeriod}
                loading={klineLoading}
                onPeriodChange={setKlinePeriod}
                height={isExpanded ? 420 : 360}
              />
            </Suspense>
          ) : (
            <div className="h-[320px] rounded-2xl border border-[var(--hairline-border)] bg-white/20 dark:bg-white/[0.01] flex items-center justify-center">
              <Spin size="small" tip="等待可视区激活..." />
            </div>
          )}
        </div>
      )}

      {/* ── Capital flow bar chart (仅 A 股个股) ── */}
      {kind === 'stock' && (fund.market === 'domestic' || fund.market === 'other' || (!fund.market && /^(SH|SZ|BJ)?\d{6}$/i.test(fund.fundcode))) && (
        (fund as any).stockSpecific?.flow ? (
          <CapitalFlowChart flow={(fund as any).stockSpecific.flow} />
        ) : (
          <CapitalFlowStatus state={capitalFlowState} />
        )
      )}

      {/* ── Asset allocation pie chart (仅基金) ── */}
      {kind === 'fund' && basic?.assetAllocation && (
        <AssetAllocationPie allocation={basic.assetAllocation} />
      )}

      {/* ── Footer two-column: intro + holdings summary (仅基金) ── */}
      {kind === 'fund' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FundIntroCard basic={basic} />
          <HoldingsSummaryCard basic={basic} holdings={holdings} />
        </div>
      )}

      {/* ── Alert panel (price notifications) ─────────────────── */}
      <Suspense fallback={<div className="h-12 rounded-2xl border border-[var(--hairline-border)] bg-slate-100 dark:bg-white/10 animate-pulse" />}>
        <AlertPanel
          fundCode={fund.fundcode}
          fundName={fund.name}
          kind={kind}
          market={fund.market}
          onToast={onToast}
          onOpenNotificationLogs={onOpenNotificationLogs}
        />
      </Suspense>
    </motion.div>
  );
}

/* ───────────────────────────────────────────────────────────────────
   FundIntroCard — shows manager + key info; expands inline on click
   ─────────────────────────────────────────────────────────────────── */

function FundIntroCard({ basic }: { basic: FundBasicInfo | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const loading = basic === undefined;            // not yet fetched
  const data = basic ?? null;                     // fetched but maybe null

  return (
    <div className="rounded-2xl border border-[var(--hairline-border)] overflow-hidden">
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100">
            基金简介
          </h4>
          {data?.manager?.star ? (
            <span className="flex items-center gap-0.5 text-amber-500">
              {Array.from({ length: data.manager.star }).map((_, i) => (
                <Star key={i} size={10} fill="currentColor" />
              ))}
            </span>
          ) : null}
        </div>

        {loading ? (
          <div className="space-y-2 animate-pulse">
            <div className="h-3 bg-slate-200 dark:bg-slate-800 rounded w-3/4" />
            <div className="h-3 bg-slate-200 dark:bg-slate-800 rounded w-1/2" />
          </div>
        ) : data ? (
          <>
            {/* Manager row */}
            <div className="flex items-center gap-2.5 mb-3">
              {data.manager?.pic ? (
                <img
                  src={data.manager.pic}
                  alt={data.manager.name}
                  className="w-9 h-9 rounded-full object-cover border border-[var(--hairline-border)]"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
                  <User size={16} />
                </div>
              )}
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-slate-700 dark:text-slate-200 truncate">
                  {data.manager?.name || '—'}
                </div>
                <div className="text-[10px] text-slate-400 truncate">
                  {data.manager?.workTime || ''} · 管理规模 {data.manager?.fundSize || '—'}
                </div>
              </div>
            </div>

            {/* Returns row */}
            <div className="grid grid-cols-4 gap-2 text-center">
              <ReturnCell label="近1月" value={data.returns.m1} />
              <ReturnCell label="近3月" value={data.returns.m3} />
              <ReturnCell label="近6月" value={data.returns.m6} />
              <ReturnCell label="近1年" value={data.returns.y1} />
            </div>
          </>
        ) : (
          <p className="text-[12px] text-slate-500">暂无简介数据</p>
        )}
      </div>

      {/* Toggle button */}
      <PressableButton
        onClick={() => setExpanded(v => !v)}
        className="w-full px-4 py-2 text-[11px] font-semibold text-[var(--primary-accent)] hover:bg-[var(--primary-accent-translucent)] border-t border-[var(--hairline-border)] flex items-center justify-center gap-1 transition-colors"
      >
        {expanded ? '收起' : '查看更多'}
        <motion.span
          animate={prefersReducedMotion ? undefined : { rotate: expanded ? 180 : 0 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.28 }}
          className="inline-flex"
        >
          <ChevronDown size={12} />
        </motion.span>
      </PressableButton>

      <AnimatePresence initial={false}>
        {expanded && data && (
          <motion.div
            key="intro-expand"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.32 }}
            className="overflow-hidden"
          >
            <div className="px-4 py-3 bg-slate-50/50 dark:bg-white/[0.02] border-t border-[var(--hairline-border)] space-y-3">
              {/* Manager scoring radar */}
              {data.manager?.power && data.manager.power.data?.length > 0 && (
                <div>
                  <div className="text-[10px] text-slate-500 mb-1.5 flex items-center gap-1">
                    <Briefcase size={10} /> 基金经理综合能力评分
                  </div>
                  <div className="grid grid-cols-5 gap-1 text-center">
                    {data.manager.power.data.map((score, i) => (
                      <div key={i} className="bg-white/60 dark:bg-white/5 rounded-md p-1.5 border border-[var(--hairline-border)]">
                        <div className="text-[9px] text-slate-500 leading-none mb-1">
                          {data.manager!.power!.categories[i] || `维度${i + 1}`}
                        </div>
                        <div className="font-mono font-bold text-[12px] text-[var(--primary-accent)] tabular-nums">
                          {score.toFixed(1)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Investment scope (placeholder narrative) */}
              <div className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                <p className="mb-1.5">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">投资范围：</span>
                  本基金主要投资于具有良好流动性的金融工具，包括国内依法发行上市的股票、
                  债券、货币市场工具等。
                </p>
                <p>
                  <span className="font-semibold text-slate-700 dark:text-slate-300">投资策略：</span>
                  通过深入的基本面研究，精选具有长期成长潜力的优质公司，
                  力争实现基金资产的长期稳健增值。
                </p>
              </div>

              <div className="text-[10px] text-slate-400 pt-1 border-t border-[var(--hairline-border)]">
                数据来源：天天基金 · 基金经理数据每季度更新
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ReturnCell({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  const isUp = v > 0;
  const isDown = v < 0;
  const color = isUp ? 'text-[var(--color-up)]' : isDown ? 'text-[var(--color-down)]' : 'text-slate-500';
  return (
    <div>
      <div className="text-[9px] text-slate-500 leading-none mb-1">{label}</div>
      <div className={`font-mono font-bold text-[12px] tabular-nums flex items-center justify-center gap-0.5 ${color}`}>
        {isUp ? <TrendingUp size={9} /> : isDown ? <TrendingDown size={9} /> : null}
        {value === null ? '--' : `${isUp ? '+' : ''}${v.toFixed(2)}%`}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────
   HoldingsSummaryCard — shows stock ratio + 10 holdings table inline
   ─────────────────────────────────────────────────────────────────── */

function HoldingsSummaryCard({
  basic,
  holdings
}: {
  basic: FundBasicInfo | null | undefined;
  holdings: FundHoldingStock[];
}) {
  const [expanded, setExpanded] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const loading = basic === undefined;
  const stockRatio = basic?.assetAllocation?.stock ?? null;
  const reportDate = basic?.assetAllocation?.reportDate ?? null;
  const fundSizeYi = basic?.scale?.size ?? null;
  const fundSizeChangePct = basic?.scale?.changePct ?? null;

  return (
    <div className="rounded-2xl border border-[var(--hairline-border)] overflow-hidden">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100">
            持仓摘要
          </h4>
          <span className="text-[10px] text-slate-400 font-mono tabular-nums">
            {reportDate || '—'}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[10px] text-slate-500 mb-1">股票仓位</div>
            <div className="font-mono font-bold text-lg tabular-nums text-slate-800 dark:text-slate-100">
              {loading ? <span className="opacity-50">--</span> :
                stockRatio !== null ? `${stockRatio.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500 mb-1">持仓股票数</div>
            <div className="font-mono font-bold text-lg tabular-nums text-slate-800 dark:text-slate-100">
              {holdings.length > 0 ? holdings.length : (loading ? <span className="opacity-50">--</span> : '—')}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500 mb-1">当前规模</div>
            <div className="font-mono font-bold text-lg tabular-nums text-slate-800 dark:text-slate-100">
              {loading ? <span className="opacity-50">--</span> :
                fundSizeYi !== null ? (
                  <>
                    {fundSizeYi.toFixed(2)}
                    <span className="text-xs font-normal text-slate-500 ml-0.5">亿</span>
                    {fundSizeChangePct !== null && (
                      <span
                        className={
                          'text-xs font-normal ml-1 ' +
                          (fundSizeChangePct > 0
                            ? 'text-red-500'
                            : fundSizeChangePct < 0
                              ? 'text-emerald-600'
                              : 'text-slate-400')
                        }
                      >
                        {fundSizeChangePct > 0 ? '+' : ''}
                        {fundSizeChangePct.toFixed(2)}%
                      </span>
                    )}
                  </>
                ) : '—'}
            </div>
          </div>
        </div>
      </div>

      <PressableButton
        onClick={() => setExpanded(v => !v)}
        className="w-full px-4 py-2 text-[11px] font-semibold text-[var(--primary-accent)] hover:bg-[var(--primary-accent-translucent)] border-t border-[var(--hairline-border)] flex items-center justify-center gap-1 transition-colors"
      >
        {expanded ? '收起' : '查看完整持仓'}
        <motion.span
          animate={prefersReducedMotion ? undefined : { rotate: expanded ? 180 : 0 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.28 }}
          className="inline-flex"
        >
          <ChevronDown size={12} />
        </motion.span>
      </PressableButton>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="holdings-expand"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.32 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[var(--hairline-border)] bg-slate-50/50 dark:bg-white/[0.02]">
              {holdings.length === 0 ? (
                <div className="px-4 py-6 text-center text-[11px] text-slate-400">
                  暂无持仓数据
                </div>
              ) : (
                <div className="min-w-0 overflow-x-auto">
                  <table className="w-full table-fixed text-left text-[11px]">
                    <colgroup>
                      <col style={{ width: '32px' }} />
                      <col />
                      <col style={{ width: '82px' }} />
                      <col style={{ width: '72px' }} />
                    </colgroup>
                    <thead>
                      <tr className="text-slate-400 dark:text-slate-500 border-b border-[var(--hairline-border)]">
                        <th className="font-semibold px-2 sm:px-3 py-2">#</th>
                        <th className="font-semibold px-2 sm:px-3 py-2">名称</th>
                        <th className="font-semibold px-2 sm:px-3 py-2 text-right whitespace-nowrap">现价(RMB)</th>
                        <th className="font-semibold px-2 sm:px-3 py-2 text-right pr-3 sm:pr-4 whitespace-nowrap">当日</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {holdings.map((s, i) => {
                        const pct = s.changePct ?? 0;
                        const isUp = pct > 0;
                        const isDown = pct < 0;
                        const color = isUp ? 'text-[var(--color-up)]' : isDown ? 'text-[var(--color-down)]' : 'text-slate-500';
                        return (
                          <tr key={`${s.exchange}-${s.code}`} className="hover:bg-white/60 dark:hover:bg-white/[0.04] transition-colors">
                            <td className="px-2 sm:px-3 py-1.5 text-slate-400 font-mono tabular-nums">{i + 1}</td>
                            <td className="min-w-0 px-2 py-1.5">
                              <div className="font-semibold text-slate-700 dark:text-slate-200 truncate" title={s.name}>
                                {s.name}
                              </div>
                              <div className="text-[9px] text-slate-400 font-mono">{s.displayCode}</div>
                            </td>
                            <td
                              className="px-1 py-1.5 text-right font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums whitespace-nowrap overflow-hidden text-ellipsis"
                              title={s.price !== null && s.currency && s.fxRateToCny
                                ? `原价 ${s.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${s.currency} · 汇率 ${s.fxRateToCny.toFixed(6)}${s.fxStale ? '（缓存汇率）' : ''}`
                                : '人民币汇率暂不可用'}
                            >
                              {s.priceCny != null ? `¥${s.priceCny.toFixed(s.priceCny >= 1000 ? 0 : 2)}` : '—'}
                            </td>
                            <td className={`px-1 py-1.5 text-right pr-2 font-mono font-semibold tabular-nums whitespace-nowrap ${color}`}>
                              {s.changePct !== null
                                ? `${isUp ? '+' : ''}${pct.toFixed(2)}%`
                                : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="px-4 py-2 text-[10px] text-slate-400 border-t border-[var(--hairline-border)] flex items-center justify-between flex-wrap gap-1">
                <span>持仓报价 · 腾讯/新浪/Yahoo多源行情</span>
                <span>持仓清单由东财季报提供 (占比数据未公开)</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */

function CapitalFlowStatus({ state }: { state?: 'loading' | 'unavailable' }) {
  const loading = state === 'loading';
  return (
    <div className="rounded-2xl border border-[var(--hairline-border)] p-4 min-h-[142px] flex flex-col justify-center">
      <div className="flex items-center justify-between mb-3">
        <h4 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100">资金流向</h4>
        <span className="text-[10px] text-slate-400">当日累计</span>
      </div>
      {loading ? (
        <div className="space-y-2.5 animate-pulse" aria-label="资金流向加载中">
          <div className="h-5 w-32 rounded bg-slate-200/80 dark:bg-white/10" />
          <div className="h-4 rounded bg-slate-100 dark:bg-white/5" />
          <div className="h-4 w-4/5 rounded bg-slate-100 dark:bg-white/5" />
          <p className="pt-1 text-[11px] text-slate-400">正在加载资金流向…</p>
        </div>
      ) : (
        <div className="text-center py-3">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">资金流数据暂不可用</p>
          <p className="mt-1 text-[11px] text-slate-400">等待实时推送补齐</p>
        </div>
      )}
    </div>
  );
}

/**
 * 资金流向条形图（A 股个股）
 *   - 顶部大数字：主力净流入额（红涨/绿跌）
 *   - 横向条形图：4 档分类（特大单 / 大单 / 中单 / 小单），正负方向独立绘制
 *   - 数据缺失时不渲染
 *
 *   数据来自东方财富 push2（仅 A 股）。字段含义按东财 f10 资金流向页惯例：
 *     主力 = 特大单 + 大单
 *     散户 = 中单 + 小单
 */
function CapitalFlowChart({
  flow
}: {
  flow: {
    mainNet: number;
    superLargeNet: number;
    largeNet: number;
    mediumNet: number;
    smallNet: number;
    _source?: string;
  };
}) {
  const yi = (v: number) => v / 1e8;   // 元 → 亿

  const segments = [
    { key: 'super', label: '特大单',  value: flow.superLargeNet, color: '#dc2626' },
    { key: 'large',  label: '大单',    value: flow.largeNet,      color: '#f97316' },
    { key: 'medium', label: '中单',    value: flow.mediumNet,     color: '#3b82f6' },
    { key: 'small',  label: '小单',    value: flow.smallNet,      color: '#8b5cf6' },
  ];

  // 找出绝对值最大的作为条形图缩放基准
  const maxAbs = Math.max(...segments.map(s => Math.abs(s.value)), 1);
  const mainYi = yi(flow.mainNet);
  const isMainPositive = flow.mainNet >= 0;
  // 中单+小单 = 散户（粗略估算，不一定严格 = -(主力)）
  const retail = flow.mediumNet + flow.smallNet;

  return (
    <div className="rounded-2xl border border-[var(--hairline-border)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100">
          资金流向
        </h4>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400 font-mono tabular-nums">当日累计</span>
          <span
            className="text-[9px] text-slate-400 font-mono tabular-nums"
            title={flow._source === 'push2delay'
              ? 'push2.eastmoney.com 不可用，已自动切换到 push2delay 备域名'
              : '数据来自东方财富 push2 资金流向接口。新股（N股）首日数据可能漏算部分成交额，建议参考 f10 页面或同花顺等第三方源交叉验证。'}
          >
            {flow._source === 'push2delay' ? '东方财富·push2delay' : '东方财富'}
          </span>
        </div>
      </div>

      {/* 头部大数字：主力净流入 */}
      <div className="flex items-baseline gap-2 mb-4">
        <span
          className={
            'font-mono font-bold tabular-nums leading-none ' +
            (isMainPositive ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')
          }
          style={{ fontSize: '1.5rem' }}
        >
          {isMainPositive ? '+' : ''}{mainYi.toFixed(2)}
        </span>
        <span className="text-sm text-slate-500">亿（主力净流入）</span>
        <span className="ml-auto text-[10px] text-slate-400 font-mono tabular-nums">
          散户 {(retail >= 0 ? '+' : '') + retail.toFixed(2)} 亿
        </span>
      </div>

      {/* 条形图：4 档分类，正负方向分别从中线向两边延伸 */}
      <div className="space-y-2.5">
        {segments.map(s => {
          const v = s.value;
          const widthPct = (Math.abs(v) / maxAbs) * 50;  // 单边最大 50%
          const isPositive = v >= 0;
          return (
            <div key={s.key} className="flex items-center gap-2 text-xs">
              <div className="w-14 shrink-0 text-slate-500 font-medium">{s.label}</div>
              <div className="flex-1 relative h-5 flex items-center">
                {/* 中线 */}
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-300/60 dark:bg-slate-600/60" />
                {/* 条形 */}
                {isPositive ? (
                  <div
                    className="absolute h-5 rounded-sm transition-all"
                    style={{
                      left: '50%',
                      width: `${widthPct}%`,
                      backgroundColor: s.color,
                      opacity: 0.85,
                    }}
                    title={`${s.label} 净流入 ${yi(v).toFixed(2)} 亿`}
                  />
                ) : (
                  <div
                    className="absolute h-5 rounded-sm transition-all"
                    style={{
                      right: '50%',
                      width: `${widthPct}%`,
                      backgroundColor: s.color,
                      opacity: 0.85,
                    }}
                    title={`${s.label} 净流出 ${Math.abs(yi(v)).toFixed(2)} 亿`}
                  />
                )}
              </div>
              <div
                className={
                  'w-20 shrink-0 text-right font-mono tabular-nums font-semibold ' +
                  (isPositive ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')
                }
              >
                {(v >= 0 ? '+' : '') + yi(v).toFixed(2)}亿
              </div>
            </div>
          );
        })}
      </div>

      {/* 图例（颜色 → 含义） */}
      <div className="mt-4 pt-3 border-t border-[var(--hairline-border)] flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: '#dc2626' }} /> 特大单（≥100万）</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: '#f97316' }} /> 大单（20-100万）</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: '#3b82f6' }} /> 中单（4-20万）</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: '#8b5cf6' }} /> 小单（&lt;4万）</span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */

/**
 * 资产配置扇形图（股票 / 债券 / 现金）
 *   - SVG 圆环图，hover 高亮某 segment 并把外部 % 标签同步放大
 *   - 中心显示股票仓位（最大占比项）
 *   - 右侧图例带百分比和颜色块
 *   - 数据缺失时不渲染整张卡片
 */
function AssetAllocationPie({
  allocation
}: {
  allocation: NonNullable<FundBasicInfo['assetAllocation']>;
}) {
  const { stock, bond, cash, reportDate } = allocation;
  // 过滤有效段并按当前值降序（视觉稳定）
  const segments = [
    { key: 'stock', label: '股票', value: stock, color: '#ef4444' },  // 红色 = 风险资产
    { key: 'bond',  label: '债券', value: bond,  color: '#10b981' },  // 绿色 = 稳健
    { key: 'cash',  label: '现金', value: cash,  color: '#64748b' },  // 灰 = 现金
  ].filter(s => typeof s.value === 'number' && s.value > 0);

  const [hovered, setHovered] = useState<string | null>(null);

  if (segments.length === 0) return null;
  // 归一化（防合计略偏离 100 导致圆环缺口）
  const total = segments.reduce((a, s) => a + (s.value as number), 0);

  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const r = 56;
  const innerR = 36;

  // 计算每个 segment 的起止角度（从 -90° 起，顺时针）
  let acc = 0;
  const arcs = segments.map(s => {
    const v = s.value as number;
    const startAngle = (acc / total) * 360 - 90;
    acc += v;
    const endAngle = (acc / total) * 360 - 90;
    return { ...s, startAngle, endAngle, ratio: v / total };
  });

  // 中心数字：显示最大占比项
  const headline = segments.reduce((a, b) => ((a.value as number) >= (b.value as number) ? a : b));

  return (
    <div className="rounded-2xl border border-[var(--hairline-border)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100">
          资产配置
        </h4>
        <span className="text-[10px] text-slate-400 font-mono tabular-nums">
          {reportDate || '—'}
        </span>
      </div>
      <div className="flex items-center gap-6 flex-wrap">
        {/* 圆环 SVG */}
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg
            viewBox={`0 0 ${size} ${size}`}
            width={size}
            height={size}
            className="overflow-visible"
            role="img"
            aria-label="资产配置扇形图"
          >
            {arcs.length === 1 ? (
              // 单 segment 100% 时的退化：用 circle 绘制（arc 命令不能画整圆）
              <circle
                cx={cx}
                cy={cy}
                r={(r + innerR) / 2}
                fill="none"
                stroke={arcs[0].color}
                strokeWidth={r - innerR}
              />
            ) : (
              arcs.map(s => {
                const start = polarToCartesian(cx, cy, r, s.startAngle);
                const end   = polarToCartesian(cx, cy, r, s.endAngle);
                const startInner = polarToCartesian(cx, cy, innerR, s.startAngle);
                const endInner   = polarToCartesian(cx, cy, innerR, s.endAngle);
                const largeArc = s.endAngle - s.startAngle > 180 ? 1 : 0;
                const isHover = hovered === s.key;
                const opacity = hovered && !isHover ? 0.45 : 1;
                const expand = isHover ? 4 : 0;
                // 沿中线方向外推
                const mid = (s.startAngle + s.endAngle) / 2;
                const rad = (mid * Math.PI) / 180;
                const dx = Math.cos(rad) * expand;
                const dy = Math.sin(rad) * expand;
                const path = [
                  `M ${start.x} ${start.y}`,
                  `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`,
                  `L ${endInner.x} ${endInner.y}`,
                  `A ${innerR} ${innerR} 0 ${largeArc} 0 ${startInner.x} ${startInner.y}`,
                  'Z',
                ].join(' ');
                return (
                  <path
                    key={s.key}
                    d={path}
                    fill={s.color}
                    opacity={opacity}
                    transform={`translate(${dx} ${dy})`}
                    style={{ transition: 'opacity 160ms ease, transform 160ms ease' }}
                    onMouseEnter={() => setHovered(s.key)}
                    onMouseLeave={() => setHovered(null)}
                  />
                );
              })
            )}
          </svg>
          {/* 中心数字 */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div
              className="font-mono font-bold tabular-nums leading-none"
              style={{
                fontSize: '1.15rem',
                color: hovered ? arcs.find(a => a.key === hovered)?.color : headline.color,
                transition: 'color 160ms ease',
              }}
            >
              {(hovered
                ? arcs.find(a => a.key === hovered)?.value
                : headline.value
              )?.toFixed(2)}
              <span className="text-[10px] font-normal text-slate-500 ml-0.5">%</span>
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              {hovered
                ? arcs.find(a => a.key === hovered)?.label
                : headline.label}
            </div>
          </div>
        </div>

        {/* 图例 */}
        <div className="flex-1 min-w-[180px] grid grid-cols-1 gap-1.5">
          {arcs.map(s => {
            const isHover = hovered === s.key;
            return (
              <div
                key={s.key}
                className="flex items-center gap-2 text-xs cursor-default"
                onMouseEnter={() => setHovered(s.key)}
                onMouseLeave={() => setHovered(null)}
                style={{ opacity: hovered && !isHover ? 0.5 : 1, transition: 'opacity 160ms ease' }}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-slate-600 dark:text-slate-300 flex-1">{s.label}</span>
                <span
                  className={
                    'font-mono font-semibold tabular-nums ' +
                    (isHover ? 'text-slate-900 dark:text-slate-50' : 'text-slate-700 dark:text-slate-200')
                  }
                >
                  {(s.value as number).toFixed(2)}%
                </span>
              </div>
            );
          })}
          <div className="text-[10px] text-slate-400 mt-1.5 pt-1.5 border-t border-[var(--hairline-border)]">
            合计 {(total).toFixed(2)}%（季报口径，可能不等于 100）
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 极坐标 → 直角坐标。SVG 默认 0°=3 点钟方向，我们把 -90° 校正到 12 点钟方向，
 * 这样第一个 segment 永远从顶端起笔。
 */
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/* ─────────────────────────────────────────────────────────────────── */


/* ─────────────────────────────────────────────────────────────────── */

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
      animate={prefersReducedMotion || disabled ? undefined : { scale: pressed ? 0.96 : 1 }}
      transition={SPRING.snap}
      className={className}
    >
      {children}
    </motion.button>
  );
};

/** Placeholder toast removed — handled by parent via onToast prop. */
