-- =====================================================
-- Migration: C-2.3A — EDL Transition Gates + Storage Operator Isolation
-- Timestamp: 20260812000001
-- =====================================================
-- Objectifs :
-- 1. Ajouter un gate EDL départ sur accepted → in_progress
-- 2. Ajouter un gate EDL arrivée sur in_progress → delivered
-- 3. Aucun gate paiement sur delivered → completed
-- 4. Supprimer la policy convoyeur_media_select_operator (accès global Operator)
--    → les operators assignés restent couverts par convoyeur_media_select_mission_concerned
--
-- Préserve intégralement la matrice d'autorisation C-2.2B1.
-- Préserve le gate externe is_internal_user() OR external_convoyeurs_enabled().
-- Aucune modification frontend, BDM, paiement, ou autre bucket.
-- =====================================================

BEGIN;

-- =====================================================
-- 1. HARDENING transition_mission_status
-- =====================================================
-- Part de la fonction active C-2.2B1 et ajoute deux gates EDL
-- avant l'UPDATE final, sans modifier la matrice d'autorisation.

CREATE OR REPLACE FUNCTION public.transition_mission_status(
  p_mission_id uuid,
  p_target_status text,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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

  -- ---------------------------------------------------------
  -- GATES EDL (C-2.3A)
  -- Vérifiés après autorisation, avant l'UPDATE.
  -- S'appliquent à tous les rôles autorisés (admin, operator, convoyeur).
  -- ---------------------------------------------------------

  -- Gate EDL départ : accepted → in_progress
  IF _current_status = 'accepted' AND p_target_status = 'in_progress' THEN
    IF NOT public.mission_has_valid_edl(p_mission_id, 'depart') THEN
      RAISE EXCEPTION 'L''état des lieux de départ doit être validé avant de démarrer la mission.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Gate EDL arrivée : in_progress → delivered
  IF _current_status = 'in_progress' AND p_target_status = 'delivered' THEN
    IF NOT public.mission_has_valid_edl(p_mission_id, 'arrivee') THEN
      RAISE EXCEPTION 'L''état des lieux d''arrivée doit être validé avant de livrer la mission.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- delivered → completed : AUCUN GATE PAIEMENT (décision métier figée)

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

-- =====================================================
-- 2. STORAGE — Suppression policy Operator global
-- =====================================================
-- convoyeur_media_select_operator accordait à tout operator
-- un accès SELECT global sur convoyeur-media sans vérification
-- d'assignation. Les operators assignés restent couverts par
-- convoyeur_media_select_mission_concerned (via la relation
-- mission.convoyeur_id → convoyeurs.auth_user_id = auth.uid()).
--
-- Après suppression :
--   Admin           → accès global via convoyeur_media_select_admin
--   Operator assigné → accès via convoyeur_media_select_mission_concerned
--   Operator non assigné → refus
--   Client concerné → accès via convoyeur_media_select_mission_concerned
--   External (flag=false) → refus via RLS cascade missions_select_b3
--   Anon            → refus

DROP POLICY IF EXISTS "convoyeur_media_select_operator" ON storage.objects;

COMMIT;

NOTIFY pgrst, 'reload schema';
