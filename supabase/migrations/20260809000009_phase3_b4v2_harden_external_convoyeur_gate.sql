-- =========================================================
-- Phase 3 B4v2 — Hardening External Convoyeur Gate
-- =========================================================
-- Corrige le bypass identifié par C-SEC FINAL GATE :
--
-- Un client authentifié pouvait créer sa propre ligne dans
-- public.convoyeurs via convoyeurs_insert_own, obtenir par
-- défaut banned=false / statut='disponible' / disponible=true,
-- et être immédiatement reconnu comme convoyeur par les
-- policies réseau (reseau_posts, reseau_comments) alors que
-- external_convoyeurs_enabled = false.
--
-- Stratégie :
--   a) convoyeurs_insert_own : ajouter is_internal_user()
--      OR external_convoyeurs_enabled() au WITH CHECK.
--      Un utilisateur externe ne peut plus s'auto-inscrire
--      lorsque la feature est désactivée.
--   b) reseau_posts_select/insert_admin_or_convoyeur :
--      restreindre la branche convoyeur à
--      is_internal_user() OR external_convoyeurs_enabled().
--      Les admins conservent l'accès via la branche admin.
--   c) reseau_comments_select/insert_admin_or_convoyeur :
--      même traitement.
--
-- Ne modifie pas :
--   - convoyeurs_insert_admin (admin peut toujours créer)
--   - convoyeurs_select_own / convoyeurs_select_own_or_admin
--     (lecture de son propre profil, sans impact réseau)
--   - convoyeurs_update_own (édition de son propre profil,
--     sans impact réseau)
--   - missions_select_b3 (by design — missions available
--     sont lisibles par tout authenticated)
--   - candidatures (déjà protégé par candidatures_insert_b3v)
--   - RPC transitions (déjà protégés par feature flag)
-- =========================================================

BEGIN;

-- =========================================================
-- 1. CONVOYEURS_INSERT_OWN : bloquer auto-inscription externe
-- =========================================================

DROP POLICY IF EXISTS "convoyeurs_insert_own" ON public.convoyeurs;
CREATE POLICY "convoyeurs_insert_own" ON public.convoyeurs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth_user_id = auth.uid()
    AND (
      public.is_internal_user()
      OR public.external_convoyeurs_enabled()
    )
  );

-- =========================================================
-- 2. RESEAU_POSTS : restreindre branche convoyeur
-- =========================================================

DROP POLICY IF EXISTS "reseau_posts_select_admin_or_convoyeur" ON public.reseau_posts;
CREATE POLICY "reseau_posts_select_admin_or_convoyeur" ON public.reseau_posts
  FOR SELECT
  TO authenticated
  USING (
    -- Admin : toujours autorisé
    EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.auth_user_id = auth.uid()
        AND c.role = 'admin'
    )
    -- Convoyeur : uniquement si feature activée OU utilisateur interne
    OR (
      (public.is_internal_user() OR public.external_convoyeurs_enabled())
      AND EXISTS (
        SELECT 1 FROM public.convoyeurs v
        WHERE v.auth_user_id = auth.uid()
          AND v.banned = false
      )
    )
  );

DROP POLICY IF EXISTS "reseau_posts_insert_admin_or_convoyeur" ON public.reseau_posts;
CREATE POLICY "reseau_posts_insert_admin_or_convoyeur" ON public.reseau_posts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Admin : toujours autorisé
    EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.auth_user_id = auth.uid()
        AND c.role = 'admin'
    )
    -- Convoyeur : uniquement si feature activée OU utilisateur interne
    OR (
      (public.is_internal_user() OR public.external_convoyeurs_enabled())
      AND EXISTS (
        SELECT 1 FROM public.convoyeurs v
        WHERE v.auth_user_id = auth.uid()
          AND v.banned = false
      )
    )
  );

-- =========================================================
-- 3. RESEAU_COMMENTS : restreindre branche convoyeur
-- =========================================================

DROP POLICY IF EXISTS "reseau_comments_select_admin_or_convoyeur" ON public.reseau_comments;
CREATE POLICY "reseau_comments_select_admin_or_convoyeur" ON public.reseau_comments
  FOR SELECT
  TO authenticated
  USING (
    -- Admin : toujours autorisé
    EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.auth_user_id = auth.uid()
        AND c.role = 'admin'
    )
    -- Convoyeur : uniquement si feature activée OU utilisateur interne
    OR (
      (public.is_internal_user() OR public.external_convoyeurs_enabled())
      AND EXISTS (
        SELECT 1 FROM public.convoyeurs v
        WHERE v.auth_user_id = auth.uid()
          AND v.banned = false
      )
    )
  );

DROP POLICY IF EXISTS "reseau_comments_insert_admin_or_convoyeur" ON public.reseau_comments;
CREATE POLICY "reseau_comments_insert_admin_or_convoyeur" ON public.reseau_comments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Admin : toujours autorisé
    EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.auth_user_id = auth.uid()
        AND c.role = 'admin'
    )
    -- Convoyeur : uniquement si feature activée OU utilisateur interne
    OR (
      (public.is_internal_user() OR public.external_convoyeurs_enabled())
      AND EXISTS (
        SELECT 1 FROM public.convoyeurs v
        WHERE v.auth_user_id = auth.uid()
          AND v.banned = false
      )
    )
  );

COMMIT;
