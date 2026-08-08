-- =====================================================
-- Migration: phase2_prepare_private_storage
-- Timestamp: 20260808140449
-- =====================================================
-- Objectifs :
-- 1. Préparer les policies RLS du bucket convoyeur-media
--    pour le futur passage en privé, sans modifier le flag public.
-- 2. Supprimer l'overwrite public sur convoyeur-documents.
-- 3. Conserver l'upload public de premier envoi candidature.
-- 4. Ajouter les roles cibles admin / operator / concerned.
--
-- Aucune modification de storage.buckets.public
-- Aucune suppression, déplacement ou renommage d'objet
-- =====================================================

BEGIN;

-- =====================================================
-- BUCKET : convoyeur-media
-- =====================================================

DROP POLICY IF EXISTS "convoyeur_media_insert_candidatures" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_media_insert_missions" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_media_update_admin" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_media_delete_admin" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_media_select_admin" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_media_select_operator" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_media_select_mission_concerned" ON storage.objects;

-- SELECT : admin
CREATE POLICY "convoyeur_media_select_admin"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
  );

-- SELECT : operator
CREATE POLICY "convoyeur_media_select_operator"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'convoyeur-media'
    AND public.is_operator()
  );

-- SELECT : client ou convoyeur concerné par la mission
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
          m.client_id IN (
            SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid()
          )
          OR m.convoyeur_id IN (
            SELECT cv.id FROM public.convoyeurs cv WHERE cv.auth_user_id = auth.uid()
          )
        )
    )
  );

-- INSERT : candidatures publiques
CREATE POLICY "convoyeur_media_insert_candidatures"
  ON storage.objects
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    bucket_id = 'convoyeur-media'
    AND name ILIKE 'candidatures/%'
  );

-- INSERT : missions par le convoyeur affecté, admin ou operator
CREATE POLICY "convoyeur_media_insert_missions"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'convoyeur-media'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.missions m
        WHERE m.id::text = split_part(name, '/', 2)
          AND m.convoyeur_id IN (
            SELECT cv.id FROM public.convoyeurs cv WHERE cv.auth_user_id = auth.uid()
          )
      )
    )
  );

-- UPDATE : admin uniquement
CREATE POLICY "convoyeur_media_update_admin"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
  )
  WITH CHECK (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
  );

-- DELETE : admin uniquement
CREATE POLICY "convoyeur_media_delete_admin"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
  );

-- =====================================================
-- BUCKET : convoyeur-documents
-- =====================================================

DROP POLICY IF EXISTS "convoyeur_docs_insert_public" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_docs_update_public" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_docs_update_admin" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_docs_select_admin" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_docs_delete_admin" ON storage.objects;

-- INSERT : candidatures publiques
CREATE POLICY "convoyeur_docs_insert_public"
  ON storage.objects
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    bucket_id = 'convoyeur-documents'
    AND name ILIKE 'candidatures/%'
  );

-- SELECT : admin
CREATE POLICY "convoyeur_docs_select_admin"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

-- UPDATE : admin uniquement (suppression de l'overwrite public)
CREATE POLICY "convoyeur_docs_update_admin"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  )
  WITH CHECK (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

-- DELETE : admin uniquement
CREATE POLICY "convoyeur_docs_delete_admin"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
