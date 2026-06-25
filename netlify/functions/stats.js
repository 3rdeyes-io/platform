// Live stats proxy - fetches from the VPS stats server (operational data only).
// Source the origin from an env var so the raw IP isn't hardcoded in the repo and so
// an HTTPS hostname can be swapped in (Netlify env: VPS_STATS_URL) without a code change.
// This is a server-side call (function -> VPS), so there is no browser mixed-content.
const VPS = process.env.VPS_STATS_URL || 'http://198.211.100.161:8765';

exports.handler = async (event) => {
  const path = (event.path || '').replace('/.netlify/functions/stats', '') || '/stats';
  const endpoint = (path === '/trades')      ? '/trades'
                 : (path === '/scans')       ? '/scans'
                 : (path === '/calibration') ? '/calibration'
                 : (path === '/shifts')      ? '/shifts'
                 : '/stats';

  try {
    // 2.5s timeout (was 8s). If the VPS stats server is slow/down, an 8s timeout
    // meant every invocation burned ~8s of function execution - a huge credit
    // multiplier. 2.5s fails fast to the cached fallback instead.
    const res = await fetch(VPS + endpoint, {
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) throw new Error('VPS ' + res.status);
    const data = await res.json();
    // Performance numbers (win rate, W/L, net) have ONE source of truth: the verified
    // ledger served by /.netlify/functions/ledger. This stats endpoint is operational
    // only (balance, scan timing), so strip any perf fields - it must never disagree
    // with the ledger.
    if (endpoint === '/stats' && data && typeof data === 'object') {
      delete data.wins; delete data.losses; delete data.winRate; delete data.totalTrades;
      delete data.trackRecord;
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': endpoint === '/trades'      ? 'public, max-age=120'
                       : endpoint === '/scans'       ? 'public, max-age=60'
                       : endpoint === '/calibration' ? 'public, max-age=600'
                       : endpoint === '/shifts'      ? 'public, max-age=120'
                       : 'public, max-age=300',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    // Fallback
    const fallback = endpoint === '/trades'      ? []
                   : endpoint === '/scans'       ? { today: null, recent: [] }
                   : endpoint === '/calibration' ? { stations: [], summary: {} }
                   : endpoint === '/shifts'      ? { recent_shifts: [], tracked_pairs: 0 }
                   : {
      // Fallback: VPS stats endpoint unreachable. Operational state only; performance
      // numbers come from the ledger function, never from here.
      balance: null, cities: 7,
      lastScan: null, lastMonitor: null,
      scanIntervalSec: 300, monitorIntervalSec: 30
    };
    // CRITICAL: cache the fallback too. Without a Cache-Control header, a
    // down-VPS response was NOT cached by the CDN - so every single request
    // re-invoked the function (and re-timed-out). Caching the fallback for 60s
    // means an outage is served from CDN cache instead of hammering the function.
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(fallback)
    };
  }
};
