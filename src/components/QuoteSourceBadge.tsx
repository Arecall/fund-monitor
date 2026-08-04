import type { FundValuation } from '../services/api';

export function quoteDisplayLabel(fund: FundValuation) {
  if (fund.navOnly) return '官方净值 · 非实时';
  if (!fund.proxyTicker) return null;
  if (fund.quoteFreshness === 'fresh') return `${fund.proxyTicker} · 实时`;
  if (fund.quoteFreshness === 'stale') return `${fund.proxyTicker} · 行情已滞后`;
  return `${fund.proxyTicker} · 上次报价`;
}

export function QuoteSourceBadge({ fund, compact = false }: { fund: FundValuation; compact?: boolean }) {
  const label = quoteDisplayLabel(fund);
  if (!label) return null;
  const stale = fund.quoteFreshness === 'stale' || fund.navOnly;
  const title = fund.navOnly
    ? `仅有官方净值${fund.officialNavDate ? `（${fund.officialNavDate}）` : ''}`
    : `${fund.quoteSourceName || `代理标的 ${fund.proxyTicker}`}；${fund.quoteTime ? `上游时间 ${fund.quoteTime}` : '上游时间未知'}；基于官方净值近似估算`;
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap shrink-0 rounded-full border font-medium ${compact ? 'px-1.5 py-px text-[9px]' : 'px-2 py-0.5 text-[10px]'} ${
        stale
          ? 'border-amber-200/70 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-400'
          : 'border-sky-200/70 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300'
      }`}
    >
      {label}
    </span>
  );
}
