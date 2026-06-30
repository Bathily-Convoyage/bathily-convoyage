-- =====================================================
-- Migration 049 : Audit RLS — Fix newsletter_subscribers
--    Restreint l'UPDATE newsletter aux admins ou au propriétaire
-- =====================================================

-- L'ancienne policy permettait à tout anon/authenticated de modifier N'IMPORTE QUEL email
DROP POLICY IF EXISTS "newsletter_update_public" ON public.newsletter_subscribers;

-- Nouvelle policy : l'utilisateur peut seulement modifier son propre email (via l'email stocké)
CREATE POLICY "newsletter_update_own"
  ON public.newsletter_subscribers
  FOR UPDATE
  TO authenticated
  USING (email = (auth.jwt() ->> 'email'))
  WITH CHECK (email = (auth.jwt() ->> 'email'));

-- Admin peut tout modifier
CREATE POLICY "newsletter_update_admin"
  ON public.newsletter_subscribers
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

NOTIFY pgrst, 'reload schema';
