// =========================================================
// PROD-1D-C.2 — NOTIFICATION OUTBOX SCHEDULER WORKER
//
// Responsibilities:
//   - One scheduled handler
//   - One POST per consumer per invocation (email + push)
//   - 30 s wall-clock timeout per consumer (independent)
//   - Strict auth header x-cron-secret
//   - No retries, no business logic, no DB, no Resend
//   - Error isolation: one consumer failure does not prevent
//     the other from being invoked (Promise.allSettled)
//
// Local test mode:
//   - ENVIRONMENT = "local" AND OUTBOX_CONSUMER_URL pointing
//     to http://127.0.0.1:* or http://localhost:*
//   - Push URL derived from OUTBOX_CONSUMER_URL by replacing
//     "process-notification-outbox" with "process-push-outbox"
//     in the pathname, or falling back to origin + /api/process-push-outbox
// =========================================================

const PRODUCTION_TARGETS = [
  { name: 'notification', url: 'https://www.bathily-convoyage.fr/api/process-notification-outbox' },
  { name: 'push', url: 'https://www.bathily-convoyage.fr/api/process-push-outbox' },
];
const LOCAL_ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

function log(payload) {
  console.log(JSON.stringify(payload));
}

function getTargetUrls(env) {
  if (env.ENVIRONMENT === 'local' && env.OUTBOX_CONSUMER_URL) {
    try {
      const emailUrl = new URL(env.OUTBOX_CONSUMER_URL);
      if (emailUrl.protocol !== 'http:') {
        return null;
      }
      if (!LOCAL_ALLOWED_HOSTS.has(emailUrl.hostname)) {
        return null;
      }
      // Derive push URL from email URL
      let pushUrl;
      if (emailUrl.pathname.includes('process-notification-outbox')) {
        pushUrl = env.OUTBOX_CONSUMER_URL.replace('process-notification-outbox', 'process-push-outbox');
      } else {
        pushUrl = emailUrl.origin + '/api/process-push-outbox';
      }
      return [
        { name: 'notification', url: env.OUTBOX_CONSUMER_URL },
        { name: 'push', url: pushUrl },
      ];
    } catch {
      return null;
    }
  }
  return PRODUCTION_TARGETS;
}

async function parseBodySafe(response) {
  try {
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function invokeConsumer(target, secret, now, scheduledTime, cron) {
  const start = Date.now();
  let timeoutId = null;
  try {
    const abort = new AbortController();
    timeoutId = setTimeout(() => abort.abort(), 30000);

    const response = await fetch(target.url, {
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
        consumer: target.name,
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
        consumer: target.name,
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
        consumer: target.name,
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
        consumer: target.name,
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
        consumer: target.name,
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
        consumer: target.name,
        timestamp: now,
        scheduled_time: scheduledTime,
        cron,
        latency_ms: latency
      });
    } else {
      log({
        event: 'network_error',
        consumer: target.name,
        timestamp: now,
        scheduled_time: scheduledTime,
        cron,
        error_class: err?.name || 'Error',
        latency_ms: latency
      });
    }
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

    const targets = getTargetUrls(env);
    if (!targets || targets.length === 0) {
      log({
        event: 'target_error',
        timestamp: now,
        scheduled_time: scheduledTime,
        cron
      });
      return;
    }

    // Invoke all consumers concurrently with error isolation.
    // Promise.allSettled ensures one consumer's failure does not
    // prevent the other from being invoked or completing.
    await Promise.allSettled(
      targets.map(target => invokeConsumer(target, secret, now, scheduledTime, cron))
    );
  }
};
