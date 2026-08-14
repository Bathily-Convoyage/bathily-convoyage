import { escapeHtml } from './_utils.js';

// =========================================================
// STRUCTURED PROVIDER ERROR
// Preserves HTTP status, Resend error code, sanitized
// message, Retry-After, and classification.
// Never logs RESEND_API_KEY or Authorization headers.
// =========================================================
export class ProviderError extends Error {
  constructor({ httpStatus, errorCode, message, retryAfter, classification }) {
    super(message);
    this.name = 'ProviderError';
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;         // Resend error code string or null
    this.retryAfter = retryAfter;       // seconds (from Retry-After header) or null
    this.classification = classification; // see classifyResponse
  }
}

// =========================================================
// CLASSIFY a Resend HTTP response.
// Conservative: 5xx → ambiguous_retryable (not transient_retryable)
// because receipt of an infrastructure-error HTTP response is not
// sufficient proof that no email could have been processed.
// =========================================================
export function classifyResponse(httpStatus, body) {
  const code = body?.code || body?.error_code || null;

  if (httpStatus >= 200 && httpStatus < 300) {
    return 'success';
  }
  if (httpStatus === 409) {
    if (code === 'invalid_idempotent_request') return 'invariant_violation';
    if (code === 'concurrent_idempotent_requests') return 'transient_retryable';
    return 'invariant_violation'; // unknown 409 → conservative
  }
  if (httpStatus === 400) {
    if (code === 'invalid_idempotency_key') return 'invariant_violation';
    return 'terminal_failed'; // validation / invalid recipient / invalid from / invalid payload
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return 'operational_blocked';
  }
  if (httpStatus === 404) {
    return 'terminal_failed';
  }
  if (httpStatus === 429) {
    if (code === 'daily_quota_exceeded' || code === 'monthly_quota_exceeded') return 'operational_blocked';
    return 'transient_retryable'; // rate_limit_exceeded
  }
  if (httpStatus >= 500) {
    return 'ambiguous_retryable';
  }
  return 'terminal_failed'; // unknown 4xx → conservative terminal
}

// =========================================================
// SEND EMAIL — accepts frozen provider request fields verbatim.
// `from` must be the EXACT frozen value (e.g.
// "Bathily Convoyage <noreply@bathily-convoyage.fr>").
// Does NOT read env.EMAIL_FROM. Does NOT reconstruct the sender.
// =========================================================
export async function sendEmail({ from, to, subject, html, idempotencyKey }, env) {
  const resendApiKey = env.RESEND_API_KEY;

  if (!resendApiKey) {
    throw new ProviderError({
      httpStatus: null,
      errorCode: null,
      message: 'RESEND_API_KEY manquante',
      retryAfter: null,
      classification: 'operational_blocked'
    });
  }

  if (!from || typeof from !== 'string' || from.trim() === '') {
    throw new ProviderError({
      httpStatus: null,
      errorCode: null,
      message: 'from manquant ou vide',
      retryAfter: null,
      classification: 'terminal_failed'
    });
  }

  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 256) {
      throw new ProviderError({
        httpStatus: null,
        errorCode: null,
        message: 'idempotencyKey invalide (longueur doit être entre 1 et 256)',
        retryAfter: null,
        classification: 'terminal_failed'
      });
    }
  }

  const headers = {
    'Authorization': `Bearer ${resendApiKey}`,
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from,                                   // EXACT frozen value, verbatim
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      })
    });
  } catch (err) {
    // Network error / timeout — no HTTP response received
    throw new ProviderError({
      httpStatus: null,
      errorCode: null,
      message: err?.message || 'Network error',
      retryAfter: null,
      classification: 'ambiguous_retryable'
    });
  }

  // Parse response body (may fail)
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const classification = classifyResponse(response.status, data);
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) || null : null;
    const code = data?.code || data?.error_code || null;
    // Sanitized message — never include API key or auth header
    const msg = data?.message || `Resend HTTP ${response.status}`;
    throw new ProviderError({
      httpStatus: response.status,
      errorCode: code,
      message: msg,
      retryAfter,
      classification
    });
  }

  return data; // { id: "..." }
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
  <div class="content"><h2 style="color:#0A4D68;margin-top:0">${escapeHtml(contentTitle)}</h2>${contentBody}</div>
  <div class="footer">© 2025 Bathily Convoyage — Convoyage automobile & moto en France.<br>Besoin d'aide ? <a href="mailto:${escapeHtml(ADMIN_EMAIL)}" style="color:#0A4D68">Contactez-nous</a></div>
  </div></body></html>`;
}
