import { useEffect, useState } from 'react';
import { motion } from 'motion/react';

/**
 * Returns a live "X 秒前" / "X 分钟前" string relative to a given timestamp.
 * Updates every second so the value always reflects the most recent time.
 */
export function RelativeTime({
  timestamp,
  prefix = '更新于 ',
  suffix = '',
  className = ''
}: {
  /** Unix ms */
  timestamp: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    // Tick once a second for the "X 秒前" granularity. We're cheap; the
    // panel is mounted at most one at a time, so this is fine.
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));

  let text: string;
  if (diffSec < 5) text = '刚刚';
  else if (diffSec < 60) text = `${diffSec} 秒前`;
  else if (diffSec < 3600) text = `${Math.floor(diffSec / 60)} 分钟前`;
  else if (diffSec < 86400) text = `${Math.floor(diffSec / 3600)} 小时前`;
  else text = `${Math.floor(diffSec / 86400)} 天前`;

  return (
    <motion.span
      // Subtle pulse on every new minute so the user can tell it's live
      // without it being distracting.
      key={Math.floor(diffSec / 60)}
      initial={{ opacity: 0.7 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className={className}
    >
      {prefix}{text}{suffix}
    </motion.span>
  );
}

/**
 * Parses the gztime field returned by fundgz.1234567.com.cn, which is
 * formatted as "YYYY-MM-DD HH:MM". Returns Unix ms in local time.
 *
 * If the field is missing or malformed, returns Date.now() as a fallback
 * (better than NaN) and the UI will show "刚刚".
 */
export function parseGzTime(s: string | undefined): number {
  if (!s) return Date.now();
  // Replace the space with T to make it ISO-ish for Date parsing.
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : Date.now();
}

/* ───────────────────────────────────────────────────────────────────
   Market status — derived from gztime freshness + current clock.
   按基金市场类型应用对应交易时段：
     - A 股 (沪深场内/场外)：09:30–11:30, 13:00–15:00
     - 港股 (HK)：09:30–12:00, 13:00–16:00
     - 美股 (US, QDII 主要跟踪)：21:30–04:00 次日（夏令）/ 22:30–05:00 次日（冬令）
   ─────────────────────────────────────────────────────────────────── */

import { detectFundMarket, type FundMarket } from '../utils/fundMarket';
export type { FundMarket } from '../utils/fundMarket';

/** 分钟数（自 00:00）→ "HH:MM" */
function minToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 简化的美股夏令时判断：3-10 月视为夏令时 */
function isUSDST(d: Date): boolean {
  const m = d.getMonth() + 1;
  return m >= 3 && m <= 10;
}

export type MarketStatusKey =
  | 'live'
  | 'lunch'
  | 'closed'
  | 'preopen'
  | 'settling'
  | 'offday';

export interface MarketStatus {
  key: MarketStatusKey;
  label: string;
  color: string;
  pulse: boolean;
  detail?: string;
}

interface SessionWindows {
  preopen: [number, number];
  morning: [number, number] | null;
  lunch: [number, number] | null;
  afternoon: [number, number];
  close: number;
}

function getSessionWindows(market: FundMarket, d: Date): SessionWindows {
  if (market === 'domestic') {
    return {
      preopen: [9 * 60, 9 * 60 + 30],
      morning: [9 * 60 + 30, 11 * 60 + 30],
      lunch: [11 * 60 + 30, 13 * 60],
      afternoon: [13 * 60, 15 * 60],
      close: 15 * 60
    };
  }
  if (market === 'hk') {
    return {
      preopen: [9 * 60, 9 * 60 + 30],
      morning: [9 * 60 + 30, 12 * 60],
      lunch: [12 * 60, 13 * 60],
      afternoon: [13 * 60, 16 * 60],
      close: 16 * 60
    };
  }
  if (market === 'us') {
    const dst = isUSDST(d);
    if (dst) {
      // 夏令时：21:30 → 次日 04:00
      return {
        preopen: [21 * 60, 21 * 60 + 30],
        morning: [21 * 60 + 30, 24 * 60],
        lunch:  null,
        afternoon: [0, 4 * 60],
        close: 4 * 60
      };
    }
    // 冬令时：22:30 → 次日 05:00
    return {
      preopen: [22 * 60, 22 * 60 + 30],
      morning: [22 * 60 + 30, 24 * 60],
      lunch:  null,
      afternoon: [0, 5 * 60],
      close: 5 * 60
    };
  }
  return {
    preopen: [0, 0],
    morning: [0, 24 * 60],
    lunch: null,
    afternoon: [0, 0],
    close: 24 * 60
  };
}

export function deriveMarketStatus(
  gzTs: number,
  now: number = Date.now(),
  market: FundMarket = 'domestic'
): MarketStatus {
  const d = new Date(now);
  const day = d.getDay();
  const isWeekend = day === 0 || day === 6;
  const min = d.getHours() * 60 + d.getMinutes();

  // 周末
  if (isWeekend) {
    if (market === 'us' && day === 6 && min < 5 * 60) {
      // 周六凌晨美股（延续自周五晚）仍在交易，按 isUSDST 决定 close
      const closeMin = isUSDST(d) ? 4 * 60 : 5 * 60;
      if (min < closeMin) {
        return { key: 'live', label: '美股盘中', color: 'text-[var(--color-up)]', pulse: true,
          detail: '美股交易延续到周六凌晨' };
      }
    }
    return {
      key: 'offday',
      label: market === 'us' ? '美股休市' : market === 'hk' ? '港股休市' : '休市',
      color: 'text-slate-500',
      pulse: false,
      detail: market === 'us' ? '美股周末休市（北京时间周六日）'
            : market === 'hk' ? '港股周末休市'
            : 'A 股周末休市'
    };
  }

  const win = getSessionWindows(market, d);
  const inWindow = (w: [number, number] | null) => w && min >= w[0] && min < w[1];

  // 上午盘
  if (inWindow(win.morning)) {
    return {
      key: 'live',
      label: market === 'us' ? '美股盘中' : market === 'hk' ? '港股盘中' : '盘中估算',
      color: 'text-[var(--color-up)]',
      pulse: true,
      detail: `估值随底层股票实时跳动（${minToHHMM(win.close)} 收盘）`
    };
  }
  // 下午盘
  if (inWindow(win.afternoon)) {
    return {
      key: 'live',
      label: market === 'us' ? '美股盘中' : market === 'hk' ? '港股盘中' : '盘中估算',
      color: 'text-[var(--color-up)]',
      pulse: true,
      detail: `估值随底层股票实时跳动（${minToHHMM(win.close)} 收盘）`
    };
  }
  // 盘前
  if (inWindow(win.preopen)) {
    return {
      key: 'preopen',
      label: '盘前',
      color: 'text-slate-500',
      pulse: false,
      detail: market === 'us' ? '美股盘前交易' : '集合竞价中'
    };
  }
  // 午休（仅 A 股 / 港股有）
  if (inWindow(win.lunch)) {
    return {
      key: 'lunch',
      label: '午休',
      color: 'text-slate-500',
      pulse: false,
      detail: market === 'hk' ? '港股 12:00–13:00 午间休市' : '11:30–13:00 午间休市'
    };
  }

  // A 股 15:00–20:00 净值锁定（特有）
  if (market === 'domestic' && min >= 15 * 60 && min < 20 * 60) {
    return {
      key: 'settling',
      label: '已锁定 15:00 估值',
      color: 'text-amber-600 dark:text-amber-400',
      pulse: false,
      detail: '基金公司将在 20:00 后陆续公布当日真实净值'
    };
  }

  // 数据陈旧
  if ((now - gzTs) > 24 * 60 * 60 * 1000) {
    return {
      key: 'offday',
      label: '暂无更新',
      color: 'text-slate-400',
      pulse: false,
      detail: '上次更新已超过 24 小时'
    };
  }

  return {
    key: 'closed',
    label: market === 'us' ? '美股已收盘' : market === 'hk' ? '港股已收盘' : '已收盘',
    color: 'text-slate-500',
    pulse: false,
    detail: market === 'us'
      ? `美股于北京时间 ${isUSDST(d) ? '04:00' : '05:00'} 收盘`
      : market === 'hk'
        ? '港股 16:00 收盘'
        : 'A 股 15:00 收盘'
  };
}

/**
 * Live market status badge — pulses when the data is being live-estimated.
 */
export function MarketStatusBadge({
  gzTs,
  fundName,
  fundCode,
  className = ''
}: {
  gzTs: number;
  fundName?: string;
  fundCode?: string;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);     // 30s tick 足够
    return () => clearInterval(id);
  }, []);

  const market = detectFundMarket(fundName, fundCode);
  const status = deriveMarketStatus(gzTs, now, market);

  return (
    <span
      className={`inline-flex items-center gap-1 font-semibold ${status.color} ${className}`}
      title={status.detail}
    >
      {status.pulse ? (
        <motion.span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: 'currentColor' }}
          animate={{ opacity: [0.3, 1, 0.3], scale: [0.85, 1.1, 0.85] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        />
      ) : (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: 'currentColor', opacity: 0.6 }}
        />
      )}
      {status.label}
    </span>
  );
}
