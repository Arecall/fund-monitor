/**
 * 实时推送 broker（Server-Sent Events）
 *
 * 架构：
 *   1. 每个 (code, kind) 组合拥有独立的"抓取循环"，按种类分流节奏：
 *        - stock（股票）: 10 秒一轮
 *        - fund （场外基金）: 60 秒一轮
 *   2. 当某 code 有 >= 1 个订阅者时，循环启动；订阅者归零后停止（节流）。
 *   3. 每次拿到上游数据，立即：
 *        a) 写入 quote_snapshots 表
 *        b) 在 broker 上 emit('tick', { code, val })
 *   4. SSE 连接按 code 维护一份 Set<res>：emit 时对所有 res.write(...) 推送。
 *
 * SSE 心跳：
 *   15 秒一次 ":keepalive\n\n" 注释，保活反代层与浏览器 EventSource。
 */
const { EventEmitter } = require('events');
const market = require('./market.cjs');
const dbHelper = require('./db.cjs');

const STOCK_INTERVAL_MS = 10 * 1000;   // 股票 10 秒
const FUND_INTERVAL_MS  = 60 * 1000;   // 基金 60 秒
const KEEPALIVE_MS      = 15 * 1000;   // SSE 心跳
const SNAPSHOT_TTL_DAYS = 90;           // 行情快照保留 90 天

class ValuationBroker {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);

    /** code -> { kind, timer, lastSnapshot, subscribers: number } */
    this.codes = new Map();

    /** 是否已经启动 keepalive */
    this._keepaliveTimer = null;

    setInterval(() => this._purgeOldSnapshots(), 60 * 60 * 1000)
      .unref?.();
  }

  /** 启动全局 SSE keepalive（首次调用时延迟启动） */
  _ensureKeepalive() {
    if (this._keepaliveTimer) return;
    this._keepaliveTimer = setInterval(() => {
      // :keepalive 注释；前端 EventSource 自动忽略
      this.emitter.emit('keepalive');
    }, KEEPALIVE_MS);
    this._keepaliveTimer.unref?.();
  }

  /**
   * 订阅 code 的实时行情。
   * 多次订阅同一 code 不会重复触发抓取循环，仅累加 subscriber 计数。
   */
  subscribe(code, kind = 'stock') {
    code = code.trim().toUpperCase();
    const interval = kind === 'fund' ? FUND_INTERVAL_MS : STOCK_INTERVAL_MS;
    let entry = this.codes.get(code);
    if (!entry) {
      entry = {
        kind,
        interval,
        timer: null,
        subscribers: 0,
        lastEmitAt: 0,
        lastEmittedSnapshot: null,
      };
      this.codes.set(code, entry);
    } else if (entry.kind !== kind) {
      // 同一个 code 的 kind 切换：直接覆盖（理论上不会发生）
      entry.kind = kind;
      entry.interval = interval;
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    }

    entry.subscribers += 1;
    if (!entry.timer) {
      this._startFetchLoop(code, entry);
    }
    this._ensureKeepalive();
    return () => this.unsubscribe(code);
  }

  unsubscribe(code) {
    code = code.trim().toUpperCase();
    const entry = this.codes.get(code);
    if (!entry) return;
    entry.subscribers = Math.max(0, entry.subscribers - 1);
    if (entry.subscribers === 0 && entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
  }

  _startFetchLoop(code, entry) {
    const fetchOnce = async () => {
      try {
        const val = await market.getFundValuation(code, entry.kind);
        if (!val) return;
        const now = Date.now();
        // 防止上游返回同一个 gztime 反复 emit（节流 + 去重）
        const sig = `${val.gztime || ''}|${val.gsz || ''}|${val.gszzl || ''}`;
        if (entry.lastEmittedSnapshot === sig) return;
        entry.lastEmittedSnapshot = sig;
        entry.lastEmitAt = now;

        // 写库（best-effort，不阻塞推送）
        this._persistSnapshot(code, val).catch((e) =>
          console.warn(`[realtime] save snapshot ${code} failed:`, e.message)
        );

        this.emitter.emit('tick', { code, val, capturedAt: now });
      } catch (e) {
        console.warn(`[realtime] fetch ${code} failed:`, e.message);
      }
    };
    // 立即先跑一次，避免客户端首次打开等 10s 才看到第一帧
    fetchOnce();
    entry.timer = setInterval(fetchOnce, entry.interval);
    entry.timer.unref?.();
  }

  async _persistSnapshot(code, val) {
    const capturedAt = Date.now();
    const gztime = val.gztime || '';
    const current = parseFloat(val.gsz);
    const pct = parseFloat(val.gszzl);
    const raw = JSON.stringify(val);
    await dbHelper.run(
      `INSERT OR REPLACE INTO quote_snapshots (code, captured_at, gztime, current, pct, raw)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [code, capturedAt, gztime, Number.isFinite(current) ? current : null,
       Number.isFinite(pct) ? pct : null, raw]
    );
  }

  async _purgeOldSnapshots() {
    try {
      const cutoff = Date.now() - SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1000;
      const r = await dbHelper.run(
        `DELETE FROM quote_snapshots WHERE captured_at < ?`,
        [cutoff]
      );
      if (r.changes > 0) {
        console.log(`[realtime] 已清理 ${r.changes} 条过期行情快照`);
      }
    } catch (e) {
      console.warn('[realtime] purge snapshots 失败:', e.message);
    }
  }

  /** 调试 / 测试 */
  stats() {
    const out = [];
    for (const [code, e] of this.codes.entries()) {
      out.push({ code, kind: e.kind, subscribers: e.subscribers });
    }
    return out;
  }
}

const broker = new ValuationBroker();

module.exports = {
  broker,
  ValuationBroker,
};
