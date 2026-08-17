import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { TrendingUp, TrendingDown, Minus, Globe, Coins, RefreshCw, AlertCircle } from 'lucide-react';
import { fetchGoldPrices, fetchGoldHistory, type GoldPrice, type GoldHistoryResponse } from '../services/api';
import { GoldChart, type GoldPoint } from './GoldChart';

interface GoldCard {
  key: 'international' | 'domestic' | 'london';
  title: string;
  subtitle: string;
  icon: typeof Globe;
  accentBg: string;
  accentText: string;
  accentRing: string;
  /**
   * 交易时段判断器：返回该市场当前是否处于交易时段
   *   - 'open'  正在交易
   *   - 'closed' 已收盘
   *   - 'pre'   即将开盘（< 30min）
   * 输入参数为 Date（北京时间），输出包含是否交易及下次开盘/收盘时间（可选）
   */
  tradingHours: (now: Date) => MarketStatus;
}

interface MarketStatus {
  state: 'open' | 'closed' | 'pre';
  label: string;             // '交易中' / '已收盘' / '即将开盘'
  nextEvent?: string;        // '下次开盘 21:30' / '收盘于 04:00' 等
}

const CARDS: GoldCard[] = [
  {
    key: 'international',
    title: '国际黄金',
    subtitle: 'COMEX 黄金（纽约）· 美元/盎司',
    icon: Globe,
    accentBg: 'bg-blue-50 dark:bg-blue-950/30',
    accentText: 'text-blue-700 dark:text-blue-400',
    accentRing: 'border-blue-200/70 dark:border-blue-800/50',
    // COMEX 黄金电子盘几乎 24h（含 1h 维护 06:00-07:00 北京），但官方主交易时段
    // 21:30-04:00 北京时间 (美东 08:30-17:00 + 电子盘延展到次日 04:00)。
    // 周一-周五交易，周末闭市。
    tradingHours: (now) => comexStatus(now),
  },
  {
    key: 'london',
    title: '伦敦金',
    subtitle: 'LBMA Spot 现货 · 美元/盎司',
    icon: Coins,
    accentBg: 'bg-amber-50 dark:bg-amber-950/30',
    accentText: 'text-amber-700 dark:text-amber-400',
    accentRing: 'border-amber-200/70 dark:border-amber-800/50',
    // LBMA Spot 现货定盘价 北京时间 16:00 / 次日 00:00 / 04:00 三次定盘
    // OTC 电子盘周一-周五几乎 24h（21:00-次日 04:00 北京）
    tradingHours: (now) => lbmaStatus(now),
  },
  {
    key: 'domestic',
    title: '国内黄金',
    subtitle: '上海黄金交易所 Au99.99 · 人民币/克',
    icon: Coins,
    accentBg: 'bg-rose-50 dark:bg-rose-950/30',
    accentText: 'text-rose-700 dark:text-rose-400',
    accentRing: 'border-rose-200/70 dark:border-rose-800/50',
    // SGE Au99.99 交易日 9:00-次日 2:30 北京，周一-周五
    // (夜盘延续到次日 02:30)
    tradingHours: (now) => sgeStatus(now),
  },
];

type GoldKey = GoldCard['key'];
type Range = 'intraday' | '1W' | '1M';

// ──────────────────────────────────────────────────────────
// 交易时段工具
// ──────────────────────────────────────────────────────────

/** 北京时间的"时分"转分钟数（0-1439） */
function toMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** 当前分钟数是否落在 [startMin, endMin] 区间（支持跨午夜，endMin < startMin 表示次日） */
function isWithin(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  // 跨午夜
  return nowMin >= startMin || nowMin < endMin;
}

/** 当前分钟数距 [startMin, endMin] 区间的"距离"（分钟），用于 pre-open 提示 */
function minutesToNextOpen(nowMin: number, startMin: number): number {
  let diff = startMin - nowMin;
  if (diff <= 0) diff += 24 * 60;
  return diff;
}

/**
 * 判断给定 Date 是否是工作日（周一-周五，北京时间）
 */
function isWeekday(d: Date): boolean {
  const dow = d.getDay();
  return dow >= 1 && dow <= 5;
}

/**
 * COMEX GC 黄金期货交易时段（北京时间）
 *  - 日盘（电子盘延续）：周一-周五 13:00-23:30（夏）/ 14:00-00:30（冬）
 *  - 夜盘（前一日美东）：周日-周四 18:00-02:30（夏）/ 19:00-02:30（冬）
 *  - 每日维护：23:30-02:30（夏）/ 00:30-02:30（冬）
 *
 * 当前简化：按夏令时（3 月-11 月）显示，冬季再调整
 *  注：夏令时从 3 月第二个周日开始，11 月第一个周日结束
 */
function comexStatus(now: Date): MarketStatus {
  const m = toMinutes(now);
  const summer = isUsDst(now);   // 美东夏令时

  // 周六全天 + 周五晚到周六凌晨 → 休市
  // 周日 18:00/19:00 才开盘
  const dow = now.getDay();
  if (dow === 6) return { state: 'closed', label: '已收盘', nextEvent: `周日 ${summer ? '18:00' : '19:00'} 开盘` };
  // 周日凌晨到开盘前
  if (dow === 0 && m < (summer ? 18 * 60 : 19 * 60)) {
    return { state: 'closed', label: '已收盘', nextEvent: `${summer ? '18:00' : '19:00'} 开盘` };
  }
  // 周五收盘后到周六凌晨
  if (dow === 5 && m >= (summer ? 23 * 60 + 30 : 24 * 60)) {
    return { state: 'closed', label: '已收盘', nextEvent: `周日 ${summer ? '18:00' : '19:00'} 开盘` };
  }

  // 维护时段
  if (summer && m >= 23 * 60 + 30 && m < 24 * 60) {
    return { state: 'closed', label: '盘前维护', nextEvent: '00:00 夜盘开盘' };
  }
  if (!summer && m >= 0 && m < 30) {
    return { state: 'closed', label: '盘前维护', nextEvent: '00:30 夜盘开盘' };
  }

  // 夜盘：18:00-02:30（夏）/ 19:00-02:30（冬）
  if (summer && isWithin(m, 18 * 60, 24 * 60)) return { state: 'open', label: '夜盘交易中', nextEvent: '维护 23:30' };
  if (summer && m < 2 * 60 + 30) return { state: 'open', label: '夜盘交易中', nextEvent: '维护 02:30' };
  if (!summer && isWithin(m, 19 * 60, 24 * 60)) return { state: 'open', label: '夜盘交易中', nextEvent: '维护 00:30' };
  if (!summer && m < 2 * 60 + 30) return { state: 'open', label: '夜盘交易中', nextEvent: '维护 02:30' };

  // 日盘：13:00-23:30（夏）/ 14:00-00:30（冬）
  if (summer && m >= 13 * 60 && m < 23 * 60 + 30) return { state: 'open', label: '日盘交易中', nextEvent: '夜盘 18:00' };
  if (!summer && m >= 14 * 60 && m < 24 * 60) return { state: 'open', label: '日盘交易中', nextEvent: '夜盘 19:00' };

  // 即将开盘（30 分钟内）
  if (summer) {
    const toDay = minutesToNextOpen(m, 13 * 60);
    if (toDay > 0 && toDay <= 30) return { state: 'pre', label: '即将开盘', nextEvent: `13:00 日盘` };
    const toNight = minutesToNextOpen(m, 18 * 60);
    if (toNight > 0 && toNight <= 30) return { state: 'pre', label: '夜盘即将开盘', nextEvent: `18:00 开盘` };
  } else {
    const toDay = minutesToNextOpen(m, 14 * 60);
    if (toDay > 0 && toDay <= 30) return { state: 'pre', label: '即将开盘', nextEvent: `14:00 日盘` };
    const toNight = minutesToNextOpen(m, 19 * 60);
    if (toNight > 0 && toNight <= 30) return { state: 'pre', label: '夜盘即将开盘', nextEvent: `19:00 开盘` };
  }

  return { state: 'closed', label: '已收盘', nextEvent: summer ? '13:00 日盘开盘' : '14:00 日盘开盘' };
}

/**
 * LBMA 现货黄金（北京时间）
 *  - 定盘价：London 10:30（北京时间 17:30 夏 / 18:30 冬）+ London 15:00（北京时间 22:00 夏 / 23:00 冬）
 *  - OTC 现货：周一-周五 London 08:00-17:00 ≈ 北京 15:00-24:00（夏）/ 16:00-次日 01:00（冬）
 *  - 周末停盘
 *  - 注：实际 24h OTC 由参与行维持（亚洲时段盘口稀）
 */
function lbmaStatus(now: Date): MarketStatus {
  const summer = isUkDst(now);   // UK 夏令时（与美东基本同步，少数年份差 1 周）
  const m = toMinutes(now);
  const dow = now.getDay();

  if (dow === 6 || dow === 0) return { state: 'closed', label: '已收盘', nextEvent: '周一 15:00 开盘' };
  if (dow === 5 && m >= (summer ? 24 * 60 : 25 * 60)) {
    return { state: 'closed', label: '已收盘', nextEvent: '周一 15:00 开盘' };
  }
  if (dow === 1 && m < (summer ? 15 * 60 : 16 * 60)) {
    return { state: 'closed', label: '已收盘', nextEvent: summer ? '15:00 开盘' : '16:00 开盘' };
  }

  // OTC 现货：周一-周五 15:00-24:00（夏）/ 16:00-次日 01:00（冬）
  if (summer && isWithin(m, 15 * 60, 24 * 60)) return { state: 'open', label: 'OTC 报价中', nextEvent: 'PM 定盘 22:00' };
  if (!summer && isWithin(m, 16 * 60, 24 * 60)) return { state: 'open', label: 'OTC 报价中', nextEvent: 'PM 定盘 23:00' };

  // 跨日部分（冬季延伸）
  if (!summer && m < 1 * 60) return { state: 'open', label: 'OTC 报价中', nextEvent: '01:00 收盘' };

  // 即将开盘
  const start = summer ? 15 * 60 : 16 * 60;
  const minToOpen = minutesToNextOpen(m, start);
  if (minToOpen > 0 && minToOpen <= 30) {
    return { state: 'pre', label: '即将开盘', nextEvent: `${summer ? '15:00' : '16:00'} 开盘` };
  }

  return { state: 'closed', label: '已收盘', nextEvent: summer ? '15:00 开盘' : '16:00 开盘' };
}

/**
 * 美东夏令时判定（3 月第二个周日 02:00 - 11 月第一个周日 02:00 美东）
 * 简化：按月份粗判（3-10 月），忽略具体日期
 */
function isUsDst(d: Date): boolean {
  const month = d.getMonth() + 1;  // 1-12
  return month >= 3 && month <= 10;
}

/**
 * 英国夏令时判定（与美东基本同步）
 */
function isUkDst(d: Date): boolean {
  return isUsDst(d);  // 简化：3 月-10 月
}

/**
 * 上海黄金交易所 Au99.99 交易时段（北京时间）
 *  - 日盘：09:00 - 11:30
 *  - 午休：11:30 - 13:30
 *  - 下午：13:30 - 15:30
 *  - 夜盘：20:00 - 次日 02:30
 *  - 周一-周五
 */
function sgeStatus(now: Date): MarketStatus {
  if (!isWeekday(now)) {
    return { state: 'closed', label: '已收盘', nextEvent: '周一 09:00 开盘' };
  }
  const m = toMinutes(now);
  // 日盘 09:00-11:30
  if (m >= 9 * 60 && m < 11 * 60 + 30) {
    return { state: 'open', label: '交易中', nextEvent: '午休于 11:30' };
  }
  // 下午 13:30-15:30
  if (m >= 13 * 60 + 30 && m < 15 * 60 + 30) {
    return { state: 'open', label: '交易中', nextEvent: '收盘于 15:30' };
  }
  // 夜盘 20:00 - 次日 02:30
  if (m >= 20 * 60 || m < 2 * 60 + 30) {
    return { state: 'open', label: '夜盘交易中', nextEvent: m >= 20 * 60 ? '收盘于次日 02:30' : '收盘于 02:30' };
  }
  // 即将开盘（日盘 30 分钟内）
  const minToDayOpen = minutesToNextOpen(m, 9 * 60);
  if (minToDayOpen > 0 && minToDayOpen <= 30) {
    return { state: 'pre', label: '即将开盘', nextEvent: `09:00 开盘` };
  }
  // 即将开盘（夜盘 30 分钟内）
  const minToNightOpen = minutesToNextOpen(m, 20 * 60);
  if (minToNightOpen > 0 && minToNightOpen <= 30) {
    return { state: 'pre', label: '夜盘即将开盘', nextEvent: `20:00 开盘` };
  }
  return { state: 'closed', label: '已收盘', nextEvent: `09:00 开盘` };
}

function formatPrice(g: GoldPrice | null | undefined): string {
  if (!g || g.price == null) return '—';
  return g.price.toFixed(2);
}

function formatChange(g: GoldPrice | null | undefined): string {
  if (!g || g.change == null) return '—';
  const sign = g.change > 0 ? '+' : '';
  return `${sign}${g.change.toFixed(2)}`;
}

function formatChangePct(g: GoldPrice | null | undefined): string {
  if (!g || g.changePct == null) return '—';
  const sign = g.changePct > 0 ? '+' : '';
  return `${sign}${g.changePct.toFixed(2)}%`;
}

export function GoldTab() {
  const prefersReducedMotion = useReducedMotion();
  const [data, setData] = useState<{ international: GoldPrice | null; domestic: GoldPrice | null; london: GoldPrice | null; updatedAt: string; error: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [focus, setFocus] = useState<GoldKey>('international');
  const [range, setRange] = useState<Range>('intraday');
  const [history, setHistory] = useState<GoldHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const historyTickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRealtime = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetchGoldPrices();
      if (res) setData(res);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadHistory = useCallback(async (key: GoldKey, r: Range) => {
    setHistoryLoading(true);
    try {
      const res = await fetchGoldHistory(key, r);
      if (res) setHistory(res);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // realtime poll
  useEffect(() => {
    loadRealtime();
    tickerRef.current = setInterval(() => loadRealtime(), 30_000);
    return () => {
      if (tickerRef.current) clearInterval(tickerRef.current);
    };
  }, [loadRealtime]);

  // history poll — fetch on focus/range change, refresh every 60s
  useEffect(() => {
    loadHistory(focus, range);
    if (historyTickerRef.current) clearInterval(historyTickerRef.current);
    historyTickerRef.current = setInterval(() => loadHistory(focus, range), 60_000);
    return () => {
      if (historyTickerRef.current) clearInterval(historyTickerRef.current);
    };
  }, [focus, range, loadHistory]);

  const historyPoints = useMemo<GoldPoint[]>(() => {
    return history?.points ?? [];
  }, [history]);

  // 当前时间（每分钟刷新一次）— 用于交易状态判定
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // 各市场状态（每次 now 变化重算）
  const marketStatuses = useMemo(() => {
    const m = new Map<GoldKey, MarketStatus>();
    CARDS.forEach(c => m.set(c.key, c.tradingHours(now)));
    return m;
  }, [now]);

  const focusedCard = CARDS.find(c => c.key === focus)!;
  const focusedData = data?.[focus];

  /** 哪些市场当前正在交易 */
  const openMarkets = useMemo(
    () => CARDS.filter(c => marketStatuses.get(c.key)?.state === 'open'),
    [marketStatuses]
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2 px-1">
        <h2 className="apple-display-heading text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <span aria-hidden>💰</span>
          金价行情
          <span className="text-[10px] text-slate-500 font-normal px-1.5 py-0.5 bg-slate-100/60 dark:bg-white/5 rounded-full">
            国 / 伦 / 国内
          </span>
          {openMarkets.length > 0 ? (
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-1 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200/70 dark:border-emerald-800/50"
              title={openMarkets.map(c => `${c.title}: ${marketStatuses.get(c.key)?.label}`).join('\n')}
            >
              <motion.span
                className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"
                animate={prefersReducedMotion ? {} : { opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              />
              {openMarkets.length === 1
                ? `${openMarkets[0].title} 交易中`
                : `${openMarkets.length} 个市场交易中`}
            </span>
          ) : (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-1 bg-slate-100/80 dark:bg-white/5 text-slate-500 dark:text-slate-400 border border-slate-200/70 dark:border-white/10">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400" />
              全部休市
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 flex items-center gap-1.5">
            <motion.span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: refreshing ? 'var(--color-up)' : data ? 'var(--color-up)' : 'var(--color-flat)' }}
              animate={prefersReducedMotion || !refreshing ? { opacity: 1 } : { opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            />
            {refreshing ? '刷新中…' : '每 30s 自动刷新'}
          </span>
          <button
            onClick={() => loadRealtime(true)}
            disabled={refreshing}
            className="text-[10px] font-bold bg-white/70 dark:bg-white/5 border border-[var(--hairline-border)] px-2.5 py-1 rounded-full flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-white/10 disabled:opacity-50"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            手动刷新
          </button>
        </div>
      </div>

      {/* Error state */}
      {data?.error && (
        <div className="px-4 py-3 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/50 text-amber-700 dark:text-amber-400 text-xs flex items-center gap-2">
          <AlertCircle size={14} />
          <span>部分数据可能不准确：{data.error}</span>
        </div>
      )}

      {/* 3 cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {CARDS.map((card) => {
          const q = data?.[card.key];
          const Icon = card.icon;
          const price = formatPrice(q);
          const change = formatChange(q);
          const changePct = formatChangePct(q);
          const dirUp = q?.change != null && q.change > 0;
          const dirDown = q?.change != null && q.change < 0;
          const TrendIcon = dirUp ? TrendingUp : dirDown ? TrendingDown : Minus;
          const trendColor = dirUp ? 'var(--color-up)' : dirDown ? 'var(--color-down)' : 'var(--color-flat)';
          const isFocused = focus === card.key;
          const clickable = q?.price != null;
          const status = marketStatuses.get(card.key)!;

          return (
            <motion.button
              key={card.key}
              onClick={() => clickable && setFocus(card.key)}
              disabled={!clickable}
              initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
              className={`text-left rounded-2xl border p-5 transition-all
                ${card.accentRing} ${card.accentBg}
                ${isFocused ? 'ring-2 ring-offset-2 ring-[var(--primary-accent)] dark:ring-offset-[#1d1d1f]' : ''}
                ${clickable ? 'hover:scale-[1.01] cursor-pointer' : 'opacity-90'}
              `}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className={`text-sm font-bold flex items-center gap-1.5 ${card.accentText}`}>
                    <Icon size={14} />
                    {card.title}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{card.subtitle}</div>
                  <MarketStatusBadge status={status} />
                </div>
                {q?.source && (
                  <span className="text-[9px] font-mono text-slate-400 bg-white/60 dark:bg-black/30 px-1.5 py-0.5 rounded-full border border-slate-200/60 dark:border-slate-800/60">
                    {q.source}
                  </span>
                )}
              </div>

              <div className="mb-3">
                <div className="text-3xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-50">
                  {loading && !data ? (
                    <span className="inline-block w-24 h-9 bg-slate-200/60 dark:bg-slate-700/40 rounded animate-pulse" />
                  ) : (
                    <>{price}<span className="text-sm font-normal text-slate-500 ml-1">{q?.currency}/{q?.unit}</span></>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1 font-bold tabular-nums" style={{ color: trendColor }}>
                  <TrendIcon size={12} />
                  {changePct}
                </span>
                <span className="text-slate-500 tabular-nums">{change}</span>
              </div>

              <div className="mt-3 pt-3 border-t border-slate-200/50 dark:border-white/10 grid grid-cols-3 gap-2 text-[10px]">
                <div>
                  <div className="text-slate-400">最高</div>
                  <div className="font-mono tabular-nums text-slate-700 dark:text-slate-300">{q?.high != null ? q.high.toFixed(2) : '—'}</div>
                </div>
                <div>
                  <div className="text-slate-400">最低</div>
                  <div className="font-mono tabular-nums text-slate-700 dark:text-slate-300">{q?.low != null ? q.low.toFixed(2) : '—'}</div>
                </div>
                <div className="text-right">
                  <div className="text-slate-400">时间</div>
                  <div className="font-mono text-slate-700 dark:text-slate-300">{q?.time || '—'}</div>
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>

      {/* Chart section */}
      <div className="bg-white/70 dark:bg-white/[0.03] border border-[var(--hairline-border)] rounded-2xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          {/* Focus 切换 */}
          <div className="inline-flex bg-slate-100/60 dark:bg-white/5 rounded-full p-0.5">
            {CARDS.map(c => (
              <button
                key={c.key}
                onClick={() => setFocus(c.key)}
                className={`relative px-2.5 py-1 text-[11px] font-semibold rounded-full transition-colors ${
                  focus === c.key ? 'text-white' : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {focus === c.key && (
                  <motion.span
                    layoutId="gold-focus-pill"
                    transition={{ type: 'spring' as const, bounce: 0.05, duration: 0.36 }}
                    className="absolute inset-0 rounded-full"
                    style={{ background: 'var(--primary-accent)' }}
                  />
                )}
                <span className="relative z-10">{c.title}</span>
              </button>
            ))}
          </div>

          {/* Range 切换 */}
          <div className="inline-flex bg-slate-100/60 dark:bg-white/5 rounded-full p-0.5">
            {([
              { key: 'intraday', label: '分时' },
              { key: '1W',       label: '1周' },
              { key: '1M',       label: '1月' },
            ] as { key: Range; label: string }[]).map(r => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`relative px-3 py-1 text-[11px] font-semibold rounded-full transition-colors ${
                  range === r.key ? 'text-white' : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {range === r.key && (
                  <motion.span
                    layoutId="gold-range-pill"
                    transition={{ type: 'spring' as const, bounce: 0.05, duration: 0.36 }}
                    className="absolute inset-0 rounded-full"
                    style={{ background: 'var(--primary-accent)' }}
                  />
                )}
                <span className="relative z-10">{r.label}</span>
              </button>
            ))}
          </div>
        </div>

        {historyLoading && historyPoints.length < 2 ? (
          <div className="text-center py-10 text-slate-400 text-xs">加载中…</div>
        ) : historyPoints.length < 2 ? (
          <GoldChart
            points={[]}
            prevClose={focusedData?.prevClose ?? null}
            currency={focusedData?.currency ?? ''}
            unit={focusedData?.unit ?? ''}
            emptyHint={
              range !== 'intraday'
                ? `服务累积不够 — 后端每 60s 写一次金价快照，开几小时后再来`
                : `服务累积不够 — 启动不到 1 分钟；2 分钟后会开始有点`
            }
          />
        ) : (
          <GoldChart
            points={historyPoints}
            range={range}
            prevClose={focusedData?.prevClose ?? null}
            currency={focusedData?.currency ?? ''}
            unit={focusedData?.unit ?? ''}
          />
        )}

        {/* 当前价格快照 */}
        <div className="mt-3 pt-3 border-t border-slate-200/50 dark:border-white/10 flex items-center justify-between text-xs">
          <div className="flex items-center gap-3">
            <span className={`font-bold ${focusedCard.accentText}`}>{focusedCard.title}</span>
            <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">
              {focusedData?.price != null ? focusedData.price.toFixed(2) : '—'} {focusedData?.currency}/{focusedData?.unit}
            </span>
          </div>
          <span className="text-[10px] text-slate-500 font-mono">
            历史 {history?.count ?? 0} 点 · 保留 31 天
          </span>
        </div>
      </div>

      {/* Footer */}
      {data?.updatedAt && (
        <div className="text-[10px] text-slate-400 text-center pt-2 font-mono">
          最近更新: {new Date(data.updatedAt).toLocaleString('zh-CN', { hour12: false })}
        </div>
      )}
    </div>
  );
}

/**
 * 交易状态徽章
 *   - open    → 绿点 + 交易中（脉冲）
 *   - pre     → 琥珀点 + 即将开盘
 *   - closed  → 灰点 + 已收盘
 */
function MarketStatusBadge({ status }: { status: MarketStatus }) {
  const prefersReducedMotion = useReducedMotion();
  const { state, label, nextEvent } = status;

  const styleMap: Record<MarketStatus['state'], string> = {
    open:   'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200/70 dark:border-emerald-800/50',
    pre:    'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200/70 dark:border-amber-800/50',
    closed: 'bg-slate-100/70 dark:bg-white/5 text-slate-500 dark:text-slate-400 border-slate-200/70 dark:border-white/10',
  };
  const dotColor: Record<MarketStatus['state'], string> = {
    open:   'bg-emerald-500',
    pre:    'bg-amber-500',
    closed: 'bg-slate-400',
  };

  return (
    <span
      className={`mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full border ${styleMap[state]}`}
      title={nextEvent || label}
    >
      <motion.span
        className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor[state]}`}
        animate={state === 'open' && !prefersReducedMotion ? { opacity: [0.4, 1, 0.4] } : {}}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      />
      {label}
      {nextEvent && <span className="opacity-70 font-normal">· {nextEvent}</span>}
    </span>
  );
}
