-- =====================================================
-- Migration: C-2.3C — Remaining External Convoyeur RLS/Storage Gates
-- Timestamp: 20260812300000
-- =====================================================
-- Objectif :
--   Ajouter le gate is_internal_user() OR external_convoyeurs_enabled()
--   sur la branche convoyeur assigné des 4 dernières policies
--   qui utilisent l'assignation convoyeur via sous-requête
--   (contournant la RLS de missions).
--
--   Les branches client et admin restent strictement inchangées.
--
-- Policies modifiées :
--   1. storage.objects → convoyeur_media_insert_missions_b2v (INSERT)
--   2. public.edls → edls_select_client_b2 (SELECT)
--   3. public.mission_events → mission_events_convoyeur_select_b2 (SELECT)
--   4. public.mission_evidence → mission_evidence_select_client_b2 (SELECT)
--
-- Ne modifie : aucune fonction, aucun RPC, aucun frontend, aucune autre policy.
-- =====================================================

BEGIN;

-- =====================================================
-- 1. storage.objects → convoyeur_media_insert_missions_b2v
--    INSERT : admin OU (convoyeur assigné AND gate externe)
-- =====================================================

DROP POLICY IF EXISTS "convoyeur_media_insert_missions_b2v" ON storage.objects;

CREATE POLICY "convoyeur_media_insert_missions_b2v" ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'convoyeur-media'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND (
      public.is_admin()
      OR (
        EXISTS (
          SELECT 1
          FROM public.missions m
          JOIN public.convoyeurs cv ON cv.id = m.convoyeur_id
          WHERE (m.id)::text = split_part(objects.name, '/'::text, 2)
            AND cv.auth_user_id = auth.uid()
        )
        AND (public.is_internal_user() OR public.external_convoyeurs_enabled())
      )
    )
  );

-- =====================================================
-- 2. public.edls → edls_select_client_b2
--    SELECT : admin OU client concerné OU (convoyeur assigné AND gate externe)
-- =====================================================

DROP POLICY IF EXISTS "edls_select_client_b2" ON public.edls;

CREATE POLICY "edls_select_client_b2" ON public.edls
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = edls.mission_id
        AND (
          m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
          OR m.client_email = (auth.jwt() ->> 'email')
        )
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.missions m
        JOIN public.convoyeurs c ON c.id = m.convoyeur_id
        WHERE m.id = edls.mission_id AND c.auth_user_id = auth.uid()
      )
      AND (public.is_internal_user() OR public.external_convoyeurs_enabled())
    )
  );

-- =====================================================
-- 3. public.mission_events → mission_events_convoyeur_select_b2
--    SELECT : admin OU (convoyeur assigné AND gate externe)
--    (pas de branche client sur cette policy — la policy
--     mission_events_client_select_b2 gère les clients séparément)
-- =====================================================

DROP POLICY IF EXISTS "mission_events_convoyeur_select_b2"
  ON public.mission_events;

CREATE POLICY "mission_events_convoyeur_select_b2"
  ON public.mission_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR (
      EXISTS (
        SELECT 1 FROM public.missions m
        WHERE m.id = mission_events.mission_id
          AND m.convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
      )
      AND (public.is_internal_user() OR public.external_convoyeurs_enabled())
    )
  );

-- =====================================================
-- 4. public.mission_evidence → mission_evidence_select_client_b2
--    SELECT : admin OU client concerné OU (convoyeur assigné AND gate externe)
-- =====================================================

DROP POLICY IF EXISTS "mission_evidence_select_client_b2" ON public.mission_evidence;

CREATE POLICY "mission_evidence_select_client_b2" ON public.mission_evidence
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_evidence.mission_id
        AND (
          m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
          OR m.client_email = (auth.jwt() ->> 'email')
        )
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.missions m
        JOIN public.convoyeurs c ON c.id = m.convoyeur_id
        WHERE m.id = mission_evidence.mission_id AND c.auth_user_id = auth.uid()
      )
      AND (public.is_internal_user() OR public.external_convoyeurs_enabled())
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
