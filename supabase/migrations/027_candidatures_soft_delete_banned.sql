-- =====================================================
-- Migration 027 : Soft delete + bannissement candidatures
--    Ajoute deleted_at (timestamp) et banned (boolean)
--    a la table convoyeur_candidatures
-- =====================================================

ALTER TABLE public.convoyeur_candidatures
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS banned boolean DEFAULT false;

-- Index pour filtrer rapidement les candidatures actives
CREATE INDEX IF NOT EXISTS idx_candidatures_deleted_at
  ON public.convoyeur_candidatures(deleted_at);

NOTIFY pgrst, 'reload schema';
