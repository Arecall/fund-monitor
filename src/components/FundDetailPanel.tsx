import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { Card, Tag, Button, Badge, BorderBeam, Statistic, Row, Col, Divider, Spin } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import { motion, AnimatePresence, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import {
  ReceiptText,
  Pencil,
  ChevronDown,
  Star,
  User,
  TrendingUp,
  TrendingDown,
  Briefcase,
  Maximize2,
  Minimize2
} from 'lucide-react';
import type {
  FundValuation,
  UserPosition,
  FundHistoryPoint,
  FundBasicInfo,
  FundHoldingStock
} from '../services/api';
import { fetchStockMinute } from '../services/api';
const FundChart = lazy(() => import('./FundChart').then(m => ({ default: m.FundChart })));
const AlertPanel = lazy(() => import('./AlertPanel').then(m => ({ default: m.AlertPanel })));

import { RelativeTime, parseGzTime, MarketStatusBadge } from './RelativeTime';
import { QuoteSourceBadge } from './QuoteSourceBadge';
import { detectFundMarket, isMarketOpen, type FundMarket } from '../utils/fundMarket';
import { formatMarketCap } from '../utils/format';
import type { MinuteFeed } from '../utils/chartData';

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
  isExpanded?: boolean;
  onToggleExpand?: () => void;
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
  isExpanded = false,
  onToggleExpand,
  onEditPosition,
  onToast
}: FundDetailPanelProps) {
  const prefersReducedMotion = useReducedMotion();
  const [chartKey, setChartKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // 真实分钟级数据/系统采样轨迹点（股票来自 Sina/腾讯，基金/无 K 线品种来自后端 quote_snapshots 快照）
  const [minuteData, setMinuteData] = useState<MinuteFeed | null>(null);
  const [minuteLoading, setMinuteLoading] = useState(true);
  const minuteSigRef = useRef<string>('');

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
    const loadMinuteData = async () => {
      try {
        const res = await fetchStockMinute(fund.fundcode, kind, fund.market);
        if (cancelled) return;
        if (res?.data && res.data.length > 0) {
          const bars = res.data.map(d => ({
            t: Date.parse(d.time.replace(' ', 'T') + '+08:00'),
            v: d.close,
            volume: d.volume,
            turnover: d.amount,
          })).filter(b => Number.isFinite(b.t));
          // 数据去重：柱数 + 最后一根 K 线时间与收盘价均未变化则跳过 setState，避免每 10s 无意义重绘。
          const last = bars[bars.length - 1];
          const sig = `${bars.length}|${last?.t}|${last?.v}`;
          if (sig !== minuteSigRef.current) {
            minuteSigRef.current = sig;
            setMinuteData({ bars });
          }
        } else {
          minuteSigRef.current = '';
          setMinuteData(null);
        }
      } catch {
        // error
      } finally {
        if (!cancelled) setMinuteLoading(false);
      }
    };
    loadMinuteData();
    const timer = setInterval(loadMinuteData, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [fund.fundcode, fund.market, kind, chartKey]);

  const current = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
  const previous = parseFloat(fund.dwjz);
  const changeAmt = current - previous;
  const changePct = previous > 0 ? (changeAmt / previous) * 100 : 0;
  const isUp = changeAmt > 0;
  const isDown = changeAmt < 0;
  const dirColor = isUp ? 'text-[var(--color-up)]' : isDown ? 'text-[var(--color-down)]' : 'text-slate-500';
  const currencyPrefix = fund.market === 'us' ? '$' : fund.market === 'hk' ? 'HK$' : '¥';

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
          {onToggleExpand && (
            <Button
              type="default"
              size="small"
              shape="round"
              icon={isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              onClick={onToggleExpand}
              className="hidden md:flex items-center text-xs border-[var(--hairline-border)] shadow-none"
            >
              {isExpanded ? '收起弹窗' : '全屏展开'}
            </Button>
          )}
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

      {/* ── Financial Terminal Metric Banner ──────────────────────────── */}
      <Card
        size="small"
        className="rounded-2xl border border-[var(--hairline-border)] shadow-sm bg-slate-50/50 dark:bg-white/[0.03] overflow-hidden"
        styles={{
          body: { padding: '16px 20px' }
        }}
      >
        <Row gutter={[16, 16]}>
          <Col span={6} xs={12} sm={6}>
            <Statistic
              title={<span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">当前净值</span>}
              value={current}
              precision={4}
              valueStyle={{
                color: 'var(--color-text-main, inherit)',
                fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontWeight: 700,
                fontSize: '1.25rem'
              }}
            />
          </Col>

          <Col span={6} xs={12} sm={6}>
            <Statistic
              title={<span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">实时涨跌</span>}
              value={Math.abs(changeAmt)}
              precision={4}
              prefix={isUp ? <ArrowUpOutlined style={{ fontSize: 16 }} /> : isDown ? <ArrowDownOutlined style={{ fontSize: 16 }} /> : null}
              valueStyle={{
                color: isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : 'inherit',
                fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontWeight: 700,
                fontSize: '1.25rem'
              }}
            />
          </Col>

          <Col span={6} xs={12} sm={6}>
            <Statistic
              title={<span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">今日涨跌幅</span>}
              value={Math.abs(changePct)}
              precision={2}
              prefix={isUp ? <ArrowUpOutlined style={{ fontSize: 16 }} /> : isDown ? <ArrowDownOutlined style={{ fontSize: 16 }} /> : null}
              suffix="%"
              valueStyle={{
                color: isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : 'inherit',
                fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontWeight: 700,
                fontSize: '1.25rem'
              }}
            />
          </Col>

          <Col span={6} xs={12} sm={6}>
            <Statistic
              title={<span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">昨收</span>}
              value={previous > 0 ? previous : 0}
              precision={4}
              valueStyle={{
                color: 'var(--color-text-main, inherit)',
                fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontWeight: 700,
                fontSize: '1.25rem'
              }}
            />
            {fund.jzrq && <div className="text-[10px] text-slate-400 font-mono mt-0.5">{fund.jzrq}</div>}
          </Col>
        </Row>

        <Divider className="my-3 border-slate-200/60 dark:border-white/10" />

        <Row gutter={[16, 16]}>
          <Col span={6} xs={12} sm={6}>
            <div className="flex flex-col justify-between h-full">
              <span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">更新时间</span>
              <div className="mt-1">
                <div className="text-base sm:text-lg font-bold font-sans text-slate-800 dark:text-slate-100 leading-tight">
                  {new Date(gzTs).toLocaleTimeString('zh-CN', { hour12: false })}
                </div>
                <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                  {new Date(gzTs).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                </div>
              </div>
            </div>
          </Col>

          <Col span={6} xs={12} sm={6}>
            {kind === 'stock' && (fund as any).stockSpecific?.totalMarketCap ? (
              <Statistic
                title={<span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">总市值</span>}
                value={formatMarketCap((fund as any).stockSpecific.totalMarketCap, fund.market)}
                valueStyle={{
                  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  fontWeight: 700,
                  fontSize: '1.125rem'
                }}
              />
            ) : basic?.scale?.size != null ? (
              <Statistic
                title={<span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">当前规模</span>}
                value={basic.scale.size}
                precision={2}
                suffix="亿"
                valueStyle={{
                  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  fontWeight: 700,
                  fontSize: '1.125rem'
                }}
              />
            ) : (
              <div className="flex flex-col justify-between h-full">
                <span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">当前规模</span>
                <div className="text-sm text-slate-400 font-medium mt-1">—</div>
              </div>
            )}
          </Col>

          <Col span={6} xs={12} sm={6}>
            <div className="flex flex-col justify-between h-full cursor-pointer group" onClick={onEditPosition}>
              <span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider flex items-center justify-between">
                持有金额 <Pencil size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </span>
              <div className="mt-1">
                {position ? (
                  <>
                    <div className="text-base sm:text-lg font-bold font-sans text-slate-800 dark:text-slate-100 leading-tight">
                      {currencyPrefix}{holdingValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                      {parseFloat(position.shares.toFixed(4))}份 · @{position.cost.toFixed(4)}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-slate-400 font-medium">未持仓</div>
                )}
              </div>
            </div>
          </Col>

          <Col span={6} xs={12} sm={6}>
            {position ? (
              <Statistic
                title={<span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">估算收益</span>}
                value={Math.abs(holdingProfit)}
                precision={2}
                prefix={holdingProfit > 0 ? '+' : holdingProfit < 0 ? '-' : ''}
                suffix={`${currencyPrefix} (${holdingProfitPct >= 0 ? '+' : ''}${holdingProfitPct.toFixed(2)}%)`}
                valueStyle={{
                  color: holdingProfit > 0 ? 'var(--color-up)' : holdingProfit < 0 ? 'var(--color-down)' : 'inherit',
                  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  fontWeight: 700,
                  fontSize: '1.125rem'
                }}
              />
            ) : kind === 'stock' && (fund as any).stockSpecific?.turnoverRate != null ? (
              <Statistic
                title={<span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">换手率</span>}
                value={(fund as any).stockSpecific.turnoverRate}
                precision={2}
                suffix="%"
                valueStyle={{
                  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  fontWeight: 700,
                  fontSize: '1.125rem'
                }}
              />
            ) : (
              <div className="flex flex-col justify-between h-full">
                <span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 uppercase tracking-wider">持仓收益</span>
                <div className="text-sm text-slate-400 font-medium mt-1">—</div>
              </div>
            )}
          </Col>
        </Row>
      </Card>

      {/* ── Real-time change banner ──────────────────────────── */}
      {(() => {
        const bannerCard = (
          <Card
            size="small"
            className="rounded-2xl border border-[var(--hairline-border)] shadow-sm bg-white/80 dark:bg-[#1c1c1e]/80 backdrop-blur-2xl"
            styles={{
              body: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }
            }}
          >
            {/* 上层：主标与实时涨跌数值 */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  <Badge status={fund.navOnly || fund.quoteFreshness === 'stale' ? 'warning' : 'processing'} />
                  {fund.navOnly ? '官方净值' : fund.quoteFreshness === 'stale' ? '延迟行情' : '实时行情'}
                </span>
                <MarketStatusBadge gzTs={gzTs} fundName={fund.name} fundCode={fund.fundcode} market={fund.market} className="text-xs" />
                <QuoteSourceBadge fund={fund} />
              </div>

              <div className="flex items-baseline gap-3">
                <span className={`font-mono font-bold text-2xl tabular-nums ${dirColor}`}>
                  {changeAmt > 0 ? '+' : ''}{changeAmt.toFixed(4)}
                </span>
                <span className={`font-mono font-bold text-lg tabular-nums ${dirColor}`}>
                  {changePct > 0 ? '+' : ''}{changePct.toFixed(2)}%
                </span>
              </div>
            </div>

            {/* 下层：元数据对齐栏 */}
            <div className="pt-2.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span>{fund.navOnly ? '官方净值' : fund.proxyTicker ? '代理估值' : '最新净值'}</span>
                <span className="font-mono font-bold text-slate-800 dark:text-slate-100 tabular-nums">
                  {currencyPrefix}{current.toFixed(4)}
                </span>
                {fund.officialNavDate && <span className="text-[10px] text-slate-400">基准净值 {fund.officialNavDate}</span>}
              </div>

              <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                <RelativeTime timestamp={gzTs} prefix="最近更新 " />
                <span className="opacity-40">·</span>
                <span>{new Date(gzTs).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span>
                {fund.quoteTime && <><span className="opacity-40">·</span><span title="上游行情时间">上游 {fund.quoteTime}</span></>}
              </div>
            </div>
          </Card>
        );

        return isTrading ? <BorderBeam>{bannerCard}</BorderBeam> : bannerCard;
      })()}

      {/* ── Chart card ───────────────────────────────────────── */}
      <section className="rounded-2xl border border-[var(--hairline-border)] bg-white/40 dark:bg-white/[0.02] p-4">
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
          totalVolume={(() => {
            const v = (fund as any).stockSpecific?.volume;
            return typeof v === 'number' && v > 0 ? v : undefined;
          })()}
          totalTurnover={(() => {
            const v = (fund as any).stockSpecific?.turnover;
            return typeof v === 'number' && v > 0 ? v : undefined;
          })()}
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

      {/* ── Capital flow bar chart (仅 A 股个股) ── */}
      {kind === 'stock' && (fund as any).stockSpecific?.flow && (
        <CapitalFlowChart flow={(fund as any).stockSpecific.flow} />
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
          onToast={onToast}
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
