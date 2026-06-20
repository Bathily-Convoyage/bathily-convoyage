-- =====================================================
-- Migration 006 : Réseau des convoyeurs
-- =====================================================

-- Ajout des champs pour la gestion du réseau
ALTER TABLE public.convoyeurs
ADD COLUMN IF NOT EXISTS disponible boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS zones jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS note_moyenne numeric(2,1) DEFAULT 5.0,
ADD COLUMN IF NOT EXISTS grade text DEFAULT 'Standard';

-- Commentaire : 'zones' stockera un tableau des régions, ex: '["Île-de-France", "PACA"]'

-- Forcer le rechargement du cache de Supabase
NOTIFY pgrst, 'reload schema';
