-- =====================================================
-- Migration 040 : Colonnes relance devis + rappel mission
-- =====================================================

-- Colonne pour tracer les relances de devis
ALTER TABLE public.devis ADD COLUMN IF NOT EXISTS relance_envoyee TIMESTAMPTZ;

-- Colonne pour tracer les rappels de mission J-1
ALTER TABLE public.missions ADD COLUMN IF NOT EXISTS rappel_envoye TIMESTAMPTZ;

-- Index pour optimiser les requetes du cron
CREATE INDEX IF NOT EXISTS idx_devis_relance ON public.devis (statut, created_at) WHERE relance_envoyee IS NULL;
CREATE INDEX IF NOT EXISTS idx_missions_rappel ON public.missions (statut, date_prise_en_charge) WHERE rappel_envoye IS NULL;

NOTIFY pgrst, 'reload schema';
