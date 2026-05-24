/**
 * telegram-webhook.js  (Netlify Functions v2)
 *
 * Receives Telegram `chat_member` updates. When a buyer joins the Pro channel via
 * their one-time invite link, the update carries:
 *   - invite_link.name      → the Stripe subscription id (we set this at invite time)
 *   - new_chat_member.user.id → their Telegram user id
 * We record that user id on the Stripe subscription's metadata, so when the
 * subscription is later canceled, stripe-webhook.js can auto-remove them.
 *
 * No database needed — the mapping lives on the Stripe subscription itself.
 *
 * SETUP (one-time):
 *   1. The bot must be an ADMIN of the Pro channel with "Ban users" permission.
 *   2. Register this webhook with Telegram, requesting chat_member updates and a
 *      secret token (must equal TELEGRAM_WEBHOOK_SECRET in Netlify env):
 *        curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
 *          -d "url=https://3rdeyes.io/.netlify/functions/telegram-webhook" \
 *          -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
 *          --data-urlencode 'allowed_updates=["chat_member"]'
 */

import Stripe from 'stripe';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Verify the request really came from Telegram (secret token set via setWebhook).
  const provided = req.headers.get('x-telegram-bot-api-secret-token');
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || provided !== expected) {
    return new Response('forbidden', { status: 403 });
  }

  let update;
  try {
    update = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  try {
    const m = update.chat_member;
    if (m) {
      const newStatus = m.new_chat_member?.status;
      const oldStatus = m.old_chat_member?.status || 'left';
      const userId    = m.new_chat_member?.user?.id;
      const subId     = m.invite_link?.name; // we set name = Stripe subscription id

      const joined =
        ['member', 'administrator', 'restricted', 'creator'].includes(newStatus) &&
        ['left', 'kicked'].includes(oldStatus);

      if (joined && userId && subId && String(subId).startsWith('sub_')) {
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
        await stripe.subscriptions.update(subId, {
          metadata: { telegram_user_id: String(userId) },
        });
        console.log(`Linked Telegram user ${userId} → subscription ${subId}`);
      }
    }
  } catch (e) {
    // Never 500 to Telegram (it would retry forever); just log.
    console.error('telegram-webhook error:', e.message);
  }

  // Always 200 so Telegram considers the update handled.
  return new Response('ok', { status: 200 });
};
