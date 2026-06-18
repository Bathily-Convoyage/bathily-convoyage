-- =====================================================
-- Migration 017 : Fix RLS pour la connexion admin
-- Problème : Un utilisateur authentifié ne peut pas lire
--            son propre profil si auth_user_id est NULL.
--            La politique "Lecture bloquée anon" USING(false)
--            bloque aussi les utilisateurs authentifiés sans
--            auth_user_id renseigné.
-- Solution : Ajouter une politique permettant à un user
--            authentifié de lire son propre profil via email.
-- =====================================================

-- Supprimer les anciennes politiques de lecture sur clients
DROP POLICY IF EXISTS "Lecture bloquée anon" ON public.clients;
DROP POLICY IF EXISTS "Client voit son profil" ON public.clients;

-- Nouvelle politique unique : un utilisateur authentifié peut lire
-- son propre profil, identifié par auth_user_id OU par email.
-- Cela permet la connexion admin même si auth_user_id n'est pas renseigné.
CREATE POLICY "Utilisateur authentifié lit son profil"
  ON public.clients FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND (
      auth_user_id = auth.uid()
      OR email = (auth.jwt()->>'email')
    )
  );

NOTIFY pgrst, 'reload schema';
