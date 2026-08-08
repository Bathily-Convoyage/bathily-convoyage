-- =====================================================
-- Migration: phase3_b1v2_workflow_hardening
-- Objectif : durcir operator UPDATE direct et rendre mission_events immuable
-- =====================================================

BEGIN;

-- =========================================================
-- 1. RETIRER operator des UPDATE directs de missions
-- =========================================================

DROP POLICY IF EXISTS "missions_update_admin_only_b1" ON public.missions;

CREATE POLICY "missions_update_admin_only_b2" ON public.missions
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- =========================================================
-- 2. TRIGGER missions : interdire tout UPDATE non-DBA sur champs sensibles
-- =========================================================

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

  -- Le statut, le convoyeur et l'identité client ne peuvent être modifiés
  -- que par les RPC métiers, même pour un admin.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Le statut ne peut être modifié que via transition_mission_status()'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.convoyeur_id IS DISTINCT FROM OLD.convoyeur_id
     OR NEW.convoyeur_nom IS DISTINCT FROM OLD.convoyeur_nom THEN
    RAISE EXCEPTION 'Le convoyeur ne peut être modifié que via admin_assign_mission()'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.client_email IS DISTINCT FROM OLD.client_email THEN
    RAISE EXCEPTION 'L''identité client ne peut pas être modifiée directement'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'La référence mission ne peut pas être modifiée directement'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.paiement_statut IS DISTINCT FROM OLD.paiement_statut
     OR NEW.stripe_session_id IS DISTINCT FROM OLD.stripe_session_id THEN
    RAISE EXCEPTION 'Le paiement ne peut pas être modifié directement'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- =========================================================
-- 3. RENDRE mission_events IMMUABLE
-- =========================================================

-- Supprimer l'ancienne policy permissive ALL
DROP POLICY IF EXISTS "mission_events_admin_all" ON public.mission_events;

-- Un trigger inconditionnel : aucun UPDATE/DELETE applicatif
CREATE OR REPLACE FUNCTION public.mission_events_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'mission_events est strictement append-only : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS mission_events_protect_trigger ON public.mission_events;
CREATE TRIGGER mission_events_protect_trigger
  BEFORE UPDATE OR DELETE ON public.mission_events
  FOR EACH ROW
  EXECUTE FUNCTION public.mission_events_protect();

-- RLS : admin et clients/convoyeurs concernés peuvent LIRE
DROP POLICY IF EXISTS "mission_events_client_select" ON public.mission_events;
DROP POLICY IF EXISTS "mission_events_convoyeur_select" ON public.mission_events;

CREATE POLICY "mission_events_client_select_b2"
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

CREATE POLICY "mission_events_convoyeur_select_b2"
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

-- Aucun INSERT/UPDATE/DELETE applicatif. L'INSERT se fait via log_mission_event (SECURITY DEFINER postgres).
REVOKE ALL ON public.mission_events FROM PUBLIC;
REVOKE ALL ON public.mission_events FROM anon;
REVOKE ALL ON public.mission_events FROM authenticated;
GRANT SELECT ON public.mission_events TO authenticated;
GRANT ALL ON public.mission_events TO postgres;

COMMIT;
