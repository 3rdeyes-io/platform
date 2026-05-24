/**
 * stripe-webhook.js  (Netlify Functions v2)
 * Handles Stripe checkout.session.completed events.
 *
 * IMPORTANT: this is a v2 function (export default + Web Request/Response) so we can
 * read the RAW request body via `await req.text()`. The classic v1 `event.body` was
 * being delivered byte-different from what Stripe signed, so signature verification
 * failed 100% of the time. req.text() returns the unmodified bytes Stripe signed.
 *
 * Flow:
 *   1. Stripe fires webhook after successful payment
 *   2. Verify the signature against the RAW body (prevents spoofing)
 *   3. Identify the plan (Pro vs Execution Pipeline)
 *   4. Create a one-time Telegram invite link for the correct channel
 *   5. Email the invite link to the subscriber via Resend
 */

import Stripe from 'stripe';

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

/* ── Telegram helpers ──────────────────────────────────────────────────────── */
// `name` is set to the Stripe subscription id (<=32 chars). When the buyer joins
// via this one-time link, Telegram reports invite_link.name in the chat_member
// update, letting telegram-webhook.js record their user id on the subscription —
// which we then use to auto-remove them on cancellation.
async function createTelegramInvite(channelId, name) {
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
      ...(name ? { name: String(name).slice(0, 32) } : {}),
    }),
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`Telegram createChatInviteLink failed: ${data.description}`);
  }
  return data.result.invite_link;
}

// Remove a user from the channel. ban then unban = kicked WITHOUT a permanent
// ban, so they can rejoin (with a fresh invite) if they ever resubscribe.
async function kickFromChannel(channelId, userId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ban = await fetch(`https://api.telegram.org/bot${token}/banChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: channelId, user_id: Number(userId) }),
  }).then(r => r.json()).catch(e => ({ ok: false, description: e.message }));

  await fetch(`https://api.telegram.org/bot${token}/unbanChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: channelId, user_id: Number(userId), only_if_banned: true }),
  }).catch(() => {});

  return ban;
}

/* ── Email helper (Resend) ─────────────────────────────────────────────────── */
async function sendWelcomeEmail({ toEmail, toName, plan, inviteLink }) {
  const isPipeline = plan === 'pipeline';
  const planLabel  = isPipeline ? 'Pro + Execution Pipeline' : 'Pro';
  const emoji      = isPipeline ? '🚀' : '⚡';
  const firstName  = toName ? esc(toName.split(' ')[0]) : '';
  const pipelineNote = isPipeline
    ? `<p style="margin:0 0 12px;color:#ccc;font-size:15px;line-height:1.6;">Your <strong style="color:#818cf8;">Execution Pipeline</strong> is confirmed. Book your 45-minute 1-on-1 setup session now (your server, your keys, fully automated):</p>
       <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;"><tr><td style="background:#6366f1;border-radius:8px;">
         <a href="https://calendly.com/anilshar1327/45mins" style="display:block;padding:13px 32px;font-size:15px;font-weight:700;color:#fff;text-decoration:none;">📅 Schedule your setup call →</a>
       </td></tr></table>`
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

/* ── Main handler (v2) ─────────────────────────────────────────────────────── */
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  // RAW body, exactly as Stripe sent and signed it.
  const rawBody = await req.text();
  const stripeClient = Stripe(process.env.STRIPE_SECRET_KEY);
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();

  let stripeEvent;
  try {
    stripeEvent = stripeClient.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return new Response(`Webhook signature error: ${err.message}`, { status: 400 });
  }

  const eventType = stripeEvent.type;

  /* ── Subscription canceled / ended → remove from the Pro channel ─────────── */
  if (eventType === 'customer.subscription.deleted') {
    const sub       = stripeEvent.data.object;
    const channelId = process.env.TELEGRAM_PRO_CHANNEL_ID;
    const userId    = sub.metadata?.telegram_user_id;
    const who       = sub.metadata?.email || sub.customer || sub.id;
    if (userId && channelId) {
      const res = await kickFromChannel(channelId, userId);
      await logToAdmin(
        `🚪 <b>Subscription canceled</b>\n📧 ${who}\n` +
        (res?.ok ? `✅ Removed from the Pro channel.` : `⚠️ Auto-remove failed (${res?.description || '?'}) — please remove manually.`)
      );
    } else {
      await logToAdmin(
        `⚠️ <b>Subscription canceled</b>\n📧 ${who}\n` +
        `No Telegram ID on file (they may have paid before tracking was enabled, or never joined). ` +
        `Please remove them from the Pro channel manually.`
      );
    }
    return new Response('ok', { status: 200 });
  }

  /* ── Renewal payment failed → warn (do NOT kick; Stripe retries) ─────────── */
  if (eventType === 'invoice.payment_failed') {
    const inv = stripeEvent.data.object;
    const who = inv.customer_email || inv.customer;
    await logToAdmin(
      `💳 <b>Renewal payment failed</b>\n📧 ${who}\n` +
      `Stripe will retry over the next few days. Access is retained until the subscription ` +
      `ultimately cancels — at which point they're removed automatically.`
    );
    return new Response('ok', { status: 200 });
  }

  // Everything else: only completed checkouts proceed past here.
  if (eventType !== 'checkout.session.completed') {
    console.log(`Ignored event type: ${eventType}`);
    return new Response('Ignored', { status: 200 });
  }

  const session = stripeEvent.data.object;
  const customerEmail = session.customer_details?.email;
  const customerName  = session.customer_details?.name || '';

  if (!customerEmail) {
    console.error('No customer email in session:', session.id);
    return new Response('No email - skipped', { status: 200 });
  }

  // Identify plan from line items.
  let plan = 'pro'; // default
  try {
    const fullSession = await stripeClient.checkout.sessions.retrieve(
      session.id,
      { expand: ['line_items'] }
    );
    const priceId = fullSession.line_items?.data?.[0]?.price?.id;
    if (priceId) plan = getPlan(priceId);
  } catch (err) {
    const amount = session.amount_total || 0;
    if (amount >= 10000) plan = 'pipeline';
    console.warn(`Could not retrieve line items (${err.message}), inferred plan=${plan} from amount=${amount}`);
  }

  const channelId = getChannelId(plan);
  if (!channelId) {
    console.error(`No channel ID configured for plan: ${plan}`);
    return new Response(`Channel not configured for plan: ${plan}`, { status: 500 });
  }

  console.log(`New ${plan} subscriber: ${customerEmail}`);

  // Stamp the subscription with the buyer's email now, so a future cancellation
  // alert can identify them even if they never joined the channel. The Telegram
  // user id is added later (by telegram-webhook.js) when they join. Stripe merges
  // metadata per-key, so these two writes don't clobber each other.
  if (session.subscription) {
    try {
      await stripeClient.subscriptions.update(session.subscription, {
        metadata: { email: customerEmail, plan },
      });
    } catch (e) {
      console.warn('Could not stamp subscription metadata:', e.message);
    }
  }

  // Create invite (named with the subscription id so joins can be linked back)
  // + send email.
  try {
    const inviteLink = await createTelegramInvite(channelId, session.subscription);

    await sendWelcomeEmail({
      toEmail: customerEmail,
      toName:  customerName,
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

    return new Response(JSON.stringify({ ok: true, plan, email: customerEmail }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Pipeline error:', err.message);

    await logToAdmin(
      `⚠️ <b>Webhook pipeline FAILED</b>\n` +
      `📧 ${customerEmail}\n` +
      `❌ ${err.message}`
    );

    return new Response(`Pipeline error: ${err.message}`, { status: 500 });
  }
};
