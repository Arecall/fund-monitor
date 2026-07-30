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
const marketHelper = require('./market.cjs');
const dbHelper = require('./db.cjs');

const STOCK_INTERVAL_MS = 10 * 1000;   // 股票 10 秒
const FUND_INTERVAL_MS  = 60 * 1000;   // 基金 60 秒
const KEEPALIVE_MS      = 15 * 1000;   // SSE 心跳
const SNAPSHOT_TTL_DAYS = 31;           // 行情快照保留 31 天（已落库数据需要复盘时查阅）
const CLOSE_GRACE_MS    = 60 * 1000;   // 收盘后 1 分钟停止抓取循环

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

      // 定时保活的同时检测：如果有处于 closed=true 但有订阅者且已到开盘时间的条目，自动拉起
      const now = new Date();
      for (const [code, entry] of this.codes.entries()) {
        if (entry.closed && entry.subscribers > 0) {
          try {
            if (marketHelper.isInTradingTime(code, now, entry.market || undefined)) {
              entry.closed = false;
              console.log(`[realtime] ${code} 交易时段开启（保活检测），自动恢复抓取`);
              this._startFetchLoop(code, entry);
            }
          } catch {}
        }
      }
    }, KEEPALIVE_MS);
    this._keepaliveTimer.unref?.();
  }

  /**
   * 订阅 code 的实时行情。
   * 多次订阅同一 code 不会重复触发抓取循环，仅累加 subscriber 计数。
   * @param {string} code    6 位 / 5 位 / 1-5 位字母 ticker
   * @param {'stock'|'fund'} kind  决定抓取节拍；自动收盘判定不影响节拍
   * @param {'domestic'|'hk'|'us'|'other'} [market] 显式传入市场类别（用于 isInTradingTime）
   */
  subscribe(code, kind = 'stock', market = null) {
    code = code.trim().toUpperCase();
    const interval = kind === 'fund' ? FUND_INTERVAL_MS : STOCK_INTERVAL_MS;
    let entry = this.codes.get(code);
    if (!entry) {
      entry = {
        code,
        kind,
        interval,
        market,
        timer: null,
        subscribers: 0,
        lastEmitAt: 0,
        lastEmittedSnapshot: null,
        lastEmittedVal: null,
        closed: false,
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
    } else if (market && !entry.market) {
      // 补充 market 信息
      entry.market = market;
    }

    entry.subscribers += 1;

    // 检查：如果此前标记为已收盘 (closed = true)，但此时已迎来新交易日/开盘时段 (inSession = true)
    // 则重置 closed 标识并拉起抓取循环（实现跨夜/跨周末长连接的自动开盘恢复）
    const now = new Date();
    const inSession = marketHelper.isInTradingTime(code, now, entry.market || undefined);

    if (entry.closed && inSession) {
      entry.closed = false;
      console.log(`[realtime] ${code} 重新进入交易时段，自动恢复抓取`);
      this._startFetchLoop(code, entry);
    } else if (entry.closed) {
      // 仍然处于收盘阶段：不再启动循环，立即 emit 一次 closed 让前端感知
      const payload = {
        code,
        kind: entry.kind,
        lastVal: entry.lastEmittedVal,
        closedAt: entry.lastEmitAt || Date.now(),
      };
      this.emitter.emit('closed', payload);
    } else if (!entry.timer) {
      // 收盘判定：若订阅瞬间已是收盘后状态，直接走 closed 路径
      if (this._isRecentlyClosed(entry)) {
        this._stopAndAnnounceClosed(entry);
      } else {
        this._startFetchLoop(code, entry);
      }
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

  /**
   * 判定当前 entry 是否已经"收盘 + 已过 1 分钟"。
   * - 不在日内交易时段（周末、节假日、跨日交易空档）
   * - 距离最近一次成功 emit ≥ 60 秒，或从未 emit 过
   * 返回 true 则应停止循环并 emit closed。
   */
  _isRecentlyClosed(entry) {
    const now = new Date();
    let inSession;
    try {
      inSession = marketHelper.isInTradingTime(entry.code, now, entry.market || undefined);
    } catch (e) {
      return false;  // 判定失败保守放行
    }
    if (inSession) return false;
    // 不在交易时段：距离最近一次 emit > 1 分钟
    if (!entry.lastEmitAt) return true;
    return (Date.now() - entry.lastEmitAt) >= CLOSE_GRACE_MS;
  }

  _stopAndAnnounceClosed(entry) {
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
    entry.closed = true;
    const payload = {
      code: entry.code,
      kind: entry.kind,
      lastVal: entry.lastEmittedVal,
      closedAt: entry.lastEmitAt || Date.now(),
    };
    this.emitter.emit('closed', payload);
    console.log(`[realtime] ${entry.code} 已收盘, 停止抓取循环`);
  }

  _startFetchLoop(code, entry) {
    const fetchOnce = async () => {
      try {
        // 如果在非交易时段，但尚未触发收盘停止判定，检查上一帧数据
        // 如果是美股基金且进入非交易时段已超 1 分钟，或者 fetchOnce 抓取时发现不属于交易时段，则停止
        if (this._isRecentlyClosed(entry)) {
          this._stopAndAnnounceClosed(entry);
          return;
        }

        const val = await marketHelper.getFundValuation(code, entry.kind);
        if (!val) return;
        const now = Date.now();
        // 防止上游返回同一个 gztime 反复 emit（节流 + 去重）
        const sig = `${val.gztime || ''}|${val.gsz || ''}|${val.gszzl || ''}`;
        if (entry.lastEmittedSnapshot === sig) {
          // 数据未变时，若不在交易时段且距离上次 emit 已超 1 分钟，直接停掉抓取
          if (this._isRecentlyClosed(entry)) {
            this._stopAndAnnounceClosed(entry);
          }
          return;
        }
        entry.lastEmittedSnapshot = sig;
        entry.lastEmitAt = now;
        entry.lastEmittedVal = val;

        // 写库（best-effort，不阻塞推送）
        this._persistSnapshot(code, val).catch((e) =>
          console.warn(`[realtime] save snapshot ${code} failed:`, e.message)
        );

        this.emitter.emit('tick', { code, val, capturedAt: now });

        // emit 完成后做收盘判定
        if (this._isRecentlyClosed(entry)) {
          this._stopAndAnnounceClosed(entry);
        }
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

      // GC：清理内存字典中 subscribers === 0 且 timer === null 的已退订无用节点
      let purgedCount = 0;
      for (const [code, entry] of this.codes.entries()) {
        if (entry.subscribers <= 0 && !entry.timer) {
          this.codes.delete(code);
          purgedCount++;
        }
      }
      if (purgedCount > 0) {
        console.log(`[realtime] 已垃圾回收 ${purgedCount} 个已退订的内存节点`);
      }
    } catch (e) {
      console.warn('[realtime] purge snapshots 失败:', e.message);
    }
  }

  /** 调试 / 测试 */
  stats() {
    const out = [];
    for (const [code, e] of this.codes.entries()) {
      out.push({
        code,
        kind: e.kind,
        subscribers: e.subscribers,
        closed: !!e.closed,
        timer: !!e.timer,
      });
    }
    return out;
  }
}

const broker = new ValuationBroker();

module.exports = {
  broker,
  ValuationBroker,
};
