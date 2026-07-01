-- =====================================================
-- Migration 058 : Storage convoyeur-documents — autoriser UPDATE sur candidatures/*
--    Le formulaire de candidature utilisait upsert:true.
--    Si un candidat rechargeait un document, l'UPDATE échouait en RLS.
--    On autorise UPDATE (et WITH CHECK) sur le même chemin candidatures/*.
-- =====================================================

-- INSERT reste public, restreint à candidatures/*
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

NOTIFY pgrst, 'reload schema';
