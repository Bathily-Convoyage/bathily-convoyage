// Simple in-memory rate limiter for Netlify functions
// Limits requests per IP address within a time window

const rateLimitMap = new Map();

// Clean up expired entries every 60 seconds
let cleanupTimer = null;
function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
      if (now > entry.resetTime) {
        rateLimitMap.delete(key);
      }
    }
  }, 60000);
  // Prevent the timer from keeping the process alive
  if (cleanupTimer.unref) cleanupTimer.unref();
}

/**
 * Check rate limit for a given IP and endpoint.
 * @param {string} ip - Client IP address
 * @param {string} endpoint - Function name or endpoint identifier
 * @param {number} maxRequests - Max requests allowed in the window
 * @param {number} windowMs - Time window in milliseconds
 * @returns {{ allowed: boolean, remaining: number, resetTime: number }}
 */
function checkRateLimit(ip, endpoint, maxRequests = 10, windowMs = 60000) {
  startCleanup();
  const key = `${ip}:${endpoint}`;
  const now = Date.now();
  let entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + windowMs };
    rateLimitMap.set(key, entry);
  }

  entry.count++;

  if (entry.count > maxRequests) {
    return { allowed: false, remaining: 0, resetTime: entry.resetTime };
  }

  return { allowed: true, remaining: maxRequests - entry.count, resetTime: entry.resetTime };
}

/**
 * Express-style middleware for Netlify functions.
 * Returns a 429 response if rate limit is exceeded, otherwise returns null.
 * @param {object} event - Netlify event object
 * @param {string} functionName - Name of the function for rate limit keying
 * @param {number} maxRequests - Max requests per window (default: 10)
 * @param {number} windowMs - Window in ms (default: 60000 = 1 min)
 * @returns {object|null} - Returns 429 response object if blocked, null if allowed
 */
function rateLimit(event, functionName, maxRequests = 10, windowMs = 60000) {
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             event.headers['client-ip'] ||
             event.headers['x-real-ip'] ||
             'unknown';

  const result = checkRateLimit(ip, functionName, maxRequests, windowMs);

  if (!result.allowed) {
    const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
    return {
      statusCode: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Trop de requêtes. Veuillez réessayer dans ' + retryAfter + ' secondes.',
        retryAfter
      })
    };
  }

  return null;
}

module.exports = { checkRateLimit, rateLimit };
