-- =====================================================
-- Migration 063 : Storage pour les médias convoyeur
--    Bucket public pour les selfies, vidéos de présentation
--    et photos de fin de mission.
-- =====================================================

-- Créer le bucket public
INSERT INTO storage.buckets (id, name, public)
VALUES ('convoyeur-media', 'convoyeur-media', true)
ON CONFLICT (id) DO NOTHING;

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

-- SELECT : public car bucket public (URLs non devinables)
-- Aucune policy SELECT nécessaire pour un bucket public

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
