-- =====================================================
-- Migration 019 : Ajout politique UPDATE sur table devis
-- =====================================================
-- Permettre aux utilisateurs authentifiés (admin) de modifier les statuts des devis

-- Créer la politique UPDATE pour la table devis
-- (PostgreSQL ne supporte pas CREATE POLICY IF NOT EXISTS, on DROP d'abord)
DROP POLICY IF EXISTS "Modification devis par admin" ON public.devis;
CREATE POLICY "Modification devis par admin"
  ON public.devis FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- Recharger le cache du schéma de Supabase
NOTIFY pgrst, 'reload schema';
