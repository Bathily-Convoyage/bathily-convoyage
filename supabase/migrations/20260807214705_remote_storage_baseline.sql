-- =====================================================
-- BASELINE STORAGE — Policies RLS personnalisées
-- Snapshot exact de production (pg_policies) au 2026-08-08.
-- 13 policies sur storage.objects pour 3 buckets.
--
-- IMPORTANT :
--   Ce fichier ne contient QUE les policies RLS sur storage.objects.
--   Aucun DML sur storage.buckets (les buckets sont des données,
--   gérés séparément via config.toml ou seeding).
--   Aucun objet interne Supabase n'est recréé.
--
-- Buckets concernés par les policies :
--   documents
--   convoyeur-documents
--   convoyeur-media
--
-- Le durcissement Storage (passage en privé, MIME, limites,
-- URLs signées) fera l'objet d'une migration séparée.
-- =====================================================

-- =====================================================
-- BUCKET : documents (4 policies)
-- =====================================================

-- SELECT : public (URLs de documents partagés avec les clients)
DROP POLICY IF EXISTS "Documents lecture publique" ON storage.objects;
CREATE POLICY "Documents lecture publique"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'documents');

-- INSERT : authenticated uniquement
DROP POLICY IF EXISTS "Documents upload authentifie" ON storage.objects;
CREATE POLICY "Documents upload authentifie"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'documents'
    AND auth.role() = 'authenticated'
  );

-- UPDATE : authenticated uniquement
DROP POLICY IF EXISTS "Documents update bloque anon" ON storage.objects;
CREATE POLICY "Documents update bloque anon"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'documents'
    AND auth.role() = 'authenticated'
  );

-- DELETE : bloqué (admin via service_role)
DROP POLICY IF EXISTS "Documents delete bloque" ON storage.objects;
CREATE POLICY "Documents delete bloque"
  ON storage.objects
  FOR DELETE
  USING (false);

-- =====================================================
-- BUCKET : convoyeur-documents (5 policies)
-- =====================================================

-- INSERT : authentifié ET anonyme, uniquement dans candidatures/* (upload de candidature)
DROP POLICY IF EXISTS "convoyeur_docs_insert_public" ON storage.objects;
CREATE POLICY "convoyeur_docs_insert_public"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'convoyeur-documents'
    AND name ILIKE 'candidatures/%'
  );

-- UPDATE : anonyme/authentifié, uniquement dans candidatures/* (ré-upload de candidature)
DROP POLICY IF EXISTS "convoyeur_docs_update_public" ON storage.objects;
CREATE POLICY "convoyeur_docs_update_public"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'convoyeur-documents'
    AND name ILIKE 'candidatures/%'
  )
  WITH CHECK (
    bucket_id = 'convoyeur-documents'
    AND name ILIKE 'candidatures/%'
  );

-- UPDATE : admin uniquement
DROP POLICY IF EXISTS "convoyeur_docs_update_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_update_admin"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

-- SELECT : admin uniquement (lecture des documents de candidature)
DROP POLICY IF EXISTS "convoyeur_docs_select_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_select_admin"
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

-- DELETE : admin uniquement
DROP POLICY IF EXISTS "convoyeur_docs_delete_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_delete_admin"
  ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

-- =====================================================
-- BUCKET : convoyeur-media (4 policies)
-- =====================================================

-- INSERT : candidatures anonymes ou authentifiées (inscription publique)
DROP POLICY IF EXISTS "convoyeur_media_insert_candidatures" ON storage.objects;
CREATE POLICY "convoyeur_media_insert_candidatures"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'convoyeur-media'
    AND (name ILIKE 'candidatures/%')
  );

-- INSERT : missions (convoyeur authentifié ou admin)
DROP POLICY IF EXISTS "convoyeur_media_insert_missions" ON storage.objects;
CREATE POLICY "convoyeur_media_insert_missions"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'convoyeur-media'
    AND (name ILIKE 'missions/%')
    AND (auth.role() = 'authenticated')
  );

-- UPDATE : admin uniquement
DROP POLICY IF EXISTS "convoyeur_media_update_admin" ON storage.objects;
CREATE POLICY "convoyeur_media_update_admin"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
  );

-- DELETE : admin uniquement
DROP POLICY IF EXISTS "convoyeur_media_delete_admin" ON storage.objects;
CREATE POLICY "convoyeur_media_delete_admin"
  ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
  );

NOTIFY pgrst, 'reload schema';
