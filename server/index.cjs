const express = require('express');
const cors = require('cors');
const dbHelper = require('./db.cjs');
const marketHelper = require('./market.cjs');
const mailer = require('./mailer.cjs');
const { hashPassword, verifyPassword, passwordMeetsPolicy } = require('./auth.cjs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// 中间件：多用户数据隔离 (Auth Middleware)
// ==========================================
// 每次请求必须携带 X-User-Name 请求头
// 自动在数据库中查找该用户，如果不存在则隐式创建它，并将 user_id 附加在 req 上
async function userIsolationMiddleware(req, res, next) {
  // 对于大盘行情 + 登录端点，不需要用户隔离
  if (req.path.startsWith('/api/market/') || req.path === '/api/auth/login') {
    return next();
  }

  const username = req.header('X-User-Name');
  if (!username || !username.trim()) {
    return res.status(401).json({ error: '未提供 X-User-Name 用户身份标识凭证' });
  }

  const sanitizedUsername = username.trim().toLowerCase();

  try {
    // 查找用户
    let user = await dbHelper.get('SELECT * FROM users WHERE LOWER(username) = ?', [sanitizedUsername]);

    if (!user) {
      // 隐式自动注册用户
      const result = await dbHelper.run('INSERT INTO users (username) VALUES (?)', [username.trim()]);
      user = { id: result.lastID, username: username.trim() };
      console.log(`[用户管理] 自动创建新用户: ${username.trim()} (ID: ${user.id})`);
    }

    // 绑定到 request 对象
    req.userId = user.id;
    req.username = user.username;
    next();
  } catch (error) {
    console.error('用户认证拦截失败:', error);
    res.status(500).json({ error: '服务器内部用户识别错误' });
  }
}

app.use(userIsolationMiddleware);

// ==========================================
// 1. 用户会话接口 (Auth Routes)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: '用户名不能为空' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: '密码不能为空' });
  }
  const trimmedName = username.trim();
  const normalizedName = trimmedName.toLowerCase();

  try {
    // 查找现有用户（不自动创建）
    const user = await dbHelper.get(
      'SELECT * FROM users WHERE LOWER(username) = ?',
      [normalizedName]
    );

    if (!user) {
      // 新用户 → 注册。需要密码强度校验。
      if (!passwordMeetsPolicy(password)) {
        return res.status(400).json({
          error: '密码至少 4 个字符且必须包含字母'
        });
      }
      const hash = hashPassword(password);
      const result = await dbHelper.run(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
        [trimmedName, hash]
      );
      return res.json({
        success: true,
        user: { id: result.lastID, username: trimmedName },
        created: true
      });
    }

    // 现有用户 → 必须有密码哈希（旧账号若无密码：返回错误让用户联系 admin）
    if (!user.password_hash) {
      return res.status(403).json({
        error: '该账号尚未设置密码，请联系管理员初始化'
      });
    }

    // 校验密码
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: '密码错误' });
    }

    res.json({
      success: true,
      user: { id: user.id, username: user.username }
    });
  } catch (error) {
    console.error('[login] error:', error);
    res.status(500).json({ error: '登录失败：' + (error.message || '服务器错误') });
  }
});

// ==========================================
// 2. 自选基金接口 (Watchlist Routes)
// ==========================================

// 获取用户的自选基金代码列表
app.get('/api/watchlist', async (req, res) => {
  try {
    const rows = await dbHelper.all('SELECT fund_code FROM watchlist WHERE user_id = ? ORDER BY created_at ASC', [req.userId]);
    const codes = rows.map(r => r.fund_code);
    res.json({ codes });
  } catch (error) {
    res.status(500).json({ error: '获取自选列表失败' });
  }
});

// 添加自选基金
app.post('/api/watchlist', async (req, res) => {
  const { code } = req.body;
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '无效的6位基金代码' });
  }

  try {
    await dbHelper.run(
      'INSERT OR IGNORE INTO watchlist (user_id, fund_code) VALUES (?, ?)',
      [req.userId, code]
    );
    res.json({ success: true, message: '成功添加至自选' });
  } catch (error) {
    res.status(500).json({ error: '添加自选失败' });
  }
});

// 移除自选基金（同时移除持仓）
app.delete('/api/watchlist/:code', async (req, res) => {
  const { code } = req.params;

  try {
    await dbHelper.run('DELETE FROM watchlist WHERE user_id = ? AND fund_code = ?', [req.userId, code]);
    await dbHelper.run('DELETE FROM positions WHERE user_id = ? AND fund_code = ?', [req.userId, code]);
    res.json({ success: true, message: '成功从自选和持仓中移除' });
  } catch (error) {
    res.status(500).json({ error: '删除失败' });
  }
});

// ==========================================
// 3. 用户持仓接口 (Positions Routes)
// ==========================================

// 获取当前用户的所有持仓
app.get('/api/positions', async (req, res) => {
  try {
    const rows = await dbHelper.all(
      'SELECT fund_code, shares, cost FROM positions WHERE user_id = ?',
      [req.userId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: '获取持仓失败' });
  }
});

// 修改或录入某只基金的持仓
app.post('/api/positions', async (req, res) => {
  const { code, shares, cost } = req.body;
  const numShares = parseFloat(shares);
  const numCost = parseFloat(cost);

  if (!code || isNaN(numShares) || numShares <= 0 || isNaN(numCost) || numCost <= 0) {
    return res.status(400).json({ error: '持有份额和成本单价必须大于0' });
  }

  try {
    // 检查此基金是否在自选中，如果不在则先加入自选
    await dbHelper.run('INSERT OR IGNORE INTO watchlist (user_id, fund_code) VALUES (?, ?)', [req.userId, code]);

    // 插入或更新持仓
    await dbHelper.run(`
      INSERT INTO positions (user_id, fund_code, shares, cost)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, fund_code)
      DO UPDATE SET shares = excluded.shares, cost = excluded.cost, updated_at = CURRENT_TIMESTAMP
    `, [req.userId, code, numShares, numCost]);

    res.json({ success: true, message: '持仓记录已更新' });
  } catch (error) {
    res.status(500).json({ error: '保存持仓失败' });
  }
});

// 清空/删除某只基金的持仓
app.delete('/api/positions/:code', async (req, res) => {
  const { code } = req.params;
  try {
    await dbHelper.run('DELETE FROM positions WHERE user_id = ? AND fund_code = ?', [req.userId, code]);
    res.json({ success: true, message: '持仓已清除' });
  } catch (error) {
    res.status(500).json({ error: '清除持仓失败' });
  }
});

// ==========================================
// 4. 公共行情接口 (Market Proxy Routes)
// ==========================================

// 获取全球大盘指数
app.get('/api/market/indices', async (req, res) => {
  try {
    const data = await marketHelper.getMarketIndices();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: '获取指数失败' });
  }
});

// 获取某只基金/股票估值（统一入口，按 code 格式自动路由数据源）
app.get('/api/market/fund/:code', async (req, res) => {
  const { code } = req.params;
  // 接受：A 股 6 位 / 港股 5 位 / 美股 1-5 位字母 / 带 HK/US 前缀
  if (!code || !/^(\d{6}|\d{4,5}|[A-Za-z]{1,5}|(HK|hk|rt_hk|US|us|gb_)[\w]{1,6})$/.test(code)) {
    return res.status(400).json({ error: '代码格式不正确（需为 A 股 6 位、港股 5 位或美股 ticker）' });
  }

  try {
    const data = await marketHelper.getFundValuation(code);
    if (!data) {
      return res.status(404).json({ error: '未找到该基金/股票或获取失败' });
    }
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: '获取估值失败' });
  }
});

// 获取某只基金历史单位净值（用于走势图）
// 场外基金每个交易日只公布一个官方净值，没有分时 K 线
app.get('/api/market/fund/:code/history', async (req, res) => {
  const { code } = req.params;
  const days = Math.max(1, Math.min(parseInt(req.query.days) || 30, 90));

  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '基金代码格式不正确' });
  }

  try {
    const data = await marketHelper.getFundHistory(code, days);
    res.json({ code, days, data });
  } catch (error) {
    res.status(500).json({ error: '获取基金历史净值失败' });
  }
});

// 获取某只基金基本信息（基金经理、资产配置、阶段收益）
app.get('/api/market/fund/:code/basic', async (req, res) => {
  const { code } = req.params;
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '基金代码格式不正确' });
  }
  try {
    const data = await marketHelper.getFundBasicInfo(code);
    if (!data) {
      return res.status(404).json({ error: '未找到该基金的基本信息' });
    }
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: '获取基金基本信息失败' });
  }
});

// 获取某只基金前十大重仓股票（代码 + 名称 + 实时涨跌幅）
// 注：免费 API 不提供单只股票占比，仅展示代码、名称、当日涨跌幅
app.get('/api/market/fund/:code/holdings', async (req, res) => {
  const { code } = req.params;
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '基金代码格式不正确' });
  }
  try {
    const data = await marketHelper.getFundHoldings(code);
    res.json({ code, holdings: data });
  } catch (error) {
    res.status(500).json({ error: '获取基金持仓失败' });
  }
});

// ==========================================
// 5. 价格提醒接口 (Alerts Routes)
// ==========================================

// 列出当前用户的所有提醒
app.get('/api/alerts', async (req, res) => {
  try {
    const rows = await dbHelper.all(
      `SELECT id, fund_code, fund_name, email, up_threshold, down_threshold,
              reference_price, is_active, last_triggered_at, last_triggered_change_pct, created_at
       FROM alerts WHERE user_id = ? ORDER BY id DESC`,
      [req.userId]
    );
    res.json({ alerts: rows });
  } catch (error) {
    res.status(500).json({ error: '获取提醒列表失败' });
  }
});

// 列出当前用户的提醒发送历史
app.get('/api/alerts/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const rows = await dbHelper.all(
      `SELECT id, alert_id, fund_code, fund_name, email, direction, change_pct,
              current_price, reference_price, message_id, sent_ok, error, sent_at
       FROM alert_history WHERE user_id = ? ORDER BY sent_at DESC LIMIT ?`,
      [req.userId, limit]
    );
    res.json({ history: rows, ethereal: mailer.isUsingEthereal() });
  } catch (error) {
    res.status(500).json({ error: '获取提醒历史失败' });
  }
});

// 创建提醒
app.post('/api/alerts', async (req, res) => {
  const { fund_code, fund_name, email, up_threshold, down_threshold } = req.body || {};
  if (!fund_code || !/^\d{6}$/.test(fund_code)) {
    return res.status(400).json({ error: '基金代码格式不正确' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  if (up_threshold == null && down_threshold == null) {
    return res.status(400).json({ error: '请至少设置一个涨跌阈值' });
  }
  const up = up_threshold != null ? Number(up_threshold) : null;
  const down = down_threshold != null ? Number(down_threshold) : null;
  if (up != null && (!Number.isFinite(up) || up <= 0 || up > 50)) {
    return res.status(400).json({ error: '上涨阈值需在 0%–50% 之间' });
  }
  if (down != null && (!Number.isFinite(down) || down <= 0 || down > 50)) {
    return res.status(400).json({ error: '下跌阈值需在 0%–50% 之间' });
  }

  try {
    // 用当前估值作为基准
    const fund = await marketHelper.getFundValuation(fund_code);
    const ref = fund ? parseFloat(fund.gsz) || parseFloat(fund.dwjz) : null;

    const result = await dbHelper.run(
      `INSERT INTO alerts
         (user_id, fund_code, fund_name, email, up_threshold, down_threshold, reference_price, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [req.userId, fund_code, fund_name || fund?.name || fund_code, email, up, down, ref]
    );
    res.json({
      success: true,
      id: result.lastID,
      message: ref
        ? `已创建提醒，基准净值 ${ref.toFixed(4)}`
        : '已创建提醒（暂未获取到基准净值，触发判断会在首次刷新时建立）',
      reference_price: ref
    });
  } catch (error) {
    console.error('创建提醒失败:', error);
    res.status(500).json({ error: '创建提醒失败' });
  }
});

// 更新提醒（启停、修改阈值）
app.put('/api/alerts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 不合法' });

  const { is_active, up_threshold, down_threshold } = req.body || {};
  const sets = [];
  const params = [];
  if (typeof is_active === 'boolean' || is_active === 0 || is_active === 1) {
    sets.push('is_active = ?');
    params.push(is_active ? 1 : 0);
  }
  if (up_threshold !== undefined) {
    sets.push('up_threshold = ?');
    params.push(up_threshold === null ? null : Number(up_threshold));
  }
  if (down_threshold !== undefined) {
    sets.push('down_threshold = ?');
    params.push(down_threshold === null ? null : Number(down_threshold));
  }
  if (!sets.length) return res.status(400).json({ error: '无有效更新字段' });

  try {
    params.push(id, req.userId);
    const r = await dbHelper.run(
      `UPDATE alerts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
      params
    );
    if (r.changes === 0) return res.status(404).json({ error: '未找到该提醒' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: '更新提醒失败' });
  }
});

// 删除提醒
app.delete('/api/alerts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 不合法' });
  try {
    const r = await dbHelper.run('DELETE FROM alerts WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (r.changes === 0) return res.status(404).json({ error: '未找到该提醒' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: '删除提醒失败' });
  }
});

// 发送测试邮件（验证 SMTP 配置 + 邮箱可送达）
app.post('/api/alerts/test-email', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  try {
    const r = await mailer.sendAlertEmail({
      to: email,
      fundCode: '000000',
      fundName: '【测试】基金监控终端',
      direction: 'up',
      changePct: 0.01,
      currentPrice: 1.0000,
      referencePrice: 1.0000
    });
    res.json({
      success: true,
      mode: r.mode,
      messageId: r.messageId,
      previewUrl: r.previewUrl
    });
  } catch (e) {
    res.status(500).json({ error: '邮件发送失败: ' + e.message });
  }
});

// ==========================================
// 6. 邮件配置接口（Email Config — admin only）
// ==========================================

/**
 * 检查当前用户是否为 admin。image-indx 用 is_admin 字段标记首注册用户。
 * 这里复用 user 表结构：如果 username 是 'admin' 则视为 admin。
 * 首次启动时把 'admin' 标记为 admin。
 */
function requireAdmin(req, res, next) {
  const user = req.username;
  if (!user) return res.status(401).json({ error: '需要登录' });
  if (user.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: '仅管理员可操作' });
  }
  next();
}

// 首次启动把 'admin' 标记为 admin
dbHelper.run(
  `UPDATE users SET is_admin = 1 WHERE LOWER(username) = 'admin' AND (is_admin IS NULL OR is_admin = 0)`
).catch(() => { /* 列不存在时忽略 */ });

// 先尝试添加 is_admin 列（如果还没有）
dbHelper.run(
  `ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`
).catch(() => { /* 已存在时忽略 */ });

// 查看邮件配置状态（所有用户都能看，但只显示配置概况，不暴露密钥）
app.get('/api/email/config', async (req, res) => {
  try {
    const status = await mailer.getStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新邮件配置（admin only）
app.put('/api/email/config', requireAdmin, async (req, res) => {
  try {
    const status = await mailer.saveConfig(req.body || {});
    res.json({ success: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────
   监控循环：每 30 秒扫一遍所有启用的提醒
   ───────────────────────────────────────────────────────────────── */

const ALERT_POLL_MS = 30 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;          // 同一提醒 30 分钟内最多触发一次
const MEMO_PRICE = new Map();                // fund_code -> last gsz (供历史展示用)

async function pollAlerts() {
  try {
    const rows = await dbHelper.all(
      `SELECT * FROM alerts WHERE is_active = 1 AND (up_threshold IS NOT NULL OR down_threshold IS NOT NULL)`
    );
    if (rows.length === 0) return;

    for (const alert of rows) {
      try {
        const fund = await marketHelper.getFundValuation(alert.fund_code);
        if (!fund) continue;
        const current = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
        if (current <= 0) continue;
        const ref = alert.reference_price || parseFloat(fund.dwjz);
        if (ref <= 0) continue;
        const changePct = ((current - ref) / ref) * 100;

        // 冷启动：第一次拿到参考价时，写回 DB
        if (!alert.reference_price) {
          await dbHelper.run('UPDATE alerts SET reference_price = ? WHERE id = ?', [ref, alert.id]);
        }

        let triggered = null;        // 'up' | 'down'
        if (alert.up_threshold != null && changePct >= alert.up_threshold) triggered = 'up';
        if (alert.down_threshold != null && changePct <= -alert.down_threshold) triggered = 'down';

        if (!triggered) {
          MEMO_PRICE.set(alert.fund_code, current);
          continue;
        }

        // 冷却：上次触发 < 30 分钟则不重发
        if (alert.last_triggered_at) {
          const lastTs = Date.parse(alert.last_triggered_at);
          if (Number.isFinite(lastTs) && Date.now() - lastTs < COOLDOWN_MS) {
            continue;
          }
        }

        // 发送 + 落库
        const sendResult = await mailer.sendAlertEmail({
          to: alert.email,
          fundCode: alert.fund_code,
          fundName: alert.fund_name,
          direction: triggered,
          changePct,
          currentPrice: current,
          referencePrice: ref
        }).catch(e => ({ error: e.message, messageId: null, previewUrl: null }));

        const nowIso = new Date().toISOString();
        const sentOk = sendResult && !sendResult.error ? 1 : 0;

        await dbHelper.run(
          `INSERT INTO alert_history
             (alert_id, user_id, fund_code, fund_name, email, direction,
              change_pct, current_price, reference_price, message_id, sent_ok, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            alert.id, alert.user_id, alert.fund_code, alert.fund_name, alert.email,
            triggered, changePct, current, ref,
            sendResult?.messageId || null, sentOk, sendResult?.error || null
          ]
        );
        await dbHelper.run(
          `UPDATE alerts SET last_triggered_at = ?, last_triggered_change_pct = ? WHERE id = ?`,
          [nowIso, changePct, alert.id]
        );

        console.log(`[alerts] ✓ triggered #${alert.id} ${alert.fund_code} ${triggered} ${changePct.toFixed(2)}%`);
      } catch (innerErr) {
        console.error(`[alerts] error on #${alert.id}:`, innerErr.message);
      }
    }
  } catch (e) {
    console.error('[alerts] poll error:', e.message);
  }
}

setInterval(pollAlerts, ALERT_POLL_MS);
// 启动后延迟 5 秒跑一次，让其他模块先就绪
setTimeout(pollAlerts, 5000);
console.log(`[alerts] 监控循环已启动，每 ${ALERT_POLL_MS / 1000}s 扫描一次`);

// ==========================================
// 启动服务
// ==========================================
app.listen(PORT, () => {
  console.log(`[基金监控全栈系统] 后端API服务已在端口 ${PORT} 启动`);
});
