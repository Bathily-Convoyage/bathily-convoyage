-- =====================================================
-- Migration 057 : Permettre l'insertion anonyme de tickets
--    depuis le formulaire de contact public
-- =====================================================

DROP POLICY IF EXISTS "tickets_insert_authenticated" ON public.support_tickets;
DROP POLICY IF EXISTS "tickets_insert_public" ON public.support_tickets;

-- Policy INSERT : anon et authenticated peuvent insérer
CREATE POLICY "tickets_insert_public"
  ON public.support_tickets FOR INSERT TO anon, authenticated
  WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
