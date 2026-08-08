-- =====================================================
-- Migration: phase3_b1_mission_workflow
-- Objectif : moteur server-side pour le cycle de vie des missions
-- =====================================================

BEGIN;

-- =========================================================
-- 1. TABLE mission_events (append-only)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.mission_events (
  id              uuid        DEFAULT gen_random_uuid() NOT NULL,
  mission_id      uuid        NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  event_type      text        NOT NULL,
  from_status     text,
  to_status       text,
  actor_user_id   uuid,
  actor_role      text,
  metadata        jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (id)
);

ALTER TABLE public.mission_events OWNER TO "postgres";

ALTER TABLE public.mission_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.mission_events FROM PUBLIC;
REVOKE ALL ON public.mission_events FROM anon;
REVOKE ALL ON public.mission_events FROM authenticated;

-- Admin : all
CREATE POLICY "mission_events_admin_all"
  ON public.mission_events
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Client concerné : SELECT
CREATE POLICY "mission_events_client_select"
  ON public.mission_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_events.mission_id
        AND (m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
             OR m.client_email = (auth.jwt() ->> 'email'))
    )
  );

-- Convoyeur concerné : SELECT
CREATE POLICY "mission_events_convoyeur_select"
  ON public.mission_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_events.mission_id
        AND m.convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
    )
  );

GRANT SELECT ON public.mission_events TO authenticated;
GRANT ALL ON public.mission_events TO postgres;

-- =========================================================
-- 2. STATUTS MISSION : nouvelle matrice
-- =========================================================

-- Migration conservatoire des 'planned' legacy
DO $$
BEGIN
  -- planned + convoyeur_id non null  => assigned
  -- planned + convoyeur_id null      => available
  UPDATE public.missions
  SET status = 'assigned'
  WHERE status = 'planned' AND convoyeur_id IS NOT NULL;

  UPDATE public.missions
  SET status = 'available'
  WHERE status = 'planned' AND convoyeur_id IS NULL;
END $$;

-- Supprimer l'ancienne contrainte et recréer avec la nouvelle énumération
ALTER TABLE public.missions
  DROP CONSTRAINT IF EXISTS missions_status_check;

ALTER TABLE public.missions
  ADD CONSTRAINT missions_status_check
  CHECK (status = ANY (ARRAY[
    'available',
    'assigned',
    'accepted',
    'in_progress',
    'delivered',
    'completed',
    'cancelled',
    'archived'
  ]));

-- =========================================================
-- 3. FONCTIONS AUXILIAIRES
-- =========================================================

CREATE OR REPLACE FUNCTION public.mission_can_transition(from_status text, to_status text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT to_status = ANY (CASE from_status
    WHEN 'available'   THEN ARRAY['assigned', 'cancelled']
    WHEN 'assigned'    THEN ARRAY['accepted', 'available', 'cancelled']
    WHEN 'accepted'    THEN ARRAY['in_progress', 'cancelled']
    WHEN 'in_progress' THEN ARRAY['delivered', 'cancelled']
    WHEN 'delivered'   THEN ARRAY['completed']
    WHEN 'completed'   THEN ARRAY['archived']
    WHEN 'cancelled'   THEN ARRAY['archived']
    ELSE ARRAY[]::text[]
  END);
$$;

REVOKE EXECUTE ON FUNCTION public.mission_can_transition(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mission_can_transition(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_convoyeur_for_mission(p_mission_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.missions m
    JOIN public.convoyeurs c ON c.id = m.convoyeur_id
    WHERE m.id = p_mission_id
      AND c.auth_user_id = p_user_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_convoyeur_for_mission(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_convoyeur_for_mission(uuid, uuid) TO authenticated;

-- =========================================================
-- 4. LOGGING D'ÉVÉNEMENTS
-- =========================================================

CREATE OR REPLACE FUNCTION public.log_mission_event(
  p_mission_id  uuid,
  p_event_type  text,
  p_from_status text,
  p_to_status   text,
  p_actor_role  text,
  p_metadata    jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.mission_events (
    mission_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_role,
    metadata
  ) VALUES (
    p_mission_id,
    p_event_type,
    p_from_status,
    p_to_status,
    auth.uid(),
    p_actor_role,
    p_metadata
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) TO authenticated;

-- =========================================================
-- 5. TRANSITION DE STATUT
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

  -- Déterminer l'acteur et valider l'autorisation
  IF _is_admin OR _is_operator THEN
    _actor_role := 'admin';
    -- Admin/operator : seulement certaines transitions
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
    -- Convoyeur assigné
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
    RAISE EXCEPTION 'Rôle % non autorisé pour la transition % -> %', _actor_role, _current_status, p_target_status
      USING ERRCODE = '42501';
  END IF;

  -- EDL gates (préparation : ne pas bloquer si les EDL n'existent pas encore)
  -- NOTE : à brancher en 3.2B-2

  UPDATE public.missions
  SET status = p_target_status,
      updated_at = now()
  WHERE id = p_mission_id;

  PERFORM public.log_mission_event(
    p_mission_id,
    'mission_status_changed',
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
-- 6. ATTRIBUTION CONVOYEUR
-- =========================================================

CREATE OR REPLACE FUNCTION public.admin_assign_mission(
  p_mission_id    uuid,
  p_convoyeur_id  uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _mission public.missions%ROWTYPE;
  _convoyeur public.convoyeurs%ROWTYPE;
  _current_status text;
BEGIN
  IF NOT (public.is_admin() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  _current_status := _mission.status;

  IF _current_status <> 'available' THEN
    RAISE EXCEPTION 'Mission non disponible : statut %', _current_status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _convoyeur
  FROM public.convoyeurs
  WHERE id = p_convoyeur_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Convoyeur introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.missions
  SET convoyeur_id   = p_convoyeur_id,
      convoyeur_nom  = _convoyeur.prenom || ' ' || _convoyeur.nom,
      status         = 'assigned',
      updated_at     = now()
  WHERE id = p_mission_id;

  PERFORM public.log_mission_event(
    p_mission_id,
    'mission_assigned',
    _current_status,
    'assigned',
    'admin',
    jsonb_build_object(
      'convoyeur_id', p_convoyeur_id,
      'convoyeur_nom', _convoyeur.prenom || ' ' || _convoyeur.nom
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) TO authenticated;

-- =========================================================
-- 7. ACCEPTATION / REFUS CONVOYEUR
-- =========================================================

CREATE OR REPLACE FUNCTION public.respond_mission_assignment(
  p_mission_id   uuid,
  p_accepted     boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _mission public.missions%ROWTYPE;
  _current_status text;
BEGIN
  IF NOT public.is_convoyeur_for_mission(p_mission_id, auth.uid()) THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  _current_status := _mission.status;

  IF _current_status <> 'assigned' THEN
    RAISE EXCEPTION 'Mission non assignée : %', _current_status
      USING ERRCODE = 'P0001';
  END IF;

  IF p_accepted THEN
    UPDATE public.missions
    SET status = 'accepted',
        updated_at = now()
    WHERE id = p_mission_id;

    PERFORM public.log_mission_event(
      p_mission_id,
      'assignment_accepted',
      _current_status,
      'accepted',
      'convoyeur',
      '{}'::jsonb
    );
  ELSE
    UPDATE public.missions
    SET convoyeur_id  = NULL,
        convoyeur_nom = NULL,
        status        = 'available',
        updated_at    = now()
    WHERE id = p_mission_id;

    PERFORM public.log_mission_event(
      p_mission_id,
      'assignment_rejected',
      _current_status,
      'available',
      'convoyeur',
      '{}'::jsonb
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) TO authenticated;

-- =========================================================
-- 8. RLS MISSIONS : RESTREINDRE LES UPDATES DIRECTS
-- =========================================================

-- Supprimer les anciennes policies d'UPDATE permissives
DROP POLICY IF EXISTS "missions_update_own_or_admin" ON public.missions;
DROP POLICY IF EXISTS "missions_update_admin" ON public.missions;

-- Les administrateurs peuvent mettre à jour, mais le front devrait utiliser les RPC
CREATE POLICY "missions_update_admin_only_b1" ON public.missions
  FOR UPDATE
  TO authenticated
  USING (public.is_admin() OR public.is_operator())
  WITH CHECK (public.is_admin() OR public.is_operator());

-- Clients : UPDATE interdit (toute mutation via RPC admin ou transition)
-- Convoyeurs : UPDATE interdit (toute mutation via RPC transition)

-- SELECT conservé
DROP POLICY IF EXISTS "missions_select_own_or_admin" ON public.missions;
CREATE POLICY "missions_select_own_or_admin_b1" ON public.missions
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR public.is_operator()
    OR auth.uid() IS NULL
    OR (
      client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
      OR client_email = (auth.jwt() ->> 'email')
      OR convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
      OR status = 'available'
    )
  );

-- INSERT interdit sauf admin
DROP POLICY IF EXISTS "missions_insert_admin" ON public.missions;
CREATE POLICY "missions_insert_admin_b1" ON public.missions
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin() OR public.is_operator());

-- DELETE interdit
DROP POLICY IF EXISTS "missions_delete_admin" ON public.missions;
CREATE POLICY "missions_delete_admin_b1" ON public.missions
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- =========================================================
-- 9. CANDIDATURES : sécuriser l'insertion par UUID
-- =========================================================

-- RLS insert déjà restrictive : convoyeur_id appartenant au user.
-- On garde mais on supprime toute référence à convoyeur_nom comme identité.
DROP POLICY IF EXISTS "candidatures_insert_authenticated" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_select_own_or_admin" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_select_concerned" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_delete_concerned" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_delete_admin" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_update_concerned" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_update_admin" ON public.candidatures;

CREATE POLICY "candidatures_insert_own_b1" ON public.candidatures
  FOR INSERT
  TO authenticated
  WITH CHECK (
    convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
  );

CREATE POLICY "candidatures_select_own_or_admin_b1" ON public.candidatures
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
    OR mission_id IN (
      SELECT m.id FROM public.missions m
      WHERE m.client_id IN (SELECT cl.id FROM public.clients cl WHERE cl.auth_user_id = auth.uid())
         OR m.client_email = (auth.jwt() ->> 'email')
    )
  );

CREATE POLICY "candidatures_delete_admin_b1" ON public.candidatures
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

CREATE POLICY "candidatures_update_admin_b1" ON public.candidatures
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

COMMIT;
