-- =========================================================
-- PROD-1D-B.2 — DELIVERY IDENTITY, ATTEMPT LEDGER, QUARANTINE
--
-- Approved design: PROD-1D-B.1 / R1 / R2 / R3 / R4 / R5
--
-- Objectives:
--   1. Add delivery identity columns to notification_outbox
--   2. Create notification_delivery_attempts ledger
--   3. Create notification_delivery_actions audit table
--   4. Replace process_notification_outbox with revised version
--   5. Add begin_delivery_attempt RPC (persistence barrier)
--   6. Add complete_delivery_attempt RPC (idempotent completion)
--   7. Enforce 20h idempotency deadline, 10min sending lease
--   8. Quarantine ambiguous outcomes beyond 20h
--   9. retry_exhausted for known transient failures
--  10. Service-role-only RPCs, RLS/FORCE RLS on new tables
--
-- No manual admin RPCs/UI in B.2.
-- =========================================================

-- =========================================================
-- 1. NOTIFICATION_OUTBOX — NEW COLUMNS
-- =========================================================

ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS delivery_id uuid;

ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS first_provider_attempt_at timestamptz;

ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS current_attempt_id uuid;

ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS current_attempt_started_at timestamptz;

ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

-- =========================================================
-- 2. NOTIFICATION_DELIVERY_ATTEMPTS — LEDGER
-- =========================================================

CREATE TABLE IF NOT EXISTS public.notification_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.notification_outbox(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  attempt_number int NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  provider_response_at timestamptz,
  provider_http_status int,
  provider_error_code text,
  provider_message_id text,
  provider_outcome text NOT NULL DEFAULT 'started'
    CHECK (provider_outcome IN ('started', 'success', 'known_failure', 'ambiguous')),
  classification text
    CHECK (classification IS NULL OR classification IN (
      'success',
      'transient_retryable',
      'ambiguous_retryable',
      'terminal_failed',
      'invariant_violation',
      'operational_blocked'
    )),
  ack_status text NOT NULL DEFAULT 'pending'
    CHECK (ack_status IN ('pending', 'applied', 'stale_rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_delivery_attempts_unique_delivery_attempt
    UNIQUE (delivery_id, attempt_number)
);

ALTER TABLE public.notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_attempts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.notification_delivery_attempts FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS notification_delivery_attempts_outbox_id_idx
  ON public.notification_delivery_attempts (outbox_id);

CREATE INDEX IF NOT EXISTS notification_delivery_attempts_delivery_id_idx
  ON public.notification_delivery_attempts (delivery_id);

-- =========================================================
-- 3. NOTIFICATION_DELIVERY_ACTIONS — APPEND-ONLY AUDIT
-- =========================================================

CREATE TABLE IF NOT EXISTS public.notification_delivery_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.notification_outbox(id) ON DELETE RESTRICT,
  old_delivery_id uuid,
  new_delivery_id uuid,
  action text NOT NULL,
  actor_user_id uuid,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notification_delivery_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_actions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.notification_delivery_actions FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS notification_delivery_actions_outbox_id_idx
  ON public.notification_delivery_actions (outbox_id);

-- =========================================================
-- 4. PROCESS_NOTIFICATION_OUTBOX — REVISED RPC
-- =========================================================

CREATE OR REPLACE FUNCTION public.process_notification_outbox(
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  status text,
  attempts int,
  last_error text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _row public.notification_outbox%ROWTYPE;
  _mission public.missions%ROWTYPE;
  _client public.clients%ROWTYPE;
  _convoyeur public.convoyeurs%ROWTYPE;
  _to_email text;
  _subject text;
  _body text;
  _safe_reference text;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit doit être compris entre 1 et 100'
      USING ERRCODE = '22023';
  END IF;

  -- ─── Phase 1: Quarantine rows beyond 20h deadline ───
  UPDATE public.notification_outbox AS _no
  SET status = 'delivery_unknown',
      prepared_at = NULL,
      current_attempt_id = NULL,
      current_attempt_started_at = NULL,
      last_error = '20h idempotency ceiling exceeded'
  WHERE _no.status IN ('retry', 'prepared', 'sending')
    AND _no.first_provider_attempt_at IS NOT NULL
    AND _no.first_provider_attempt_at + interval '20 hours' <= now();

  -- ─── Phase 2: Stale sending recovery (10min lease) ───
  UPDATE public.notification_outbox AS _no
  SET status = 'prepared',
      prepared_at = now(),
      current_attempt_id = NULL,
      current_attempt_started_at = NULL
  WHERE _no.status = 'sending'
    AND _no.current_attempt_started_at + interval '10 minutes' <= now()
    AND (_no.first_provider_attempt_at IS NULL
         OR _no.first_provider_attempt_at + interval '20 hours' > now());

  -- ─── Phase 3: Select and process rows ───
  FOR _row IN
    SELECT no.*
    FROM public.notification_outbox no
    WHERE no.status = 'pending'
       OR (no.status = 'retry'
           AND (no.next_retry_at IS NULL OR no.next_retry_at <= now()))
       OR (no.status = 'prepared' AND no.prepared_at <= now() - interval '10 minutes')
    ORDER BY no.created_at
    FOR UPDATE OF no SKIP LOCKED
    LIMIT p_limit
  LOOP
    BEGIN
      -- ─── pending — first preparation ───
      IF _row.status = 'pending' THEN
        SELECT * INTO _mission FROM public.missions m WHERE m.id = _row.mission_id;
        _to_email := NULL;

        IF _row.recipient_type = 'client' AND _mission.client_id IS NOT NULL THEN
          SELECT * INTO _client FROM public.clients c WHERE c.id = _mission.client_id;
          _to_email := _client.email;
        ELSIF _row.recipient_type = 'convoyeur' AND _mission.convoyeur_id IS NOT NULL THEN
          SELECT * INTO _convoyeur FROM public.convoyeurs c WHERE c.id = _mission.convoyeur_id;
          _to_email := _convoyeur.email;
        END IF;

        IF _to_email IS NULL THEN
          UPDATE public.notification_outbox AS no
          SET status = 'failed', prepared_at = NULL, sent_at = NULL,
              current_attempt_id = NULL, current_attempt_started_at = NULL,
              last_error = 'Destinataire introuvable'
          WHERE no.id = _row.id;
          RETURN QUERY SELECT _row.id, 'failed', _row.attempts, 'Destinataire introuvable'::text;
          CONTINUE;
        END IF;

        _subject := CASE _row.notification_type
          WHEN 'mission_assigned' THEN 'Votre mission est assignée'
          WHEN 'assignment_accepted' THEN 'Mission acceptée par l''exécutant'
          WHEN 'assignment_rejected' THEN 'Mission refusée par l''exécutant'
          WHEN 'edl_departure_validated' THEN 'Départ confirmé'
          WHEN 'mission_started' THEN 'Mission en cours'
          WHEN 'edl_arrival_validated' THEN 'Arrivée confirmée'
          WHEN 'mission_delivered' THEN 'Mission livrée'
          WHEN 'mission_cancelled' THEN 'Mission annulée'
          ELSE 'Notification mission'
        END;

        _safe_reference := COALESCE(_mission.reference, 'inconnue');
        _safe_reference := replace(_safe_reference, '&', '&amp;');
        _safe_reference := replace(_safe_reference, '<', '&lt;');
        _safe_reference := replace(_safe_reference, '>', '&gt;');
        _safe_reference := replace(_safe_reference, '"', '&quot;');
        _safe_reference := replace(_safe_reference, '''', '&#39;');

        _body := CASE _row.notification_type
          WHEN 'mission_assigned' THEN '<p>Votre mission ' || _safe_reference || ' a été assignée.</p>'
          WHEN 'edl_departure_validated' THEN '<p>Le départ de la mission ' || _safe_reference || ' est confirmé.</p>'
          WHEN 'mission_started' THEN '<p>La mission ' || _safe_reference || ' est en cours.</p>'
          WHEN 'edl_arrival_validated' THEN '<p>L''arrivée de la mission ' || _safe_reference || ' est confirmée.</p>'
          WHEN 'mission_delivered' THEN '<p>La mission ' || _safe_reference || ' est livrée.</p>'
          WHEN 'mission_cancelled' THEN '<p>La mission ' || _safe_reference || ' est annulée.</p>'
          ELSE '<p>Notification concernant la mission ' || _safe_reference || '</p>'
        END;

        -- Freeze DB-derived fields in provider_request (from is NOT set here)
        UPDATE public.notification_outbox AS no
        SET status = 'prepared',
            prepared_at = now(),
            sent_at = NULL,
            last_error = NULL,
            next_retry_at = NULL,
            payload = no.payload
              || jsonb_build_object(
                'provider_request', jsonb_build_object(
                  'to', _to_email,
                  'subject', _subject,
                  'html', _body,
                  'from', NULL::text
                )
              )
        WHERE no.id = _row.id;

        RETURN QUERY SELECT _row.id, 'prepared', _row.attempts, NULL::text;

      -- ─── retry — re-preparation with frozen payload ───
      ELSIF _row.status = 'retry' THEN
        IF _row.payload->'provider_request'->>'to' IS NOT NULL
           AND _row.payload->'provider_request'->>'subject' IS NOT NULL
           AND _row.payload->'provider_request'->>'html' IS NOT NULL THEN
          UPDATE public.notification_outbox AS no
          SET status = 'prepared',
              prepared_at = now(),
              sent_at = NULL,
              last_error = NULL,
              next_retry_at = NULL
          WHERE no.id = _row.id;
          RETURN QUERY SELECT _row.id, 'prepared', _row.attempts, NULL::text;
        ELSE
          UPDATE public.notification_outbox AS no
          SET status = 'failed',
              prepared_at = NULL,
              sent_at = NULL,
              current_attempt_id = NULL,
              current_attempt_started_at = NULL,
              last_error = 'Frozen provider_request incomplete'
          WHERE no.id = _row.id;
          RETURN QUERY SELECT _row.id, 'failed', _row.attempts, 'Frozen provider_request incomplete'::text;
        END IF;

      -- ─── prepared stale — lease reclaim ───
      ELSIF _row.status = 'prepared' THEN
        IF _row.payload->'provider_request'->>'to' IS NOT NULL
           AND _row.payload->'provider_request'->>'subject' IS NOT NULL
           AND _row.payload->'provider_request'->>'html' IS NOT NULL THEN
          UPDATE public.notification_outbox AS no
          SET prepared_at = now()
          WHERE no.id = _row.id;
          RETURN QUERY SELECT _row.id, 'prepared', _row.attempts, NULL::text;
        ELSE
          UPDATE public.notification_outbox AS no
          SET status = 'failed',
              prepared_at = NULL,
              sent_at = NULL,
              last_error = 'Frozen provider_request incomplete'
          WHERE no.id = _row.id;
          RETURN QUERY SELECT _row.id, 'failed', _row.attempts, 'Frozen provider_request incomplete'::text;
        END IF;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_outbox AS no
      SET status = 'failed', prepared_at = NULL,
          current_attempt_id = NULL, current_attempt_started_at = NULL,
          last_error = SQLERRM
      WHERE no.id = _row.id;
      RETURN QUERY SELECT _row.id, 'failed', _row.attempts, SQLERRM;
    END;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_notification_outbox(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_notification_outbox(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.process_notification_outbox(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_notification_outbox(int) TO service_role;

-- =========================================================
-- 5. BEGIN_DELIVERY_ATTEMPT — PERSISTENCE BARRIER
-- =========================================================

CREATE OR REPLACE FUNCTION public.begin_delivery_attempt(
  p_outbox_id uuid,
  p_expected_attempts int,
  p_from text
)
RETURNS TABLE (
  result text,
  outbox_id uuid,
  delivery_id uuid,
  attempt_id uuid,
  attempt_number int,
  provider_request jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _row public.notification_outbox%ROWTYPE;
  _attempt_id uuid;
  _attempt_number int;
  _provider_request jsonb;
  _current_first_attempt timestamptz;
BEGIN
  -- Step 1: Lock and check prepared row
  SELECT first_provider_attempt_at INTO _current_first_attempt
  FROM public.notification_outbox
  WHERE id = p_outbox_id
    AND status = 'prepared'
    AND attempts = p_expected_attempts
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'cas_mismatch'::text, p_outbox_id, NULL::uuid, NULL::uuid, NULL::int, NULL::jsonb;
    RETURN;
  END IF;

  -- Step 2: Enforce 20h deadline BEFORE any mutation
  IF _current_first_attempt IS NOT NULL
     AND _current_first_attempt + interval '20 hours' <= now() THEN
    UPDATE public.notification_outbox
    SET status = 'delivery_unknown',
        prepared_at = NULL,
        last_error = '20h idempotency ceiling exceeded at begin_delivery_attempt'
    WHERE id = p_outbox_id
      AND status = 'prepared'
      AND attempts = p_expected_attempts;
    RETURN QUERY SELECT 'deadline_expired'::text, p_outbox_id, NULL::uuid, NULL::uuid, NULL::int, NULL::jsonb;
    RETURN;
  END IF;

  -- Step 3: Validate p_from is non-null and non-empty
  IF p_from IS NULL OR btrim(p_from) = '' THEN
    RETURN QUERY SELECT 'invalid_from'::text, p_outbox_id, NULL::uuid, NULL::uuid, NULL::int, NULL::jsonb;
    RETURN;
  END IF;

  -- Step 4: Atomic CAS — prepared → sending
  UPDATE public.notification_outbox AS _no
  SET status = 'sending',
      delivery_id = COALESCE(_no.delivery_id, gen_random_uuid()),
      first_provider_attempt_at = COALESCE(_no.first_provider_attempt_at, now()),
      current_attempt_started_at = now(),
      current_attempt_id = gen_random_uuid(),
      attempts = _no.attempts + 1,
      payload = CASE
        WHEN NOT (_no.payload->'provider_request' ? 'from')
               OR _no.payload->'provider_request'->>'from' IS NULL
        THEN jsonb_set(
          _no.payload,
          '{provider_request,from}',
          to_jsonb(p_from)
        )
        ELSE _no.payload
      END
  WHERE _no.id = p_outbox_id
    AND _no.status = 'prepared'
    AND _no.attempts = p_expected_attempts
  RETURNING * INTO _row;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'cas_mismatch'::text, p_outbox_id, NULL::uuid, NULL::uuid, NULL::int, NULL::jsonb;
    RETURN;
  END IF;

  -- Step 5: Validate complete provider_request (non-null, non-empty)
  _provider_request := _row.payload->'provider_request';
  IF _provider_request->>'to' IS NULL
     OR btrim(_provider_request->>'to') = ''
     OR _provider_request->>'subject' IS NULL
     OR btrim(_provider_request->>'subject') = ''
     OR _provider_request->>'html' IS NULL
     OR btrim(_provider_request->>'html') = ''
     OR _provider_request->>'from' IS NULL
     OR btrim(_provider_request->>'from') = '' THEN
    RAISE EXCEPTION 'Incomplete provider_request: to/subject/html/from missing or empty';
  END IF;

  _attempt_number := _row.attempts;
  _attempt_id := _row.current_attempt_id;

  -- Step 6: Insert ledger row in same transaction
  INSERT INTO public.notification_delivery_attempts (
    id, outbox_id, delivery_id, attempt_number, started_at,
    provider_outcome, ack_status
  ) VALUES (
    _attempt_id, _row.id, _row.delivery_id, _attempt_number, now(),
    'started', 'pending'
  );

  RETURN QUERY SELECT
    'ok'::text,
    _row.id,
    _row.delivery_id,
    _attempt_id,
    _attempt_number,
    _provider_request;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.begin_delivery_attempt(uuid, int, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.begin_delivery_attempt(uuid, int, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.begin_delivery_attempt(uuid, int, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.begin_delivery_attempt(uuid, int, text) TO service_role;

-- =========================================================
-- 6. COMPLETE_DELIVERY_ATTEMPT — IDEMPOTENT COMPLETION
-- =========================================================

CREATE OR REPLACE FUNCTION public.complete_delivery_attempt(
  p_outbox_id uuid,
  p_expected_attempt_id uuid,
  p_expected_delivery_id uuid,
  p_attempt_number int,
  p_classification text,
  p_provider_http_status int,
  p_provider_error_code text,
  p_provider_message_id text,
  p_last_error text,
  p_next_retry_at timestamptz
)
RETURNS TABLE (
  ack_applied boolean,
  already_completed boolean,
  outbox_status text,
  attempt_id uuid,
  provider_result_persisted boolean,
  failure_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _ledger_row public.notification_delivery_attempts%ROWTYPE;
  _outbox_row public.notification_outbox%ROWTYPE;
  _provider_outcome text;
  _requested_new_status text;
  _deadline_ok boolean := false;
  _attempts_ok boolean := false;
BEGIN
  -- Step 1: Locate and lock ledger row by immutable attempt UUID
  SELECT * INTO _ledger_row
  FROM public.notification_delivery_attempts
  WHERE id = p_expected_attempt_id
    AND outbox_id = p_outbox_id
    AND delivery_id = p_expected_delivery_id
    AND attempt_number = p_attempt_number
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      false, false, NULL::text, p_expected_attempt_id, false,
      'ledger_row_not_found';
    RETURN;
  END IF;

  -- Step 2: Validate p_classification IMMEDIATELY
  IF p_classification NOT IN (
    'success',
    'transient_retryable',
    'ambiguous_retryable',
    'terminal_failed',
    'invariant_violation',
    'operational_blocked'
  ) THEN
    RETURN QUERY SELECT
      false, false, NULL::text, _ledger_row.id, false,
      'invalid_classification';
    RETURN;
  END IF;

  -- Step 3: Derive provider_outcome from classification
  _provider_outcome := CASE p_classification
    WHEN 'success' THEN 'success'
    WHEN 'transient_retryable' THEN 'known_failure'
    WHEN 'ambiguous_retryable' THEN 'ambiguous'
    WHEN 'terminal_failed' THEN 'known_failure'
    WHEN 'invariant_violation' THEN 'known_failure'
    WHEN 'operational_blocked' THEN 'known_failure'
  END;

  -- Step 4: IDEMPOTENT REPLAY CHECK
  IF _ledger_row.ack_status = 'applied' THEN
    IF _ledger_row.classification <> p_classification
       OR _ledger_row.provider_outcome <> _provider_outcome
       OR COALESCE(_ledger_row.provider_http_status, -1) <> COALESCE(p_provider_http_status, -1)
       OR COALESCE(_ledger_row.provider_error_code, '__N__') <> COALESCE(p_provider_error_code, '__N__')
       OR COALESCE(_ledger_row.provider_message_id, '__N__') <> COALESCE(p_provider_message_id, '__N__') THEN
      RETURN QUERY SELECT
        false, true,
        (SELECT status FROM public.notification_outbox WHERE id = p_outbox_id),
        _ledger_row.id, true,
        'result_conflict';
      RETURN;
    END IF;
    RETURN QUERY SELECT
      true, true,
      (SELECT status FROM public.notification_outbox WHERE id = p_outbox_id),
      _ledger_row.id, true,
      NULL::text;
    RETURN;
  END IF;

  IF _ledger_row.ack_status = 'stale_rejected' THEN
    IF _ledger_row.classification <> p_classification
       OR _ledger_row.provider_outcome <> _provider_outcome
       OR COALESCE(_ledger_row.provider_http_status, -1) <> COALESCE(p_provider_http_status, -1)
       OR COALESCE(_ledger_row.provider_error_code, '__N__') <> COALESCE(p_provider_error_code, '__N__')
       OR COALESCE(_ledger_row.provider_message_id, '__N__') <> COALESCE(p_provider_message_id, '__N__') THEN
      RETURN QUERY SELECT
        false, true,
        (SELECT status FROM public.notification_outbox WHERE id = p_outbox_id),
        _ledger_row.id, true,
        'result_conflict';
      RETURN;
    END IF;
    RETURN QUERY SELECT
      false, true,
      (SELECT status FROM public.notification_outbox WHERE id = p_outbox_id),
      _ledger_row.id, true,
      'previously_stale_rejected';
    RETURN;
  END IF;

  IF _ledger_row.ack_status <> 'pending' THEN
    RETURN QUERY SELECT
      false, true,
      (SELECT status FROM public.notification_outbox WHERE id = p_outbox_id),
      _ledger_row.id, false,
      'unexpected_ack_status:' || _ledger_row.ack_status;
    RETURN;
  END IF;

  -- Step 5: Derive requested_new_status from classification + conditions
  _requested_new_status := NULL;

  IF p_classification = 'success' THEN
    _requested_new_status := 'sent';

  ELSIF p_classification = 'transient_retryable' THEN
    SELECT
      (first_provider_attempt_at IS NULL
       OR first_provider_attempt_at + interval '20 hours' > now()),
      attempts < 3
    INTO _deadline_ok, _attempts_ok
    FROM public.notification_outbox
    WHERE id = p_outbox_id;

    IF _deadline_ok AND _attempts_ok THEN
      _requested_new_status := 'retry';
    ELSE
      _requested_new_status := 'retry_exhausted';
    END IF;

  ELSIF p_classification = 'ambiguous_retryable' THEN
    SELECT
      (first_provider_attempt_at IS NULL
       OR first_provider_attempt_at + interval '20 hours' > now()),
      attempts < 3
    INTO _deadline_ok, _attempts_ok
    FROM public.notification_outbox
    WHERE id = p_outbox_id;

    IF _deadline_ok AND _attempts_ok THEN
      _requested_new_status := 'retry';
    ELSE
      _requested_new_status := 'delivery_unknown';
    END IF;

  ELSIF p_classification = 'terminal_failed' THEN
    _requested_new_status := 'failed';

  ELSIF p_classification = 'invariant_violation' THEN
    _requested_new_status := 'delivery_unknown';

  ELSIF p_classification = 'operational_blocked' THEN
    _requested_new_status := 'operational_blocked';
  END IF;

  IF _requested_new_status IS NULL THEN
    RETURN QUERY SELECT
      false, false, NULL::text, _ledger_row.id, false,
      'invalid_classification';
    RETURN;
  END IF;

  -- Step 6: Persist provider result in ledger (WHERE ack_status = 'pending')
  -- provider_response_at: NULL only when no HTTP response was received
  -- (network timeout / response lost). An HTTP 5xx response WAS received,
  -- so provider_response_at must be set even though classification is
  -- ambiguous_retryable for duplicate-safety purposes.
  UPDATE public.notification_delivery_attempts
  SET provider_response_at = CASE WHEN p_provider_http_status IS NULL THEN NULL ELSE now() END,
      provider_http_status = p_provider_http_status,
      provider_error_code = p_provider_error_code,
      provider_message_id = p_provider_message_id,
      provider_outcome = _provider_outcome,
      classification = p_classification
  WHERE id = _ledger_row.id
    AND ack_status = 'pending';

  -- Step 7: CAS outbox transition using current_attempt_id
  UPDATE public.notification_outbox
  SET status = _requested_new_status,
      sent_at = CASE WHEN _requested_new_status = 'sent' THEN now() ELSE sent_at END,
      last_error = p_last_error,
      prepared_at = NULL,
      current_attempt_id = NULL,
      current_attempt_started_at = NULL,
      next_retry_at = p_next_retry_at,
      payload = CASE
        WHEN p_provider_message_id IS NOT NULL
        THEN jsonb_set(payload, '{provider_message_id}', to_jsonb(p_provider_message_id))
        ELSE payload
      END
  WHERE id = p_outbox_id
    AND status = 'sending'
    AND current_attempt_id = p_expected_attempt_id
  RETURNING * INTO _outbox_row;

  IF NOT FOUND THEN
    -- Outbox CAS failed: provider result already persisted
    UPDATE public.notification_delivery_attempts
    SET ack_status = 'stale_rejected'
    WHERE id = _ledger_row.id
      AND ack_status = 'pending';

    RETURN QUERY SELECT
      false, false,
      (SELECT status FROM public.notification_outbox WHERE id = p_outbox_id),
      _ledger_row.id, true,
      'outbox_cas_mismatch';
    RETURN;
  END IF;

  -- Step 8: Mark ledger ACK as applied
  UPDATE public.notification_delivery_attempts
  SET ack_status = 'applied'
  WHERE id = _ledger_row.id
    AND ack_status = 'pending';

  RETURN QUERY SELECT
    true, false,
    _outbox_row.status,
    _ledger_row.id,
    true,
    NULL::text;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_delivery_attempt(uuid, uuid, uuid, int, text, int, text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_delivery_attempt(uuid, uuid, uuid, int, text, int, text, text, text, timestamptz) FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_delivery_attempt(uuid, uuid, uuid, int, text, int, text, text, text, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_delivery_attempt(uuid, uuid, uuid, int, text, int, text, text, text, timestamptz) TO service_role;
