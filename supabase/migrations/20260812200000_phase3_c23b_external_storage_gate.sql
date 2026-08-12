-- =====================================================
-- Migration: C-2.3B — External Storage SELECT Gate
-- Timestamp: 20260812200000
-- =====================================================
-- Objectif :
--   Ajouter le gate externe is_internal_user() OR external_convoyeurs_enabled()
--   uniquement sur la branche convoyeur assigné de la policy
--   convoyeur_media_select_mission_concerned.
--
--   La branche client concerné reste strictement inchangée.
--
-- Logique après migration :
--   client_concerné
--   OU
--   (convoyeur_assigné AND (is_internal_user() OR external_convoyeurs_enabled()))
--
-- Préserve toutes les autres policies du bucket convoyeur-media.
-- Ne modifie aucune fonction, aucun RPC, aucun frontend.
-- =====================================================

BEGIN;

-- =====================================================
-- 1. Remplacer la policy convoyeur_media_select_mission_concerned
-- =====================================================

DROP POLICY IF EXISTS "convoyeur_media_select_mission_concerned" ON storage.objects;

CREATE POLICY "convoyeur_media_select_mission_concerned"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'convoyeur-media'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND EXISTS (
      SELECT 1
      FROM public.missions m
      WHERE m.id::text = split_part(name, '/', 2)
        AND (
          -- Branche client concerné : inchangée, pas de gate externe
          m.client_id IN (
            SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid()
          )
          -- Branche convoyeur assigné : gate externe ajouté (C-2.3B)
          OR (
            m.convoyeur_id IN (
              SELECT cv.id FROM public.convoyeurs cv WHERE cv.auth_user_id = auth.uid()
            )
            AND (public.is_internal_user() OR public.external_convoyeurs_enabled())
          )
        )
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
