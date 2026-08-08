-- =====================================================
-- Migration 043 : Nouveaux champs devis (HiFlow features)
-- =====================================================

-- Ajouter les colonnes vehicle_condition et utilitaire_size à la table devis
ALTER TABLE public.devis
  ADD COLUMN IF NOT EXISTS vehicle_condition TEXT DEFAULT 'working' CHECK (vehicle_condition IN ('working', 'non_working')),
  ADD COLUMN IF NOT EXISTS utilitaire_size TEXT,
  ADD COLUMN IF NOT EXISTS is_collection BOOLEAN DEFAULT false;

-- Index pour filtrer les devis par état du véhicule
CREATE INDEX IF NOT EXISTS idx_devis_vehicle_condition ON public.devis (vehicle_condition) WHERE vehicle_condition IS NOT NULL;

NOTIFY pgrst, 'reload schema';
