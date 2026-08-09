-- =========================================================
-- Phase 3 B4v3 — Harden Available Mission Privacy
-- =========================================================
-- Corrige l'exposition PII identifiée par V6 :
--
-- missions_select_b3 accordait la lecture de toute mission
-- status='available' à tout utilisateur authenticated, sans
-- vérifier external_convoyeurs_enabled(). Les colonnes
-- client_email, client_nom, client_telephone, immatriculation,
-- stripe_session_id, montant_ht, remuneration_convoyeur
-- étaient exposées.
--
-- Correction :
--   La branche status='available' est conditionnée par
--   is_internal_user() OR external_convoyeurs_enabled().
--   - internal user (admin/operator) : peut voir les missions
--     disponibles (gestion interne)
--   - external convoyeur : uniquement si feature activée
--   - client tiers non concerné : REFUSÉ
--
-- Les autres branches (admin, operator, client propriétaire,
-- convoyeur assigné) restent inchangées.
-- =========================================================

BEGIN;

DROP POLICY IF EXISTS "missions_select_b3" ON public.missions;
CREATE POLICY "missions_select_b3" ON public.missions
  FOR SELECT
  TO authenticated
  USING (
    -- Admin : toujours autorisé
    public.is_admin()
    -- Operator interne : toujours autorisé
    OR public.is_operator()
    -- Client propriétaire via client_id
    OR client_id IN (
      SELECT c.id FROM public.clients c
      WHERE c.auth_user_id = auth.uid()
    )
    -- Client propriétaire via email JWT
    OR client_email = (auth.jwt() ->> 'email')
    -- Convoyeur assigné à la mission
    OR convoyeur_id IN (
      SELECT c.id FROM public.convoyeurs c
      WHERE c.auth_user_id = auth.uid()
    )
    -- Mission disponible : uniquement si feature activée
    -- OU utilisateur interne
    OR (
      status = 'available'
      AND (
        public.is_internal_user()
        OR public.external_convoyeurs_enabled()
      )
    )
  );

COMMIT;
