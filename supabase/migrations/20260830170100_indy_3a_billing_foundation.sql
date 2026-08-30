-- =========================================================
-- INDY-3A — Billing Database Foundation
-- =========================================================
-- Level 1 manual-assisted Indy invoicing architecture.
-- Adds billing_records + billing_events tables, RPCs, RLS,
-- terminal-state immutability guard, and billing workflow cutoff.
--
-- Architecture source of truth:
--   INDY-2, INDY-2A, INDY-2B, INDY-2C
--
-- Additive only. Does NOT modify missions, clients, devis,
-- Stripe RPCs, payment state machine, or existing migrations.
-- =========================================================

BEGIN;

-- =========================================================
-- 1. TABLE: public.billing_records
-- =========================================================

CREATE TABLE IF NOT EXISTS public.billing_records (
  id                      uuid         DEFAULT gen_random_uuid() NOT NULL,
  mission_id              uuid         NOT NULL REFERENCES public.missions(id) ON DELETE RESTRICT,
  client_id               uuid         REFERENCES public.clients(id) ON DELETE RESTRICT,
  provider                text         NOT NULL DEFAULT 'indy',
  status                  text         NOT NULL DEFAULT 'prepared',
  invoice_type            text         NOT NULL DEFAULT 'invoice',
  external_invoice_id     text,
  external_invoice_number text,
  total_ht                numeric      NOT NULL,
  total_tva               numeric      NOT NULL DEFAULT 0,
  total_ttc               numeric      NOT NULL,
  currency                text         NOT NULL DEFAULT 'EUR',
  prepared_payload        jsonb        NOT NULL,
  issued_at               timestamptz,
  cancelled_at            timestamptz,
  notes                   text,
  created_by              uuid,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (id),

  -- State machine values
  CONSTRAINT billing_records_status_check
    CHECK (status IN ('prepared', 'issued', 'cancelled')),
  CONSTRAINT billing_records_invoice_type_check
    CHECK (invoice_type IN ('invoice', 'credit_note')),

  -- Lifecycle consistency per status
  CONSTRAINT billing_records_prepared_no_external_number
    CHECK (status <> 'prepared' OR external_invoice_number IS NULL),
  CONSTRAINT billing_records_prepared_no_external_id
    CHECK (status <> 'prepared' OR external_invoice_id IS NULL),
  CONSTRAINT billing_records_prepared_no_issued_at
    CHECK (status <> 'prepared' OR issued_at IS NULL),
  CONSTRAINT billing_records_prepared_no_cancelled_at
    CHECK (status <> 'prepared' OR cancelled_at IS NULL),

  CONSTRAINT billing_records_issued_has_external_number
    CHECK (status <> 'issued' OR (external_invoice_number IS NOT NULL
                                  AND btrim(external_invoice_number) <> '')),
  CONSTRAINT billing_records_issued_has_issued_at
    CHECK (status <> 'issued' OR issued_at IS NOT NULL),
  CONSTRAINT billing_records_issued_no_cancelled_at
    CHECK (status <> 'issued' OR cancelled_at IS NULL),

  CONSTRAINT billing_records_cancelled_no_external_number
    CHECK (status <> 'cancelled' OR external_invoice_number IS NULL),
  CONSTRAINT billing_records_cancelled_no_external_id
    CHECK (status <> 'cancelled' OR external_invoice_id IS NULL),
  CONSTRAINT billing_records_cancelled_no_issued_at
    CHECK (status <> 'cancelled' OR issued_at IS NULL),
  CONSTRAINT billing_records_cancelled_has_cancelled_at
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),

  -- Provider / currency / financials
  CONSTRAINT billing_records_provider_nonempty
    CHECK (btrim(provider) <> ''),
  CONSTRAINT billing_records_currency_nonempty
    CHECK (btrim(currency) <> ''),
  CONSTRAINT billing_records_total_ht_positive
    CHECK (total_ht > 0),
  CONSTRAINT billing_records_total_tva_nonneg
    CHECK (total_tva >= 0),
  CONSTRAINT billing_records_total_ttc_ge_total_ht
    CHECK (total_ttc >= total_ht)
);

ALTER TABLE public.billing_records OWNER TO postgres;

-- =========================================================
-- 2. TABLE: public.billing_events
-- =========================================================

CREATE TABLE IF NOT EXISTS public.billing_events (
  id                  uuid         DEFAULT gen_random_uuid() NOT NULL,
  billing_record_id   uuid         NOT NULL REFERENCES public.billing_records(id) ON DELETE RESTRICT,
  event_type          text         NOT NULL,
  from_status         text,
  to_status           text,
  actor_user_id       uuid,
  actor_role          text,
  metadata            jsonb        DEFAULT '{}'::jsonb,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

ALTER TABLE public.billing_events OWNER TO postgres;

-- =========================================================
-- 3. INDEXES
-- =========================================================

-- At most one prepared primary invoice per mission
CREATE UNIQUE INDEX IF NOT EXISTS billing_records_one_prepared_per_mission_idx
  ON public.billing_records(mission_id)
  WHERE status = 'prepared';

-- External invoice number unique per provider
CREATE UNIQUE INDEX IF NOT EXISTS billing_records_unique_external_number_per_provider_idx
  ON public.billing_records(provider, external_invoice_number)
  WHERE external_invoice_number IS NOT NULL;

-- Query support
CREATE INDEX IF NOT EXISTS billing_records_mission_id_idx
  ON public.billing_records(mission_id);
CREATE INDEX IF NOT EXISTS billing_records_status_idx
  ON public.billing_records(status);
CREATE INDEX IF NOT EXISTS billing_records_client_id_idx
  ON public.billing_records(client_id);
CREATE INDEX IF NOT EXISTS billing_records_issued_at_idx
  ON public.billing_records(issued_at)
  WHERE issued_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_events_billing_record_id_idx
  ON public.billing_events(billing_record_id);
CREATE INDEX IF NOT EXISTS billing_events_created_at_idx
  ON public.billing_events(created_at);

-- =========================================================
-- 4. TRIGGER: billing_records_insert_guard (BEFORE INSERT)
-- =========================================================
-- Ensures every billing_record is born as status='prepared'
-- with coherent NULL lifecycle fields. No direct issued/cancelled
-- creation is possible, even from SECURITY DEFINER RPCs or
-- postgres direct SQL.
-- =========================================================

CREATE OR REPLACE FUNCTION public.billing_records_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status <> 'prepared' THEN
    RAISE EXCEPTION
      'Un enregistrement de facturation doit naître avec status=''prepared'' (tentative: ''%'')',
      NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.external_invoice_number IS NOT NULL THEN
    RAISE EXCEPTION 'external_invoice_number doit être NULL à la création'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.external_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'external_invoice_id doit être NULL à la création'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'issued_at doit être NULL à la création'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'cancelled_at doit être NULL à la création'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.billing_records_insert_guard() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.billing_records_insert_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS billing_records_insert_guard_trigger ON public.billing_records;
CREATE TRIGGER billing_records_insert_guard_trigger
  BEFORE INSERT ON public.billing_records
  FOR EACH ROW
  EXECUTE FUNCTION public.billing_records_insert_guard();

-- =========================================================
-- 5. TRIGGER: billing_records_guard (BEFORE UPDATE)
-- =========================================================
-- Unified guard replacing protect + state_guard.
-- Unconditional — NO postgres/current_user bypass.
--
-- Layer 1: terminal records (issued/cancelled) → reject ALL updates
-- Layer 2: state machine legality (prepared → issued/cancelled only)
-- Layer 3: core field immutability (always, even during prepared)
-- Layer 4: prepared_payload immutability
-- Layer 5: transition-specific field rules
-- =========================================================

CREATE OR REPLACE FUNCTION public.billing_records_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Layer 1: Terminal record full immutability (unconditional)
  IF OLD.status IN ('issued', 'cancelled') THEN
    RAISE EXCEPTION
      'Enregistrement terminal (status=%) : aucune modification autorisée',
      OLD.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Layer 2: State machine transition legality
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'prepared' AND NEW.status NOT IN ('issued', 'cancelled') THEN
      RAISE EXCEPTION
        'Transition illégale : prepared → % non autorisé (seuls issued et cancelled le sont)',
        NEW.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Layer 3: Core field immutability (always, no bypass)
  IF NEW.mission_id IS DISTINCT FROM OLD.mission_id THEN
    RAISE EXCEPTION 'mission_id est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'client_id est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'provider est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.invoice_type IS DISTINCT FROM OLD.invoice_type THEN
    RAISE EXCEPTION 'invoice_type est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.total_ht IS DISTINCT FROM OLD.total_ht THEN
    RAISE EXCEPTION 'total_ht est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.total_tva IS DISTINCT FROM OLD.total_tva THEN
    RAISE EXCEPTION 'total_tva est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.total_ttc IS DISTINCT FROM OLD.total_ttc THEN
    RAISE EXCEPTION 'total_ttc est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'currency est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'created_by est immuable' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at est immuable' USING ERRCODE = '42501';
  END IF;

  -- Layer 4: prepared_payload immutability
  IF NEW.prepared_payload IS DISTINCT FROM OLD.prepared_payload THEN
    RAISE EXCEPTION 'prepared_payload est immuable'
      USING ERRCODE = '42501';
  END IF;

  -- Layer 5: Transition-specific field rules
  IF OLD.status = 'prepared' AND NEW.status = 'issued' THEN
    -- Allowed: external_invoice_number, external_invoice_id, issued_at set
    NULL;
  ELSIF OLD.status = 'prepared' AND NEW.status = 'cancelled' THEN
    -- external fields must remain NULL
    IF NEW.external_invoice_number IS NOT NULL THEN
      RAISE EXCEPTION 'external_invoice_number ne peut pas être défini lors d''une annulation'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.external_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'external_invoice_id ne peut pas être défini lors d''une annulation'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'issued_at ne peut pas être défini lors d''une annulation'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Remaining in prepared state (no transition)
    IF NEW.external_invoice_number IS DISTINCT FROM OLD.external_invoice_number THEN
      RAISE EXCEPTION 'external_invoice_number ne peut être défini que lors de l''émission'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.external_invoice_id IS DISTINCT FROM OLD.external_invoice_id THEN
      RAISE EXCEPTION 'external_invoice_id ne peut être défini que lors de l''émission'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'issued_at ne peut être défini que lors de l''émission'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'cancelled_at ne peut être défini que lors de l''annulation'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.billing_records_guard() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.billing_records_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS billing_records_guard_trigger ON public.billing_records;
CREATE TRIGGER billing_records_guard_trigger
  BEFORE UPDATE ON public.billing_records
  FOR EACH ROW
  EXECUTE FUNCTION public.billing_records_guard();

-- =========================================================
-- 6. TRIGGER: billing_records_set_updated_at (BEFORE UPDATE)
-- =========================================================
-- Reuses the existing shared public.set_updated_at() function.
-- Order-independent with billing_records_guard: terminal UPDATEs
-- are always rejected by the guard regardless of firing order.
-- =========================================================

DROP TRIGGER IF EXISTS billing_records_set_updated_at ON public.billing_records;
CREATE TRIGGER billing_records_set_updated_at
  BEFORE UPDATE ON public.billing_records
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- 7. TRIGGER: billing_events append-only guard
-- =========================================================

CREATE OR REPLACE FUNCTION public.billing_events_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'billing_events est strictement append-only : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.billing_events_protect() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.billing_events_protect() FROM PUBLIC;

DROP TRIGGER IF EXISTS billing_events_protect_trigger ON public.billing_events;
CREATE TRIGGER billing_events_protect_trigger
  BEFORE UPDATE OR DELETE ON public.billing_events
  FOR EACH ROW
  EXECUTE FUNCTION public.billing_events_protect();

-- =========================================================
-- 8. RLS: billing_records
-- =========================================================

ALTER TABLE public.billing_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_records FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.billing_records FROM PUBLIC;
REVOKE ALL ON public.billing_records FROM anon;
REVOKE ALL ON public.billing_records FROM authenticated;
GRANT SELECT ON public.billing_records TO authenticated;

DROP POLICY IF EXISTS "billing_records_admin_select" ON public.billing_records;
CREATE POLICY "billing_records_admin_select"
  ON public.billing_records
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "billing_records_client_select_own" ON public.billing_records;
CREATE POLICY "billing_records_client_select_own"
  ON public.billing_records
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = billing_records.mission_id
        AND (
          m.client_id IN (
            SELECT c.id FROM public.clients c
            WHERE c.auth_user_id = auth.uid()
          )
          OR m.client_email = auth.jwt() ->> 'email'
        )
    )
  );

-- No INSERT/UPDATE/DELETE policies — all via SECURITY DEFINER RPCs

-- =========================================================
-- 9. RLS: billing_events (admin-only)
-- =========================================================

ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.billing_events FROM PUBLIC;
REVOKE ALL ON public.billing_events FROM anon;
REVOKE ALL ON public.billing_events FROM authenticated;
GRANT SELECT ON public.billing_events TO authenticated;

DROP POLICY IF EXISTS "billing_events_admin_select_only" ON public.billing_events;
CREATE POLICY "billing_events_admin_select_only"
  ON public.billing_events
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- No INSERT/UPDATE/DELETE policies — writes via SECURITY DEFINER RPCs only

-- =========================================================
-- 10. INTERNAL FUNCTION: log_billing_event
-- =========================================================
-- Internal-only. Not granted to anon/authenticated/PUBLIC.
-- Called from within prepare/link/cancel RPCs.
-- actor_user_id derived from auth.uid(), never from parameters.
-- =========================================================

CREATE OR REPLACE FUNCTION public.log_billing_event(
  p_billing_record_id uuid,
  p_event_type text,
  p_from_status text DEFAULT NULL,
  p_to_status text DEFAULT NULL,
  p_actor_role text DEFAULT 'admin',
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.billing_events (
    billing_record_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_role,
    metadata
  ) VALUES (
    p_billing_record_id,
    p_event_type,
    p_from_status,
    p_to_status,
    auth.uid(),
    p_actor_role,
    p_metadata
  );
END;
$$;

ALTER FUNCTION public.log_billing_event(uuid, text, text, text, text, jsonb) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.log_billing_event(uuid, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- =========================================================
-- 11. RPC: prepare_billing_record
-- =========================================================
-- Creates a billing_record with status='prepared'.
-- Server-side snapshot of seller/customer/mission/financial data.
-- Rejects duplicate active primary invoices.
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

  -- Mission must exist
  SELECT * INTO v_mission FROM public.missions WHERE id = p_mission_id;
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

-- =========================================================
-- 12. RPC: link_external_invoice
-- =========================================================
-- Transitions prepared → issued.
-- Sets external_invoice_number, external_invoice_id, issued_at.
-- Single 'issued' event for the atomic transition.
-- =========================================================

CREATE OR REPLACE FUNCTION public.link_external_invoice(
  p_billing_record_id uuid,
  p_external_invoice_number text,
  p_external_invoice_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_record public.billing_records%ROWTYPE;
  v_trimmed_number text;
  v_trimmed_id text;
  v_rows_affected int;
BEGIN
  -- Authorization
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur' USING ERRCODE = '42501';
  END IF;

  -- Validate external number
  v_trimmed_number := btrim(p_external_invoice_number);
  IF v_trimmed_number IS NULL OR v_trimmed_number = '' THEN
    RAISE EXCEPTION 'Le numéro de facture externe est requis' USING ERRCODE = '22023';
  END IF;
  IF length(v_trimmed_number) > 100 THEN
    RAISE EXCEPTION 'Le numéro de facture externe est trop long (max 100 caractères)'
      USING ERRCODE = '22023';
  END IF;

  v_trimmed_id := NULL;
  IF p_external_invoice_id IS NOT NULL THEN
    v_trimmed_id := btrim(p_external_invoice_id);
    IF v_trimmed_id = '' THEN
      v_trimmed_id := NULL;
    END IF;
  END IF;

  -- Load record with lock
  SELECT * INTO v_record
  FROM public.billing_records
  WHERE id = p_billing_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enregistrement de facturation introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_record.status <> 'prepared' THEN
    RAISE EXCEPTION 'Seul un enregistrement préparé peut être émis (status actuel: %)',
      v_record.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Atomic compare-and-swap transition
  UPDATE public.billing_records
  SET
    status = 'issued',
    external_invoice_number = v_trimmed_number,
    external_invoice_id = v_trimmed_id,
    issued_at = now()
  WHERE id = p_billing_record_id
    AND status = 'prepared';

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected = 0 THEN
    RAISE EXCEPTION 'Échec de la transition préparé → émis (conflit concurrent)'
      USING ERRCODE = 'P0001';
  END IF;

  -- Log issued event atomically
  PERFORM public.log_billing_event(
    p_billing_record_id,
    'issued',
    'prepared',
    'issued',
    'admin',
    jsonb_build_object(
      'external_invoice_number', v_trimmed_number,
      'external_invoice_id', v_trimmed_id
    )
  );
END;
$$;

ALTER FUNCTION public.link_external_invoice(uuid, text, text) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.link_external_invoice(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_external_invoice(uuid, text, text) TO authenticated;

-- =========================================================
-- 13. RPC: cancel_billing_record
-- =========================================================
-- Transitions prepared → cancelled.
-- issued → cancelled is FORBIDDEN (terminal state).
-- =========================================================

CREATE OR REPLACE FUNCTION public.cancel_billing_record(
  p_billing_record_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_record public.billing_records%ROWTYPE;
  v_rows_affected int;
BEGIN
  -- Authorization
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Réservé à l''administrateur' USING ERRCODE = '42501';
  END IF;

  -- Load record with lock
  SELECT * INTO v_record
  FROM public.billing_records
  WHERE id = p_billing_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enregistrement de facturation introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_record.status <> 'prepared' THEN
    RAISE EXCEPTION 'Seul un enregistrement préparé peut être annulé (status actuel: %). '
                    'Une facture émise ne peut pas être annulée — créez un avoir dans Indy.',
      v_record.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Atomic compare-and-swap transition
  UPDATE public.billing_records
  SET
    status = 'cancelled',
    cancelled_at = now(),
    notes = COALESCE(p_reason, notes)
  WHERE id = p_billing_record_id
    AND status = 'prepared';

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected = 0 THEN
    RAISE EXCEPTION 'Échec de l''annulation (conflit concurrent)'
      USING ERRCODE = 'P0001';
  END IF;

  -- Log cancelled event atomically
  PERFORM public.log_billing_event(
    p_billing_record_id,
    'cancelled',
    'prepared',
    'cancelled',
    'admin',
    jsonb_build_object('reason', p_reason)
  );
END;
$$;

ALTER FUNCTION public.cancel_billing_record(uuid, text) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.cancel_billing_record(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_billing_record(uuid, text) TO authenticated;

-- =========================================================
-- 14. BILLING WORKFLOW CUTOFF SETTING
-- =========================================================
-- Uses existing app_settings(key text PK, value jsonb).
-- Does NOT overwrite if key already exists.
-- =========================================================

INSERT INTO public.app_settings (key, value, updated_by)
SELECT 'billing_workflow_start_at', to_jsonb(now()), NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.app_settings WHERE key = 'billing_workflow_start_at'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
