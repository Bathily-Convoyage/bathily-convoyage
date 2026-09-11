-- =========================================================
-- P3C2-A — Atomic Primary Contact RPC
-- =========================================================
-- Adds crm_set_primary_contact(organization_id, contact_id)
-- SECURITY DEFINER. Internal-only. Atomically unsets the
-- previous primary_contact and sets the new one in a single
-- transaction, avoiding the non-atomic two-UPDATE race that
-- the partial unique index organization_contacts_primary_unique_idx
-- would otherwise expose.
--
-- Additive only. No table changes. No RLS changes. No grant changes.
-- Does NOT weaken the unique index or any existing trigger.
--
-- SECURITY DEFINER function introduced (1, with SET search_path = ''):
--   1. public.crm_set_primary_contact
-- EXECUTE: authenticated only.
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. RPC: crm_set_primary_contact
-- =========================================================
-- SECURITY DEFINER. Internal-only. Atomic primary contact swap.
--
-- Behavior:
--   p_contact_id IS NULL  -> unset primary on all contacts of org
--   p_contact_id non-NULL -> unset old primary, set new primary
--
-- Validations:
--   - caller is internal user (admin or operator)
--   - organization exists
--   - if contact_id non-null: contact exists AND belongs to org
--
-- The partial unique index organization_contacts_primary_unique_idx
-- guarantees at most one primary_contact=true per organization.
-- This RPC performs both UPDATEs in one transaction so the index
-- invariant is never violated mid-operation.

CREATE OR REPLACE FUNCTION public.crm_set_primary_contact(
  p_organization_id uuid,
  p_contact_id      uuid
)
RETURNS void
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

  -- 2. Organization must exist.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
    RAISE EXCEPTION 'Organisation introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- 3. If contact_id is non-null, validate it belongs to the org.
  IF p_contact_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_contacts
      WHERE id = p_contact_id
        AND organization_id = p_organization_id
    ) THEN
      RAISE EXCEPTION 'Le contact n''appartient pas à cette organisation'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 4. Atomically unset all existing primaries for this org.
  UPDATE public.organization_contacts
    SET primary_contact = false
    WHERE organization_id = p_organization_id
      AND primary_contact = true;

  -- 5. Set the new primary (if non-null).
  IF p_contact_id IS NOT NULL THEN
    UPDATE public.organization_contacts
      SET primary_contact = true
      WHERE id = p_contact_id;
  END IF;
END;
$$;

ALTER FUNCTION public.crm_set_primary_contact(uuid, uuid) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_set_primary_contact(uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.crm_set_primary_contact(uuid, uuid) TO authenticated;

-- =========================================================
-- 2. COMMENT
-- =========================================================

COMMENT ON FUNCTION public.crm_set_primary_contact(uuid, uuid) IS
  'SECURITY DEFINER. Internal-only. Atomically unsets previous primary_contact and sets new one for an organization. NULL contact_id clears primary. Preserves partial unique index invariant.';

-- =========================================================
-- 3. SCHEMA CACHE
-- =========================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
