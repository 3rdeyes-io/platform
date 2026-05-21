// Live stats proxy - fetches from VPS stats server
const VPS = 'http://198.211.100.161:8765';

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
    // Track record is being rebuilt directly from Kalshi settlement records.
    // Until that's complete, do not expose any win/loss numbers - the prior
    // public ledger was under-recording losses and we will not republish
    // figures we cannot fully stand behind.
    if (endpoint === '/stats' && data && typeof data === 'object') {
      delete data.wins; delete data.losses; delete data.winRate; delete data.totalTrades;
      data.trackRecord = 'under_reconstruction';
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
      // Fallback: VPS stats endpoint unreachable. Do not surface fabricated
      // numbers - return the honest "under reconstruction" state.
      trackRecord: 'under_reconstruction',
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
