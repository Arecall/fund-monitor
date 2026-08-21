import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Drawer, ConfigProvider, theme as antdTheme, Tag, Spin, Pagination, Tooltip, Badge } from 'antd';
import { motion, AnimatePresence, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import {
  Plus,
  Trash2,
  Search,
  Info,
  DollarSign,
  Sun,
  Moon,
  LogOut,
  FolderLock,
  ChevronRight,
  Sliders,
  Sparkles,
  PieChart,
  Target,
  Settings,
  X,
  Loader2,
  Pencil,
  Maximize2,
  Minimize2,
  Bell
} from 'lucide-react';
import {
  loginUser,
  fetchMarketIndices,
  fetchFundValuation,
  fetchFundHistory,
  fetchFundBasic,
  fetchFundHoldings,
  fetchWatchlist,
  addWatchlistItem,
  removeFromWatchlist,
  reorderWatchlist,
  fetchPositions,
  savePosition,
  removePosition,
  searchByName,
  subscribeValuations,
  fetchUnreadAlertCount,
  markAlertsAsRead,
  type SearchResult,
  type FundValuation,
  type MarketIndex,
  type UserPosition,
  type FundHistoryPoint,
  type FundBasicInfo,
  type FundHoldingStock,
  type WatchlistItem,
} from './services/api';
import { detectFundMarket, isAnyMarketOpen, type FundMarket } from './utils/fundMarket';
import { QuoteSourceBadge } from './components/QuoteSourceBadge';
import { Sparkline } from './components/Sparkline';

// 架构优化：非首屏 Tab 及配置弹窗组件采用 React.lazy() 异步懒加载，缩减首屏 Bundle 体积
const EmailConfigPanel = React.lazy(() => import('./components/EmailConfigPanel').then(m => ({ default: m.EmailConfigPanel })));
const NotificationLogModal = React.lazy(() => import('./components/NotificationLogModal').then(m => ({ default: m.NotificationLogModal })));
const GoldTab = React.lazy(() => import('./components/GoldTab').then(m => ({ default: m.GoldTab })));
const AiStockPickTab = React.lazy(() => import('./components/AiStockPickTab').then(m => ({ default: m.AiStockPickTab })));
const loadFundDetailPanel = () => import('./components/FundDetailPanel').then(m => ({ default: m.FundDetailPanel }));
const FundDetailPanel = React.lazy(loadFundDetailPanel);

class DetailErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6 text-sm text-red-600 bg-red-50 dark:bg-red-950/30 rounded-2xl border border-red-200 dark:border-red-800/50">
          <div className="font-bold mb-1">详情面板渲染出错</div>
          <pre className="text-xs whitespace-pre-wrap break-all opacity-80">{String(this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ───────────────────────────────────────────────────────────────────
   Apple Motion tokens — derived from WWDC Designing Fluid Interfaces
   damping 1.0 / response 0.3–0.4 → "bounce:0, duration:0.3" in Motion API
   damping 0.8 / response 0.4 → "bounce:0.2, duration:0.4" for momentum
   ─────────────────────────────────────────────────────────────────── */

const SPRING = {
  // Critically damped — default UI (Apple's "graceful and non-distracting")
  default: { type: 'spring' as const, bounce: 0, duration: 0.32 },
  // Slight bounce — only for gesture-driven / momentum interactions
  snap:    { type: 'spring' as const, bounce: 0.18, duration: 0.38 },
  // Materialize — sheet/card arrives
  sheet:   { type: 'spring' as const, bounce: 0.05, duration: 0.42 },
  // Toast — slide-in from top
  toast:   { type: 'spring' as const, bounce: 0, duration: 0.34 },
  // 拖动期：极短 spring — 跨过落点中点时 1-2 帧内基本到位，
  //   即便被后续 setState 截断，视觉上不会"积累误差"，避免跳帧
  drag:    { type: 'spring' as const, bounce: 0, duration: 0.16 },
};

/* ───────────────────────────────────────────────────────────────────
   Hook: pointer-down feedback gives "instant" press state (§1)
   Returns a style object that activates on press, not on release.
   ─────────────────────────────────────────────────────────────────── */

function usePointerDown() {
  const [pressed, setPressed] = useState(false);
  const onPointerDown = useCallback(() => setPressed(true), []);
  const onPointerUp = useCallback(() => setPressed(false), []);
  const onPointerCancel = useCallback(() => setPressed(false), []);
  return { pressed, handlers: { onPointerDown, onPointerUp, onPointerCancel } };
}

/* ───────────────────────────────────────────────────────────────────
   Component: AnimatedNumber
   Flashes background colour when the value changes — pure Apple-style
   "continuous feedback during the interaction" (§1).
   ─────────────────────────────────────────────────────────────────── */

const AnimatedNumber = React.memo(function AnimatedNumber({
  value,
  decimals = 2,
  prefix = '',
  className = '',
  format = 'number'
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  className?: string;
  format?: 'number' | 'percent';
}) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (value === prev.current) return;
    setFlash(value > prev.current ? 'up' : 'down');
    prev.current = value;
    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [value]);

  const formatted = format === 'percent'
    ? `${value > 0 ? '+' : ''}${value.toFixed(decimals)}%`
    : `${prefix}${value.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      })}`;

  const flashClass = flash === 'up'
    ? 'animate-[valueFlashUp_600ms_ease-out]'
    : flash === 'down'
      ? 'animate-[valueFlashDown_600ms_ease-out]'
      : '';

  return (
    <span className={`${className} ${flashClass} rounded-md px-1 -mx-1 transition-colors`}>
      {formatted}
    </span>
  );
});

/* ───────────────────────────────────────────────────────────────────
   Apple Design Skeleton Loaders — 1:1 layout match with shimmer
   ─────────────────────────────────────────────────────────────────── */

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

function SkeletonCard({ code }: { code: string }) {
  return (
    <div className="p-3.5 space-y-3 animate-pulse select-none">
      {/* Header: Name + Tag */}
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1.5 flex-1 min-w-0">
          <div className="h-4 w-32 bg-slate-200/80 dark:bg-white/10 rounded-md" />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-slate-300 dark:text-slate-600">{code}</span>
            <div className="h-3.5 w-10 bg-slate-200/60 dark:bg-white/5 rounded-full" />
          </div>
        </div>
        <div className="h-6 w-6 rounded-full bg-slate-200/50 dark:bg-white/5" />
      </div>

      {/* Body: Price + Change pill */}
      <div className="flex items-baseline justify-between pt-1">
        <div className="space-y-1">
          <div className="h-2.5 w-12 bg-slate-200/60 dark:bg-white/5 rounded" />
          <div className="h-5 w-20 bg-slate-200/80 dark:bg-white/10 rounded-md" />
        </div>
        <div className="h-7 w-16 bg-slate-200/80 dark:bg-white/10 rounded-lg" />
      </div>

      {/* Footer info bar */}
      <div className="pt-2 border-t border-slate-100/60 dark:border-slate-800/40 flex items-center justify-between">
        <div className="h-3 w-24 bg-slate-200/50 dark:bg-white/5 rounded" />
        <div className="h-3 w-16 bg-slate-200/50 dark:bg-white/5 rounded" />
      </div>
    </div>
  );
}

function DetailPanelSkeleton() {
  return (
    <div className="apple-card p-5 md:p-6 space-y-5 min-h-[400px] flex flex-col items-center justify-center">
      <Spin size="large" tip="正在加载行情详情与走势图..." />
    </div>
  );
}

function SkeletonTableRow({ code }: { code: string }) {
  return (
    <tr className="animate-pulse select-none">
      {/* 名称与代码 */}
      <td className="p-4 pl-6">
        <div className="space-y-1.5">
          <div className="h-4 w-36 bg-slate-200/80 dark:bg-white/10 rounded-md" />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-slate-300 dark:text-slate-600">{code}</span>
            <div className="h-3.5 w-9 bg-slate-200/60 dark:bg-white/5 rounded-full" />
          </div>
        </div>
      </td>
      {/* 昨收 */}
      <td className="p-4 text-right">
        <div className="h-4 w-16 bg-slate-200/70 dark:bg-white/10 rounded ml-auto" />
      </td>
      {/* 现价 */}
      <td className="p-4 text-right">
        <div className="h-4 w-16 bg-slate-200/80 dark:bg-white/10 rounded ml-auto" />
      </td>
      {/* 涨跌幅 */}
      <td className="p-4 text-right">
        <div className="h-5 w-14 bg-slate-200/80 dark:bg-white/10 rounded-md ml-auto" />
      </td>
      {/* 持仓 */}
      <td className="p-4 text-right">
        <div className="h-4 w-20 bg-slate-200/60 dark:bg-white/5 rounded ml-auto" />
      </td>
      {/* 盈亏 */}
      <td className="p-4 text-right">
        <div className="h-4 w-14 bg-slate-200/60 dark:bg-white/5 rounded ml-auto" />
      </td>
      {/* 操作按钮 */}
      <td className="p-4 text-center pr-6">
        <div className="h-6 w-16 bg-slate-200/70 dark:bg-white/10 rounded-full mx-auto" />
      </td>
    </tr>
  );
}

/**
 * 前端涨跌幅强校验与自动纠错策略：
 * 某些上游数据源或历史 SSE 快照可能推送错误/陈旧的 gszzl 字段（例如现价 27.94 > 昨收 27.86 但算出了 -0.07%）。
 * 此时以 现价(gsz/dwjz) 与 昨收价(dwjz) 作为最高优先级，强制使用数学公式 `(current - prev) / prev * 100` 重算。
 */
function getRealtimeChangeVal(fund: FundValuation): number {
  const currentPrice = parseFloat(fund.gsz) || parseFloat(fund.dwjz) || 0;
  const prevPrice = parseFloat(fund.dwjz) || 0;
  if (currentPrice > 0 && prevPrice > 0) {
    return ((currentPrice - prevPrice) / prevPrice) * 100;
  }
  return parseFloat(fund.gszzl) || 0;
}

/* ───────────────────────────────────────────────────────────────────
   判定持仓 updated_at 是否为北京时间今天（今日修改/新建按 pos.cost 算今日盈亏）
   ─────────────────────────────────────────────────────────────────── */
function isUpdatedToday(updatedAt?: string): boolean {
  if (!updatedAt) return false;
  try {
    const updatedDate = new Date(updatedAt);
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(updatedDate) === fmt.format(now);
  } catch {
    return false;
  }
}

/**
 * 计算今日盈亏参考基准价（含数据强制纠错与修正）：
 * 1. 若买入单价 posCost > currentPrice（买入价高于当前最新净值）：判定为历史高位购买，今日盈亏强制按当日开盘/昨收价 (prevPrice) 计算；
 * 2. 往日旧持仓（非今日修改）：直接以昨日收盘价 (prevPrice) 作为今日基准价；
 * 3. 当日买入/修改持仓：
 *    - 若买入单价 posCost < prevPrice（买入价低于开盘/昨收价），强制以开盘/昨收价 (prevPrice) 作为今日盈亏基准价；
 *    - 若 posPrice >= prevPrice 且 posCost <= currentPrice，以买入单价 posCost 作为今日盈亏基准价；
 * 4. 防爆兜底：若 prevPrice <= 0 或无效，强制以 posCost 兜底修正，确保不计算出 NaN。
 */
function getTodayBasePrice(posCost: number, prevPrice: number, currentPrice: number, updatedToday: boolean): number {
  const safeCost = Number.isFinite(posCost) && posCost > 0 ? posCost : 0;
  const safePrev = Number.isFinite(prevPrice) && prevPrice > 0 ? prevPrice : 0;
  const safeCurrent = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0;

  // 规则1：若购买价格大于当前净值，判定为历史购买的，今日盈亏强制按当日开盘/昨收价计
  if (safeCost > 0 && safeCurrent > 0 && safeCost > safeCurrent) {
    return safePrev > 0 ? safePrev : safeCost;
  }

  // 规则2：非今日修改的历史持仓，直接按昨日收盘/开盘价计
  if (!updatedToday) {
    return safePrev > 0 ? safePrev : safeCost;
  }

  // 规则3：当日修改但买入价低于开盘/昨收价，按开盘/昨收价计
  if (safePrev > 0 && safeCost < safePrev) {
    return safePrev;
  }

  return safeCost > 0 ? safeCost : safePrev;
}

type PressDragState = {
  pendingCode: string | null;
  activeCode: string | null;
  ghostY: number;
  startY: number;
  grabOffsetY: number;
  targetIdx: number;
};

/* ───────────────────────────────────────────────────────────────────
   Memoized watchlist rows — 列表渲染 memo 化：
   SSE tick 仅更新变化的那一只基金，其它行通过浅比较 props 跳过重渲染。
   回调在 App 内以 useCallback 稳定，拖拽状态在 tick 期间引用不变，因此
   memo 比较能命中缓存，避免每次报价推送都整表重渲染。
   ─────────────────────────────────────────────────────────────────── */

interface WatchlistCardProps {
  code: string;
  fund: FundValuation;
  pos: UserPosition | undefined;
  selfTab: 'fund' | 'stock';
  pressDrag: PressDragState;
  isDropTarget: boolean;
  prefersReducedMotion: boolean | null;
  onRowPointerDown: (code: string) => (e: React.PointerEvent) => void;
  suppressClickAfterDrag: (e: React.MouseEvent) => void;
  onSelect: (code: string) => void;
  onRemove: (code: string, name: string) => void;
  onEditPosition: (code: string) => void;
  dragJustEndedRef: React.MutableRefObject<boolean>;
}

const WatchlistCard = React.memo(function WatchlistCard({
  code, fund, pos, selfTab, pressDrag, isDropTarget, prefersReducedMotion,
  onRowPointerDown, suppressClickAfterDrag, onSelect, onRemove, onEditPosition, dragJustEndedRef,
}: WatchlistCardProps) {
  const changeVal = getRealtimeChangeVal(fund);
  const isUp = changeVal > 0;
  const isDown = changeVal < 0;
  const changeBg = isUp
    ? 'bg-[var(--color-up-bg)] text-[var(--color-up)]'
    : isDown
      ? 'bg-[var(--color-down-bg)] text-[var(--color-down)]'
      : 'bg-slate-100 dark:bg-slate-800 text-slate-500';

  let holdingValue = 0;
  let todayProfit = 0;
  if (pos) {
    const currentPrice = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
    const prevPrice = parseFloat(fund.dwjz);
    holdingValue = pos.shares * currentPrice;
    const updatedToday = isUpdatedToday(pos.updated_at);
    const basePrice = getTodayBasePrice(pos.cost, prevPrice, currentPrice, updatedToday);
    if (basePrice > 0 && currentPrice > 0) {
      todayProfit = pos.shares * (currentPrice - basePrice);
    }
  }

  return (
    <motion.div
      data-fund-code={code}
      layout="position"
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
      transition={SPRING.snap}
      onPointerDown={onRowPointerDown(code)}
      onClickCapture={suppressClickAfterDrag}
      onClick={() => {
        if (dragJustEndedRef.current) return;
        onSelect(code);
      }}
      className={`p-3.5 hover:bg-slate-50/80 dark:hover:bg-white/[0.03] transition-all duration-200 ease-out cursor-pointer space-y-2 select-none relative ${
        pressDrag.pendingCode === code
          ? 'scale-[1.015] bg-white dark:bg-[#1c1c1e] shadow-[0_10px_28px_-10px_rgba(59,130,246,0.4),0_0_0_1px_rgba(59,130,246,0.18)] z-10'
          : ''
      } ${
        pressDrag.activeCode === code
          ? 'opacity-30 scale-[0.985] saturate-[0.6] transition-none'
          : ''
      } ${
        isDropTarget
          ? 'bg-blue-50/70 dark:bg-blue-950/30 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.25)]'
          : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">
            {fund.name}
          </div>
          <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
            <span className="tabular-nums">{fund.fundcode}</span>
            <Tag
              color={
                selfTab === 'stock'
                  ? (fund.market === 'us' ? 'blue' : fund.market === 'hk' ? 'green' : 'gold')
                  : 'default'
              }
              className="font-semibold text-[10px] rounded-full border-0 m-0 leading-none py-0.5 px-2 font-sans"
            >
              {selfTab === 'stock'
                ? (fund.market === 'us' ? '美股' : fund.market === 'hk' ? '港股' : 'A股')
                : '公募场外'}
            </Tag>
          </div>
        </div>

        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              onRemove(code, fund.name);
            }}
            title="退订并删除"
            aria-label="退订基金"
            className="p-1.5 rounded-full text-slate-400 hover:text-red-500 transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <div>
          <div className="text-[10px] text-slate-400">
            {selfTab === 'stock' ? '现价' : fund.navOnly ? '官方净值' : fund.quoteFreshness === 'stale' ? '估算净值（滞后）' : '估算净值'}
          </div>
          <div className="font-mono font-bold text-base text-slate-800 dark:text-slate-100 tabular-nums">
            {parseFloat(fund.gsz).toFixed(4)}
            <span className="text-[10px] font-normal text-slate-400 ml-1.5">
              {fund.gztime.split(' ')[1] || fund.gztime}
            </span>
          </div>
          <div className="mt-1 font-sans"><QuoteSourceBadge fund={fund} compact /></div>
        </div>

        {/* 迷你分时走势图 */}
        <div className="px-1 shrink-0">
          <Sparkline
            key={`${selfTab}:${fund.market || 'domestic'}:${code}`}
            code={code}
            kind={selfTab === 'stock' ? 'stock' : 'fund'}
            market={fund.market}
            currentPrice={parseFloat(fund.gsz) || parseFloat(fund.dwjz)}
            prevClose={parseFloat(fund.dwjz)}
            isUp={isUp}
            width={80}
            height={26}
          />
        </div>

        <div className={`px-2.5 py-1 rounded-lg font-mono font-bold text-sm tabular-nums ${changeBg}`}>
          {isUp ? '+' : ''}{changeVal.toFixed(2)}%
        </div>
      </div>

      <div className="pt-2 border-t border-slate-100/80 dark:border-slate-800/40 flex items-center justify-between text-[11px]" onClick={e => e.stopPropagation()}>
        {pos ? (
          <div className="flex items-center justify-between w-full">
            <div className="text-slate-500 text-[10px]">
              持仓 <span className="font-mono font-bold text-slate-700 dark:text-slate-200">¥{holdingValue.toFixed(2)}</span>
            </div>
            <div className="font-mono font-semibold text-[10px]">
              今日: <span className={todayProfit > 0 ? 'text-[var(--color-up)]' : todayProfit < 0 ? 'text-[var(--color-down)]' : 'text-slate-400'}>
                {todayProfit > 0 ? '+' : ''}{todayProfit.toFixed(2)}
              </span>
            </div>
            <button
              onClick={() => onEditPosition(code)}
              className="text-[10px] text-blue-600 dark:text-blue-400 underline ml-2"
            >
              改持仓
            </button>
          </div>
        ) : (
          <button
            onClick={() => onEditPosition(code)}
            className="text-[10px] text-slate-400 hover:text-blue-500 flex items-center gap-1"
          >
            + 添加持仓数据
          </button>
        )}
      </div>
    </motion.div>
  );
});

interface WatchlistRowProps {
  code: string;
  fund: FundValuation;
  pos: UserPosition | undefined;
  selfTab: 'fund' | 'stock';
  pressDrag: PressDragState;
  isDropTarget: boolean;
  dragOverCode: string | null;
  onRowPointerDown: (code: string) => (e: React.PointerEvent) => void;
  suppressClickAfterDrag: (e: React.MouseEvent) => void;
  onSelect: (code: string) => void;
  onRemove: (code: string, name: string) => void;
  onEditPosition: (code: string) => void;
  handleDragStart: (code: string) => (e: React.DragEvent) => void;
  handleDragOver: (code: string) => (e: React.DragEvent) => void;
  handleDrop: (code: string) => (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

const WatchlistRow = React.memo(function WatchlistRow({
  code, fund, pos, selfTab, pressDrag, isDropTarget, dragOverCode,
  onRowPointerDown, suppressClickAfterDrag, onSelect, onRemove, onEditPosition,
  handleDragStart, handleDragOver, handleDrop, onDragEnd,
}: WatchlistRowProps) {
  const changeVal = getRealtimeChangeVal(fund);
  const isUp = changeVal > 0;
  const isDown = changeVal < 0;
  const changeColor = isUp
    ? 'text-[var(--color-up)]'
    : isDown ? 'text-[var(--color-down)]' : 'text-slate-400';

  let holdingValue = 0;
  let todayProfit = 0;
  if (pos) {
    const currentPrice = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
    const prevPrice = parseFloat(fund.dwjz);
    holdingValue = pos.shares * currentPrice;
    const updatedToday = isUpdatedToday(pos.updated_at);
    const basePrice = getTodayBasePrice(pos.cost, prevPrice, currentPrice, updatedToday);
    if (basePrice > 0 && currentPrice > 0) {
      todayProfit = pos.shares * (currentPrice - basePrice);
    }
  }

  return (
    <tr
      data-fund-code={code}
      draggable={!pressDrag.activeCode}
      onDragStart={handleDragStart(code)}
      onDragOver={handleDragOver(code)}
      onDrop={handleDrop(code)}
      onDragEnd={onDragEnd}
      onPointerDown={onRowPointerDown(code)}
      onClickCapture={suppressClickAfterDrag}
      className={`apple-row select-none cursor-grab active:cursor-grabbing transition-all duration-200 ease-out ${
        pressDrag.pendingCode === code
          ? 'scale-[1.005] bg-white dark:bg-[#1c1c1e] shadow-[0_8px_24px_-8px_rgba(59,130,246,0.35),0_0_0_1px_rgba(59,130,246,0.18)] relative z-10'
          : ''
      } ${
        pressDrag.activeCode === code
          ? 'opacity-30 scale-[0.985] saturate-[0.6] transition-none'
          : ''
      } ${
        isDropTarget
          ? 'bg-blue-50/70 dark:bg-blue-950/30 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.25)] relative z-[5]'
          : ''
      } ${
        dragOverCode === code ? 'bg-blue-50/60 dark:bg-blue-950/30' : ''
      }`}
    >
      <td
        className="py-3 pl-4 pr-2 cursor-pointer hover:underline decoration-slate-400 underline-offset-4"
        onClick={() => onSelect(code)}
      >
        <div className="font-bold text-slate-800 dark:text-slate-100 truncate max-w-[160px]" title={fund.name}>
          {fund.name}
        </div>
        <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
          <span className="tabular-nums">{fund.fundcode}</span>
          <Tag
            color={
              selfTab === 'stock'
                ? (fund.market === 'us' ? 'blue' : fund.market === 'hk' ? 'green' : 'gold')
                : 'default'
            }
            className="font-semibold text-[10px] rounded-full border-0 m-0 leading-none py-0.5 px-2 font-sans"
          >
            {selfTab === 'stock'
              ? (fund.market === 'us' ? '美股' : fund.market === 'hk' ? '港股' : 'A股')
              : '公募场外'}
          </Tag>
        </div>
      </td>
      <td className="py-3 px-2 text-right font-mono font-medium tabular-nums">
        {parseFloat(fund.dwjz).toFixed(4)}
        <div className="text-[9px] text-[#86868b] mt-0.5">{fund.jzrq}</div>
      </td>
      <td className="py-3 px-2 text-right font-mono font-bold text-slate-700 dark:text-slate-300 tabular-nums whitespace-nowrap">
        {parseFloat(fund.gsz).toFixed(4)}
        <div className="text-[9px] text-[#86868b] mt-0.5">{fund.gztime.split(' ')[1] || fund.gztime}</div>
        <div className="mt-1 flex justify-end whitespace-nowrap"><QuoteSourceBadge fund={fund} compact /></div>
      </td>
      <td className={`py-3 px-2 text-right font-bold font-mono tabular-nums ${changeColor}`}>
        {isUp ? '+' : ''}{changeVal.toFixed(2)}%
      </td>
      <td className="py-3 px-2 text-center align-middle whitespace-nowrap w-[96px]">
        <Sparkline
          code={code}
          kind={selfTab === 'stock' ? 'stock' : 'fund'}
          market={fund.market}
          currentPrice={parseFloat(fund.gsz) || parseFloat(fund.dwjz)}
          prevClose={parseFloat(fund.dwjz)}
          isUp={isUp}
          width={80}
          height={24}
        />
      </td>

      <td className="py-3 px-2 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
        {pos ? (
          <button
            onClick={() => onEditPosition(code)}
            className="cursor-pointer group inline-flex flex-col items-end text-right p-1 rounded-xl hover:bg-slate-100/60 dark:hover:bg-white/5 transition-all"
          >
            <div className="font-mono font-bold text-sm text-slate-800 dark:text-slate-100 tabular-nums group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
              ¥{holdingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1 tabular-nums">
              <span>{pos.shares.toFixed(2)}份</span>
              <span className="opacity-40">·</span>
              <span>@{pos.cost.toFixed(4)}</span>
              <Pencil size={9} className="opacity-60 group-hover:opacity-100 transition-opacity ml-0.5" />
            </div>
          </button>
        ) : (
          <PressableButton
            onClick={() => onEditPosition(code)}
            className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50/80 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/50 px-2.5 py-1 rounded-full border border-blue-200/60 dark:border-blue-900/40 font-semibold transition-all"
          >
            + 持仓
          </PressableButton>
        )}
      </td>

      <td className={`py-3 px-2 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
        pos
          ? (todayProfit > 0 ? 'text-[var(--color-up)]'
              : todayProfit < 0 ? 'text-[var(--color-down)]'
              : 'text-slate-400')
          : 'text-slate-300 dark:text-slate-700'
      }`}>
        {pos ? (
          <>
            {todayProfit > 0 ? '+' : ''}
            {todayProfit.toFixed(2)}
          </>
        ) : (
          '--'
        )}
      </td>

      <td className="py-3 pr-4 pl-2 text-center whitespace-nowrap w-[110px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-center gap-1.5 whitespace-nowrap">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(code);
            }}
            className="text-[11px] font-semibold text-[var(--primary-accent)] hover:bg-[var(--primary-accent-translucent)] px-3 py-1 rounded-full transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            查看详情
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              onRemove(code, fund.name);
            }}
            title="退订并删除"
            aria-label="退订基金"
            className="p-1.5 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors cursor-pointer"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </td>
    </tr>
  );
});

/* ───────────────────────────────────────────────────────────────────
   Main App
   ─────────────────────────────────────────────────────────────────── */

function App() {
  /* ---------- Session state ---------- */
  const [currentUser, setCurrentUser] = useState<string>('');
  const [authReady, setAuthReady] = useState(false);
  const [loginInput, setLoginInput] = useState<string>('');
  const [loginPassword, setLoginPassword] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);

  /* ---------- Data state ---------- */
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [fundsData, setFundsData] = useState<Record<string, FundValuation>>({});
  // 收盘码表：broker emit 'closed' 时写入，便于后续 UI 切到"已休市"提示
  // 当前不直接消费，MarketingStatusBadge 通过 gzTs+时间也能自然显示 closed 状态
  const closedCodesRef = useRef<Record<string, { lastVal: FundValuation | null; closedAt: number }>>({});
  const setClosedCodes = useCallback((updater: (prev: Record<string, { lastVal: FundValuation | null; closedAt: number }>) => Record<string, { lastVal: FundValuation | null; closedAt: number }>) => {
    closedCodesRef.current = updater(closedCodesRef.current);
  }, []);
  const [marketIndices, setMarketIndices] = useState<MarketIndex[]>([]);
  const [positions, setPositions] = useState<Record<string, UserPosition>>({});
  const [selfTab, setSelfTab] = useState<'fund' | 'stock'>(() => {
    try {
      const saved = localStorage.getItem('fund_self_tab');
      if (saved === 'fund' || saved === 'stock') return saved;
    } catch {}
    return 'fund';
  });
  const [watchlistPage, setWatchlistPage] = useState(1);
  const [watchlistPageSize, setWatchlistPageSize] = useState(10);
  const isDesktopWatchlist = useMediaQuery('(min-width: 768px)');
  const [mainTab, setMainTab] = useState<'portfolio' | 'gold' | 'ai-stock-pick'>(() => {
    // 刷新停留在哪个 tab — 从 localStorage 恢复
    try {
      const saved = localStorage.getItem('fund_main_tab');
      if (saved === 'portfolio' || saved === 'gold' || saved === 'ai-stock-pick') return saved;
    } catch {}
    return 'portfolio';
  });

  const [detailOverrideMap, setDetailOverrideMap] = useState<Record<string, { kind: 'fund' | 'stock'; market: string }>>({});

  const handleAiOpenDetail = useCallback(async (code: string, market: 'domestic' | 'hk' | 'us' | 'other') => {
    setDetailOverrideMap(prev => ({ ...prev, [code]: { kind: 'stock', market } }));
    if (!fundsData[code]) {
      try {
        const val = await fetchFundValuation(code, 'stock', { enrich: true });
        if (val) {
          setFundsData(prev => ({ ...prev, [code]: val }));
        }
      } catch (e) {
        console.warn('获取股票即时行情失败:', e);
      }
    }
    setSelectedFundCode(code);
  }, [fundsData]);

  /* ---------- UI state ---------- */
  const [newCode, setNewCode] = useState('');
  const [listedEtfPrompt, setListedEtfPrompt] = useState<{ code: string; message: string } | null>(null);
  const preserveCodeOnTabSwitchRef = useRef<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [loading, setLoading] = useState(false);

  /* ---------- Name search autocomplete ---------- */
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchTimerRef = useRef<number | null>(null);
  const composingRef = useRef(false);  // IME 拼音输入进行中
  const addBoxRef = useRef<HTMLDivElement>(null);

  /* ---------- Edit-position modal state ---------- */
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [posActionTab, setPosActionTab] = useState<'buy' | 'sell' | 'set'>('buy');
  const [buyShares, setBuyShares] = useState('');
  const [buyCost, setBuyCost] = useState('');
  const [sellShares, setSellShares] = useState('');
  const [editShares, setEditShares] = useState('');
  const [editCost, setEditCost] = useState('');
  const [editAmount, setEditAmount] = useState('');     // 总投入金额（"按金额"模式）
  const [editMode, setEditMode] = useState<'shares' | 'amount'>('shares');  // 输入模式

  /* ---------- Preferences ---------- */
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isIntlColor, setIsIntlColor] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const watchlistRef = useRef<string[]>([]);
  const watchlistItemsRef = useRef<WatchlistItem[]>([]);
  const watchlistItemMapRef = useRef<Map<string, WatchlistItem>>(new Map());
  const fundsDataRef = useRef<Record<string, FundValuation>>({});
  const positionsRef = useRef<Record<string, UserPosition>>({});
  const currentUserRef = useRef(currentUser);
  const sessionGenerationRef = useRef(0);
  const pendingInitialQuoteCodesRef = useRef<Set<string>>(new Set());
  const activeQuoteCodesRef = useRef<string[]>([]);

  /* ---------- Selection state for detail panel ---------- */
  const [selectedFundCode, setSelectedFundCode] = useState<string | null>(null);
  const [isDetailExpanded, setIsDetailExpanded] = useState(false);
  const [isNotificationLogOpen, setIsNotificationLogOpen] = useState(false);
  const [unreadAlertCount, setUnreadAlertCount] = useState(0);
  const [deletingItem, setDeletingItem] = useState<{ code: string; name: string } | null>(null);

  // 加载当前用户未读告警推送数量
  const refreshUnreadCount = useCallback(async () => {
    if (!currentUser) return;
    const count = await fetchUnreadAlertCount();
    setUnreadAlertCount(count);
  }, [currentUser]);

  useEffect(() => {
    refreshUnreadCount();
    const timer = setInterval(refreshUnreadCount, 30_000);
    return () => clearInterval(timer);
  }, [refreshUnreadCount]);

  const handleOpenNotificationLogs = useCallback(async () => {
    setIsNotificationLogOpen(true);
    if (unreadAlertCount > 0) {
      setUnreadAlertCount(0);
      void markAlertsAsRead();
    }
  }, [unreadAlertCount]);
  const [historyMap, setHistoryMap] = useState<Record<string, FundHistoryPoint[]>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [basicMap, setBasicMap] = useState<Record<string, FundBasicInfo | null>>({});
  const [holdingsMap, setHoldingsMap] = useState<Record<string, FundHoldingStock[]>>({});
  const [detailFlowState, setDetailFlowState] = useState<Record<string, 'loading' | 'unavailable'>>({});
  const detailFetchedAtRef = useRef<Record<string, { history?: number; basic?: number; holdings?: number; flow?: number }>>({});
  const DETAIL_HISTORY_TTL = 30 * 60_000;
  const DETAIL_BASIC_TTL = 24 * 60 * 60_000;
  const DETAIL_HOLDINGS_TTL = 5 * 60_000;

  // 基础行情 tick 不携带低频扩展字段；合并保留上一帧的市值、换手率和资金流，
  // 直到后续扩展 tick 用新值替换，避免详情页在两帧之间闪隐。
  const mergeValuation = useCallback((previous: FundValuation | undefined, incoming: FundValuation, capturedAt?: number): FundValuation => {
    const canMergeStockSpecific = !!previous?.stockSpecific && !!incoming.stockSpecific && previous.market === incoming.market;
    return {
      ...incoming,
      ...(canMergeStockSpecific ? {
        stockSpecific: { ...previous.stockSpecific, ...incoming.stockSpecific },
      } : {}),
      capturedAt: capturedAt ?? incoming.capturedAt ?? Date.now(),
    } as FundValuation;
  }, []);

  // 详情的实时价格由 SSE、股票分钟线由 FundDetailPanel 自己的 10s 定时器负责。
  // 历史净值/基金资料/重仓属于低频数据，仅在首次打开或客户端 TTL 到期后刷新。
  useEffect(() => {
    if (!selectedFundCode) return;
    const code = selectedFundCode;
    const item = watchlistItemsRef.current.find(w => w.fund_code === code);
    const kind = item?.kind || 'fund';
    const now = Date.now();
    const fetchedAt = detailFetchedAtRef.current[code] || {};
    let cancelled = false;

    const historyStale = !fetchedAt.history || now - fetchedAt.history >= DETAIL_HISTORY_TTL;
    const basicStale = kind === 'fund' && (!fetchedAt.basic || now - fetchedAt.basic >= DETAIL_BASIC_TTL);
    const holdingsStale = kind === 'fund' && (!fetchedAt.holdings || now - fetchedAt.holdings >= DETAIL_HOLDINGS_TTL);

    if (historyStale) {
      setHistoryLoading(true);
      fetchFundHistory(code, 60, kind)
        .then(hist => {
          if (cancelled) return;
          detailFetchedAtRef.current[code] = { ...detailFetchedAtRef.current[code], history: Date.now() };
          setHistoryMap(prev => ({ ...prev, [code]: hist }));
        })
        .catch(err => console.error(`加载 ${code} 历史数据失败:`, err))
        .finally(() => { if (!cancelled) setHistoryLoading(false); });
    } else {
      setHistoryLoading(false);
    }

    if (basicStale) {
      fetchFundBasic(code)
        .then(basic => {
          if (cancelled) return;
          detailFetchedAtRef.current[code] = { ...detailFetchedAtRef.current[code], basic: Date.now() };
          setBasicMap(prev => ({ ...prev, [code]: basic }));
        })
        .catch(err => console.error(`加载 ${code} 基本信息失败:`, err));
    }

    if (holdingsStale) {
      fetchFundHoldings(code)
        .then(holdings => {
          if (cancelled) return;
          detailFetchedAtRef.current[code] = { ...detailFetchedAtRef.current[code], holdings: Date.now() };
          setHoldingsMap(prev => ({ ...prev, [code]: holdings }));
        })
        .catch(err => console.error(`加载 ${code} 重仓数据失败:`, err));
    }

    return () => { cancelled = true; };
  }, [selectedFundCode]);

  // 打开 A 股个股详情时，单独确保一次包含资金流向的扩展行情；常规分页行情仍保持 base-first。
  useEffect(() => {
    if (!selectedFundCode) return;
    const code = selectedFundCode;
    const item = watchlistItems.find(w => w.fund_code === code);
    const isDomesticStock = item?.kind === 'stock' && (item.market === 'domestic' || item.market === 'other' || (!item.market && /^(SH|SZ|BJ)?\d{6}$/i.test(code)));
    if (!isDomesticStock) return;

    const existing = fundsDataRef.current[code];
    if (existing?.stockSpecific?.flow) {
      setDetailFlowState(prev => {
        if (!prev[code]) return prev;
        const { [code]: _removed, ...rest } = prev;
        return rest;
      });
      return;
    }

    const fetchedAt = detailFetchedAtRef.current[code]?.flow;
    if (fetchedAt && Date.now() - fetchedAt < 60_000) return;

    let cancelled = false;
    setDetailFlowState(prev => ({ ...prev, [code]: 'loading' }));
    void fetchFundValuation(code, 'stock', { enrich: true }).then(value => {
      if (value) {
        const nextValue = mergeValuation(fundsDataRef.current[code], value);
        const next = { ...fundsDataRef.current, [code]: nextValue };
        fundsDataRef.current = next;
        setFundsData(next);
      }
      detailFetchedAtRef.current[code] = { ...detailFetchedAtRef.current[code], flow: Date.now() };
      if (cancelled) return;
      if (value?.stockSpecific?.flow) {
        setDetailFlowState(prev => {
          const { [code]: _removed, ...rest } = prev;
          return rest;
        });
      } else {
        setDetailFlowState(prev => ({ ...prev, [code]: 'unavailable' }));
      }
    });

    return () => { cancelled = true; };
  }, [selectedFundCode, watchlistItems, mergeValuation]);


  /* ---------- Drag-to-reorder（股票 tab，HTML5 原生 drag & drop）---------- */
  const [dragOverCode, setDragOverCode] = useState<string | null>(null);
  const dragSrcCodeRef = useRef<string | null>(null);
  const nativeDragInProgressRef = useRef(false); // 标记 HTML5 原生 drag 是否已激活（用于与长按 timer 互斥）

  const prefersReducedMotion = useReducedMotion();

  const visibleList = useMemo(() => {
    return watchlistItems
      .filter(item => (selfTab === 'stock' ? item.kind === 'stock' : item.kind === 'fund'))
      .map(item => ({
        code: item.fund_code,
        key: `${item.kind}:${item.market || 'domestic'}:${item.fund_code}`,
      }));
  }, [watchlistItems, selfTab]);

  const watchlistPageCount = Math.max(1, Math.ceil(visibleList.length / watchlistPageSize));
  const pagedVisibleList = useMemo(() => {
    const start = (watchlistPage - 1) * watchlistPageSize;
    return visibleList.slice(start, start + watchlistPageSize);
  }, [visibleList, watchlistPage, watchlistPageSize]);

  useEffect(() => {
    setWatchlistPage(page => Math.min(page, watchlistPageCount));
  }, [watchlistPageCount]);

  useEffect(() => {
    setWatchlistPage(1);
  }, [selfTab]);

  // 行情请求按当前停留 Tab 的分页发起；跨页持仓在首帧后再补齐，确保汇总统计最终完整。
  const { foregroundQuoteCodes, deferredHoldingQuoteCodes, quoteTargetSubscriptionKey } = useMemo(() => {
    const itemMap = new Map(watchlistItems.map(item => [item.fund_code.toUpperCase(), item]));
    const foreground: string[] = [];
    const deferredHoldings: string[] = [];
    const foregroundSet = new Set<string>();
    const seen = new Set<string>();

    const addForeground = (code?: string | null) => {
      const normalized = code?.trim();
      if (!normalized) return;
      const key = normalized.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      foregroundSet.add(key);
      foreground.push(normalized);
    };
    const addDeferredHolding = (code?: string | null) => {
      const normalized = code?.trim();
      if (!normalized) return;
      const key = normalized.toUpperCase();
      if (foregroundSet.has(key) || seen.has(key)) return;
      seen.add(key);
      deferredHoldings.push(normalized);
    };

    pagedVisibleList.forEach(item => addForeground(item.code));
    addForeground(selectedFundCode);
    Object.keys(positions).forEach(addDeferredHolding);

    const describe = (code: string) => {
      const item = itemMap.get(code.toUpperCase());
      return `${code.toUpperCase()}:${item?.kind || 'fund'}:${item?.market || ''}`;
    };
    return {
      foregroundQuoteCodes: foreground,
      deferredHoldingQuoteCodes: deferredHoldings,
      quoteTargetSubscriptionKey: `${foreground.map(describe).join('|')}||${deferredHoldings.map(describe).join('|')}`,
    };
  }, [pagedVisibleList, positions, selectedFundCode, watchlistItems]);

  const handleDragStart = useCallback((code: string) => (e: React.DragEvent) => {
    // 0) 若自定义拖动已激活，绝对禁止原生 drag（防止拖动过程中被原生系统接管）
    if (pressDragRef.current.activeCode) {
      e.preventDefault();
      return;
    }
    // 1) 若自定义计时还在挂起（pending）状态 — 阻止原生 drag，避免双系统同时触发
    if (pressDragRef.current.pendingCode === code) {
      e.preventDefault();
      return;
    }
    // 2) 若指针按下已超过 200ms 才触发 dragstart（用户明显在长按）— 禁止原生 drag
    const elapsed = pressStartTimeRef.current ? Date.now() - pressStartTimeRef.current : 0;
    if (elapsed > 200) {
      e.preventDefault();
      return;
    }
    // 3) 200ms 内的快速 dragstart，让原生 drag 处理
    nativeDragInProgressRef.current = true;
    dragSrcCodeRef.current = code;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((code: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragSrcCodeRef.current && dragSrcCodeRef.current !== code) {
      setDragOverCode(code);
    }
  }, []);

  const handleDrop = useCallback((code: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    const src = dragSrcCodeRef.current;
    setDragOverCode(null);
    dragSrcCodeRef.current = null;
    if (!src || src === code) return;

    const kind: 'fund' | 'stock' = selfTab === 'stock' ? 'stock' : 'fund';
    const list = watchlistItems.filter(i => i.kind === kind);
    const fromIdx = list.findIndex(i => i.fund_code === src);
    const toIdx = list.findIndex(i => i.fund_code === code);
    if (fromIdx < 0 || toIdx < 0) return;

    const newList = [...list];
    newList.splice(fromIdx, 1);
    newList.splice(toIdx, 0, list[fromIdx]);
    const newOrder = newList.map(i => i.fund_code);

    const otherItems = watchlistItems.filter(i => i.kind !== kind);
    const prevItems = watchlistItems;
    setWatchlistItems([...otherItems, ...newList]);

    try {
      await reorderWatchlist(kind, newOrder);
    } catch (err: any) {
      setWatchlistItems(prevItems);
      setToastMsg('排序保存失败：' + (err?.message || '请检查后端'));
      setTimeout(() => setToastMsg(null), 3000);
    }
  }, [watchlistItems, selfTab]);

  const handleDragEnd = useCallback(() => {
    setDragOverCode(null);
    nativeDragInProgressRef.current = false;
  }, []);


  /* ---------- Long-press 2s 拖动排序（PC + 移动通用，与 HTML5 drag 并存）---------- */
  const LONG_PRESS_MS = 2000;
  // 鼠标微抖动（~1-3px/s）易在 2s 内累计超过 10px，导致 timer 被误取消。鼠标放宽到 50px。
  // 触屏保留 10px：滚动 / 滑动越早取消越好，避免误激活拖动模式。
  const MOUSE_MOVE_THRESHOLD = 50;
  const TOUCH_MOVE_THRESHOLD = 10;

  const [pressDrag, setPressDrag] = useState<{
    pendingCode: string | null;     // 2s 计时正在进行的行
    activeCode: string | null;     // 已激活自定义拖动模式的行
    ghostY: number;                // 浮卡 Y（窗口坐标）
    startY: number;                // 激活瞬间的起始 Y 坐标（用于计算相对位移，保证原位浮起）
    grabOffsetY: number;           // 手指到行顶的偏移
    targetIdx: number;             // 当前落点槽位下标
  }>({ pendingCode: null, activeCode: null, ghostY: 0, startY: 0, grabOffsetY: 0, targetIdx: -1 });

  const pressDragRef = useRef(pressDrag);
  useEffect(() => { pressDragRef.current = pressDrag; }, [pressDrag]);

  const pressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const pressStartTimeRef = useRef<number | null>(null); // 按下时刻（毫秒），用于 handleDragStart 判断是否进入"长按窗口"
  const slotBoundsRef = useRef<Array<{ code: string; top: number; bottom: number; mid: number; left: number; width: number; height: number }>>([]);
  const dragJustEndedRef = useRef(false); // 释放后 300ms 内吞掉浏览器合成的 click

  const clearPressTimer = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  const activatePressDrag = useCallback((code: string) => {
    // 采样当前所有可见行的物理 Rect（按 Y 升序）
    // 关键：过滤掉 display:none 的隐藏副本（移动端卡片和桌面行在 DOM 中并存但仅一侧可见，
    //        getBoundingClientRect 对隐藏元素返回 0，会让 ghost 卡渲染到左上角宽 0 的位置）
    const rowEls = Array.from(document.querySelectorAll<HTMLElement>('[data-fund-code]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    const stockCodes = new Set(visibleList.map(item => item.code));
    const bounds = rowEls
      .filter(el => stockCodes.has(el.dataset.fundCode!))
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          code: el.dataset.fundCode!,
          top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2,
          left: r.left, width: r.width, height: r.height,
        };
      })
      .sort((a, b) => a.top - b.top);
    slotBoundsRef.current = bounds;

    const activeEl = rowEls.find(el => el.dataset.fundCode === code);
    const startY = pressStartRef.current?.y ?? 0;
    const grabOffsetY = activeEl ? startY - activeEl.getBoundingClientRect().top : 0;

    setPressDrag({
      pendingCode: null,
      activeCode: code,
      ghostY: startY,
      startY,
      grabOffsetY,
      targetIdx: bounds.findIndex(b => b.code === code),
    });

    // 触觉反馈（移动端）
    try { navigator.vibrate?.(40); } catch { /* ignore */ }
  }, [visibleList]);

  const onRowPointerDown = useCallback((code: string) => (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 跳过按钮/输入框/链接 — 让它们的原生点击行为继续工作
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, [role="button"]')) return;
    // HTML5 drag 已在进行时不参与
    if (nativeDragInProgressRef.current) return;

    pressStartRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    pressStartTimeRef.current = Date.now();
    clearPressTimer();
    setPressDrag(prev => ({ ...prev, pendingCode: code, activeCode: null }));

    pressTimerRef.current = window.setTimeout(() => {
      if (nativeDragInProgressRef.current) return;
      if (!pressStartRef.current) return;
      activatePressDrag(code);
    }, LONG_PRESS_MS);
  }, [clearPressTimer, activatePressDrag]);

  // 全局 pointermove — pending 阶段位移过大则取消，active 阶段无条件 100% 实时跟随指针 + 实时重排
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const state = pressDragRef.current;

      // 1) 【已激活拖动模式】：无条件跟进指针 e.clientY，不受 pressStartRef 是否被浏览器置空的影响
      if (state.activeCode) {
        if (e.cancelable) e.preventDefault();
        const bounds = slotBoundsRef.current;
        if (!bounds.length) return;
        const rowH = bounds[0].height;
        // ghost 中心 = 指针位置 - grabOffset + 半行高
        const ghostCenterY = e.clientY - state.grabOffsetY + rowH / 2;
        const encroachment = rowH / 5;
        let targetIdx = 0;
        for (let i = 0; i < bounds.length; i++) {
          if (ghostCenterY >= bounds[i].top + encroachment) {
            targetIdx = i;
          } else {
            break;
          }
        }
        targetIdx = Math.max(0, Math.min(targetIdx, bounds.length - 1));

        // 【实时渲染】：若计算出的目标槽位与当前列表中 activeCode 的位置不同，立即实时重排前端数组
        const items = watchlistItemsRef.current;
        const kind: 'fund' | 'stock' = selfTab === 'stock' ? 'stock' : 'fund';
        const currentSubList = items.filter(i => i.kind === kind);
        const fromIdx = currentSubList.findIndex(i => i.fund_code === state.activeCode);

        if (fromIdx >= 0 && fromIdx !== targetIdx) {
          const newSubList = [...currentSubList];
          const [movedItem] = newSubList.splice(fromIdx, 1);
          newSubList.splice(targetIdx, 0, movedItem);

          const otherItems = items.filter(i => i.kind !== kind);
          setWatchlistItems([...otherItems, ...newSubList]);
        }

        setPressDrag(prev => ({ ...prev, ghostY: e.clientY, targetIdx }));
        return;
      }

      // 2) 【2s 计时等待 pending 阶段】：位移过大则取消长按
      const start = pressStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const dist = Math.hypot(dx, dy);

      const isMouseMove = e.pointerType === 'mouse';
      const moveThreshold = isMouseMove ? MOUSE_MOVE_THRESHOLD : TOUCH_MOVE_THRESHOLD;
      if (state.pendingCode && dist > moveThreshold) {
        clearPressTimer();
        pressStartRef.current = null;
        setPressDrag({ pendingCode: null, activeCode: null, ghostY: 0, startY: 0, grabOffsetY: 0, targetIdx: -1 });
      }
    };
    document.addEventListener('pointermove', onMove, { passive: false });
    return () => document.removeEventListener('pointermove', onMove);
  }, [clearPressTimer, selfTab]);

  // 全局 pointerup / cancel — 提交排序
  useEffect(() => {
    const onUp = () => {
      const state = pressDragRef.current;
      clearPressTimer();

      // HTML5 原生 drag 正在收尾，则让原生 drop 处理
      if (nativeDragInProgressRef.current) {
        pressStartRef.current = null;
        setPressDrag({ pendingCode: null, activeCode: null, ghostY: 0, startY: 0, grabOffsetY: 0, targetIdx: -1 });
        return;
      }

      if (state.activeCode) {
        const items = watchlistItemsRef.current;
        const kind: 'fund' | 'stock' = selfTab === 'stock' ? 'stock' : 'fund';
        const list = items.filter(i => i.kind === kind);
        const finalOrder = list.map(i => i.fund_code);

        // 提交最终持久化排序
        reorderWatchlist(kind, finalOrder).catch((err: any) => {
          setToastMsg('排序保存失败：' + (err?.message || '请检查后端'));
          setTimeout(() => setToastMsg(null), 3000);
        });

        // 长按激活后无论是否发生位移都吞掉 click，避免误开详情面板
        dragJustEndedRef.current = true;
        setTimeout(() => { dragJustEndedRef.current = false; }, 300);
      }

      pressStartRef.current = null;
      setPressDrag({ pendingCode: null, activeCode: null, ghostY: 0, startY: 0, grabOffsetY: 0, targetIdx: -1 });
    };
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [clearPressTimer, setToastMsg, selfTab]);

  // 拦截浏览器在长按拖动抬起后合成的 click
  const suppressClickAfterDrag = useCallback((e: React.MouseEvent) => {
    if (dragJustEndedRef.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);


  /* ---------- Boot ---------- */
  useEffect(() => {
    const savedTheme = localStorage.getItem('fund_theme_dark');
    if (savedTheme === 'true') {
      setIsDarkMode(true);
      document.documentElement.classList.add('dark');
    }
    const savedIntlColor = localStorage.getItem('fund_intl_color');
    if (savedIntlColor === 'true') {
      setIsIntlColor(true);
      document.documentElement.classList.add('intl-color');
    }
    const savedUser = localStorage.getItem('fund_user_name');
    if (savedUser && savedUser !== 'guest') {
      setCurrentUser(savedUser);
      setIsLoggedIn(true);
    } else {
      setCurrentUser('guest');
      setIsLoggedIn(false);
    }
    setAuthReady(true);
  }, []);

  useEffect(() => {
    currentUserRef.current = currentUser;
    sessionGenerationRef.current += 1;
    pendingInitialQuoteCodesRef.current.clear();
    fundsDataRef.current = {};
    setFundsData({});
    setSelectedFundCode(null);
    setHistoryMap({});
    setBasicMap({});
    setHoldingsMap({});
    detailFetchedAtRef.current = {};
  }, [currentUser]);

  useEffect(() => {
    if (authReady && isLoggedIn && currentUser) loadUserData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, isLoggedIn, currentUser]);

  /* ---------- Polling (background-friendly + 休市自动暂停) ---------- */
  // 使用 ref 跟踪最新 state，避免定时器回调闭包过期
  useEffect(() => {
    watchlistRef.current = watchlist;
    watchlistItemsRef.current = watchlistItems;
    watchlistItemMapRef.current = new Map(
      watchlistItems.map(item => [item.fund_code.toUpperCase(), item])
    );
    fundsDataRef.current = fundsData;
    positionsRef.current = positions;
    activeQuoteCodesRef.current = [...foregroundQuoteCodes, ...deferredHoldingQuoteCodes];
  });

  // 仅刷新当前种类的代码，避免打爆上游
  const refreshOneKind = (kindFilter: 'fund' | 'stock') => {
    if (document.visibilityState !== 'visible') return;

    const codes = activeQuoteCodesRef.current;
    const itemMap = watchlistItemMapRef.current;
    const data = fundsDataRef.current;

    const targetCodes = codes.filter(code => {
      const item = itemMap.get(code.toUpperCase());
      return (item?.kind || 'fund') === kindFilter;
    });
    if (targetCodes.length === 0) return;

    // 休市校验：仅当该种类下的市场仍有活跃时刷新
    const activeMarkets: FundMarket[] = targetCodes.map(code => {
      const item = itemMap.get(code.toUpperCase());
      if (item?.market === 'us' || item?.market === 'hk' || item?.market === 'domestic' || item?.market === 'other') {
        return item.market;
      }
      const val = data[code];
      return detectFundMarket(val?.name, code);
    });
    if (!isAnyMarketOpen(activeMarkets)) return;

    (async () => {
      try {
        const updatedFunds = { ...data };
        await Promise.all(targetCodes.map(async (code) => {
          const item = itemMap.get(code.toUpperCase());
          const val = await fetchFundValuation(code, item?.kind);
          if (val) updatedFunds[code] = mergeValuation(data[code], val);
        }));
        fundsDataRef.current = updatedFunds;
        setFundsData(updatedFunds);
      } catch (e) {
        console.error(`[poll:${kindFilter}] 轮询失败:`, e);
      }
    })();
  };

  /** SSE 实时订阅：当前分页优先，非当前页持仓在首帧完成或短超时后补齐。 */
  useEffect(() => {
    if (!currentUser) return;
    const foregroundCodes = foregroundQuoteCodes.map(code => code.trim()).filter(Boolean);
    const deferredCodes = deferredHoldingQuoteCodes.map(code => code.trim()).filter(Boolean);
    if (foregroundCodes.length === 0 && deferredCodes.length === 0) return;

    const itemMap = watchlistItemMapRef.current;
    const pendingCodes = new Set([...foregroundCodes, ...deferredCodes].filter(code => !fundsDataRef.current[code]));
    const pendingForegroundCodes = new Set(foregroundCodes.filter(code => pendingCodes.has(code)));
    let fallbackCancelled = false;
    let deferredStarted = false;
    pendingInitialQuoteCodesRef.current = pendingCodes;

    // SSE tick 批处理：同一帧内到达的多个 tick 合并为一次 setFundsData，避免逐条触发整树重渲染。
    const pendingTickRef = { map: new Map<string, { val: FundValuation; capturedAt: number }>(), raf: 0 };
    const flushPendingTicks = () => {
      pendingTickRef.raf = 0;
      if (pendingTickRef.map.size === 0) return;
      const updates = pendingTickRef.map;
      pendingTickRef.map = new Map();
      const base = fundsDataRef.current;
      const next = { ...base };
      for (const [c, u] of updates) {
        const value = mergeValuation(base[c], u.val, u.capturedAt);
        next[c] = value;
        if (value.stockSpecific?.flow) {
          setDetailFlowState(prev => {
            if (!prev[c]) return prev;
            const { [c]: _removed, ...rest } = prev;
            return rest;
          });
        }
      }
      fundsDataRef.current = next;
      setFundsData(next);
    };

    const disposers: Array<() => void> = [];
    const groupByMarketAndKind = (targetCodes: string[]) => {
      const groups: Record<string, { kind: 'stock' | 'fund'; codes: string[] }> = {};
      for (const code of targetCodes) {
        const item = itemMap.get(code.toUpperCase());
        const kind = item?.kind || 'fund';
        const market = item?.market || detectFundMarket(undefined, code);
        const key = `${kind}:${market}`;
        if (!groups[key]) groups[key] = { kind, codes: [] };
        groups[key].codes.push(code);
      }
      for (const [key, group] of Object.entries(groups)) {
        const market = key.slice(key.indexOf(':') + 1) as FundMarket;
        const sub = subscribeValuations({
          codes: group.codes,
          kind: group.kind,
          market,
          onTick: t => {
            pendingCodes.delete(t.code);
            pendingForegroundCodes.delete(t.code);
            pendingTickRef.map.set(t.code, { val: t.val, capturedAt: t.capturedAt });
            if (!pendingTickRef.raf) pendingTickRef.raf = requestAnimationFrame(flushPendingTicks);
            setClosedCodes(prev => { const { [t.code]: _omit, ...rest } = prev; return rest; });
            if (pendingForegroundCodes.size === 0) activateDeferred();
          },
          onClosed: c => {
            const price = c.lastVal ? (parseFloat(c.lastVal.gsz) || parseFloat(c.lastVal.dwjz)) : 0;
            const hasUsableQuote = Number.isFinite(price) && price > 0;
            if (hasUsableQuote) {
              pendingCodes.delete(c.code);
              pendingForegroundCodes.delete(c.code);
            }
            setClosedCodes(prev => ({ ...prev, [c.code]: c }));
            if (hasUsableQuote && c.lastVal) {
              const closedVal = c.lastVal.quoteTimestamp
                ? { ...c.lastVal, quoteSession: 'closed' as const, quoteFreshness: 'stale' as const,
                    quoteAgeMs: Math.max(0, c.closedAt - c.lastVal.quoteTimestamp),
                    proxyFallbackReason: c.lastVal.proxyFallbackReason || '交易时段已结束，保留最后有效代理报价' }
                : c.lastVal;
              const next = { ...fundsDataRef.current, [c.code]: { ...closedVal, capturedAt: c.closedAt } };
              fundsDataRef.current = next;
              setFundsData(next);
            }
            if (pendingForegroundCodes.size === 0) activateDeferred();
          },
        });
        disposers.push(sub);
      }
    };

    const fetchMissingQuotes = (targetCodes: string[]) => {
      const remainingCodes = targetCodes.filter(code => pendingCodes.has(code) && !fundsDataRef.current[code]);
      let cursor = 0;
      const updates: Record<string, FundValuation> = {};
      const worker = async () => {
        while (!fallbackCancelled && cursor < remainingCodes.length) {
          const code = remainingCodes[cursor++];
          if (!pendingCodes.has(code) || fundsDataRef.current[code]) continue;
          const item = itemMap.get(code.toUpperCase());
          const val = await fetchFundValuation(code, item?.kind);
          if (fallbackCancelled || !val || !pendingCodes.has(code)) continue;
          pendingCodes.delete(code);
          pendingForegroundCodes.delete(code);
          updates[code] = mergeValuation(fundsDataRef.current[code], val, Date.now());
        }
      };
      void Promise.all(Array.from({ length: Math.min(4, remainingCodes.length) }, worker)).then(() => {
        if (fallbackCancelled || Object.keys(updates).length === 0) return;
        const next = { ...fundsDataRef.current, ...updates };
        fundsDataRef.current = next;
        setFundsData(next);
        if (pendingForegroundCodes.size === 0) activateDeferred();
      });
    };

    let deferredFallbackTimer: number | null = null;
    const activateDeferred = () => {
      if (deferredStarted || fallbackCancelled) return;
      deferredStarted = true;
      if (deferredCodes.length === 0) return;
      groupByMarketAndKind(deferredCodes);
      deferredFallbackTimer = window.setTimeout(() => fetchMissingQuotes(deferredCodes), 1200);
    };

    // 先只订阅当前恢复/停留 Tab 的当前页（和可能已打开的详情）。
    groupByMarketAndKind(foregroundCodes);
    const foregroundFallbackTimer = window.setTimeout(() => fetchMissingQuotes(foregroundCodes), 1200);
    // 某个慢源不能阻塞总资产：短超时后仍后台补齐跨页持仓。
    const deferredStartTimer = window.setTimeout(activateDeferred, 2200);
    if (pendingForegroundCodes.size === 0) activateDeferred();

    return () => {
      fallbackCancelled = true;
      window.clearTimeout(foregroundFallbackTimer);
      window.clearTimeout(deferredStartTimer);
      if (deferredFallbackTimer !== null) window.clearTimeout(deferredFallbackTimer);
      if (pendingTickRef.raf) cancelAnimationFrame(pendingTickRef.raf);
      disposers.forEach(d => d());
    };
    // 订阅重建只由稳定目标 key 驱动；tick 本身不能触发重连。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, quoteTargetSubscriptionKey]);

  // 兜底轮询：SSE 静默失效时才按对应市场和品种回退 REST，收盘市场不会请求。
  useEffect(() => {
    if (!currentUser) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const data = fundsDataRef.current;
      const itemMap = watchlistItemMapRef.current;
      const now = Date.now();
      const staleKinds = new Set<'stock' | 'fund'>();
      for (const code of activeQuoteCodesRef.current) {
        const item = itemMap.get(code.toUpperCase());
        const kind = item?.kind || 'fund';
        const value = data[code];
        const ttl = kind === 'stock' ? 30_000 : 120_000;
        if (!value || typeof value.capturedAt !== 'number' || now - value.capturedAt > ttl) {
          staleKinds.add(kind);
        }
      }
      staleKinds.forEach(kind => refreshOneKind(kind));
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks-exhaustive-deps
  }, [currentUser]);

  // 顶部全球大盘在可见时持续刷新，离开页面时不产生额外请求。
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    const refreshIndices = async () => {
      if (document.visibilityState !== 'visible') return;
      const indices = await fetchMarketIndices();
      if (!cancelled && indices.length > 0) setMarketIndices(indices);
    };
    const timer = window.setInterval(refreshIndices, 30_000);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void refreshIndices(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [currentUser]);

  /* ---------- Toast ---------- */
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  }, []);

  /* ---------- Data loaders ---------- */
  const loadUserData = async () => {
    const session = currentUserRef.current;
    const generation = sessionGenerationRef.current;
    setLoading(true);
    try {
      // 首屏请求并行化：自选、持仓、大盘指数互不依赖，并发发起避免串行等待。
      const watchPromise = fetchWatchlist();
      const posPromise = fetchPositions();
      const indicesPromise = fetchMarketIndices();

      // 自选先发布：列表会立即用现有 Skeleton 行渲染，首帧报价交给 SSE 回填。
      const data = await watchPromise;
      if (currentUserRef.current !== session || sessionGenerationRef.current !== generation) return;
      setWatchlist(data.codes);
      setWatchlistItems(data.items);

      const [posList, indices] = await Promise.all([posPromise, indicesPromise]);
      if (currentUserRef.current !== session || sessionGenerationRef.current !== generation) return;

      const posMap: Record<string, UserPosition> = {};
      posList.forEach(p => { posMap[p.fund_code] = p; });
      setPositions(posMap);
      setMarketIndices(indices);
    } catch (e) {
      console.error('加载用户数据失败:', e);
      showToast('数据加载失败，请检查后端服务是否启动');
    } finally {
      if (currentUserRef.current === session && sessionGenerationRef.current === generation) {
        setLoading(false);
      }
    }
  };

  /* ---------- Auth ---------- */
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = loginInput.trim();
    const pwd = loginPassword;
    if (!name) return;
    if (!pwd) {
      setLoginError('请输入密码');
      return;
    }
    setLoginError('');
    try {
      setLoading(true);
      const res = await loginUser(name, pwd);
      if (res.success) {
        setCurrentUser(res.user.username);
        setIsLoggedIn(true);
        setLoginInput('');
        setLoginPassword('');
        showToast(`欢迎回来，${res.user.username}！`);
      }
    } catch (e: any) {
      // 后端用 HTTP 4xx 表示密码错/账号异常；fetch 包装里 throw 出 message
      const msg = e?.message || '登录失败，请检查后端';
      setLoginError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    if (confirm('确定要切换账号吗？这不会清除您存在后端的配置。')) {
      localStorage.setItem('fund_user_name', 'guest');
      setCurrentUser('guest');
      setIsLoggedIn(false);
      setWatchlist([]);
      setFundsData({});
      setPositions({});
    }
  };

  /* ---------- Watchlist CRUD ---------- */

  /**
   * 名称搜索下拉的输入变化：200ms 防抖后请求后端搜索（全面支持中英文、Ticker与代码）
   * IME 拼音输入进行中不发请求，等 compositionEnd 后再发
   */
  const handleAddInputChange = (value: string) => {
    setNewCode(value);
    setSearchError('');

    // 取消上一个待发请求
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }

    if (value.trim().length < 1) {
      setSearchResults([]);
      setDropdownOpen(false);
      return;
    }

    // IME 输入中先不搜（compositionend 才会真正选定汉字）
    if (composingRef.current) return;

    searchTimerRef.current = window.setTimeout(async () => {
      // 再检查一次：debounce 期间用户可能又开始拼音输入了
      if (composingRef.current) return;
      setSearchBusy(true);
      try {
        const results = await searchByName(value.trim(), selfTab);
        // 请求返回时用户可能已经清空/切换，要核对一次当前输入
        if (!composingRef.current && value.trim().length > 0) {
          setSearchResults(results);
          setHighlightIdx(0);
          setDropdownOpen(results.length > 0);
        }
      } catch {
        setSearchResults([]);
        setDropdownOpen(false);
      } finally {
        setSearchBusy(false);
      }
    }, 200);
  };

  /**
   * 直接通过名称搜索结果添加：跳过 regex 校验、走带 kind 的拉取
   */
  const addFromSearchResult = async (result: SearchResult) => {
    setSearchLoading(true);
    setSearchError('');
    setDropdownOpen(false);
    try {
      const res = await addWatchlistItem({ code: result.code, kind: result.kind, market: result.market });
      if (!res.success && res.prompt?.type === 'listed_etf_wrong_tab') {
        setListedEtfPrompt({ code: result.code, message: res.message });
        return;
      }
      const finalKind = res.kind;
      const fund = res.quote || await fetchFundValuation(result.code, finalKind);
      if (!fund) throw new Error('未找到该代码，请确认是否正确');
      setWatchlist(prev => prev.includes(result.code) ? prev : [...prev, result.code]);
      setWatchlistItems(prev => {
        const item = { fund_code: result.code, kind: finalKind, market: res.market, sector: res.sector, created_at: new Date().toISOString() } as WatchlistItem;
        const existing = prev.findIndex(x => x.fund_code === result.code);
        return existing >= 0 ? prev.map((x, i) => i === existing ? { ...x, ...item } : x) : [...prev, item];
      });
      setFundsData(prev => ({ ...prev, [result.code]: fund }));
      setNewCode('');
      setSearchResults([]);
      showToast(res.message || `已订阅${finalKind === 'stock' ? '股票' : '基金'}: ${fund.name}`);
    } catch (err: any) {
      setSearchError(err.message || '获取数据失败，请确认代码');
    } finally {
      setSearchLoading(false);
    }
  };

  /**
   * 添加框键盘：↑/↓ 移动、Enter 选中、Esc 关闭
   */
  const handleAddInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!dropdownOpen || searchResults.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = searchResults[highlightIdx];
      if (picked) addFromSearchResult(picked);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDropdownOpen(false);
    }
  };

  /**
   * 切换 selfTab 时清空搜索状态
   */
  useEffect(() => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    setSearchResults([]);
    setDropdownOpen(false);
    const preservedCode = preserveCodeOnTabSwitchRef.current;
    preserveCodeOnTabSwitchRef.current = null;
    setNewCode(preservedCode || '');
    setSearchError('');
  }, [selfTab]);

  /**
   * 点击外部关闭下拉
   */
  useEffect(() => {
    if (!dropdownOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!addBoxRef.current) return;
      if (!addBoxRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [dropdownOpen]);

  const handleAddFund = async (e: React.FormEvent) => {
    e.preventDefault();
    // 如果下拉开着且有高亮项，回车直接选中
    if (dropdownOpen && searchResults[highlightIdx]) {
      addFromSearchResult(searchResults[highlightIdx]);
      return;
    }
    const inputVal = newCode.trim();
    if (!inputVal) return;

    const kind: 'fund' | 'stock' = selfTab === 'stock' ? 'stock' : 'fund';
    setSearchLoading(true);
    setSearchError('');

    // 1. 若输入为标准代码形态（A股6位/港股4-5位/美股1-6位Ticker），尝试直接添加
    const isStandardCode = /^(\d{4,6}|[A-Za-z]{1,6}(\.[A-Za-z]{1,2})?)$/.test(inputVal);
    if (isStandardCode) {
      try {
        const directCode = inputVal.toUpperCase();
        const res = await addWatchlistItem({ code: directCode, kind });
        if (!res.success && res.prompt?.type === 'listed_etf_wrong_tab') {
          setListedEtfPrompt({ code: directCode, message: res.message });
          setSearchLoading(false);
          return;
        }
        const finalKind = res.kind;
        const fund = res.quote || await fetchFundValuation(directCode, finalKind);
        if (fund) {
          setWatchlist(prev => prev.includes(directCode) ? prev : [...prev, directCode]);
          setWatchlistItems(prev => {
            const item = { fund_code: directCode, kind: finalKind, market: res.market, sector: res.sector, created_at: new Date().toISOString() } as WatchlistItem;
            const existing = prev.findIndex(x => x.fund_code === directCode);
            return existing >= 0 ? prev.map((x, i) => i === existing ? { ...x, ...item } : x) : [...prev, item];
          });
          setFundsData(prev => ({ ...prev, [directCode]: fund }));
          setNewCode('');
          setSearchResults([]);
          setDropdownOpen(false);
          showToast(res.message || `已订阅${finalKind === 'stock' ? '股票' : '基金'}: ${fund.name}`);
          setSearchLoading(false);
          return;
        }
      } catch {
        // 直接代码失败，自动回退到名称/英文联想搜索
      }
    }

    // 2. 智能中英文/名称联想搜索并自动采纳第一条结果
    try {
      const results = await searchByName(inputVal, selfTab);
      if (results && results.length > 0) {
        await addFromSearchResult(results[0]);
        return;
      }
      setSearchError('未找到相关标的，请输入正确的代码或中英文名称 (如 NVDA / TSLA / 00700 / 腾讯)');
    } catch (err: any) {
      setSearchError(err.message || '获取数据失败，请确认代码或名称');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleRemoveFund = useCallback((code: string, name: string) => {
    setDeletingItem({ code, name });
  }, []);

  const executeRemove = async (code: string, name: string) => {
    setDeletingItem(null);
    setSelectedFundCode(curr => (curr === code ? null : curr));

    const prevList = watchlist;
    const prevItems = watchlistItems;
    const prevPos = positions;

    setWatchlist(prev => prev.filter(c => c !== code));
    setWatchlistItems(prev => prev.filter(i => i.fund_code !== code));
    setPositions(prev => {
      const next = { ...prev };
      delete next[code];
      return next;
    });

    try {
      await removeFromWatchlist(code);
      showToast(`已删除订阅: ${name || code}`);
    } catch (e) {
      setWatchlist(prevList);
      setWatchlistItems(prevItems);
      setPositions(prevPos);
      showToast('删除订阅失败，请检查网络');
    }
  };

  /* ---------- Position edit ---------- */
  const openEditPosition = useCallback((code: string) => {
    setEditingCode(code);
    // 用 ref 读取最新持仓/行情，避免把 fundsData 放进依赖导致 SSE 每次 tick 都重建本回调、击穿行级 memo。
    const pos = positionsRef.current[code];
    const fund = fundsDataRef.current[code];
    const curPrice = fund ? (parseFloat(fund.gsz) || parseFloat(fund.dwjz) || 0) : 0;

    const s = pos && pos.shares > 0 ? pos.shares : 0;
    const c = pos && pos.cost > 0 ? pos.cost : 0;

    setEditShares(s > 0 ? s.toString() : '');
    setEditCost(c > 0 ? c.toString() : (curPrice > 0 ? curPrice.toFixed(4) : ''));
    setEditAmount(s > 0 && c > 0 ? (s * c).toFixed(2) : '');
    setEditMode('shares');

    // 默认行为：如果已有持仓，默认进入【补仓】模式；如果无持仓，默认进入【建仓/重置】模式
    if (s > 0) {
      setPosActionTab('buy');
      setBuyShares('');
      setBuyCost(curPrice > 0 ? curPrice.toFixed(4) : (c > 0 ? c.toFixed(4) : ''));
      setSellShares('');
    } else {
      setPosActionTab('set');
      setBuyShares('');
      setBuyCost(curPrice > 0 ? curPrice.toFixed(4) : '');
      setSellShares('');
    }
  }, []);

  const handleActionSavePosition = async () => {
    if (!editingCode) return;
    const currentPos = positions[editingCode] || { shares: 0, cost: 0, fund_code: editingCode };

    let finalShares = currentPos.shares;
    let finalCost = currentPos.cost;

    if (posActionTab === 'buy') {
      const sBuy = parseFloat(buyShares);
      const cBuy = parseFloat(buyCost);
      if (isNaN(sBuy) || sBuy <= 0 || isNaN(cBuy) || cBuy <= 0) {
        showToast('请输入有效的补仓买入份数与单价（均需 > 0）');
        return;
      }
      const totalOldCost = currentPos.shares * currentPos.cost;
      const totalBuyCost = sBuy * cBuy;
      finalShares = currentPos.shares + sBuy;
      finalCost = (totalOldCost + totalBuyCost) / finalShares;
    } else if (posActionTab === 'sell') {
      const sSell = parseFloat(sellShares);
      if (isNaN(sSell) || sSell <= 0) {
        showToast('请输入有效的卖出份数（必须 > 0）');
        return;
      }
      if (sSell > currentPos.shares + 0.0001) {
        showToast(`卖出份数超出持有总额 (${currentPos.shares.toFixed(2)} 份)`);
        return;
      }
      finalShares = currentPos.shares - sSell;
      if (finalShares <= 0.0001) {
        // 全部卖出 → 清空持仓
        await removePosition(editingCode);
        setPositions(prev => {
          const next = { ...prev };
          delete next[editingCode];
          return next;
        });
        showToast('已全仓卖出清空');
        setEditingCode(null);
        return;
      }
      // 减仓时持仓单价不变
      finalCost = currentPos.cost;
    } else {
      // 重置/直接指定持仓
      const sSet = parseFloat(editShares);
      const cSet = parseFloat(editCost);
      if (isNaN(sSet) || sSet <= 0 || isNaN(cSet) || cSet <= 0) {
        showToast('请输入有效的总份数与单价（均需 > 0）');
        return;
      }
      finalShares = sSet;
      finalCost = cSet;
    }

    try {
      await savePosition(editingCode, finalShares, finalCost);
      setPositions(prev => ({
        ...prev,
        [editingCode]: { fund_code: editingCode, shares: finalShares, cost: finalCost, updated_at: new Date().toISOString() }
      }));
      const actionDesc = posActionTab === 'buy' ? '补仓成功' : posActionTab === 'sell' ? '减仓成功' : '持仓更新';
      showToast(`${actionDesc}：持仓变为 ${finalShares.toFixed(2)} 份 @ 均价 ¥${finalCost.toFixed(4)}`);
    } catch (e: any) {
      showToast('保存持仓失败：' + (e?.message || '请检查后端'));
    }
    setEditingCode(null);
  };

  /** 显式清空持仓（用户主动点击"清空持仓"按钮，立刻清空并关闭弹窗） */
  const handleClearPosition = async () => {
    if (!editingCode) return;
    const code = editingCode;
    // 1. 立即关闭弹窗
    setEditingCode(null);

    // 2. 乐观更新：先清空前端持仓状态，使 UI 即刻生效
    const prevPos = positions;
    setPositions(prev => {
      const next = { ...prev };
      delete next[code];
      return next;
    });

    // 3. 后台异步发送清除请求
    try {
      await removePosition(code);
      showToast('持仓记录已清空');
    } catch (e: any) {
      setPositions(prevPos);
      showToast('清空失败：' + (e?.message || '请检查后端'));
    }
  };

  /* ---------- Theme toggles ---------- */
  const toggleDarkMode = () => {
    const nextDark = !isDarkMode;
    setIsDarkMode(nextDark);
    localStorage.setItem('fund_theme_dark', String(nextDark));
    document.documentElement.classList.toggle('dark', nextDark);
  };

  const toggleColorRule = () => {
    const nextIntl = !isIntlColor;
    setIsIntlColor(nextIntl);
    localStorage.setItem('fund_intl_color', String(nextIntl));
    document.documentElement.classList.toggle('intl-color', nextIntl);
    showToast(nextIntl ? '已切换至"绿涨红跌"（国际配色）' : '已切换至"红涨绿跌"（国内习惯）');
  };

  /* ---------- Portfolio aggregates ---------- */
  const stats = useMemo(() => {
    let totalValue = 0;
    let totalCost = 0;
    let todayProfit = 0;
    Object.entries(positions).forEach(([code, pos]) => {
      const fund = fundsData[code];
      if (fund) {
        const currentPrice = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
        const prevPrice = parseFloat(fund.dwjz);
        if (currentPrice > 0) {
          totalValue += pos.shares * currentPrice;
          totalCost += pos.shares * pos.cost;
          // 计算今日盈亏基准价：若为当日修改且买入价低于开盘/昨收价，则取开盘/昨收价
          const updatedToday = isUpdatedToday(pos.updated_at);
          const basePrice = getTodayBasePrice(pos.cost, prevPrice, currentPrice, updatedToday);
          if (basePrice > 0) {
            todayProfit += pos.shares * (currentPrice - basePrice);
          }
        }
      }
    });
    const totalProfit = totalValue - totalCost;
    const totalProfitRate = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
    return { totalValue, totalCost, todayProfit, totalProfit, totalProfitRate };
  }, [positions, fundsData]);

  /* ───────────────────────────────────────────────────────────────────
     Render: Login screen — Apple Materialize entry
     ─────────────────────────────────────────────────────────────────── */

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#f5f5f7] dark:bg-black flex flex-col items-center justify-center p-6 gap-4">
        <Spin size="large" tip="系统初始化数据中..." />
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="relative min-h-screen bg-[#f5f5f7] dark:bg-black flex items-center justify-center p-4 overflow-hidden">

        {/* Animated background orbs — subtle drift, alive but not distracting */}
        <motion.div
          className="absolute top-20 left-10 w-72 h-72 rounded-full filter blur-3xl pointer-events-none"
          style={{
            background: isDarkMode ? 'rgba(41, 151, 255, 0.08)' : 'rgba(0, 102, 204, 0.06)'
          }}
          animate={prefersReducedMotion ? undefined : {
            x: [0, 30, 0],
            y: [0, -20, 0],
          }}
          transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute bottom-20 right-10 w-80 h-80 rounded-full filter blur-3xl pointer-events-none"
          style={{
            background: isDarkMode ? 'rgba(48, 209, 88, 0.08)' : 'rgba(48, 209, 88, 0.05)'
          }}
          animate={prefersReducedMotion ? undefined : {
            x: [0, -25, 0],
            y: [0, 15, 0],
          }}
          transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
        />

        {/* Card — materializes: scale + blur + opacity together */}
        <motion.div
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, filter: 'blur(8px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          transition={SPRING.sheet}
          className="bg-white dark:bg-[#1d1d1f] rounded-[28px] border border-[var(--hairline-border)] shadow-xl max-w-sm w-full p-8 relative overflow-hidden"
        >
          {/* Top highlight — light catching the material (§12) */}
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent dark:via-white/10" />

          <div className="text-center mb-8">
            <motion.div
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ ...SPRING.snap, delay: 0.1 }}
              className="w-14 h-14 bg-[#0066cc]/10 text-[#0066cc] dark:text-[#2997ff] rounded-2xl flex items-center justify-center mx-auto mb-4 border border-[var(--hairline-border)] shadow-sm"
            >
              <PieChart size={28} strokeWidth={1.75} />
            </motion.div>

            <h1 className="apple-display-heading text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50 mb-1.5">
              全球基金数据监控看板
            </h1>
            <p className="text-xs text-[#86868b] leading-relaxed">
              数据多端同步 · 独立订阅隔离 · 免密一键登录
            </p>
          </div>

          <form onSubmit={handleLoginSubmit} className="space-y-5">
            <div>
              <label className="apple-eyebrow block mb-2">
                自定义用户名 / 理财昵称
              </label>
              <input
                type="text"
                required
                placeholder="例如: 张三 或 user123"
                value={loginInput}
                onChange={(e) => { setLoginInput(e.target.value); setLoginError(''); }}
                autoComplete="username"
                className="apple-input w-full px-4 py-3 text-sm placeholder-slate-400 dark:placeholder-slate-500 font-medium"
              />
            </div>

            <div>
              <label className="apple-eyebrow block mb-2">
                密码
              </label>
              <input
                type="password"
                required
                placeholder="新用户首次登录即注册"
                value={loginPassword}
                onChange={(e) => { setLoginPassword(e.target.value); setLoginError(''); }}
                autoComplete="current-password"
                className="apple-input w-full px-4 py-3 text-sm placeholder-slate-400 dark:placeholder-slate-500 font-medium"
              />
            </div>

            <AnimatePresence>
              {loginError && (
                <motion.div
                  initial={{ opacity: 0, y: -4, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: 'auto' }}
                  exit={{ opacity: 0, y: -4, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="px-3 py-2 text-[11px] text-[#ff453a] bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/40 rounded-xl font-medium">
                    ⚠️ {loginError}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <PressableButton
              type="submit"
              disabled={loading}
              className="w-full py-3 apple-btn-primary text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : null}
              {loginInput && loginPassword && watchlist.length === 0 ? '注册并进入' : '进入看板'}
              <ChevronRight size={16} strokeWidth={2.5} />
            </PressableButton>
          </form>

          <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-800/80 text-center">
            <div className="flex items-center justify-center gap-4 text-[10px] text-[#86868b]">
              <span className="flex items-center gap-1 font-medium">
                <FolderLock size={12} /> SQLite 本地数据库隔离
              </span>
              <span>•</span>
              <span className="flex items-center gap-1 font-medium">
                <Target size={12} /> 无打扰摸鱼终端
              </span>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  /* ───────────────────────────────────────────────────────────────────
     Render: Main dashboard
     ─────────────────────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-[#f5f5f7] dark:bg-black text-slate-900 dark:text-slate-100 flex flex-col font-sans transition-colors duration-200">

      {/* Toast — spring slide-in top-center (z-50 高于 Modal 与 Navbar，阴影与深度对比增强) */}
      <AnimatePresence>
        {toastMsg && (
          <motion.div
            key={toastMsg}
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -20, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -16, scale: 0.94 }}
            transition={SPRING.toast}
            className="fixed top-5 left-1/2 -translate-x-1/2 z-[100] bg-slate-900/95 text-white dark:bg-white/95 dark:text-slate-900 backdrop-blur-2xl px-4 py-2.5 rounded-full shadow-[0_12px_40px_rgba(0,0,0,0.25)] ring-1 ring-white/10 dark:ring-black/10 text-xs font-medium flex items-center gap-2.5 pointer-events-none"
          >
            <span className="flex items-center justify-center w-4 h-4 rounded-full bg-blue-500 text-white shrink-0">
              <Info size={10} strokeWidth={3} />
            </span>
            <span>{toastMsg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top navigation — Frosted Glass material */}
      <nav className="apple-navbar sticky top-0 z-40 px-3 py-2.5 md:px-6 md:py-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 md:gap-6 shrink-0">
          <h1 className="text-base md:text-lg font-semibold tracking-tight apple-display-heading flex items-center gap-1.5 whitespace-nowrap shrink-0">
            <span aria-hidden className="text-lg">📊</span>
            <span className="hidden md:inline">全球基金监控终端</span>
          </h1>

          {/* 主 tab: 自选 (portfolio) / 金价 (gold) / 优质选股 (ai-stock-pick) */}
          <div className="relative inline-flex bg-slate-100/60 dark:bg-white/5 rounded-full p-0.5 shrink-0">
            {([
              { key: 'portfolio',     label: '自选', icon: '📋' },
              { key: 'gold',          label: '金价', icon: '💰' },
              { key: 'ai-stock-pick', label: '优质选股', icon: '✨' },
            ] as const).map(t => {
              const active = mainTab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => {
                    setMainTab(t.key);
                    try { localStorage.setItem('fund_main_tab', t.key); } catch {}
                  }}
                  className={`relative px-2.5 md:px-3.5 py-1 md:py-1.5 text-xs font-semibold rounded-full transition-colors flex items-center gap-1 whitespace-nowrap ${
                    active ? 'text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="main-tab-pill"
                      transition={{ type: 'spring' as const, bounce: 0.05, duration: 0.36 }}
                      className="absolute inset-0 rounded-full"
                      style={{ background: 'var(--primary-accent)' }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1">
                    <span aria-hidden>{t.icon}</span>
                    {t.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1 md:gap-3 shrink-0">
          {/* User pill */}
          <motion.div
            whileHover={prefersReducedMotion ? undefined : { scale: 1.02 }}
            transition={SPRING.default}
            className="flex items-center gap-1 md:gap-2 bg-[#f5f5f7] dark:bg-black/40 px-2 md:px-3 py-1 md:py-1.5 rounded-full border border-[var(--hairline-border)] shrink-0"
          >
            <div className="w-5 h-5 md:w-6 md:h-6 rounded-full bg-[#0066cc] dark:bg-[#2997ff] text-white flex items-center justify-center font-bold text-[9px] md:text-[10px] shrink-0">
              {currentUser.substring(0, 2).toUpperCase()}
            </div>
            <span className="hidden md:inline text-xs font-semibold text-slate-700 dark:text-slate-300 max-w-[100px] truncate">
              {currentUser}
            </span>
            <PressableIconButton
              onClick={handleLogout}
              aria-label="切换/登出用户"
              className="p-0.5 md:p-1 rounded-full text-slate-400 hover:text-red-500 ml-0.5 shrink-0"
            >
              <LogOut size={12} />
            </PressableIconButton>
          </motion.div>

          <span className="hidden md:inline h-4 w-px bg-[var(--divider)] shrink-0" />

          {/* 桌面端常驻设置按钮 */}
          <div className="hidden md:flex items-center gap-1.5">
            <Tooltip title={unreadAlertCount > 0 ? `预警订阅与推送日志 (${unreadAlertCount} 条未读)` : '预警订阅与推送日志'} placement="bottom">
              <PressableIconButton
                onClick={handleOpenNotificationLogs}
                aria-label="预警订阅与推送日志"
                className="p-2 rounded-full hover:bg-slate-200/50 dark:hover:bg-slate-800/50 text-slate-400 hover:text-blue-500 dark:hover:text-blue-400"
              >
                <Badge count={unreadAlertCount} size="small" offset={[2, -2]} overflowCount={99}>
                  <Bell size={15} />
                </Badge>
              </PressableIconButton>
            </Tooltip>
            <EmailConfigPanel
              isAdmin={currentUser.toLowerCase() === 'admin'}
              currentUser={currentUser}
              onToast={showToast}
            />
            <Tooltip title={isDarkMode ? '切换到亮色模式' : '切换到暗黑模式'} placement="bottom">
              <PressableIconButton
                onClick={toggleDarkMode}
                aria-label={isDarkMode ? '切换到亮色模式' : '切换到暗黑模式'}
                className="p-2 rounded-full hover:bg-slate-200/50 dark:hover:bg-slate-800/50 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                {isDarkMode ? <Sun size={15} /> : <Moon size={15} />}
              </PressableIconButton>
            </Tooltip>
            <Tooltip title="切换红绿涨跌色彩规则 (中国/国际标准)" placement="bottom">
              <PressableButton
                onClick={toggleColorRule}
                className="text-[10px] font-bold bg-[#f5f5f7] dark:bg-[#1d1d1f] hover:bg-slate-200/50 dark:hover:bg-slate-800/50 border border-[var(--hairline-border)] px-2.5 py-1.5 ml-0.5"
              >
                {isIntlColor ? '🟢涨🔴跌' : '🔴涨🟢跌'}
              </PressableButton>
            </Tooltip>
          </div>

          {/* 移动端设置菜单入口图标 */}
          <div className="flex md:hidden items-center">
            <PressableIconButton
              onClick={() => setIsMobileMenuOpen(true)}
              aria-label="打开应用设置菜单"
              className="p-2 rounded-full bg-slate-100/80 dark:bg-white/5 border border-[var(--hairline-border)] text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/10"
            >
              <Settings size={15} />
            </PressableIconButton>
          </div>
        </div>
      </nav>

      {/* Market ticker strip */}
      <div className="apple-toolbar px-3.5 py-2.5 md:px-6 md:py-3 overflow-x-auto scrollbar-none flex items-center gap-3 md:gap-6 text-[11px] whitespace-nowrap">
        <span className="apple-eyebrow flex items-center gap-1.5 whitespace-nowrap">
          <Sparkles size={13} className="text-amber-500" /> 全球大盘
        </span>
        {marketIndices.length === 0 ? (
          <div className="flex gap-4 animate-pulse">
            {[...Array(6)].map((_, i) => (
              <span key={i} className="bg-slate-100 dark:bg-slate-800 h-4 w-20 rounded" />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-5">
            {marketIndices.map(index => {
              const isUp = index.change > 0;
              const isDown = index.change < 0;
              const color = isUp
                ? 'text-[var(--color-up)]'
                : isDown ? 'text-[var(--color-down)]' : 'text-slate-500';
              return (
                <div
                  key={index.code}
                  className="flex items-center gap-1.5 bg-white/60 dark:bg-black/60 px-3 py-1 rounded-full border border-[var(--hairline-border)] transition-colors duration-200"
                >
                  <span className="font-semibold text-slate-700 dark:text-slate-300">{index.name}</span>
                  <span className="font-mono font-bold text-slate-800 dark:text-slate-100 tabular-nums">
                    {index.price.toFixed(2)}
                  </span>
                  <span className={`font-mono font-semibold flex items-center text-[10px] tabular-nums ${color}`}>
                    {isUp ? '▲' : isDown ? '▼' : ''}
                    {Math.abs(index.changePercent).toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Main grid — 页面分支渲染 */}
      {mainTab === 'gold' ? (
        <div className="flex-1 max-w-7xl w-full mx-auto p-3.5 md:p-6">
          <React.Suspense fallback={
            <div className="flex flex-col items-center justify-center p-16 min-h-[360px] gap-3">
              <Spin size="large" tip="正在加载黄金行情分析看板..." />
            </div>
          }>
            <GoldTab />
          </React.Suspense>
        </div>
      ) : mainTab === 'ai-stock-pick' ? (
        <div className="flex-1 max-w-7xl w-full mx-auto p-3.5 md:p-6">
          <React.Suspense fallback={
            <div className="flex flex-col items-center justify-center p-16 min-h-[360px] gap-3">
              <Spin size="large" tip="正在加载优质股票智能筛选中心..." />
            </div>
          }>
            <AiStockPickTab onOpenDetail={handleAiOpenDetail} />
          </React.Suspense>
        </div>
      ) : (
      <div className="flex-1 max-w-7xl w-full mx-auto p-3.5 md:p-6 grid grid-cols-1 lg:grid-cols-4 gap-4 md:gap-6">

        {/* Left column: portfolio summary + settings */}
        <div className="lg:col-span-1 flex flex-col gap-4 md:gap-6">

          {/* Portfolio summary card — dark glass, spring hover */}
          <motion.section
            whileHover={prefersReducedMotion ? undefined : { y: -3 }}
            transition={SPRING.default}
            className="bg-black text-white rounded-[20px] p-5 md:p-6 shadow-md border border-slate-900 relative overflow-hidden"
          >
            <div className="absolute right-0 top-0 w-32 h-32 bg-blue-500/20 rounded-full filter blur-3xl pointer-events-none" />

            <div className="flex flex-col md:block">
              <h2 className="apple-eyebrow text-slate-400 mb-2.5 flex items-center gap-1.5">
                <DollarSign size={14} className="text-[#2997ff]" /> 资产预估总额
              </h2>

              <div className="mb-4 md:mb-6">
                <div className="apple-display-large font-mono text-white tabular-nums text-2xl sm:text-3xl md:text-2xl lg:text-3xl font-bold">
                  ¥{' '}
                  <AnimatedNumber
                    value={stats.totalValue}
                    decimals={2}
                    className="inline"
                  />
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  持仓总成本: <span className="font-mono text-slate-300">¥{stats.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>

            {/* 盈亏指标：移动端双列卡片，侧边栏上下自适应 */}
            <div className="grid grid-cols-2 md:grid-cols-1 gap-2.5 pt-3.5 border-t border-slate-800/80">
              <div className="bg-white/5 md:bg-transparent p-2.5 md:p-0 rounded-xl md:rounded-none flex flex-col md:flex-row md:justify-between md:items-center gap-1">
                <span className="text-[10px] md:text-xs text-slate-400">今日预估盈亏</span>
                <span className={`text-xs sm:text-sm font-bold font-mono tabular-nums ${
                  stats.todayProfit > 0 ? 'text-[#ff453a]'
                    : stats.todayProfit < 0 ? 'text-[#30d158]' : 'text-slate-300'
                }`}>
                  {stats.todayProfit > 0 ? '+' : ''}{stats.todayProfit.toFixed(2)}
                </span>
              </div>

              <div className="bg-white/5 md:bg-transparent p-2.5 md:p-0 rounded-xl md:rounded-none flex flex-col md:flex-row md:justify-between md:items-center gap-1">
                <span className="text-[10px] md:text-xs text-slate-400">累计预估盈亏</span>
                <span className={`text-xs sm:text-sm font-bold font-mono tabular-nums ${
                  stats.totalProfit > 0 ? 'text-[#ff453a]'
                    : stats.totalProfit < 0 ? 'text-[#30d158]' : 'text-slate-300'
                }`}>
                  {stats.totalProfit > 0 ? '+' : ''}{stats.totalProfit.toFixed(2)}
                  <span className="text-[9px] md:text-[10px] font-semibold ml-1 block sm:inline">
                    ({stats.totalProfitRate > 0 ? '+' : ''}{stats.totalProfitRate.toFixed(2)}%)
                  </span>
                </span>
              </div>
            </div>
          </motion.section>

          {/* Settings card */}
          <motion.section
            whileHover={prefersReducedMotion ? undefined : { y: -2 }}
            transition={SPRING.default}
            className="apple-card p-5"
          >
            <h3 className="apple-eyebrow mb-3 flex items-center gap-1.5">
              <Sliders size={14} className="text-[#0066cc]" /> 数据更新机制
            </h3>
            <div className="text-[11px] text-[#86868b] leading-relaxed space-y-2">
              <p>后端独立隔离多用户自选与持仓列表。</p>
              <p>行情刷新频率：股票约 10 秒 / 次，基金估值约 1 分钟 / 次。</p>
            </div>
          </motion.section>
        </div>

        {/* Right column: watchlist */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          <section className="apple-card overflow-hidden flex flex-col">

            {/* Header / tabs / add watchlist */}
            <div className="px-5 pt-4 pb-3 border-b border-[var(--hairline-border)] bg-slate-50/30 dark:bg-[#1d1d1f]/40">
              <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
                <h2 className="apple-display-heading text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <span aria-hidden>📋</span>
                  <span>自选</span>
                  <span className="px-2 py-0.5 bg-[#0066cc]/10 text-[#0066cc] dark:bg-[#2997ff]/20 dark:text-[#2997ff] rounded-full text-[9px] font-bold tracking-wider">
                    {watchlistItems.filter(w => w.kind === 'fund').length} 基金 · {watchlistItems.filter(w => w.kind === 'stock').length} 股
                  </span>
                </h2>
              </div>
              {/* Tab 切换 */}
              <div className="flex items-center gap-1 mb-3 p-0.5 bg-slate-100/60 dark:bg-white/5 rounded-full w-fit">
                {([
                  { key: 'fund',   label: '基金' },
                  { key: 'stock',  label: '股票' },
                ] as const).map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => {
                      setSelfTab(tab.key);
                      try { localStorage.setItem('fund_self_tab', tab.key); } catch {}
                    }}
                    className={`relative px-4 py-1.5 text-xs font-semibold rounded-full transition-colors ${
                      selfTab === tab.key
                        ? 'bg-white dark:bg-[#2c2c2e] text-slate-900 dark:text-slate-50 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <form onSubmit={handleAddFund} className="flex items-center gap-2 w-full">
                <div ref={addBoxRef} className="relative flex-1 min-w-0">
                  <input
                    type="text"
                    maxLength={20}
                    placeholder={selfTab === 'stock' ? '代码或名称，支持中英文 (如 NVDA / TSLA / 00700 / 腾讯 / 苹果)' : '代码或名称，支持中英文 (如 161039 / 易方达 / 标普500)'}
                    value={newCode}
                    onChange={(e) => handleAddInputChange(e.target.value)}
                    onCompositionStart={() => { composingRef.current = true; }}
                    onCompositionEnd={(e) => {
                      composingRef.current = false;
                      // 拼音组合结束，触发搜索（用 IME 提交后的最终值）
                      handleAddInputChange((e.target as HTMLInputElement).value);
                    }}
                    onKeyDown={handleAddInputKeyDown}
                    onFocus={() => { if (searchResults.length > 0) setDropdownOpen(true); }}
                    autoComplete="off"
                    spellCheck={false}
                    className="apple-input pl-9 pr-3 py-2 text-xs w-full font-medium placeholder-slate-400"
                  />
                  <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  {searchBusy && (
                    <Loader2 size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 animate-spin" />
                  )}
                  <AnimatePresence>
                    {dropdownOpen && searchResults.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: -4, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.98 }}
                        transition={SPRING.snap}
                        className="absolute top-full left-0 right-0 mt-1 z-50 apple-card overflow-hidden shadow-lg max-h-72 overflow-y-auto"
                      >
                        {searchResults.map((r, i) => (
                          <button
                            key={`${r.market}:${r.code}`}
                            type="button"
                            onMouseEnter={() => setHighlightIdx(i)}
                            onClick={() => addFromSearchResult(r)}
                            className={`w-full px-3 py-2 text-xs flex items-center gap-3 text-left transition-colors ${
                              i === highlightIdx
                                ? 'bg-[#0066cc]/10 dark:bg-[#2997ff]/15 text-slate-900 dark:text-slate-50'
                                : 'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5'
                            }`}
                          >
                            <span className="flex-1 truncate font-medium">{r.name}</span>
                            <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">{r.code}</span>
                            <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-white/10 text-slate-500 dark:text-slate-400 shrink-0">
                              {r.market === 'domestic' ? 'A股' : r.market === 'hk' ? '港股' : r.market === 'us' ? '美股' : '其他'}
                            </span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <PressableButton
                  type="submit"
                  disabled={searchLoading}
                  className="px-3.5 py-2 apple-btn-primary text-xs font-semibold flex items-center gap-1 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Plus size={14} strokeWidth={2.5} />
                  订阅
                </PressableButton>
              </form>
            </div>

            <AnimatePresence initial={false}>
              {searchError && (
                <motion.div
                  key={searchError}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={SPRING.default}
                  className="overflow-hidden"
                >
                  <div className="px-5 py-2.5 bg-red-50 dark:bg-red-950/20 text-[#ff453a] text-xs border-b border-[var(--hairline-border)] font-medium">
                    ⚠️ {searchError}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Watchlist content — Mobile Card View (md:hidden) & Desktop Table (hidden md:block) */}
            {(() => {
              if (visibleList.length === 0) {
                return (
                  <div className="p-8 text-center text-slate-400 text-xs font-medium">
                    当前列表无记录。请在上方搜索框输入代码添加。
                  </div>
                );
              }

              return (
                <>
                  {!isDesktopWatchlist && (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                    {pagedVisibleList.map(({ code, key }) => {
                        const fund = fundsData[code];
                        const pos = positions[code];
                        if (!fund) {
                          return <SkeletonCard key={key} code={code} />;
                        }
                        const isDropTarget = !!pressDrag.activeCode && pressDrag.activeCode !== code && pressDrag.targetIdx === visibleList.findIndex(item => item.key === key);
                        return (
                          <WatchlistCard
                            key={key}
                            code={code}
                            fund={fund}
                            pos={pos}
                            selfTab={selfTab}
                            pressDrag={pressDrag}
                            isDropTarget={isDropTarget}
                            prefersReducedMotion={prefersReducedMotion}
                            onRowPointerDown={onRowPointerDown}
                            suppressClickAfterDrag={suppressClickAfterDrag}
                            onSelect={setSelectedFundCode}
                            onRemove={handleRemoveFund}
                            onEditPosition={openEditPosition}
                            dragJustEndedRef={dragJustEndedRef}
                          />
                        );
                      })}
                    </div>
                  )}

                  {isDesktopWatchlist && (
                    <div className="overflow-x-auto flex-1 scrollbar-none">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50/40 dark:bg-[#1d1d1f]/40 text-slate-400 dark:text-slate-500 border-b border-[var(--hairline-border)] font-semibold whitespace-nowrap">
                          <th className="py-3 pl-4 pr-2">{selfTab === 'stock' ? '股票名称与代码' : '基金名称与代码'}</th>
                          {selfTab === 'stock' ? (
                            <>
                              <th className="py-3 px-2 text-right">昨收</th>
                              <th className="py-3 px-2 text-right">现价</th>
                              <th className="py-3 px-2 text-right">涨跌幅</th>
                              <th className="py-3 px-2 text-center w-[96px]">分时走势</th>
                            </>
                          ) : (
                            <>
                              <th className="py-3 px-2 text-right">昨日单位净值</th>
                              <th className="py-3 px-2 text-right">估算净值</th>
                              <th className="py-3 px-2 text-right">估算涨跌</th>
                              <th className="py-3 px-2 text-center w-[96px]">分时走势</th>
                            </>
                          )}
                          <th className="py-3 px-2 text-right">我的持仓预估</th>
                          <th className="py-3 px-2 text-right">{selfTab === 'stock' ? '今日盈亏' : '今日估算盈亏'}</th>
                          <th className="py-3 pr-4 pl-2 text-center w-[110px]">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                        {pagedVisibleList.map(({ code, key }) => {
                            const fund = fundsData[code];
                            const pos = positions[code];

                            if (!fund) {
                              return <SkeletonTableRow key={key} code={code} />;
                            }

                            const isDropTarget = !!pressDrag.activeCode && pressDrag.activeCode !== code && pressDrag.targetIdx === visibleList.findIndex(item => item.key === key);
                            return (
                              <WatchlistRow
                                key={key}
                                code={code}
                                fund={fund}
                                pos={pos}
                                selfTab={selfTab}
                                pressDrag={pressDrag}
                                isDropTarget={isDropTarget}
                                dragOverCode={dragOverCode}
                                onRowPointerDown={onRowPointerDown}
                                suppressClickAfterDrag={suppressClickAfterDrag}
                                onSelect={setSelectedFundCode}
                                onRemove={handleRemoveFund}
                                onEditPosition={openEditPosition}
                                handleDragStart={handleDragStart}
                                handleDragOver={handleDragOver}
                                handleDrop={handleDrop}
                                onDragEnd={handleDragEnd}
                              />
                            );
                          })}
                      </tbody>
                    </table>
                    </div>
                  )}

                  {visibleList.length > 10 && (
                    <div className="flex items-center justify-center border-t border-[var(--hairline-border)] px-4 py-3">
                      <Pagination
                        current={watchlistPage}
                        total={visibleList.length}
                        pageSize={watchlistPageSize}
                        showSizeChanger
                        pageSizeOptions={[10, 20, 50]}
                        showLessItems
                        size="small"
                        onChange={(page, pageSize) => {
                          if (pageSize !== watchlistPageSize) {
                            setWatchlistPageSize(pageSize);
                            setWatchlistPage(1);
                            return;
                          }
                          setWatchlistPage(page);
                        }}
                        onShowSizeChange={(_page, pageSize) => {
                          setWatchlistPageSize(pageSize);
                          setWatchlistPage(1);
                        }}
                        showTotal={(total, range) => `${range[0]}-${range[1]} / ${total} 条`}
                      />
                    </div>
                  )}
                </>
              );
            })()}
          </section>
        </div>
      </div>
      )}

      <AnimatePresence>
        {listedEtfPrompt && (
          <ModalShell key="listed-etf-tab" onDismiss={() => setListedEtfPrompt(null)} ariaLabel="场内 ETF 添加提示">
            <motion.div
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }}
              transition={SPRING.sheet}
              className="bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-2xl rounded-[28px] max-w-sm w-full p-6 border border-[var(--hairline-border)] shadow-2xl space-y-4"
            >
              <div>
                <div className="apple-eyebrow text-blue-600 dark:text-blue-400 text-[10px] mb-1">场内交易品种</div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-50">这是场内 ETF</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{listedEtfPrompt.message}</p>
                <p className="mt-2 text-xs font-mono text-slate-400">代码：{listedEtfPrompt.code}</p>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setListedEtfPrompt(null)} className="px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10 rounded-xl">取消</button>
                <button onClick={() => {
                  preserveCodeOnTabSwitchRef.current = listedEtfPrompt.code;
                  setListedEtfPrompt(null);
                  setSelfTab('stock');
                  try { localStorage.setItem('fund_self_tab', 'stock'); } catch {}
                }} className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl">切换到股票</button>
              </div>
            </motion.div>
          </ModalShell>
        )}
      </AnimatePresence>

      {/* ─────────────────────────────────────────────────────────────────
         Edit Position Modal — Apple Materialize (scrim + sheet spring in)
         (§3 Interruptible · §4 Spring · §12 Materialize · §14 Reduced)
         ───────────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {editingCode && (
          <ModalShell
            key="edit-position"
            onDismiss={() => setEditingCode(null)}
            ariaLabel="编辑持仓"
            closeOnScrimClick={false}
          >
            <motion.div
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 12, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8, filter: 'blur(4px)' }}
              transition={SPRING.sheet}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-2xl rounded-[28px] max-w-sm w-full p-6 border border-[var(--hairline-border)] shadow-2xl relative overflow-hidden space-y-4"
            >
              {/* Top highlight */}
              <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent dark:via-white/10" />

              {/* 标题栏 — 解决过密与长文本溢出 */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="apple-eyebrow text-slate-400 text-[10px] mb-0.5 flex items-center gap-1">
                    <span aria-hidden>💼</span> 持仓管理
                  </div>
                  <h3 className="apple-display-heading text-sm font-bold text-slate-900 dark:text-slate-50 truncate" title={fundsData[editingCode]?.name || editingCode}>
                    {fundsData[editingCode]?.name || editingCode}
                  </h3>
                </div>
                {positions[editingCode] && positions[editingCode].shares > 0 && (
                  <div className="text-right shrink-0 bg-slate-50 dark:bg-white/5 border border-[var(--hairline-border)] px-2.5 py-1 rounded-xl">
                    <div className="text-[9px] text-slate-400 font-mono">现有持仓</div>
                    <div className="text-[11px] font-mono font-bold text-slate-700 dark:text-slate-200 tabular-nums">
                      {positions[editingCode].shares.toFixed(2)}<span className="text-[9px] font-normal text-slate-400">份</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 3 种持仓操作模式分段控制器：补仓 | 卖出 | 修正 */}
              <div className="flex p-0.5 bg-slate-100/70 dark:bg-white/5 rounded-full text-[11px]">
                {([
                  { key: 'buy', label: '➕ 补仓买入' },
                  { key: 'sell', label: '➖ 减仓卖出' },
                  { key: 'set', label: '✏️ 直接修正' },
                ] as const).map(opt => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setPosActionTab(opt.key)}
                    className={`flex-1 py-1.5 rounded-full font-semibold transition-all ${
                      posActionTab === opt.key
                        ? 'bg-white dark:bg-[#2c2c2e] text-slate-900 dark:text-slate-50 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="space-y-3.5">
                {/* 1. 补仓 / 加仓 */}
                {posActionTab === 'buy' && (
                  <>
                    <div>
                      <label className="apple-eyebrow block mb-1">本次买入/补仓份数 (份)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="例如: 500"
                        value={buyShares}
                        onChange={(e) => setBuyShares(e.target.value)}
                        className="apple-input w-full px-3.5 py-2 text-xs font-mono font-semibold placeholder-slate-400"
                      />
                    </div>
                    <div>
                      <label className="apple-eyebrow block mb-1">买入成交单价 (元/份)</label>
                      <input
                        type="number"
                        step="0.0001"
                        min="0"
                        placeholder="成交单价"
                        value={buyCost}
                        onChange={(e) => setBuyCost(e.target.value)}
                        className="apple-input w-full px-3.5 py-2 text-xs font-mono placeholder-slate-400"
                      />
                    </div>

                    {/* 补仓后成本加权预估面板 */}
                    <div className="bg-blue-50/60 dark:bg-blue-950/20 border border-blue-100/80 dark:border-blue-900/30 rounded-2xl p-3 text-[11px] space-y-1.5">
                      <div className="text-slate-500 flex justify-between">
                        <span>当前持仓：</span>
                        <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {positions[editingCode]?.shares.toFixed(2) || '0'} 份 @ ¥{positions[editingCode]?.cost.toFixed(4) || '0'}
                        </span>
                      </div>
                      <div className="text-blue-600 dark:text-blue-400 font-semibold flex justify-between pt-1.5 border-t border-blue-100/60 dark:border-blue-900/40">
                        <span>补仓后新持仓：</span>
                        <span className="font-mono tabular-nums">
                          {(() => {
                            const curS = positions[editingCode]?.shares || 0;
                            const curC = positions[editingCode]?.cost || 0;
                            const bS = parseFloat(buyShares);
                            const bC = parseFloat(buyCost);
                            if (isNaN(bS) || bS <= 0) {
                              return '请输入补仓份数';
                            }
                            const validBc = isNaN(bC) || bC <= 0 ? curC : bC;
                            const nextS = curS + bS;
                            const nextC = (curS * curC + bS * validBc) / nextS;
                            return `${nextS.toFixed(2)} 份 @ 新加权成本 ¥${nextC.toFixed(4)}`;
                          })()}
                        </span>
                      </div>
                    </div>
                  </>
                )}

                {/* 2. 减仓 / 卖出 */}
                {posActionTab === 'sell' && (
                  <>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="apple-eyebrow">本次卖出减仓份数 (份)</label>
                        <span className="text-[10px] text-slate-400 font-mono">
                          最多可卖 {positions[editingCode]?.shares.toFixed(2) || '0'} 份
                        </span>
                      </div>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max={positions[editingCode]?.shares || 0}
                        placeholder="卖出份数"
                        value={sellShares}
                        onChange={(e) => setSellShares(e.target.value)}
                        className="apple-input w-full px-3.5 py-2 text-xs font-mono font-semibold placeholder-slate-400"
                      />
                      {/* 快捷比例选框 */}
                      <div className="flex gap-1.5 mt-2">
                        {[
                          { label: '25%', ratio: 0.25 },
                          { label: '50%', ratio: 0.5 },
                          { label: '75%', ratio: 0.75 },
                          { label: '全仓卖出', ratio: 1 },
                        ].map(btn => (
                          <button
                            key={btn.label}
                            type="button"
                            onClick={() => {
                              const maxS = positions[editingCode]?.shares || 0;
                              setSellShares((maxS * btn.ratio).toFixed(2));
                            }}
                            className="flex-1 py-1 text-[10px] font-semibold bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/15 rounded-lg text-slate-600 dark:text-slate-300 transition-colors"
                          >
                            {btn.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 减仓预估面板 */}
                    <div className="bg-amber-50/60 dark:bg-amber-950/20 border border-amber-100/80 dark:border-amber-900/30 rounded-2xl p-3 text-[11px] space-y-1.5">
                      <div className="text-slate-500 flex justify-between">
                        <span>卖出后剩余持仓：</span>
                        <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {(() => {
                            const curS = positions[editingCode]?.shares || 0;
                            const sS = parseFloat(sellShares) || 0;
                            const left = Math.max(0, curS - sS);
                            return `${left.toFixed(2)} 份 (成本维持 ¥${(positions[editingCode]?.cost || 0).toFixed(4)})`;
                          })()}
                        </span>
                      </div>
                      <div className="text-amber-700 dark:text-amber-400 font-semibold flex justify-between pt-1.5 border-t border-amber-100/60 dark:border-amber-900/40">
                        <span>预估回笼资金：</span>
                        <span className="font-mono tabular-nums">
                          {(() => {
                            const sS = parseFloat(sellShares) || 0;
                            const curP = fundsData[editingCode]
                              ? (parseFloat(fundsData[editingCode].gsz) || parseFloat(fundsData[editingCode].dwjz) || 0)
                              : (positions[editingCode]?.cost || 0);
                            return `¥ ${(sS * curP).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                          })()}
                        </span>
                      </div>
                    </div>
                  </>
                )}

                {/* 3. 直接修正设置 */}
                {posActionTab === 'set' && (
                  <>
                    {/* 输入模式切换：按份数 / 按金额 */}
                    <div className="flex p-0.5 bg-slate-100/50 dark:bg-white/5 rounded-full mb-3 text-[10px]">
                      {([
                        { key: 'shares', label: '按份数设定' },
                        { key: 'amount', label: '按总金额设定' },
                      ] as const).map(opt => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setEditMode(opt.key)}
                          className={`flex-1 py-1 rounded-full font-semibold transition-colors ${
                            editMode === opt.key
                              ? 'bg-white dark:bg-[#2c2c2e] text-slate-900 dark:text-slate-50 shadow-sm'
                              : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    {editMode === 'shares' ? (
                      <>
                        <div>
                          <label className="apple-eyebrow block mb-1">总持有份额 (份)</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="如: 1000"
                            value={editShares}
                            onChange={(e) => setEditShares(e.target.value)}
                            className="apple-input w-full px-3.5 py-2 text-xs font-mono font-semibold placeholder-slate-400"
                          />
                        </div>
                        <div>
                          <label className="apple-eyebrow block mb-1">持仓均价成本 (元/份)</label>
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            placeholder="如: 2.1350"
                            value={editCost}
                            onChange={(e) => setEditCost(e.target.value)}
                            className="apple-input w-full px-3.5 py-2 text-xs font-mono placeholder-slate-400"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <label className="apple-eyebrow block mb-1">总投入金额 (元)</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="如: 10000"
                            value={editAmount}
                            onChange={(e) => {
                              setEditAmount(e.target.value);
                              const a = parseFloat(e.target.value);
                              const c = parseFloat(editCost);
                              if (!isNaN(a) && !isNaN(c) && c > 0 && a >= 0) setEditShares((a / c).toFixed(2));
                            }}
                            className="apple-input w-full px-3.5 py-2 text-xs font-mono font-semibold placeholder-slate-400"
                          />
                        </div>
                        <div>
                          <label className="apple-eyebrow block mb-1">成本单价 (元/份)</label>
                          <input
                            type="number"
                            step="0.0001"
                            min="0"
                            placeholder="单价"
                            value={editCost}
                            onChange={(e) => {
                              setEditCost(e.target.value);
                              const c = parseFloat(e.target.value);
                              const a = parseFloat(editAmount);
                              if (!isNaN(c) && !isNaN(a) && c > 0 && a >= 0) setEditShares((a / c).toFixed(2));
                            }}
                            className="apple-input w-full px-3.5 py-2 text-xs font-mono placeholder-slate-400"
                          />
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 text-xs pt-1 border-t border-slate-100 dark:border-white/5">
                {positions[editingCode] ? (
                  <button
                    type="button"
                    onClick={handleClearPosition}
                    className="px-2.5 py-1.5 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 font-semibold flex items-center gap-1 text-[11px] rounded-full transition-colors cursor-pointer"
                  >
                    <Trash2 size={12} />
                    清空持仓
                  </button>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingCode(null)}
                    className="px-4 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleActionSavePosition}
                    className="px-4 py-1.5 text-xs font-semibold rounded-full bg-[#0066cc] hover:bg-[#0055b3] dark:bg-[#2997ff] dark:hover:bg-[#47a4ff] text-white shadow-sm transition-all cursor-pointer"
                  >
                    {posActionTab === 'buy' ? '确认补仓' : posActionTab === 'sell' ? '确认卖出' : '保存设置'}
                  </button>
                </div>
              </div>
            </motion.div>          </ModalShell>
        )}
      </AnimatePresence>

      {/* ─────────────────────────────────────────────────────────────
         Mobile Quick Settings Sheet
         ───────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 md:hidden">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            />

            {/* Bottom Sheet Card */}
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', bounce: 0.05, duration: 0.35 }}
              className="absolute bottom-0 left-0 right-0 bg-[var(--canvas-bg)] dark:bg-[#1c1c1e] rounded-t-[28px] border-t border-[var(--hairline-border)] p-5 pb-8 space-y-5 shadow-2xl"
            >
              {/* Handle Indicator Bar */}
              <div className="w-10 h-1 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto" />

              {/* Title & Close */}
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base flex items-center gap-2">
                  <Settings size={18} className="text-[#0066cc]" /> 应用快捷设置
                </h3>
                <button
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="p-1 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Control items list */}
              <div className="space-y-3 pt-1">
                {/* 1. Theme Toggle */}
                <div className="bg-white/60 dark:bg-white/5 border border-[var(--hairline-border)] rounded-2xl p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {isDarkMode ? <Moon size={16} className="text-blue-400" /> : <Sun size={16} className="text-amber-500" />}
                    <div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">外观主题</div>
                      <div className="text-[10px] text-slate-400">{isDarkMode ? '深色夜间模式' : '浅色明亮模式'}</div>
                    </div>
                  </div>
                  <button
                    onClick={toggleDarkMode}
                    className="text-xs font-bold px-3 py-1.5 rounded-full bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-slate-200 border border-[var(--hairline-border)]"
                  >
                    {isDarkMode ? '🌙 切换亮色' : '☀️ 切换深色'}
                  </button>
                </div>

                {/* 2. Color Rule Toggle */}
                <div className="bg-white/60 dark:bg-white/5 border border-[var(--hairline-border)] rounded-2xl p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm">🎨</span>
                    <div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">涨跌配色偏好</div>
                      <div className="text-[10px] text-slate-400">{isIntlColor ? '美股/国际 (绿涨红跌)' : '国内传统 (红涨绿跌)'}</div>
                    </div>
                  </div>
                  <button
                    onClick={toggleColorRule}
                    className="text-xs font-bold px-3 py-1.5 rounded-full bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-slate-200 border border-[var(--hairline-border)]"
                  >
                    {isIntlColor ? '🟢 涨 🔴 跌' : '🔴 涨 🟢 跌'}
                  </button>
                </div>

                {/* 3. Push Logs & Subscriptions */}
                <div className="bg-white/60 dark:bg-white/5 border border-[var(--hairline-border)] rounded-2xl p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm">🔔</span>
                    <div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                        预警订阅与推送日志
                        {unreadAlertCount > 0 && (
                          <Badge count={unreadAlertCount} size="small" overflowCount={99} />
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400">查看个人告警记录与订阅规则</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      handleOpenNotificationLogs();
                    }}
                    className="text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 px-3 py-1.5 rounded-full border border-blue-200/50 dark:border-blue-900/30 cursor-pointer"
                  >
                    查看日志
                  </button>
                </div>

                {/* 4. Notification & Watermark (Admin only) */}
                <div className="bg-white/60 dark:bg-white/5 border border-[var(--hairline-border)] rounded-2xl p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm">📧</span>
                    <div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">邮件服务配置</div>
                      <div className="text-[10px] text-slate-400">配置 SMTP / Resend 服务密钥</div>
                    </div>
                  </div>
                  <React.Suspense fallback={<div className="flex items-center gap-1.5 text-xs text-slate-400 font-medium"><Spin size="small" /> 正在加载...</div>}>
                    <EmailConfigPanel
                      isAdmin={currentUser.toLowerCase() === 'admin'}
                      currentUser={currentUser}
                      onToast={showToast}
                    />
                  </React.Suspense>
                </div>

                {/* 5. User Info & Logout */}
                <div className="bg-white/60 dark:bg-white/5 border border-[var(--hairline-border)] rounded-2xl p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-6 h-6 rounded-full bg-[#0066cc] dark:bg-[#2997ff] text-white flex items-center justify-center font-bold text-[10px]">
                      {currentUser.substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">当前账号</div>
                      <div className="text-[10px] text-slate-400">{currentUser}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      handleLogout();
                    }}
                    className="text-xs font-semibold text-red-500 bg-red-50 dark:bg-red-950/30 px-3 py-1.5 rounded-full border border-red-200/50 dark:border-red-900/30 flex items-center gap-1"
                  >
                    <LogOut size={12} /> 退出登录
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ─────────────────────────────────────────────────────────────
         Fund Detail Drawer — right-side Apple Sheet
         Slides in from the right, focuses on the selected fund's
         curve, metrics and holdings. On mobile it expands to full-
         height sheet.
         ───────────────────────────────────────────────────────────── */}
      {/* ── 删除确认 Modal ── */}
      <AnimatePresence>
        {deletingItem && (
          <ModalShell
            onDismiss={() => setDeletingItem(null)}
            ariaLabel="确认删除"
            closeOnScrimClick={false}
          >
            <motion.div
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8 }}
              transition={SPRING.snap}
              onClick={e => e.stopPropagation()}
              className="apple-card p-6 max-w-sm w-full space-y-4"
            >
              <div className="space-y-1.5">
                <h3 className="apple-display-heading text-lg font-semibold text-slate-900 dark:text-slate-50">
                  确认退订并删除？
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  即将删除自选【<span className="font-semibold text-slate-700 dark:text-slate-200">{deletingItem.name || deletingItem.code}</span>】，这会同步清除该持仓与关联数据。
                </p>
              </div>
              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setDeletingItem(null)}
                  className="px-4 py-2 text-xs font-semibold rounded-full bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-white/20 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => executeRemove(deletingItem.code, deletingItem.name)}
                  className="px-4 py-2 text-xs font-semibold rounded-full bg-red-500 hover:bg-red-600 text-white shadow-sm transition-colors cursor-pointer"
                >
                  确认删除
                </button>
              </div>
            </motion.div>
          </ModalShell>
        )}
      </AnimatePresence>

      {/* ── 长按 2s 拖动浮卡（PC + 移动通用，跟随指针）── */}
      {pressDrag.activeCode && (() => {
        const code = pressDrag.activeCode;
        const fund = fundsData[code];
        const pos = positions[code];
        const bounds = slotBoundsRef.current.find(b => b.code === code);
        if (!fund || !bounds) return null;

        const changeVal = parseFloat(fund.gszzl);
        const isUp = changeVal > 0;
        const isDown = changeVal < 0;
        const changeColor = isUp
          ? 'text-[var(--color-up)]'
          : isDown ? 'text-[var(--color-down)]' : 'text-slate-400';
        const changeBg = isUp
          ? 'bg-[var(--color-up-bg)] text-[var(--color-up)]'
          : isDown
            ? 'bg-[var(--color-down-bg)] text-[var(--color-down)]'
            : 'bg-slate-100 dark:bg-slate-800 text-slate-500';

        let holdingValue = 0;
        let todayProfit = 0;
        if (pos) {
          const currentPrice = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
          const prevPrice = parseFloat(fund.dwjz);
          holdingValue = pos.shares * currentPrice;
          const updatedToday = isUpdatedToday(pos.updated_at);
          const basePrice = getTodayBasePrice(pos.cost, prevPrice, currentPrice, updatedToday);
          if (basePrice > 0 && currentPrice > 0) {
            todayProfit = pos.shares * (currentPrice - basePrice);
          }
        }

        const isDesktop = window.innerWidth >= 768;

        if (isDesktop) {
          // PC 桌面表格模式：渲染与表格 1:1 宽度的浮动行
          return (
            <motion.div
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1.01, opacity: 1 }}
              transition={SPRING.snap}
              style={{
                position: 'fixed',
                top: pressDrag.ghostY - pressDrag.grabOffsetY,
                left: bounds.left,
                width: bounds.width,
                zIndex: 9999,
                pointerEvents: 'none',
                willChange: 'top',
              }}
              className="bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-3xl rounded-xl shadow-[0_20px_50px_-10px_rgba(0,0,0,0.3),0_0_0_1px_rgba(59,130,246,0.3)]
                         border border-blue-500/40 cursor-grabbing overflow-hidden"
            >
              <table className="w-full text-left border-collapse text-xs">
                <tbody>
                  <tr className="bg-blue-50/20 dark:bg-blue-950/20">
                    <td className="p-4 pl-6">
                      <div className="flex items-center gap-2">
                        <svg width="10" height="14" viewBox="0 0 10 14" className="text-blue-500 shrink-0" fill="currentColor">
                          <circle cx="2" cy="3" r="1.2" /><circle cx="8" cy="3" r="1.2" />
                          <circle cx="2" cy="7" r="1.2" /><circle cx="8" cy="7" r="1.2" />
                          <circle cx="2" cy="11" r="1.2" /><circle cx="8" cy="11" r="1.2" />
                        </svg>
                        <div>
                          <div className="font-bold text-slate-800 dark:text-slate-100 truncate max-w-[180px]" title={fund.name}>
                            {fund.name}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
                            <span className="tabular-nums">{fund.fundcode}</span>
                            <Tag
                              color={
                                selfTab === 'stock'
                                  ? (fund.market === 'us' ? 'blue' : fund.market === 'hk' ? 'green' : 'gold')
                                  : 'default'
                              }
                              className="font-semibold text-[10px] rounded-full border-0 m-0 leading-none py-0.5 px-2 font-sans"
                            >
                              {selfTab === 'stock'
                                ? (fund.market === 'us' ? '美股' : fund.market === 'hk' ? '港股' : 'A股')
                                : '公募场外'}
                            </Tag>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-right font-mono font-medium tabular-nums">
                      {parseFloat(fund.dwjz).toFixed(4)}
                      <div className="text-[9px] text-[#86868b] mt-0.5">{fund.jzrq}</div>
                    </td>
                    <td className="p-4 text-right font-mono font-bold text-slate-700 dark:text-slate-300 tabular-nums">
                      {parseFloat(fund.gsz).toFixed(4)}
                      <div className="text-[9px] text-[#86868b] mt-0.5">{fund.gztime.split(' ')[1] || fund.gztime}</div>
                    </td>
                    <td className={`p-4 text-right font-bold font-mono tabular-nums ${changeColor}`}>
                      {isUp ? '+' : ''}{changeVal.toFixed(2)}%
                    </td>
                    <td className="p-4 text-right whitespace-nowrap">
                      {pos ? (
                        <div className="inline-flex flex-col items-end text-right p-1">
                          <div className="font-mono font-bold text-sm text-slate-800 dark:text-slate-100 tabular-nums">
                            ¥{holdingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5 tabular-nums">
                            {pos.shares.toFixed(2)}份 · @{pos.cost.toFixed(4)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-400">未持仓</span>
                      )}
                    </td>
                    <td className={`p-4 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                      pos
                        ? (todayProfit > 0 ? 'text-[var(--color-up)]'
                            : todayProfit < 0 ? 'text-[var(--color-down)]'
                            : 'text-slate-400')
                        : 'text-slate-300 dark:text-slate-700'
                    }`}>
                      {pos ? `${todayProfit > 0 ? '+' : ''}${todayProfit.toFixed(2)}` : '--'}
                    </td>
                    <td className="p-4 text-center pr-6 whitespace-nowrap">
                      <span className="px-2.5 py-1 rounded-full bg-blue-500 text-white text-[10px] font-bold tracking-wider shadow-sm">
                        拖动中
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </motion.div>
          );
        }

        // 移动端 Card 模式
        return (
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={SPRING.snap}
            style={{
              position: 'fixed',
              top: pressDrag.ghostY - pressDrag.grabOffsetY,
              left: bounds.left,
              width: bounds.width,
              zIndex: 9999,
              pointerEvents: 'none',
              willChange: 'top',
            }}
            className="bg-white/90 dark:bg-[#1c1c1e]/90 backdrop-blur-3xl rounded-[20px] p-3.5 space-y-2 cursor-grabbing origin-top-left
                       shadow-[0_24px_48px_-12px_rgba(0,0,0,0.28),0_2px_6px_-1px_rgba(0,0,0,0.08),inset_0_1px_0_0_rgba(255,255,255,0.6)]
                       ring-1 ring-black/[0.06] dark:ring-white/[0.08]
                       before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-gradient-to-r before:from-transparent before:via-blue-500 before:to-transparent before:rounded-t-[20px]"
          >
            <div className="flex items-start justify-between gap-2 relative">
              <div className="min-w-0 flex-1">
                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">
                  {fund.name}
                </div>
                <div className="text-[10px] text-slate-400 font-mono mt-0.5 tabular-nums">
                  {fund.fundcode}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <svg width="10" height="14" viewBox="0 0 10 14" className="text-blue-500" fill="currentColor">
                  <circle cx="2" cy="3" r="1.2" /><circle cx="8" cy="3" r="1.2" />
                  <circle cx="2" cy="7" r="1.2" /><circle cx="8" cy="7" r="1.2" />
                  <circle cx="2" cy="11" r="1.2" /><circle cx="8" cy="11" r="1.2" />
                </svg>
                <div className="px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[9px] font-bold tracking-wider">
                  拖动中
                </div>
              </div>
            </div>
            <div className="flex items-baseline justify-between pt-1">
              <div className="font-mono font-bold text-base text-slate-800 dark:text-slate-100 tabular-nums">
                {parseFloat(fund.gsz).toFixed(4)}
              </div>
              <div className={`px-2 py-0.5 rounded-lg font-mono font-bold text-xs tabular-nums ${changeBg}`}>
                {isUp ? '+' : ''}{changeVal.toFixed(2)}%
              </div>
            </div>
          </motion.div>
        );
      })()}

      <AnimatePresence>
        {selectedFundCode && fundsData[selectedFundCode] && (() => {
          const item = watchlistItems.find(w => w.fund_code === selectedFundCode) || (detailOverrideMap[selectedFundCode] ? {
            fund_code: selectedFundCode,
            kind: detailOverrideMap[selectedFundCode].kind,
            market: detailOverrideMap[selectedFundCode].market,
          } : undefined);
          const isStock = item?.kind === 'stock';
          return (
          <DetailDrawer
            key="detail-drawer"
            onDismiss={() => {
              setSelectedFundCode(null);
              setIsDetailExpanded(false);
            }}
            ariaLabel={isStock ? '股票详情' : '基金详情'}
            title={isStock ? '股票详情' : '基金详情'}
            isDarkMode={isDarkMode}
            isExpanded={isDetailExpanded}
            onToggleExpand={() => setIsDetailExpanded(v => !v)}
          >
            <React.Suspense fallback={<DetailPanelSkeleton />}>
            <DetailErrorBoundary>
            <FundDetailPanel
              key={selectedFundCode}
              fund={fundsData[selectedFundCode]}
              kind={item?.kind}
              capitalFlowState={detailFlowState[selectedFundCode]}
              position={positions[selectedFundCode]}
              history={historyMap[selectedFundCode] || []}
              historyLoading={historyLoading}
              basic={basicMap[selectedFundCode]}
              holdings={holdingsMap[selectedFundCode] || []}
              isExpanded={isDetailExpanded}
              onToggleExpand={() => setIsDetailExpanded(v => !v)}
              onEditPosition={() => {
                setSelectedFundCode(null);
                setIsDetailExpanded(false);
                setTimeout(() => openEditPosition(selectedFundCode), 280);
              }}
              onToast={showToast}
              onOpenNotificationLogs={() => setIsNotificationLogOpen(true)}
            />
            </DetailErrorBoundary>
            </React.Suspense>
          </DetailDrawer>
          );
        })()}
      </AnimatePresence>

      {/* ─────────────────────────────────────────────────────────────
         Notification Logs & Subscriptions Modal (User-Isolated)
         ───────────────────────────────────────────────────────────── */}
      <React.Suspense fallback={null}>
        <NotificationLogModal
          open={isNotificationLogOpen}
          onClose={() => setIsNotificationLogOpen(false)}
          currentUser={currentUser}
          onToast={showToast}
          onSelectFund={(code) => {
            setSelectedFundCode(code);
            setIsDetailExpanded(false);
          }}
        />
      </React.Suspense>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────
   ModalShell — handles the scrim, focus trap surface, and click-out
   The actual card uses Motion for the spring enter/exit.
   ─────────────────────────────────────────────────────────────────── */

function ModalShell({
  children,
  onDismiss,
  ariaLabel,
  closeOnScrimClick = true
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  ariaLabel: string;
  closeOnScrimClick?: boolean;
}) {
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnScrimClick) onDismiss();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onDismiss, closeOnScrimClick]);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
      transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
      onMouseDown={(e) => {
        if (closeOnScrimClick && e.target === e.currentTarget) onDismiss();
      }}
      onClick={(e) => {
        if (closeOnScrimClick && e.target === e.currentTarget) onDismiss();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40"
      style={{
        backdropFilter: prefersReducedMotion ? undefined : 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: prefersReducedMotion ? undefined : 'blur(20px) saturate(180%)',
      }}
    >
      {children}
    </motion.div>
  );
}

/* ───────────────────────────────────────────────────────────────────
   PressableButton — instant feedback on pointer-down (§1).
   Avoids the perceived latency of waiting for click/touch-up.
   ─────────────────────────────────────────────────────────────────── */

const PressableButton = React.forwardRef<HTMLButtonElement, HTMLMotionProps<'button'>>(
  function PressableButton({ children, className = '', disabled, type = 'button', ...rest }, ref) {
    const { pressed, handlers } = usePointerDown();
    const prefersReducedMotion = useReducedMotion();

    return (
      <motion.button
        ref={ref}
        type={type}
        disabled={disabled}
        {...rest}
        {...handlers}
        animate={prefersReducedMotion || disabled ? undefined : {
          scale: pressed ? 0.96 : 1,
          opacity: pressed ? 0.92 : 1,
        }}
        transition={SPRING.snap}
        className={className}
      >
        {children}
      </motion.button>
    );
  }
);

const PressableIconButton = React.forwardRef<HTMLButtonElement, HTMLMotionProps<'button'>>(
  function PressableIconButton({ children, className = '', disabled, ...rest }, ref) {
    const { pressed, handlers } = usePointerDown();
    const prefersReducedMotion = useReducedMotion();

    return (
      <motion.button
        ref={ref}
        {...rest}
        disabled={disabled}
        {...handlers}
        animate={prefersReducedMotion ? undefined : {
          scale: pressed ? 0.88 : 1,
        }}
        transition={SPRING.snap}
        className={className}
      >
        {children}
      </motion.button>
    );
  }
);

/* ───────────────────────────────────────────────────────────────────
   DetailDrawer — right-anchored Apple Sheet
   Slides in from the right edge with a spring (Apple's preferred
   pattern for secondary detail / peek content — see iOS Maps, Music).
   On md+ screens it caps at 560px; below md it becomes a full-height
   sheet from the bottom.
   ─────────────────────────────────────────────────────────────────── */

function DetailDrawer({
  children,
  onDismiss,
  ariaLabel,
  title = '详情',
  isDarkMode = false,
  isExpanded = false,
  onToggleExpand,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  ariaLabel: string;
  title?: string;
  isDarkMode?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [visible, setVisible] = useState(true);

  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  const handleAfterOpenChange = useCallback((open: boolean) => {
    if (!open) {
      onDismiss();
    }
  }, [onDismiss]);

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          fontFamily: 'inherit',
          colorBgElevated: isDarkMode ? '#1c1c1e' : '#ffffff',
        },
      }}
    >
      <Drawer
        title={
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{title}</span>
            {isExpanded && (
              <Tag color="processing" className="text-[10px] rounded-full border-0 font-semibold m-0">
                全屏视图
              </Tag>
            )}
          </div>
        }
        extra={
          onToggleExpand ? (
            <div className="flex items-center gap-2 mr-2">
              <button
                type="button"
                onClick={onToggleExpand}
                title={isExpanded ? '收起弹窗' : '展开全屏视图'}
                className="hidden md:flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 rounded-full transition-colors cursor-pointer"
              >
                {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                <span>{isExpanded ? '收起' : '展开'}</span>
              </button>
            </div>
          ) : null
        }
        placement="right"
        open={visible}
        onClose={handleClose}
        afterOpenChange={handleAfterOpenChange}
        width={
          isExpanded
            ? '100vw'
            : typeof window !== 'undefined' && window.innerWidth < 768 ? '100%' : 640
        }
        aria-label={ariaLabel}
        styles={{
          header: {
            padding: '12px 20px',
            borderBottom: '1px solid var(--hairline-border)',
          },
          body: {
            padding: isExpanded ? '20px 32px' : '12px 16px',
            backgroundColor: 'var(--canvas-bg)',
          },
          mask: {
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
          },
        }}
        destroyOnClose
      >
        {children}
      </Drawer>
    </ConfigProvider>
  );
}

export default App;
