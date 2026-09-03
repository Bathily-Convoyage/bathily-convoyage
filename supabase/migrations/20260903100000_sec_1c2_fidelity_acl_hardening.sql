-- ================================================================
-- SEC-1C2 — Fidelity ACL Hardening
-- ================================================================
-- Closes two ACL issues identified by the SEC-1C1 read-only audit:
--
--   1. P2: public.points_fidelite had GRANT INSERT TO authenticated
--      with an RLS policy that only checks user_id = auth.uid().
--      There is no CHECK constraint on the points value, so any
--      authenticated user could self-award arbitrary loyalty points
--      via a direct PostgREST INSERT, inflating solde_fidelite.
--
--   2. P3: public.apply_parrainage_code(text) had EXECUTE granted
--      to authenticated but has zero runtime callers in the current
--      application (frontend uses direct table access instead).
--      Dead privileged grant — least-privilege cleanup.
--
-- This migration performs ONLY two REVOKE statements:
--   - REVOKE INSERT ON public.points_fidelite FROM authenticated
--   - REVOKE EXECUTE ON FUNCTION public.apply_parrainage_code(text) FROM authenticated
--
-- Preserved:
--   - service_role access (ALL on points_fidelite, EXECUTE on apply_parrainage_code)
--   - authenticated SELECT on points_fidelite (read path for solde_fidelite view)
--   - authenticated UPDATE/DELETE on points_fidelite (existing grants unchanged)
--   - anon grants (none existed on these objects)
--   - RLS policies (unchanged)
--   - table definitions, constraints, function body (unchanged)
--   - frontend, fidelity UI, parrainages table, solde_fidelite view (unchanged)
--
-- No DROP. No ALTER FUNCTION. No CREATE OR REPLACE FUNCTION. No RLS rewrite.
-- No data mutation. No frontend change. No auth config change.
-- ================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ================================================================
-- 1. Block authenticated self-award of loyalty points
-- ================================================================
-- After this REVOKE, only service_role (and postgres owner) can
-- INSERT into points_fidelite. Points must be awarded through a
-- SECURITY DEFINER RPC or server-side function, not direct client
-- inserts.
REVOKE INSERT ON TABLE public.points_fidelite FROM authenticated;

-- ================================================================
-- 2. Remove dead EXECUTE grant on apply_parrainage_code
-- ================================================================
-- The function has zero runtime callers. The frontend fidelite.js
-- uses direct table access (which is itself RLS-gated). Revoking
-- the dead EXECUTE grant reduces the attack surface until the
-- function is hardened (self-referral / multi-claim prevention)
-- and wired to the frontend in a future chantier.
REVOKE EXECUTE ON FUNCTION public.apply_parrainage_code(text) FROM authenticated;

COMMIT;
