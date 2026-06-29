// Shared utilities for Cloudflare Pages Functions
// Provides Netlify-like helpers for CORS, rate limiting, and response formatting

const ALLOWED_ORIGINS = [
  'https://www.bathily-convoyage.fr',
  'https://bathily-convoyage.fr',
  'http://localhost:5173',
  'http://localhost:3000'
];

export function getCorsHeaders(request, extra = {}) {
  const origin = request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    ...extra
  };
}

export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

export function handleOptions(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: getCorsHeaders(request) });
  }
  return null;
}

// Simple in-memory rate limiter (per Worker isolate)
const rateLimitMap = new Map();

export function checkRateLimit(request, functionName, maxRequests = 10, windowMs = 60000) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
             request.headers.get('cf-connecting-ip') ||
             'unknown';
  const key = `${ip}:${functionName}`;
  const now = Date.now();
  let entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + windowMs };
    rateLimitMap.set(key, entry);
  }

  entry.count++;

  if (entry.count > maxRequests) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    return jsonResponse(
      { error: 'Trop de requêtes. Veuillez réessayer dans ' + retryAfter + ' secondes.', retryAfter },
      429,
      { 'Retry-After': String(retryAfter), 'Access-Control-Allow-Origin': '*' }
    );
  }
  return null;
}

// Helper to parse JSON body from request
export async function parseBody(request) {
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Helper to get query params
export function getQueryParams(request) {
  const url = new URL(request.url);
  const params = {};
  for (const [key, value] of url.searchParams.entries()) {
    params[key] = value;
  }
  return params;
}

// Web Crypto helper: generate random hex string (replaces Node.js crypto.randomBytes(n).toString('hex'))
export function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
