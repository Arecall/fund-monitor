import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Loader2, RefreshCw } from 'lucide-react';
import { fetchSectorBreakdown, type SectorGroup } from '../services/api';

interface SectorViewProps {
  data: Awaited<ReturnType<typeof fetchSectorBreakdown>> | null;
  onRefresh: () => Promise<void>;
}

/**
 * SectorView — 按行业板块聚合用户持仓
 *   - 顶部：板块分布条形图（按市值权重）
 *   - 每个板块卡片：该板块下的所有 items + 板块合计（数量/市值/盈亏/今日盈亏）
 */
export function SectorView({ data, onRefresh }: SectorViewProps) {
  const [loading, setLoading] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const [local, setLocal] = useState(data);

  useEffect(() => { setLocal(data); }, [data]);

  const refresh = async () => {
    setLoading(true);
    try { await onRefresh(); }
    finally { setLoading(false); }
  };

  if (!local || !local.groups) {
    return (
      <div className="flex-1 flex items-center justify-center p-12 text-center">
        <div>
          <Loader2 className="inline-block w-5 h-5 animate-spin text-slate-400 mb-2" />
          <div className="text-[11px] text-slate-500">加载板块分布中...</div>
        </div>
      </div>
    );
  }

  const groups = local.groups;
  const totalValue = local.totalValue || 0;

  if (groups.length === 0 || totalValue === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-12 text-center">
        <div>
          <div className="text-2xl mb-2">📊</div>
          <div className="text-sm text-slate-600 dark:text-slate-300 font-semibold mb-1">暂无板块数据</div>
          <div className="text-[11px] text-slate-500 max-w-xs mx-auto">
            添加自选（基金或股票）后，板块视图会自动按行业归类。
            只有持仓（不是仅自选）才会计入板块市值。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {/* 顶部：总览 + 刷新 */}
      <div className="flex items-center justify-between px-2 py-1">
        <div className="text-[11px] text-slate-500">
          共 <span className="font-mono font-bold text-slate-700 dark:text-slate-200">{groups.length}</span> 个板块 · 总市值
          <span className="font-mono font-bold text-slate-700 dark:text-slate-200 ml-1">
            ¥ {totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-[10px] font-bold bg-white/70 dark:bg-white/5 border border-[var(--hairline-border)] px-2.5 py-1 rounded-full flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-white/10 disabled:opacity-50"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      {/* 板块分布条 */}
      <div className="px-2">
        <div className="flex h-2 rounded-full overflow-hidden bg-slate-100 dark:bg-white/5">
          {groups.map((g, i) => (
            <motion.div
              key={g.sector}
              initial={prefersReducedMotion ? false : { width: 0 }}
              animate={{ width: `${g.weight}%` }}
              transition={{ type: 'spring', bounce: 0, duration: 0.5, delay: i * 0.04 }}
              title={`${g.sector} ${g.weight.toFixed(1)}%`}
              style={{ background: local.colors?.[g.sector] || '#86868b' }}
              className="h-full"
            />
          ))}
        </div>
      </div>

      {/* 板块卡片列表 */}
      <div className="space-y-2">
        {groups.map((g, i) => (
          <SectorCard key={g.sector} group={g} color={local.colors?.[g.sector] || '#86868b'} index={i} />
        ))}
      </div>
    </div>
  );
}

function SectorCard({ group, color, index }: { group: SectorGroup; color: string; index: number }) {
  const prefersReducedMotion = useReducedMotion();
  const totalProfit = group.totalValue - group.totalCost;
  const totalProfitPct = group.totalCost > 0 ? (totalProfit / group.totalCost) * 100 : 0;
  const todayPct = group.totalValue > 0 ? (group.totalTodayProfit / group.totalValue) * 100 : 0;
  const isUp = totalProfit > 0;
  const isTodayUp = group.totalTodayProfit > 0;

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', bounce: 0, duration: 0.32, delay: index * 0.04 }}
      className="rounded-2xl border border-[var(--hairline-border)] bg-white/40 dark:bg-white/[0.02] overflow-hidden"
    >
      {/* 板块 header */}
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div
            className="w-2.5 h-2.5 rounded-full"
            style={{ background: color }}
          />
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {group.sector}
          </div>
          <span className="text-[10px] text-slate-400 bg-slate-100/60 dark:bg-white/5 px-1.5 py-0.5 rounded-full">
            {group.items.length} 只
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            {group.weight.toFixed(1)}%
          </span>
        </div>
        <div className="text-right">
          <div className="font-mono font-bold text-sm text-slate-800 dark:text-slate-100 tabular-nums">
            ¥ {group.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </div>
          <div className={`text-[10px] font-mono tabular-nums ${
            isUp ? 'text-[var(--color-up)]' : isTodayUp === false ? 'text-[var(--color-down)]' : 'text-slate-400'
          }`}>
            {totalProfit > 0 ? '+' : ''}{totalProfit.toFixed(0)} ({totalProfitPct > 0 ? '+' : ''}{totalProfitPct.toFixed(2)}%)
            {' · '}
            今日 {group.totalTodayProfit > 0 ? '+' : ''}{group.totalTodayProfit.toFixed(0)} ({todayPct > 0 ? '+' : ''}{todayPct.toFixed(2)}%)
          </div>
        </div>
      </div>

      {/* 板块下 item 列表 */}
      <div className="border-t border-[var(--hairline-border)] divide-y divide-slate-100 dark:divide-slate-800/50">
        {group.items.map((it) => (
          <div
            key={it.code}
            className="flex items-center justify-between px-4 py-1.5 hover:bg-slate-50/40 dark:hover:bg-white/[0.02] transition-colors text-xs"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold flex-shrink-0 ${
                it.kind === 'stock' ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
              }`}>
                {it.kind === 'stock' ? '股' : '基'}
              </span>
              <span className="font-mono text-slate-500 tabular-nums w-14 flex-shrink-0">{it.code}</span>
              <span className="truncate text-slate-700 dark:text-slate-200 font-medium" title={it.name}>
                {it.name}
              </span>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              {it.value > 0 ? (
                <span className={`font-mono font-semibold tabular-nums ${
                  it.changePct > 0 ? 'text-[var(--color-up)]'
                    : it.changePct < 0 ? 'text-[var(--color-down)]'
                    : 'text-slate-500'
                }`}>
                  {it.changePct > 0 ? '+' : ''}{it.changePct.toFixed(2)}%
                </span>
              ) : (
                <span className="text-[10px] text-slate-400">仅自选</span>
              )}
              {it.value > 0 && (
                <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
                  ¥ {it.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
