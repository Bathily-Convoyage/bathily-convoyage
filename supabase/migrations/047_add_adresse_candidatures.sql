-- =====================================================
-- Migration 047 : Ajouter colonnes adresse & code_postal
--    à la table convoyeur_candidatures pour le formulaire
--    de formation convoyeur (adresse postale obligatoire)
-- =====================================================

ALTER TABLE public.convoyeur_candidatures
  ADD COLUMN IF NOT EXISTS adresse text,
  ADD COLUMN IF NOT EXISTS code_postal text,
  ADD COLUMN IF NOT EXISTS date_naissance date;

NOTIFY pgrst, 'reload schema';
