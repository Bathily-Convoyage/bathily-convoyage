-- =====================================================
-- Migration: phase3_c22b2_mission_contact_and_external_select_gate
--
-- Objectifs :
--   1. Hardening RLS : gate externe sur la branche convoyeur
--      de missions_select_b3.
--   2. Suppression de la policy legacy missions_select_concerned
--      qui contourne le gate external_convoyeurs_enabled.
--   3. Création de la RPC get_mission_contact pour l'accès
--      ciblé au téléphone client par l'exécutant assigné.
--
-- Invariant : external_convoyeurs_enabled = false
-- =====================================================

BEGIN;

-- =========================================================
-- 1. HARDENING missions_select_b3 — GATE CONVOYEUR EXTERNE
-- =========================================================
-- La branche convoyeur_id IN (...) de missions_select_b3
-- autorisait un convoyeur assigné à lire la mission
-- sans vérifier is_internal_user() OR external_convoyeurs_enabled().
-- Un convoyeur externe assigné pouvait donc lire toutes les
-- colonnes (PII incluse) même avec le flag désactivé.
--
-- Correction : la branche convoyeur est désormais conditionnée par
-- is_internal_user() OR external_convoyeurs_enabled().
-- Les autres branches (admin, operator, client, available) sont
-- inchangées.
-- =========================================================

DROP POLICY IF EXISTS "missions_select_b3" ON public.missions;

CREATE POLICY "missions_select_b3" ON public.missions
  FOR SELECT
  TO authenticated
  USING (
    -- Admin : toujours autorisé
    public.is_admin()
    -- Operator interne : toujours autorisé (accès gestion global)
    OR public.is_operator()
    -- Client propriétaire via client_id
    OR client_id IN (
      SELECT c.id FROM public.clients c
      WHERE c.auth_user_id = auth.uid()
    )
    -- Client propriétaire via email JWT
    OR client_email = (auth.jwt() ->> 'email')
    -- Convoyeur assigné : uniquement si utilisateur interne
    -- OU feature flag activé
    OR (
      convoyeur_id IN (
        SELECT c.id FROM public.convoyeurs c
        WHERE c.auth_user_id = auth.uid()
      )
      AND (
        public.is_internal_user()
        OR public.external_convoyeurs_enabled()
      )
    )
    -- Mission disponible : uniquement si utilisateur interne
    -- OU feature flag activé
    OR (
      status = 'available'
      AND (
        public.is_internal_user()
        OR public.external_convoyeurs_enabled()
      )
    )
  );

-- =========================================================
-- 2. SUPPRESSION POLICY LEGACY missions_select_concerned
-- =========================================================
-- Cette policy du baseline original coexistait avec
-- missions_select_b3. Les policies PostgreSQL sont additives
-- (OR logique). missions_select_concerned autorisait :
--   client_id IN (SELECT ... WHERE auth_user_id = auth.uid())
--   OR convoyeur_id IN (SELECT ... WHERE auth_user_id = auth.uid())
--
-- Sans aucun gate sur is_internal_user() ou
-- external_convoyeurs_enabled(), elle permettait à un
-- convoyeur externe assigné de contourner le feature flag
-- et de lire toutes les colonnes de sa mission (PII incluse).
--
-- missions_select_b3 couvre déjà les mêmes cas (client_id,
-- convoyeur_id) AVEC le gate externe. La policy legacy est
-- donc redondante ET dangereuse.
--
-- Suppression justifiée : éliminer le contournement du gate.
-- =========================================================

DROP POLICY IF EXISTS "missions_select_concerned" ON public.missions;

-- =========================================================
-- 3. RPC get_mission_contact
-- =========================================================
-- Retourne uniquement missions.client_telephone pour
-- l'exécutant interne assigné à la mission.
--
-- Autorisation :
--   is_operator() = true
--   AND is_convoyeur_for_mission(p_mission_id, auth.uid()) = true
--
-- Refus pour :
--   - operator non assigné
--   - admin (utilise dashboard-admin.html)
--   - client
--   - convoyeur externe (même assigné)
--   - anonymous
--
-- Anti-énumération :
--   Mission inexistante, mission non assignée, caller non
--   autorisé → même erreur générique 42501.
--
-- Retour :
--   TABLE(client_telephone text) — un seul champ, rien d'autre.
--   Valeur NULL possible si aucun téléphone enregistré.
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_mission_contact(p_mission_id uuid)
RETURNS TABLE(client_telephone text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _phone text;
  _authorized boolean;
BEGIN
  -- Vérifier l'autorisation sans révéler si la mission existe
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(p_mission_id, auth.uid()))
  INTO _authorized;

  IF COALESCE(_authorized, false) = false THEN
    RAISE EXCEPTION 'Non autorisé ou contact indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- Récupérer uniquement le téléphone snapshot
  SELECT m.client_telephone
  INTO _phone
  FROM public.missions m
  WHERE m.id = p_mission_id;

  -- Si la mission n'existe pas (ne devrait pas arriver si
  -- is_convoyeur_for_mission a retourné true), réponse générique
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé ou contact indisponible'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT _phone;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_mission_contact(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_mission_contact(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_mission_contact(uuid) TO authenticated;

COMMIT;
