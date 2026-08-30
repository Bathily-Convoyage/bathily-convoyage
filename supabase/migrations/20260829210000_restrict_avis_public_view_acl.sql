-- V1.1-B3: Reconcile avis_public view ACL to SELECT-only for public roles.
--
-- Root cause: Supabase's default ACLs for the public schema (pg_default_acl
-- entries for defaclobjtype='r') automatically grant ALL privileges
-- (arwdDxtm) to anon and authenticated on any new relation created in
-- public, including views. The original migration 20260829200000 only
-- issued GRANT SELECT, but the platform's default privileges also granted
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER.
--
-- This follow-up migration makes the intended SELECT-only ACL reproducible
-- from Git by explicitly revoking all privileges and re-granting only SELECT.
--
-- This migration is state-idempotent: if the view already has SELECT-only
-- grants (current Production state after manual fix), REVOKE ALL is a no-op
-- and GRANT SELECT is a no-op. If the view has excessive grants (fresh
-- replay from 20260829200000), this migration corrects them.
--
-- Scope:
--   - public.avis_public view ACL only
--   - NO changes to public.avis base table
--   - NO changes to submit_public_avis RPC
--   - NO changes to RLS policies
--   - NO changes to default privileges
--   - NO data mutation
--   - NO table structure changes
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Revoke ALL privileges from public API roles on the view.
-- This removes any auto-granted INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, and TRIGGER privileges from Supabase's default ACLs.
REVOKE ALL PRIVILEGES ON public.avis_public FROM anon;
REVOKE ALL PRIVILEGES ON public.avis_public FROM authenticated;

-- Re-grant only SELECT to public API roles.
GRANT SELECT ON public.avis_public TO anon;
GRANT SELECT ON public.avis_public TO authenticated;

COMMIT;
