-- ============================================================
--  Stripe Backend Payment RPCs
--  Objective: Allow Cloudflare Functions (service_role) to safely
--  update stripe_session_id and paiement_statut without weakening
--  the missions_sensitive_protect trigger.
--
--  The trigger blocks direct UPDATE of paiement_statut and
--  stripe_session_id unless current_user = 'postgres'.
--  These SECURITY DEFINER functions run as postgres (owner),
--  so the trigger allows the UPDATE.
--
--  EXECUTE is granted ONLY to service_role.
--  anon, authenticated, and PUBLIC are explicitly revoked.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. record_stripe_checkout_session
--    Links a Stripe Checkout Session ID to a mission.
--    Called by create-checkout-session.js after Stripe session creation.
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_stripe_checkout_session(
  p_mission_id uuid,
  p_session_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_mission public.missions;
BEGIN
  -- Validate inputs
  IF p_mission_id IS NULL THEN
    RAISE EXCEPTION 'mission_id est requis'
      USING ERRCODE = '23502';
  END IF;

  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id est requis'
      USING ERRCODE = '23502';
  END IF;

  IF p_session_id NOT LIKE 'cs\_%' THEN
    RAISE EXCEPTION 'session_id doit commencer par cs_'
      USING ERRCODE = '23514';
  END IF;

  -- Lock the mission row
  SELECT * INTO v_mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  -- Refuse if already paid
  IF v_mission.paiement_statut IN ('paid', 'paye') THEN
    RAISE EXCEPTION 'Mission deja payee'
      USING ERRCODE = '55006';
  END IF;

  -- Only allow payable statuses
  IF v_mission.status NOT IN ('available', 'assigned', 'accepted') THEN
    RAISE EXCEPTION 'Statut non payable: %', v_mission.status
      USING ERRCODE = '55006';
  END IF;

  -- Idempotent: same session already linked
  IF v_mission.stripe_session_id = p_session_id THEN
    RETURN 'already_linked';
  END IF;

  -- Refuse if a different session is already linked
  IF v_mission.stripe_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'Une autre session Stripe est deja liee a cette mission'
      USING ERRCODE = '55006';
  END IF;

  -- Link the session (only stripe_session_id, nothing else)
  UPDATE public.missions
  SET stripe_session_id = p_session_id
  WHERE id = p_mission_id;

  RETURN 'linked';
END;
$$;

-- ============================================================
-- 2. complete_stripe_checkout_payment
--    Marks a mission as paid after Stripe webhook confirmation.
--    Called by stripe-webhook.js on checkout.session.completed.
--    Requires the session_id to be already linked.
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_stripe_checkout_payment(
  p_mission_id uuid,
  p_session_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_mission public.missions;
BEGIN
  -- Validate inputs
  IF p_mission_id IS NULL THEN
    RAISE EXCEPTION 'mission_id est requis'
      USING ERRCODE = '23502';
  END IF;

  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'session_id est requis'
      USING ERRCODE = '23502';
  END IF;

  -- Lock the mission row
  SELECT * INTO v_mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  -- Session must be already linked
  IF v_mission.stripe_session_id IS NULL THEN
    RAISE EXCEPTION 'Aucune session Stripe liee a cette mission'
      USING ERRCODE = '55006';
  END IF;

  -- Session must match exactly
  IF v_mission.stripe_session_id != p_session_id THEN
    RAISE EXCEPTION 'session_id ne correspond pas'
      USING ERRCODE = '42883';
  END IF;

  -- Idempotent: already paid
  IF v_mission.paiement_statut IN ('paid', 'paye') THEN
    RETURN 'already_paid';
  END IF;

  -- Refuse terminal statuses
  IF v_mission.status IN ('cancelled', 'completed', 'archived') THEN
    RAISE EXCEPTION 'Mission non payable (statut: %)', v_mission.status
      USING ERRCODE = '55006';
  END IF;

  -- Mark as paid (only paiement_statut, nothing else)
  UPDATE public.missions
  SET paiement_statut = 'paid'
  WHERE id = p_mission_id;

  RETURN 'paid';
END;
$$;

-- ============================================================
-- 3. Grants: service_role ONLY
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.record_stripe_checkout_session(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_stripe_checkout_session(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.record_stripe_checkout_session(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_stripe_checkout_session(uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.complete_stripe_checkout_payment(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_stripe_checkout_payment(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_stripe_checkout_payment(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_stripe_checkout_payment(uuid, text) TO service_role;

COMMIT;
