-- =====================================================
-- Migration: phase3_c22b1_fix_operator_executor_transitions
-- Objectif : Corriger le conflit de rôles operator/convoyeur
--            dans transition_mission_status()
--
-- Problème :
--   La fonction actuelle utilise IF _is_admin OR _is_operator THEN ...
--   ELSIF _is_convoyeur THEN ...
--   Un operator qui est aussi le convoyeur assigné ne jamais atteint
--   la branche convoyeur, bloquant les transitions terrain :
--     accepted → in_progress (Démarrer)
--     in_progress → delivered (Livrer)
--
-- Solution :
--   Rendre les autorisations CUMULATIVES au lieu de mutuellement exclusives.
--   Un operator assigné bénéficie des transitions de gestion ET d'exécution.
--   Les transitions d'exécution nécessitent is_convoyeur_for_mission() = true
--   ET (is_internal_user() OR external_convoyeurs_enabled()).
--
-- Préservation :
--   - SECURITY DEFINER, search_path = ''
--   - GRANT uniquement à authenticated
--   - mission_can_transition() inchangé
--   - EDL gates inchangés (mission_has_valid_edl sur delivered→completed uniquement)
--   - log_mission_event inchangé
--   - missions_sensitive_protect trigger inchangé
--   - Matrices de transitions inchangées
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.transition_mission_status(
  p_mission_id    uuid,
  p_target_status text,
  p_reason        text DEFAULT NULL,
  p_metadata      jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _current_status     text;
  _is_admin           boolean := public.is_admin();
  _is_operator        boolean := public.is_operator();
  _is_convoyeur       boolean;
  _mission            public.missions%ROWTYPE;
  _allowed_gestion    boolean := false;
  _allowed_execution  boolean := false;
  _allowed            boolean := false;
  _actor_role         text;
  _event_type         text;
BEGIN
  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  _current_status := _mission.status;

  IF NOT public.mission_can_transition(_current_status, p_target_status) THEN
    RAISE EXCEPTION 'Transition interdite : % -> %', _current_status, p_target_status
      USING ERRCODE = 'P0001';
  END IF;

  _is_convoyeur := public.is_convoyeur_for_mission(p_mission_id, auth.uid());

  -- ---------------------------------------------------------
  -- Branche 1 : TRANSITIONS DE GESTION (admin / operator)
  -- Conserve la matrice existante inchangée.
  -- S'applique indépendamment de l'affectation convoyeur.
  -- ---------------------------------------------------------
  IF _is_admin OR _is_operator THEN
    _allowed_gestion := (
      (_current_status = 'available'   AND p_target_status = 'assigned')
      OR (_current_status = 'assigned'  AND p_target_status IN ('available', 'cancelled'))
      OR (_current_status = 'accepted'  AND p_target_status = 'cancelled')
      OR (_current_status = 'in_progress' AND p_target_status = 'cancelled')
      OR (_current_status = 'delivered' AND p_target_status = 'completed')
      OR (_current_status = 'completed' AND p_target_status = 'archived')
      OR (_current_status = 'cancelled' AND p_target_status = 'archived')
    );
  END IF;

  -- ---------------------------------------------------------
  -- Branche 2 : TRANSITIONS D'EXÉCUTION (convoyeur assigné)
  -- Conserve la matrice existante inchangée.
  -- Nécessite is_convoyeur_for_mission() = true.
  -- Gate externe : is_internal_user() OR external_convoyeurs_enabled().
  -- ---------------------------------------------------------
  IF _is_convoyeur THEN
    IF public.is_internal_user() OR public.external_convoyeurs_enabled() THEN
      _allowed_execution := (
        (_current_status = 'assigned'   AND p_target_status IN ('accepted', 'available'))
        OR (_current_status = 'accepted'  AND p_target_status = 'in_progress')
        OR (_current_status = 'in_progress' AND p_target_status = 'delivered')
      );
    END IF;
  END IF;

  -- ---------------------------------------------------------
  -- Autorisation cumulative
  -- ---------------------------------------------------------
  _allowed := _allowed_gestion OR _allowed_execution;

  IF NOT _allowed THEN
    IF _is_admin OR _is_operator OR _is_convoyeur THEN
      RAISE EXCEPTION 'Transition % -> % non autorisée pour ce rôle', _current_status, p_target_status
        USING ERRCODE = '42501';
    ELSE
      RAISE EXCEPTION 'Non autorisé'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Détermination du rôle acteur pour le log
  -- Priorise le rôle d'exécution si la transition est d'exécution,
  -- sinon utilise le rôle de gestion.
  IF _allowed_execution AND NOT _allowed_gestion THEN
    _actor_role := 'convoyeur';
  ELSIF _allowed_gestion AND NOT _allowed_execution THEN
    _actor_role := 'admin';
  ELSIF _allowed_execution AND _allowed_gestion THEN
    -- Cumul : l'operator est aussi le convoyeur assigné.
    -- On loge comme 'operator' pour tracer l'identité interne.
    _actor_role := 'operator';
  ELSE
    _actor_role := 'admin';
  END IF;

  UPDATE public.missions
  SET status = p_target_status,
      updated_at = now()
  WHERE id = p_mission_id;

  _event_type := public.mission_event_name(_current_status, p_target_status);

  PERFORM public.log_mission_event(
    p_mission_id,
    _event_type,
    _current_status,
    p_target_status,
    _actor_role,
    jsonb_build_object(
      'reason', p_reason,
      'metadata', p_metadata
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) TO authenticated;

COMMIT;
