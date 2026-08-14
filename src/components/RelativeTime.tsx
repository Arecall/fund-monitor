import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { isUsEasternDst, parseGzTime } from '../utils/time';

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
  if (diffSec < 3) text = '刚刚';
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

// Backward-compatible re-export for existing callers. gztime is always a Beijing wall-clock time.
export { parseGzTime };

/* ───────────────────────────────────────────────────────────────────
   Market status — derived from gztime freshness + current clock.
   按基金市场类型应用对应交易时段：
     - A 股 (沪深场内/场外)：09:30–11:30, 13:00–15:00
     - 港股 (HK)：09:30–12:00, 13:00–16:00
     - 美股 (US, QDII 主要跟踪)：21:30–04:00 次日（夏令）/ 22:30–05:00 次日（冬令）
   ─────────────────────────────────────────────────────────────────── */

import { detectFundMarket, getNextOpenTime, type FundMarket } from '../utils/fundMarket';
export type { FundMarket } from '../utils/fundMarket';

/**
 * 实时开盘倒计时组件
 * 区分目标开盘时间 (如 09:30) 与剩余倒计时 (如 06:59)，消除阅读混淆
 */
export function OpenCountdown({
  market = 'domestic',
  showTargetTime = true,
  rawCountdown = false,
  prefix = '',
  className = ''
}: {
  market?: FundMarket;
  showTargetTime?: boolean;
  rawCountdown?: boolean;
  prefix?: string;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const nextOpen = getNextOpenTime(market, new Date(now));
  const diffMs = Math.max(0, nextOpen.getTime() - now);

  const totalSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  let countdownStr = '';
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const leftHours = hours % 24;
    countdownStr = `${days}天${leftHours}小时`;
  } else if (hours > 0) {
    countdownStr = `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  } else {
    // 隐藏开头的 0：例如 2:56 而非 02:56
    countdownStr = `${mins}:${String(secs).padStart(2, '0')}`;
  }

  const targetParts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(nextOpen);
  const targetMap = Object.fromEntries(targetParts.map(p => [p.type, p.value]));
  const targetTimeLabel = `${targetMap.hour}:${targetMap.minute}`;

  if (rawCountdown) {
    return <span className={`font-mono ${className}`}>{countdownStr}</span>;
  }

  return (
    <span className={`font-mono font-semibold tracking-tight inline-flex items-center gap-1 ${className}`}>
      {prefix && <span>{prefix}</span>}
      {showTargetTime && (
        <span className="bg-blue-100/80 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-[10px] px-1.5 py-0.2 rounded font-sans font-bold">
          {targetTimeLabel} 开盘
        </span>
      )}
      <span className="tabular-nums">
        <span className="text-[10px] font-sans font-normal opacity-75 mr-0.5">剩</span>
        {countdownStr}
      </span>
    </span>
  );
}

/** 分钟数（自 00:00）→ "HH:MM" */
function minToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
      preopen: [9 * 60 + 15, 9 * 60 + 30],
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
    const dst = isUsEasternDst(d);
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

  // 美股 4 阶段判定（盘前/盘中/盘后/夜盘）。交易日必须按纽约日期判断：
  // 北京周一凌晨仍可能是纽约周日，不能误标为上一交易日盘中。
  if (market === 'us') {
    const nyWeekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short'
    }).format(d);
    if (nyWeekday === 'Sat' || nyWeekday === 'Sun') {
      return { key: 'offday', label: '美股休市', color: 'text-slate-500', pulse: false, detail: '美股周末休市' };
    }
    const dst = isUsEasternDst(d);
    // 夏令时: 盘前 16:00-21:30 | 盘中 21:30-04:00(次) | 盘后 04:00-08:00(次) | 夜盘 08:00-16:00
    // 冬令时: 盘前 17:00-22:30 | 盘中 22:30-05:00(次) | 盘后 05:00-09:00(次) | 夜盘 09:00-17:00
    const preStart = dst ? 16 * 60 : 17 * 60;
    const regStart = dst ? (21 * 60 + 30) : (22 * 60 + 30);
    const regEnd   = dst ? 4 * 60 : 5 * 60;
    const postEnd  = dst ? 8 * 60 : 9 * 60;

    // 周末美股判定：周六 04:00/05:00 前仍属周五常规盘中
    if (isWeekend) {
      if (day === 6 && min < regEnd) {
        return { key: 'live', label: '美股盘中', color: 'text-[var(--color-up)]', pulse: true, detail: '美股常规盘中交易（延续自周五夜）' };
      }
      return {
        key: 'offday',
        label: '美股休市',
        color: 'text-slate-500',
        pulse: false,
        detail: '美股周末休市'
      };
    }

    // 1) 盘中 (Regular Session)
    if (min >= regStart || min < regEnd) {
      return { key: 'live', label: '美股盘中', color: 'text-[var(--color-up)]', pulse: true, detail: '美股常规盘中交易（美东 09:30–16:00）' };
    }
    // 2) 盘后 (After-Hours)
    if (min >= regEnd && min < postEnd) {
      return { key: 'closed', label: '美股盘后', color: 'text-amber-600 dark:text-amber-400', pulse: false, detail: '美股盘后交易（美东 16:00–20:00）' };
    }
    // 3) 夜盘 (Overnight)
    if (min >= postEnd && min < preStart) {
      return { key: 'preopen', label: '美股夜盘', color: 'text-indigo-500', pulse: false, detail: '美股夜盘交易（美东 20:00–04:00）' };
    }
    // 4) 盘前 (Pre-Market)
    if (min >= preStart && min < regStart) {
      return { key: 'preopen', label: '美股盘前', color: 'text-blue-600 dark:text-blue-400', pulse: false, detail: '美股盘前交易（美东 04:00–09:30）' };
    }
  }

  // 周末
  if (isWeekend) {
    return {
      key: 'offday',
      label: market === 'hk' ? '港股休市' : '休市',
      color: 'text-slate-500',
      pulse: false,
      detail: market === 'hk' ? '港股周末休市' : 'A 股周末休市'
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
      ? `美股于北京时间 ${isUsEasternDst(d) ? '04:00' : '05:00'} 收盘`
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
  market,
  className = ''
}: {
  gzTs: number;
  fundName?: string;
  fundCode?: string;
  market?: FundMarket;
  className?: string;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000); // 1s 保持倒计时精准更新
    return () => clearInterval(id);
  }, []);

  const resolvedMarket = market || detectFundMarket(fundName, fundCode);
  const status = deriveMarketStatus(gzTs, now, resolvedMarket);
  const isClosedOrPreopen = status.key === 'closed' || status.key === 'preopen' || status.key === 'lunch' || status.key === 'offday';

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-semibold ${status.color} ${className}`}
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
      <span>{status.label}</span>
      {isClosedOrPreopen && (
        <OpenCountdown market={resolvedMarket} prefix="· " className="text-[10px] opacity-80" />
      )}
    </span>
  );
}
