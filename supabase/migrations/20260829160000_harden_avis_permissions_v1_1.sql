-- V1.1-A4: Least-privilege finalization for public.avis (anon + authenticated).
--
-- This migration completes the secure avis remediation by applying column-level
-- grants to BOTH anon and authenticated roles, replacing all table-wide grants
-- on public.avis with least-privilege column-level grants.
--
-- Problems fixed:
--   1. anon had zero grants → 401 on homepage avis load (fixed in A2)
--   2. anon INSERT policy allowed auto-approval, source spoofing, etc. (fixed in A2)
--   3. authenticated INSERT policy allowed auto-approval, source spoofing, etc. (fixed in A3)
--   4. authenticated had table-wide SELECT → private columns exposed to any authenticated user
--   5. authenticated had table-wide INSERT → could inject statut, source, reponse_admin, etc.
--   6. authenticated had table-wide UPDATE → could inject reponse_admin, approved_at, source, etc.
--   7. authenticated had table-wide DELETE → no DELETE policy exists, but grant was unnecessary
--
-- Solution:
--   - REVOKE all table-wide grants from authenticated
--   - GRANT column-level SELECT on only the 6 public display columns
--   - GRANT column-level INSERT on only the review submission fields
--   - GRANT column-level UPDATE on only the user-editable review fields
--   - Do NOT grant DELETE to authenticated (no DELETE policy exists)
--   - Harden both INSERT policies (A2/A3) to enforce statut='en_attente', source='site',
--     reponse_admin IS NULL, approved_at IS NULL
--   - Email is optional for both anon and authenticated (matching frontend UI)
--
-- Admin access:
--   - avis_select_admin policy (is_admin()) is unchanged — admins can still see all ROWS
--   - Admins who need private COLUMNS use service_role (bypasses RLS, has ALL grants)
--   - No admin frontend reads avis — no admin INSERT/SELECT consumer exists
--   - avis_update_own policy is unchanged (user_id = auth.uid() AND statut = 'en_attente')
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ============================================================
-- REVOKE table-wide grants from authenticated
-- ============================================================
-- The baseline granted SELECT, INSERT, DELETE, UPDATE table-wide to authenticated.
-- Replace with column-level grants below.
REVOKE SELECT, INSERT, DELETE, UPDATE ON public.avis FROM authenticated;

-- ============================================================
-- PUBLIC READ: column-level SELECT for anon AND authenticated
-- ============================================================
-- Both roles get SELECT only on the 6 public display columns used by
-- the homepage avis renderer. Private columns (auteur_email, user_id,
-- mission_id, reponse_admin, approved_at, updated_at, source,
-- type_service, id) are NOT granted to either role.
--
-- RLS still filters rows: avis_select_approved (statut = 'approuve')
-- for both roles, avis_select_admin (is_admin()) for authenticated admins.
GRANT SELECT (auteur_nom, note, titre, commentaire, ville, created_at)
  ON public.avis TO anon;

GRANT SELECT (auteur_nom, note, titre, commentaire, ville, created_at)
  ON public.avis TO authenticated;

-- ============================================================
-- ANON INSERT: harden policy + column-level INSERT
-- ============================================================
DROP POLICY "avis_insert_anon_safe" ON public.avis;

CREATE POLICY "avis_insert_anon_safe"
  ON public.avis
  FOR INSERT
  TO anon
  WITH CHECK (
    user_id IS NULL
    AND statut = 'en_attente'
    AND source = 'site'
    AND reponse_admin IS NULL
    AND approved_at IS NULL
  );

-- Column-level INSERT: anon can only set review fields.
-- NOT granted: id, statut, source, created_at, updated_at (defaults),
-- user_id, mission_id, reponse_admin, approved_at, type_service (enforced NULL).
GRANT INSERT (auteur_type, auteur_nom, auteur_email, note, titre, commentaire, ville)
  ON public.avis TO anon;

-- ============================================================
-- AUTHENTICATED INSERT: harden policy + column-level INSERT
-- ============================================================
DROP POLICY "avis_insert_auth_safe" ON public.avis;

CREATE POLICY "avis_insert_auth_safe"
  ON public.avis
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (user_id IS NULL OR user_id = (SELECT auth.uid()))
    AND statut = 'en_attente'
    AND source = 'site'
    AND reponse_admin IS NULL
    AND approved_at IS NULL
  );

-- Column-level INSERT: authenticated can set review fields + own user_id.
-- NOT granted: id, statut, source, created_at, updated_at (defaults),
-- mission_id, reponse_admin, approved_at, type_service (enforced NULL/safe).
GRANT INSERT (auteur_type, auteur_nom, auteur_email, user_id, note, titre, commentaire, ville)
  ON public.avis TO authenticated;

-- ============================================================
-- AUTHENTICATED UPDATE: column-level UPDATE (least privilege)
-- ============================================================
-- The avis_update_own policy (user_id = auth.uid() AND statut = 'en_attente')
-- is unchanged. It controls WHICH rows can be updated. This grant controls
-- WHICH columns can be updated.
--
-- Column-level UPDATE: authenticated can only update review fields.
-- NOT granted: statut (no self-approval), source (no spoofing),
-- reponse_admin (no admin response injection), approved_at (no approval
-- timestamp injection), user_id (no identity change), mission_id,
-- type_service, id, created_at, updated_at.
--
-- This closes the A3 finding where table-wide UPDATE allowed a user to
-- inject reponse_admin, approved_at, or source on their own en_attente avis.
GRANT UPDATE (auteur_type, auteur_nom, auteur_email, note, titre, commentaire, ville)
  ON public.avis TO authenticated;

-- ============================================================
-- AUTHENTICATED DELETE: NOT granted
-- ============================================================
-- No DELETE policy exists on avis. The table-wide DELETE grant from the
-- baseline was unnecessary and is NOT re-granted. RLS would block all
-- DELETEs anyway, but least privilege means not granting it at all.

COMMIT;
