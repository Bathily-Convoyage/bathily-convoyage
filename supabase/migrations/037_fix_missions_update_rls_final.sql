-- =====================================================
-- Migration 037 : Correction définitive des policies RLS
--   sur missions (UPDATE)
--
-- Problèmes corrigés :
-- 1. missions_update_active_anon recréée par migration 033
--    après avoir été supprimée par migration 028
--    → Permet à un utilisateur non authentifié de modifier
--      le statut d'une mission (faille critique)
-- 2. 3 policies UPDATE simultanées (OR logique PostgreSQL)
--    dont missions_update_authenticated trop permissive
--    → N'importe quel user authentifié peut modifier
--      n'importe quelle mission
--
-- Solution :
-- - Supprimer toutes les policies UPDATE existantes
-- - Créer une seule policy restrictive :
--   admin OU client propriétaire OU convoyeur assigné
-- =====================================================

NOTIFY pgrst, 'reload schema';

-- 1. Supprimer toutes les policies UPDATE existantes
DROP POLICY IF EXISTS "missions_update_active_anon" ON public.missions;
DROP POLICY IF EXISTS "missions_update_authenticated" ON public.missions;
DROP POLICY IF EXISTS "missions_update_own_or_admin" ON public.missions;

-- 2. Créer une seule policy UPDATE restrictive
CREATE POLICY "missions_update_own_or_admin"
  ON public.missions
  FOR UPDATE
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        -- Client : propriétaire de la mission
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid()
        )
        OR client_email = (auth.jwt()->>'email')
        -- Convoyeur : assigné à la mission
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs
          WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs
          WHERE auth_user_id = auth.uid()
        )
      )
    )
  )
  WITH CHECK (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid()
        )
        OR client_email = (auth.jwt()->>'email')
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs
          WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs
          WHERE auth_user_id = auth.uid()
        )
      )
    )
  );

-- =====================================================
-- 3. Unifier la CHECK constraint sur paiement_statut
--    Le frontend utilise 'paid' et 'paye' indifferemment
-- =====================================================
ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_paiement_statut_check;
ALTER TABLE public.missions
  ADD CONSTRAINT missions_paiement_statut_check
  CHECK (paiement_statut IN ('pending', 'paid', 'paye'));

NOTIFY pgrst, 'reload schema';
