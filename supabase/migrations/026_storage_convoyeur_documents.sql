-- =====================================================
-- Migration 026 : Policies RLS pour le bucket "convoyeur-documents"
--    Permet aux candidats authentifiés d'uploader
--    et à l'admin de lire/télécharger les documents
-- =====================================================

-- 1. Créer le bucket s'il n'existe pas
INSERT INTO storage.buckets (id, name, public)
VALUES ('convoyeur-documents', 'convoyeur-documents', false)
ON CONFLICT (id) DO NOTHING;

-- 2. SELECT : admin uniquement (lecture des documents de candidature)
DROP POLICY IF EXISTS "convoyeur_docs_select_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_select_admin"
  ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

-- 3. INSERT : utilisateurs authentifiés (candidats qui uploadent leurs documents)
DROP POLICY IF EXISTS "convoyeur_docs_insert_authenticated" ON storage.objects;
CREATE POLICY "convoyeur_docs_insert_authenticated"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'convoyeur-documents'
    AND auth.role() = 'authenticated'
  );

-- 4. UPDATE : admin uniquement
DROP POLICY IF EXISTS "convoyeur_docs_update_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_update_admin"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

-- 5. DELETE : admin uniquement
DROP POLICY IF EXISTS "convoyeur_docs_delete_admin" ON storage.objects;
CREATE POLICY "convoyeur_docs_delete_admin"
  ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'convoyeur-documents'
    AND public.is_admin()
  );

NOTIFY pgrst, 'reload schema';
