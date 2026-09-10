-- =========================================================
-- P3B3 — CRM Opportunities + Pipeline Events
-- =========================================================
-- Third CRM schema layer. Additive only.
-- Does NOT modify any existing table (clients, devis, missions,
-- billing_records, billing_events, organizations, organization_segments,
-- organization_sites, organization_contacts).
--
-- Tables:
--   public.crm_opportunities     (commercial deal object)
--   public.crm_pipeline_events   (auditable, immutable transition log)
--
-- RPC:
--   public.crm_transition_opportunity(uuid, text, text)
--     SECURITY DEFINER, SET search_path = ''
--     Internal-only (is_internal_user). Atomic stage transition + event.
--
-- Triggers:
--   crm_opportunities_contact_org_check   — BEFORE INSERT/UPDATE
--     SECURITY DEFINER. Ensures contact/org integrity (5-state matrix):
--     if contact_id is non-null, organization_id must be non-null and
--     match the contact's organization.
--   crm_opportunities_set_created_by       — BEFORE INSERT
--     SECURITY DEFINER. Sets created_by = auth.uid() server-side.
--     created_by is NOT in the column-level INSERT grant (non-forgeable).
--   crm_opportunities_create_event         — AFTER INSERT
--     SECURITY DEFINER. Creates initial pipeline event
--     (from_stage=NULL, to_stage='lead').
--   crm_pipeline_events_immutable          — BEFORE UPDATE/DELETE
--     Blocks all direct mutation unconditionally.
--
-- Stage mutation + creation hardening (P3B3A + P3B3B):
--   No stage-specific trigger. Primary control is column-level INSERT
--   and UPDATE privileges: authenticated has NO INSERT or UPDATE on
--   stage, lost_reason, created_by, id, created_at, updated_at.
--   crm_transition_opportunity() (SECURITY DEFINER, runs as owner)
--   bypasses column privileges and is the only stage/lost_reason write path.
--   At INSERT time, stage defaults to 'lead' and cannot be overridden
--   by authenticated users (no INSERT privilege on stage column).
--
-- RLS:
--   crm_opportunities: is_internal_user() for SELECT/INSERT/UPDATE.
--     DELETE = admin-only (commercial records with history).
--   crm_pipeline_events: is_internal_user() SELECT only.
--     No INSERT/UPDATE/DELETE for authenticated (RPC-only writes).
--
-- SECURITY DEFINER functions introduced by P3B3 (exactly 4, all with
-- SET search_path = ''):
--   1. public.crm_transition_opportunity (transition RPC)
--   2. public.crm_opportunities_create_event (creation event trigger)
--   3. public.crm_opportunities_check_contact_org (contact/org trigger)
--   4. public.crm_opportunities_set_created_by (created_by trigger)
-- All trigger functions have EXECUTE revoked from PUBLIC, anon, authenticated.
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. TABLE: public.crm_opportunities
-- =========================================================

CREATE TABLE IF NOT EXISTS public.crm_opportunities (
  id                uuid         DEFAULT gen_random_uuid() NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  organization_id   uuid         REFERENCES public.organizations(id) ON DELETE SET NULL,
  contact_id        uuid         REFERENCES public.organization_contacts(id) ON DELETE SET NULL,

  title             text         NOT NULL,

  stage             text         NOT NULL DEFAULT 'lead',

  estimated_value   numeric,
  probability       smallint,

  source            text,
  source_detail     text,
  campaign          text,
  external_reference text,

  lead_first_name   text,
  lead_last_name    text,
  lead_email        text,
  lead_phone        text,

  next_action       text,
  next_action_at   timestamptz,
  last_contact_at  timestamptz,

  lost_reason      text,

  created_by        uuid,

  PRIMARY KEY (id),

  -- title must not be empty/whitespace
  CONSTRAINT crm_opportunities_title_nonempty
    CHECK (btrim(title) <> ''),

  -- stage constrained to allowed pipeline stages
  CONSTRAINT crm_opportunities_stage_check
    CHECK (stage IN (
      'lead',
      'qualified',
      'contacted',
      'meeting',
      'quote_requested',
      'quote_sent',
      'negotiating',
      'won',
      'lost',
      'dormant'
    )),

  -- probability 0..100 when present
  CONSTRAINT crm_opportunities_probability_check
    CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100)),

  -- estimated_value >= 0 when present
  CONSTRAINT crm_opportunities_estimated_value_check
    CHECK (estimated_value IS NULL OR estimated_value >= 0),

  -- lost_reason must be NULL unless stage='lost'
  CONSTRAINT crm_opportunities_lost_reason_invariant
    CHECK (lost_reason IS NULL OR stage = 'lost')
);

ALTER TABLE public.crm_opportunities OWNER TO postgres;

-- =========================================================
-- 2. INDEXES: crm_opportunities
-- =========================================================

CREATE INDEX IF NOT EXISTS crm_opportunities_organization_id_idx
  ON public.crm_opportunities(organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_opportunities_contact_id_idx
  ON public.crm_opportunities(contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_opportunities_stage_idx
  ON public.crm_opportunities(stage);

CREATE INDEX IF NOT EXISTS crm_opportunities_next_action_at_idx
  ON public.crm_opportunities(next_action_at)
  WHERE next_action_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_opportunities_last_contact_at_idx
  ON public.crm_opportunities(last_contact_at)
  WHERE last_contact_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_opportunities_created_at_idx
  ON public.crm_opportunities(created_at);

-- =========================================================
-- 3. TRIGGER: crm_opportunities updated_at
-- =========================================================

DROP TRIGGER IF EXISTS crm_opportunities_set_updated_at ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_set_updated_at
  BEFORE UPDATE ON public.crm_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- 4. TRIGGER: contact/org integrity check
-- =========================================================
-- If both organization_id and contact_id are set, the contact must
-- belong to that organization. Prevents cross-organization mismatch.

CREATE OR REPLACE FUNCTION public.crm_opportunities_check_contact_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contact_org_id uuid;
BEGIN
  -- 5-state contact/org integrity matrix:
  --   org=A, contact=contact(A)  -> ALLOW
  --   org=A, contact=contact(B)  -> DENY (mismatch)
  --   org=NULL, contact=NULL     -> ALLOW (early lead)
  --   org=A, contact=NULL        -> ALLOW (org without specific contact)
  --   org=NULL, contact=contact(A)-> DENY (contact without org is inconsistent)
  --
  -- Invariant: if contact_id is non-null, organization_id must be non-null
  -- AND must equal the contact's organization. This avoids internally
  -- inconsistent CRM records. We do not auto-fill organization_id —
  -- explicit data is easier to audit.
  IF NEW.contact_id IS NOT NULL THEN
    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'Un contact nécessite une organisation (organization_id requis quand contact_id est renseigné)'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT organization_id INTO v_contact_org_id
    FROM public.organization_contacts
    WHERE id = NEW.contact_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Contact introuvable' USING ERRCODE = 'P0002';
    END IF;

    IF v_contact_org_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'Le contact n''appartient pas à cette organisation'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.crm_opportunities_check_contact_org() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_opportunities_check_contact_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_opportunities_contact_org_check ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_contact_org_check
  BEFORE INSERT OR UPDATE ON public.crm_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_opportunities_check_contact_org();

-- =========================================================
-- 4b. TRIGGER: created_by server-derivation (BEFORE INSERT)
-- =========================================================
-- created_by is audit metadata identifying the authenticated creator.
-- It is NOT in the column-level INSERT grant, so authenticated users
-- cannot forge it. This trigger sets it server-side from auth.uid().
-- SECURITY DEFINER so it can call auth.uid() reliably.

CREATE OR REPLACE FUNCTION public.crm_opportunities_set_created_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.created_by := auth.uid();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.crm_opportunities_set_created_by() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_opportunities_set_created_by() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_opportunities_set_created_by ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_set_created_by
  BEFORE INSERT ON public.crm_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_opportunities_set_created_by();

-- =========================================================
-- 5. STAGE MUTATION HARDENING (column-level privileges)
-- =========================================================
-- P3B3A: Removed the BEFORE UPDATE trigger that relied on
-- current_user = 'postgres' as the stage authorization mechanism.
-- That was too broad — any SECURITY DEFINER function running as
-- postgres could bypass it, and role identity alone does not prove
-- the caller is crm_transition_opportunity().
--
-- Primary control is now column-level UPDATE privileges:
--   - REVOKE table-wide UPDATE from authenticated.
--   - GRANT UPDATE only on mutable non-stage, non-lost_reason columns.
--   - stage and lost_reason have NO column-level UPDATE grant for
--     authenticated, so direct UPDATE of those columns is denied at
--     the SQL privilege level.
--   - crm_transition_opportunity() is SECURITY DEFINER (runs as owner
--     postgres) and bypasses column privileges, so it can update stage
--     and lost_reason.
--
-- No stage-specific trigger is needed. The column privilege model is
-- the clean primary invariant and cannot be bypassed by ordinary
-- authenticated CRUD.
--
-- (Trigger function and trigger from P3B3 are dropped if present.)

-- =========================================================
-- 6. TABLE: public.crm_pipeline_events
-- =========================================================
-- Immutable audit log of pipeline transitions. Written only by
-- the transition RPC and the creation-event trigger.

CREATE TABLE IF NOT EXISTS public.crm_pipeline_events (
  id                uuid         DEFAULT gen_random_uuid() NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),

  opportunity_id    uuid         NOT NULL REFERENCES public.crm_opportunities(id) ON DELETE RESTRICT,

  from_stage        text,
  to_stage          text         NOT NULL,

  reason            text,

  actor_user_id     uuid,
  actor_role        text,

  metadata          jsonb        NOT NULL DEFAULT '{}'::jsonb,

  PRIMARY KEY (id),

  -- actor_role constrained to known internal roles
  CONSTRAINT crm_pipeline_events_actor_role_check
    CHECK (actor_role IS NULL OR actor_role IN ('admin', 'operator')),

  -- to_stage must be a valid pipeline stage
  CONSTRAINT crm_pipeline_events_to_stage_check
    CHECK (to_stage IN (
      'lead',
      'qualified',
      'contacted',
      'meeting',
      'quote_requested',
      'quote_sent',
      'negotiating',
      'won',
      'lost',
      'dormant'
    )),

  -- from_stage, when present, must be a valid pipeline stage
  CONSTRAINT crm_pipeline_events_from_stage_check
    CHECK (from_stage IS NULL OR from_stage IN (
      'lead',
      'qualified',
      'contacted',
      'meeting',
      'quote_requested',
      'quote_sent',
      'negotiating',
      'won',
      'lost',
      'dormant'
    ))
);

ALTER TABLE public.crm_pipeline_events OWNER TO postgres;

-- =========================================================
-- 7. INDEXES: crm_pipeline_events
-- =========================================================

CREATE INDEX IF NOT EXISTS crm_pipeline_events_opportunity_created_idx
  ON public.crm_pipeline_events(opportunity_id, created_at);

-- =========================================================
-- 8. TRIGGER: pipeline events immutability
-- =========================================================
-- Blocks UPDATE and DELETE unconditionally (even for postgres).
-- Events are audit evidence and must never be modified.

CREATE OR REPLACE FUNCTION public.crm_pipeline_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'crm_pipeline_events est strictement immutable : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.crm_pipeline_events_immutable() OWNER TO postgres;

DROP TRIGGER IF EXISTS crm_pipeline_events_immutable_trigger ON public.crm_pipeline_events;
CREATE TRIGGER crm_pipeline_events_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.crm_pipeline_events
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_pipeline_events_immutable();

-- =========================================================
-- 9. RLS: crm_opportunities
-- =========================================================

ALTER TABLE public.crm_opportunities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.crm_opportunities FROM PUBLIC;
REVOKE ALL ON public.crm_opportunities FROM anon;
REVOKE ALL ON public.crm_opportunities FROM authenticated;
-- P3B3B: Column-level INSERT + UPDATE privileges.
-- Table-wide INSERT and UPDATE are NOT granted to authenticated.
-- Only mutable non-protected columns get INSERT/UPDATE.
--
-- Protected columns (NOT in INSERT or UPDATE grants):
--   id           — default gen_random_uuid()
--   stage        — default 'lead', writable only via crm_transition_opportunity()
--   lost_reason  — lifecycle controlled by transition RPC
--   created_at   — DB default now()
--   updated_at   — trigger-managed (public.set_updated_at())
--   created_by   — server-derived via BEFORE INSERT trigger (auth.uid())
GRANT SELECT, DELETE ON public.crm_opportunities TO authenticated;
GRANT INSERT (
  organization_id,
  contact_id,
  title,
  estimated_value,
  probability,
  source,
  source_detail,
  campaign,
  external_reference,
  lead_first_name,
  lead_last_name,
  lead_email,
  lead_phone,
  next_action,
  next_action_at,
  last_contact_at
) ON public.crm_opportunities TO authenticated;
GRANT UPDATE (
  organization_id,
  contact_id,
  title,
  estimated_value,
  probability,
  source,
  source_detail,
  campaign,
  external_reference,
  lead_first_name,
  lead_last_name,
  lead_email,
  lead_phone,
  next_action,
  next_action_at,
  last_contact_at
) ON public.crm_opportunities TO authenticated;
-- stage, lost_reason, created_by, id, created_at, updated_at intentionally
-- NOT in the column-level INSERT or UPDATE grants.
GRANT ALL ON public.crm_opportunities TO service_role;

-- SELECT: internal users only.
CREATE POLICY crm_opportunities_select_internal
  ON public.crm_opportunities FOR SELECT TO authenticated
  USING (public.is_internal_user());

-- INSERT: internal users only. Stage defaults to 'lead'.
CREATE POLICY crm_opportunities_insert_internal
  ON public.crm_opportunities FOR INSERT TO authenticated
  WITH CHECK (public.is_internal_user());

-- UPDATE: internal users only. Stage and lost_reason are NOT in the
-- column-level UPDATE grant — they are writable only via the
-- crm_transition_opportunity() SECURITY DEFINER RPC.
CREATE POLICY crm_opportunities_update_internal
  ON public.crm_opportunities FOR UPDATE TO authenticated
  USING (public.is_internal_user())
  WITH CHECK (public.is_internal_user());

-- DELETE: admin-only. Opportunities are commercial records with
-- pipeline history. Operators should use stage='lost' instead.
CREATE POLICY crm_opportunities_delete_admin
  ON public.crm_opportunities FOR DELETE TO authenticated
  USING (public.is_admin());

-- =========================================================
-- 10. RLS: crm_pipeline_events
-- =========================================================
-- SELECT = internal only. No direct INSERT/UPDATE/DELETE for
-- authenticated. Events written only by SECURITY DEFINER functions.

ALTER TABLE public.crm_pipeline_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.crm_pipeline_events FROM PUBLIC;
REVOKE ALL ON public.crm_pipeline_events FROM anon;
REVOKE ALL ON public.crm_pipeline_events FROM authenticated;
GRANT SELECT ON public.crm_pipeline_events TO authenticated;
GRANT ALL ON public.crm_pipeline_events TO service_role;

-- SELECT: internal users only.
CREATE POLICY crm_pipeline_events_select_internal
  ON public.crm_pipeline_events FOR SELECT TO authenticated
  USING (public.is_internal_user());

-- No INSERT/UPDATE/DELETE policies — writes via SECURITY DEFINER
-- functions only (transition RPC + creation-event trigger).

-- =========================================================
-- 11. TRIGGER: initial creation event (AFTER INSERT)
-- =========================================================
-- SECURITY DEFINER so it can insert into crm_pipeline_events
-- (which has no INSERT grant for authenticated).
-- Creates from_stage=NULL, to_stage='lead' event for complete
-- pipeline history from creation.

CREATE OR REPLACE FUNCTION public.crm_opportunities_create_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
BEGIN
  -- Determine actor role from current authorization model.
  IF public.is_admin() THEN
    v_actor_role := 'admin';
  ELSIF public.is_operator() THEN
    v_actor_role := 'operator';
  ELSE
    v_actor_role := NULL;
  END IF;

  INSERT INTO public.crm_pipeline_events (
    opportunity_id,
    from_stage,
    to_stage,
    reason,
    actor_user_id,
    actor_role,
    metadata
  ) VALUES (
    NEW.id,
    NULL,
    NEW.stage,
    'Opportunité créée',
    v_actor_id,
    v_actor_role,
    jsonb_build_object('creation', true)
  );

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.crm_opportunities_create_event() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_opportunities_create_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_opportunities_create_event ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_create_event
  AFTER INSERT ON public.crm_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_opportunities_create_event();

-- =========================================================
-- 12. RPC: crm_transition_opportunity
-- =========================================================
-- SECURITY DEFINER. Internal-only. Atomic stage transition +
-- pipeline event insert. Stage changes via this RPC only.

CREATE OR REPLACE FUNCTION public.crm_transition_opportunity(
  p_opportunity_id uuid,
  p_to_stage text,
  p_reason text DEFAULT NULL
)
RETURNS public.crm_opportunities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_opportunity public.crm_opportunities%ROWTYPE;
  v_from_stage text;
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_allowed boolean := false;
BEGIN
  -- 1. Authorization: internal users only.
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Réservé aux utilisateurs internes' USING ERRCODE = '42501';
  END IF;

  -- Determine actor role (not trusted from frontend).
  IF public.is_admin() THEN
    v_actor_role := 'admin';
  ELSE
    v_actor_role := 'operator';
  END IF;

  -- 2. Lock opportunity row.
  SELECT * INTO v_opportunity
  FROM public.crm_opportunities
  WHERE id = p_opportunity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Opportunité introuvable' USING ERRCODE = 'P0002';
  END IF;

  v_from_stage := v_opportunity.stage;

  -- 4. Reject no-op transition.
  IF v_from_stage = p_to_stage THEN
    RAISE EXCEPTION 'Transition no-op : stage déjà %', p_to_stage
      USING ERRCODE = 'P0001';
  END IF;

  -- 5. Validate allowed transition map.
  -- lead -> qualified, contacted, lost, dormant
  -- qualified -> contacted, meeting, quote_requested, lost, dormant
  -- contacted -> meeting, quote_requested, lost, dormant
  -- meeting -> quote_requested, quote_sent, lost, dormant
  -- quote_requested -> quote_sent, lost, dormant
  -- quote_sent -> negotiating, won, lost, dormant
  -- negotiating -> won, lost, dormant
  -- dormant -> contacted, qualified, lost
  -- won = terminal
  -- lost = terminal
  v_allowed := false;
  CASE v_from_stage
    WHEN 'lead' THEN
      v_allowed := p_to_stage IN ('qualified', 'contacted', 'lost', 'dormant');
    WHEN 'qualified' THEN
      v_allowed := p_to_stage IN ('contacted', 'meeting', 'quote_requested', 'lost', 'dormant');
    WHEN 'contacted' THEN
      v_allowed := p_to_stage IN ('meeting', 'quote_requested', 'lost', 'dormant');
    WHEN 'meeting' THEN
      v_allowed := p_to_stage IN ('quote_requested', 'quote_sent', 'lost', 'dormant');
    WHEN 'quote_requested' THEN
      v_allowed := p_to_stage IN ('quote_sent', 'lost', 'dormant');
    WHEN 'quote_sent' THEN
      v_allowed := p_to_stage IN ('negotiating', 'won', 'lost', 'dormant');
    WHEN 'negotiating' THEN
      v_allowed := p_to_stage IN ('won', 'lost', 'dormant');
    WHEN 'dormant' THEN
      v_allowed := p_to_stage IN ('contacted', 'qualified', 'lost');
    ELSE
      -- won and lost are terminal — no transitions allowed.
      v_allowed := false;
  END CASE;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Transition non autorisée : % -> %', v_from_stage, p_to_stage
      USING ERRCODE = 'P0001';
  END IF;

  -- 6. Update opportunity stage atomically.
  -- 7. Clear lost_reason unless transitioning to lost.
  -- 8. If transitioning to lost, capture reason.
  UPDATE public.crm_opportunities
  SET stage = p_to_stage,
      lost_reason = CASE WHEN p_to_stage = 'lost' THEN p_reason ELSE NULL END
  WHERE id = p_opportunity_id
  RETURNING * INTO v_opportunity;

  -- 9. Insert exactly one pipeline event.
  INSERT INTO public.crm_pipeline_events (
    opportunity_id,
    from_stage,
    to_stage,
    reason,
    actor_user_id,
    actor_role,
    metadata
  ) VALUES (
    p_opportunity_id,
    v_from_stage,
    p_to_stage,
    p_reason,
    v_actor_id,
    v_actor_role,
    jsonb_build_object('transition', true)
  );

  -- 10. Return updated opportunity.
  RETURN v_opportunity;
END;
$$;

ALTER FUNCTION public.crm_transition_opportunity(uuid, text, text) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_transition_opportunity(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_transition_opportunity(uuid, text, text) TO authenticated;

-- =========================================================
-- 13. COMMENTS
-- =========================================================

COMMENT ON TABLE public.crm_opportunities IS
  'CRM commercial opportunity. A prospect is simply stage=lead (no separate prospects table). Stage changes only via crm_transition_opportunity() RPC. Contact/org integrity enforced by trigger. lost_reason NULL unless stage=lost.';

COMMENT ON COLUMN public.crm_opportunities.stage IS
  'Pipeline stage: lead, qualified, contacted, meeting, quote_requested, quote_sent, negotiating, won, lost, dormant. won/lost are terminal. Direct UPDATE of stage is blocked by trigger.';

COMMENT ON COLUMN public.crm_opportunities.lost_reason IS
  'NULL unless stage=lost. Set by crm_transition_opportunity() when transitioning to lost. Reason recommended but not hard-required.';

COMMENT ON TABLE public.crm_pipeline_events IS
  'Immutable audit log of CRM pipeline transitions. Written only by crm_transition_opportunity() RPC and the AFTER INSERT creation trigger. No direct INSERT/UPDATE/DELETE for authenticated. ON DELETE RESTRICT on opportunity FK.';

COMMENT ON FUNCTION public.crm_transition_opportunity(uuid, text, text) IS
  'SECURITY DEFINER. Internal-only. Atomic stage transition + pipeline event. Validates allowed transition map. Clears lost_reason unless transitioning to lost. Returns updated opportunity.';

-- =========================================================
-- 14. SCHEMA CACHE
-- =========================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
