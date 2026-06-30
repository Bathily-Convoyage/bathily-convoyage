-- =====================================================
-- Migration 055 : Colonnes date_livraison + heure_livraison sur devis
-- =====================================================

ALTER TABLE public.devis
  ADD COLUMN IF NOT EXISTS date_livraison date,
  ADD COLUMN IF NOT EXISTS heure_livraison time;

NOTIFY pgrst, 'reload schema';
