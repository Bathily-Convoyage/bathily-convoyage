-- =====================================================
-- Migration 054 : Colonnes SIV sur vehicules
--    vin, couleur, date_premiere_circulation, numero_carte_grise
-- =====================================================

ALTER TABLE public.vehicules
  ADD COLUMN IF NOT EXISTS vin text,
  ADD COLUMN IF NOT EXISTS couleur text,
  ADD COLUMN IF NOT EXISTS date_premiere_circulation date,
  ADD COLUMN IF NOT EXISTS numero_carte_grise text;

NOTIFY pgrst, 'reload schema';
