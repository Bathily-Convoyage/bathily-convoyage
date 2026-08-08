-- =====================================================
-- Migration 056 : Fix policy avis_insert pour permettre
--    user_id non-NULL pour les utilisateurs authentifiés
-- =====================================================

DROP POLICY IF EXISTS "avis_insert_public_safe" ON public.avis;

-- Policy pour anon : user_id doit être NULL (pas de forge)
CREATE POLICY "avis_insert_anon_safe"
  ON public.avis FOR INSERT TO anon
  WITH CHECK (user_id IS NULL AND auteur_email IS NOT NULL);

-- Policy pour authenticated : user_id peut être auth.uid() ou NULL
CREATE POLICY "avis_insert_auth_safe"
  ON public.avis FOR INSERT TO authenticated
  WITH CHECK ((user_id IS NULL OR user_id = auth.uid()) AND auteur_email IS NOT NULL);

NOTIFY pgrst, 'reload schema';
