-- =====================================================
-- MISSIONS-EXT-2C — Admin/Operator Expense Entry RPC
-- =====================================================
-- Adds ONE narrowly scoped SECURITY DEFINER RPC so an
-- authenticated admin or operator can record a real, known
-- mission expense directly from the mission details UI.
--
-- Business semantics:
--   An expense entered directly by an authorized admin/operator
--   represents a known business cost and is APPROVED immediately.
--   The same person records and validates the cost, so the expense
--   is created with status='approved' and correct audit metadata.
--
-- Security:
--   - SECURITY DEFINER, explicit empty search_path.
--   - Rejects anonymous callers.
--   - Allows ONLY existing admin/operator roles via the project's
--     authoritative permission helpers (is_admin / is_operator).
--   - Clients blocked. Convoyeurs blocked unless they separately
--     hold an admin/operator role.
--   - status, reviewed_by, reviewed_at are derived SERVER-SIDE.
--     The caller CANNOT choose status or forge the reviewer.
--   - No broad table INSERT/UPDATE grants are added. The protect
--     trigger and SELECT-only grant on mission_expenses remain
--     untouched; the RPC runs as postgres (the only existing
--     mutation identity) and performs the single INSERT.
--
-- Profitability invariant (unchanged):
--   margin = montant_ht - remuneration_convoyeur
--            - SUM(mission_expenses.amount WHERE status='approved')
--   missions.marge is NOT authoritative.
--
-- This migration is ADDITIVE and backward-compatible:
--   - no schema change
--   - no RLS change
--   - no grant change on tables
--   - no CHECK change
--   - one new function + its EXECUTE grants only
--
-- LOCAL FILE ONLY. NOT EXECUTED in this gate.
-- DO NOT apply to Production without explicit authorization.
-- =====================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- =====================================================
-- 1. RPC: admin_create_mission_expense
-- =====================================================
CREATE OR REPLACE FUNCTION public.admin_create_mission_expense(
  p_mission_id   uuid,
  p_expense_type text,
  p_amount       numeric,
  p_expense_date date,
  p_description  text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _mission     public.missions%ROWTYPE;
  _is_admin    boolean;
  _is_operator boolean;
  _actor_role  text;
  _desc_trim   text;
  _expense_id  uuid;
BEGIN
  -- 1. Auth required (anonymous blocked)
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- 2. Authorize: admin OR operator only (clients/convoyeurs blocked
  --    unless they separately hold an admin/operator role).
  _is_admin    := public.is_admin();
  _is_operator := public.is_operator();

  IF NOT (_is_admin OR _is_operator) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  _actor_role := CASE WHEN _is_admin THEN 'admin' ELSE 'operator' END;

  -- 3. Mission must exist
  SELECT * INTO _mission FROM public.missions WHERE id = p_mission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0001';
  END IF;

  -- 4. Validate expense_type against the exact DB allowlist
  IF p_expense_type NOT IN ('fuel', 'charging', 'toll', 'parking', 'return_transport', 'washing', 'other') THEN
    RAISE EXCEPTION 'Type de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  -- 5. Validate amount: positive and finite
  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (p_amount > 0) THEN
    -- Covers <= 0, NaN (NaN > 0 is false), and numeric edge cases.
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  -- 6. Validate expense_date
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'Date de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  -- 7. Validate description: non-empty (btrim) and <= 500 chars.
  --    Matches the table CHECK constraint mission_expenses_description_len.
  _desc_trim := btrim(p_description);
  IF _desc_trim IS NULL OR length(_desc_trim) = 0 OR length(p_description) > 500 THEN
    RAISE EXCEPTION 'Description invalide' USING ERRCODE = 'P0001';
  END IF;

  -- 8. Create the expense as APPROVED with server-derived audit metadata.
  --    status / reviewed_by / reviewed_at are NOT accepted from the caller.
  --    submitted_by records who entered the expense; submitted_at marks the
  --    recording timestamp so the audit trail stays coherent.
  INSERT INTO public.mission_expenses (
    mission_id,
    submitted_by,
    expense_type,
    amount,
    currency,
    expense_date,
    description,
    status,
    submitted_at,
    reviewed_by,
    reviewed_at
  ) VALUES (
    p_mission_id,
    auth.uid(),
    p_expense_type,
    p_amount,
    'EUR',
    p_expense_date,
    p_description,
    'approved',
    now(),
    auth.uid(),
    now()
  )
  RETURNING id INTO _expense_id;

  -- 9. Audit log (same event type used by review_mission_expense approvals)
  PERFORM public.log_mission_event(
    _mission.id,
    'expense_approved',
    NULL,
    NULL,
    _actor_role,
    jsonb_build_object(
      'expense_id', _expense_id,
      'expense_type', p_expense_type,
      'admin_created', true
    )
  );

  RETURN _expense_id;
END;
$$;

-- =====================================================
-- 2. EXECUTE grants — match the P3.5 ACL pattern
-- =====================================================
REVOKE EXECUTE ON FUNCTION public.admin_create_mission_expense(uuid, text, numeric, date, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_create_mission_expense(uuid, text, numeric, date, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_create_mission_expense(uuid, text, numeric, date, text) FROM authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_mission_expense(uuid, text, numeric, date, text) TO authenticated, service_role;

COMMIT;
