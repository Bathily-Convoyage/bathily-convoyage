export async function sendEmail({ to, subject, html }, env) {
  const resendApiKey = env.RESEND_API_KEY;
  const FROM_EMAIL = env.EMAIL_FROM || 'onboarding@resend.dev';

  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY manquante');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `Bathily Convoyage <${FROM_EMAIL}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || `Resend HTTP ${response.status}`);
  }
  return data;
}

export function wrapEmailLayout(contentTitle, contentBody, env = {}) {
  const ADMIN_EMAIL = env.EMAIL_ADMIN || 'contact@bathily-convoyage.fr';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:'Helvetica Neue',Arial,sans-serif;background-color:#FDFBF7;color:#2D2A24;margin:0;padding:20px}
    .container{max-width:600px;margin:0 auto;background:#fff;border-radius:20px;border:1px solid #E8E1D9;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.03)}
    .header{background-color:#0A4D68;padding:30px;text-align:center;color:#fff}
    .header h1{margin:0;font-size:24px;font-weight:800;letter-spacing:-.02em}
    .content{padding:40px 30px;line-height:1.6;font-size:15px}
    .footer{background-color:#F9F6F0;padding:20px;text-align:center;font-size:12px;color:#6B625A;border-top:1px solid #E8E1D9}
    .btn{display:inline-block;background-color:#0A4D68;color:#fff!important;text-decoration:none;padding:12px 28px;border-radius:40px;font-weight:700;margin-top:20px;font-size:14px}
    .highlight-box{background-color:#E6F0F4;border-left:4px solid #0A4D68;padding:15px;border-radius:8px;margin:20px 0}
  </style></head><body><div class="container"><div class="header"><h1>Bathily Convoyage.</h1></div>
  <div class="content"><h2 style="color:#0A4D68;margin-top:0">${contentTitle}</h2>${contentBody}</div>
  <div class="footer">© 2025 Bathily Convoyage — Convoyage automobile & moto en France.<br>Besoin d'aide ? <a href="mailto:${ADMIN_EMAIL}" style="color:#0A4D68">Contactez-nous</a></div>
  </div></body></html>`;
}
