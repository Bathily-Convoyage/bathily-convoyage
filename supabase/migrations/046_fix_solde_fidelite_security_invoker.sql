-- =====================================================
-- Migration 046 : Correction sécurité vue solde_fidelite
--    Passe la vue en SECURITY INVOKER pour respecter les RLS
--    de la table sous-jante points_fidelite
-- =====================================================

-- Recréer la vue avec SECURITY INVOKER
CREATE OR REPLACE VIEW public.solde_fidelite
WITH (security_invoker = true) AS
SELECT
  user_id,
  COALESCE(SUM(points), 0) AS solde_points,
  COUNT(*) AS nb_transactions
FROM public.points_fidelite
GROUP BY user_id;

-- Le GRANT SELECT reste sur authenticated, mais maintenant
-- les RLS de points_fidelite (user_id = auth.uid()) s'appliquent
GRANT SELECT ON public.solde_fidelite TO authenticated;

NOTIFY pgrst, 'reload schema';
