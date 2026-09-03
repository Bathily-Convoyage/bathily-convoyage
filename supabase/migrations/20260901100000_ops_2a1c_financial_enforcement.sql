-- ================================================================
-- OPS-2A1C — Phase C Financial Enforcement
-- ================================================================
-- Makes admin_update_mission_tariffs() the ONLY authorized path
-- for changing mission financial fields (montant_ht, remuneration_convoyeur, marge).
--
-- 1. REVOKE table-level UPDATE on public.missions FROM authenticated
-- 2. Harden missions_financial_protect() with authorization gate
-- 3. Preserve Phase A dirty-data compatibility
-- 4. Preserve non-financial mission updates
--
-- NO data mutation. NO data repair. NO RLS change. NO CHECK constraint.
-- NO billing table change. NO Stripe schema change.
-- ================================================================

BEGIN;

-- ================================================================
-- 1. REVOKE UPDATE FROM authenticated
-- ================================================================
-- After OPS-2A1B, the frontend tariff editor calls the RPC.
-- No authenticated user needs direct table-level UPDATE on missions.
--
-- SECURITY DEFINER functions (RPCs) execute as postgres and are
-- unaffected by this revoke.
--
-- NO grant-back. NO column-level UPDATE grant.
-- ================================================================

REVOKE UPDATE ON TABLE public.missions FROM authenticated;

-- ================================================================
-- 2. Harden missions_financial_protect() — Phase C
-- ================================================================
-- Recreate the trigger function with the Phase A dirty-data
-- semantics preserved, PLUS the authorization gate.
--
-- When ANY financial field changes, the trigger requires BOTH:
--   current_user = 'postgres'
--   AND
--   current_setting('bathily.tariff_update_authorized', true) = '1'
--
-- Otherwise raise 42501 (insufficient_privilege).
--
-- Non-financial updates remain allowed for any caller.
-- ================================================================

CREATE OR REPLACE FUNCTION public.missions_financial_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Only activate when financial fields change
  IF NEW.montant_ht IS DISTINCT FROM OLD.montant_ht
     OR NEW.remuneration_convoyeur IS DISTINCT FROM OLD.remuneration_convoyeur
     OR NEW.marge IS DISTINCT FROM OLD.marge
  THEN
    -- Phase C: Authorization gate
    -- Require BOTH postgres (SECURITY DEFINER context) AND the
    -- transaction-local GUC marker set by admin_update_mission_tariffs.
    -- This ensures only the authorized RPC can mutate financial fields.
    IF current_user <> 'postgres'
       OR current_setting('bathily.tariff_update_authorized', true) IS DISTINCT FROM '1'
    THEN
      RAISE EXCEPTION 'Modification des tarifs non autorisée. Utiliser admin_update_mission_tariffs().'
        USING ERRCODE = '42501';
    END IF;

    -- Phase A dirty-data compatibility: only validate CHANGED fields individually.
    -- Unchanged historical invalid values are NOT rejected here.

    -- A. Validate montant_ht ONLY if it changed
    IF NEW.montant_ht IS DISTINCT FROM OLD.montant_ht
       AND NEW.montant_ht IS NOT NULL AND NEW.montant_ht <= 0 THEN
      RAISE EXCEPTION 'montant_ht doit être strictement positif'
        USING ERRCODE = '23514';
    END IF;

    -- B. Validate remuneration_convoyeur ONLY if it changed
    IF NEW.remuneration_convoyeur IS DISTINCT FROM OLD.remuneration_convoyeur
       AND NEW.remuneration_convoyeur IS NOT NULL AND NEW.remuneration_convoyeur < 0 THEN
      RAISE EXCEPTION 'remuneration_convoyeur ne peut pas être négative'
        USING ERRCODE = '23514';
    END IF;

    -- C. Cross-field validation: only when both individual values are valid.
    --    This avoids rejecting updates where an unchanged historical field
    --    is individually invalid (e.g. price=0 with rem>0). The cross-field
    --    check only fires when both price>0 AND rem>=0, so the violation
    --    is genuinely caused by the combination, not by a stale invalid field.
    IF NEW.montant_ht IS NOT NULL AND NEW.montant_ht > 0
       AND NEW.remuneration_convoyeur IS NOT NULL AND NEW.remuneration_convoyeur >= 0
       AND NEW.remuneration_convoyeur > NEW.montant_ht THEN
      RAISE EXCEPTION 'remuneration_convoyeur ne peut pas dépasser montant_ht'
        USING ERRCODE = '23514';
    END IF;

    -- D. Derive marge only when both values are individually valid and
    --    cross-field valid. Do not invent a margin for dirty rows.
    IF NEW.montant_ht IS NOT NULL AND NEW.montant_ht > 0
       AND NEW.remuneration_convoyeur IS NOT NULL AND NEW.remuneration_convoyeur >= 0
       AND NEW.remuneration_convoyeur <= NEW.montant_ht THEN
      NEW.marge := NEW.montant_ht - NEW.remuneration_convoyeur;
    END IF;

    -- E. If either financial component is NULL or individually invalid:
    --    do NOT invent a margin. NEW.marge retains whatever the caller set,
    --    or OLD.marge if unchanged.
  END IF;

  -- F. Non-financial UPDATE: return NEW unchanged (financial values untouched)
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.missions_financial_protect() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.missions_financial_protect()
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger already exists from OPS-2A1A; no need to drop/recreate
-- since CREATE OR REPLACE FUNCTION updates the function body in place
-- and the existing trigger will use the new definition.

COMMIT;
