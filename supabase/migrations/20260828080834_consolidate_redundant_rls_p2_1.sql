BEGIN;

-- P2.1 removes only redundant permissive-policy branches identified by the
-- Supabase Performance Advisor. The resulting predicates are the exact OR of
-- the previous policies, so the set of visible/writable rows does not change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- clients INSERT
-- Previous union:
--   legacy admin OR own row OR own row
-- Keep the legacy admin predicate verbatim instead of replacing it with a
-- broader helper, and retain the optimized initPlan auth.uid() form.
DROP POLICY "clients_insert_admin" ON public.clients;
DROP POLICY "clients_insert_authenticated" ON public.clients;
DROP POLICY "clients_insert_own" ON public.clients;

CREATE POLICY "clients_insert_admin_or_own"
ON public.clients
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.clients AS c_admin
    WHERE c_admin.auth_user_id = (SELECT auth.uid())
      AND c_admin.role = 'admin'
  )
  OR auth_user_id = (SELECT auth.uid())
);

-- clients SELECT
-- clients_select_own is wholly contained in clients_select_own_or_admin.
DROP POLICY "clients_select_own" ON public.clients;

-- convoyeurs SELECT
-- Both narrower policies are wholly contained in
-- convoyeurs_select_own_or_admin. Keeping that policy unchanged also keeps the
-- existing behavior where a banned convoyeur can read only their own profile.
DROP POLICY "convoyeurs_select_admin" ON public.convoyeurs;
DROP POLICY "convoyeurs_select_own" ON public.convoyeurs;

-- devis SELECT
-- devis_select_admin_or_own and devis_select_own_or_admin have identical
-- predicates; retain the latter as the canonical policy.
DROP POLICY "devis_select_admin_or_own" ON public.devis;

COMMIT;
