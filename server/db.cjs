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
    // 1. 用户表
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. 自选基金列表
    db.run(`
      CREATE TABLE IF NOT EXISTS watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        fund_code TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, fund_code)
      )
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
        reference_price REAL,                -- 基准净值（创建时的 gsz）
        is_active INTEGER NOT NULL DEFAULT 1, -- 1 启用 0 暂停
        last_triggered_at TEXT,               -- 上次触发时间，ISO
        last_triggered_change_pct REAL,       -- 触发时的涨跌幅（用于邮件/历史展示）
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
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
