-- =========================================================
-- RM-01F — Atomic Contact Update (edit + primary in one transaction)
-- =========================================================
-- Adds crm_update_contact_atomic(contact_id, organization_id, ...)
-- SECURITY DEFINER. Internal-only.
--
-- Purpose (RM01A-003):
--   The previous frontend flow updated contact fields via a direct
--   RLS UPDATE, then called crm_set_primary_contact in a SEPARATE
--   transaction. If the primary RPC failed, the contact-field UPDATE
--   was already committed — a partial, non-atomic state.
--
--   This RPC performs BOTH the permitted-field UPDATE and the
--   primary-contact reassignment inside a single database
--   transaction (the function body). If any step fails, the whole
--   operation rolls back: no partial update can persist.
--
-- Additive only. No table changes. No RLS changes. No index changes.
-- Does NOT weaken the partial unique index
--   organization_contacts_primary_unique_idx or any trigger.
-- Does NOT delete or alter crm_set_primary_contact (still usable
--   elsewhere for primary-only swaps).
--
-- SECURITY DEFINER function introduced (1, with SET search_path = ''):
--   1. public.crm_update_contact_atomic
-- EXECUTE: authenticated only.
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. RPC: crm_update_contact_atomic
-- =========================================================
-- SECURITY DEFINER. Internal-only.
--
-- Behavior:
--   - Updates the permitted business fields of one contact.
--   - Applies primary-contact state atomically:
--       p_primary_contact = true  AND was not primary -> unset all
--                              primaries for the org, set this contact.
--       p_primary_contact = false AND was primary     -> clear primary.
--       primary unchanged                            -> no-op on primary.
--   - All in one transaction: field update + primary change
--     succeed or fail together.
--
-- Validations:
--   - caller is authenticated and internal user (admin or operator)
--   - contact exists AND belongs to p_organization_id (cross-org guard)
--
-- Permitted fields (explicit parameters — no arbitrary column update):
--   first_name, last_name, job_title, department, email, phone,
--   mobile, preferred_channel, decision_maker, active, notes.
--   primary_contact is handled via the atomic primary logic below.
--   organization_id, client_id, created_at, updated_at are NOT
--   mutable here.
--
-- The partial unique index organization_contacts_primary_unique_idx
-- guarantees at most one primary_contact=true per organization.
-- This RPC unsets existing primaries BEFORE setting the new one in
-- the same transaction so the index invariant is never violated
-- mid-operation.

CREATE OR REPLACE FUNCTION public.crm_update_contact_atomic(
  p_contact_id        uuid,
  p_organization_id   uuid,
  p_first_name        text,
  p_last_name         text,
  p_job_title         text,
  p_department        text,
  p_email             text,
  p_phone             text,
  p_mobile            text,
  p_preferred_channel text,
  p_decision_maker    boolean,
  p_active            boolean,
  p_notes             text,
  p_primary_contact   boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_was_primary boolean;
BEGIN
  -- 1. Authorization: authenticated + internal users only.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Réservé aux utilisateurs internes' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate contact exists AND belongs to the claimed organization.
  --    This is the cross-org guard: a contact from another organization
  --    cannot be edited or made primary here.
  SELECT primary_contact INTO v_was_primary
    FROM public.organization_contacts
    WHERE id = p_contact_id
      AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Le contact n''appartient pas à cette organisation'
      USING ERRCODE = 'P0001';
  END IF;

  -- 3. Update permitted contact fields (CHECK constraints still apply;
  --    a constraint violation aborts the whole transaction).
  UPDATE public.organization_contacts
    SET first_name        = p_first_name,
        last_name         = p_last_name,
        job_title         = p_job_title,
        department        = p_department,
        email             = p_email,
        phone             = p_phone,
        mobile            = p_mobile,
        preferred_channel = p_preferred_channel,
        decision_maker    = p_decision_maker,
        active            = p_active,
        notes             = p_notes
    WHERE id = p_contact_id;

  -- 4. Apply primary-contact state atomically (same transaction).
  --    The previous primary is cleared ONLY if the new assignment
  --    proceeds. If this block raises, the field UPDATE above is
  --    rolled back too — no partial update persists.
  IF p_primary_contact AND NOT v_was_primary THEN
    -- Promote: unset all existing primaries for this org first.
    UPDATE public.organization_contacts
      SET primary_contact = false
      WHERE organization_id = p_organization_id
        AND primary_contact = true;
    -- Then set the new primary.
    UPDATE public.organization_contacts
      SET primary_contact = true
      WHERE id = p_contact_id;
  ELSIF NOT p_primary_contact AND v_was_primary THEN
    -- Demote: clear primary on this contact.
    UPDATE public.organization_contacts
      SET primary_contact = false
      WHERE id = p_contact_id;
  END IF;
  -- If primary state is unchanged, this block is a no-op.
END;
$$;

ALTER FUNCTION public.crm_update_contact_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text,
  boolean, boolean, text, boolean
) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_update_contact_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text,
  boolean, boolean, text, boolean
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.crm_update_contact_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text,
  boolean, boolean, text, boolean
) TO authenticated;

-- =========================================================
-- 2. COMMENT
-- =========================================================

COMMENT ON FUNCTION public.crm_update_contact_atomic(
  uuid, uuid, text, text, text, text, text, text, text, text,
  boolean, boolean, text, boolean
) IS
  'SECURITY DEFINER. Internal-only. Atomically updates permitted contact fields AND applies primary-contact state in a single transaction. Cross-org guard via organization_id validation. Preserves partial unique index invariant. Rollback is all-or-nothing.';

-- =========================================================
-- 3. SCHEMA CACHE
-- =========================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
