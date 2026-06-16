-- =====================================================
-- Migration 009 : RLS sécurisé sur public.missions
-- Clients voient leurs missions via Supabase Auth
-- Convoyeurs voient les missions qui leur sont assignées
-- Admin utilise service_role (bypass RLS total)
-- =====================================================

-- Supprimer les anciennes politiques permissives
DROP POLICY IF EXISTS "Lecture publique missions" ON public.missions;
DROP POLICY IF EXISTS "Insertion missions" ON public.missions;
DROP POLICY IF EXISTS "MAJ missions" ON public.missions;
DROP POLICY IF EXISTS "DELETE missions" ON public.missions;

-- S'assurer que RLS est activé
ALTER TABLE public.missions ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- SELECT : Un client authentifié voit UNIQUEMENT ses missions
-- (via la relation client_id = id dans la table clients
--  où l'email correspond à auth.email())
-- -------------------------------------------------------
CREATE POLICY "Client voit ses missions"
  ON public.missions
  FOR SELECT
  USING (
    client_id IN (
      SELECT id FROM public.clients WHERE email = auth.email()
    )
  );

-- -------------------------------------------------------
-- SELECT : Un convoyeur voit les missions qui lui sont assignées
-- (via la relation convoyeur_id = id dans la table convoyeurs
--  où l'email correspond à auth.email())
-- Note : les convoyeurs n'utilisent pas encore Supabase Auth
-- cette politique est prête pour la migration future
-- -------------------------------------------------------
CREATE POLICY "Convoyeur voit ses missions assignees"
  ON public.missions
  FOR SELECT
  USING (
    convoyeur_id IN (
      SELECT id FROM public.convoyeurs WHERE email = auth.email()
    )
  );

-- -------------------------------------------------------
-- INSERT : Seuls les utilisateurs authentifiés peuvent créer
-- une mission (le devis.html crée via service_role en pratique)
-- -------------------------------------------------------
CREATE POLICY "Insertion mission authentifiee"
  ON public.missions
  FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- -------------------------------------------------------
-- UPDATE : Seul le client propriétaire peut modifier sa mission
-- (ex: annulation). L'admin utilise service_role.
-- -------------------------------------------------------
CREATE POLICY "Client modifie ses missions"
  ON public.missions
  FOR UPDATE
  USING (
    client_id IN (
      SELECT id FROM public.clients WHERE email = auth.email()
    )
  );

-- -------------------------------------------------------
-- DELETE : Bloqué pour tout le monde via anon/authenticated
-- Seul le service_role (admin) peut supprimer
-- -------------------------------------------------------
CREATE POLICY "Suppression missions bloquee"
  ON public.missions
  FOR DELETE
  USING (false);

-- Recharger le cache du schéma
NOTIFY pgrst, 'reload schema';
