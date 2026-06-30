-- =====================================================
-- Migration 050 : Storage convoyeur-documents — upload anonyme
--    Le formulaire de candidature convoyeur est public.
--    Les candidats uploadent avant d'avoir un compte.
--    On autorise INSERT en anon avec restriction au chemin candidatures/*.
-- =====================================================

-- Conserver le bucket privé
INSERT INTO storage.buckets (id, name, public)
VALUES ('convoyeur-documents', 'convoyeur-documents', false)
ON CONFLICT (id) DO NOTHING;

-- INSERT : authentifié ET anonyme, uniquement dans candidatures/* (upload de candidature)
DROP POLICY IF EXISTS "convoyeur_docs_insert_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_docs_insert_anon" ON storage.objects;
CREATE POLICY "convoyeur_docs_insert_public"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'convoyeur-documents'
    AND (name ILIKE 'candidatures/%')
  );

-- SELECT/UPDATE/DELETE restent admin
DROP POLICY IF EXISTS "convoyeur_docs_select_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_select_admin"
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

DROP POLICY IF EXISTS "convoyeur_docs_update_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_update_admin"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

DROP POLICY IF EXISTS "convoyeur_docs_delete_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_delete_admin"
  ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

NOTIFY pgrst, 'reload schema';
