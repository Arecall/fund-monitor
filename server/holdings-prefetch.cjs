'use strict';

const PREFETCH_SETTING_KEY = 'fund_holdings_composition_last_refresh_ny_date';

function isUsPremarketRefreshWindow(now = new Date(), time = null) {
  const p = time?.getUsEasternDateTimeParts(now) || {};
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return !['Sat', 'Sun'].includes(p.weekday) && minutes >= 8 * 60 + 45 && minutes < 9 * 60 + 30;
}

function createHoldingsPrefetch({ dbHelper, marketHelper, marketTime, logger = console }) {
  let inFlight = false;

  async function refreshIfDue({ force = false, now = new Date() } = {}) {
    if (inFlight) return { skipped: 'in-flight' };
    const marketDate = marketTime.formatUsEasternYmd(now);
    if (!force && !isUsPremarketRefreshWindow(now, marketTime)) return { skipped: 'outside-window', marketDate };

    const saved = await dbHelper.get('SELECT value FROM settings WHERE key = ?', [PREFETCH_SETTING_KEY]);
    if (!force && saved?.value === marketDate) return { skipped: 'already-refreshed', marketDate };

    inFlight = true;
    const startedAt = Date.now();
    try {
      const rows = await dbHelper.all(
        `SELECT DISTINCT fund_code FROM watchlist
         WHERE kind = 'fund' AND fund_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'`
      );
      const result = await marketHelper.refreshFundHoldingCompositions(rows.map(row => row.fund_code));
      await dbHelper.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        [PREFETCH_SETTING_KEY, marketDate]
      );
      logger.log(`[holdings-prefetch] ${marketDate} 完成：${result.success}/${result.total} 成功，${result.empty} 空，${result.failed} 失败，耗时 ${Date.now() - startedAt}ms`);
      return { marketDate, ...result };
    } catch (error) {
      logger.warn(`[holdings-prefetch] ${marketDate} 刷新失败:`, error.message);
      return { marketDate, error: error.message };
    } finally {
      inFlight = false;
    }
  }

  return { refreshIfDue };
}

module.exports = { PREFETCH_SETTING_KEY, isUsPremarketRefreshWindow, createHoldingsPrefetch };
