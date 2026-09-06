-- =====================================================
-- MISSIONS-EXT-4A3 — External Billing Isolation
-- =====================================================
-- Business rule:
--   External platform missions (hiflow, driiveme, alb, other)
--   are autofactured by their respective platforms.
--   Bathily must NOT create a normal client invoice/billing
--   record for them. Only direct missions enter the Indy
--   billing workflow.
--
-- This migration is ADDITIVE and forward-only:
--   - Redefines prepare_billing_record to reject external missions
--   - Preserves SECURITY DEFINER, search_path='', ACL model
--   - Does NOT modify historical migrations
--   - Does NOT change billing_records schema
--   - Does NOT change link_external_invoice or cancel_billing_record
--     (they operate on existing billing records by ID; blocking
--      creation at prepare_billing_record is the authoritative gate)
--   - Does NOT introduce platform_fee
--   - Does NOT change external margin formula
--   - Does NOT touch settlement, expenses, incidents, or EDL
--
-- LOCAL ONLY. NOT EXECUTED in this gate.
-- DO NOT apply to Production without explicit authorization.
-- =====================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- =====================================================
-- 1. Redefine prepare_billing_record — reject external missions
-- =====================================================
-- The function is recreated identically to the OPS-2A1A version
-- (with FOR UPDATE lock) plus a single new guard:
--   IF v_mission.source_mission <> 'direct' THEN RAISE EXCEPTION
-- This guard is placed BEFORE any INSERT or side effect, ensuring
-- atomicity — no billing row, no event, no outbox entry is created
-- for an external mission.
-- =====================================================

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

  -- MISSIONS-EXT-4A3: External missions are autofactured by their platform.
  -- Bathily must NOT create a normal client billing record for them.
  -- This guard is placed before any INSERT or side effect (atomicity).
  IF v_mission.source_mission IS NULL OR v_mission.source_mission <> 'direct' THEN
    RAISE EXCEPTION 'Les missions externes ne sont pas facturables par Bathily (autofacturation plateforme)'
      USING ERRCODE = 'P0001';
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
