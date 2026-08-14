import { Tag } from 'antd';
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
    <Tag
      title={title}
      color={stale ? 'warning' : 'processing'}
      className={`border-0 rounded-full font-medium font-sans m-0 ${compact ? 'text-[9px] px-1.5 py-0' : 'text-[10px] px-2 py-0.5'}`}
    >
      {label}
    </Tag>
  );
}
