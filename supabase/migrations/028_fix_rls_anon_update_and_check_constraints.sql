-- =====================================================
-- Migration 028 : Sécurité RLS + CHECK constraints
-- 1. Supprimer la policy missions_update_active_anon (Bug 13)
-- 2. Ajouter CHECK constraints sur status et paiement_statut (Bug 43)
-- =====================================================

-- Bug 13 : Supprimer la policy qui permet à un utilisateur non authentifié
-- de modifier le statut des missions
DROP POLICY IF EXISTS "missions_update_active_anon" ON public.missions;

-- Recréer une policy qui exige l'authentification pour UPDATE
CREATE POLICY "missions_update_authenticated"
  ON public.missions
  FOR UPDATE
  USING (
    auth.uid() IS NOT NULL
  )
  WITH CHECK (
    auth.uid() IS NOT NULL
  );

-- Bug 43 : Ajouter des CHECK constraints permissifs
-- (supprimés dans la migration 022 sans remplacement)
DO $$
BEGIN
  -- status CHECK
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'missions_status_check'
  ) THEN
    ALTER TABLE public.missions
    ADD CONSTRAINT missions_status_check
    CHECK (status IN ('planned','available','in_progress','completed','cancelled','archived'));
  END IF;

  -- paiement_statut CHECK
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'missions_paiement_statut_check'
  ) THEN
    ALTER TABLE public.missions
    ADD CONSTRAINT missions_paiement_statut_check
    CHECK (paiement_statut IN ('pending','paid'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Si les colonnes n'existent pas encore ou autre erreur, on ignore
  RAISE NOTICE 'CHECK constraint skipped: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';
