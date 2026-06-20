-- =====================================================
-- Migration 018 : Ajout de la colonne 'mode' aux tables
-- =====================================================
-- La colonne 'mode' est utilisée dans le code mais manquait dans la structure des tables
-- Cette migration ajoute la colonne 'mode' aux tables missions et devis

-- Ajouter la colonne 'mode' à la table missions si elle n'existe pas
ALTER TABLE public.missions
ADD COLUMN IF NOT EXISTS mode text DEFAULT 'route';

-- Ajouter la colonne 'mode' à la table devis si elle n'existe pas
ALTER TABLE public.devis
ADD COLUMN IF NOT EXISTS mode text DEFAULT 'route';

-- Si la colonne 'mode_transport' existe dans la table devis, migrer les données vers 'mode'
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'devis' AND column_name = 'mode_transport'
    ) THEN
        UPDATE public.devis SET mode = mode_transport WHERE mode IS NULL AND mode_transport IS NOT NULL;
    END IF;
END $$;

-- Recharger le cache du schéma de Supabase
NOTIFY pgrst, 'reload schema';
