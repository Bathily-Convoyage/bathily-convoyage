-- =====================================================
-- SEC-MARKET-RLS-1 — Harden Direct Available Mission RLS
-- =====================================================
-- Corrective RLS-only migration.
--
-- ROOT CAUSE
-- ----------
-- The missions_select_b3 policy's status='available' branch
-- gated DIRECT available missions with:
--
--   source_mission = 'direct'
--   AND (is_internal_user() OR external_convoyeurs_enabled())
--
-- external_convoyeurs_enabled() reads a GLOBAL app_settings flag
-- (not user-specific). When the marketplace flag is true, this
-- reduced to `source_mission = 'direct' AND TRUE`, granting every
-- authenticated user — including clients, external convoyeurs
-- (banned and active), and generic authenticated users — read
-- access to DIRECT available missions and their PII columns
-- (client_email, client_telephone, immatriculation, stripe_session_id,
-- remuneration_convoyeur, ...).
--
-- This defect predates MISSIONS-EXT-1. The MISSIONS-EXT-1A migration
-- (20260905120000) correctly narrowed the EXTERNAL branch but
-- preserved the vulnerable DIRECT branch verbatim.
--
-- FIX
-- ---
-- The marketplace feature flag must control ONLY the intended
-- EXTERNAL-convoyeur marketplace visibility. It must NOT act as a
-- global authenticated-user visibility bypass for DIRECT missions.
--
-- New DIRECT available branch:
--   source_mission = 'direct' AND is_internal_user()
--
--   - admin / operator (internal users): preserved
--   - clients: NOT visible via the available branch
--   - external convoyeurs (active or banned): NOT visible
--   - generic authenticated: NOT visible
--   - anon: NOT visible (policy is TO authenticated)
--
-- The EXTERNAL available branch is UNCHANGED and already correct:
--   source_mission <> 'direct'
--   AND external_convoyeurs_enabled()
--   AND EXISTS (auth-linked non-banned convoyeur)
--
-- No helper function changes.
-- No grant changes.
-- No schema changes.
-- No data rewrite.
-- No feature-flag mutation.
-- RLS-only.
--
-- LOCAL FILE ONLY. NOT EXECUTED in production by this gate.
-- =====================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER POLICY "missions_select_b3" ON public.missions
  USING (
    public.is_admin()
    OR public.is_operator()
    OR client_id IN (
      SELECT c.id
      FROM public.clients c
      WHERE c.auth_user_id = (select auth.uid())
    )
    OR client_email = ((select auth.jwt()) ->> 'email')
    OR convoyeur_id IN (
      SELECT c.id
      FROM public.convoyeurs c
      WHERE c.auth_user_id = (select auth.uid())
        AND c.banned = false
    )
    OR (
      status = 'available'
      AND (
        -- Direct available missions: internal users only.
        -- The marketplace flag must NOT grant DIRECT mission
        -- visibility to non-internal users.
        (source_mission = 'direct'
         AND public.is_internal_user())
        OR (
          -- External available missions: only when external_convoyeurs_enabled
          -- AND auth-linked non-banned convoyeur.
          -- Admin/operator bypass through top-level is_admin()/is_operator().
          -- Do NOT use is_internal_user() here — admin/operator already covered.
          source_mission <> 'direct'
          AND public.external_convoyeurs_enabled()
          AND EXISTS (
            SELECT 1
            FROM public.convoyeurs c
            WHERE c.auth_user_id = (select auth.uid())
              AND c.banned = false
          )
        )
      )
    )
  );

COMMIT;
