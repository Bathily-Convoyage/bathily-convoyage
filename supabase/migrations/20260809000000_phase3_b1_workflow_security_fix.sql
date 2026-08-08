-- =====================================================
-- Migration: phase3_b1_workflow_security_fix
-- Objectif : durcir le moteur workflow (bypass direct, event types, atomicité)
-- =====================================================

BEGIN;

-- =========================================================
-- 1. TRIGGERS DE PROTECTION CONTRE BYPASS
-- =========================================================

-- Bloquer tout UPDATE/DELETE direct sur mission_events sauf owner postgres
CREATE OR REPLACE FUNCTION public.mission_events_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF current_user = 'postgres' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'mission_events est append-only : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS mission_events_protect_trigger ON public.mission_events;
CREATE TRIGGER mission_events_protect_trigger
  BEFORE UPDATE OR DELETE ON public.mission_events
  FOR EACH ROW
  EXECUTE FUNCTION public.mission_events_protect();

-- Bloquer les modifications directes de statut / convoyeur sur missions
CREATE OR REPLACE FUNCTION public.missions_sensitive_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Les RPC métier SECURITY DEFINER s'exécutent en tant que postgres.
  IF current_user = 'postgres' THEN
    RETURN NEW;
  END IF;

  -- Seuls admin/operator peuvent modifier les colonnes non sensibles (tarifs, etc.)
  IF NOT (public.is_admin() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Missions : UPDATE direct interdit pour ce rôle'
      USING ERRCODE = '42501';
  END IF;

  -- Même admin/operator ne peuvent pas modifier status / convoyeur directement ;
  -- ces champs doivent passer par les RPC métier.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Le statut ne peut être modifié que via transition_mission_status()'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.convoyeur_id IS DISTINCT FROM OLD.convoyeur_id
     OR NEW.convoyeur_nom IS DISTINCT FROM OLD.convoyeur_nom THEN
    RAISE EXCEPTION 'Le convoyeur ne peut être modifié que via admin_assign_mission()'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS missions_sensitive_protect_trigger ON public.missions;
CREATE TRIGGER missions_sensitive_protect_trigger
  BEFORE UPDATE ON public.missions
  FOR EACH ROW
  EXECUTE FUNCTION public.missions_sensitive_protect();

REVOKE EXECUTE ON FUNCTION public.mission_events_protect() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missions_sensitive_protect() FROM PUBLIC;

-- =========================================================
-- 2. EVENT TYPES MÉTIER EXPLICITES
-- =========================================================

CREATE OR REPLACE FUNCTION public.mission_event_name(
  p_from text,
  p_to text
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_from = 'available'   AND p_to = 'assigned'   THEN 'mission_assigned'
    WHEN p_from = 'assigned'    AND p_to = 'accepted'   THEN 'assignment_accepted'
    WHEN p_from = 'assigned'    AND p_to = 'available'  THEN 'assignment_rejected'
    WHEN p_from = 'accepted'    AND p_to = 'in_progress' THEN 'mission_started'
    WHEN p_from = 'in_progress' AND p_to = 'delivered'  THEN 'mission_delivered'
    WHEN p_from = 'delivered'   AND p_to = 'completed'  THEN 'mission_completed'
    WHEN p_from = 'completed'   AND p_to = 'archived'   THEN 'mission_archived'
    WHEN p_from = 'cancelled'   AND p_to = 'archived'   THEN 'mission_archived'
    WHEN p_from IN ('available','assigned','accepted','in_progress','delivered')
         AND p_to = 'cancelled' THEN 'mission_cancelled'
    ELSE 'mission_status_changed'
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.mission_event_name(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mission_event_name(text, text) TO authenticated;

-- =========================================================
-- 3. CORRECTION transition_mission_status (event type explicite)
-- =========================================================

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
  _current_status text;
  _is_admin       boolean := public.is_admin();
  _is_operator    boolean := public.is_operator();
  _is_convoyeur   boolean;
  _mission        public.missions%ROWTYPE;
  _allowed        boolean := false;
  _actor_role     text;
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

  IF _is_admin OR _is_operator THEN
    _actor_role := 'admin';
    _allowed := (
      (_current_status = 'available'   AND p_target_status = 'assigned')
      OR (_current_status = 'assigned'  AND p_target_status IN ('available', 'cancelled'))
      OR (_current_status = 'accepted'  AND p_target_status = 'cancelled')
      OR (_current_status = 'in_progress' AND p_target_status = 'cancelled')
      OR (_current_status = 'delivered' AND p_target_status = 'completed')
      OR (_current_status = 'completed' AND p_target_status = 'archived')
      OR (_current_status = 'cancelled' AND p_target_status = 'archived')
    );

  ELSIF _is_convoyeur THEN
    _actor_role := 'convoyeur';
    _allowed := (
      (_current_status = 'assigned'   AND p_target_status IN ('accepted', 'available'))
      OR (_current_status = 'accepted'  AND p_target_status = 'in_progress')
      OR (_current_status = 'in_progress' AND p_target_status = 'delivered')
    );

  ELSE
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  IF NOT _allowed THEN
    RAISE EXCEPTION 'Transition % -> % non autorisée pour ce rôle', _current_status, p_target_status
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.missions
  SET status = p_target_status,
      updated_at = now()
  WHERE id = p_mission_id;

  PERFORM public.log_mission_event(
    p_mission_id,
    public.mission_event_name(_current_status, p_target_status),
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

-- =========================================================
-- 4. FORCER ROW LEVEL SECURITY SUR mission_events
-- =========================================================

ALTER TABLE public.mission_events FORCE ROW LEVEL SECURITY;

-- S'assurer que log_mission_event n'est pas appelable directement par un user
REVOKE EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) FROM authenticated;

COMMIT;
