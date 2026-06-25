-- Migration: Ensure candidatures table has all needed columns

-- Add missing columns to candidatures if they don't exist
ALTER TABLE public.candidatures
  ADD COLUMN IF NOT EXISTS mission_reference text,
  ADD COLUMN IF NOT EXISTS mission_trajet text,
  ADD COLUMN IF NOT EXISTS mission_montant numeric;

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';
