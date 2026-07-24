import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
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
  Loader2
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
import { FundDetailPanel } from './components/FundDetailPanel';
import { EmailConfigPanel } from './components/EmailConfigPanel';
import { GoldTab } from './components/GoldTab';

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
   Main App
   ─────────────────────────────────────────────────────────────────── */

function App() {
  /* ---------- Session state ---------- */
  const [currentUser, setCurrentUser] = useState<string>('guest');
  const [loginInput, setLoginInput] = useState<string>('');
  const [loginPassword, setLoginPassword] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);

  /* ---------- Data state ---------- */
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [fundsData, setFundsData] = useState<Record<string, FundValuation>>({});
  const [marketIndices, setMarketIndices] = useState<MarketIndex[]>([]);
  const [positions, setPositions] = useState<Record<string, UserPosition>>({});
  const [selfTab, setSelfTab] = useState<'fund' | 'stock'>(() => {
    try {
      const saved = localStorage.getItem('fund_self_tab');
      if (saved === 'fund' || saved === 'stock') return saved;
    } catch {}
    return 'fund';
  });
  const [mainTab, setMainTab] = useState<'portfolio' | 'gold'>(() => {
    // 刷新停留在哪个 tab — 从 localStorage 恢复
    try {
      const saved = localStorage.getItem('fund_main_tab');
      if (saved === 'portfolio' || saved === 'gold') return saved;
    } catch {}
    return 'portfolio';
  });

  /* ---------- UI state ---------- */
  const [newCode, setNewCode] = useState('');
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
  const [editShares, setEditShares] = useState('');
  const [editCost, setEditCost] = useState('');
  const [editAmount, setEditAmount] = useState('');     // 总投入金额（"按金额"模式）
  const [editMode, setEditMode] = useState<'shares' | 'amount'>('shares');  // 输入模式

  /* ---------- Preferences ---------- */
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isIntlColor, setIsIntlColor] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [autoRefreshInterval] = useState<number>(30);

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const timerRef = useRef<any>(null);

  /* ---------- Selection state for detail panel ---------- */
  const [selectedFundCode, setSelectedFundCode] = useState<string | null>(null);
  const [historyMap, setHistoryMap] = useState<Record<string, FundHistoryPoint[]>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [basicMap, setBasicMap] = useState<Record<string, FundBasicInfo | null>>({});
  const [holdingsMap, setHoldingsMap] = useState<Record<string, FundHoldingStock[]>>({});

  /* ---------- Drag-to-reorder state ---------- */
  // 拖动中：dragActiveCode = 当前抬起的行；pendingOrder = 本次手势重排后的预览顺序。
  // pendingDragCode = pointerdown 已发生、但 timer 还没到（等待 450ms 触屏 / 200ms 鼠标）。
  //   此时需要 touch-action:none 阻止浏览器误判滚动。
  // dragCommittedRef = 拖动已激活，下一次合成 click 必须被拦截，避免打开详情 drawer。
  // dragOverIndex 暂未深度使用（FLIP 自动补间已经给出足够视觉反馈），保留以备后续插入指示线。
  const [dragActiveCode, setDragActiveCode] = useState<string | null>(null);
  const [pendingDragCode, setPendingDragCode] = useState<string | null>(null);
  const [, setDragOverIndex] = useState<number | null>(null);
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const dragCommittedRef = useRef(false);
  // 行 DOM rect 缓存，给 onMove 用：客户端 Y 坐标 → 落点 index
  const rowRectMapRef = useRef<Map<string, DOMRect>>(new Map());
  // pointermove rAF 节流：避免 60-240Hz 设备上一帧多次 setState 让 motion spring 反复被截断
  const dragRafPendingRef = useRef(false);
  const dragLastClientYRef = useRef(0);
  // 物理插槽边界信息 (Slot 0..N-1)
  const slotBoundsRef = useRef<{ top: number; bottom: number; mid: number }[]>([]);
  // 拖拽按住瞬间的垂直 offset（相对卡片顶部）
  const dragGrabOffsetRef = useRef<number>(0);

  // 根据当前鼠标停留的物理位置计算目标插入位置 (goalIdx)
  const calculateGoalIdx = useCallback((gcode: string, clientY: number, currList: string[]): number => {
    const fromIdx = currList.indexOf(gcode);
    if (fromIdx < 0) return 0;

    const bounds = slotBoundsRef.current;
    if (bounds.length === 0) return fromIdx;

    // 校准计算：以被抓取卡片的“几何中心/中点”作为实际检测点
    // clientY 是鼠标点，clientY - grabOffset 是卡片 top，+ cardHeight/2 即为卡片中点
    const cardHeight = bounds[0] ? (bounds[0].bottom - bounds[0].top) : 60;
    const cardMidY = clientY - dragGrabOffsetRef.current + (cardHeight / 2);

    let targetIdx = 0;
    // 检测卡片中心目前停留在哪个物理 Slot 的 Bounds（或超过了哪个 Mid）
    for (let i = 0; i < bounds.length; i++) {
      if (cardMidY > bounds[i].mid) {
        targetIdx = i + 1;
      }
    }

    return Math.min(Math.max(0, targetIdx), currList.length - 1);
  }, []);

  useEffect(() => {
    // If the currently-selected fund was removed from the watchlist, drop
    // the selection. We deliberately do NOT auto-select anything on initial
    // load — the user should land on the main page, not a detail drawer.
    if (selectedFundCode && !watchlist.includes(selectedFundCode)) {
      setSelectedFundCode(null);
    }
  }, [watchlist, selectedFundCode]);

  // Fetch historical NAV when the selected fund changes — covers 1D/1W/1M
  // ranges with real data from the backend. 按 tab 强制 kind（股票走腾讯 K 线）
  useEffect(() => {
    if (!selectedFundCode) return;
    if (historyMap[selectedFundCode]) return;          // already cached
    const item = watchlistItems.find(w => w.fund_code === selectedFundCode);
    const kind = item?.kind;
    let cancelled = false;
    setHistoryLoading(true);
    fetchFundHistory(selectedFundCode, 35, kind)
      .then(data => {
        if (cancelled) return;
        setHistoryMap(prev => ({ ...prev, [selectedFundCode]: data }));
      })
      .catch(() => { /* swallow — chart will fall back to estimate */ })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [selectedFundCode, historyMap]);

  // Fetch basic info + holdings (cached) when the selected fund changes.
  useEffect(() => {
    if (!selectedFundCode) return;
    const code = selectedFundCode;

    if (!basicMap[code]) {
      fetchFundBasic(code)
        .then(data => setBasicMap(prev => ({ ...prev, [code]: data })))
        .catch(() => setBasicMap(prev => ({ ...prev, [code]: null })));
    }

    if (!holdingsMap[code]) {
      fetchFundHoldings(code)
        .then(data => setHoldingsMap(prev => ({ ...prev, [code]: data })))
        .catch(() => setHoldingsMap(prev => ({ ...prev, [code]: [] })));
    }
  }, [selectedFundCode, basicMap, holdingsMap]);

  const prefersReducedMotion = useReducedMotion();

  /* ---------- Drag-to-reorder: state + handlers ---------- */

  // 当前 tab 内可见的顺序。拖动中由 pendingOrder 提供预览；非拖动态 = filteredList。
  const visibleList = useMemo(() => {
    if (pendingOrder) return pendingOrder;
    return watchlist.filter(code => {
      if (selfTab === 'fund') {
        const it = watchlistItems.find(w => w.fund_code === code);
        return !it || it.kind === 'fund';
      }
      if (selfTab === 'stock') {
        const it = watchlistItems.find(w => w.fund_code === code);
        return it?.kind === 'stock';
      }
      return true;
    });
  }, [pendingOrder, watchlist, watchlistItems, selfTab]);

  // 用 kindOf 把重排后的子序列塞回全局 watchlist，同时保留另一 kind 的相对位置
  function mergeKindOrder(
    global: string[],
    reorderedKind: string[],
    activeKind: 'fund' | 'stock',
    kindOf: (c: string) => 'fund' | 'stock'
  ): string[] {
    const queue = [...reorderedKind];
    return global.map(code => (kindOf(code) === activeKind ? queue.shift()! : code));
  }

  const cancelDrag = useCallback(() => {
    setDragActiveCode(null);
    setPendingDragCode(null);
    setDragOverIndex(null);
    setPendingOrder(null);
    dragCommittedRef.current = false;
    dragRafPendingRef.current = false;
    dragLastToIdxRef.current = -1;
  }, []);

  const commitDrag = useCallback(async () => {
    if (!pendingOrder || !dragActiveCode) return;
    const newOrder = pendingOrder;
    const previousWatchlist = watchlist;
    setPendingOrder(null);
    // dragCommittedRef 不在这里清零 —— 让浏览器合成的 click 有机会被 onClickCapture 拦截
    setDragActiveCode(null);
    setPendingDragCode(null);
    setDragOverIndex(null);

    // 顺序未变 → 不发请求
    const kindOf = (c: string) => watchlistItems.find(w => w.fund_code === c)?.kind || 'fund';
    const merged = mergeKindOrder(watchlist, newOrder, selfTab, kindOf);
    const unchanged = merged.length === watchlist.length &&
      merged.every((c, i) => c === watchlist[i]);
    if (unchanged) return;

    // 乐观合并回全局
    setWatchlist(merged);

    try {
      await reorderWatchlist(selfTab, newOrder);
    } catch (err: any) {
      setWatchlist(previousWatchlist);  // 回滚
      setToastMsg('排序保存失败：' + (err?.message || '请检查后端'));
      setTimeout(() => setToastMsg(null), 3000);
    }
  }, [pendingOrder, dragActiveCode, watchlist, watchlistItems, selfTab]);

  // 拖动中按 Esc 取消
  useEffect(() => {
    if (!dragActiveCode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelDrag(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragActiveCode, cancelDrag]);

  // 切换 tab 强制取消拖动（避免跨 kind 错乱）
  useEffect(() => {
    if (dragActiveCode) cancelDrag();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfTab]);

  // Rect 采样：每次列表变化或拖动状态变化后重算各行 rect。
  // 拖动期间也包含 gcode 自己的 rect（spring 进度反映在 mid 上），
  //   用于 rAF tick 比较 clientY vs gcode.mid 决定推上/下。
  useLayoutEffect(() => {
    const map = new Map<string, DOMRect>();
    document.querySelectorAll<HTMLElement>('[data-fund-code]').forEach(el => {
      map.set(el.dataset.fundCode!, el.getBoundingClientRect());
    });
    rowRectMapRef.current = map;
  }, [visibleList, dragActiveCode]);

  // 每行调用的回调：长按激活、移动重排、提交落库
  // 手势状态用 Map<Ref> 而非 useState，避免每行都触发渲染 + 满足 hooks 规则
  const rowGestureRefs = useRef(new Map<string, {
    timer: number | null;
    start: { x: number; y: number; pointerId: number; el: Element | null } | null;
    activated: boolean;
  }>());

  // 关键设计：move/up 监听绑到 document 而非每行。原因：
  //   1. setPointerCapture 在某些浏览器/React Synthetic Event 上下文里会静默失败，
  //      此时指针离开原 row 后 onPointerMove 不再触发 → 跨行拖动失效
  //   2. 绑到 document 后，无论指针在哪都能持续收到 move/up，跨行拖动可靠
  // 单个 ref 跟踪"当前手势是哪个 code"，document 级 listener 读取并分派
  const gestureCodeRef = useRef<string | null>(null);

  const makeRowHandlers = useCallback((code: string) => {
    const onPointerDown = (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      let st = rowGestureRefs.current.get(code);
      if (!st) {
        st = { timer: null, start: null, activated: false };
        rowGestureRefs.current.set(code, st);
      }
      // 清理上次未释放的资源
      if (st.timer != null) { clearTimeout(st.timer); st.timer = null; }
      const el = e.currentTarget as Element | null;
      st.start = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, el };
      st.activated = false;
      gestureCodeRef.current = code;
      // 新手势开始：重置 rAF + toIdx dedup 状态
      dragLastToIdxRef.current = -1;
      dragRafPendingRef.current = false;
      dragLastClientYRef.current = e.clientY;
      // 进入等待态：CSS 给该行 touch-action:none 阻止浏览器滚动误判
      setPendingDragCode(code);
      // 拖动已结束的标志位在新手势开始时先重置（如果上一手势的合成 click 已经过了）
      dragCommittedRef.current = false;
      // pointer capture 是 best-effort：失败也无所谓，document 级 listener 会兜底
      if (el && typeof (el as any).setPointerCapture === 'function') {
        try { (el as any).setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      const isTouch = e.pointerType === 'touch';
      const threshold = isTouch ? 450 : 200;
      st.timer = window.setTimeout(() => {
        if (!st!.start) return;
        st!.activated = true;

        // 采样当前所有可见行的静态 DOM 物理 Bound (top, bottom, mid)
        const rowElements = Array.from(document.querySelectorAll<HTMLElement>('[data-fund-code]'));
        const elementRects = rowElements.map(el => ({
          code: el.dataset.fundCode!,
          rect: el.getBoundingClientRect()
        }));

        // 按 Y 轴升序排列，提取各物理插槽的 bounds
        const bounds = elementRects
          .map(item => ({
            top: item.rect.top,
            bottom: item.rect.bottom,
            mid: (item.rect.top + item.rect.bottom) / 2
          }))
          .sort((a, b) => a.top - b.top);
        slotBoundsRef.current = bounds;

        // 记录鼠标在卡片内部的抓取偏移量 (grabOffset)
        const activeRect = elementRects.find(item => item.code === code)?.rect;
        if (activeRect) {
          dragGrabOffsetRef.current = st.start.y - activeRect.top;
        } else {
          dragGrabOffsetRef.current = 0;
        }

        // 关键点：用闭包传入此刻捕获的 code，避免后续动画或 state 重绘改变激活的基金
        const activeCode = code;
        setDragActiveCode(activeCode);
        setPendingDragCode(null);  // 等待结束，由激活态接管视觉反馈
        setPendingOrder(visibleList);
        // 标记本次手势已激活 drag —— 释放后浏览器合成的 click 必须被 onClickCapture 拦截
        dragCommittedRef.current = true;
      }, threshold);
    };

    // per-row 上还保留 onPointerMove 作为"快速路径"（用户在原 row 内小幅移动时立即反应）
    // 真正的跨行拖动由 document 级 listener 接管
    const onPointerMove = (e: React.PointerEvent) => {
      const gcode = gestureCodeRef.current;
      if (gcode !== code) return;
      const st = rowGestureRefs.current.get(code);
      if (!st || !st.start) return;

      // 如果拖拽手势已经激活，强制阻止默认滚动行为 (避免向上拖拽触发页面上滑)
      if (st.activated) {
        e.preventDefault();
        return;
      }

      const dx = e.clientX - st.start.x;
      const dy = e.clientY - st.start.y;
      const dist = Math.hypot(dx, dy);
      if (!st.activated && dist > 8) {
        // 未激活就大距离移动 → 视为滚动意图
        if (st.timer != null) { clearTimeout(st.timer); st.timer = null; }
        st.start = null;
        setPendingDragCode(null);
        gestureCodeRef.current = null;
        return;
      }
    };

    const onPointerUp = () => {
      // 已激活的 up 由 document 级 listener 处理
      // 这里什么都不做 —— document 级 listener 会 commit
    };

    const onPointerCancel = () => {
      const st = rowGestureRefs.current.get(code);
      if (st && st.timer != null) { clearTimeout(st.timer); st.timer = null; }
      if (st) st.start = null;
      if (gestureCodeRef.current === code) gestureCodeRef.current = null;
      setPendingDragCode(curr => (curr === code ? null : curr));
    };

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
  }, [visibleList, commitDrag]);

  // Document 级 move/up/cancel —— 兜底：无论指针 capture 是否生效，跨行都能持续响应
  useEffect(() => {
    // rAF tick：把"上一帧最新 clientY"应用到 pendingOrder，每帧最多一次 setState
    const tickMove = () => {
      dragRafPendingRef.current = false;
      const gcode = gestureCodeRef.current;
      if (!gcode) return;
      const st = rowGestureRefs.current.get(gcode);
      if (!st || !st.activated || !st.start) return;
      const clientY = dragLastClientYRef.current;

      // 链式 rAF：setState 后若还没到 goal，下一帧继续推一格
      //   这样手指停在 goal 位置时，抬起行也会在若干帧内到位
      let shouldReschedule = false;

      setPendingOrder(curr => {
        if (!curr) return curr;
        const fromIdx = curr.indexOf(gcode);
        if (fromIdx < 0) return curr;

        const goalIdx = calculateGoalIdx(gcode, clientY, curr);
        if (goalIdx === fromIdx) return curr;

        // 直接一次性步进至当前鼠标停靠的物理 Goal Index
        // 不再逐帧 ±1 步累加，彻底消除逐步推演带来的跳帧和中途反复动画抖动
        const next = [...curr];
        next.splice(fromIdx, 1);
        next.splice(goalIdx, 0, gcode);
        setDragOverIndex(goalIdx);
        return next;
      });

      // 直接更新至最新鼠标位置，不需要 reschedule 链式推演
      shouldReschedule = false;
    };

    const onMove = (e: PointerEvent) => {
      const gcode = gestureCodeRef.current;
      if (!gcode) return;
      const st = rowGestureRefs.current.get(gcode);
      if (!st || !st.start || !st.activated) return;
      e.preventDefault();
      dragLastClientYRef.current = e.clientY;
      if (dragRafPendingRef.current) return;
      dragRafPendingRef.current = true;
      requestAnimationFrame(tickMove);
    };

    // 关键修复：增加原生的 touchmove 监听，解决 PC 触屏模拟器 / 移动端向上拖动时触发页面上滑的问题
    const onNativeTouchMove = (e: TouchEvent) => {
      const gcode = gestureCodeRef.current;
      if (!gcode) return;
      const st = rowGestureRefs.current.get(gcode);
      if (st && st.activated) {
        if (e.cancelable) e.preventDefault();
      }
    };
    const onUp = () => {
      const gcode = gestureCodeRef.current;
      if (!gcode) return;
      const st = rowGestureRefs.current.get(gcode);
      // 关键: onUp 之前先同步跑一次 tickMove + flushToGoal, 并 flushSync 强制 commit
      //   避免 onUp 与 chain rAF race 导致 commitDrag 读到旧 pendingOrder
      if (st && st.activated) {
        tickMove();
        flushToGoal(gcode);
        flushSync(() => {});   // 强制 React 立即 commit flushToGoal 的 setState
      }
      if (st && st.activated) commitDrag();
      if (st) {
        if (st.timer != null) clearTimeout(st.timer);
        st.timer = null;
        st.start = null;
        st.activated = false;
      }
      dragRafPendingRef.current = false;
      dragLastToIdxRef.current = -1;
      gestureCodeRef.current = null;
      setPendingDragCode(null);
      // 若没有激活过拖拽，立即复位 dragCommittedRef；若激活过，延迟 300ms 清零拦截 click
      if (!st || !st.activated) {
        dragCommittedRef.current = false;
      } else {
        setTimeout(() => { dragCommittedRef.current = false; }, 300);
      }
    };

    // onUp 时强制把 gcode 推到 goalIdx (一次性, 突破 ±1 步限制)
    //   拖动期间的 chain rAF 因为是 ±1 步, 可能还没推到 goal 就被 onUp 打断;
    //   onUp 时一次性 jump 到 goal, 保证最终顺序符合手指落点.
    const flushToGoal = (gcode: string) => {
      const clientY = dragLastClientYRef.current;
      setPendingOrder(curr => {
        if (!curr) return curr;
        const fromIdx = curr.indexOf(gcode);
        if (fromIdx < 0) return curr;
        const goalIdx = calculateGoalIdx(gcode, clientY, curr);
        if (goalIdx === fromIdx) return curr;
        const next = [...curr];
        next.splice(fromIdx, 1);
        next.splice(goalIdx, 0, gcode);
        return next;
      });
    };
    const onCancel = () => {
      const gcode = gestureCodeRef.current;
      if (!gcode) return;
      const st = rowGestureRefs.current.get(gcode);
      if (st) {
        if (st.timer != null) clearTimeout(st.timer);
        st.timer = null;
        st.start = null;
      }
      dragRafPendingRef.current = false;
      dragLastToIdxRef.current = -1;
      gestureCodeRef.current = null;
      setPendingDragCode(null);
    };
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('touchmove', onNativeTouchMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('touchmove', onNativeTouchMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
    };
  }, [commitDrag]);

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
  }, []);

  useEffect(() => {
    if (currentUser) loadUserData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  /* ---------- Polling (background-friendly + 休市自动暂停) ---------- */
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoRefreshInterval > 0 && currentUser) {
      timerRef.current = setInterval(() => {
        if (document.visibilityState !== 'visible') return;

        // 全局休市校验：提取用户自选列表中关注的所有市场
        const activeMarkets: FundMarket[] = watchlistItems.map(item => {
          if (item.market === 'us' || item.market === 'hk' || item.market === 'domestic' || item.market === 'other') {
            return item.market;
          }
          const val = fundsData[item.fund_code];
          return detectFundMarket(val?.name, item.fund_code);
        });

        // 若用户关注的所有市场目前均处于休市闭市状态（如周末或深夜全盘休市），跳过轮询刷新
        if (!isAnyMarketOpen(activeMarkets)) {
          return;
        }

        refreshPricesOnly();
      }, autoRefreshInterval * 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist, watchlistItems, fundsData, autoRefreshInterval, currentUser]);

  /* ---------- Toast ---------- */
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  }, []);

  /* ---------- Data loaders ---------- */
  const loadUserData = async () => {
    setLoading(true);
    try {
      const data = await fetchWatchlist();
      setWatchlist(data.codes);
      setWatchlistItems(data.items);
      const posList = await fetchPositions();
      const posMap: Record<string, UserPosition> = {};
      posList.forEach(p => { posMap[p.fund_code] = p; });
      setPositions(posMap);
      const indices = await fetchMarketIndices();
      setMarketIndices(indices);
      const updatedFunds: Record<string, FundValuation> = {};
      await Promise.all(data.codes.map(async (code: string) => {
        const item = data.items.find((w: WatchlistItem) => w.fund_code === code);
        const val = await fetchFundValuation(code, item?.kind);
        if (val) updatedFunds[code] = val;
      }));
      setFundsData(updatedFunds);
    } catch (e) {
      console.error('加载用户数据失败:', e);
      showToast('数据加载失败，请检查后端服务是否启动');
    } finally {
      setLoading(false);
    }
  };

  const refreshPricesOnly = async () => {
    try {
      const indices = await fetchMarketIndices();
      if (indices.length > 0) setMarketIndices(indices);
      const updatedFunds = { ...fundsData };
      await Promise.all(watchlist.map(async (code) => {
        const item = watchlistItems.find((w: WatchlistItem) => w.fund_code === code);
        const val = await fetchFundValuation(code, item?.kind);
        if (val) updatedFunds[code] = val;
      }));
      setFundsData(updatedFunds);
    } catch (e) {
      console.error('定时轮询行情失败:', e);
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
   * 名称搜索下拉的输入变化：250ms 防抖后请求后端搜索；仅当输入含非 ASCII 字符才触发
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

    // 纯代码形态（仅含 A-Z / 0-9）→ 不发搜索请求
    // 用 lowercase 比对，因为 toUpperCase 对中文是 no-op、且会改变 aapl→AAPL 这种纯字母输入
    const isCodeLike = /^[a-z0-9]+$/i.test(value);
    if (isCodeLike || value.length < 1) {
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
        const results = await searchByName(value, selfTab);
        // 请求返回时用户可能已经清空/切换，要核对一次当前输入
        if (!composingRef.current && value.length > 0) {
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
    }, 250);
  };

  /**
   * 直接通过名称搜索结果添加：跳过 regex 校验、走带 kind 的拉取
   */
  const addFromSearchResult = async (result: SearchResult) => {
    if (watchlist.includes(result.code)) {
      setSearchError('该代码已在自选列表中');
      setDropdownOpen(false);
      return;
    }
    setSearchLoading(true);
    setSearchError('');
    setDropdownOpen(false);
    try {
      const fund = await fetchFundValuation(result.code, result.kind);
      if (fund) {
        const res = await addWatchlistItem({
          code: result.code,
          kind: result.kind,
          market: fund.market as any,
        });
        setWatchlist(prev => [...prev, result.code]);
        setWatchlistItems(prev => [...prev, {
          fund_code: result.code,
          kind: result.kind,
          market: fund.market as any,
          sector: (res as any).sector,
          created_at: new Date().toISOString()
        }]);
        setFundsData(prev => ({ ...prev, [result.code]: fund }));
        setNewCode('');
        setSearchResults([]);
        showToast(`已订阅${result.kind === 'stock' ? '股票' : '基金'}: ${fund.name}`);
      } else {
        setSearchError('未找到该代码，请确认是否正确');
      }
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
    setNewCode('');
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
    // 如果下拉开着，回车应该已经选中 → 这里拦一道
    if (dropdownOpen && searchResults[highlightIdx]) {
      addFromSearchResult(searchResults[highlightIdx]);
      return;
    }
    const code = newCode.trim();
    // 接受：A 股 6 位 / 港股 5 位 / 美股 1-5 位字母
    if (!/^(\d{6}|\d{4,5}|[A-Za-z]{1,5})$/.test(code)) {
      setSearchError('请输入 A 股 6 位 / 港股 5 位 / 美股 ticker，或输入中文名搜索');
      return;
    }
    if (watchlist.includes(code)) {
      setSearchError('该代码已在自选列表中');
      return;
    }
    // 根据 selfTab 决定 kind（基金/股票）
    const kind: 'fund' | 'stock' = selfTab === 'stock' ? 'stock' : 'fund';
    setSearchLoading(true);
    setSearchError('');
    try {
      const fund = await fetchFundValuation(code, kind);
      if (fund) {
        const res = await addWatchlistItem({
          code,
          kind,
          market: fund.market as any,
        });
        setWatchlist(prev => [...prev, code]);
        setWatchlistItems(prev => [...prev, {
          fund_code: code, kind,
          market: fund.market as any, sector: (res as any).sector, created_at: new Date().toISOString()
        }]);
        setFundsData(prev => ({ ...prev, [code]: fund }));
        setNewCode('');
        showToast(`已订阅${kind === 'stock' ? '股票' : '基金'}: ${fund.name}`);
      } else {
        setSearchError('未找到该代码，请确认是否正确');
      }
    } catch (err: any) {
      setSearchError(err.message || '获取数据失败，请确认代码');
    } finally {
      setSearchLoading(false);
    }
  };

  const handleRemoveFund = async (code: string, name: string) => {
    if (confirm(`确定要取订并删除自选基金【${name || code}】吗？这会同步清除该基金的持仓记录。`)) {
      try {
        await removeFromWatchlist(code);
        setWatchlist(prev => prev.filter(c => c !== code));
        const newPos = { ...positions };
        delete newPos[code];
        setPositions(newPos);
        showToast(`已删除订阅: ${name || code}`);
      } catch (e) {
        showToast('删除订阅失败，请重试');
      }
    }
  };

  /* ---------- Position edit ---------- */
  const openEditPosition = (code: string) => {
    setEditingCode(code);
    const pos = positions[code] || { shares: 0, cost: 0, fund_code: code };
    const s = pos.shares > 0 ? pos.shares : 0;
    const c = pos.cost > 0 ? pos.cost : 0;
    setEditShares(s > 0 ? s.toString() : '');
    setEditCost(c > 0 ? c.toString() : '');
    setEditAmount(s > 0 && c > 0 ? (s * c).toFixed(2) : '');
    setEditMode('shares');
  };

  const handleSavePosition = async () => {
    if (!editingCode) return;
    const shares = parseFloat(editShares);
    const cost = parseFloat(editCost);

    // 校验：必须两个都是有效正数才保存
    if (isNaN(shares) || shares <= 0 || isNaN(cost) || cost <= 0) {
      showToast('请输入有效的份额和成本（都必须 > 0）');
      return;
    }

    try {
      await savePosition(editingCode, shares, cost);
      setPositions(prev => ({
        ...prev,
        [editingCode]: { fund_code: editingCode, shares, cost }
      }));
      showToast(`已保存：${shares}份 × ¥${cost.toFixed(4)} = ¥${(shares * cost).toFixed(2)}`);
    } catch (e: any) {
      showToast('保存持仓失败：' + (e?.message || '请检查后端'));
    }
    setEditingCode(null);
  };

  /** 显式清除持仓（用户主动点击"清除"按钮） */
  const handleClearPosition = async () => {
    if (!editingCode) return;
    if (!confirm('确定清除该基金的持仓记录？此操作不可撤销。')) return;
    try {
      await removePosition(editingCode);
      setPositions(prev => {
        const next = { ...prev };
        delete next[editingCode];
        return next;
      });
      showToast('持仓记录已清除');
    } catch (e: any) {
      showToast('清除失败：' + (e?.message || '请检查后端'));
    }
    setEditingCode(null);
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
          if (prevPrice > 0) {
            todayProfit += pos.shares * (currentPrice - prevPrice);
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

      {/* Toast — spring slide-in from top-right with origin awareness */}
      <AnimatePresence>
        {toastMsg && (
          <motion.div
            key={toastMsg}
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.96 }}
            transition={SPRING.toast}
            style={{ originX: 1, originY: 0 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 md:left-4 md:translate-x-0 z-40 bg-slate-900 text-white dark:bg-white dark:text-slate-900 pl-2 pr-4 py-3 rounded-2xl shadow-2xl text-[11px] font-semibold flex items-center gap-2 border border-slate-800 dark:border-slate-200"
          >
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white">
              <Info size={11} strokeWidth={2.5} />
            </span>
            {toastMsg}
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

          {/* 主 tab: 自选 (portfolio) / 金价 (gold) */}
          <div className="relative inline-flex bg-slate-100/60 dark:bg-white/5 rounded-full p-0.5 shrink-0">
            {([
              { key: 'portfolio', label: '自选', icon: '📋' },
              { key: 'gold',       label: '金价', icon: '💰' },
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
          <div className="hidden md:flex items-center gap-2">
            <EmailConfigPanel
              isAdmin={currentUser.toLowerCase() === 'admin'}
              currentUser={currentUser}
              onToast={showToast}
            />
            <PressableIconButton
              onClick={toggleDarkMode}
              aria-label={isDarkMode ? '切换到亮色模式' : '切换到暗黑模式'}
              className="p-2 rounded-full hover:bg-slate-200/50 dark:hover:bg-slate-800/50 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              {isDarkMode ? <Sun size={15} /> : <Moon size={15} />}
            </PressableIconButton>
            <PressableButton
              onClick={toggleColorRule}
              className="text-[10px] font-bold bg-[#f5f5f7] dark:bg-[#1d1d1f] hover:bg-slate-200/50 dark:hover:bg-slate-800/50 border border-[var(--hairline-border)] px-2.5 py-1.5"
            >
              {isIntlColor ? '🟢涨🔴跌' : '🔴涨🟢跌'}
            </PressableButton>
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

      {/* Main grid — 金价 tab 占满整页时只渲染金价 */}
      {mainTab === 'gold' ? (
        <div className="flex-1 max-w-7xl w-full mx-auto p-3.5 md:p-6">
          <GoldTab />
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
              <Sliders size={14} className="text-[#0066cc]" /> 订阅架构说明
            </h3>
            <div className="text-[11px] text-[#86868b] leading-relaxed space-y-2">
              <p>后端通过 SQLite 进行多用户自选与持仓列表隔离。</p>
              <p>数据自动定时（每 30 秒）在后台刷新最新净值估算与大盘数据，并在后台自动挂载缓存避免频繁接口访问。</p>
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
                    placeholder={selfTab === 'stock' ? '代码 或 名称 (如 00700 / 腾讯)' : '代码 或 名称 (如 161039 / 三花)'}
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
                  {/* ── Mobile Card List ── */}
                  <div className="block md:hidden divide-y divide-slate-100 dark:divide-slate-800/60">
                    <AnimatePresence initial={false}>
                      {visibleList.map((code) => {
                        const fund = fundsData[code];
                        const pos = positions[code];
                        if (!fund) {
                          return (
                            <div key={code} className="p-4 text-xs text-slate-400 font-mono animate-pulse">
                              {code} 读取中...
                            </div>
                          );
                        }

                        const changeVal = parseFloat(fund.gszzl);
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
                          if (prevPrice > 0) {
                            todayProfit = pos.shares * (currentPrice - prevPrice);
                          }
                        }

                        return (
                          <motion.div
                            key={code}
                            layout="position"
                            data-fund-code={code}
                            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                            transition={dragActiveCode ? SPRING.drag : SPRING.default}
                            onClick={() => { if (!dragCommittedRef.current) setSelectedFundCode(code); }}
                            onClickCapture={(e) => {
                              if (dragCommittedRef.current) {
                                e.preventDefault();
                                e.stopPropagation();
                                dragCommittedRef.current = false;
                              }
                            }}
                            {...(() => {
                              const h = makeRowHandlers(code);
                              return {
                                onPointerDown: h.onPointerDown,
                                onPointerCancel: h.onPointerCancel,
                              };
                            })()}
                            className={`p-3.5 hover:bg-slate-50/80 dark:hover:bg-white/[0.03] transition-colors cursor-pointer space-y-2 touch-none select-none ${
                              (pendingDragCode === code || dragActiveCode === code)
                                ? 'is-dragging relative bg-white dark:bg-[#1d1d1f] '
                                : ''
                            }${dragActiveCode === code ? 'z-50 scale-[1.02] shadow-2xl ring-2 ring-[#0066cc]/40 dark:ring-[#2997ff]/40' : ''}`}
                            style={{ touchAction: 'none' }}
                          >
                            {/* Card Header: Name + Code + Tag + Actions */}
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">
                                  {fund.name}
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
                                  <span className="tabular-nums">{fund.fundcode}</span>
                                  <span className={`text-[9px] px-1.5 py-0.2 rounded font-sans font-medium border ${
                                    selfTab === 'stock'
                                      ? (fund.market === 'us' ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border-blue-200/60 dark:border-blue-900/40'
                                        : fund.market === 'hk' ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border-emerald-200/60 dark:border-emerald-900/40'
                                        : 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200/60 dark:border-amber-900/40')
                                      : 'bg-slate-100 dark:bg-black text-[#86868b] border-[var(--hairline-border)]'
                                  }`}>
                                    {selfTab === 'stock'
                                      ? (fund.market === 'us' ? '美股' : fund.market === 'hk' ? '港股' : 'A股')
                                      : '公募场外'}
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                                <PressableIconButton
                                  onClick={() => handleRemoveFund(code, fund.name)}
                                  aria-label="退订基金"
                                  className="p-1.5 rounded-full text-slate-400 hover:text-red-500"
                                >
                                  <Trash2 size={14} />
                                </PressableIconButton>
                              </div>
                            </div>

                            {/* Card Body: Price & Change Pill */}
                            <div className="flex items-baseline justify-between pt-1">
                              <div>
                                <div className="text-[10px] text-slate-400">
                                  {selfTab === 'stock' ? '现价' : '估算净值'}
                                </div>
                                <div className="font-mono font-bold text-base text-slate-800 dark:text-slate-100 tabular-nums">
                                  {parseFloat(fund.gsz).toFixed(4)}
                                  <span className="text-[10px] font-normal text-slate-400 ml-1.5">
                                    {fund.gztime.split(' ')[1] || fund.gztime}
                                  </span>
                                </div>
                              </div>

                              <div className={`px-2.5 py-1 rounded-lg font-mono font-bold text-sm tabular-nums ${changeBg}`}>
                                {isUp ? '+' : ''}{changeVal.toFixed(2)}%
                              </div>
                            </div>

                            {/* Position info bar if held or button to add */}
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
                                    onClick={() => openEditPosition(code)}
                                    className="text-[10px] text-blue-600 dark:text-blue-400 underline ml-2"
                                  >
                                    改持仓
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => openEditPosition(code)}
                                  className="text-[10px] text-slate-400 hover:text-blue-500 flex items-center gap-1"
                                >
                                  + 添加持仓数据
                                </button>
                              )}
                            </div>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>

                  {/* ── Desktop Table View ── */}
                  <div className="hidden md:block overflow-x-auto flex-1">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50/40 dark:bg-[#1d1d1f]/40 text-slate-400 dark:text-slate-500 border-b border-[var(--hairline-border)] font-semibold">
                          <th className="p-4 pl-6">{selfTab === 'stock' ? '股票名称与代码' : '基金名称与代码'}</th>
                          {selfTab === 'stock' ? (
                            <>
                              <th className="p-4 text-right">昨收</th>
                              <th className="p-4 text-right">现价</th>
                              <th className="p-4 text-right">涨跌幅</th>
                            </>
                          ) : (
                            <>
                              <th className="p-4 text-right">昨日单位净值</th>
                              <th className="p-4 text-right">实时估算净值</th>
                              <th className="p-4 text-right">实时估算涨跌</th>
                            </>
                          )}
                          <th className="p-4 text-right">我的持仓预估</th>
                          <th className="p-4 text-right">{selfTab === 'stock' ? '今日盈亏' : '今日估算盈亏'}</th>
                          <th className="p-4 text-center pr-6">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                        <AnimatePresence initial={false}>
                          {visibleList.map((code) => {
                            const fund = fundsData[code];
                            const pos = positions[code];

                            if (!fund) {
                              return (
                                <tr key={code}>
                                  <td className="p-4 pl-6 text-slate-400 font-mono font-semibold">{code}</td>
                                  <td colSpan={6} className="p-4 text-center text-[10px] text-slate-400 animate-pulse">
                                    读取中...
                                  </td>
                                </tr>
                              );
                            }

                            const changeVal = parseFloat(fund.gszzl);
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
                              if (prevPrice > 0) {
                                todayProfit = pos.shares * (currentPrice - prevPrice);
                              }
                            }

                            return (
                              <motion.tr
                                key={code}
                                layout="position"
                                data-fund-code={code}
                                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                                transition={dragActiveCode ? SPRING.drag : SPRING.default}
                                {...(() => {
                                  const h = makeRowHandlers(code);
                                  return {
                                    onPointerDown: h.onPointerDown,
                                    onPointerCancel: h.onPointerCancel,
                                  };
                                })()}
                                className={`apple-row touch-none select-none ${(pendingDragCode === code || dragActiveCode === code) ? 'is-dragging' : ''} ${dragActiveCode === code ? 'z-50 shadow-xl bg-blue-50/30 dark:bg-blue-900/20' : ''}`}
                                style={{ touchAction: 'none' }}
                              >
                                <td className="p-4 pl-6">
                                  <div className="font-bold text-slate-800 dark:text-slate-100 truncate max-w-[180px]" title={fund.name}>
                                    {fund.name}
                                  </div>
                                  <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
                                    <span className="tabular-nums">{fund.fundcode}</span>
                                    <span className={`text-[9px] px-2 py-0.2 rounded-full font-sans font-medium border ${
                                      selfTab === 'stock'
                                        ? (fund.market === 'us' ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border-blue-200/60 dark:border-blue-900/40'
                                          : fund.market === 'hk' ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 border-emerald-200/60 dark:border-emerald-900/40'
                                          : 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200/60 dark:border-amber-900/40')
                                        : 'bg-slate-100 dark:bg-black text-[#86868b] border-[var(--hairline-border)]'
                                    }`}>
                                      {selfTab === 'stock'
                                        ? (fund.market === 'us' ? '美股' : fund.market === 'hk' ? '港股' : 'A股')
                                        : '公募场外'}
                                    </span>
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

                                <td className="p-4 text-right">
                                  {pos ? (
                                    <button
                                      onClick={() => openEditPosition(code)}
                                      className="cursor-pointer group text-right"
                                    >
                                      <div className="font-bold font-mono text-slate-800 dark:text-slate-100 tabular-nums">
                                        ¥{holdingValue.toFixed(2)}
                                      </div>
                                      <div className="text-[9px] text-slate-400 group-hover:text-blue-500 mt-0.5 transition-colors flex items-center justify-end gap-1 tabular-nums">
                                        {pos.shares}份 | @{pos.cost.toFixed(4)} ✏️
                                      </div>
                                    </button>
                                  ) : (
                                    <PressableButton
                                      onClick={() => openEditPosition(code)}
                                      className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2.5 py-1 border border-blue-100/50 dark:border-blue-900/10 font-semibold"
                                    >
                                      + 持仓
                                    </PressableButton>
                                  )}
                                </td>

                                <td className={`p-4 text-right font-mono font-bold tabular-nums ${
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

                                <td className="p-4 text-center pr-6" onClick={e => e.stopPropagation()}>
                                  <div className="flex items-center justify-center gap-1">
                                    <PressableButton
                                      onClick={() => setSelectedFundCode(code)}
                                      className="text-[10px] font-semibold text-[var(--primary-accent)] hover:bg-[var(--primary-accent-translucent)] px-2 py-1 rounded-full"
                                    >
                                      查看详情
                                    </PressableButton>
                                    <PressableIconButton
                                      onClick={() => handleRemoveFund(code, fund.name)}
                                      aria-label="退订基金"
                                      className="p-1.5 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20"
                                    >
                                      <Trash2 size={13} />
                                    </PressableIconButton>
                                  </div>
                                </td>
                              </motion.tr>
                            );
                          })}
                        </AnimatePresence>
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
          </section>
        </div>
      </div>
      )}

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
          >
            <motion.div
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 12, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8, filter: 'blur(4px)' }}
              transition={SPRING.sheet}
              className="bg-white dark:bg-[#1d1d1f] rounded-[28px] max-w-sm w-full p-6 border border-[var(--hairline-border)] shadow-2xl relative overflow-hidden"
            >
              {/* Top highlight */}
              <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent dark:via-white/10" />

              <h3 className="apple-display-heading text-sm font-bold text-slate-900 dark:text-slate-50 mb-4 flex items-center gap-1.5">
                <span aria-hidden>✏️</span>
                <span>记持仓成本：{fundsData[editingCode]?.name || editingCode}</span>
              </h3>

              {/* 输入模式切换：按份数 / 按金额 */}
              <div className="flex p-0.5 bg-slate-100/60 dark:bg-white/5 rounded-full mb-4 text-[11px]">
                {([
                  { key: 'shares', label: '按份数输入' },
                  { key: 'amount', label: '按金额输入' },
                ] as const).map(opt => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => {
                      setEditMode(opt.key);
                      // 切换到"按金额"时，把现有 shares × cost 填到 amount
                      if (opt.key === 'amount') {
                        const s = parseFloat(editShares);
                        const c = parseFloat(editCost);
                        if (!isNaN(s) && !isNaN(c) && s > 0 && c > 0) {
                          setEditAmount((s * c).toFixed(2));
                        }
                      } else {
                        // 切换到"按份数"时，把 amount/cost 推回 shares
                        const a = parseFloat(editAmount);
                        const c = parseFloat(editCost);
                        if (!isNaN(a) && !isNaN(c) && c > 0 && a > 0) {
                          setEditShares((a / c).toFixed(2));
                        }
                      }
                    }}
                    className={`flex-1 py-1.5 rounded-full font-semibold transition-colors ${
                      editMode === opt.key
                        ? 'bg-white dark:bg-[#2c2c2e] text-slate-900 dark:text-slate-50 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="space-y-4 mb-4">
                {editMode === 'shares' ? (
                  <>
                    <div>
                      <label className="apple-eyebrow block mb-1.5">持有基金份额 (份)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="例如: 1250.50"
                        value={editShares}
                        onChange={(e) => setEditShares(e.target.value)}
                        className="apple-input w-full px-4 py-2.5 text-xs placeholder-slate-400"
                      />
                    </div>

                    <div>
                      <label className="apple-eyebrow block mb-1.5">持仓均价成本 (元/份)</label>
                      <input
                        type="number"
                        step="0.0001"
                        min="0"
                        placeholder="例如: 2.1350"
                        value={editCost}
                        onChange={(e) => setEditCost(e.target.value)}
                        className="apple-input w-full px-4 py-2.5 text-xs placeholder-slate-400"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="apple-eyebrow block mb-1.5">总投入金额 (元)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="例如: 10000"
                        value={editAmount}
                        onChange={(e) => {
                          setEditAmount(e.target.value);
                          // 自动算份额 = 金额 / 单价
                          const a = parseFloat(e.target.value);
                          const c = parseFloat(editCost);
                          if (!isNaN(a) && !isNaN(c) && c > 0 && a >= 0) {
                            setEditShares((a / c).toFixed(2));
                          }
                        }}
                        className="apple-input w-full px-4 py-2.5 text-sm font-mono font-semibold placeholder-slate-400"
                      />
                    </div>

                    <div>
                      <label className="apple-eyebrow block mb-1.5">当前单价 (元/份)</label>
                      <input
                        type="number"
                        step="0.0001"
                        min="0"
                        placeholder="例如: 2.1350"
                        value={editCost}
                        onChange={(e) => {
                          setEditCost(e.target.value);
                          // 单价变化时同步重算份额
                          const c = parseFloat(e.target.value);
                          const a = parseFloat(editAmount);
                          if (!isNaN(c) && !isNaN(a) && c > 0 && a >= 0) {
                            setEditShares((a / c).toFixed(2));
                          }
                        }}
                        className="apple-input w-full px-4 py-2.5 text-xs placeholder-slate-400"
                      />
                    </div>
                  </>
                )}

                {/* 实时总览 — 让用户清晰看到"份数 × 单价 = 总金额" */}
                <div className="bg-slate-50/60 dark:bg-white/[0.03] border border-[var(--hairline-border)] rounded-xl px-3 py-2.5 grid grid-cols-2 gap-3 text-[11px]">
                  <div>
                    <div className="apple-eyebrow text-slate-500 mb-0.5">总投入金额</div>
                    <div className="font-mono font-bold text-sm tabular-nums text-slate-800 dark:text-slate-100">
                      {(() => {
                        const s = parseFloat(editShares);
                        const c = parseFloat(editCost);
                        if (isNaN(s) || isNaN(c) || s <= 0 || c <= 0) return '—';
                        return `¥ ${(s * c).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                      })()}
                    </div>
                  </div>
                  <div>
                    <div className="apple-eyebrow text-slate-500 mb-0.5">当前市值</div>
                    <div className="font-mono font-bold text-sm tabular-nums text-slate-800 dark:text-slate-100">
                      {(() => {
                        const s = parseFloat(editShares);
                        const cur = fundsData[editingCode]
                          ? (parseFloat(fundsData[editingCode].gsz) || parseFloat(fundsData[editingCode].dwjz))
                          : NaN;
                        if (isNaN(s) || isNaN(cur) || s <= 0) return '—';
                        return `¥ ${(s * cur).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 text-xs">
                {positions[editingCode] ? (
                  <PressableButton
                    onClick={handleClearPosition}
                    className="px-3 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 font-medium flex items-center gap-1"
                  >
                    <Trash2 size={11} />
                    清除持仓
                  </PressableButton>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">
                  <PressableButton
                    onClick={() => setEditingCode(null)}
                    className="px-4 py-2 apple-btn-ghost text-slate-600 dark:text-slate-400 font-medium"
                  >
                    取消
                  </PressableButton>
                  <PressableButton
                    onClick={handleSavePosition}
                    className="px-4 py-2 apple-btn-primary font-medium"
                  >
                    保存持仓
                  </PressableButton>
                </div>
              </div>
            </motion.div>
          </ModalShell>
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

                {/* 3. Notification & Watermark */}
                <div className="bg-white/60 dark:bg-white/5 border border-[var(--hairline-border)] rounded-2xl p-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm">📧</span>
                    <div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">预警提醒与水位线</div>
                      <div className="text-[10px] text-slate-400">配置邮件警报接收箱</div>
                    </div>
                  </div>
                  <EmailConfigPanel
                    isAdmin={currentUser.toLowerCase() === 'admin'}
                    currentUser={currentUser}
                    onToast={showToast}
                  />
                </div>

                {/* 4. User Info & Logout */}
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
      <AnimatePresence>
        {selectedFundCode && fundsData[selectedFundCode] && (() => {
          const item = watchlistItems.find(w => w.fund_code === selectedFundCode);
          const isStock = item?.kind === 'stock';
          return (
          <DetailDrawer
            key="detail-drawer"
            onDismiss={() => setSelectedFundCode(null)}
            ariaLabel={isStock ? '股票详情' : '基金详情'}
            title={isStock ? '股票详情' : '基金详情'}
          >
            <FundDetailPanel
              fund={fundsData[selectedFundCode]}
              kind={item?.kind}
              position={positions[selectedFundCode]}
              history={historyMap[selectedFundCode] || []}
              historyLoading={historyLoading}
              basic={basicMap[selectedFundCode]}
              holdings={holdingsMap[selectedFundCode] || []}
              onEditPosition={() => {
                setSelectedFundCode(null);
                setTimeout(() => openEditPosition(selectedFundCode), 280);
              }}
              onToast={showToast}
            />
          </DetailDrawer>
          );
        })()}
      </AnimatePresence>
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
  ariaLabel
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  ariaLabel: string;
}) {
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onDismiss]);

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
        // Click-out dismiss (§7 wayfinding: every screen has a way out)
        if (e.target === e.currentTarget) onDismiss();
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
  title = '详情'
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  ariaLabel: string;
  title?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const drawerRef = useRef<HTMLDivElement>(null);

  // ESC dismiss + scroll lock
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-[60]"
    >
      {/* Scrim — fades in, tap to dismiss */}
      <motion.div
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
        transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
        onClick={onDismiss}
        className="absolute inset-0 bg-slate-950/40"
        style={{
          backdropFilter: prefersReducedMotion ? undefined : 'blur(8px)',
          WebkitBackdropFilter: prefersReducedMotion ? undefined : 'blur(8px)',
        }}
      />

      {/* Drawer surface — slides in from right on md+, from bottom on mobile */}
      <motion.div
        ref={drawerRef}
        initial={
          prefersReducedMotion
            ? { opacity: 0 }
            : { x: '100%' }
        }
        animate={{ x: 0 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { x: '100%' }}
        transition={
          prefersReducedMotion
            ? { duration: 0.2 }
            : { type: 'spring', bounce: 0, duration: 0.42 }
        }
        className="absolute top-0 right-0 bottom-0 w-full md:w-[560px] lg:w-[640px] bg-[var(--canvas-bg)] dark:bg-black shadow-2xl overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Sticky header with always-visible close affordance ── */}
        <div
          className="sticky top-0 z-10 bg-[var(--canvas-bg)]/90 dark:bg-black/90 backdrop-blur-xl border-b border-[var(--hairline-border)] px-4 md:px-5 py-3 flex items-center justify-between"
          data-testid="drawer-header"
        >
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            {title}
          </span>

          {/* Close button — uses motion's native whileTap so onClick is
              never blocked by manual pointer-state capture. */}
          <motion.button
            type="button"
            onClick={onDismiss}
            whileTap={prefersReducedMotion ? undefined : { scale: 0.85 }}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.18 }}
            aria-label="关闭详情"
            title="关闭 (Esc)"
            className="group flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            <X size={16} strokeWidth={2.25} />
            <span className="text-xs font-semibold hidden sm:inline">关闭</span>
          </motion.button>
        </div>

        {/* Top edge highlight — light catching the material */}
        <div className="h-px bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/10 pointer-events-none" />
        <div className="p-3 md:p-5 flex-1">
          {children}
        </div>
      </motion.div>
    </div>
  );
}

export default App;
