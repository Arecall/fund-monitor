/**
 * 数值格式化工具（成交量 / 成交额 / 市值 / 百分比 等）
 *
 * 注意：
 * - A 股 Sina parts[8] 返回的是"股"，但中文 UI 习惯按"手"展示（1 手 = 100 股），
 *   因此 A 股显示前要 /100。
 * - 港股 / 美股 Sina 字段单位即"股"，直接按股展示。
 */

/**
 * 成交量格式化
 * @param v 原始股数（A 股未除 100）
 * @param market 'domestic' | 'hk' | 'us' | 'other'
 */
export function formatVolume(v: number, market?: string): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  let display = v;
  let unit: string;
  if (market === 'hk' || market === 'us') {
    unit = '股';
  } else {
    // A 股 / 基金：除 100 转"手"
    display = v / 100;
    unit = '手';
  }
  if (display >= 1e8) return `${(display / 1e8).toFixed(2)}亿${unit}`;
  if (display >= 1e4) return `${(display / 1e4).toFixed(2)}万${unit}`;
  return `${display.toFixed(0)}${unit}`;
}

/**
 * 成交额格式化（单位：元）
 */
export function formatTurnover(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿元`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万元`;
  return `${v.toFixed(0)}元`;
}

/**
 * 市值格式化（使用货币符号：USD $ / HKD HK$ / RMB ¥）
 * @param market 'domestic' | 'hk' | 'us'
 */
export function formatMarketCap(v: number, market?: string): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  const prefix = market === 'us' ? '$' : market === 'hk' ? 'HK$' : '¥';
  if (v >= 1e12) return `${prefix}${(v / 1e12).toFixed(2)}万亿`;
  if (v >= 1e8)  return `${prefix}${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4)  return `${prefix}${(v / 1e4).toFixed(2)}万`;
  return `${prefix}${v.toFixed(0)}`;
}

/**
 * 百分比格式化（接受小数或百分数）
 */
export function formatPercent(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`;
}