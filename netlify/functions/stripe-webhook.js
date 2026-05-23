/**
 * stripe-webhook.js
 * Netlify Function - handles Stripe checkout.session.completed events.
 *
 * Flow:
 *   1. Stripe fires webhook after successful payment
 *   2. We verify the signature (prevents spoofing)
 *   3. Retrieve the session to identify the plan (Pro vs Execution Pipeline)
 *   4. Create a one-time Telegram invite link for the correct channel
 *   5. Email the invite link to the subscriber via Resend
 */

const stripe = require('stripe');

// HTML-escape any value interpolated into the welcome-email markup. The customer
// name comes from Stripe, but we never inject raw user text into HTML.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ── Plan routing ──────────────────────────────────────────────────────────── */
// Real products: Pro ($49/mo) and Execution Pipeline ($499 one-time, which also
// includes Pro). There is NO separate "Elite" tier or channel — both buyers join
// the Pro signals channel; Pipeline buyers additionally get a setup session.
function getPlan(priceId) {
  const proId      = process.env.STRIPE_PRO_PRICE_ID;
  const pipelineId = process.env.STRIPE_PIPELINE_PRICE_ID || process.env.STRIPE_ELITE_PRICE_ID; // back-compat env name
  if (priceId && priceId === pipelineId) return 'pipeline';
  if (priceId && priceId === proId)      return 'pro';
  return 'pro'; // default fallback
}

// Both Pro and Execution Pipeline buyers join the Pro channel (Pipeline includes
// Pro). There is no separate Elite channel.
function getChannelId(_plan) {
  return process.env.TELEGRAM_PRO_CHANNEL_ID;
}

/* ── Telegram helper ───────────────────────────────────────────────────────── */
async function createTelegramInvite(channelId) {
  const expireDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 days
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createChatInviteLink`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:              channelId,
      member_limit:         1,      // one-time use
      expire_date:          expireDate,
      creates_join_request: false,
    }),
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`Telegram createChatInviteLink failed: ${data.description}`);
  }
  return data.result.invite_link;
}

/* ── Email helper (Resend) ─────────────────────────────────────────────────── */
async function sendWelcomeEmail({ toEmail, toName, plan, inviteLink }) {
  const isPipeline = plan === 'pipeline';
  const planLabel  = isPipeline ? 'Pro + Execution Pipeline' : 'Pro';
  const emoji      = isPipeline ? '🚀' : '⚡';
  const firstName  = toName ? esc(toName.split(' ')[0]) : '';
  const pipelineNote = isPipeline
    ? `<p style="margin:0 0 24px;color:#ccc;font-size:15px;line-height:1.6;">Your <strong style="color:#818cf8;">Execution Pipeline</strong> setup is reserved - we will reach out within 24 hours to schedule your one-on-one session (your server, your keys, fully automated).</p>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif;color:#e0e0e0;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111;border-radius:12px;border:1px solid #222;overflow:hidden;">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#00d4ff,#0077ff);padding:30px;text-align:center;">
            <p style="margin:0;font-size:32px;font-weight:900;color:#000;letter-spacing:-1px;">3<sup style="font-size:18px;">rd</sup> EYES</p>
            <p style="margin:6px 0 0;font-size:13px;color:#003344;letter-spacing:3px;text-transform:uppercase;">AI Weather Signals</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <h2 style="margin:0 0 8px;font-size:22px;color:#fff;">${emoji} Welcome to ${planLabel}!</h2>
            <p style="margin:0 0 24px;color:#aaa;font-size:15px;">Hi${firstName ? ' ' + firstName : ''},</p>
            <p style="margin:0 0 24px;color:#ccc;font-size:15px;line-height:1.6;">
              Your <strong style="color:#00d4ff;">${planLabel}</strong> access is now active.
              Click below to join your private signals channel - our AI posts trade alerts
              before the market moves.
            </p>
            ${pipelineNote}
            <!-- CTA button -->
            <table cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
              <tr>
                <td style="background:#00d4ff;border-radius:8px;">
                  <a href="${inviteLink}"
                     style="display:block;padding:14px 36px;font-size:16px;font-weight:700;color:#000;text-decoration:none;letter-spacing:0.5px;">
                    Join ${planLabel} Channel →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;color:#666;font-size:13px;text-align:center;">
              ⏱ This invite is <strong>one-time use</strong> and expires in 7 days.
            </p>
            <hr style="border:none;border-top:1px solid #222;margin:28px 0;">
            <p style="margin:0;color:#555;font-size:13px;line-height:1.6;">
              Questions? Reply to this email or message us on Telegram @thirdeyes_signals.<br>
              - The 3rd Eyes Team
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 40px;background:#0d0d0d;text-align:center;">
            <p style="margin:0;color:#333;font-size:11px;">
              3rd Eyes · 3rdeyes.io · You're receiving this because you subscribed.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:    '3rd Eyes Signals <signals@3rdeyes.io>',
      to:      [toEmail],
      subject: `${emoji} Your ${planLabel} channel invite - 3rd Eyes`,
      html,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend email failed (${resp.status}): ${errText}`);
  }

  const result = await resp.json();
  console.log(`Email sent to ${toEmail} - ID: ${result.id}`);
  return result.id;
}

/* ── Also post invite to a private Telegram admin log ──────────────────────── */
async function logToAdmin(message) {
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!adminChatId) return;

  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    adminChatId,
      text:       message,
      parse_mode: 'HTML',
    }),
  }).catch(() => {});
}

/* ── Main handler ──────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── 1. Verify Stripe webhook signature ───────────────────────────────────
  const sig = event.headers['stripe-signature'];
  if (!sig) {
    return { statusCode: 400, body: 'Missing stripe-signature header' };
  }

  let stripeEvent;
  const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

  // Stripe signs the EXACT raw request bytes. Netlify base64-encodes function
  // request bodies (event.isBase64Encoded === true), so event.body is NOT the
  // raw payload Stripe signed — passing it straight to constructEvent fails every
  // time with "No signatures found matching the expected signature for payload".
  // Decode back to the original UTF-8 bytes before verifying.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    stripeEvent = stripeClient.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook signature error: ${err.message}` };
  }

  // ── 2. Only handle completed checkouts ──────────────────────────────────
  if (stripeEvent.type !== 'checkout.session.completed') {
    console.log(`Ignored event type: ${stripeEvent.type}`);
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  const customerEmail = session.customer_details?.email;
  const customerName  = session.customer_details?.name || '';

  if (!customerEmail) {
    console.error('No customer email in session:', session.id);
    return { statusCode: 200, body: 'No email - skipped' };
  }

  // ── 3. Identify plan from line items ────────────────────────────────────
  let plan = 'pro'; // default
  try {
    const fullSession = await stripeClient.checkout.sessions.retrieve(
      session.id,
      { expand: ['line_items'] }
    );
    const priceId = fullSession.line_items?.data?.[0]?.price?.id;
    if (priceId) plan = getPlan(priceId);
  } catch (err) {
    // Fallback only runs if line-item retrieval failed. Pro is $49 and the Execution
    // Pipeline is $499 (one-time), so an amount of $100+ cleanly indicates Pipeline.
    const amount = session.amount_total || 0;
    if (amount >= 10000) plan = 'pipeline';
    console.warn(`Could not retrieve line items (${err.message}), inferred plan=${plan} from amount=${amount}`);
  }

  const channelId = getChannelId(plan);
  if (!channelId) {
    console.error(`No channel ID configured for plan: ${plan}`);
    return { statusCode: 500, body: `Channel not configured for plan: ${plan}` };
  }

  console.log(`New ${plan} subscriber: ${customerEmail}`);

  // ── 4. Create invite + send email ───────────────────────────────────────
  try {
    const inviteLink = await createTelegramInvite(channelId);

    await sendWelcomeEmail({
      toEmail:    customerEmail,
      toName:     customerName,
      plan,
      inviteLink,
    });

    await logToAdmin(
      `🎉 <b>New ${plan.toUpperCase()} subscriber</b>\n` +
      `📧 ${customerEmail}\n` +
      `🔗 ${inviteLink}` +
      (plan === 'pipeline'
        ? `\n\n💼 <b>EXECUTION PIPELINE - action needed:</b> reach out to schedule the setup session.`
        : '')
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, plan, email: customerEmail }),
    };

  } catch (err) {
    console.error('Pipeline error:', err.message);

    await logToAdmin(
      `⚠️ <b>Webhook pipeline FAILED</b>\n` +
      `📧 ${customerEmail}\n` +
      `❌ ${err.message}`
    );

    return { statusCode: 500, body: `Pipeline error: ${err.message}` };
  }
};
