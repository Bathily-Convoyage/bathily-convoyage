-- =====================================================
-- Migration 053 : Vues en SECURITY INVOKER
--    convoyeurs_public et solde_fidelite
-- =====================================================

ALTER VIEW public.convoyeurs_public SET (security_invoker = true);
ALTER VIEW public.solde_fidelite SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';
