-- =========================================================
-- OPS-2A1A — Financial Integrity Phase A (Additive)
-- =========================================================
-- This migration is ADDITIVE and backward-compatible.
--
-- It introduces:
--   1. admin_update_mission_tariffs() RPC
--   2. missions_financial_protect() trigger (PERMISSIVE mode)
--   3. prepare_billing_record() lock fix (FOR UPDATE on mission row)
--
-- It does NOT:
--   - modify missions table grants
--   - introduce trigger authorization gates
--   - require GUC in the trigger
--   - add CHECK constraints
--   - repair dirty data
--
-- Phase C (enforcement) is deferred to a future migration.
-- =========================================================

BEGIN;

-- =========================================================
-- 1. RPC: admin_update_mission_tariffs
-- =========================================================
-- Post-create tariff mutation RPC.
-- SECURITY DEFINER (runs as postgres).
-- Sets a transaction-local GUC marker before the financial UPDATE
-- so that the future Phase C trigger can verify authorization.
--
-- Phase A trigger does NOT yet require the marker, but the RPC
-- sets/resets it now for forward-compatible behavior.
-- =========================================================

CREATE OR REPLACE FUNCTION public.admin_update_mission_tariffs(
  p_mission_id uuid,
  p_montant_ht numeric DEFAULT NULL,
  p_remuneration_convoyeur numeric DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_mission public.missions%ROWTYPE;
  v_new_price numeric;
  v_new_rem numeric;
  v_new_marge numeric;
  v_old_price numeric;
  v_old_rem numeric;
  v_old_marge numeric;
  v_reason text;
BEGIN
  -- 1. Authentication
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentification requise' USING ERRCODE = '42501';
  END IF;

  -- 2. Authorization
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur' USING ERRCODE = '42501';
  END IF;

  -- 3. At least one tariff parameter required
  IF p_montant_ht IS NULL AND p_remuneration_convoyeur IS NULL THEN
    RAISE EXCEPTION 'Au moins un champ tarifaire est requis' USING ERRCODE = 'P0001';
  END IF;

  -- 4. Lock mission row
  SELECT * INTO v_mission FROM public.missions WHERE id = p_mission_id FOR UPDATE;

  -- 5. Mission existence
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- 6. Payment guard
  IF v_mission.paiement_statut IN ('paid', 'paye') THEN
    RAISE EXCEPTION 'Les tarifs ne peuvent pas être modifiés après paiement'
      USING ERRCODE = 'P0001';
  END IF;

  -- 7. Stripe session guard
  IF v_mission.stripe_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'Les tarifs ne peuvent pas être modifiés après création d''une session de paiement'
      USING ERRCODE = 'P0001';
  END IF;

  -- 8. Billing guard
  IF EXISTS (
    SELECT 1 FROM public.billing_records
    WHERE mission_id = p_mission_id
      AND invoice_type = 'invoice'
      AND status IN ('prepared', 'issued')
  ) THEN
    RAISE EXCEPTION 'Une facturation est en préparation ou émise. Annulez-la avant de modifier les tarifs.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 9. Resolve new values (NULL = leave unchanged)
  v_new_price := COALESCE(p_montant_ht, v_mission.montant_ht);
  v_new_rem := COALESCE(p_remuneration_convoyeur, v_mission.remuneration_convoyeur);

  -- 10. Validate resolved values
  IF v_new_price IS NULL THEN
    RAISE EXCEPTION 'montant_ht ne peut pas être NULL' USING ERRCODE = '23502';
  END IF;
  IF v_new_price <= 0 THEN
    RAISE EXCEPTION 'montant_ht doit être strictement positif' USING ERRCODE = '23514';
  END IF;
  IF v_new_rem IS NULL THEN
    RAISE EXCEPTION 'remuneration_convoyeur ne peut pas être NULL' USING ERRCODE = '23502';
  END IF;
  IF v_new_rem < 0 THEN
    RAISE EXCEPTION 'remuneration_convoyeur ne peut pas être négative' USING ERRCODE = '23514';
  END IF;
  IF v_new_rem > v_new_price THEN
    RAISE EXCEPTION 'remuneration_convoyeur ne peut pas dépasser montant_ht' USING ERRCODE = '23514';
  END IF;

  -- 11. Calculate margin
  v_new_marge := v_new_price - v_new_rem;

  -- 12. Capture old financial values
  v_old_price := v_mission.montant_ht;
  v_old_rem := v_mission.remuneration_convoyeur;
  v_old_marge := v_mission.marge;

  -- 13. Sanitize/validate reason
  v_reason := NULLIF(btrim(p_reason), '');
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'La raison ne peut pas dépasser 500 caractères' USING ERRCODE = '22001';
  END IF;

  -- 14. Set transaction-local GUC marker
  PERFORM set_config('bathily.tariff_update_authorized', '1', true);

  -- 15. UPDATE mission financial fields
  --     Do NOT catch the exception — let it propagate and roll back.
  UPDATE public.missions
  SET montant_ht = v_new_price,
      remuneration_convoyeur = v_new_rem,
      marge = v_new_marge,
      updated_at = now()
  WHERE id = p_mission_id;

  -- 16. Immediately reset GUC marker
  PERFORM set_config('bathily.tariff_update_authorized', '', true);

  -- 17. Log audit event
  PERFORM public.log_mission_event(
    p_mission_id,
    'tariff_updated',
    NULL,
    NULL,
    'admin',
    jsonb_build_object(
      'old_montant_ht', v_old_price,
      'new_montant_ht', v_new_price,
      'old_remuneration_convoyeur', v_old_rem,
      'new_remuneration_convoyeur', v_new_rem,
      'old_marge', v_old_marge,
      'new_marge', v_new_marge,
      'reason', v_reason
    )
  );

  -- 18. Return result
  RETURN jsonb_build_object(
    'old_montant_ht', v_old_price,
    'new_montant_ht', v_new_price,
    'old_remuneration_convoyeur', v_old_rem,
    'new_remuneration_convoyeur', v_new_rem,
    'old_marge', v_old_marge,
    'new_marge', v_new_marge
  );
END;
$$;

ALTER FUNCTION public.admin_update_mission_tariffs(uuid, numeric, numeric, text) OWNER TO postgres;

REVOKE EXECUTE ON FUNCTION public.admin_update_mission_tariffs(uuid, numeric, numeric, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_mission_tariffs(uuid, numeric, numeric, text)
  TO authenticated;

-- =========================================================
-- 2. TRIGGER FUNCTION: missions_financial_protect
-- =========================================================
-- Phase A: PERMISSIVE mode.
-- Derives marge and validates financial invariants.
-- Does NOT enforce authorization (no current_user / GUC check).
-- Phase C will add the authorization gate.
-- =========================================================

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
    -- Phase A: permissive mode (derive + validate only, no auth gate)
    -- Dirty-data compatibility: only validate CHANGED fields individually.
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

DROP TRIGGER IF EXISTS missions_financial_protect_trigger ON public.missions;
CREATE TRIGGER missions_financial_protect_trigger
  BEFORE UPDATE ON public.missions
  FOR EACH ROW
  EXECUTE FUNCTION public.missions_financial_protect();

-- =========================================================
-- 3. prepare_billing_record — Lock Fix
-- =========================================================
-- Recreate prepare_billing_record with FOR UPDATE on the mission
-- SELECT to serialize with admin_update_mission_tariffs.
--
-- All existing behavior is preserved exactly. The ONLY change is
-- adding FOR UPDATE to the mission row SELECT.
-- =========================================================

CREATE OR REPLACE FUNCTION public.prepare_billing_record(
  p_mission_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_mission public.missions%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_client_id uuid;
  v_total_ht numeric;
  v_total_tva numeric := 0;
  v_total_ttc numeric;
  v_prepared_payload jsonb;
  v_billing_id uuid;
  v_customer_name text;
  v_service_desc text;
BEGIN
  -- Authorization
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur' USING ERRCODE = '42501';
  END IF;

  -- Mission must exist — LOCK ROW for serialization with tariff RPC
  SELECT * INTO v_mission FROM public.missions WHERE id = p_mission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Mission must have a positive amount
  IF v_mission.montant_ht IS NULL OR v_mission.montant_ht <= 0 THEN
    RAISE EXCEPTION 'Le montant HT de la mission doit être positif' USING ERRCODE = 'P0001';
  END IF;

  -- Reject if an active primary invoice already exists
  IF EXISTS (
    SELECT 1 FROM public.billing_records
    WHERE mission_id = p_mission_id
      AND invoice_type = 'invoice'
      AND status IN ('prepared', 'issued')
  ) THEN
    RAISE EXCEPTION 'Une facture active existe déjà pour cette mission'
      USING ERRCODE = 'P0001';
  END IF;

  -- Determine client_id from mission
  v_client_id := v_mission.client_id;

  -- Load client if linked
  IF v_client_id IS NOT NULL THEN
    SELECT * INTO v_client FROM public.clients WHERE id = v_client_id;
  END IF;

  -- Financials (Level 1: franchise en base, TVA=0)
  v_total_ht := v_mission.montant_ht;
  v_total_tva := 0;
  v_total_ttc := v_total_ht;

  -- Build customer name
  IF v_client.id IS NOT NULL AND v_client.is_pro = true AND v_client.societe IS NOT NULL AND btrim(v_client.societe) <> '' THEN
    v_customer_name := v_client.societe;
  ELSIF v_client.id IS NOT NULL THEN
    v_customer_name := btrim(COALESCE(v_client.prenom, '') || ' ' || COALESCE(v_client.nom, ''));
  ELSE
    v_customer_name := COALESCE(v_mission.client_nom, 'Client');
  END IF;

  -- Build service description
  v_service_desc := 'Convoyage automobile'
    || COALESCE(' — ' || btrim(COALESCE(v_mission.depart_ville, v_mission.depart, '')) || ' → ' || btrim(COALESCE(v_mission.arrivee_ville, v_mission.arrivee, '')), '')
    || COALESCE(' — Mode ' || v_mission.mode, '')
    || COALESCE(' — Pack ' || v_mission.pack, '');

  -- Build prepared_payload (server-side, authoritative)
  v_prepared_payload := jsonb_build_object(
    'seller', jsonb_build_object(
      'name', 'Bathily-Convoyage',
      'legal_form', 'Entreprise individuelle (micro-entrepreneur)',
      'siret', '789 285 376 00032',
      'address', '34, rue de Padirac 34070 Montpellier',
      'email', 'contact@bathily-convoyage.fr',
      'tva_regime', 'TVA non applicable — franchise en base (art. 293 B CGI)'
    ),
    'customer', jsonb_build_object(
      'name', v_customer_name,
      'email', COALESCE(v_client.email, v_mission.client_email),
      'address', COALESCE(v_client.adresse, v_mission.client_address),
      'code_postal', v_client.code_postal,
      'ville', v_client.ville,
      'pays', COALESCE(v_client.pays, 'France'),
      'siret', v_client.siret,
      'tva_intra', v_client.tva_intra,
      'is_pro', COALESCE(v_client.is_pro, false)
    ),
    'mission', jsonb_build_object(
      'reference', v_mission.reference,
      'depart', v_mission.depart,
      'arrivee', v_mission.arrivee,
      'vehicule', v_mission.vehicule,
      'pack', v_mission.pack,
      'mode', v_mission.mode,
      'date_mission', v_mission.date_mission,
      'service_description', v_service_desc
    ),
    'financial', jsonb_build_object(
      'total_ht', v_total_ht,
      'total_tva', v_total_tva,
      'total_ttc', v_total_ttc,
      'currency', 'EUR',
      'tva_rate', 0
    )
  );

  -- Insert billing_record (status='prepared' enforced by insert_guard trigger)
  INSERT INTO public.billing_records (
    mission_id,
    client_id,
    provider,
    status,
    invoice_type,
    total_ht,
    total_tva,
    total_ttc,
    currency,
    prepared_payload,
    notes,
    created_by
  ) VALUES (
    p_mission_id,
    v_client_id,
    'indy',
    'prepared',
    'invoice',
    v_total_ht,
    v_total_tva,
    v_total_ttc,
    'EUR',
    v_prepared_payload,
    p_notes,
    v_actor_id
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_billing_id;

  -- If insert was skipped by ON CONFLICT (race on partial unique index)
  IF v_billing_id IS NULL THEN
    RAISE EXCEPTION 'Une préparation est déjà en cours pour cette mission (conflit concurrent)'
      USING ERRCODE = 'P0001';
  END IF;

  -- Log creation event atomically
  PERFORM public.log_billing_event(
    v_billing_id,
    'billing_record_created',
    NULL,
    'prepared',
    'admin',
    jsonb_build_object(
      'mission_id', p_mission_id,
      'total_ht', v_total_ht,
      'total_ttc', v_total_ttc,
      'provider', 'indy'
    )
  );

  RETURN v_billing_id;
END;
$$;

ALTER FUNCTION public.prepare_billing_record(uuid, text) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.prepare_billing_record(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_billing_record(uuid, text) TO authenticated;

COMMIT;
