-- =====================================================
-- Migration 005 : Ajout des colonnes manquantes
-- =====================================================

-- Il semblerait que certaines colonnes n'existaient pas dans votre table 'clients'
-- malgré leur présence dans le fichier initial. Ce script s'assure qu'elles soient bien créées.

ALTER TABLE public.clients
ADD COLUMN IF NOT EXISTS adresse text,
ADD COLUMN IF NOT EXISTS code_postal text,
ADD COLUMN IF NOT EXISTS ville text,
ADD COLUMN IF NOT EXISTS pays text DEFAULT 'France',
ADD COLUMN IF NOT EXISTS entreprise text,
ADD COLUMN IF NOT EXISTS siret text;

-- Faisons de même pour les convoyeurs au cas où
ALTER TABLE public.convoyeurs
ADD COLUMN IF NOT EXISTS adresse text,
ADD COLUMN IF NOT EXISTS code_postal text,
ADD COLUMN IF NOT EXISTS ville text,
ADD COLUMN IF NOT EXISTS pays text DEFAULT 'France';

-- Forcer le rechargement du cache du schéma de Supabase
NOTIFY pgrst, 'reload schema';
