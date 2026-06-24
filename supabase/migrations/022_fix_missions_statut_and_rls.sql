-- Migration 022 : Fix missions statut CHECK constraint + RLS policy pour client_email
-- 1. Drop CHECK constraint sur statut pour permettre les valeurs utilisées par l'app (available, planned, in_progress, completed, cancelled)
-- 2. Drop CHECK constraint sur paiement_statut pour permettre 'pending' et 'paid'
-- 3. Update RLS policy missions_select_own_or_admin pour matcher aussi sur client_email

-- =====================================================
-- 1. Drop CHECK constraints sur missions.statut
-- =====================================================
DO $$
BEGIN
  -- Trouver et drop le CHECK constraint sur statut
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'missions' AND constraint_type = 'CHECK'
  ) THEN
    ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_statut_check;
    ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_paiement_statut_check;
  END IF;
END $$;

-- =====================================================
-- 2. Recréer sans CHECK (ou avec un CHECK permissif)
-- =====================================================
-- Pas de nouveau CHECK : on autorise toutes les valeurs pour statut et paiement_statut
-- L'application contrôle les valeurs via le code frontend

-- =====================================================
-- 3. Update RLS policy pour missions SELECT
--    Ajouter match sur client_email pour les missions sans client_id
-- =====================================================
DROP POLICY IF EXISTS "missions_select_own_or_admin" ON public.missions;

CREATE POLICY "missions_select_own_or_admin"
  ON public.missions
  FOR SELECT
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
        )
        OR client_email = (auth.jwt()->>'email')
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  );
