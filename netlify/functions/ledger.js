/**
 * ledger.js  (Netlify Functions v2)
 *
 * Serves the exchange-verified ledger WITHOUT a site deploy. The VPS regenerates
 * ledger.json daily and pushes it to the repo's `data` branch (which Netlify does
 * NOT build — allowed_branches is ["main"]), so updates cost zero deploy credits.
 * This function fetches that file from GitHub raw and returns it with a 5-minute
 * CDN cache, so the function itself runs only a few times an hour.
 *
 * Pages fetch /.netlify/functions/ledger and fall back to their static content if
 * this ever fails.
 */

const RAW = "https://raw.githubusercontent.com/3rdeyes-io/platform/data/ledger.json";

export default async () => {
  try {
    const r = await fetch(RAW, {
      headers: { Accept: "application/json" },
      // bust GitHub's own ~5-min raw cache only as much as needed
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `upstream ${r.status}` }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    const body = await r.text();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // CDN caches the response 5 min → ~12 function calls/hour max, ~free.
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
};
