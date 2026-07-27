import { useState, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import {
  ReceiptText,
  ArrowUpRight,
  ArrowDownRight,
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
  FundHoldingStock
} from '../services/api';
import { FundChart } from './FundChart';
import { RelativeTime, parseGzTime, MarketStatusBadge } from './RelativeTime';
import { AlertPanel } from './AlertPanel';

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
  onEditPosition?: () => void;
  onToast?: (msg: string) => void;
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
  onEditPosition,
  onToast
}: FundDetailPanelProps) {
  const prefersReducedMotion = useReducedMotion();
  const [chartKey, setChartKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const current = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
  const previous = parseFloat(fund.dwjz);
  const changeAmt = current - previous;
  const changePct = previous > 0 ? (changeAmt / previous) * 100 : 0;
  const isUp = changeAmt > 0;
  const isDown = changeAmt < 0;
  const dirColor = isUp ? 'text-[var(--color-up)]' : isDown ? 'text-[var(--color-down)]' : 'text-slate-500';
  const dirBg    = isUp ? 'bg-[var(--color-up-bg)]' : isDown ? 'bg-[var(--color-down-bg)]' : 'bg-slate-100 dark:bg-slate-800/50';

  /** Parse gztime once so the relative-time hook starts from the right anchor. */
  const gzTs = parseGzTime(fund.gztime);

  const holdingValue = position ? position.shares * current : 0;
  const holdingCost  = position ? position.shares * position.cost : 0;
  const holdingProfit = holdingValue - holdingCost;

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setChartKey(k => k + 1);        // force chart re-mount to redraw the line
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  return (
    <motion.div
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      transition={SPRING.panel}
      className="apple-card p-5 md:p-6 flex flex-col gap-5"
    >
      {/* ── Title row ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h3 className="apple-display-heading text-base font-semibold text-slate-900 dark:text-slate-50">
            {fund.name}
          </h3>
          <span className="font-mono text-[11px] text-slate-500 tabular-nums">{fund.fundcode}</span>
          {/* 基金显示风险等级；股票显示市场归属 */}
          {kind === 'fund' ? (
            <span className="text-[10px] bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full font-bold border border-blue-100/60 dark:border-blue-900/30">
              混合型-中高风险
            </span>
          ) : (
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
              fund.market === 'us'  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200/60 dark:border-blue-900/30'
            : fund.market === 'hk'  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200/60 dark:border-emerald-900/30'
            :                            'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200/60 dark:border-amber-900/30'
            }`}>
              {fund.market === 'us' ? '美股' : fund.market === 'hk' ? '港股' : 'A股'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <PressableButton
            onClick={() => onToast?.('交易记录功能开发中')}
            className="text-[11px] font-semibold bg-white/70 dark:bg-white/5 border border-[var(--hairline-border)] px-3 py-1.5 rounded-full flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-white/10"
          >
            <ReceiptText size={12} />
            交易记录
          </PressableButton>
        </div>
      </div>

      {/* ── Metric row — 5 cards ─────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
        <MetricCard label="当前净值" tone="neutral" title={current.toFixed(6)}>
          <span
            className="font-mono font-bold text-[1.4rem] tabular-nums text-slate-900 dark:text-slate-50 leading-none cursor-default"
          >
            {current.toFixed(4)}
          </span>
        </MetricCard>

        <MetricCard label="实时涨跌" tone={isUp ? 'up' : isDown ? 'down' : 'neutral'} highlight>
          <div className="flex items-center gap-1">
            {isUp ? <ArrowUpRight size={14} /> : isDown ? <ArrowDownRight size={14} /> : <span className="w-3.5" />}
            <span className="font-mono font-bold text-[1rem] tabular-nums">
              {changeAmt > 0 ? '+' : ''}{changeAmt.toFixed(4)}
            </span>
          </div>
          <span className="text-[9px] font-bold bg-red-50 dark:bg-red-950/40 text-[#ff453a] px-1.5 py-0.5 rounded mt-1 self-start">
            实时
          </span>
        </MetricCard>

        <MetricCard label="今日涨跌幅" tone={isUp ? 'up' : isDown ? 'down' : 'neutral'}>
          <span className="font-mono font-bold text-[1rem] tabular-nums">
            {changePct > 0 ? '+' : ''}{changePct.toFixed(2)}%
          </span>
        </MetricCard>

        <MetricCard label="更新时间" tone="neutral">
          <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-slate-200" style={{ fontSize: '1rem', letterSpacing: '0.01em' }}>
            {new Date(gzTs).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
          <span className="text-[10px] text-slate-400 mt-0.5">
            {new Date(gzTs).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
          </span>
        </MetricCard>

        <MetricCard
          label="持有金额"
          tone={position ? (holdingProfit > 0 ? 'up' : holdingProfit < 0 ? 'down' : 'neutral') : 'muted'}
          onClick={onEditPosition}
          className="col-span-2 sm:col-span-1"
        >
          {position ? (
            <>
              <span className="font-mono font-bold text-[1rem] tabular-nums">
                ¥{holdingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1">
                {position.shares}份 · @{position.cost.toFixed(4)} <Pencil size={9} />
              </span>
            </>
          ) : (
            <span className="text-xs text-slate-400">未持仓</span>
          )}
        </MetricCard>
      </div>

      {/* ── Real-time change banner ──────────────────────────── */}
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING.panel}
        className={`rounded-2xl border border-[var(--hairline-border)] p-4 flex items-center gap-3 flex-wrap ${dirBg}`}
      >
        <div className="flex items-center gap-2">
          <span className="apple-eyebrow text-slate-600 dark:text-slate-300">实时涨跌</span>
          <span className="text-[10px] bg-red-50 dark:bg-red-950/40 text-[#ff453a] px-1.5 py-0.5 rounded font-bold">
            实时
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className={`font-mono font-bold text-xl tabular-nums ${dirColor}`}>
            {changeAmt > 0 ? '+' : ''}{changeAmt.toFixed(4)}
          </span>
          <span className={`font-mono font-bold text-lg tabular-nums ${dirColor}`}>
            {changePct > 0 ? '+' : ''}{changePct.toFixed(2)}%
          </span>
        </div>
        <div className="hidden md:flex items-center gap-3 ml-auto text-[11px] text-slate-500">
          <span>最新净值 <span className="font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{current.toFixed(4)}</span></span>
          <MarketStatusBadge gzTs={gzTs} fundName={fund.name} fundCode={fund.fundcode} />
        </div>
        <div className="text-[10px] text-slate-400 w-full md:w-auto flex items-center gap-1.5">
          <RelativeTime timestamp={gzTs} prefix="最近更新 " />
          <span className="opacity-50">·</span>
          <span className="font-mono">{new Date(gzTs).toLocaleTimeString('zh-CN', { hour12: false })}</span>
        </div>
      </motion.div>

      {/* ── Chart card ───────────────────────────────────────── */}
      <section className="rounded-2xl border border-[var(--hairline-border)] bg-white/40 dark:bg-white/[0.02] p-4">
        <FundChart
          key={`${chartKey}-${(fund as any).dataDate || fund.gztime?.split(' ')[0] || ''}`}
          fundCode={fund.fundcode}
          fundName={fund.name}
          kind={kind}
          current={current}
          previous={previous}
          openPrice={(fund.open ? parseFloat(fund.open) : undefined) ?? (() => {
            const ssOpen = (fund as any).stockSpecific?.open;
            return typeof ssOpen === 'number' && ssOpen > 0 ? ssOpen : undefined;
          })()}
          highPrice={(() => {
            const v = (fund as any).stockSpecific?.high;
            return typeof v === 'number' && v > 0 ? v : undefined;
          })()}
          lowPrice={(() => {
            const v = (fund as any).stockSpecific?.low;
            return typeof v === 'number' && v > 0 ? v : undefined;
          })()}
          height={300}
          history={history}
          historyLoading={historyLoading}
          refreshing={refreshing}
          onRefresh={handleRefresh}
        />
      </section>

      {/* ── Footer two-column: intro + holdings summary (仅基金) ── */}
      {kind === 'fund' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FundIntroCard basic={basic} />
          <HoldingsSummaryCard basic={basic} holdings={holdings} />
        </div>
      )}

      {/* ── Alert panel (price notifications) ─────────────────── */}
      <AlertPanel
        fundCode={fund.fundcode}
        fundName={fund.name}
        onToast={onToast}
      />
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
        <div className="grid grid-cols-2 gap-3">
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
                <table className="w-full text-left text-[11px]">
                  <thead>
                    <tr className="text-slate-400 dark:text-slate-500 border-b border-[var(--hairline-border)]">
                      <th className="font-semibold px-3 py-2 w-8">#</th>
                      <th className="font-semibold px-3 py-2">名称</th>
                      <th className="font-semibold px-3 py-2 text-right">现价</th>
                      <th className="font-semibold px-3 py-2 text-right pr-4">当日</th>
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
                          <td className="px-3 py-1.5 text-slate-400 font-mono tabular-nums">{i + 1}</td>
                          <td className="px-3 py-1.5">
                            <div className="font-semibold text-slate-700 dark:text-slate-200 truncate max-w-[140px]" title={s.name}>
                              {s.name}
                            </div>
                            <div className="text-[9px] text-slate-400 font-mono">{s.displayCode}</div>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono font-semibold text-slate-700 dark:text-slate-200 tabular-nums">
                            {s.price !== null ? s.price.toFixed(s.price > 100 ? 2 : (s.exchange === 'HK' ? 1 : 2)) : '—'}
                          </td>
                          <td className={`px-3 py-1.5 text-right pr-4 font-mono font-semibold tabular-nums ${color}`}>
                            {s.changePct !== null
                              ? `${isUp ? '+' : ''}${pct.toFixed(2)}%`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div className="px-4 py-2 text-[10px] text-slate-400 border-t border-[var(--hairline-border)] flex items-center justify-between">
                <span>实时行情 · 新浪财经</span>
                <span>单股占比数据免费 API 暂不可用</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */

function MetricCard({
  label,
  tone,
  highlight,
  onClick,
  title,
  className = '',
  children
}: {
  label: string;
  tone: 'up' | 'down' | 'neutral' | 'muted';
  highlight?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const isUp = tone === 'up';
  const isDown = tone === 'down';
  const isMuted = tone === 'muted';

  const toneStyles = isUp
    ? 'border-[rgba(255,69,58,0.18)]'
    : isDown
      ? 'border-[rgba(48,209,88,0.18)]'
      : 'border-[var(--hairline-border)]';

  const textColor = isUp
    ? 'text-[var(--color-up)]'
    : isDown
      ? 'text-[var(--color-down)]'
      : isMuted ? 'text-slate-400' : 'text-slate-900 dark:text-slate-50';

  const content = (
    <div title={title} className={`flex flex-col gap-1.5 p-3 min-h-[88px] rounded-2xl border ${toneStyles} ${highlight ? (isUp ? 'bg-[var(--color-up-bg)]' : isDown ? 'bg-[var(--color-down-bg)]' : 'bg-slate-50 dark:bg-white/5') : 'bg-white/40 dark:bg-white/[0.02]'} ${onClick ? 'cursor-pointer hover:bg-white/70 dark:hover:bg-white/[0.05] transition-colors' : ''} ${className}`}>
      <div className={`text-[10px] font-bold ${isMuted ? 'text-slate-400' : 'text-slate-500'} uppercase tracking-wider truncate`}>
        {label}
      </div>
      <div className={`flex flex-col min-w-0 ${textColor}`}>
        {children}
      </div>
    </div>
  );

  if (onClick) {
    return (
      <PressableButton
        onClick={onClick}
        className={`text-left ${className}`}
      >
        {content}
      </PressableButton>
    );
  }
  return content;
}

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
