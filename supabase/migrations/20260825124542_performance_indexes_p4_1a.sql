BEGIN;

-- Fail fast rather than waiting behind an unexpected long-running lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Cover every foreign key reported by the Supabase Performance Advisor.
CREATE INDEX IF NOT EXISTS idx_convoyeur_candidatures_existing_auth_user_id
  ON public.convoyeur_candidatures (existing_auth_user_id);

CREATE INDEX IF NOT EXISTS idx_edls_supersedes_edl_id
  ON public.edls (supersedes_edl_id);

CREATE INDEX IF NOT EXISTS idx_mission_events_mission_id
  ON public.mission_events (mission_id);

CREATE INDEX IF NOT EXISTS idx_mission_tracking_tokens_mission_id
  ON public.mission_tracking_tokens (mission_id);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_mission_id
  ON public.notification_outbox (mission_id);

-- Keep the outbox indexes small by indexing only rows that can still be worked.
-- The column order follows process_notification_outbox(): readiness first,
-- then FIFO ordering by created_at where applicable.
CREATE INDEX IF NOT EXISTS notification_outbox_pending_created_at_idx
  ON public.notification_outbox (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS notification_outbox_retry_ready_idx
  ON public.notification_outbox (next_retry_at, created_at)
  WHERE status = 'retry';

CREATE INDEX IF NOT EXISTS notification_outbox_prepared_ready_idx
  ON public.notification_outbox (prepared_at, created_at)
  WHERE status = 'prepared';

CREATE INDEX IF NOT EXISTS notification_outbox_sending_lease_idx
  ON public.notification_outbox (current_attempt_started_at)
  WHERE status = 'sending'
    AND current_attempt_started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_outbox_provider_deadline_idx
  ON public.notification_outbox (first_provider_attempt_at)
  WHERE status IN ('retry', 'prepared', 'sending')
    AND first_provider_attempt_at IS NOT NULL;

COMMIT;
