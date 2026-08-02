/**
 * methodology-full.js
 *
 * Serves the FULL methodology (signal pipeline, calibration, execution framework)
 * to Execution-Pipeline ($499) buyers only.
 *
 * SECURITY MODEL - deliberately server-side:
 *  - Entitlement is decided HERE by querying Stripe, never by the browser. The page
 *    only asks; this function decides. (A hidden div or a `localStorage.isPro = true`
 *    is not access control - the user controls the browser.)
 *  - Access is proven by an emailed magic link carrying an HMAC token bound to the
 *    buyer's email + expiry. Tokens are unguessable and unforgeable without
 *    METHODOLOGY_SECRET; no sequential ids to enumerate (no IDOR).
 *  - Content lives OUTSIDE the deployed static site, so there is no public URL to
 *    discover. Nothing gated is in the HTML bundle.
 *  - Rate-limited per email/IP to make guessing and email-bombing impractical.
 *
 * Routes (POST):
 *   {action:"request", email}         -> emails a magic link if the buyer qualifies
 *   {action:"verify",  token}         -> returns the gated HTML
 */
const crypto = require('crypto');

const SECRET = process.env.METHODOLOGY_SECRET || '';
const TTL_MS = 1000 * 60 * 60 * 24 * 30;          // links valid 30 days
const hits = new Map();                            // in-memory best-effort throttle

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!SECRET || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  // timing-safe compare
  const a = Buffer.from(mac || ''), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

function throttled(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

/** Does this email have an active Execution Pipeline entitlement? Stripe is the truth. */
async function isPipelineBuyer(stripe, email) {
  const customers = await stripe.customers.list({ email, limit: 5 });
  for (const c of customers.data) {
    // one-time $499 purchase
    const sessions = await stripe.checkout.sessions.list({ customer: c.id, limit: 20 });
    for (const s of sessions.data) {
      if (s.payment_status === 'paid' && (s.amount_total || 0) >= 49900) return true;
      if (s.metadata && s.metadata.plan === 'pipeline' && s.payment_status === 'paid') return true;
    }
    // or an active sub explicitly tagged pipeline
    const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 10 });
    for (const s of subs.data) {
      if (['active', 'trialing'].includes(s.status) && s.metadata && s.metadata.plan === 'pipeline') return true;
    }
  }
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!SECRET) {
    console.error('METHODOLOGY_SECRET not configured');
    return { statusCode: 503, body: JSON.stringify({ error: 'Not configured' }) };
  }

  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const action = payload.action;

  // ── verify: exchange a token for the gated content ──────────────────────────
  if (action === 'verify') {
    if (throttled(`v:${ip}`, 30, 60_000)) return { statusCode: 429, body: JSON.stringify({ error: 'Slow down' }) };
    const claims = verify(payload.token);
    if (!claims) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired link' }) };
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      body: JSON.stringify({ ok: true, email: claims.email, html: GATED_HTML }),
    };
  }

  // ── request: email a magic link to a verified buyer ─────────────────────────
  if (action === 'request') {
    const email = String(payload.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email' }) };
    }
    if (throttled(`r:${ip}`, 5, 15 * 60_000) || throttled(`e:${email}`, 3, 15 * 60_000)) {
      return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests. Try again later.' }) };
    }

    let entitled = false;
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      entitled = await isPipelineBuyer(stripe, email);
    } catch (e) {
      console.error('entitlement check failed:', e.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not verify right now' }) };
    }

    if (entitled) {
      const token = sign({ email, exp: Date.now() + TTL_MS });
      const link = `https://3rdeyes.io/methodology-full?t=${encodeURIComponent(token)}`;
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          body: JSON.stringify({
            from: '3rd Eyes <signals@3rdeyes.io>',
            to: [email],
            subject: 'Your 3rd Eyes full methodology access',
            html: `<p>Here is your private access link to the full 3rd Eyes methodology:</p>
                   <p><a href="${link}">Open the full methodology</a></p>
                   <p style="color:#666;font-size:13px">This link is tied to your purchase and expires in 30 days.
                   Please do not forward it - the operational details inside are what your edge is built on.</p>`,
          }),
        });
      } catch (e) {
        console.error('send failed:', e.message);
      }
    }
    // identical response either way: never reveal who is or isn't a customer
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, message: 'If that email has Execution Pipeline access, a link is on its way.' }),
    };
  }

  return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
};

// ── The gated content. Lives here (function bundle), NOT in the public site. ────
const GATED_HTML = `
<h2>Signal Generation Pipeline (full)</h2>
<p>Every market passes a fixed gate sequence. A candidate must clear <em>all</em> of it;
any single failure drops the trade, regardless of how attractive the others look.</p>
<ol>
  <li><strong>Liquidity gate</strong> - bid/ask spread and fillable depth at our target price must clear a floor, or the trade is unmanageable on exit.</li>
  <li><strong>Price window</strong> - we only fade contracts inside a defined NO price band; outside it the payoff geometry stops working.</li>
  <li><strong>Ensemble geometry</strong> - for band markets every member must sit fully outside the band; for threshold markets every member must sit on our side of the strike. Unanimity is required, not a majority.</li>
  <li><strong>Raw-model danger zone</strong> - we re-check the <em>un-bias-corrected</em> members against the band edges, so a bias adjustment can never mask a model that is genuinely close.</li>
  <li><strong>Buffer</strong> - a calibrated minimum separation in degrees F between the ensemble and the strike, set higher for coastal stations than inland.</li>
  <li><strong>Spread ceiling</strong> - ensemble standard deviation must be under a per-regime maximum; disagreement means no trade.</li>
  <li><strong>HRRR confirmation</strong> - for near-term markets the high-resolution model must agree and must not diverge from the ensemble beyond a set tolerance.</li>
  <li><strong>Win-probability floor and edge band</strong> - the calibrated probability must clear a floor <em>and</em> beat the market price by a minimum margin. Critically there is also a <strong>maximum</strong> edge: an implausibly large edge means our forecast is broken, not that the market is wrong, and the trade is rejected.</li>
  <li><strong>Concentration limits</strong> - one position per city per day, a cap per weather region per day, and a cooldown after any stop-out on that event.</li>
</ol>

<h2>Win-Probability &amp; Calibration (full)</h2>
<p>Win probability comes from a normal distribution centred on the bias-corrected ensemble
mean, evaluated against the strike geometry (tail probability for threshold markets, the
sum of both tails for band markets), then capped so no signal is ever presented as a
certainty.</p>
<p>The distribution width is the part that matters most, and it is <strong>learned per city</strong>:</p>
<ul>
  <li>The base width is the ensemble's own disagreement, inflated by a fixed factor, then floored.</li>
  <li>The floor is <strong>trained from ground truth</strong> - we score every historical forecast against the official NOAA daily climate record and take each station's realised error spread. Volatile inland cities carry a materially wider floor than stable desert stations.</li>
  <li>Width grows with lead time; a next-day market is treated as meaningfully less certain than a same-day one.</li>
  <li>A rolling per-station bias correction shifts the mean itself, so a city whose forecasts consistently run cold is adjusted before scoring rather than after losing.</li>
</ul>
<p>The whole calibration retrains weekly and after every settled trade, so the model's
confidence tracks its own measured accuracy rather than an assumption made on day one.</p>

<h2>Execution Framework (full)</h2>
<p>Orders are placed as limits at our target price with a defined time-to-live and a
deterministic idempotency key, so a duplicate or retried run collapses to a single order
instead of doubling exposure. Fills are read back from the exchange and only the quantity
that actually filled is booked.</p>
<p><strong>Sizing is flat.</strong> Every position is the same dollar size regardless of
conviction. Counterfactual replay of our own history showed compounding sizing was
net-negative: one oversized stop-out erased a long run of small wins.</p>
<p><strong>Exit logic is probability-based, not price-based.</strong> A held position's win
probability is recomputed every monitor cycle from the live forecast using the same maths
as entry. We exit when that probability collapses - not when the price dips. This was
calibrated against every historical stop-out: positions stopped on mid-range price dips
recovered the majority of the time, while positions whose forecast genuinely broke almost
never did. A wide price stop remains as a deep backstop for when forecast data is stale.</p>
<p>Band markets use a complementary rule: exit when the live forecast mean enters the band
itself, because a one-degree band's probability is structurally insensitive at that range.</p>

<h2>What we deliberately do not do</h2>
<ul>
  <li>No YES positions - the asymmetry that makes the NO side work inverts.</li>
  <li>No coastal one-degree bands - marine-layer noise made them the single worst cohort in our record.</li>
  <li>No trading a city whose bias model is still cold-started.</li>
  <li>No overriding an exit manually because a position "feels" recoverable.</li>
</ul>
`;
