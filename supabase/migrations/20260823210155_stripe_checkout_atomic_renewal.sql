BEGIN;

-- Atomically link the first Checkout Session or replace the exact expired
-- session observed by the caller. Stripe creation happens before this short
-- transaction and is protected separately by a deterministic idempotency key.
CREATE OR REPLACE FUNCTION public.replace_stripe_checkout_session(
  p_mission_id uuid,
  p_expected_session_id text,
  p_new_session_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_mission public.missions;
  v_result text;
BEGIN
  IF p_mission_id IS NULL THEN
    RAISE EXCEPTION 'mission_id est requis' USING ERRCODE = '23502';
  END IF;

  IF p_new_session_id IS NULL OR btrim(p_new_session_id) = '' THEN
    RAISE EXCEPTION 'new_session_id est requis' USING ERRCODE = '23502';
  END IF;

  IF p_new_session_id NOT LIKE 'cs\_%' THEN
    RAISE EXCEPTION 'new_session_id doit commencer par cs_' USING ERRCODE = '23514';
  END IF;

  IF p_expected_session_id IS NOT NULL
     AND p_expected_session_id NOT LIKE 'cs\_%' THEN
    RAISE EXCEPTION 'expected_session_id doit commencer par cs_' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_mission.paiement_statut IN ('paid', 'paye') THEN
    RAISE EXCEPTION 'Mission deja payee' USING ERRCODE = '55006';
  END IF;

  IF v_mission.status NOT IN ('available', 'assigned', 'accepted') THEN
    RAISE EXCEPTION 'Statut non payable: %', v_mission.status USING ERRCODE = '55006';
  END IF;

  IF v_mission.stripe_session_id = p_new_session_id THEN
    RETURN 'already_linked';
  END IF;

  IF v_mission.stripe_session_id IS DISTINCT FROM p_expected_session_id THEN
    RAISE EXCEPTION 'La session Stripe a change simultanement' USING ERRCODE = '55006';
  END IF;

  v_result := CASE WHEN p_expected_session_id IS NULL THEN 'linked' ELSE 'replaced' END;

  UPDATE public.missions
  SET stripe_session_id = p_new_session_id
  WHERE id = p_mission_id;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_stripe_checkout_session(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.replace_stripe_checkout_session(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.replace_stripe_checkout_session(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_stripe_checkout_session(uuid, text, text) TO service_role;

COMMIT;
