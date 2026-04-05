const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = process.env.FROM_EMAIL || "makro. <onboarding@resend.dev>";
const BASE   = process.env.BACKEND_URL || "https://makro-backend-production.up.railway.app";

async function sendVerificationEmail(email, token) {
  const url = `${BASE}/verify?token=${token}`;
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Bestätige deine E-Mail – makro.",
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0c0c0c;font-family:sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:48px 24px;">
    <div style="font-size:32px;font-weight:800;letter-spacing:-1.5px;color:#efefef;margin-bottom:6px;">
      makro<span style="color:#f59e0b;">.</span>
    </div>
    <div style="color:#555;font-size:13px;margin-bottom:40px;">Dein Makro-Tracker</div>
    <div style="color:#efefef;font-size:18px;font-weight:700;margin-bottom:10px;">Fast geschafft!</div>
    <div style="color:#888;font-size:14px;line-height:1.7;margin-bottom:32px;">
      Klick auf den Button um deine E-Mail-Adresse zu bestätigen und loszulegen.
    </div>
    <a href="${url}"
       style="display:inline-block;background:#f59e0b;color:#000;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px;text-decoration:none;">
      E-Mail bestätigen →
    </a>
    <div style="color:#444;font-size:12px;margin-top:36px;line-height:1.6;">
      Falls du dich nicht bei makro. registriert hast, kannst du diese E-Mail ignorieren.
    </div>
  </div>
</body>
</html>`,
  });
}

module.exports = { sendVerificationEmail };
