-- =====================================================
-- P3-B2.3B — Push Notification Outbox + Consumer Foundation
-- =====================================================
-- Business rule:
--   Mission events (mission_assigned, mission_cancelled) enqueue
--   push notification rows in a dedicated outbox table, fully
--   separated from the existing email notification_outbox.
--
-- This migration is ADDITIVE and forward-only:
--   - Creates public.push_notification_outbox table
--   - RLS enabled, service_role only (no client write access)
--   - Unique idempotency constraint on (mission_event_id, notification_type, target_user_id)
--   - Enqueue trigger on mission_events (parallel to email enqueue, independent)
--   - Claim RPC for concurrency-safe row processing
--   - Does NOT modify existing notification_outbox, email consumer, or email triggers
--   - Does NOT alter wrangler config, secrets, or cron
--
-- Convoyeur-to-user mapping:
--   convoyeurs.auth_user_id → auth.users.id
--   The enqueue function resolves convoyeur_id → auth_user_id at enqueue time.
-- =====================================================

-- =====================================================
-- 1. TABLE: push_notification_outbox
-- =====================================================

CREATE TABLE IF NOT EXISTS public.push_notification_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id          uuid REFERENCES public.missions(id) ON DELETE CASCADE,
  mission_event_id    uuid REFERENCES public.mission_events(id) ON DELETE CASCADE,
  notification_type   text NOT NULL,
  target_user_id      uuid NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending',
  attempts            int  NOT NULL DEFAULT 0,
  claimed_at          timestamptz,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  last_error          text
);

-- =====================================================
-- 2. CONSTRAINTS
-- =====================================================

-- Idempotency: one push row per (mission_event_id, notification_type, target_user_id)
ALTER TABLE public.push_notification_outbox
  ADD CONSTRAINT push_notification_outbox_event_type_user_key
  UNIQUE (mission_event_id, notification_type, target_user_id);

-- Status values
ALTER TABLE public.push_notification_outbox
  ADD CONSTRAINT push_notification_outbox_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed'));

-- Max attempts ceiling
ALTER TABLE public.push_notification_outbox
  ADD CONSTRAINT push_notification_outbox_attempts_check
  CHECK (attempts >= 0 AND attempts <= 10);

-- =====================================================
-- 3. INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_push_outbox_status_due
  ON public.push_notification_outbox (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_push_outbox_status_claimed
  ON public.push_notification_outbox (status, claimed_at);

CREATE INDEX IF NOT EXISTS idx_push_outbox_target_user
  ON public.push_notification_outbox (target_user_id);

-- =====================================================
-- 4. RLS — server-side only, no client access
-- =====================================================

ALTER TABLE public.push_notification_outbox ENABLE ROW LEVEL SECURITY;

-- No policies for anon or authenticated — table is service_role only.
-- service_role bypasses RLS, so no policy is needed for backend access.
-- Browser clients cannot read, insert, update, or delete push outbox rows.

-- =====================================================
-- 5. GRANTS — service_role only
-- =====================================================

-- Revoke any default grants that might have been inherited
REVOKE ALL ON TABLE public.push_notification_outbox FROM anon;
REVOKE ALL ON TABLE public.push_notification_outbox FROM authenticated;

-- Grant full access only to service_role and postgres
GRANT ALL ON TABLE public.push_notification_outbox TO service_role;

-- =====================================================
-- 6. ENQUEUE TRIGGER — parallel to email enqueue, independent
-- =====================================================

CREATE OR REPLACE FUNCTION public.enqueue_push_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _convoyeur_id uuid;
  _target_user_id uuid;
  _payload jsonb;
BEGIN
  -- Only handle push-relevant events
  IF NEW.event_type NOT IN ('mission_assigned', 'mission_cancelled') THEN
    RETURN NEW;
  END IF;

  -- Resolve convoyeur from mission
  SELECT convoyeur_id INTO _convoyeur_id
  FROM public.missions
  WHERE id = NEW.mission_id;

  IF _convoyeur_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Resolve auth_user_id from convoyeur
  SELECT auth_user_id INTO _target_user_id
  FROM public.convoyeurs
  WHERE id = _convoyeur_id;

  IF _target_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Build push payload (SW-compatible: { title, body, url })
  _payload := jsonb_build_object(
    'event_type', NEW.event_type,
    'mission_id', NEW.mission_id,
    'metadata', COALESCE(NEW.metadata, '{}'::jsonb)
  );

  -- Enqueue push row (idempotent via unique constraint)
  INSERT INTO public.push_notification_outbox (
    mission_id, mission_event_id, notification_type, target_user_id, payload, status
  )
  VALUES (
    NEW.mission_id, NEW.id, NEW.event_type, _target_user_id, _payload, 'pending'
  )
  ON CONFLICT (mission_event_id, notification_type, target_user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mission_events_enqueue_push ON public.mission_events;
CREATE TRIGGER mission_events_enqueue_push
  AFTER INSERT ON public.mission_events
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_push_notification();

-- Revoke direct execution from client roles — trigger still works
-- because trigger functions execute with SECURITY DEFINER context,
-- not the caller's privileges.
REVOKE EXECUTE ON FUNCTION public.enqueue_push_notification() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enqueue_push_notification() FROM anon;
REVOKE EXECUTE ON FUNCTION public.enqueue_push_notification() FROM authenticated;

-- =====================================================
-- 7. CLAIM RPC — concurrency-safe row claiming with stale recovery
-- =====================================================
-- Atomically transitions eligible rows to 'processing'.
-- Eligible rows:
--   pending AND next_attempt_at <= now() AND attempts < 10
--   OR
--   processing AND claimed_at < now() - 5 minutes AND attempts < 10
--
-- The 5-minute timeout allows recovery of rows claimed by workers
-- that crashed before finalizing. Reclaiming increments attempts
-- again, ensuring max attempts is still enforced.
--
-- FOR UPDATE SKIP LOCKED prevents two concurrent consumers from
-- claiming the same row.

CREATE OR REPLACE FUNCTION public.claim_push_outbox_rows(p_limit int DEFAULT 10)
RETURNS TABLE (
  id uuid,
  mission_id uuid,
  mission_event_id uuid,
  notification_type text,
  target_user_id uuid,
  payload jsonb,
  attempts int,
  next_attempt_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.push_notification_outbox AS p
  SET
    status = 'processing',
    attempts = p.attempts + 1,
    claimed_at = now(),
    updated_at = now()
  WHERE p.id IN (
    SELECT q.id
    FROM public.push_notification_outbox q
    WHERE (
      (q.status = 'pending' AND q.next_attempt_at <= now())
      OR
      (q.status = 'processing' AND q.claimed_at < now() - interval '5 minutes')
    )
    AND q.attempts < 10
    ORDER BY q.next_attempt_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING
    p.id, p.mission_id, p.mission_event_id,
    p.notification_type, p.target_user_id, p.payload,
    p.attempts, p.next_attempt_at;
END;
$$;

-- Revoke direct execution from client roles — backend/service_role only
REVOKE EXECUTE ON FUNCTION public.claim_push_outbox_rows(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_push_outbox_rows(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_push_outbox_rows(int) FROM authenticated;

-- =====================================================
-- 8. COMPLETE RPC — finalize delivery outcome with CAS protection
-- =====================================================
-- CAS (Compare-And-Swap): only finalizes a row if it is still
-- 'processing' with the expected attempt number. This prevents
-- a worker from overwriting a row that was reclaimed and is now
-- being processed by another worker.

CREATE OR REPLACE FUNCTION public.complete_push_outbox_row(
  p_id uuid,
  p_status text,
  p_expected_attempts int,
  p_last_error text DEFAULT NULL,
  p_next_attempt_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _updated bool;
BEGIN
  UPDATE public.push_notification_outbox
  SET
    status = p_status,
    last_error = p_last_error,
    next_attempt_at = COALESCE(p_next_attempt_at, now()),
    sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
    updated_at = now()
  WHERE id = p_id
    AND status = 'processing'
    AND attempts = p_expected_attempts
  RETURNING TRUE INTO _updated;

  RETURN COALESCE(_updated, FALSE);
END;
$$;

-- Revoke direct execution from client roles — backend/service_role only
REVOKE EXECUTE ON FUNCTION public.complete_push_outbox_row(uuid, text, int, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_push_outbox_row(uuid, text, int, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_push_outbox_row(uuid, text, int, text, timestamptz) FROM authenticated;

COMMIT;
