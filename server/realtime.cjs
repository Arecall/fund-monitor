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
const marketTime = require('./time.cjs');
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
            if (marketHelper.shouldPollValuationNow(code, entry.market || undefined, entry.kind, now)) {
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
        lastEnrichmentSnapshot: null,
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
    const inSession = marketHelper.shouldPollValuationNow(code, entry.market || undefined, entry.kind, now);

    if (entry.closed && inSession) {
      entry.closed = false;
      console.log(`[realtime] ${code} 重新进入交易时段，自动恢复抓取`);
      this._startFetchLoop(code, entry);
    } else if (entry.closed) {
      // 仍然处于收盘阶段：不再启动循环，立即 emit 一次 closed 让前端感知
      const closedAt = entry.lastEmitAt || Date.now();
      entry.lastEmittedVal = this._markClosedProxySnapshot(entry.lastEmittedVal, closedAt);
      const payload = {
        code,
        kind: entry.kind,
        lastVal: entry.lastEmittedVal,
        closedAt,
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
      inSession = marketHelper.shouldPollValuationNow(entry.code, entry.market || undefined, entry.kind, now);
    } catch (e) {
      return false;  // 判定失败保守放行
    }
    if (inSession) return false;
    // 不在交易时段：距离最近一次 emit > 1 分钟
    if (!entry.lastEmitAt) return true;
    return (Date.now() - entry.lastEmitAt) >= CLOSE_GRACE_MS;
  }

  _markClosedProxySnapshot(val, closedAt = Date.now()) {
    if (!val || (!val.proxyTicker && !val.quoteTimestamp)) return val;
    return {
      ...val,
      quoteSession: 'closed',
      quoteFreshness: 'stale',
      quoteAgeMs: val.quoteTimestamp ? Math.max(0, closedAt - val.quoteTimestamp) : (val.quoteAgeMs ?? null),
      proxyFallbackReason: val.proxyFallbackReason || '交易时段已结束，保留最后有效代理报价',
    };
  }

  _stopAndAnnounceClosed(entry) {
    if (entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
    entry.closed = true;

    // 收盘后将 lastVal.gztime 重写为该市场当次收盘时刻（北京时间）
    // 目的：上游 QDII 基金接口在盘后会持续返回"当前北京时间"，
    //       显示 10:06 这种尚未收盘的真实时间戳容易误导用户，
    //       此处统一冻结为标准收盘时刻 (夏令 04:00 / 冬令 05:00)
    //
    // 关键修复：即便 lastEmittedVal 仍为 null（首次进入 fetchOnce 就已是非交易时段，
    //           此前从未 emit 过 tick），也要用 entry.market 判定并构造一个冻结快照推给前端，
    //           否则前端 fundsData 保留着初次加载时的 10:24 上游时间戳，UI 持续误导用户。
    const isUs = entry.market === 'us' || (entry.lastEmittedVal && entry.lastEmittedVal.market === 'us');
    // 代理行情已携带真实上游 quoteTime；不能覆写成美股常规盘收盘时间。
    const hasExplicitProxyQuoteTime = !!entry.lastEmittedVal?.quoteTimestamp;
    if (isUs && !hasExplicitProxyQuoteTime) {
      try {
        const now = new Date();
        // 冻结的日期与夏/冬令时必须来自同一笔最后行情，避免 DST 切换周末
        // 用今天的规则覆盖上周五收盘规则而导致 04:00 / 05:00 错位。
        const lastDate = new Date(entry.lastEmitAt || Date.now());
        const closeHour = marketTime.isUsEasternDst(lastDate) ? 4 : 5;
        // 收盘时间字符串必须按北京时间生成，不能依赖部署主机的本地时区。
        const jzrq = marketTime.formatBeijingYmd(lastDate);
        const frozenGztime = `${jzrq} ${String(closeHour).padStart(2, '0')}:00`;
        if (entry.lastEmittedVal) {
          entry.lastEmittedVal = {
            ...entry.lastEmittedVal,
            gztime: frozenGztime,
          };
        } else {
          // 无历史 emit：从数据库快照兜底读取上一帧"已收盘"数据，否则只发空骨架
          const stored = this._loadLastClosedSnapshotFromDb(entry.code);
          if (stored) {
            entry.lastEmittedVal = { ...stored, gztime: frozenGztime };
          } else {
            // 没有真实的内存/落库行情时只能明确表示"无可用收盘价"。
            // 绝不能构造 0.0000 骨架，否则前端会把它当作有效报价覆盖真实数据。
            entry.lastEmittedVal = null;
          }
        }
      } catch (e) {
        console.warn(`[realtime] close-snapshot rewrite failed for ${entry.code}:`, e.message);
      }
    }

    const closedAt = entry.lastEmitAt || Date.now();
    entry.lastEmittedVal = this._markClosedProxySnapshot(entry.lastEmittedVal, closedAt);
    const payload = {
      code: entry.code,
      kind: entry.kind,
      lastVal: entry.lastEmittedVal,
      closedAt,
    };
    this.emitter.emit('closed', payload);
    console.log(`[realtime] ${entry.code} 已收盘, 停止抓取循环`);
  }

  /**
   * 从数据库中读取最近一次"已收盘/夜盘"时刻的快照，作为首次停止时构造冻结 lastVal 的兜底数据源。
   * 仅返回 captured_at 在最近 48 小时内的快照，避免被 1 周前的陈旧数据覆盖。
   * 返回 null 表示无任何可用快照。
   */
  _loadLastClosedSnapshotFromDb(code) {
    try {
      const since = Date.now() - 48 * 60 * 60 * 1000;
      const row = dbHelper.get(
        `SELECT raw FROM quote_snapshots WHERE code = ? AND captured_at >= ? ORDER BY captured_at DESC LIMIT 1`,
        [code, since]
      );
      if (!row || !row.raw) return null;
      try {
        const val = JSON.parse(row.raw);
        const price = parseFloat(val?.gsz) || parseFloat(val?.dwjz);
        return Number.isFinite(price) && price > 0 ? val : null;
      } catch { return null; }
    } catch (e) {
      console.warn(`[realtime] loadLastClosedSnapshotFromDb failed for ${code}:`, e.message);
      return null;
    }
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

        // ─── 关键：自纠 market ───
        // watchlist 里 6 位基金常常被粗略存为 'domestic'（前端添加时 market 检测对
        // QDII 名称敏感度不足），但 fundgz 返回的 val.name 含「全球/纳斯达克/标普」
        // 等关键词，真实市场为 US。错配的 market 会让 broker 把 10:00 北京时间误判
        // 为 A 股盘中继续抓取 — 这里用 val.market (上游返回) 覆写一次 entry.market，
        // 让 _isRecentlyClosed 用正确的市场时段判定。
        let marketSelfCorrected = false;
        if (val.market && val.market !== entry.market) {
          const prev = entry.market;
          entry.market = val.market;
          marketSelfCorrected = !!prev && prev !== val.market;
          if (marketSelfCorrected) {
            console.log(`[realtime] ${code} market self-correct: ${prev} → ${val.market} (by upstream name)`);
          }
        }

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

        // 首帧只承载核心价格字段；市值、换手率与资金流在后台完成后以第二个 tick 补齐。
        // 该路径不走价格签名去重，因为扩展字段不会改变价格/时间。
        if (val.stockSpecific && val.market && val.market !== 'other') {
          const baseEnrichmentSig = JSON.stringify({
            totalMarketCap: val.stockSpecific.totalMarketCap ?? null,
            floatMarketCap: val.stockSpecific.floatMarketCap ?? null,
            turnoverRate: val.stockSpecific.turnoverRate ?? null,
            flow: val.stockSpecific.flow ?? null,
          });
          void marketHelper.enrichStockValuation(code, entry.kind, val)
            .then(enriched => {
              if (!enriched?.stockSpecific || entry.subscribers === 0) return;
              const specific = enriched.stockSpecific;
              const enrichmentSig = JSON.stringify({
                totalMarketCap: specific.totalMarketCap ?? null,
                floatMarketCap: specific.floatMarketCap ?? null,
                turnoverRate: specific.turnoverRate ?? null,
                flow: specific.flow ?? null,
              });
              // 每次基础报价 tick 都不带扩展字段，会覆盖前端上一帧的 flow。
              // 即使资金流数值未变化，也需要再推一次扩展 tick，将其合并回详情页。
              if (enrichmentSig === baseEnrichmentSig) return;

              entry.lastEnrichmentSnapshot = enrichmentSig;
              entry.lastEmittedVal = enriched;
              const enrichedAt = Date.now();
              this._persistSnapshot(code, enriched).catch((e) =>
                console.warn(`[realtime] save enriched snapshot ${code} failed:`, e.message)
              );
              this.emitter.emit('tick', { code, val: enriched, capturedAt: enrichedAt });
            })
            .catch((e) => console.warn(`[realtime] enrich ${code} failed:`, e.message));
        }

        // emit 完成后做收盘判定。
        // 若本轮刚从错的 market (例如 'domestic') 自纠为正确的 'us'，强制无视
        // 1 分钟 grace 直接判收 — 否则首次 self-correct 后 _isRecentlyClosed 仍
        // 因 lastEmitAt 刚刚 set 而放行，broker 继续每 60s 抓取基金接口，UI 仍显示
        // 上游 fundgz 返回的"今天当前北京时间"。
        const inTradingNow = marketHelper.shouldPollValuationNow(code, entry.market || undefined, entry.kind, now);
        if (!inTradingNow && (marketSelfCorrected || this._isRecentlyClosed(entry))) {
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
    if (!val || val.navOnly || val.isPlaceholder) return;
    const capturedAt = Date.now();
    const current = parseFloat(val.gsz);
    if (!Number.isFinite(current) || current <= 0) return;

    // 拦截美股 QDII 基金在白天 A 股开盘阶段上游返回的非交易占位估值
    if (val.market === 'us') {
      const d = new Date(capturedAt);
      const bjtHour = marketTime.getBeijingHour(d);
      // 北京时间 05:00 - 16:00 属于美股休市/夜盘低频阶段，防注入白天静态占位数据
      if (!val.quoteTimestamp && bjtHour >= 5 && bjtHour < 16) {
        return;
      }
    }

    const gztime = val.gztime || '';
    const pct = parseFloat(val.gszzl);
    const raw = JSON.stringify(val);
    await dbHelper.run(
      `INSERT OR REPLACE INTO quote_snapshots (code, captured_at, gztime, current, pct, raw)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [code, capturedAt, gztime, current, Number.isFinite(pct) ? pct : null, raw]
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
