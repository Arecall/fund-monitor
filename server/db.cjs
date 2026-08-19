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
        is_active INTEGER NOT NULL DEFAULT 1, -- 1 启用 0 暂停
        last_triggered_at TEXT,               -- 上次触发时间，ISO
        last_triggered_change_pct REAL,       -- 触发时的涨跌幅（用于邮件/历史展示）
        last_triggered_direction TEXT,        -- 上次触发方向 'up' / 'down'（辅助诊断）
        last_nav_date TEXT,                   -- 最新官方净值日期 (jzrq)，用于跨日重置水位线
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Alerts schema migration: 给老数据库添加水位线 + last_triggered_direction + last_nav_date
    const alertColumns = [
      ['high_water_price', 'REAL'],
      ['low_water_price', 'REAL'],
      ['last_triggered_direction', 'TEXT'],
      ['last_nav_date', 'TEXT'],
    ];
    for (const [name, definition] of alertColumns) {
      db.run(`ALTER TABLE alerts ADD COLUMN ${name} ${definition}`, (err) => {
        if (err && !/duplicate column name/i.test(err.message)) {
          console.error(`[db] alerts migration failed for ${name}:`, err.message);
        }
      });
    }
    // 回填水位线：老用户没有水位线，但有 reference_price 锁定，把水位线初始化为参考价
    // 这样从升级那一刻起，老提醒的判断逻辑与新逻辑等价（不重置基准）。
    db.run(`
      UPDATE alerts
      SET high_water_price = COALESCE(high_water_price, reference_price),
          low_water_price  = COALESCE(low_water_price,  reference_price)
      WHERE high_water_price IS NULL OR low_water_price IS NULL
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
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 6. 全局设置表（KV 形式）
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 金价历史快照（服务端累积）— 一分钟一条，三个 key 各存一份。
    // 自动清理 31 天前数据：金价日内分时粒度 1 分钟足够，月增 ~5 MB。
    db.run(`
      CREATE TABLE IF NOT EXISTS gold_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        t INTEGER NOT NULL,
        v REAL NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_gold_history_key_t ON gold_history (key, t)`);

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

    // 自动清理历史因 QDII 代理标的原生分钟 K 线（如 QQQ 美金 718 元）未缩放错误写入 6 位基金代码的污染打点 (> 50 元)
    db.run(`
      DELETE FROM quote_snapshots
      WHERE code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
        AND current > 50
    `);

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
