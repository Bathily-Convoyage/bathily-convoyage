-- =========================================================
-- P3C2-D — Internal User Listing RPC
-- =========================================================
-- Adds crm_list_internal_users()
-- SECURITY DEFINER. Internal-only. Returns a safe, minimal
-- list of internal users (admins + active operators) for the
-- CRM activity assigned_to picker.
--
-- user_roles and internal_operators both have RLS enabled with
-- all privileges revoked from authenticated and no SELECT
-- policies, so the frontend cannot read them directly. This
-- RPC is the safe read path.
--
-- Returns ONLY:
--   user_id       — auth.users id (uuid, needed for assigned_to FK)
--   display_name  — human-readable name
--   role          — 'admin' or 'operator'
--   active        — boolean (operators: internal_operators.active;
--                   admins: always true)
--
-- Does NOT return: password hashes, email (unless already in
--   display_name), provider identities, tokens, or any auth
--   metadata beyond what is needed for assignment.
--
-- Additive only. No table changes. No RLS changes.
--
-- SECURITY DEFINER function introduced (1, with SET search_path = ''):
--   1. public.crm_list_internal_users
-- EXECUTE: authenticated only.
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. RPC: crm_list_internal_users
-- =========================================================

CREATE OR REPLACE FUNCTION public.crm_list_internal_users()
RETURNS TABLE (
  user_id      uuid,
  display_name text,
  role         text,
  active       boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 1. Authorization: internal users only.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Réservé aux utilisateurs internes' USING ERRCODE = '42501';
  END IF;

  -- 2. Return admins (role='admin' in user_roles).
  --    Admins are always considered active.
  --    display_name comes from internal_operators if available,
  --    otherwise falls back to the clients table (legacy admin path).
  RETURN QUERY
    SELECT
      ur.user_id,
      COALESCE(io.display_name,
        (SELECT c.prenom || ' ' || c.nom
         FROM public.clients c
         WHERE c.auth_user_id = ur.user_id
         LIMIT 1),
        'Admin') AS display_name,
      'admin'::text AS role,
      true AS active
    FROM public.user_roles ur
    LEFT JOIN public.internal_operators io ON io.user_id = ur.user_id
    WHERE ur.role = 'admin';

  -- 3. Return active operators (role='operator' AND internal_operators.active = true).
  RETURN QUERY
    SELECT
      ur.user_id,
      COALESCE(io.display_name, 'Opérateur') AS display_name,
      'operator'::text AS role,
      io.active AS active
    FROM public.user_roles ur
    JOIN public.internal_operators io ON io.user_id = ur.user_id
    WHERE ur.role = 'operator'
      AND io.active = true;
END;
$$;

ALTER FUNCTION public.crm_list_internal_users() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_list_internal_users() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.crm_list_internal_users() TO authenticated;

-- =========================================================
-- 2. COMMENT
-- =========================================================

COMMENT ON FUNCTION public.crm_list_internal_users() IS
  'SECURITY DEFINER. Internal-only. Returns minimal user_id/display_name/role/active for CRM activity assignment. Does not expose auth metadata.';

-- =========================================================
-- 3. SCHEMA CACHE
-- =========================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
