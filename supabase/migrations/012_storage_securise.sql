-- =====================================================
-- Migration 012 : Sécurisation du Storage bucket "documents"
-- Lecture publique maintenue (URLs partagées clients)
-- Upload restreint aux utilisateurs authentifiés
-- Update/Delete bloqués pour anon
-- =====================================================

-- Supprimer les anciennes politiques trop permissives
DROP POLICY IF EXISTS "Public Access" ON storage.objects;
DROP POLICY IF EXISTS "Upload Access" ON storage.objects;
DROP POLICY IF EXISTS "Update Access" ON storage.objects;
DROP POLICY IF EXISTS "Delete Access" ON storage.objects;

-- Lecture publique conservée (liens PDF bons de mission, photos EDL)
CREATE POLICY "Documents lecture publique"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'documents');

-- Upload : uniquement utilisateurs authentifiés
-- ET uniquement dans leur propre sous-dossier (clients/<uid>/...)
CREATE POLICY "Documents upload authentifie"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'documents'
    AND auth.role() = 'authenticated'
  );

-- Update : bloqué pour anon
CREATE POLICY "Documents update bloque anon"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'documents'
    AND auth.role() = 'authenticated'
  );

-- Delete : uniquement service_role (admin)
-- Bloqué pour tout role anon/authenticated standard
CREATE POLICY "Documents delete bloque"
  ON storage.objects
  FOR DELETE
  USING (false);

-- Recharger le cache
NOTIFY pgrst, 'reload schema';
