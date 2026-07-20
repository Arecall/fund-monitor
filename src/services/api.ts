// 基金与大盘指数 API 封装服务

export interface FundValuation {
  fundcode: string;  // 基金代码
  name: string;      // 基金名称
  jzrq: string;      // 最新官方净值日期
  dwjz: string;      // 最新官方单位净值
  gsz: string;       // 估算当日净值
  gszzl: string;     // 估算当日涨跌幅 (单位为 %，例如 -0.38)
  gztime: string;    // 估算时间
  lastUpdated?: number; // 本地获取时间戳
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
}

// 统一添加用户名请求头的 fetch 包装器
async function request(url: string, options: RequestInit = {}): Promise<any> {
  const username = localStorage.getItem('fund_user_name') || 'guest';
  const headers = {
    ...options.headers,
    'Content-Type': 'application/json',
    'X-User-Name': username
  };

  const response = await fetch(url, { ...options, headers });
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
 * 获取国内场外基金实时估值
 */
export async function fetchFundValuation(code: string): Promise<FundValuation | null> {
  try {
    return await request(`/api/market/fund/${code}`);
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
}

export async function fetchFundHistory(
  code: string,
  days: number = 30
): Promise<FundHistoryPoint[]> {
  try {
    const data = await request(`/api/market/fund/${code}/history?days=${days}`);
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
  exchange: 'SH' | 'SZ' | 'HK' | '';
  displayCode: string;
  name: string;
  price: number | null;
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

export async function saveEmailConfig(updates: Record<string, string>): Promise<{ success: boolean; status: EmailStatus }> {
  return request('/api/email/config', {
    method: 'PUT',
    body: JSON.stringify(updates)
  });
}

/**
 * 获取自选基金代码列表
 */
export async function fetchWatchlist(): Promise<string[]> {
  try {
    const data = await request('/api/watchlist');
    return data.codes || [];
  } catch (error) {
    console.error('获取自选列表失败:', error);
    return [];
  }
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
