-- =====================================================
-- Migration 023 : Ajout des colonnes manquantes sur convoyeurs
-- Certaines colonnes sont référencées dans le code mais n'existent pas en DB
-- =====================================================

ALTER TABLE public.convoyeurs
ADD COLUMN IF NOT EXISTS annee_permis integer,
ADD COLUMN IF NOT EXISTS type_permis text,
ADD COLUMN IF NOT EXISTS taux_auto numeric(4,2) DEFAULT 0.47,
ADD COLUMN IF NOT EXISTS taux_moto numeric(4,2) DEFAULT 0.40,
ADD COLUMN IF NOT EXISTS zone text,
ADD COLUMN IF NOT EXISTS niveau text DEFAULT 'Standard',
ADD COLUMN IF NOT EXISTS disponible boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS banned boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS adresse text,
ADD COLUMN IF NOT EXISTS code_postal text,
ADD COLUMN IF NOT EXISTS ville text,
ADD COLUMN IF NOT EXISTS notes_admin text,
ADD COLUMN IF NOT EXISTS documents jsonb DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_convoyeurs_auth_user_id ON public.convoyeurs(auth_user_id);

-- Recharger le cache du schéma
NOTIFY pgrst, 'reload schema';
