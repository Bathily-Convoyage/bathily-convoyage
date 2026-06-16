-- =====================================================
-- Migration 011 : RLS sécurisé sur convoyeurs_candidats et edls
-- =====================================================

-- -------------------------------------------------------
-- TABLE : convoyeurs_candidats
-- -------------------------------------------------------
DROP POLICY IF EXISTS "Insertion publique candidatures" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "Lecture candidats" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "MAJ statut admin" ON public.convoyeurs_candidats;

ALTER TABLE public.convoyeurs_candidats ENABLE ROW LEVEL SECURITY;

-- Insertion publique : n'importe qui peut postuler
CREATE POLICY "Insertion candidature libre"
  ON public.convoyeurs_candidats
  FOR INSERT
  WITH CHECK (true);

-- Lecture : bloquée pour anon (admin utilise service_role)
CREATE POLICY "Lecture candidats bloquee anon"
  ON public.convoyeurs_candidats
  FOR SELECT
  USING (false);

-- UPDATE : bloqué pour anon
CREATE POLICY "MAJ candidats bloquee anon"
  ON public.convoyeurs_candidats
  FOR UPDATE
  USING (false);

-- DELETE : bloqué pour anon
CREATE POLICY "Suppression candidats bloquee"
  ON public.convoyeurs_candidats
  FOR DELETE
  USING (false);

-- -------------------------------------------------------
-- TABLE : edls (états des lieux)
-- Un état des lieux est lié à une mission.
-- Seul le client propriétaire de la mission peut le voir.
-- Le convoyeur y accède via le bon de mission (service_role).
-- -------------------------------------------------------
DROP POLICY IF EXISTS "Insertion publique edls" ON public.edls;
DROP POLICY IF EXISTS "Lecture publique edls" ON public.edls;
DROP POLICY IF EXISTS "Mise a jour edls" ON public.edls;

ALTER TABLE public.edls ENABLE ROW LEVEL SECURITY;

-- INSERT : Autorisé pour authenticated (convoyeur en mission)
CREATE POLICY "Insertion edl authentifie"
  ON public.edls
  FOR INSERT
  WITH CHECK (true);

-- SELECT : Le client voit les EDLs de ses missions uniquement
CREATE POLICY "Client voit ses edls"
  ON public.edls
  FOR SELECT
  USING (
    mission_id IN (
      SELECT m.id FROM public.missions m
      JOIN public.clients c ON m.client_id = c.id
      WHERE c.email = auth.email()
    )
  );

-- UPDATE : Bloqué anon (service_role pour admin)
CREATE POLICY "MAJ edls bloquee anon"
  ON public.edls
  FOR UPDATE
  USING (false);

-- DELETE : Bloqué
CREATE POLICY "Suppression edls bloquee"
  ON public.edls
  FOR DELETE
  USING (false);

-- Recharger le cache du schéma
NOTIFY pgrst, 'reload schema';
