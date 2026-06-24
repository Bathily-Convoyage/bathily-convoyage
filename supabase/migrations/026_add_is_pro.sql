-- =====================================================
-- Migration 026 : Ajout colonnes is_pro et pro_status
-- Permet de distinguer les clients pro des particuliers
-- =====================================================

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_pro boolean DEFAULT false;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS pro_status text DEFAULT null;
-- pro_status: 'pending' (demande en attente), 'approved' (validé), 'rejected' (refusé)

-- Index pour filtrer les pros en attente
CREATE INDEX IF NOT EXISTS idx_clients_pro_status ON public.clients(pro_status) WHERE pro_status IS NOT NULL;

NOTIFY pgrst, 'reload schema';
