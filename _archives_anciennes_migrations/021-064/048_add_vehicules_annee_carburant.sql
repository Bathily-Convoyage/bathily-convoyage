-- =====================================================
-- Migration 048 : Ajouter colonnes annee et carburant
--    à la table vehicules pour le dashboard client
-- =====================================================

ALTER TABLE public.vehicules
  ADD COLUMN IF NOT EXISTS annee integer,
  ADD COLUMN IF NOT EXISTS carburant text;

NOTIFY pgrst, 'reload schema';
