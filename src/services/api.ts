// 基金与大盘指数 API 封装服务

export interface GoldPrice {
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  currency: string;
  unit: string;
  name: string;
  source: string;
  symbol: string;
  time?: string;
  date?: string;
}

export interface GoldPricesResponse {
  international: GoldPrice | null;
  domestic: GoldPrice | null;
  london: GoldPrice | null;
  updatedAt: string;
  error: string | null;
}

export interface FundValuation {
  fundcode: string;  // 基金代码
  name: string;      // 基金名称
  jzrq: string;      // 最新官方净值日期
  dwjz: string;      // 最新官方单位净值
  gsz: string;       // 估算当日净值
  gszzl: string;     // 估算当日涨跌幅 (单位为 %，例如 -0.38)
  gztime: string;    // 估算时间
  lastUpdated?: number; // 本地获取时间戳
  capturedAt?: number; // SSE broker 抓取并推送的时间戳
  market?: 'domestic' | 'hk' | 'us' | 'other';  // 板块路由用
  /** 估值/行情来源与时效；capturedAt 仅代表本机获取时间，不代表上游报价时间。 */
  estimate?: boolean;
  estimateMethod?: 'holdings' | 'proxy-etf' | 'proxy-futures';
  navOnly?: boolean;
  officialNavDate?: string;
  proxyTicker?: string;
  proxyIndexName?: string;
  proxyTencentSymbol?: string;
  quoteSource?: string;
  quoteSourceName?: string;
  quoteSourceSymbol?: string;
  quoteSession?: 'regular' | 'postmarket' | 'premarket' | 'overnight' | 'closed';
  quoteTime?: string;
  quoteTimestamp?: number | null;
  quoteAgeMs?: number | null;
  quoteFreshness?: 'fresh' | 'stale' | 'unknown';
  proxyFallbackReason?: string | null;
  /** 个股当日开盘价（A股个股可用；基金无此概念） */
  open?: string;
  /** 个股专属字段（基金不会有） */
  stockSpecific?: {
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
    turnover: number | null;
    change: number | null;
    totalMarketCap?: number | null;
    floatMarketCap?: number | null;
    turnoverRate?: number | null;
    /** A 股资金流向（东财 push2 字段 f137/f140/f143/f146/f149） */
    flow?: {
      current: number;
      /** 主力净流入额（元）= 特大单 + 大单 ≈ f137 */
      mainNet: number;
      /** 特大单净流入额（元）= f140 */
      superLargeNet: number;
      /** 大单净流入额（元）= f143 */
      largeNet: number;
      /** 中单净流入额（元）= f146 */
      mediumNet: number;
      /** 小单净流入额（元）= f149 */
      smallNet: number;
      /** 主力 = 特大 + 大 自校验值，调试用 */
      mainDerived?: number;
      /** 数据来源标记：'push2' | 'push2delay' */
      _source?: string;
    };
  };
}

export interface MarketIndex {
  code: string;      // 代码，例如 s_sh000001
  name: string;      // 名称，例如 上证指数
  price: number;     // 最新点数
  change: number;    // 涨跌额
  changePercent: number; // 涨跌幅 (%)
  status: 'open' | 'closed'; // 交易状态
}

export interface UserPosition {
  fund_code: string;
  shares: number;
  cost: number;
  updated_at?: string;
}

// 统一添加用户名请求头的 fetch 包装器
async function request(url: string, options: RequestInit = {}): Promise<any> {
  const username = localStorage.getItem('fund_user_name') || 'guest';
  const headers = {
    ...options.headers,
    'Content-Type': 'application/json',
    'X-User-Name': username
  };

  // 拼接 _t 时间戳防 304 缓存
  const finalUrl = url.includes('?') ? `${url}&_t=${Date.now()}` : `${url}?_t=${Date.now()}`;

  const response = await fetch(finalUrl, { cache: 'no-store', ...options, headers });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

/**
 * 验证/登录用户（需要密码）
 */
export async function loginUser(
  username: string,
  password: string
): Promise<{ success: boolean; user: { id: number; username: string }; created?: boolean }> {
  localStorage.setItem('fund_user_name', username);
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

/**
 * 获取大盘指数数据
 */
export async function fetchMarketIndices(): Promise<MarketIndex[]> {
  try {
    return await request('/api/market/indices');
  } catch (error) {
    console.error('获取大盘数据失败:', error);
    return [];
  }
}

/**
 * SSE 订阅：监听后端实时推送的估值更新
 *
 * 行为：
 *   - 用 EventSource 建立长连接，后端每次拿到上游就立即推送
 *   - 上游节拍差异（股票 10s / 基金 60s）已由服务端按种类分流
 *   - 自动重连：内置 onerror + readyState 监控，3 秒后 retry
 *   - 返回 disposer() 调用即可断开订阅
 */
export type RealtimeTick = {
  code: string;
  val: FundValuation;
  capturedAt: number;
};

/** 后端推送的"该 code 已收盘 + 1 分钟"事件 */
export type RealtimeClosed = {
  code: string;
  kind: string;
  lastVal: FundValuation | null;
  closedAt: number;
};

export type RealtimeOptions = {
  codes: string[];
  kind?: 'stock' | 'fund';
  /** 可选：市场类别，透传给 broker 用于收盘判定 */
  market?: 'domestic' | 'hk' | 'us' | 'other';
  onTick?: (tick: RealtimeTick) => void;
  onClosed?: (closed: RealtimeClosed) => void;
  onReady?: () => void;
  onError?: (err: unknown) => void;
};

export function subscribeValuations(opts: RealtimeOptions): () => void {
  const { codes, kind = 'stock', market, onTick, onClosed, onReady, onError } = opts;
  if (!codes || codes.length === 0) return () => {};

  let es: EventSource | null = null;
  let closed = false;
  let retryTimer: number | null = null;

  const open = () => {
    if (closed) return;
    const params = new URLSearchParams();
    params.set('codes', codes.join(','));
    params.set('kind', kind);
    if (market) params.set('market', market);
    params.set('_t', String(Date.now()));
    const url = `/api/stream/valuations?${params.toString()}`;
    try {
      es = new EventSource(url);
    } catch (e) {
      onError?.(e);
      scheduleRetry();
      return;
    }
    es.addEventListener('ready', () => onReady?.());
    es.addEventListener('tick', (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as RealtimeTick;
        onTick?.(data);
      } catch (e) {
        // 忽略解析错误
      }
    });
    es.addEventListener('closed', (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as RealtimeClosed;
        onClosed?.(data);
      } catch {}
    });
    es.onerror = (ev) => {
      if (closed) return;
      onError?.(ev);
      try { es?.close(); } catch {}
      scheduleRetry();
    };
  };

  const scheduleRetry = () => {
    if (closed) return;
    if (retryTimer != null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      open();
    }, 3000);
  };

  open();

  return () => {
    closed = true;
    if (retryTimer != null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (es) {
      try { es.close(); } catch {}
      es = null;
    }
  };
}

/**
 * 获取金价（国际 COMEX / 国内 SGE Au99.99 / 伦敦 XAU spot）
 */
export async function fetchGoldPrices(): Promise<GoldPricesResponse | null> {
  try {
    return await request('/api/market/gold');
  } catch (error) {
    console.error('获取金价失败:', error);
    return null;
  }
}

/**
 * 服务端累积的金价历史快照（最近 ~31 天，新用户立即可见）
 * range: 'intraday' (24h) | '1W' (7d) | '1M' (30d)
 * key: 'international' | 'domestic' | 'london'
 */
export interface GoldHistoryResponse {
  key: string;
  range: string;
  points: { t: number; v: number }[];
  count: number;
}

export async function fetchGoldHistory(
  key: 'international' | 'domestic' | 'london',
  range: 'intraday' | '1W' | '1M' = 'intraday'
): Promise<GoldHistoryResponse | null> {
  try {
    return await request(`/api/market/gold/${key}/history?range=${range}`);
  } catch (error) {
    console.error(`获取 ${key} ${range} 历史失败:`, error);
    return null;
  }
}

/**
 * 获取国内场外基金实时估值
 */
export async function fetchFundValuation(code: string, kind?: 'fund' | 'stock'): Promise<FundValuation | null> {
  try {
    const q = kind ? `?kind=${kind}` : '';
    const value = await request(`/api/market/fund/${code}${q}`) as FundValuation | null;
    return value ? { ...value, capturedAt: value.capturedAt ?? Date.now() } : null;
  } catch (error) {
    console.error(`获取基金 ${code} 失败:`, error);
    return null;
  }
}

/**
 * 获取基金历史单位净值
 * 场外基金每个交易日只公布一个官方净值，没有分时 K 线
 */
export interface FundHistoryPoint {
  date: string;        // YYYY-MM-DD
  dwjz: number;        // 单位净值
  /** 10 周期简单移动平均（基于历史 dwjz 计算）。少于 10 个交易日时为 null */
  ma10?: number | null;
}

/**
 * 个股分钟级 K 线（用于分时图 hover 显示真实每分钟成交量/成交额）
 * A 股来自 Sina / 港股来自腾讯 / 美股暂无公开接口（返回 data: null）
 */
export interface StockMinutePoint {
  time: string;          // "YYYY-MM-DD HH:MM:SS"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;        // 股（A 股 UI 显示需 /100 转"手"）
  amount: number;        // 元
}

export interface StockMinuteResponse {
  code: string;
  market: string;
  data: StockMinutePoint[] | null;
}

export async function fetchStockMinute(
  code: string,
  kind: 'fund' | 'stock' = 'stock',
  market?: string
): Promise<StockMinuteResponse | null> {
  try {
    const marketQuery = market ? `&market=${encodeURIComponent(market)}` : '';
    const data = await request(`/api/market/fund/${code}/minute?kind=${kind}${marketQuery}`);
    return data as StockMinuteResponse;
  } catch (error) {
    console.error(`获取分钟数据 ${code} 失败:`, error);
    return null;
  }
}

export async function fetchFundHistory(
  code: string,
  days: number = 30,
  kind?: 'fund' | 'stock'
): Promise<FundHistoryPoint[]> {
  try {
    const q = kind ? `&kind=${kind}` : "";
    const data = await request(`/api/market/fund/${code}/history?days=${days}${q}`);
    return data.data || [];
  } catch (error) {
    console.error(`获取基金 ${code} 历史净值失败:`, error);
    return [];
  }
}

/**
 * 基金基本信息（来自天天基金 pingzhongdata）：
 *   基金经理、资产配置、阶段收益、风险等级等
 */
export interface FundBasicInfo {
  code: string;
  name: string;
  manager: {
    name: string;
    workTime: string;
    star: number;
    fundSize: string;
    pic?: string;
    power?: { avr: string; data: number[]; categories: string[] };
  } | null;
  assetAllocation: {
    stock: number | null;
    bond: number | null;
    cash: number | null;
    reportDate: string | null;
  };
  returns: {
    m1: number | null;
    m3: number | null;
    m6: number | null;
    y1: number | null;
  };
  /** 基金净资产规模（亿）— 来自 Data_fluctuationScale 最新一季 */
  scale: {
    size: number | null;
    changePct: number | null;
    reportDate: string | null;
  };
}

export async function fetchFundBasic(code: string): Promise<FundBasicInfo | null> {
  try {
    return await request(`/api/market/fund/${code}/basic`);
  } catch (error) {
    console.error(`获取基金 ${code} 基本信息失败:`, error);
    return null;
  }
}

/**
 * 基金前十大重仓股票
 * 注：免费 API 不提供单只股票占比，仅展示代码、名称、当日涨跌幅
 */
export interface FundHoldingStock {
  code: string;
  exchange: 'SH' | 'SZ' | 'HK' | 'US' | 'JP' | 'KR' | '';
  displayCode: string;
  name: string;
  price: number | null;
  currency?: 'CNY' | 'HKD' | 'USD' | 'JPY' | 'KRW';
  priceCny?: number | null;
  fxRateToCny?: number | null;
  fxStale?: boolean;
  quoteSource?: string | null;
  changePct: number | null;
}

export async function fetchFundHoldings(code: string): Promise<FundHoldingStock[]> {
  try {
    const data = await request(`/api/market/fund/${code}/holdings`);
    return data.holdings || [];
  } catch (error) {
    console.error(`获取基金 ${code} 持仓失败:`, error);
    return [];
  }
}

/* ───────────────────────────────────────────────────────────────────
   价格提醒 (Alerts)
   ─────────────────────────────────────────────────────────────────── */

export interface AlertItem {
  id: number;
  fund_code: string;
  fund_name: string | null;
  email: string;
  up_threshold: number | null;
  down_threshold: number | null;
  reference_price: number | null;
  is_active: number;                       // 0 / 1
  last_triggered_at: string | null;
  last_triggered_change_pct: number | null;
  created_at: string;
}

export interface AlertHistoryItem {
  id: number;
  alert_id: number;
  fund_code: string;
  fund_name: string | null;
  email: string;
  direction: 'up' | 'down';
  change_pct: number;
  current_price: number;
  reference_price: number | null;
  message_id: string | null;
  sent_ok: number;
  error: string | null;
  sent_at: string;
}

export async function fetchAlerts(): Promise<AlertItem[]> {
  try {
    const data = await request('/api/alerts');
    return data.alerts || [];
  } catch (error) {
    console.error('获取提醒列表失败:', error);
    return [];
  }
}

export async function fetchAlertHistory(limit: number = 10): Promise<{ history: AlertHistoryItem[]; ethereal: boolean }> {
  try {
    return await request(`/api/alerts/history?limit=${limit}`);
  } catch (error) {
    console.error('获取提醒历史失败:', error);
    return { history: [], ethereal: false };
  }
}

export async function createAlert(params: {
  fund_code: string;
  fund_name?: string;
  email: string;
  up_threshold?: number | null;
  down_threshold?: number | null;
}): Promise<{ success: boolean; id: number; reference_price: number | null; message: string }> {
  return request('/api/alerts', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}

export async function updateAlert(id: number, params: {
  is_active?: boolean;
  up_threshold?: number | null;
  down_threshold?: number | null;
}): Promise<{ success: boolean }> {
  return request(`/api/alerts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(params)
  });
}

export async function deleteAlert(id: number): Promise<{ success: boolean }> {
  return request(`/api/alerts/${id}`, { method: 'DELETE' });
}

export async function sendTestEmail(email: string): Promise<{ success: boolean; previewUrl?: string; mode?: string }> {
  return request('/api/alerts/test-email', {
    method: 'POST',
    body: JSON.stringify({ email })
  });
}

/* ───────────────────────────────────────────────────────────────────
   提醒全局设置（Alert Settings）
   ─────────────────────────────────────────────────────────────────── */

export interface AlertSettings {
  stopAfterMarketClose: boolean;
}

export async function fetchAlertSettings(): Promise<AlertSettings> {
  try {
    return await request('/api/alerts/settings');
  } catch (error) {
    console.error('获取提醒设置失败:', error);
    return { stopAfterMarketClose: true };   // 失败时按默认值（保守：停止）
  }
}

export async function saveAlertSettings(updates: { stopAfterMarketClose?: boolean }): Promise<{ success: boolean; stopAfterMarketClose: boolean }> {
  return request('/api/alerts/settings', {
    method: 'PUT',
    body: JSON.stringify(updates)
  });
}

/* ───────────────────────────────────────────────────────────────────
   邮件配置（Email Config）
   ─────────────────────────────────────────────────────────────────── */

export interface EmailStatus {
  mode: string;                          // 'dev' | 'resend' | 'smtp'
  resendConfigured: boolean;
  smtpConfigured: boolean;
  mailFrom: string;
  appName: string;
  effectiveMode: string;
}

export async function fetchEmailStatus(): Promise<EmailStatus> {
  return request('/api/email/config');
}

export interface EmailSecrets {
  resend_api_key: string;
  smtp_pass: string;
  mail_from: string;
  app_name: string;
}

export async function fetchEmailSecrets(): Promise<EmailSecrets> {
  return request('/api/email/config/reveal');
}

export async function saveEmailConfig(updates: Record<string, string>): Promise<{ success: boolean; status: EmailStatus }> {
  return request('/api/email/config', {
    method: 'PUT',
    body: JSON.stringify(updates)
  });
}

/**
 * 自选条目（含 kind/market/sector/note 元数据）
 */
export interface WatchlistItem {
  fund_code: string;
  kind: 'fund' | 'stock';
  market?: 'domestic' | 'hk' | 'us' | 'other';
  sector?: string;
  note?: string;
  created_at?: string;
}

/**
 * 获取自选列表（可按 kind 过滤）
 */
export async function fetchWatchlist(kind?: 'fund' | 'stock'): Promise<{ codes: string[]; items: WatchlistItem[] }> {
  try {
    const data = await request(kind ? `/api/watchlist?kind=${kind}` : '/api/watchlist');
    return { codes: data.codes || [], items: data.items || [] };
  } catch (error) {
    console.error('获取自选列表失败:', error);
    return { codes: [], items: [] };
  }
}

/**
 * 添加自选（支持基金 + 个股）
 */
export interface AddWatchlistResult {
  success: boolean;
  expectedKind?: 'stock';
  prompt?: { type: 'listed_etf_wrong_tab'; title: string; message: string };
  added: boolean;
  duplicate: boolean;
  moved: boolean;
  requestedKind: 'fund' | 'stock';
  code: string;
  kind: 'fund' | 'stock';
  market: 'domestic' | 'hk' | 'us' | 'other';
  sector?: string;
  resolvedAs?: 'listed_etf_stock' | 'listed_etf_candidate_unverified' | null;
  quote?: FundValuation | null;
  message: string;
}

export async function addWatchlistItem(params: {
  code: string;
  kind?: 'fund' | 'stock';
  market?: 'domestic' | 'hk' | 'us' | 'other';
  sector?: string;
  note?: string;
}): Promise<AddWatchlistResult> {
  return request('/api/watchlist', { method: 'POST', body: JSON.stringify(params) });
}

export async function updateWatchlistItem(code: string, params: { sector?: string; note?: string; market?: string; kind?: 'fund' | 'stock' }) {
  return request(`/api/watchlist/${code}`, { method: 'PATCH', body: JSON.stringify(params) });
}

export interface ListedEtfRepairResult {
  success: boolean;
  applied: boolean;
  scanned: number;
  candidates: number;
  verified: number;
  updated: number;
  updatedCodes: string[];
  skipped: Array<{ code: string; reason: string }>;
}

/** 修复旧版本中误归为基金的、已通过交易所报价验证的场内 ETF。 */
export async function repairListedEtfWatchlist(): Promise<ListedEtfRepairResult> {
  return request('/api/watchlist/repair-listed-etfs', {
    method: 'POST',
    body: JSON.stringify({ apply: true }),
  });
}

/**
 * 拖动排序：把指定 kind 下的 codes 数组批量持久化为新的 sort_order
 * 服务端单事务原子写入；调用失败时调用方应回滚本地顺序。
 */
export async function reorderWatchlist(
  kind: 'fund' | 'stock',
  codes: string[]
): Promise<{ success: boolean; kind: string; count: number }> {
  return request('/api/watchlist/order', {
    method: 'PUT',
    body: JSON.stringify({ kind, codes })
  });
}

/**
 * 名称搜索：按关键字搜基金/股票，返回候选 (code, name, market, kind)
 * 用于前端添加自选时的实时下拉
 */
export interface SearchResult {
  code: string;
  name: string;
  market: 'domestic' | 'hk' | 'us' | 'other';
  kind: 'fund' | 'stock';
}

export async function searchByName(
  query: string,
  kind: 'fund' | 'stock' = 'fund'
): Promise<SearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  try {
    const data = await request(`/api/market/search?q=${encodeURIComponent(q)}&kind=${kind}`);
    return data.results || [];
  } catch (error) {
    console.error(`名称搜索失败 [${q}]:`, error);
    return [];
  }
}

/* 板块 API */
export interface SectorGroup {
  sector: string;
  items: Array<{
    code: string;
    name: string;
    market: string;
    kind: string;
    value: number;
    cost: number;
    todayProfit: number;
    changePct: number;
  }>;
  totalValue: number;
  totalCost: number;
  totalTodayProfit: number;
  totalProfit: number;
  weight: number;
}

export async function fetchSectorBreakdown(): Promise<{
  sectors: string[];
  colors: Record<string, string>;
  groups: SectorGroup[];
  totalValue: number;
}> {
  return request('/api/sectors/breakdown');
}

export async function fetchSectors(): Promise<{ sectors: string[]; colors: Record<string, string> }> {
  return request('/api/sectors');
}

/**
 * 添加自选基金
 */
export async function addToWatchlist(code: string): Promise<boolean> {
  try {
    const res = await request('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    return !!res.success;
  } catch (error) {
    console.error('添加自选失败:', error);
    throw error;
  }
}

/**
 * 移除自选基金
 */
export async function removeFromWatchlist(code: string): Promise<boolean> {
  try {
    const res = await request(`/api/watchlist/${code}`, {
      method: 'DELETE'
    });
    return !!res.success;
  } catch (error) {
    console.error('删除自选失败:', error);
    return false;
  }
}

/**
 * 获取用户所有持仓
 */
export async function fetchPositions(): Promise<UserPosition[]> {
  try {
    return await request('/api/positions');
  } catch (error) {
    console.error('获取持仓失败:', error);
    return [];
  }
}

/**
 * 保存或修改持仓记录
 */
export async function savePosition(code: string, shares: number, cost: number): Promise<boolean> {
  try {
    const res = await request('/api/positions', {
      method: 'POST',
      body: JSON.stringify({ code, shares, cost })
    });
    return !!res.success;
  } catch (error) {
    console.error('保存持仓失败:', error);
    throw error;
  }
}

/**
 * 清除某只基金的持仓
 */
export async function removePosition(code: string): Promise<boolean> {
  try {
    const res = await request(`/api/positions/${code}`, {
      method: 'DELETE'
    });
    return !!res.success;
  } catch (error) {
    console.error('删除持仓失败:', error);
    return false;
  }
}
