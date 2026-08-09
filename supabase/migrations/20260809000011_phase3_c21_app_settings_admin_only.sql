-- =========================================================
-- Phase 3 C-2.1 — app_settings UPDATE restreint à is_admin()
-- =========================================================
-- Décision d'architecture n°2 (C-2.1) :
--
-- La policy app_settings_update_b3v accordait l'UPDATE à
-- (is_admin() OR is_operator()). Un operator pouvait ainsi
-- théoriquement modifier external_convoyeurs_enabled et
-- activer les convoyeurs externes, ce qui violerait
-- l'invariant absolu du projet.
--
-- Correction :
--   - SELECT conservé pour is_admin() OR is_operator()
--     (lecture interne nécessaire au fonctionnement du
--      feature flag côté frontend/edge functions).
--   - UPDATE restreint à is_admin() uniquement.
--   - Aucune modification de la valeur actuelle du flag
--     external_convoyeurs_enabled.
--   - Aucune donnée distante touchée par cette migration.
--
-- Test obligatoire :
--   Un operator authentifié tentant :
--     UPDATE app_settings SET value = 'true'
--       WHERE key = 'external_convoyeurs_enabled';
--   doit être refusé par PostgreSQL/RLS (42501).
--   Un admin conserve la capacité d'administration.
-- =========================================================

BEGIN;

-- =========================================================
-- 1. SELECT conservé pour utilisateurs internes
-- =========================================================
-- La lecture reste accessible à admin et operator afin que
-- le frontend et les edge functions puissent consulter le
-- feature flag. Aucun élargissement.

DROP POLICY IF EXISTS "app_settings_select_b3v" ON public.app_settings;
CREATE POLICY "app_settings_select_c21" ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (public.is_admin() OR public.is_operator());

-- =========================================================
-- 2. UPDATE restreint à is_admin() uniquement
-- =========================================================
-- Retire la branche is_operator() de la policy UPDATE.
-- Un operator ne peut plus modifier app_settings, en
-- particulier external_convoyeurs_enabled.

DROP POLICY IF EXISTS "app_settings_update_b3v" ON public.app_settings;
CREATE POLICY "app_settings_update_c21" ON public.app_settings
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- =========================================================
-- 3. VÉRIFICATIONS TRANSACTIONNELLES
-- =========================================================

DO $verify$
BEGIN
  -- 3.1 RLS toujours activée sur app_settings
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'app_settings'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on app_settings'
      USING ERRCODE = 'P0001';
  END IF;

  -- 3.2 Policy UPDATE existe et est restreinte à is_admin()
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.app_settings'::regclass
      AND polname = 'app_settings_update_c21'
  ) THEN
    RAISE EXCEPTION 'app_settings_update_c21 policy not created'
      USING ERRCODE = 'P0001';
  END IF;

  -- 3.3 L'ancienne policy b3v ne doit plus exister
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.app_settings'::regclass
      AND polname = 'app_settings_update_b3v'
  ) THEN
    RAISE EXCEPTION 'app_settings_update_b3v policy still exists — drop failed'
      USING ERRCODE = 'P0001';
  END IF;

  -- 3.4 Le flag external_convoyeurs_enabled reste présent
  IF NOT EXISTS (
    SELECT 1 FROM public.app_settings WHERE key = 'external_convoyeurs_enabled'
  ) THEN
    RAISE EXCEPTION 'external_convoyeurs_enabled key missing from app_settings'
      USING ERRCODE = 'P0001';
  END IF;
END $verify$;

COMMIT;
