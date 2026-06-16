-- =====================================================
-- Migration 010 : RLS sécurisé sur public.convoyeurs
-- Lecture publique restreinte : seuls nom/prénom/ville/statut
-- sont accessibles via une vue publique sécurisée.
-- Les données personnelles (email, tel, IBAN, mot_de_passe)
-- sont bloquées pour anon.
-- =====================================================

-- Supprimer les anciennes politiques permissives
DROP POLICY IF EXISTS "Lecture publique convoyeurs" ON public.convoyeurs;
DROP POLICY IF EXISTS "Insertion admin convoyeurs" ON public.convoyeurs;
DROP POLICY IF EXISTS "MAJ convoyeurs" ON public.convoyeurs;

-- S'assurer que RLS est activé
ALTER TABLE public.convoyeurs ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- SELECT : Bloqué pour anon (admin utilise service_role)
-- Le dashboard-convoyeur.html lit via service_role ou
-- via une vue publique limitée ci-dessous
-- -------------------------------------------------------
CREATE POLICY "Lecture convoyeurs bloquee anon"
  ON public.convoyeurs
  FOR SELECT
  USING (false);

-- -------------------------------------------------------
-- INSERT : Bloqué via anon, uniquement service_role (admin)
-- -------------------------------------------------------
CREATE POLICY "Insertion convoyeurs bloquee anon"
  ON public.convoyeurs
  FOR INSERT
  WITH CHECK (false);

-- -------------------------------------------------------
-- UPDATE : Autorisé (les convoyeurs n'ont pas Supabase Auth,
-- l'authentification se fait côté app via SHA-256.
-- La session convoyeur est validée avant tout appel update.
-- TODO : migrer vers Supabase Auth pour restreindre ici.
-- -------------------------------------------------------
CREATE POLICY "MAJ convoyeurs session app"
  ON public.convoyeurs
  FOR UPDATE
  USING (true);

-- -------------------------------------------------------
-- DELETE : Bloqué pour tout le monde via anon
-- -------------------------------------------------------
CREATE POLICY "Suppression convoyeurs bloquee"
  ON public.convoyeurs
  FOR DELETE
  USING (false);

-- -------------------------------------------------------
-- VUE PUBLIQUE : Expose uniquement les infos non-sensibles
-- pour le sélecteur de convoyeur dans le dashboard
-- -------------------------------------------------------
CREATE OR REPLACE VIEW public.convoyeurs_public AS
SELECT
  id,
  prenom,
  nom,
  ville,
  statut,
  note_moyenne,
  nombre_missions,
  grade,
  disponible,
  zones,
  type_permis
FROM public.convoyeurs
WHERE statut != 'inactif';

-- Permettre la lecture de la vue publique
GRANT SELECT ON public.convoyeurs_public TO anon, authenticated;

-- Recharger le cache du schéma
NOTIFY pgrst, 'reload schema';
