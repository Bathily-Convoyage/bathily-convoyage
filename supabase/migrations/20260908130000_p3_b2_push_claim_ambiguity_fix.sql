-- =====================================================
-- P3-B2.4H2A — Fix column reference ambiguity in claim_push_outbox_rows
-- =====================================================
-- Root cause: PostgreSQL error "column reference 'attempts' is ambiguous"
-- The function's RETURNS TABLE(... attempts int ...) creates a PL/pgSQL
-- output parameter named 'attempts'. In the UPDATE SET clause, the
-- unqualified 'attempts' is ambiguous between the table column and
-- the PL/pgSQL output parameter variable.
--
-- Fix: Add #variable_conflict use_column directive to tell PL/pgSQL
-- to resolve ambiguous references as table columns, not variables.
-- This is the minimum change — no SQL logic changes, no signature
-- changes, no semantic changes.
--
-- Reference: PostgreSQL docs §41.11 PL/pgSQL under the Hood
-- "You can specify that PL/pgSQL should resolve ambiguous references
--  as the variable or as the table column."
-- =====================================================

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
#variable_conflict use_column
BEGIN
  -- Phase 1: Recover stale processing rows that have exhausted attempts
  UPDATE public.push_notification_outbox
  SET
    status = 'failed',
    last_error = 'Max attempts reached (stale processing recovery)',
    updated_at = now()
  WHERE status = 'processing'
    AND claimed_at < now() - interval '5 minutes'
    AND attempts >= 5;

  -- Phase 2: Claim eligible rows for processing
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
    AND q.attempts < 5
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

-- Explicit grant to service_role — needed for Supabase RPC calls
GRANT EXECUTE ON FUNCTION public.claim_push_outbox_rows(int) TO service_role;
