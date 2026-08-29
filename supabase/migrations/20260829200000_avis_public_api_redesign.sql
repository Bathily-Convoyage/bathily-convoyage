-- V1.1-B: Replace direct public.avis table access with a dedicated public view
-- and a SECURITY DEFINER submit RPC.
--
-- This migration replaces the failed V1.1 approach (column-level grants on the
-- base table, which broke PostgREST table visibility) with a clean separation:
--
--   PUBLIC READ:  avis_public view (6 public columns, approved-only, no RLS)
--   PUBLIC WRITE: submit_public_avis RPC (SECURITY DEFINER, narrow contract)
--   DIRECT TABLE: anon gets zero privileges; authenticated loses table-wide grants
--                 (no direct frontend consumer remains after the view/RPC switch)
--
-- Objects created:
--   1. VIEW public.avis_public
--   2. FUNCTION public.submit_public_avis(...)
--
-- Grants:
--   - SELECT on avis_public TO anon, authenticated
--   - EXECUTE on submit_public_avis TO anon, authenticated
--   - REVOKE all table-wide grants on public.avis FROM authenticated
--   - anon: NO direct privileges on public.avis (unchanged from baseline)
--
-- Policies:
--   - DROP avis_insert_anon_safe (replaced by RPC)
--   - DROP avis_insert_auth_safe (replaced by RPC)
--   - avis_select_approved: preserved (harmless; view is the public path)
--   - avis_select_admin: preserved (future admin path)
--   - avis_update_own: preserved (harmless; no grant to exercise it)
--
-- No data mutation. No table structure change. No service_role change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ============================================================
-- 1. PUBLIC READ VIEW
-- ============================================================
-- A regular (non-security-definer) view with RLS disabled.
-- PostgREST exposes it via table-level SELECT grant.
-- The view definition hard-codes the approved-only filter and
-- limits columns to the 6 public display fields.
-- Private columns (auteur_email, user_id, mission_id, reponse_admin,
-- approved_at, updated_at, source, type_service, id, statut) are
-- structurally absent from the view output.
CREATE OR REPLACE VIEW public.avis_public
  WITH (security_barrier = true)
AS
  SELECT
    auteur_nom,
    note,
    titre,
    commentaire,
    ville,
    created_at
  FROM public.avis
  WHERE statut = 'approuve';

-- Grant SELECT on the view to public API roles.
-- No RLS on the view — the WHERE clause in the view definition
-- is the only filter needed (approved-only).
GRANT SELECT ON public.avis_public TO anon;
GRANT SELECT ON public.avis_public TO authenticated;

-- ============================================================
-- 2. PUBLIC SUBMIT RPC
-- ============================================================
-- SECURITY DEFINER so the function can INSERT into public.avis
-- even though anon/authenticated have no direct INSERT privilege.
-- The function accepts ONLY review fields; all privileged fields
-- are forced internally.
--
-- Security measures:
--   - SET search_path TO '' (empty, fully-qualified references)
--   - REVOKE EXECUTE FROM PUBLIC
--   - EXECUTE only to anon, authenticated
--   - No dynamic SQL
--   - Input validation (auteur_type, note range, required fields)
--   - user_id derived from auth.uid() (never from caller argument)
--   - statut, source, reponse_admin, approved_at forced to safe values
CREATE OR REPLACE FUNCTION public.submit_public_avis(
  p_auteur_type text,
  p_auteur_nom text,
  p_note integer,
  p_commentaire text,
  p_auteur_email text DEFAULT NULL,
  p_titre text DEFAULT NULL,
  p_ville text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _user_id uuid;
  _new_id uuid;
BEGIN
  -- Validate auteur_type
  IF p_auteur_type IS NULL OR p_auteur_type NOT IN ('client', 'convoyeur', 'visiteur') THEN
    RAISE EXCEPTION 'auteur_type doit être client, convoyeur ou visiteur'
      USING ERRCODE = '23514';
  END IF;

  -- Validate auteur_nom (required, non-empty)
  IF p_auteur_nom IS NULL OR btrim(p_auteur_nom) = '' THEN
    RAISE EXCEPTION 'auteur_nom est obligatoire'
      USING ERRCODE = '23502';
  END IF;

  -- Validate note (required, 1..5)
  IF p_note IS NULL OR p_note < 1 OR p_note > 5 THEN
    RAISE EXCEPTION 'note doit être entre 1 et 5'
      USING ERRCODE = '23514';
  END IF;

  -- Validate commentaire (required, non-empty)
  IF p_commentaire IS NULL OR btrim(p_commentaire) = '' THEN
    RAISE EXCEPTION 'commentaire est obligatoire'
      USING ERRCODE = '23502';
  END IF;

  -- Derive user_id from auth context (never from caller)
  _user_id := auth.uid();

  -- Insert with all privileged fields forced to safe defaults
  INSERT INTO public.avis (
    auteur_type,
    auteur_nom,
    auteur_email,
    user_id,
    note,
    titre,
    commentaire,
    ville,
    statut,
    source,
    reponse_admin,
    approved_at
  ) VALUES (
    p_auteur_type,
    p_auteur_nom,
    p_auteur_email,
    _user_id,
    p_note,
    p_titre,
    p_commentaire,
    p_ville,
    'en_attente',
    'site',
    NULL,
    NULL
  )
  RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$function$;

-- Revoke EXECUTE from PUBLIC (default grant on new functions)
REVOKE EXECUTE ON FUNCTION public.submit_public_avis(
  text, text, integer, text, text, text, text
) FROM PUBLIC;

-- Grant EXECUTE only to intended API roles
GRANT EXECUTE ON FUNCTION public.submit_public_avis(
  text, text, integer, text, text, text, text
) TO anon;

GRANT EXECUTE ON FUNCTION public.submit_public_avis(
  text, text, integer, text, text, text, text
) TO authenticated;

-- ============================================================
-- 3. DIRECT TABLE GRANT CLEANUP
-- ============================================================
-- Revoke all table-wide grants from authenticated on public.avis.
-- After the frontend switches to the view + RPC, no direct table
-- consumer remains. service_role and postgres are unchanged.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.avis FROM authenticated;

-- anon: no grants on public.avis (already the case from baseline).
-- Nothing to revoke.

-- ============================================================
-- 4. POLICY CLEANUP
-- ============================================================
-- The old INSERT policies are now obsolete: the SECURITY DEFINER
-- RPC performs the INSERT with service_role-level privileges
-- (bypassing RLS), and the function's internal logic enforces all
-- safety constraints. No direct INSERT path remains for anon or
-- authenticated.
DROP POLICY IF EXISTS "avis_insert_anon_safe" ON public.avis;
DROP POLICY IF EXISTS "avis_insert_auth_safe" ON public.avis;

-- Preserved policies (unchanged):
--   avis_select_approved  — still valid for any future direct-table
--                           authenticated SELECT path (admin read)
--   avis_select_admin     — admin SELECT path
--   avis_update_own       — harmless; no UPDATE grant to exercise it

COMMIT;
