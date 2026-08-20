const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const dbHelper = require('./db.cjs');
const marketHelper = require('./market.cjs');
const { broker: valuationBroker } = require('./realtime.cjs');
const mailer = require('./mailer.cjs');
const { hashPassword, verifyPassword, passwordMeetsPolicy } = require('./auth.cjs');
const { SECTORS, SECTOR_COLORS, inferStockSector, inferFundSector, classifyHoldings, aggregateBySector } = require('./sectors.cjs');
const marketTime = require('./time.cjs');
const { createHoldingsPrefetch } = require('./holdings-prefetch.cjs');

const app = express();
const PORT = process.env.PORT || 3001;

// 禁用 ETag，防止浏览器把 API 动态数据误判定为 304 Not Modified
app.disable('etag');

// 开启 HTTP Gzip 响应压缩（大幅提升 HTML/JS/CSS/JSON 网络传输速率）
app.use(compression({
  filter: (req, res) => {
    // SSE 流式响应不启用 Gzip 压缩，避免消息延迟滞留
    if (req.path.startsWith('/api/stream/')) return false;
    return compression.filter(req, res);
  }
}));

app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);

// 为所有动态 API 注入防强缓存/防 304 标头
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const DIST_DIR = path.resolve(__dirname, '../dist');
app.use(express.static(DIST_DIR, {
  etag: true,
  setHeaders(res, filePath) {
    const relative = path.relative(DIST_DIR, filePath).replace(/\\/g, '/');
    if (relative.startsWith('assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (relative === 'index.html') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return res.sendFile(path.join(DIST_DIR, 'index.html'));
  }
  next();
});

// ==========================================
// 中间件：多用户数据隔离 (Auth Middleware)
// ==========================================
// 每次请求必须携带 X-User-Name 请求头
// 自动在数据库中查找该用户，如果不存在则隐式创建它，并将 user_id 附加在 req 上
async function userIsolationMiddleware(req, res, next) {
  // 对于大盘行情 + 登录端点 + 实时推送 SSE，不需要用户隔离
  // （推送流是 anonymous 共享的，每个 code 只保持一份抓取循环）
  if (req.path === '/api/health' ||
      req.path.startsWith('/api/market/') ||
      req.path.startsWith('/api/stream/') ||
      req.path === '/api/auth/login') {
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
// 0. 健康检查接口 (Health Route)
// ==========================================
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.4.2' });
});
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

// ==========================================
// 2. 自选基金/股票接口 (Watchlist Routes)
// ==========================================
// 区分 kind: 'fund' (A 股/港股 QDII 基金) | 'stock' (A 股/港股/美股 个股)

// 获取用户的自选（按 kind 过滤）
// 排序：每个 kind 独立的 sort_order 列，所以重排 fund tab 不会影响 stock tab。
app.get('/api/watchlist', async (req, res) => {
  try {
    const kind = req.query.kind;       // 可选: 'fund' | 'stock'
    let sql = `SELECT fund_code, kind, market, sector, note, created_at,
                      fund_sort_order, stock_sort_order
               FROM watchlist WHERE user_id = ?`;
    const params = [req.userId];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    // 按当前激活的 kind 选排序列；不传 kind 时按 kind 分组，各自精确按 sort_order 强制转 INTEGER 数值排序
    if (kind === 'fund') {
      sql += ' ORDER BY CAST(COALESCE(fund_sort_order, id) AS INTEGER) ASC, id ASC';
    } else if (kind === 'stock') {
      sql += ' ORDER BY CAST(COALESCE(stock_sort_order, id) AS INTEGER) ASC, id ASC';
    } else {
      sql += " ORDER BY CASE WHEN kind = 'stock' THEN 1 ELSE 0 END ASC, CASE WHEN kind = 'stock' THEN CAST(COALESCE(stock_sort_order, id) AS INTEGER) ELSE CAST(COALESCE(fund_sort_order, id) AS INTEGER) END ASC, id ASC";
    }
    const rows = await dbHelper.all(sql, params);
    res.json({
      codes: rows.map(r => r.fund_code),
      items: rows,
    });
  } catch (error) {
    res.status(500).json({ error: '获取自选列表失败' });
  }
});

// 添加自选（支持基金 + 个股）。服务端会验证 Fund tab 提交的场内 ETF，并以交易所路径保存。
app.post('/api/watchlist', async (req, res) => {
  const { code: rawCode, kind: requestedKind, market, sector, note } = req.body || {};
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '代码不能为空' });
  if (!/^(\d{6}|\d{4,5}|[A-Z]{1,5})$/.test(code)) return res.status(400).json({ error: '代码格式不正确' });

  let finalKind = requestedKind === 'stock' ? 'stock' : 'fund';
  let finalMarket = market;
  let resolvedAs = null;
  let verifiedQuote = null;
  const listedCandidate = finalKind === 'fund' &&
    marketHelper.getMainlandExchangeSymbol(code, { includeListedEtf: true })?.instrumentType === 'listed_etf';

  // 16xxxx 等有歧义代码也必须真实拿到交易所报价才会切换，绝不按前缀盲改。
  if (listedCandidate) {
    try {
      const quote = await marketHelper.getFundValuation(code, 'stock');
      const price = parseFloat(quote?.gsz);
      if (quote?.market === 'domestic' && quote?.stockSpecific && Number.isFinite(price) && price > 0) {
        // Fund tab 只提示正确归属，绝不静默插入或迁移到股票 Tab。
        return res.json({
          success: false, added: false, duplicate: false, moved: false,
          requestedKind: 'fund', expectedKind: 'stock', code, kind: 'fund', market: 'domestic',
          resolvedAs: 'listed_etf_stock', quote,
          message: '检测到这是场内 ETF，请切换到股票自选后添加以使用交易所实时行情',
          prompt: { type: 'listed_etf_wrong_tab', title: '这是场内 ETF', message: '该代码应在「股票」Tab 添加，是否切换并保留代码？' },
        });
      } else {
        resolvedAs = 'listed_etf_candidate_unverified';
      }
    } catch {
      resolvedAs = 'listed_etf_candidate_unverified';
    }
  }
  if (!finalMarket) {
    if (/^\d{6}$/.test(code)) finalMarket = 'domestic';
    else if (/^\d{4,5}$/.test(code)) finalMarket = 'hk';
    else finalMarket = 'us';
  }

  try {
    const existing = await dbHelper.get('SELECT kind, market, sector FROM watchlist WHERE user_id = ? AND fund_code = ?', [req.userId, code]);
    if (existing) {
      const shouldMove = existing.kind === 'fund' && finalKind === 'stock' && resolvedAs === 'listed_etf_stock';
      if (shouldMove) {
        const maxRow = await dbHelper.get('SELECT COALESCE(MAX(stock_sort_order), 0) AS max_order FROM watchlist WHERE user_id = ?', [req.userId]);
        await dbHelper.run(
          "UPDATE watchlist SET kind = 'stock', market = 'domestic', stock_sort_order = ? WHERE user_id = ? AND fund_code = ?",
          [(maxRow?.max_order || 0) + 1, req.userId, code]
        );
      }
      return res.json({ success: true, added: false, duplicate: !shouldMove, moved: shouldMove, requestedKind: requestedKind || 'fund', code, kind: shouldMove ? 'stock' : existing.kind, market: shouldMove ? 'domestic' : existing.market, sector: existing.sector, resolvedAs, quote: verifiedQuote, message: shouldMove ? '检测到场内 ETF，已切换到股票自选并使用交易所实时行情' : `该代码已在${existing.kind === 'stock' ? '股票' : '基金'}自选中` });
    }

    const finalSector = sector || (finalKind === 'stock' ? inferStockSector(code) : inferFundSector(''));
    const orderCol = finalKind === 'stock' ? 'stock_sort_order' : 'fund_sort_order';
    const maxRow = await dbHelper.get(`SELECT COALESCE(MAX(${orderCol}), 0) AS max_order FROM watchlist WHERE user_id = ?`, [req.userId]);
    const nextOrder = (maxRow?.max_order || 0) + 1;
    await dbHelper.run(
      `INSERT INTO watchlist (user_id, fund_code, kind, market, sector, note, fund_sort_order, stock_sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, code, finalKind, finalMarket, finalSector, note || null, nextOrder, nextOrder]
    );
    res.json({ success: true, added: true, duplicate: false, moved: false, requestedKind: requestedKind || 'fund', code, kind: finalKind, market: finalMarket, sector: finalSector, resolvedAs, quote: verifiedQuote, message: resolvedAs === 'listed_etf_stock' ? '检测到场内 ETF，已添加到股票自选并使用交易所实时行情' : `成功添加至自选（${finalKind === 'stock' ? '股票' : '基金'}）` });
  } catch (error) {
    console.error('[watchlist] add failed:', error.message);
    res.status(500).json({ error: '添加自选失败' });
  }
});

// 修复历史版本错误归类的场内 ETF：仅当前用户、仅原 fund 条目、仅在真实交易所报价验证成功后切换。
app.post('/api/watchlist/repair-listed-etfs', async (req, res) => {
  const apply = req.body?.apply !== false;
  try {
    const rows = await dbHelper.all(
      `SELECT fund_code, kind, market FROM watchlist
       WHERE user_id = ? AND kind = 'fund' AND fund_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
         AND (market IS NULL OR market = '' OR market = 'domestic')`,
      [req.userId]
    );
    const candidates = rows.filter(row =>
      marketHelper.getMainlandExchangeSymbol(row.fund_code, { includeListedEtf: true })?.instrumentType === 'listed_etf'
    );
    const verified = [];
    const skipped = [];
    for (const row of candidates) {
      try {
        const quote = await marketHelper.getFundValuation(row.fund_code, 'stock');
        const price = parseFloat(quote?.gsz);
        if (quote?.market === 'domestic' && quote?.stockSpecific && Number.isFinite(price) && price > 0) {
          verified.push(row.fund_code);
        } else {
          skipped.push({ code: row.fund_code, reason: 'exchange_quote_unavailable' });
        }
      } catch {
        skipped.push({ code: row.fund_code, reason: 'exchange_quote_failed' });
      }
    }
    let updated = 0;
    if (apply && verified.length) {
      await dbHelper.db.exec('BEGIN IMMEDIATE');
      try {
        for (const code of verified) {
          const result = await dbHelper.run(
            `UPDATE watchlist SET kind = 'stock', market = 'domestic'
             WHERE user_id = ? AND fund_code = ? AND kind = 'fund'`,
            [req.userId, code]
          );
          updated += result.changes || 0;
        }
        await dbHelper.db.exec('COMMIT');
      } catch (error) {
        await dbHelper.db.exec('ROLLBACK');
        throw error;
      }
    }
    res.json({ success: true, applied: apply, scanned: rows.length, candidates: candidates.length, verified: verified.length, updated, updatedCodes: apply ? verified : [], skipped });
  } catch (error) {
    console.error('[watchlist] repair listed ETFs failed:', error.message);
    res.status(500).json({ error: '修复场内 ETF 分类失败' });
  }
});

// 更新自选条目（用于设置 sector / note 等）
app.patch('/api/watchlist/:code', async (req, res) => {
  const { code } = req.params;
  const { sector, note, market, kind } = req.body || {};
  const sets = [];
  const params = [];
  if (sector !== undefined) { sets.push('sector = ?'); params.push(sector); }
  if (note !== undefined)   { sets.push('note = ?');   params.push(note); }
  if (market !== undefined) { sets.push('market = ?'); params.push(market); }
  if (kind !== undefined)   { sets.push('kind = ?');   params.push(kind); }
  if (!sets.length) return res.status(400).json({ error: '无有效更新字段' });
  params.push(code, req.userId);
  try {
    const r = await dbHelper.run(
      `UPDATE watchlist SET ${sets.join(', ')} WHERE fund_code = ? AND user_id = ?`,
      params
    );
    if (r.changes === 0) return res.status(404).json({ error: '未找到该自选' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: '更新失败' });
  }
});

// 批量重排某个 kind 下的顺序（前端长按拖动排序落库）
app.put('/api/watchlist/order', async (req, res) => {
  const { kind, codes } = req.body || {};
  console.log('[PUT /api/watchlist/order] kind=', kind, 'codes=', codes);
  if (kind !== 'fund' && kind !== 'stock') {
    return res.status(400).json({ error: 'kind 必须是 fund 或 stock' });
  }
  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'codes 必须是非空数组' });
  }
  const col = kind === 'fund' ? 'fund_sort_order' : 'stock_sort_order';

  try {
    // 1. 校验 codes 全部属于当前用户
    const placeholders = codes.map(() => '?').join(',');
    const rows = await dbHelper.all(
      `SELECT fund_code, kind FROM watchlist
       WHERE user_id = ? AND fund_code IN (${placeholders})`,
      [req.userId, ...codes]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: '指定的自选代码不存在' });
    }

    // 2. 单事务内批量更新（任一失败回滚，避免部分写入）
    await dbHelper.db.exec('BEGIN');
    try {
      for (let i = 0; i < codes.length; i++) {
        await dbHelper.run(
          `UPDATE watchlist SET ${col} = ?, kind = ? WHERE user_id = ? AND fund_code = ?`,
          [parseInt(i + 1, 10), kind, req.userId, String(codes[i])]
        );
      }
      await dbHelper.db.exec('COMMIT');
      console.log('[PUT /api/watchlist/order] COMMIT success, updated', codes.length, 'rows for kind=', kind);
    } catch (e) {
      await dbHelper.db.exec('ROLLBACK');
      throw e;
    }

    res.json({ success: true, kind, count: codes.length });
  } catch (error) {
    console.error('[watchlist order] error:', error.message);
    res.status(500).json({ error: '排序保存失败' });
  }
});

// 移除自选（同时移除持仓）
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
// 2.5 行业板块接口 (Sector Routes)
// ==========================================

// 列出所有支持的行业 + 颜色
app.get('/api/sectors', (_req, res) => {
  res.json({
    sectors: SECTORS,
    colors: SECTOR_COLORS,
  });
});

// 用户的板块分布（按持仓市值聚合）
app.get('/api/sectors/breakdown', async (req, res) => {
  try {
    // 1. 拉用户的 watchlist（含 sector/market/note）
    const watchRows = await dbHelper.all(
      'SELECT fund_code, kind, market, sector, note FROM watchlist WHERE user_id = ?',
      [req.userId]
    ).catch(async () => {
      return await dbHelper.all(
        'SELECT fund_code FROM watchlist WHERE user_id = ?',
        [req.userId]
      ).then(rows => rows.map(r => ({ ...r, kind: 'fund', market: 'domestic', sector: null, note: null })));
    });

    // 2. 拉持仓
    const positions = await dbHelper.all(
      'SELECT fund_code, shares, cost FROM positions WHERE user_id = ?',
      [req.userId]
    );
    const posMap = Object.fromEntries(positions.map(p => [p.fund_code, p]));

    // 3. 对每只拉实时估值（并发处理，提高响应性能）
    const itemResults = await Promise.all(
      watchRows.map(async (w) => {
        try {
          const fund = await marketHelper.getFundValuation(w.fund_code, w.kind || 'fund');
          if (!fund) return null;
          const pos = posMap[w.fund_code];
          const current = parseFloat(fund.gsz) || parseFloat(fund.dwjz) || 0;
          const prev = parseFloat(fund.dwjz) || 0;
          const value = pos ? pos.shares * current : 0;
          const cost = pos ? pos.shares * pos.cost : 0;
          const todayProfit = pos && prev > 0 ? pos.shares * (current - prev) : 0;
          return {
            code: w.fund_code,
            name: w.name || fund.name || w.fund_code,
            market: w.market || fund.market || 'domestic',
            kind: w.kind || 'fund',
            sector: w.sector || (w.kind === 'stock' ? inferStockSector(w.fund_code) : inferFundSector(fund.name || '')),
            value, cost, todayProfit,
            changePct: parseFloat(fund.gszzl) || 0,
          };
        } catch {
          return null;
        }
      })
    );
    const items = itemResults.filter(Boolean);

    const classified = classifyHoldings(items);
    const aggregated = aggregateBySector(classified);
    res.json({
      sectors: SECTORS,
      colors: SECTOR_COLORS,
      groups: aggregated,
      totalValue: aggregated.reduce((s, g) => s + g.totalValue, 0),
    });
  } catch (error) {
    res.status(500).json({ error: '获取板块分布失败：' + error.message });
  }
});

// ==========================================
// 3. 用户持仓接口 (Positions Routes)
// ==========================================

// 获取当前用户的所有持仓
app.get('/api/positions', async (req, res) => {
  try {
    const rows = await dbHelper.all(
      'SELECT fund_code, shares, cost, updated_at FROM positions WHERE user_id = ?',
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

// 获取金价（国际 COMEX / 国内 SGE Au99.99 / 伦敦 XAU spot）— 公开接口无 auth
app.get('/api/market/gold', async (_req, res) => {
  try {
    const data = await marketHelper.getGoldPrices();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: '获取金价失败：' + (error.message || '未知错误') });
  }
});

// 获取金价历史快照 — 服务端累积，新用户立即看到分时 / 周 / 月走势图
// range: intraday (24h) | 1W (7d) | 1M (30d)  — 都限定在表内 31 天上限内
app.get('/api/market/gold/:key/history', async (req, res) => {
  const key = String(req.params.key || '');
  const validKeys = ['international', 'domestic', 'london'];
  if (!validKeys.includes(key)) {
    return res.status(400).json({ error: 'key 必须是 ' + validKeys.join(' / ') });
  }
  const range = String(req.query.range || 'intraday');
  const now = Date.now();
  const cutoff =
    range === '1W' ? now - 7  * 24 * 60 * 60 * 1000 :
    range === '1M' ? now - 30 * 24 * 60 * 60 * 1000 :
                     now - 24 * 60 * 60 * 1000;   // intraday 默认 24h

  try {
    const rows = await dbHelper.all(
      `SELECT t, v FROM gold_history WHERE key = ? AND t >= ? ORDER BY t ASC`,
      [key, cutoff]
    );
    res.json({
      key,
      range,
      points: rows.map(r => ({ t: r.t, v: r.v })),
      count: rows.length,
    });
  } catch (e) {
    res.status(500).json({ error: '查询金价历史失败：' + e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────
   金价累积循环：每 60s 拉一次，三个 key 各写一条到 gold_history。
   顺便清理 31 天前数据。
   ───────────────────────────────────────────────────────────────── */
const GOLD_POLL_MS = 60 * 1000;
const GOLD_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const GOLD_KEYS = ['international', 'domestic', 'london'];

async function pollGoldAndPersist() {
  try {
    const data = await marketHelper.getGoldPrices();
    if (!data) return;
    const ts = Date.now();
    const inserts = [];
    for (const key of GOLD_KEYS) {
      const g = data[key];
      if (!g || g.price == null) continue;
      inserts.push(dbHelper.run(
        `INSERT INTO gold_history (key, t, v) VALUES (?, ?, ?)`,
        [key, ts, g.price]
      ));
    }
    if (inserts.length > 0) await Promise.all(inserts);

    // 清理 31 天前数据（每轮顺手做，0 阻断）
    const cutoff = ts - GOLD_RETENTION_MS;
    await dbHelper.run(
      `DELETE FROM gold_history WHERE t < ?`,
      [cutoff]
    );
  } catch (e) {
    console.error('[gold-poll]', e.message);
  }
}

setInterval(pollGoldAndPersist, GOLD_POLL_MS);
setTimeout(pollGoldAndPersist, 5000);          // 启动延迟 5s
console.log(`[gold] 累积循环已启动，每 ${GOLD_POLL_MS / 1000}s 写库，保留 ${GOLD_RETENTION_MS / 86400000} 天`);

// 每个纽约交易日 08:45–09:30 的盘前窗口更新一次自选基金持仓构成。
const holdingsPrefetch = createHoldingsPrefetch({ dbHelper, marketHelper, marketTime });
setInterval(() => holdingsPrefetch.refreshIfDue(), 60 * 1000).unref?.();
setTimeout(() => holdingsPrefetch.refreshIfDue(), 10_000);
console.log('[holdings-prefetch] 盘前持仓构成刷新已启动（纽约时间 08:45）');

// 名称搜索（用于前端添加自选时的实时下拉）
app.get('/api/market/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const kind = req.query.kind === 'stock' ? 'stock' : 'fund';
  if (!q) return res.json({ results: [] });
  try {
    const results = await marketHelper.searchByName(q, kind);
    res.json({ results });
  } catch (error) {
    console.error('[search]', error.message);
    res.json({ results: [] });
  }
});

// 获取某只基金/股票估值（统一入口，按 code 格式自动路由数据源）
app.get('/api/market/fund/:code', async (req, res) => {
  const { code } = req.params;
  const kindOverride = req.query.kind;     // 可选: 'fund' | 'stock'，由前端 tab 决定
  // 仅股票详情可显式等待扩展行情；普通列表报价继续保持 base-first。
  const enrich = kindOverride === 'stock' && ['1', 'true'].includes(String(req.query.enrich || '').toLowerCase());
  // 接受：A 股 6 位 / 港股 5 位 / 美股 1-5 位字母 / 带 HK/US 前缀
  if (!code || !/^(\d{6}|\d{4,5}|[A-Za-z]{1,5}|(HK|hk|rt_hk|US|us|gb_)[\w]{1,6})$/.test(code)) {
    return res.status(400).json({ error: '代码格式不正确（需为 A 股 6 位、港股 5 位或美股 ticker）' });
  }

  try {
    const data = await marketHelper.getFundValuation(code, kindOverride, { enrich });
    if (!data) {
      return res.status(404).json({ error: '未找到该基金/股票或获取失败' });
    }
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: '获取估值失败' });
  }
});

// 仅开发诊断：探测腾讯 Qt 候选标的。必须显式开启，且不回传原始上游文本。
app.get('/api/debug/tencent-quote-probe', async (req, res) => {
  if (process.env.ENABLE_QUOTE_PROBE !== 'true') return res.status(404).end();
  const symbol = String(req.query.symbol || '').trim();
  if (!/^[a-z]{2,5}[A-Za-z0-9._-]{1,20}$/.test(symbol)) {
    return res.status(400).json({ error: 'symbol 格式不正确' });
  }
  try {
    const quote = await marketHelper.fetchTencentQtProxyQuote(symbol);
    if (!quote) return res.status(404).json({ valid: false, symbol });
    res.json({ valid: true, symbol, ...quote });
  } catch (error) {
    res.status(502).json({ valid: false, symbol, error: '上游行情获取失败' });
  }
});

// 获取某只基金历史单位净值（用于走势图）
// 场外基金每个交易日只公布一个官方净值，没有分时 K 线
app.get('/api/market/fund/:code/history', async (req, res) => {
  const { code } = req.params;
  const kindOverride = req.query.kind;     // optional 'fund' | 'stock', consistent with valuation route
  const days = Math.max(1, Math.min(parseInt(req.query.days) || 30, 90));

  if (!code || !/^(\d{6}|\d{4,5}|[A-Za-z]{1,5})$/.test(code)) {
    return res.status(400).json({ error: '代码格式不正确（6 位基金 / 5 位港股 / 1-5 位美股）' });
  }

  try {
    const data = await marketHelper.getFundHistory(code, days, kindOverride);
    res.json({ code, days, data });
  } catch (error) {
    res.status(500).json({ error: '获取基金历史净值失败' });
  }
});

// 获取股票日 / 周 K 线（完整 OHLCV，用于股票详情页蜡烛图）
app.get('/api/market/stock/:code/kline', async (req, res) => {
  const { code } = req.params;
  const period = ['day', 'week', 'month', 'quarter', 'year'].includes(req.query.period)
    ? req.query.period
    : 'day';
  const requestedCount = parseInt(req.query.count) || parseInt(req.query.days) || 120;
  const limits = {
    day: [20, 365],
    week: [12, 260],
    month: [12, 120],
    quarter: [8, 80],
    year: [5, 60],
  };
  const [minCount, maxCount] = limits[period];
  const count = Math.max(minCount, Math.min(requestedCount, maxCount));

  if (!code || !/^(\d{6}|\d{4,5}|[A-Za-z]{1,5})$/.test(code)) {
    return res.status(400).json({ error: '股票代码格式不正确' });
  }

  try {
    const data = await marketHelper.fetchStockKLineHistory(code, count, period);
    res.json({ code: code.toUpperCase(), period, count, data });
  } catch (error) {
    res.status(500).json({ error: '获取股票 K 线失败' });
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

// 获取个股分钟级 K 线（用于分时图 hover 显示真实成交量/成交额）
// A 股 → Sina；港股 → 腾讯；美股暂不支持 → 返回 null
app.get('/api/market/fund/:code/minute', async (req, res) => {
  const { code } = req.params;
  const kindOverride = req.query.kind;     // 'stock'
  const rawMarket = String(req.query.market || '').trim().toLowerCase();
  const marketParam = ['domestic', 'hk', 'us', 'other'].includes(rawMarket) ? rawMarket : null;

  if (!code || !/^(\d{6}|\d{4,5}|[A-Za-z]{1,5})$/.test(code)) {
    return res.status(400).json({ error: '代码格式不正确' });
  }
  try {
    let targetMarket = marketParam;
    if (!targetMarket) {
      const val = await marketHelper.getFundValuation(code, kindOverride);
      if (!val || !val.market) {
        return res.status(404).json({ error: '未找到该代码对应的市场' });
      }
      targetMarket = val.market;
    }

    if (targetMarket === 'other') {
      return res.json({ code, market: targetMarket, data: null });
    }
    const data = await marketHelper.fetchStockMinuteData(code, targetMarket, kindOverride);
    res.json({ code, market: targetMarket, data: data || null });
  } catch (error) {
    res.status(500).json({ error: '获取分钟数据失败' });
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
    // The current mailer supports dev / resend / smtp modes and no longer
    // exposes the legacy isUsingEthereal() helper. Keep the response field for
    // frontend compatibility without letting history reads fail at runtime.
    res.json({ history: rows, ethereal: false });
  } catch (error) {
    res.status(500).json({ error: '获取提醒历史失败' });
  }
});

// 创建提醒
app.post('/api/alerts', async (req, res) => {
  const { fund_code, fund_name, email, up_threshold, down_threshold } = req.body || {};
  if (!fund_code || !/^(\d{6}|\d{4,5}|[A-Za-z]{1,5}|(HK|hk|US|us|gb_|\w+)[\w]{1,6})$/.test(fund_code)) {
    return res.status(400).json({ error: '代码格式不正确' });
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
    // 用昨日单位净值(dwjz)作为涨跌基准，而不是当日实时估算(gsz)。
    // 原因：QDII/老基金日间 gsz 是基于持仓成分股的"实时估算"，与次日才公布的
    // 官方净值之间会有 1-2% 的回归差。以 gsz 为基准会把这次"回归"误判为
    // "下跌触发"。dwjz 是用户对"涨/跌"心理预期的基准（相对昨日收盘）。
    const fund = await marketHelper.getFundValuation(fund_code);

    // 防御：如果数据源只返回了昨日净值（navOnly=true）而没有今日估算，
    // 直接以 dwjz 为基准会导致日后 gsz 第一次刷新时看起来像"涨跌"。
    // 这种基金建议稍后再试，或用户主动接受"以 dwjz 为基准"才能创建。
    if (fund && fund.navOnly) {
      return res.status(503).json({
        error: '当前数据源仅能获取昨日官方净值（QDII/老基金常见），无法建立准确涨跌基准。请稍后到行情页面刷新一次后再创建提醒，或改用持仓成分股相对稳定的基金。'
      });
    }

    const dwjzParsed = fund ? parseFloat(fund.dwjz) : NaN;
    const gszParsed = fund ? parseFloat(fund.gsz) : NaN;
    // 优先 dwjz（昨日净值），回退到 gsz（极少数情况 dwjz 为 0）
    const ref = Number.isFinite(dwjzParsed) && dwjzParsed > 0
      ? dwjzParsed
      : (Number.isFinite(gszParsed) && gszParsed > 0 ? gszParsed : null);

    // 水位线初始值 = ref（昨收），这样从创建那一刻起，
    // 高位触发要求 current ≥ ref * (1 + up/100)，
    // 低位触发要求 current ≤ ref * (1 - down/100)。
    const highWater = ref;
    const lowWater  = ref;

    const navDate = fund ? (fund.jzrq || '') : '';

    const result = await dbHelper.run(
      `INSERT INTO alerts
         (user_id, fund_code, fund_name, email, up_threshold, down_threshold,
          reference_price, high_water_price, low_water_price, last_nav_date, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [req.userId, fund_code, fund_name || fund?.name || fund_code, email, up, down,
       ref, highWater, lowWater, navDate]
    );
    res.json({
      success: true,
      id: result.lastID,
      message: ref
        ? `已创建提醒，基准净值 ${ref.toFixed(4)}（基于昨日单位净值，水位线模式）`
        : '已创建提醒（暂未获取到基准净值，触发判断会在首次刷新时建立）',
      reference_price: ref
    });
  } catch (error) {
    console.error('创建提醒失败:', error);
    res.status(500).json({ error: '创建提醒失败' });
  }
});

// ==========================================
// 提醒全局设置（Alert Settings）
//   — 必须注册在 /api/alerts/:id 之前，否则 settings 被当 id 抢先匹配
// ==========================================
// alert_stop_after_close: 'true' | 'false'，默认 'true'
// 开启时：非交易时段（按市场分别判断）跳过 pollAlerts，不发邮件、不写 history

const ALERT_SETTINGS_KEYS = ['alert_stop_after_close'];
let ALERT_STOP_AFTER_CLOSE = true;     // 内存缓存；PUT 后立即刷新

async function loadAlertSettings() {
  try {
    const rows = await dbHelper.all(
      `SELECT key, value FROM settings WHERE key IN (${ALERT_SETTINGS_KEYS.map(() => '?').join(',')})`,
      ALERT_SETTINGS_KEYS
    );
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    // 未设置或显式 'true' → 开启；只有显式 'false' 才关闭
    ALERT_STOP_AFTER_CLOSE = (map.alert_stop_after_close || 'true') !== 'false';
  } catch (e) {
    console.warn('[alerts] load settings failed:', e.message);
  }
}

// 公开查询（任何登录用户都能看，便于前端展示状态）
app.get('/api/alerts/settings', async (_req, res) => {
  try {
    await loadAlertSettings();
    res.json({ stopAfterMarketClose: ALERT_STOP_AFTER_CLOSE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新（admin only）
app.put('/api/alerts/settings', requireAdmin, async (req, res) => {
  const { stopAfterMarketClose } = req.body || {};
  if (typeof stopAfterMarketClose !== 'boolean') {
    return res.status(400).json({ error: 'stopAfterMarketClose 必须是 boolean' });
  }
  try {
    await dbHelper.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      ['alert_stop_after_close', stopAfterMarketClose ? 'true' : 'false']
    );
    ALERT_STOP_AFTER_CLOSE = stopAfterMarketClose;
    console.log(`[alerts] stopAfterMarketClose = ${stopAfterMarketClose}`);
    res.json({ success: true, stopAfterMarketClose });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      referencePrice: 1.0000,
      openPrice: 0.9900
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

// 查看已配置密钥原文（admin only）— 用于在 UI 展示 / 复制。
// ⚠️ 暴露明文密钥，仅限 admin 在受信环境中调用。
app.get('/api/email/config/reveal', requireAdmin, async (req, res) => {
  try {
    const secrets = await mailer.getRevealedSecrets();
    res.json(secrets);
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

    // 每轮重新加载设置（PUT 后下次 poll 立即生效；开销可忽略）
    await loadAlertSettings();

    for (const alert of rows) {
      try {
        const fund = await marketHelper.getFundValuation(alert.fund_code);
        if (!fund) continue;

        // 非交易时段跳过：结合品种/基金市场属性判断（A股/港股/美股/QDII）
        if (ALERT_STOP_AFTER_CLOSE && !marketHelper.isInTradingTime(alert.fund_code, undefined, fund.market)) {
          continue;
        }

        // ⚠️ 防御：数据源只回退到昨日净值（navOnly=true）时没有"今日实时价"，
        // 此时计算出来的 changePct 没有意义，跳过本轮不触发。
        if (fund.navOnly) {
          console.log(`[alerts] skip #${alert.id} ${alert.fund_code} — data source navOnly-only (gsz==dwjz), wait for realtime source`);
          continue;
        }
        // 代理行情的上游时间是事实来源，不能因服务器刚抓到旧报价而触发告警。
        if (fund.quoteFreshness === 'stale' || fund.quoteFreshness === 'unknown') {
          console.log(`[alerts] skip #${alert.id} ${alert.fund_code} — proxy quote ${fund.quoteFreshness}`);
          continue;
        }

        const current = parseFloat(fund.gsz) || parseFloat(fund.dwjz);
        if (current <= 0) continue;

        // ============================================================
        // 跨日水位线自动重置逻辑
        // ------------------------------------------------------------
        // 当进入新交易日，最新官方净值日期 (fund.jzrq) 变动，或者上一步
        // 拿到了新的 dwjz (昨收价)，将高低水位线均重置为当天的基准 dwjz。
        // ============================================================
        let highWater = alert.high_water_price;
        let lowWater  = alert.low_water_price;
        const currentDwjz = parseFloat(fund.dwjz);
        const navDate = fund.jzrq || '';

        // 从 1.2.14 升级的提醒已有水位线但没有 last_nav_date。首次拿到有效净值日期时，
        // 先以当前官方净值建立明确的日基准，避免旧水位线一直无法进入跨日重置逻辑。
        if (navDate && !alert.last_nav_date && Number.isFinite(currentDwjz) && currentDwjz > 0) {
          highWater = currentDwjz;
          lowWater = currentDwjz;
          await dbHelper.run(
            'UPDATE alerts SET high_water_price = ?, low_water_price = ?, reference_price = ?, last_nav_date = ? WHERE id = ?',
            [highWater, lowWater, currentDwjz, navDate, alert.id]
          );
        // 跨日重置判断：如果记录了上次净值日期且与最新日期不符，重置水位线为新 dwjz
        } else if (navDate && alert.last_nav_date && navDate !== alert.last_nav_date && Number.isFinite(currentDwjz) && currentDwjz > 0) {
          console.log(`[alerts] 跨日重置提醒 #${alert.id} ${alert.fund_code}: ${alert.last_nav_date} -> ${navDate}, 新昨收=${currentDwjz}`);
          highWater = currentDwjz;
          lowWater = currentDwjz;
          await dbHelper.run(
            'UPDATE alerts SET high_water_price = ?, low_water_price = ?, reference_price = ?, last_nav_date = ? WHERE id = ?',
            [highWater, lowWater, currentDwjz, navDate, alert.id]
          );
        }

        // 冷启动：水位线未初始化（NULL）→ 用当前 dwjz 作起点
        if (highWater == null || lowWater == null) {
          const initWater = Number.isFinite(currentDwjz) && currentDwjz > 0 ? currentDwjz : current;
          highWater = highWater == null ? initWater : highWater;
          lowWater  = lowWater  == null ? initWater : lowWater;
          await dbHelper.run(
            'UPDATE alerts SET high_water_price = COALESCE(high_water_price, ?), low_water_price = COALESCE(low_water_price, ?), last_nav_date = COALESCE(last_nav_date, ?) WHERE id = ?',
            [highWater, lowWater, navDate, alert.id]
          );
        }
        if (highWater <= 0 || lowWater <= 0) continue;

        // 计算本轮"涨幅"和"跌幅"（相对各自水位线）
        const upMovePct   = ((current - highWater) / highWater) * 100;
        const downMovePct = ((current - lowWater)  / lowWater)  * 100;

        let triggered = null;        // 'up' | 'down'
        let changePct = 0;
        if (alert.up_threshold != null   && upMovePct   >= alert.up_threshold)   { triggered = 'up';   changePct = upMovePct; }
        if (alert.down_threshold != null && downMovePct <= -alert.down_threshold) { triggered = 'down'; changePct = downMovePct; }

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

        // 发送 + 落库 — 防御性：再次确认非交易时间，防止未来的回归
        if (ALERT_STOP_AFTER_CLOSE && !marketHelper.isInTradingTime(alert.fund_code, undefined, fund.market)) {
          console.log(`[alerts] safety-skip #${alert.id} market=${fund.market || 'unknown'} (defensive double-check) at BJT=${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})}`);
          continue;
        }

        // 计算本轮邮件里展示用的"参考价"（用户在邮件里看到的是相对哪个值的涨跌）
        const displayRef = triggered === 'up' ? highWater : lowWater;
        const openPrice = (fund.open ? parseFloat(fund.open) : undefined) || (fund.stockSpecific && typeof fund.stockSpecific.open === 'number' ? fund.stockSpecific.open : undefined) || parseFloat(fund.dwjz) || displayRef;

        const sendResult = await mailer.sendAlertEmail({
          to: alert.email,
          fundCode: alert.fund_code,
          fundName: alert.fund_name,
          direction: triggered,
          changePct,
          currentPrice: current,
          referencePrice: displayRef,
          openPrice
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
            triggered, changePct, current, displayRef,
            sendResult?.messageId || null, sentOk, sendResult?.error || null
          ]
        );

        // 触发后更新对应方向的水位线及最新官方净值日期 (last_nav_date)
        const newHighWater = triggered === 'up'   ? current : highWater;
        const newLowWater  = triggered === 'down' ? current : lowWater;
        await dbHelper.run(
          `UPDATE alerts SET
             last_triggered_at = ?,
             last_triggered_change_pct = ?,
             last_triggered_direction = ?,
             high_water_price = ?,
             low_water_price  = ?,
             last_nav_date    = COALESCE(NULLIF(?, ''), last_nav_date)
           WHERE id = ?`,
          [nowIso, changePct, triggered, newHighWater, newLowWater, navDate, alert.id]
        );

        console.log(`[alerts] ✓ triggered #${alert.id} ${alert.fund_code} ${triggered} ${changePct.toFixed(2)}% (ref_basis=water ${displayRef.toFixed(4)} → cur=${current.toFixed(4)}, new high_water=${newHighWater.toFixed(4)} low_water=${newLowWater.toFixed(4)})`);
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

// 启动时加载全局提醒设置（默认值立即生效）
loadAlertSettings().then(() => {
  console.log(`[alerts] 收盘后停止通知 = ${ALERT_STOP_AFTER_CLOSE}`);
});

// ==========================================
// 启动服务
// ==========================================
// ==========================================
// 7. 实时推送：SSE 端点
// ==========================================

/**
 * GET /api/stream/valuations?codes=002050,AAPL,019018&kind=stock&market=domestic|hk|us
 *   - codes: 逗号分隔的代码列表（必填）
 *   - kind: 整体默认 kind，未识别 code 走此默认（可选，默认 'stock'）
 *   - market: 用于 broker 的收盘判定（domestic/hk/us，可选；不传则由 detectCodeKind 推断）
 *
 * SSE 事件：
 *   - event: ready   连接就绪
 *   - event: tick    行情更新
 *   - event: closed  收盘 + 1 分钟后停止抓取（最后一条 lastVal 是收盘价）
 *
 * SSE 协议要点：
 *   - Content-Type: text/event-stream
 *   - Cache-Control: no-store
 *   - Connection: keep-alive
 *   - 周期性 `:keepalive\n\n` 注释
 */
app.get('/api/stream/valuations', (req, res) => {
  const codesParam = String(req.query.codes || '').trim();
  const defaultKind = req.query.kind === 'fund' ? 'fund' : 'stock';
  const rawMarket = String(req.query.market || '').trim().toLowerCase();
  const market =
    rawMarket === 'domestic' || rawMarket === 'hk' || rawMarket === 'us' || rawMarket === 'other'
      ? rawMarket
      : null;
  const codes = codesParam
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (codes.length === 0) {
    return res.status(400).json({ error: 'codes 不能为空' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // 禁用 Nginx 缓冲
  res.flushHeaders?.();
  // 立即写一行注释 + 一条 ready 事件，避免某些客户端超时
  res.write(`:sse-connected ${Date.now()}\n\n`);
  res.write(`event: ready\ndata: {"codes":${JSON.stringify(codes)}}\n\n`);

  // 订阅每个 code；按 code 个性化 kind（用户可显式传 kind=fund）
  const unsubscribers = [];
  const onTick = (payload) => {
    if (!codes.includes(payload.code)) return;
    try {
      res.write(`event: tick\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      // 连接已断，忽略
    }
  };
  const onClosed = (payload) => {
    if (!codes.includes(payload.code)) return;
    try {
      res.write(`event: closed\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  };
  const onKeepalive = () => {
    try {
      res.write(`:keepalive ${Date.now()}\n\n`);
    } catch {}
  };

  valuationBroker.emitter.on('tick', onTick);
  valuationBroker.emitter.on('closed', onClosed);
  valuationBroker.emitter.on('keepalive', onKeepalive);

  codes.forEach(code => {
    const unsub = valuationBroker.subscribe(code, defaultKind, market);
    unsubscribers.push(unsub);
  });

  // 客户端断线：清理订阅
  req.on('close', () => {
    valuationBroker.emitter.off('tick', onTick);
    valuationBroker.emitter.off('closed', onClosed);
    valuationBroker.emitter.off('keepalive', onKeepalive);
    unsubscribers.forEach(fn => { try { fn(); } catch {} });
  });
});

/** 调试：列出 broker 当前订阅状态 */
app.get('/api/stream/stats', (_req, res) => {
  try {
    res.json({ codes: valuationBroker.stats() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 启动服务
// ==========================================
app.listen(PORT, () => {
  console.log(`[基金监控全栈系统] 后端API服务已在端口 ${PORT} 启动`);
});
