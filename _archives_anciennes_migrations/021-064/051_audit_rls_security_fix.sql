-- =====================================================
-- Migration 051 : Audit RLS — Sécurisation complète
--    Basé sur l'audit Supabase AI
--    1. Serrer les INSERT policies "WITH CHECK true"
--    2. Révoquer EXECUTE sur fonctions SECURITY DEFINER pour anon
-- =====================================================

-- =========================================================
-- 1) INSERT policies : empêcher le forge d'ownership
-- =========================================================

-- --- clients : anon peut s'inscrire mais ne peut pas choisir auth_user_id ni role=admin
DROP POLICY IF EXISTS "Autoriser insertion inscription client" ON public.clients;
DROP POLICY IF EXISTS "clients_insert_public" ON public.clients;
CREATE POLICY "clients_insert_public_safe"
  ON public.clients
  FOR INSERT
  TO anon
  WITH CHECK (
    auth_user_id IS NULL
    AND role IS DISTINCT FROM 'admin'
  );

-- --- convoyeurs : anon peut candidater mais pas choisir auth_user_id ni banned=true
DROP POLICY IF EXISTS "Autoriser insertion inscription convoyeur" ON public.convoyeurs;
CREATE POLICY "convoyeurs_insert_public_safe"
  ON public.convoyeurs
  FOR INSERT
  TO anon
  WITH CHECK (
    auth_user_id IS NULL
    AND banned IS DISTINCT FROM true
  );

-- --- convoyeur_candidatures : insert public sans restriction (pas de colonne convoyeur_id)
--    On garde WITH CHECK (true) car cette table ne contient pas de lien d'ownership.
--    La table est en lecture admin uniquement.
DROP POLICY IF EXISTS "candidatures_conv_insert_public" ON public.convoyeur_candidatures;
CREATE POLICY "candidatures_conv_insert_public_safe"
  ON public.convoyeur_candidatures
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- --- devis : anon peut soumettre un devis mais sans client_id forgeable
DROP POLICY IF EXISTS "devis_insert_public" ON public.devis;
CREATE POLICY "devis_insert_public_safe"
  ON public.devis
  FOR INSERT
  TO anon
  WITH CHECK (
    client_id IS NULL
    AND client_email IS NOT NULL
  );

-- --- avis : anon peut laisser un avis mais sans user_id forgeable
DROP POLICY IF EXISTS "avis_insert_public" ON public.avis;
CREATE POLICY "avis_insert_public_safe"
  ON public.avis
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    user_id IS NULL
    AND auteur_email IS NOT NULL
  );

-- --- newsletter_subscribers : insert public, email obligatoire
DROP POLICY IF EXISTS "newsletter_insert_public" ON public.newsletter_subscribers;
CREATE POLICY "newsletter_insert_public_safe"
  ON public.newsletter_subscribers
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    email IS NOT NULL
  );

-- =========================================================
-- 2) RPC SECURITY DEFINER : révoquer EXECUTE pour anon
-- =========================================================

REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin_by_email(text) FROM anon;

-- Fonctions internes (triggers) — pas appelables par RPC mais on sécurise
REVOKE EXECUTE ON FUNCTION public.auto_link_missions_to_client() FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_clients_auth_user_id() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_clients_auth_user_id_on_update() FROM anon;

NOTIFY pgrst, 'reload schema';
