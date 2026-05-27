/**
 * free-signup.js
 * Handles free tier email signups from the homepage form.
 * Sends a welcome email with the public Telegram channel link via Resend.
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Parse form body (application/x-www-form-urlencoded)
  const params = new URLSearchParams(event.body);
  const email = params.get('email') || '';

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: 'Invalid email' };
  }

  // Add the subscriber to the Resend audience so they receive signal emails.
  // No-op until RESEND_AUDIENCE_ID is set, so this never breaks the welcome flow.
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (audienceId) {
    try {
      await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({ email, unsubscribed: false }),
      });
    } catch (err) {
      console.error('Resend audience add failed:', err.message);
    }
  }

  const channelUrl = 'https://t.me/thirdeyes_signals';

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
            <p style="margin:6px 0 0;font-size:13px;color:#003344;letter-spacing:3px;text-transform:uppercase;">Engineered Weather Signals</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <h2 style="margin:0 0 16px;font-size:22px;color:#fff;">Your free signal access is ready.</h2>
            <p style="margin:0 0 20px;color:#ccc;font-size:15px;line-height:1.6;">
              We post real weather arbitrage signals to our public Telegram channel.
              Every signal includes the full trade reasoning: model output, buffer, confidence grade,
              and the exact contract to trade on Kalshi.
            </p>
            <p style="margin:0 0 24px;color:#ccc;font-size:15px;line-height:1.6;">
              Place the trades manually, track your results, and upgrade to Pro when you're ready for full coverage.
            </p>
            <!-- CTA -->
            <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
              <tr>
                <td style="background:#00d4ff;border-radius:8px;">
                  <a href="${channelUrl}"
                     style="display:block;padding:14px 36px;font-size:16px;font-weight:700;color:#000;text-decoration:none;">
                    Join Free Channel on Telegram &rarr;
                  </a>
                </td>
              </tr>
            </table>
            <!-- Steps -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:20px;margin-bottom:24px;">
              <tr><td style="padding:12px 16px;">
                <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:.08em;">How it works</p>
                <p style="margin:0 0 8px;color:#aaa;font-size:14px;line-height:1.6;">1. Click the button above and install Telegram if you haven't already.</p>
                <p style="margin:0 0 8px;color:#aaa;font-size:14px;line-height:1.6;">2. Join the channel - signals post automatically when the model fires.</p>
                <p style="margin:0;color:#aaa;font-size:14px;line-height:1.6;">3. When a signal posts, go to Kalshi, find the contract, and place the trade manually.</p>
              </td></tr>
            </table>
            <hr style="border:none;border-top:1px solid #222;margin:0 0 20px;">
            <p style="margin:0;color:#555;font-size:13px;line-height:1.6;">
              Questions? Reply to this email.<br>
              When you're ready for full coverage and Pro features -
              <a href="https://3rdeyes.io/#pricing" style="color:#00d4ff;text-decoration:none;">upgrade here</a>.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 40px;background:#0d0d0d;text-align:center;">
            <p style="margin:0;color:#333;font-size:11px;">
              3rd Eyes &middot; 3rdeyes.io &middot; You signed up for free signals at 3rdeyes.io
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: '3rd Eyes Signals <signals@3rdeyes.io>',
        to: [email],
        subject: 'Your free 3rd Eyes signal access',
        html,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Resend error:', err);
      return { statusCode: 500, body: 'Email failed' };
    }

    const result = await resp.json();
    console.log(`Free signup email sent to ${email} - ID: ${result.id}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('Free signup error:', err.message);
    return { statusCode: 500, body: 'Server error' };
  }
};
