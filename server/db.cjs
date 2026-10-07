const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'db.sqlite3');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('成功连接到 SQLite 数据库:', dbPath);
    initTables();
  }
});

function initTables() {
  db.serialize(() => {
    // 开启 WAL 模式 + 设置锁超时时间与同步级别，极大提升并发读写吞吐量并防止锁竞争
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA busy_timeout = 5000;');
    db.run('PRAGMA synchronous = NORMAL;');

    // 1. 用户表
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. 自选基金/股票列表（kind 区分 fund / stock）
    db.run(`
      CREATE TABLE IF NOT EXISTS watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        fund_code TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'fund',  -- 'fund' | 'stock'
        market TEXT,                        -- 'domestic' | 'hk' | 'us' | 'other'
        sector TEXT,                        -- 行业板块，如 '科技' / '金融' / '医疗'
        note TEXT,                          -- 用户备注
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, fund_code)
      )
    `);

    // Migrate databases created before v1.1.2. CREATE TABLE IF NOT EXISTS
    // does not add new columns to an existing table, so add them explicitly.
    const watchlistColumns = [
      ['kind', "TEXT NOT NULL DEFAULT 'fund'"],
      ['market', 'TEXT'],
      ['sector', 'TEXT'],
      ['note', 'TEXT'],
    ];
    for (const [name, definition] of watchlistColumns) {
      db.run(`ALTER TABLE watchlist ADD COLUMN ${name} ${definition}`, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) {
          console.error(`[db] watchlist migration failed for ${name}:`, err.message);
        }
      });
    }
    // 回填/校准缺失的 market 和 kind（若 kind 已存在则尊重原设置，不强制把美股基金覆盖成 stock）
    db.run(`
      UPDATE watchlist
      SET kind = COALESCE(NULLIF(kind, ''), 'fund'),
          market = COALESCE(
            NULLIF(market, ''),
            CASE
              WHEN fund_code GLOB '[A-Za-z]*' THEN 'us'
              WHEN length(fund_code) IN (4, 5) THEN 'hk'
              ELSE 'domestic'
            END
          )
    `);

    // v1.2.23 — per-kind 拖动排序字段。两列独立，reorder 一个 tab 不影响另一个。
    const watchlistSortColumns = [
      ['fund_sort_order',  'INTEGER'],
      ['stock_sort_order', 'INTEGER'],
    ];
    for (const [name, definition] of watchlistSortColumns) {
      db.run(`ALTER TABLE watchlist ADD COLUMN ${name} ${definition}`, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) {
          console.error(`[db] watchlist sort migration failed for ${name}:`, err.message);
        }
      });
    }
    // 回填：用 id ASC 当作初始顺序。COALESCE 保证用户拖动过的值不被覆盖。
    db.run(`
      UPDATE watchlist
      SET fund_sort_order  = COALESCE(fund_sort_order,  id),
          stock_sort_order = COALESCE(stock_sort_order, id)
      WHERE fund_sort_order IS NULL OR stock_sort_order IS NULL
    `);

    // 3. 持仓记录表
    db.run(`
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        fund_code TEXT NOT NULL,
        shares REAL NOT NULL,
        cost REAL NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, fund_code)
      )
    `);

    // 4. 价格提醒表
    db.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        fund_code TEXT NOT NULL,
        fund_name TEXT,
        email TEXT NOT NULL,
        up_threshold REAL,                    -- 上涨 N% 触发，null 表示不监控上涨
        down_threshold REAL,                  -- 下跌 N% 触发，null 表示不监控下跌
        reference_price REAL,                -- 基准净值（创建时的 dwjz，UI 展示用，触发判断已迁移到水位线）
        high_water_price REAL,                -- 上涨水位线：从该值起涨 up_threshold 才再触发；null = 未初始化
        low_water_price REAL,                 -- 下跌水位线：从该值起跌 down_threshold 才再触发；null = 未初始化
        kind TEXT NOT NULL DEFAULT 'fund',    -- 'fund' | 'stock'
        market TEXT DEFAULT 'domestic',       -- 'domestic' | 'hk' | 'us' | 'other'
        last_trading_day TEXT,                -- 当前锁定的权威交易日 (YYYY-MM-DD)
        triggered_today_up INTEGER NOT NULL DEFAULT 0,   -- 当日是否已触发上涨告警
        triggered_today_down INTEGER NOT NULL DEFAULT 0, -- 当日是否已触发下跌告警
        is_active INTEGER NOT NULL DEFAULT 1, -- 1 启用 0 暂停
        last_triggered_at TEXT,               -- 上次触发时间，ISO
        last_triggered_change_pct REAL,       -- 触发时的涨跌幅（用于邮件/历史展示）
        last_triggered_direction TEXT,        -- 上次触发方向 'up' / 'down'（辅助诊断）
        last_nav_date TEXT,                   -- 最新官方净值日期 (jzrq)，用于跨日重置水位线
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Alerts schema migration: 给老数据库添加水位线 + 标的类型 + 交易日状态机字段
    const alertColumns = [
      ['high_water_price', 'REAL'],
      ['low_water_price', 'REAL'],
      ['last_triggered_direction', 'TEXT'],
      ['last_nav_date', 'TEXT'],
      ['kind', "TEXT NOT NULL DEFAULT 'fund'"],
      ['market', "TEXT NOT NULL DEFAULT 'domestic'"],
      ['last_trading_day', 'TEXT'],
      ['triggered_today_up', 'INTEGER NOT NULL DEFAULT 0'],
      ['triggered_today_down', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of alertColumns) {
      db.run(`ALTER TABLE alerts ADD COLUMN ${name} ${definition}`, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) {
          console.error(`[db] alerts migration failed for ${name}:`, err.message);
        }
      });
    }
    // 回填水位线：老用户没有水位线，但有 reference_price 锁定，把水位线初始化为参考价
    db.run(`
      UPDATE alerts
      SET high_water_price = COALESCE(high_water_price, reference_price),
          low_water_price  = COALESCE(low_water_price,  reference_price)
      WHERE high_water_price IS NULL OR low_water_price IS NULL
    `);

    // 自动回填 kind 与 market：优先对齐自选表 watchlist 中的真实分类
    db.run(`
      UPDATE alerts
      SET kind = COALESCE((
            SELECT watchlist.kind FROM watchlist
            WHERE watchlist.user_id = alerts.user_id AND watchlist.fund_code = alerts.fund_code
            LIMIT 1
          ), kind, 'fund'),
          market = COALESCE((
            SELECT watchlist.market FROM watchlist
            WHERE watchlist.user_id = alerts.user_id AND watchlist.fund_code = alerts.fund_code
            LIMIT 1
          ), market, 'domestic')
      WHERE EXISTS (
        SELECT 1 FROM watchlist
        WHERE watchlist.user_id = alerts.user_id AND watchlist.fund_code = alerts.fund_code
      )
    `);

    // 针对不在自选表中的孤立记录进行代码特征推断回填
    db.run(`
      UPDATE alerts
      SET market = CASE
        WHEN fund_code LIKE 'HK%' OR fund_code LIKE 'hk%' OR length(fund_code) = 5 THEN 'hk'
        WHEN fund_code GLOB '*[A-Za-z]*' THEN 'us'
        ELSE 'domestic'
      END
      WHERE market IS NULL OR market = '';
    `);
    db.run(`
      UPDATE alerts
      SET kind = CASE
        WHEN fund_code GLOB '*[A-Za-z]*' THEN 'stock'
        WHEN fund_code GLOB '60*' OR fund_code GLOB '68*' OR fund_code GLOB '00*' OR fund_code GLOB '30*' THEN 'stock'
        WHEN length(fund_code) = 5 THEN 'stock'
        ELSE kind
      END
      WHERE kind IS NULL OR kind = '';
    `);

    // 5. 提醒发送历史（审计 + UI 展示）
    db.run(`
      CREATE TABLE IF NOT EXISTS alert_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        fund_code TEXT NOT NULL,
        fund_name TEXT,
        email TEXT NOT NULL,
        direction TEXT NOT NULL,              -- 'up' / 'down'
        change_pct REAL NOT NULL,
        current_price REAL NOT NULL,
        reference_price REAL,
        message_id TEXT,                     -- 邮件服务返回的 messageId
        sent_ok INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,  -- 0 未读 / 1 已读
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 历史表迁移：添加 is_read 字段
    db.run(`ALTER TABLE alert_history ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0`, (err) => {
      if (err && !/duplicate column name/i.test(err.message)) {
        console.error('[db] alert_history migration failed for is_read:', err.message);
      }
    });
    db.run(`CREATE INDEX IF NOT EXISTS idx_alert_history_user_read ON alert_history (user_id, is_read)`);

    // 6. 全局设置表（KV 形式）
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 金价历史快照（服务端累积与外部回补）— 分时（minute）与宏观日线（day）分流存储
    // 自动清理 31 天前数据：月增 ~5 MB。
    db.run(`
      CREATE TABLE IF NOT EXISTS gold_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        t INTEGER NOT NULL,
        v REAL NOT NULL,
        period TEXT NOT NULL DEFAULT 'minute'
      )
    `);
    db.all(`PRAGMA table_info(gold_history)`, (err, cols) => {
      if (!err && cols && !cols.some(c => c.name === 'period')) {
        db.run(`ALTER TABLE gold_history ADD COLUMN period TEXT NOT NULL DEFAULT 'minute'`);
      }
    });
    db.run(`DROP INDEX IF EXISTS uidx_gold_history_key_t`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_gold_history_key_period_t ON gold_history (key, period, t)`);

    // 行情快照（实时推送 broker 在每次拉到上游数据时写入）：
    //   code + captured_at (epoch ms) 复合主键，确保幂等写入
    //   gztime  来自上游原始字符串（如 "2026-07-29 14:35:27"）
    //   current 现价
    //   pct     涨跌幅（百分比，已含符号）
    //   raw     完整 JSON 字符串，方便后续复盘 / 回放，不参与搜索
    // 后端每 90 天滚动清理，避免磁盘膨胀。
    db.run(`
      CREATE TABLE IF NOT EXISTS quote_snapshots (
        code TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        gztime TEXT,
        current REAL,
        pct REAL,
        raw TEXT,
        PRIMARY KEY (code, captured_at)
      ) WITHOUT ROWID
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_quote_snapshots_code_time ON quote_snapshots (code, captured_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_quote_snapshots_time ON quote_snapshots (captured_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_user_active ON alerts (user_id, is_active)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_watchlist_user_kind ON watchlist (user_id, kind)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_positions_user ON positions (user_id)`);

    // 7. 用户个人股票偏好与自动化定时配置表（每位用户独立个性化配置）
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_user_config (
        user_id INTEGER PRIMARY KEY,
        api_key_encrypted TEXT DEFAULT '',
        base_url TEXT DEFAULT 'https://api.anthropic.com',
        model_name TEXT DEFAULT 'claude-3-7-sonnet-20250219',
        api_format TEXT DEFAULT 'anthropic',
        auth_header_type TEXT DEFAULT 'ANTHROPIC_AUTH_TOKEN',
        markets TEXT DEFAULT '["domestic"]',
        stock_count INTEGER DEFAULT 5,
        strategy TEXT DEFAULT 'balanced',
        pre_market_enabled INTEGER DEFAULT 0,
        close_enabled INTEGER DEFAULT 0,
        last_pre_run TEXT,
        last_close_run TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 针对已有表的迁移
    const aiConfigCols = [
      ['api_format', "TEXT DEFAULT 'anthropic'"],
      ['auth_header_type', "TEXT DEFAULT 'ANTHROPIC_AUTH_TOKEN'"],
    ];
    for (const [colName, colDef] of aiConfigCols) {
      db.run(`ALTER TABLE ai_user_config ADD COLUMN ${colName} ${colDef}`, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) {
          console.error(`[db] ai_user_config migration failed for ${colName}:`, err.message);
        }
      });
    }

    // 8. 全局 AI 接口凭证与大模型配置表（仅限 Admin 管理员维护，单例 id=1）
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_system_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        api_key_encrypted TEXT DEFAULT '',
        base_url TEXT DEFAULT 'https://api.anthropic.com',
        model_name TEXT DEFAULT 'claude-3-7-sonnet-20250219',
        api_format TEXT DEFAULT 'anthropic',
        auth_header_type TEXT DEFAULT 'ANTHROPIC_AUTH_TOKEN',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 确保全局单例行存在
    db.run(`
      INSERT OR IGNORE INTO ai_system_config (id, api_key_encrypted, base_url, model_name, api_format, auth_header_type)
      VALUES (1, '', 'https://api.anthropic.com', 'claude-3-7-sonnet-20250219', 'anthropic', 'ANTHROPIC_AUTH_TOKEN')
    `);

    // 自动平滑迁移：若旧版 ai_user_config 中已配置过 API 密钥，自动同步到系统全局配置中
    db.run(`
      UPDATE ai_system_config
      SET api_key_encrypted = COALESCE(
            (SELECT api_key_encrypted FROM ai_user_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != '' ORDER BY user_id ASC LIMIT 1),
            api_key_encrypted
          ),
          base_url = COALESCE(
            (SELECT base_url FROM ai_user_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != '' ORDER BY user_id ASC LIMIT 1),
            base_url
          ),
          model_name = COALESCE(
            (SELECT model_name FROM ai_user_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != '' ORDER BY user_id ASC LIMIT 1),
            model_name
          ),
          api_format = COALESCE(
            (SELECT api_format FROM ai_user_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != '' ORDER BY user_id ASC LIMIT 1),
            api_format
          ),
          auth_header_type = COALESCE(
            (SELECT auth_header_type FROM ai_user_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != '' ORDER BY user_id ASC LIMIT 1),
            auth_header_type
          )
      WHERE (api_key_encrypted IS NULL OR api_key_encrypted = '')
        AND EXISTS (SELECT 1 FROM ai_user_config WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != '')
    `);

    // 9. AI 选股分析报告表
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_stock_pick_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        trigger_type TEXT NOT NULL,
        markets TEXT NOT NULL,
        stock_count INTEGER,
        strategy TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT,
        context_snapshot TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 9. AI 推荐股票明细表
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_stock_pick_recs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        market TEXT,
        rank INTEGER,
        confidence REAL,
        cap_category TEXT DEFAULT '中盘成长',
        growth_theme TEXT DEFAULT '',
        reason_fundamental TEXT,
        reason_technical TEXT,
        reason_catalyst TEXT,
        risk_warning TEXT,
        in_candidate_pool INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (report_id) REFERENCES ai_stock_pick_reports(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 针对已有 recommendations 表的字段平滑增量迁移
    const aiRecsCols = [
      ['cap_category', "TEXT DEFAULT '中盘成长'"],
      ['growth_theme', "TEXT DEFAULT ''"],
    ];
    for (const [colName, colDef] of aiRecsCols) {
      db.run(`ALTER TABLE ai_stock_pick_recs ADD COLUMN ${colName} ${colDef}`, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) {
          console.error(`[db] ai_stock_pick_recs migration failed for ${colName}:`, err.message);
        }
      });
    }

    db.run(`CREATE INDEX IF NOT EXISTS idx_ai_reports_user_created ON ai_stock_pick_reports (user_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ai_recs_report ON ai_stock_pick_recs (report_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ai_config_sched ON ai_user_config (pre_market_enabled, close_enabled)`);

    // 自动清理历史因 QDII 代理标的原生分钟 K 线（如 QQQ 美金 718 元）未缩放错误写入 6 位基金代码的污染打点 (> 50 元)
    db.run(`
      DELETE FROM quote_snapshots
      WHERE code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
        AND current > 50
    `);

    // 自动清理代理标的（QQQ / SPY 等）误写入缩放后小净值的污染打点 (< 50 元)
    db.run(`
      DELETE FROM quote_snapshots
      WHERE code IN ('QQQ', 'SPY', 'SOXX', 'USQQQ', 'usQQQ')
        AND current < 50
    `);

    // 清理非法非正数价格
    db.run(`
      DELETE FROM quote_snapshots
      WHERE current IS NULL OR current <= 0
    `);

    // 10. 银行与宏观资讯动态表（含哈希指纹去重与滚动淘汰）
    db.run(`
      CREATE TABLE IF NOT EXISTS bank_news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        publish_time TEXT NOT NULL,
        summary TEXT NOT NULL,
        impact TEXT NOT NULL,
        source TEXT,
        is_seed INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_news_hash ON bank_news (hash)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bank_news_time ON bank_news (publish_time DESC)`);

    // 预填核心四大宏观研选基石条目 (确保离线或冷启动时绝对具备高品质金融底仓参考)
    const SEED_NEWS = [
      {
        hash: 'seed-pboc-liquidity',
        title: '央行持续优化流动性结构，支持长钱长投增配高股息权益资产',
        category: '政策宏观',
        publish_time: '宏观政策导向',
        summary: '中央金融工作会议及监管政策明确支持险资、社保、养老金提高权益投资上限，高股息、低估值、稳健现金流的国有大行成为中长期配置压舱石。',
        impact: '夯实高股息大行与红利 ETF 估值中枢。',
        source: '政策导向',
        is_seed: 1
      },
      {
        hash: 'seed-nim-bottoming',
        title: '商业银行净息差企稳筑底，负债端定期存款挂牌利率多轮调降对冲资产端压力',
        category: '息差与盈利',
        publish_time: '2024 中报跟踪',
        summary: '随着各大行持续下调存款挂牌利率，负债成本改善为应对存量房贷与对公收益下行提供有效缓冲，净息差（NIM）收窄速度已明显边际放缓。',
        impact: '银行业盈利韧性提升，保障现金分红持续性。',
        source: '行业分析',
        is_seed: 1
      },
      {
        hash: 'seed-debt-resolution',
        title: '一揽子化债方案深入推进，金融机构资产质量安全边际充实',
        category: '风控信贷',
        publish_time: '信贷资产质量',
        summary: '地方政府特殊再融资债券发行置换隐性债务，有效缓释大行与长三角/成渝城商行的地方信贷风险暴露；主要上市银行不良贷款率均控制在 1.35% 以内，拨备覆盖率整体充裕。',
        impact: '消除银行股资产端“坏账黑天鹅”过度悲观预期。',
        source: '信贷质量',
        is_seed: 1
      },
      {
        hash: 'seed-t0-liquidity',
        title: '场内货币 ETF 满足资金日内极速周转，注意银证转账提现时间窗口',
        category: '流动性工具',
        publish_time: '流动性常识',
        summary: '银华日利（511880）、华宝添益（511990）等支持 T+0 回转交易，卖出后资金在证券账户实时可用；但转出至银行卡受银行清算时段约束，非交易日与夜间无法转出。',
        impact: '提示投资者合理规划周末与夜间备用流动性。',
        source: '交易机制',
        is_seed: 1
      }
    ];
    for (const seed of SEED_NEWS) {
      db.run(`
        INSERT OR IGNORE INTO bank_news (hash, title, category, publish_time, summary, impact, source, is_seed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [seed.hash, seed.title, seed.category, seed.publish_time, seed.summary, seed.impact, seed.source, seed.is_seed]);
    }

    console.log('数据库表结构初始化/验证完成');
  });
}

// 辅助包装：将 db.get 转为 Promise
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// 辅助包装：将 db.all 转为 Promise
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// 辅助包装：将 db.run 转为 Promise
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

module.exports = {
  db,
  get,
  all,
  run
};
