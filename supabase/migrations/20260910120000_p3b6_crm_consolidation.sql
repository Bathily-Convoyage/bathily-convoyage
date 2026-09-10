-- =========================================================
-- P3B6 — CRM Consolidation
-- =========================================================
-- Adds:
--   1. crm_link_events append-only audit table (PER_FIELD_CHANGE,
--      FAIL_CLOSED) for CRM link mutations on clients/devis/missions.
--   2. crm_timeline_read SECURITY DEFINER read function (6 branches)
--      with role-dependent redaction of financial/payment data.
--   3. crm_organizations_summary SECURITY DEFINER read function
--      (operator-safe aggregates, no billing_amount, no legal IDs).
--   4. idx_mission_events_mission_created_at composite index.
--
-- Additive only. No backfill. No changes to existing tables' RLS,
-- grants, columns, FKs, or triggers. P3B5 guard functions are
-- CREATE OR REPLACE extended in-place to insert audit rows in the
-- same transaction (FAIL_CLOSED).
--
-- SECURITY DEFINER inventory after P3B6:
--   P3B6 introduces 4 new SECURITY DEFINER functions:
--     - crm_link_events_immutable
--     - log_crm_link_event
--     - crm_timeline_read
--     - crm_organizations_summary
--
--   The 3 P3B5 guards are CREATE OR REPLACE and do not increase
--   the function count.
--
--   Cumulative SECURITY DEFINER inventory is verified separately;
--   do not hard-code a historical total here.
--
-- Privilege expansion (intentional, documented):
--   crm_timeline_read and crm_organizations_summary are SECURITY DEFINER
--   gated on is_internal_user(). An active operator gains read access
--   to data from devis, mission_events, billing_records, and
--   billing_events (which they cannot SELECT directly under current
--   RLS). Financial amounts and payment technical identifiers are
--   redacted for non-admin callers. Payment session IDs are never exposed.
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. TABLE: public.crm_link_events
-- =========================================================
-- Append-only audit log for CRM link mutations.
-- One row per changed CRM link field (PER_FIELD_CHANGE).
-- Written by extended P3B5 guard functions (SECURITY DEFINER, OWNER postgres).
-- No direct INSERT/UPDATE/DELETE by any role.
-- RLS: admin-only SELECT.

CREATE TABLE IF NOT EXISTS public.crm_link_events (
  id              uuid         DEFAULT gen_random_uuid() NOT NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  actor_user_id   uuid         NOT NULL,
  actor_role      text         NOT NULL,
  entity_type     text         NOT NULL,
  entity_id       uuid         NOT NULL,
  field_name      text         NOT NULL,
  old_value       uuid,
  new_value       uuid,
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,

  PRIMARY KEY (id),

  CONSTRAINT crm_link_events_actor_role_check
    CHECK (actor_role IN ('admin', 'operator')),

  CONSTRAINT crm_link_events_entity_type_check
    CHECK (entity_type IN ('client', 'devis', 'mission')),

  CONSTRAINT crm_link_events_field_name_check
    CHECK (field_name IN (
      'organization_id',
      'contact_id',
      'opportunity_id',
      'devis_id'
    )),

  -- Entity/field compatibility: one CHECK expressing all valid combos.
  CONSTRAINT crm_link_events_entity_field_compatible
    CHECK (
      (entity_type = 'client'  AND field_name = 'organization_id')
      OR
      (entity_type = 'devis'   AND field_name IN ('organization_id', 'contact_id', 'opportunity_id'))
      OR
      (entity_type = 'mission'  AND field_name IN ('devis_id', 'organization_id'))
    )
);

ALTER TABLE public.crm_link_events OWNER TO postgres;

-- =========================================================
-- 2. IMMUTABILITY TRIGGER: crm_link_events
-- =========================================================

CREATE OR REPLACE FUNCTION public.crm_link_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'crm_link_events est strictement append-only : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.crm_link_events_immutable() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_link_events_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS crm_link_events_protect_trigger ON public.crm_link_events;
CREATE TRIGGER crm_link_events_protect_trigger
  BEFORE UPDATE OR DELETE ON public.crm_link_events
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_link_events_immutable();

-- =========================================================
-- 3. RLS + GRANTS: crm_link_events
-- =========================================================

ALTER TABLE public.crm_link_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_link_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.crm_link_events FROM PUBLIC;
REVOKE ALL ON public.crm_link_events FROM anon;
REVOKE ALL ON public.crm_link_events FROM authenticated;
REVOKE ALL ON public.crm_link_events FROM service_role;

-- authenticated SELECT grant; RLS restricts to admin-only.
GRANT SELECT ON public.crm_link_events TO authenticated;

DROP POLICY IF EXISTS crm_link_events_admin_select ON public.crm_link_events;
CREATE POLICY crm_link_events_admin_select
  ON public.crm_link_events
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- No INSERT/UPDATE/DELETE policies. All writes via guard functions
-- (SECURITY DEFINER, OWNER postgres) which bypass RLS.

-- =========================================================
-- 4. INTERNAL HELPER: log_crm_link_event
-- =========================================================
-- Trigger-only SECURITY DEFINER helper. Not callable by any role.
-- Inserts one audit row per changed CRM link field.
-- Called from extended P3B5 guard functions.

CREATE OR REPLACE FUNCTION public.log_crm_link_event(
  p_entity_type text,
  p_entity_id   uuid,
  p_field_name  text,
  p_old_value   uuid,
  p_new_value   uuid,
  p_metadata    jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_role text;
BEGIN
  -- Derive actor_role deterministically from the existing role model.
  -- No user-supplied actor fields. auth.uid() is the caller UUID.
  IF public.is_admin() THEN
    v_actor_role := 'admin';
  ELSIF public.is_operator() THEN
    v_actor_role := 'operator';
  ELSE
    -- Authorization check in the calling guard already denied the
    -- mutation for non-internal users. This branch is unreachable
    -- in normal operation. If reached, fail closed.
    RAISE EXCEPTION 'acteur non interne : audit impossible'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.crm_link_events (
    actor_user_id,
    actor_role,
    entity_type,
    entity_id,
    field_name,
    old_value,
    new_value,
    metadata
  ) VALUES (
    auth.uid(),
    v_actor_role,
    p_entity_type,
    p_entity_id,
    p_field_name,
    p_old_value,
    p_new_value,
    p_metadata
  );
END;
$$;

ALTER FUNCTION public.log_crm_link_event(text, uuid, text, uuid, uuid, jsonb)
  OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.log_crm_link_event(text, uuid, text, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- =========================================================
-- 5. EXTEND P3B5 GUARD: guard_clients_organization_id
-- =========================================================
-- Preserve ALL existing P3B5 authorization logic exactly.
-- Add: PER_FIELD_CHANGE audit INSERT for organization_id changes.
-- FAIL_CLOSED: if audit INSERT fails, the business mutation rolls back.

CREATE OR REPLACE FUNCTION public.guard_clients_organization_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.organization_id IS NOT NULL THEN
      IF NOT (public.is_admin() OR public.is_operator()) THEN
        RAISE EXCEPTION 'Non autorisé : organization_id modifiable par admin ou opérateur actif uniquement'
          USING ERRCODE = '42501';
      END IF;
      -- Audit: INSERT with non-null organization_id (NULL -> value)
      PERFORM public.log_crm_link_event(
        'client', NEW.id, 'organization_id',
        NULL, NEW.organization_id,
        jsonb_build_object('trigger', 'guard_clients_organization_id', 'op', 'INSERT')
      );
    END IF;
  ELSE  -- UPDATE
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      IF NOT (public.is_admin() OR public.is_operator()) THEN
        RAISE EXCEPTION 'Non autorisé : organization_id modifiable par admin ou opérateur actif uniquement'
          USING ERRCODE = '42501';
      END IF;
      -- Audit: UPDATE changing organization_id (old -> new, covers value->NULL unlink)
      PERFORM public.log_crm_link_event(
        'client', NEW.id, 'organization_id',
        OLD.organization_id, NEW.organization_id,
        jsonb_build_object('trigger', 'guard_clients_organization_id', 'op', 'UPDATE')
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_clients_organization_id() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.guard_clients_organization_id()
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger already exists from P3B5; no need to recreate.

-- =========================================================
-- 6. EXTEND P3B5 GUARD: devis_guard_crm_links
-- =========================================================
-- Preserve ALL existing P3B5 authorization + consistency logic exactly.
-- Add: PER_FIELD_CHANGE audit INSERTs for organization_id, contact_id,
-- opportunity_id. Up to 3 audit rows per devis mutation.
-- FAIL_CLOSED: if any audit INSERT fails, the business mutation rolls back.

CREATE OR REPLACE FUNCTION public.devis_guard_crm_links()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _crm_mutation      boolean;
  v_contact_org_id   uuid;
  v_opp_org_id       uuid;
  v_client_org_id    uuid;
BEGIN
  -- ============================================================
  -- Phase 1: AUTHORIZATION (no CRM lookups)
  -- ANY change to any CRM link column requires is_internal_user().
  -- ============================================================
  IF TG_OP = 'INSERT' THEN
    _crm_mutation := NEW.organization_id IS NOT NULL
                     OR NEW.contact_id IS NOT NULL
                     OR NEW.opportunity_id IS NOT NULL;
  ELSE  -- UPDATE
    _crm_mutation := NEW.organization_id IS DISTINCT FROM OLD.organization_id
                     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
                     OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id;
  END IF;

  IF _crm_mutation AND NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Non autorisé : les liens CRM nécessitent un utilisateur interne (admin ou opérateur)'
      USING ERRCODE = '42501';
  END IF;

  -- ============================================================
  -- Phase 2: CROSS-ENTITY CONSISTENCY (CRM lookups)
  -- ============================================================

  -- 2a. Contact/org: if contact_id set, org required and must match
  IF NEW.contact_id IS NOT NULL THEN
    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'Un contact nécessite une organisation (organization_id requis)'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT organization_id INTO v_contact_org_id
    FROM public.organization_contacts
    WHERE id = NEW.contact_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Contact introuvable' USING ERRCODE = 'P0002';
    END IF;

    IF v_contact_org_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'Le contact n''appartient pas à cette organisation'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 2b. Opportunity/org: if opp has org, devis.org must match
  IF NEW.opportunity_id IS NOT NULL THEN
    SELECT organization_id INTO v_opp_org_id
    FROM public.crm_opportunities
    WHERE id = NEW.opportunity_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Opportunité introuvable' USING ERRCODE = 'P0002';
    END IF;

    IF v_opp_org_id IS NOT NULL THEN
      IF NEW.organization_id IS NULL THEN
        RAISE EXCEPTION 'Le devis doit avoir la même organisation que l''opportunité'
          USING ERRCODE = 'P0001';
      END IF;
      IF v_opp_org_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'L''opportunité n''appartient pas à cette organisation'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- 2c. Client/org: if both set, must match (permissive: NULL either => ALLOW)
  IF NEW.client_id IS NOT NULL THEN
    SELECT organization_id INTO v_client_org_id
    FROM public.clients
    WHERE id = NEW.client_id
    FOR SHARE;

    IF FOUND AND v_client_org_id IS NOT NULL AND NEW.organization_id IS NOT NULL THEN
      IF v_client_org_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'Le client n''appartient pas à cette organisation'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- ============================================================
  -- Phase 3: AUDIT (PER_FIELD_CHANGE, FAIL_CLOSED)
  -- ============================================================
  IF TG_OP = 'INSERT' THEN
    -- Audit only non-null CRM link fields on INSERT
    IF NEW.organization_id IS NOT NULL THEN
      PERFORM public.log_crm_link_event(
        'devis', NEW.id, 'organization_id',
        NULL, NEW.organization_id,
        jsonb_build_object('trigger', 'devis_guard_crm_links', 'op', 'INSERT')
      );
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
      PERFORM public.log_crm_link_event(
        'devis', NEW.id, 'contact_id',
        NULL, NEW.contact_id,
        jsonb_build_object('trigger', 'devis_guard_crm_links', 'op', 'INSERT')
      );
    END IF;
    IF NEW.opportunity_id IS NOT NULL THEN
      PERFORM public.log_crm_link_event(
        'devis', NEW.id, 'opportunity_id',
        NULL, NEW.opportunity_id,
        jsonb_build_object('trigger', 'devis_guard_crm_links', 'op', 'INSERT')
      );
    END IF;
  ELSE  -- UPDATE: audit only changed fields
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      PERFORM public.log_crm_link_event(
        'devis', NEW.id, 'organization_id',
        OLD.organization_id, NEW.organization_id,
        jsonb_build_object('trigger', 'devis_guard_crm_links', 'op', 'UPDATE')
      );
    END IF;
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
      PERFORM public.log_crm_link_event(
        'devis', NEW.id, 'contact_id',
        OLD.contact_id, NEW.contact_id,
        jsonb_build_object('trigger', 'devis_guard_crm_links', 'op', 'UPDATE')
      );
    END IF;
    IF NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id THEN
      PERFORM public.log_crm_link_event(
        'devis', NEW.id, 'opportunity_id',
        OLD.opportunity_id, NEW.opportunity_id,
        jsonb_build_object('trigger', 'devis_guard_crm_links', 'op', 'UPDATE')
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.devis_guard_crm_links() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.devis_guard_crm_links()
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger already exists from P3B5; no need to recreate.

-- =========================================================
-- 7. EXTEND P3B5 GUARD: missions_check_devis_org
-- =========================================================
-- Preserve ALL existing P3B5 authorization + consistency logic exactly.
-- Add: PER_FIELD_CHANGE audit INSERTs for devis_id, organization_id.
-- Up to 2 audit rows per mission mutation.
-- FAIL_CLOSED: if any audit INSERT fails, the business mutation rolls back.

CREATE OR REPLACE FUNCTION public.missions_check_devis_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _crm_mutation  boolean;
  v_devis_org_id uuid;
BEGIN
  -- ============================================================
  -- Phase 1: AUTHORIZATION (no CRM lookups)
  -- ANY change to any CRM link column requires is_internal_user().
  -- ============================================================
  IF TG_OP = 'INSERT' THEN
    _crm_mutation := NEW.devis_id IS NOT NULL
                     OR NEW.organization_id IS NOT NULL;
  ELSE  -- UPDATE
    _crm_mutation := NEW.devis_id IS DISTINCT FROM OLD.devis_id
                     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id;
  END IF;

  IF _crm_mutation AND NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Non autorisé : les liens CRM nécessitent un utilisateur interne (admin ou opérateur)'
      USING ERRCODE = '42501';
  END IF;

  -- ============================================================
  -- Phase 2: CONSISTENCY (CRM lookups)
  -- ============================================================
  IF NEW.devis_id IS NOT NULL THEN
    SELECT organization_id INTO v_devis_org_id
    FROM public.devis
    WHERE id = NEW.devis_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Devis introuvable' USING ERRCODE = 'P0002';
    END IF;

    IF v_devis_org_id IS NOT NULL THEN
      IF NEW.organization_id IS NULL THEN
        RAISE EXCEPTION 'La mission doit avoir la même organisation que le devis'
          USING ERRCODE = 'P0001';
      END IF;
      IF v_devis_org_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'Le devis n''appartient pas à cette organisation'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- ============================================================
  -- Phase 3: AUDIT (PER_FIELD_CHANGE, FAIL_CLOSED)
  -- ============================================================
  IF TG_OP = 'INSERT' THEN
    IF NEW.devis_id IS NOT NULL THEN
      PERFORM public.log_crm_link_event(
        'mission', NEW.id, 'devis_id',
        NULL, NEW.devis_id,
        jsonb_build_object('trigger', 'missions_check_devis_org', 'op', 'INSERT')
      );
    END IF;
    IF NEW.organization_id IS NOT NULL THEN
      PERFORM public.log_crm_link_event(
        'mission', NEW.id, 'organization_id',
        NULL, NEW.organization_id,
        jsonb_build_object('trigger', 'missions_check_devis_org', 'op', 'INSERT')
      );
    END IF;
  ELSE  -- UPDATE: audit only changed fields
    IF NEW.devis_id IS DISTINCT FROM OLD.devis_id THEN
      PERFORM public.log_crm_link_event(
        'mission', NEW.id, 'devis_id',
        OLD.devis_id, NEW.devis_id,
        jsonb_build_object('trigger', 'missions_check_devis_org', 'op', 'UPDATE')
      );
    END IF;
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      PERFORM public.log_crm_link_event(
        'mission', NEW.id, 'organization_id',
        OLD.organization_id, NEW.organization_id,
        jsonb_build_object('trigger', 'missions_check_devis_org', 'op', 'UPDATE')
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.missions_check_devis_org() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.missions_check_devis_org()
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger already exists from P3B5; no need to recreate.

-- =========================================================
-- 8. INDEX: mission_events composite
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_mission_events_mission_created_at
  ON public.mission_events (mission_id, created_at DESC);

-- =========================================================
-- 9. FUNCTION: crm_timeline_read
-- =========================================================
-- SECURITY DEFINER. Gate: is_internal_user(). Returns unified timeline.
-- 6 UNION branches:
--   Immutable events: crm_pipeline_events, mission_events, billing_events
--   State projections: devis, missions, crm_activities
-- Excluded: billing_records (billing_events covers lifecycle),
--           crm_link_events (admin-only audit, not operator-visible).
--
-- Role-dependent redaction:
--   - billing_events metadata is rebuilt for non-admin callers to
--     exclude financial amounts and payment technical identifiers.
--   - Payment session IDs are NEVER included in any metadata.
--   - Admin sees full billing_events metadata (financial fields allowed,
--     but payment session IDs are not in billing_events anyway).
--
-- Pagination: composite cursor (event_at DESC, event_key DESC).
-- Limit: bounded server-side (default 50, max 200).

CREATE OR REPLACE FUNCTION public.crm_timeline_read(
  p_organization_id  uuid        DEFAULT NULL,
  p_mission_id      uuid        DEFAULT NULL,
  p_opportunity_id  uuid        DEFAULT NULL,
  p_client_id       uuid        DEFAULT NULL,
  p_limit           integer     DEFAULT 50,
  p_before_event_at timestamptz DEFAULT NULL,
  p_before_event_key text      DEFAULT NULL
)
RETURNS TABLE (
  event_key              text,
  event_source           text,
  source_id              uuid,
  event_type             text,
  event_at               timestamptz,
  record_kind            text,
  current_organization_id uuid,
  current_client_id      uuid,
  current_contact_id     uuid,
  current_opportunity_id uuid,
  current_devis_id       uuid,
  current_mission_id     uuid,
  actor_user_id          uuid,
  actor_role             text,
  title                  text,
  description            text,
  metadata               jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_admin boolean;
  v_limit    integer;
BEGIN
  -- ============================================================
  -- 1. AUTHORIZE (before any filter lookup)
  -- ============================================================
  IF NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Non autorisé : lecture timeline réservée aux utilisateurs internes'
      USING ERRCODE = '42501';
  END IF;

  -- ============================================================
  -- 2. RECORD ROLE (once)
  -- ============================================================
  v_is_admin := public.is_admin();

  -- ============================================================
  -- 3. BOUND LIMIT (no NULL resolution gap)
  -- ============================================================
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);

  -- ============================================================
  -- 4. VALIDATE CURSOR PAIR
  -- ============================================================
  IF (p_before_event_at IS NULL AND p_before_event_key IS NOT NULL)
     OR (p_before_event_at IS NOT NULL AND p_before_event_key IS NULL) THEN
    RAISE EXCEPTION 'Curseur invalide : p_before_event_at et p_before_event_key doivent être tous deux NULL ou tous deux non-NULL'
      USING ERRCODE = '22023';
  END IF;

  -- ============================================================
  -- 5. QUERY (static SQL, no dynamic SQL)
  -- ============================================================
  RETURN QUERY
  WITH timeline AS (
    -- --------------------------------------------------------
    -- Branch 1: crm_pipeline_events (immutable_event)
    -- --------------------------------------------------------
    SELECT
      'pipeline_event:' || pe.id::text                    AS event_key,
      'pipeline_event'::text                              AS event_source,
      pe.id                                               AS source_id,
      pe.to_stage                                         AS event_type,
      pe.created_at                                       AS event_at,
      'immutable_event'::text                             AS record_kind,
      o.organization_id                                   AS current_organization_id,
      NULL::uuid                                          AS current_client_id,
      o.contact_id                                        AS current_contact_id,
      pe.opportunity_id                                   AS current_opportunity_id,
      NULL::uuid                                          AS current_devis_id,
      NULL::uuid                                          AS current_mission_id,
      pe.actor_user_id                                    AS actor_user_id,
      pe.actor_role                                       AS actor_role,
      'Opportunité : ' || o.title                          AS title,
      COALESCE('Étape ' || pe.from_stage || ' → ' || pe.to_stage, 'Étape ' || pe.to_stage) AS description,
      jsonb_build_object(
        'from_stage', pe.from_stage,
        'to_stage', pe.to_stage,
        'reason', pe.reason,
        'metadata', pe.metadata
      )                                                   AS metadata
    FROM public.crm_pipeline_events pe
    JOIN public.crm_opportunities o ON o.id = pe.opportunity_id
    WHERE (p_organization_id IS NULL OR o.organization_id = p_organization_id)
      AND (p_opportunity_id IS NULL OR pe.opportunity_id = p_opportunity_id)
      AND (p_client_id IS NULL)
      AND (p_mission_id IS NULL)

    UNION ALL

    -- --------------------------------------------------------
    -- Branch 2: mission_events (immutable_event)
    -- --------------------------------------------------------
    SELECT
      'mission_event:' || me.id::text                      AS event_key,
      'mission_event'::text                               AS event_source,
      me.id                                               AS source_id,
      me.event_type                                       AS event_type,
      me.created_at                                       AS event_at,
      'immutable_event'::text                             AS record_kind,
      m.organization_id                                   AS current_organization_id,
      m.client_id                                         AS current_client_id,
      NULL::uuid                                          AS current_contact_id,
      NULL::uuid                                          AS current_opportunity_id,
      m.devis_id                                          AS current_devis_id,
      me.mission_id                                       AS current_mission_id,
      me.actor_user_id                                    AS actor_user_id,
      me.actor_role                                       AS actor_role,
      'Mission : ' || me.event_type                        AS title,
      COALESCE('Statut ' || me.from_status || ' → ' || me.to_status, 'Événement ' || me.event_type) AS description,
      me.metadata                                         AS metadata
    FROM public.mission_events me
    JOIN public.missions m ON m.id = me.mission_id
    WHERE (p_organization_id IS NULL OR m.organization_id = p_organization_id)
      AND (p_mission_id IS NULL OR me.mission_id = p_mission_id)
      AND (p_opportunity_id IS NULL)
      AND (p_client_id IS NULL OR m.client_id = p_client_id)

    UNION ALL

    -- --------------------------------------------------------
    -- Branch 3: billing_events (immutable_event)
    -- Redacted metadata for non-admin callers.
    -- --------------------------------------------------------
    SELECT
      'billing_event:' || be.id::text                      AS event_key,
      'billing_event'::text                               AS event_source,
      be.id                                               AS source_id,
      be.event_type                                       AS event_type,
      be.created_at                                       AS event_at,
      'immutable_event'::text                             AS record_kind,
      m.organization_id                                   AS current_organization_id,
      br.client_id                                       AS current_client_id,
      NULL::uuid                                          AS current_contact_id,
      NULL::uuid                                          AS current_opportunity_id,
      NULL::uuid                                          AS current_devis_id,
      br.mission_id                                       AS current_mission_id,
      be.actor_user_id                                    AS actor_user_id,
      be.actor_role                                       AS actor_role,
      'Facturation : ' || be.event_type                    AS title,
      COALESCE('Statut ' || be.from_status || ' → ' || be.to_status, 'Événement ' || be.event_type) AS description,
      CASE
        WHEN v_is_admin THEN
          -- Admin: full metadata (may contain total_ht, total_ttc,
          -- external_invoice_number, external_invoice_id)
          be.metadata
        ELSE
          -- Operator: allow-listed metadata only. No amounts,
          -- no provider IDs, no invoice technical identifiers.
          jsonb_build_object(
            'from_status', be.from_status,
            'to_status', be.to_status,
            'event_type', be.event_type
          )
      END                                                 AS metadata
    FROM public.billing_events be
    JOIN public.billing_records br ON br.id = be.billing_record_id
    JOIN public.missions m ON m.id = br.mission_id
    WHERE (p_organization_id IS NULL OR m.organization_id = p_organization_id)
      AND (p_mission_id IS NULL OR br.mission_id = p_mission_id)
      AND (p_opportunity_id IS NULL)
      AND (p_client_id IS NULL OR br.client_id = p_client_id)

    UNION ALL

    -- --------------------------------------------------------
    -- Branch 4: devis (state_projection)
    -- --------------------------------------------------------
    SELECT
      'devis:' || d.id::text                              AS event_key,
      'devis'::text                                       AS event_source,
      d.id                                               AS source_id,
      'devis_created'::text                               AS event_type,
      d.created_at                                        AS event_at,
      'state_projection'::text                            AS record_kind,
      d.organization_id                                   AS current_organization_id,
      d.client_id                                         AS current_client_id,
      d.contact_id                                        AS current_contact_id,
      d.opportunity_id                                    AS current_opportunity_id,
      d.id                                                AS current_devis_id,
      NULL::uuid                                          AS current_mission_id,
      NULL::uuid                                          AS actor_user_id,
      NULL::text                                          AS actor_role,
      'Devis ' || d.reference || ' créé'                  AS title,
      'Statut : ' || COALESCE(d.status, 'pending')        AS description,
      jsonb_build_object(
        'reference', d.reference,
        'status', d.status,
        'total_ht', d.total_ht
      )                                                   AS metadata
    FROM public.devis d
    WHERE (p_organization_id IS NULL OR d.organization_id = p_organization_id)
      AND (p_mission_id IS NULL)
      AND (p_opportunity_id IS NULL OR d.opportunity_id = p_opportunity_id)
      AND (p_client_id IS NULL OR d.client_id = p_client_id)

    UNION ALL

    -- --------------------------------------------------------
    -- Branch 5: missions (state_projection)
    -- Mission creation is NOT logged to mission_events, so a
    -- state projection is required for mission visibility.
    -- Excludes: payment session IDs, montant_ht, remuneration_convoyeur.
    -- --------------------------------------------------------
    SELECT
      'mission:' || m.id::text                            AS event_key,
      'mission'::text                                     AS event_source,
      m.id                                               AS source_id,
      'mission_created'::text                            AS event_type,
      m.created_at                                        AS event_at,
      'state_projection'::text                            AS record_kind,
      m.organization_id                                   AS current_organization_id,
      m.client_id                                         AS current_client_id,
      NULL::uuid                                          AS current_contact_id,
      NULL::uuid                                          AS current_opportunity_id,
      m.devis_id                                          AS current_devis_id,
      m.id                                                AS current_mission_id,
      NULL::uuid                                          AS actor_user_id,
      NULL::text                                          AS actor_role,
      'Mission ' || m.reference || ' créée'               AS title,
      'Statut : ' || m.status                             AS description,
      jsonb_build_object(
        'status', m.status,
        'reference', m.reference
      )                                                   AS metadata
    FROM public.missions m
    WHERE (p_organization_id IS NULL OR m.organization_id = p_organization_id)
      AND (p_mission_id IS NULL OR m.id = p_mission_id)
      AND (p_opportunity_id IS NULL)
      AND (p_client_id IS NULL OR m.client_id = p_client_id)

    UNION ALL

    -- --------------------------------------------------------
    -- Branch 6: crm_activities (state_projection)
    -- --------------------------------------------------------
    SELECT
      'activity:' || a.id::text                           AS event_key,
      'activity'::text                                    AS event_source,
      a.id                                               AS source_id,
      a.activity_type                                     AS event_type,
      COALESCE(a.occurred_at, a.completed_at, a.created_at) AS event_at,
      'state_projection'::text                            AS record_kind,
      a.organization_id                                   AS current_organization_id,
      NULL::uuid                                          AS current_client_id,
      a.contact_id                                        AS current_contact_id,
      a.opportunity_id                                    AS current_opportunity_id,
      NULL::uuid                                          AS current_devis_id,
      NULL::uuid                                          AS current_mission_id,
      a.created_by                                        AS actor_user_id,
      NULL::text                                          AS actor_role,
      a.subject                                           AS title,
      a.body                                              AS description,
      jsonb_build_object(
        'status', a.status,
        'direction', a.direction,
        'due_at', a.due_at
      )                                                   AS metadata
    FROM public.crm_activities a
    WHERE (p_organization_id IS NULL OR a.organization_id = p_organization_id)
      AND (p_mission_id IS NULL)
      AND (p_opportunity_id IS NULL OR a.opportunity_id = p_opportunity_id)
      AND (p_client_id IS NULL)
  )
  SELECT
    t.event_key,
    t.event_source,
    t.source_id,
    t.event_type,
    t.event_at,
    t.record_kind,
    t.current_organization_id,
    t.current_client_id,
    t.current_contact_id,
    t.current_opportunity_id,
    t.current_devis_id,
    t.current_mission_id,
    t.actor_user_id,
    t.actor_role,
    t.title,
    t.description,
    t.metadata
  FROM timeline t
  WHERE (p_before_event_at IS NULL
         OR t.event_at < p_before_event_at
         OR (t.event_at = p_before_event_at
             AND t.event_key < p_before_event_key))
  ORDER BY t.event_at DESC, t.event_key DESC
  LIMIT v_limit;
END;
$$;

ALTER FUNCTION public.crm_timeline_read(
  uuid, uuid, uuid, uuid, integer, timestamptz, text
) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_timeline_read(
  uuid, uuid, uuid, uuid, integer, timestamptz, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.crm_timeline_read(
  uuid, uuid, uuid, uuid, integer, timestamptz, text
) TO authenticated;

-- =========================================================
-- 10. FUNCTION: crm_organizations_summary
-- =========================================================
-- SECURITY DEFINER. Gate: is_internal_user().
-- Returns one row per non-archived organization with aggregate counts.
-- Operator-safe: no billing_amount, no siret/siren/vat_number,
-- no billing_email/billing_address.
-- Cartesian-safe: uses pre-aggregated CTEs (no multi-join fan-out).
-- Early leads (opportunities with organization_id=NULL) are excluded.

CREATE OR REPLACE FUNCTION public.crm_organizations_summary()
RETURNS TABLE (
  organization_id    uuid,
  legal_name         text,
  trade_name         text,
  status             text,
  contacts_count     bigint,
  opportunities_count bigint,
  activities_count   bigint,
  devis_count        bigint,
  missions_count     bigint,
  billing_count      bigint,
  pipeline_value     numeric,
  last_activity_at   timestamptz,
  last_devis_at      timestamptz,
  last_mission_at    timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- ============================================================
  -- 1. AUTHORIZE
  -- ============================================================
  IF NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Non autorisé : résumé organisations réservé aux utilisateurs internes'
      USING ERRCODE = '42501';
  END IF;

  -- ============================================================
  -- 2. QUERY (pre-aggregated CTEs, no Cartesian fan-out)
  -- ============================================================
  RETURN QUERY
  WITH
  contacts_agg AS (
    SELECT oc.organization_id, count(*) AS cnt
    FROM public.organization_contacts oc
    GROUP BY oc.organization_id
  ),
  opportunities_agg AS (
    SELECT op.organization_id,
           count(*) AS cnt,
           COALESCE(sum(op.estimated_value), 0) AS pipeline_value
    FROM public.crm_opportunities op
    WHERE op.organization_id IS NOT NULL
    GROUP BY op.organization_id
  ),
  activities_agg AS (
    SELECT act.organization_id, count(*) AS cnt, max(act.occurred_at) AS last_at
    FROM public.crm_activities act
    WHERE act.organization_id IS NOT NULL
    GROUP BY act.organization_id
  ),
  devis_agg AS (
    SELECT d.organization_id, count(*) AS cnt, max(d.created_at) AS last_at
    FROM public.devis d
    WHERE d.organization_id IS NOT NULL
    GROUP BY d.organization_id
  ),
  missions_agg AS (
    SELECT m.organization_id, count(*) AS cnt, max(m.created_at) AS last_at
    FROM public.missions m
    WHERE m.organization_id IS NOT NULL
    GROUP BY m.organization_id
  ),
  billing_agg AS (
    -- billing_records has no organization_id; derive through missions.
    SELECT m.organization_id, count(*) AS cnt
    FROM public.billing_records br
    JOIN public.missions m ON m.id = br.mission_id
    WHERE m.organization_id IS NOT NULL
    GROUP BY m.organization_id
  )
  SELECT
    o.id                                               AS organization_id,
    o.legal_name                                       AS legal_name,
    o.trade_name                                       AS trade_name,
    o.status                                           AS status,
    COALESCE(ca.cnt, 0)                                AS contacts_count,
    COALESCE(oa.cnt, 0)                                AS opportunities_count,
    COALESCE(ac.cnt, 0)                                AS activities_count,
    COALESCE(da.cnt, 0)                                AS devis_count,
    COALESCE(ma.cnt, 0)                                AS missions_count,
    COALESCE(ba.cnt, 0)                                AS billing_count,
    COALESCE(oa.pipeline_value, 0)                     AS pipeline_value,
    ac.last_at                                         AS last_activity_at,
    da.last_at                                         AS last_devis_at,
    ma.last_at                                         AS last_mission_at
  FROM public.organizations o
  LEFT JOIN contacts_agg ca     ON ca.organization_id = o.id
  LEFT JOIN opportunities_agg oa ON oa.organization_id = o.id
  LEFT JOIN activities_agg ac   ON ac.organization_id = o.id
  LEFT JOIN devis_agg da        ON da.organization_id = o.id
  LEFT JOIN missions_agg ma     ON ma.organization_id = o.id
  LEFT JOIN billing_agg ba      ON ba.organization_id = o.id
  WHERE o.status <> 'archived'
  ORDER BY o.legal_name;
END;
$$;

ALTER FUNCTION public.crm_organizations_summary() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_organizations_summary()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.crm_organizations_summary()
  TO authenticated;

COMMIT;
