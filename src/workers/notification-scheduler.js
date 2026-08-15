// =========================================================
// PROD-1D-C.2 — NOTIFICATION OUTBOX SCHEDULER WORKER
//
// Responsibilities:
//   - One scheduled handler
//   - One POST per invocation to the consumer
//   - 30 s wall-clock timeout
//   - Strict auth header x-cron-secret
//   - No retries, no business logic, no DB, no Resend
//
// Local test mode:
//   - ENVIRONMENT = "local" AND OUTBOX_CONSUMER_URL pointing
//     to http://127.0.0.1:* or http://localhost:*
// =========================================================

const PRODUCTION_TARGET = 'https://www.bathily-convoyage.fr/api/process-notification-outbox';
const LOCAL_ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

function log(payload) {
  console.log(JSON.stringify(payload));
}

function getTargetUrl(env) {
  if (env.ENVIRONMENT === 'local' && env.OUTBOX_CONSUMER_URL) {
    try {
      const url = new URL(env.OUTBOX_CONSUMER_URL);
      if (url.protocol !== 'http:') {
        return null;
      }
      if (!LOCAL_ALLOWED_HOSTS.has(url.hostname)) {
        return null;
      }
      return env.OUTBOX_CONSUMER_URL;
    } catch {
      return null;
    }
  }
  return PRODUCTION_TARGET;
}

async function parseBodySafe(response) {
  try {
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const now = new Date().toISOString();
    const scheduledTime = new Date(controller.scheduledTime).toISOString();
    const cron = controller.cron;

    log({
      event: 'scheduled',
      timestamp: now,
      scheduled_time: scheduledTime,
      cron
    });

    const enabled = env.NOTIFICATION_SCHEDULER_ENABLED === 'true';
    if (!enabled) {
      log({
        event: 'scheduler_disabled',
        timestamp: now,
        scheduled_time: scheduledTime,
        cron
      });
      return;
    }

    const secret = env.OUTBOX_CRON_SECRET;
    if (!secret) {
      log({
        event: 'configuration_error',
        timestamp: now,
        scheduled_time: scheduledTime,
        cron,
        missing: 'OUTBOX_CRON_SECRET'
      });
      return;
    }

    const target = getTargetUrl(env);
    if (!target) {
      log({
        event: 'target_error',
        timestamp: now,
        scheduled_time: scheduledTime,
        cron
      });
      return;
    }

    const start = Date.now();
    let timeoutId = null;
    try {
      const abort = new AbortController();
      timeoutId = setTimeout(() => abort.abort(), 30000);

      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'x-cron-secret': secret
        },
        signal: abort.signal
      });

      clearTimeout(timeoutId);
      const latency = Date.now() - start;
      const { status } = response;

      if (status === 200) {
        const body = await parseBodySafe(response);
        const processed = body && Number.isInteger(body.processed) ? body.processed : null;
        const resultsCount = body && Array.isArray(body.results) ? body.results.length : null;
        log({
          event: 'ok',
          timestamp: now,
          scheduled_time: scheduledTime,
          cron,
          status,
          http_status: status,
          latency_ms: latency,
          processed,
          results_count: resultsCount
        });
      } else if (status === 401 || status === 403) {
        log({
          event: 'critical_auth_failure',
          timestamp: now,
          scheduled_time: scheduledTime,
          cron,
          status,
          http_status: status,
          latency_ms: latency
        });
      } else if (status === 429) {
        log({
          event: 'rate_limited',
          timestamp: now,
          scheduled_time: scheduledTime,
          cron,
          status,
          http_status: status,
          latency_ms: latency
        });
      } else if (status >= 500) {
        log({
          event: 'consumer_error',
          timestamp: now,
          scheduled_time: scheduledTime,
          cron,
          status,
          http_status: status,
          latency_ms: latency
        });
      } else {
        log({
          event: 'unexpected_status',
          timestamp: now,
          scheduled_time: scheduledTime,
          cron,
          status,
          http_status: status,
          latency_ms: latency
        });
      }
    } catch (err) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      const latency = Date.now() - start;
      if (err && err.name === 'AbortError') {
        log({
          event: 'timeout_ambiguous',
          timestamp: now,
          scheduled_time: scheduledTime,
          cron,
          latency_ms: latency
        });
      } else {
        log({
          event: 'network_error',
          timestamp: now,
          scheduled_time: scheduledTime,
          cron,
          error_class: err?.name || 'Error',
          latency_ms: latency
        });
      }
    }
  }
};
