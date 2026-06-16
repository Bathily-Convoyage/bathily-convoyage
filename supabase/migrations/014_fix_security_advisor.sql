-- =====================================================
-- Migration 014 : Fix Security Advisor warnings
-- 1. Vue convoyeurs_public avec SECURITY INVOKER
-- 2. RLS policies trop permissives (USING true) corrigées
-- =====================================================

-- -------------------------------------------------------
-- 1. FIX : Vue convoyeurs_public → SECURITY INVOKER
-- La vue héritait des droits du créateur (SECURITY DEFINER)
-- On la recrée avec SECURITY INVOKER pour respecter RLS
-- -------------------------------------------------------
DROP VIEW IF EXISTS public.convoyeurs_public;

CREATE OR REPLACE VIEW public.convoyeurs_public
WITH (security_invoker = true)
AS
SELECT
  id,
  prenom,
  ville,
  zone,
  niveau,
  disponible,
  zones,
  note_moyenne,
  grade,
  taux_auto,
  taux_moto,
  auth_user_id
FROM public.convoyeurs;

GRANT SELECT ON public.convoyeurs_public TO anon, authenticated;

-- -------------------------------------------------------
-- 2. FIX : Policy UPDATE convoyeurs trop permissive
-- Remplace USING (true) par auth.uid() check
-- -------------------------------------------------------
DROP POLICY IF EXISTS "MAJ convoyeurs session app" ON public.convoyeurs;
DROP POLICY IF EXISTS "Convoyeur modifie son profil" ON public.convoyeurs;
DROP POLICY IF EXISTS "Convoyeur voit son profil" ON public.convoyeurs;
DROP POLICY IF EXISTS "Lecture convoyeurs bloquee anon" ON public.convoyeurs;

-- Un convoyeur authentifié voit uniquement son propre profil
CREATE POLICY "Convoyeur voit son profil"
  ON public.convoyeurs FOR SELECT
  USING (auth_user_id = auth.uid());

-- Un convoyeur authentifié modifie uniquement son propre profil
CREATE POLICY "Convoyeur modifie son profil"
  ON public.convoyeurs FOR UPDATE
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- -------------------------------------------------------
-- 3. FIX : Policy INSERT candidatures trop permissive
-- On garde USING(true) pour SELECT (vérif email existant)
-- mais on cible mieux l'INSERT
-- -------------------------------------------------------
DROP POLICY IF EXISTS "Insertion candidature libre" ON public.convoyeurs_candidats;

CREATE POLICY "Insertion candidature libre"
  ON public.convoyeurs_candidats
  FOR INSERT
  WITH CHECK (
    statut = 'pending'
    AND email IS NOT NULL
    AND prenom IS NOT NULL
    AND nom IS NOT NULL
  );

NOTIFY pgrst, 'reload schema';
