-- =====================================================
-- Migration: phase3_c24b_client_tracking
-- Objectif : Étendre create_tracking_token au Client propriétaire
--            + révoquer les anciens tokens actifs avant création
-- =====================================================

BEGIN;

-- =========================================================
-- 1. EXTENSION create_tracking_token : Client propriétaire
-- =========================================================

CREATE OR REPLACE FUNCTION public.create_tracking_token(p_mission_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  _token text;
  _hash text;
  _mission_status text;
  _mission_client_id uuid;
  _is_admin_op boolean;
  _is_client_owner boolean;
BEGIN
  -- Vérifier mission existe et récupérer infos
  SELECT status, client_id INTO _mission_status, _mission_client_id
  FROM public.missions
  WHERE id = p_mission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Déterminer l'autorisation
  _is_admin_op := public.is_admin() OR public.is_operator();

  _is_client_owner := EXISTS (
    SELECT 1 FROM public.clients c
    WHERE c.id = _mission_client_id
      AND c.auth_user_id = auth.uid()
  );

  IF NOT (_is_admin_op OR _is_client_owner) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Statuts autorisés
  -- Admin/Operator : accepted, in_progress, delivered
  -- Client : assigned, accepted, in_progress (pas après livraison)
  IF _is_admin_op THEN
    IF _mission_status NOT IN ('accepted', 'in_progress', 'delivered') THEN
      RAISE EXCEPTION 'Statut mission incompatible avec la création d''un lien de suivi' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Client propriétaire
    IF _mission_status NOT IN ('assigned', 'accepted', 'in_progress') THEN
      RAISE EXCEPTION 'Statut mission incompatible avec la création d''un lien de suivi' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Révoquer les anciens tokens actifs de cette mission
  UPDATE public.mission_tracking_tokens
  SET revoked_at = now()
  WHERE mission_id = p_mission_id
    AND revoked_at IS NULL
    AND expires_at > now();

  -- Générer nouveau token
  _token := encode(extensions.gen_random_bytes(32), 'base64');
  _hash := encode(extensions.digest(_token, 'sha256'), 'hex');

  INSERT INTO public.mission_tracking_tokens (mission_id, token_hash, created_by)
  VALUES (p_mission_id, _hash, auth.uid());

  RETURN _token;
END;
$function$;

-- Les grants restent identiques : authenticated peut EXECUTE
-- L'autorisation réelle est dans le corps SECURITY DEFINER
REVOKE EXECUTE ON FUNCTION public.create_tracking_token(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_tracking_token(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_tracking_token(uuid) TO authenticated;

-- =========================================================
-- 2. VÉRIFICATION : external_convoyeurs_enabled reste false
-- =========================================================
DO $verify$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.app_settings WHERE key = 'external_convoyeurs_enabled'
  ) THEN
    RAISE EXCEPTION 'external_convoyeurs_enabled key missing from app_settings'
      USING ERRCODE = 'P0001';
  END IF;
END $verify$;

COMMIT;
