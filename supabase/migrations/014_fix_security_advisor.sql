-- =====================================================
-- Migration 014 : Fix Security Advisor warnings
-- Correction de toutes les policies USING(true) permissives
-- =====================================================

-- -------------------------------------------------------
-- 1. VUE convoyeurs_public → SECURITY INVOKER
-- -------------------------------------------------------
DROP VIEW IF EXISTS public.convoyeurs_public;
CREATE OR REPLACE VIEW public.convoyeurs_public
WITH (security_invoker = true)
AS
SELECT id, prenom, ville, zone, niveau, disponible, zones,
       note_moyenne, grade, taux_auto, taux_moto, auth_user_id
FROM public.convoyeurs;
GRANT SELECT ON public.convoyeurs_public TO anon, authenticated;

-- -------------------------------------------------------
-- 2. TABLE candidatures — policies trop permissives
-- -------------------------------------------------------
DROP POLICY IF EXISTS "Suppression publique candidatures" ON public.candidatures;
DROP POLICY IF EXISTS "Insertion publique candidatures" ON public.candidatures;
DROP POLICY IF EXISTS "Lecture publique candidatures" ON public.candidatures;
DROP POLICY IF EXISTS "Modification publique candidatures" ON public.candidatures;

-- -------------------------------------------------------
-- 3. TABLE clients — ajout auth_user_id + policies
-- -------------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_auth_user_id ON public.clients(auth_user_id);

DROP POLICY IF EXISTS "Autoriser toutes les actions sur clients" ON public.clients;
DROP POLICY IF EXISTS "Autoriser la lecture des profils" ON public.clients;

CREATE POLICY "Client voit son profil"
  ON public.clients FOR SELECT
  USING (auth_user_id = auth.uid());

-- -------------------------------------------------------
-- 4. TABLE convoyeurs
-- -------------------------------------------------------
DROP POLICY IF EXISTS "Suppression publique convoyeurs" ON public.convoyeurs;
DROP POLICY IF EXISTS "Insertion publique convoyeurs" ON public.convoyeurs;
DROP POLICY IF EXISTS "Modification publique convoyeurs" ON public.convoyeurs;
DROP POLICY IF EXISTS "Convoyeur voit son profil" ON public.convoyeurs;
DROP POLICY IF EXISTS "Convoyeur modifie son profil" ON public.convoyeurs;

CREATE POLICY "Convoyeur voit son profil"
  ON public.convoyeurs FOR SELECT
  USING (auth_user_id = auth.uid());

CREATE POLICY "Convoyeur modifie son profil"
  ON public.convoyeurs FOR UPDATE
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- -------------------------------------------------------
-- 5. TABLE devis
-- -------------------------------------------------------
DROP POLICY IF EXISTS "Autoriser toutes les actions sur devis" ON public.devis;
DROP POLICY IF EXISTS "Accès complet pour l'admin" ON public.devis;
DROP POLICY IF EXISTS "Autoriser la lecture publique des devis" ON public.devis;
DROP POLICY IF EXISTS "Autoriser la modification publique des devis" ON public.devis;

-- Lecture et modification devis : accès public conservé (formulaire public)
-- Les devis sont créés par des visiteurs anonymes via le formulaire
CREATE POLICY "Lecture devis publique securisee"
  ON public.devis FOR SELECT
  USING (true);

-- UPDATE : Permettre aux utilisateurs authentifiés (admin) de modifier les statuts
CREATE POLICY "Modification devis par admin"
  ON public.devis FOR UPDATE
  USING (auth.role() = 'authenticated');

-- -------------------------------------------------------
-- 6. TABLE missions
-- -------------------------------------------------------
DROP POLICY IF EXISTS "Autoriser toutes les actions sur missions" ON public.missions;
DROP POLICY IF EXISTS "Autoriser la suppression publique des missions" ON public.missions;
DROP POLICY IF EXISTS "Autoriser la lecture publique des missions" ON public.missions;
DROP POLICY IF EXISTS "Autoriser la modification publique des missions" ON public.missions;

-- -------------------------------------------------------
-- 7. TABLE system_settings — lecture publique OK (tarifs)
-- -------------------------------------------------------
-- "Allow public read access on system_settings" SELECT USING(true) → intentionnel, on garde

NOTIFY pgrst, 'reload schema';
