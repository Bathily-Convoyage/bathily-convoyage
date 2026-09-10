-- =========================================================
-- P3B4 — CRM Activities / Tasks / Interactions
-- =========================================================
-- Fourth CRM schema layer. Additive only.
-- Does NOT modify any existing table (clients, devis, missions,
-- billing_records, billing_events, organizations, organization_segments,
-- organization_sites, organization_contacts, crm_opportunities,
-- crm_pipeline_events).
--
-- Table:
--   public.crm_activities
--     Unified activity log: calls, emails, meetings, notes,
--     tasks, follow-ups, reminders. A task is activity_type='task'
--     with status='pending'. No separate task table.
--
-- Triggers:
--   crm_activities_set_updated_at   — BEFORE UPDATE
--     Reuses public.set_updated_at() (no duplicate helper).
--   crm_activities_check_cross_entity — BEFORE INSERT/UPDATE
--     SECURITY DEFINER. Enforces cross-entity organization consistency:
--     - If contact_id is set, organization_id must be non-null and
--       match the contact's organization.
--     - If opportunity_id is set and the opportunity has an organization,
--       activity.organization_id must match opportunity.organization_id.
--   crm_activities_set_created_by    — BEFORE INSERT
--     SECURITY DEFINER. Sets created_by = auth.uid() server-side.
--     created_by is NOT in the column-level INSERT grant (non-forgeable).
--
-- RLS:
--   crm_activities: is_internal_user() for SELECT/INSERT/UPDATE.
--     DELETE = admin-only (activity history has audit value).
--
-- Service role trust boundary (P3B3C principle):
--   service_role is an application credential, NOT a database owner.
--   Column-level INSERT/UPDATE on business columns only.
--   No access to created_by, id, created_at, updated_at.
--
-- SECURITY DEFINER functions introduced by P3B4 (exactly 2, all with
-- SET search_path = ''):
--   1. public.crm_activities_check_cross_entity (cross-entity trigger)
--   2. public.crm_activities_set_created_by (created_by trigger)
-- All trigger functions have EXECUTE revoked from PUBLIC, anon, authenticated.
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. TABLE: public.crm_activities
-- =========================================================

CREATE TABLE IF NOT EXISTS public.crm_activities (
  id              uuid         DEFAULT gen_random_uuid() NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),

  organization_id  uuid         REFERENCES public.organizations(id) ON DELETE SET NULL,
  contact_id       uuid         REFERENCES public.organization_contacts(id) ON DELETE SET NULL,
  opportunity_id   uuid         REFERENCES public.crm_opportunities(id) ON DELETE SET NULL,

  activity_type    text         NOT NULL,
  direction        text,
  subject          text         NOT NULL,
  body             text,

  status           text         NOT NULL DEFAULT 'completed',

  occurred_at      timestamptz,
  due_at           timestamptz,
  completed_at     timestamptz,

  assigned_to      uuid         REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by       uuid         NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  metadata         jsonb        NOT NULL DEFAULT '{}'::jsonb,

  PRIMARY KEY (id),

  -- Activity types
  CONSTRAINT crm_activities_activity_type_check
    CHECK (activity_type IN (
      'call',
      'email',
      'meeting',
      'note',
      'task',
      'follow_up',
      'sms',
      'whatsapp',
      'other'
    )),

  -- Direction (nullable for non-communication types)
  CONSTRAINT crm_activities_direction_check
    CHECK (direction IS NULL OR direction IN ('inbound', 'outbound', 'internal')),

  -- Status model
  CONSTRAINT crm_activities_status_check
    CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),

  -- Non-empty trimmed subject
  CONSTRAINT crm_activities_subject_check
    CHECK (btrim(subject) <> '')
);

-- =========================================================
-- 2. INDEXES
-- =========================================================

CREATE INDEX IF NOT EXISTS crm_activities_organization_id
  ON public.crm_activities (organization_id);

CREATE INDEX IF NOT EXISTS crm_activities_contact_id
  ON public.crm_activities (contact_id);

CREATE INDEX IF NOT EXISTS crm_activities_opportunity_id
  ON public.crm_activities (opportunity_id);

CREATE INDEX IF NOT EXISTS crm_activities_activity_type
  ON public.crm_activities (activity_type);

CREATE INDEX IF NOT EXISTS crm_activities_status
  ON public.crm_activities (status);

CREATE INDEX IF NOT EXISTS crm_activities_due_at
  ON public.crm_activities (due_at);

CREATE INDEX IF NOT EXISTS crm_activities_occurred_at
  ON public.crm_activities (occurred_at);

CREATE INDEX IF NOT EXISTS crm_activities_created_at
  ON public.crm_activities (created_at);

CREATE INDEX IF NOT EXISTS crm_activities_assigned_to
  ON public.crm_activities (assigned_to);

-- Partial index: pending tasks by due_at (for task/follow-up workflow)
CREATE INDEX IF NOT EXISTS crm_activities_pending_due_at
  ON public.crm_activities (due_at)
  WHERE status IN ('pending', 'in_progress');

-- =========================================================
-- 3. TRIGGER: updated_at (reuse existing helper)
-- =========================================================

DROP TRIGGER IF EXISTS crm_activities_set_updated_at ON public.crm_activities;
CREATE TRIGGER crm_activities_set_updated_at
  BEFORE UPDATE ON public.crm_activities
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- 4. TRIGGER: cross-entity organization integrity (BEFORE INSERT/UPDATE)
-- =========================================================
-- SECURITY DEFINER so it can read organization_contacts and
-- crm_opportunities regardless of caller RLS.
--
-- Invariants:
--   1. If contact_id is non-null, organization_id must be non-null
--      AND match the contact's organization.
--   2. If opportunity_id is non-null and the opportunity has a
--      non-null organization_id, activity.organization_id must match
--      opportunity.organization_id.
--   3. If opportunity_id is non-null and the opportunity has a
--      non-null contact_id, we do NOT require activity.contact_id to
--      equal opportunity.contact_id (an opportunity may involve several
--      contacts over time). But if activity.contact_id is also set,
--      it must be consistent (rule 1 applies).
--   4. If assigned_to is non-null, the target user must be an active
--      internal user: an admin (user_roles role='admin') or an active
--      operator (user_roles role='operator' AND internal_operators.active
--      = true). Clients, convoyeurs, inactive operators, and unknown
--      users are rejected. Admin takes precedence where roles overlap.
--
-- P3B4C CONCURRENCY: Parent rows (organization_contacts,
-- crm_opportunities) are locked FOR SHARE before reading their
-- organization_id. FOR SHARE conflicts with the parent UPDATE
-- (FOR NO KEY UPDATE), so child validation and parent reparent
-- serialize: whichever acquires the lock first commits first, and
-- the other operation validates against the committed state.
-- Lock order: contact before opportunity (deterministic, no cycle).

CREATE OR REPLACE FUNCTION public.crm_activities_check_cross_entity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contact_org_id    uuid;
  v_opp_org_id        uuid;
  v_is_admin          boolean;
  v_is_active_op      boolean;
BEGIN
  -- Rule 1: contact_id requires matching organization_id
  IF NEW.contact_id IS NOT NULL THEN
    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'Un contact nécessite une organisation (organization_id requis quand contact_id est renseigné)'
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

  -- Rule 2: opportunity organization must match activity organization
  IF NEW.opportunity_id IS NOT NULL THEN
    SELECT organization_id INTO v_opp_org_id
    FROM public.crm_opportunities
    WHERE id = NEW.opportunity_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Opportunité introuvable' USING ERRCODE = 'P0002';
    END IF;

    IF v_opp_org_id IS NOT NULL AND v_opp_org_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'L''opportunité n''appartient pas à cette organisation'
        USING ERRCODE = 'P0001';
    END IF;

    -- If activity has no organization but opportunity does, that's a
    -- cross-org inconsistency — reject.
    IF v_opp_org_id IS NOT NULL AND NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'L''activité doit avoir la même organisation que l''opportunité'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Rule 4: assigned_to must be an active internal user (admin or active operator).
  -- P3B4B: Admin semantics now match public.is_admin() exactly — both the
  -- user_roles path AND the legacy clients.role='admin' path are recognized.
  IF NEW.assigned_to IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = NEW.assigned_to AND ur.role = 'admin'
    )
    OR EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.role = 'admin' AND c.auth_user_id = NEW.assigned_to
    ) INTO v_is_admin;

    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.internal_operators io ON io.user_id = ur.user_id
      WHERE ur.user_id = NEW.assigned_to
        AND ur.role = 'operator'
        AND io.active = true
    ) INTO v_is_active_op;

    IF NOT v_is_admin AND NOT v_is_active_op THEN
      RAISE EXCEPTION 'L''assigné doit être un utilisateur interne actif (admin ou opérateur actif)'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.crm_activities_check_cross_entity() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_activities_check_cross_entity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_activities_check_cross_entity ON public.crm_activities;
CREATE TRIGGER crm_activities_check_cross_entity
  BEFORE INSERT OR UPDATE ON public.crm_activities
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_activities_check_cross_entity();

-- =========================================================
-- 4b. TRIGGER: created_by server-derivation (BEFORE INSERT)
-- =========================================================
-- created_by is audit metadata identifying the authenticated creator.
-- It is NOT in the column-level INSERT grant, so authenticated users
-- cannot forge it. This trigger sets it server-side from auth.uid().

CREATE OR REPLACE FUNCTION public.crm_activities_set_created_by()
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

ALTER FUNCTION public.crm_activities_set_created_by() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_activities_set_created_by() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_activities_set_created_by ON public.crm_activities;
CREATE TRIGGER crm_activities_set_created_by
  BEFORE INSERT ON public.crm_activities
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_activities_set_created_by();

-- =========================================================
-- 4c. PARENT GUARD: organization_contacts.organization_id
-- =========================================================
-- P3B4B: Protects the CRM graph from cross-organization
-- inconsistency. A contact organization change is rejected if it
-- would leave any dependent opportunity or activity inconsistent.
--
-- organization_contacts.organization_id is NOT NULL, so only A->B
-- transitions are possible (never -> NULL).
--
-- Invariants enforced:
--   - No crm_opportunities.contact_id = NEW.id with
--     organization_id IS DISTINCT FROM NEW.organization_id
--     (would violate P3B3 crm_opportunities_check_contact_org).
--   - No crm_activities.contact_id = NEW.id with
--     organization_id IS DISTINCT FROM NEW.organization_id
--     (would violate P3B4 crm_activities_check_cross_entity rule 1).
--
-- No automatic cascade. The guard ALLOWs safe transitions or
-- REJECTs unsafe ones. Exceptional graph migrations require an
-- explicit admin-only atomic operation (future).

CREATE OR REPLACE FUNCTION public.organization_contacts_guard_reparent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conflict_count integer;
BEGIN
  -- No-op if organization_id unchanged
  IF OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
    RETURN NEW;
  END IF;

  -- Check dependent opportunities (P3B3: contact requires matching org)
  SELECT count(*) INTO v_conflict_count
  FROM public.crm_opportunities o
  WHERE o.contact_id = NEW.id
    AND o.organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Le changement d''organisation du contact rendrait des opportunités incohérentes'
      USING ERRCODE = 'P0001';
  END IF;

  -- Check dependent activities (P3B4: contact requires matching org)
  SELECT count(*) INTO v_conflict_count
  FROM public.crm_activities a
  WHERE a.contact_id = NEW.id
    AND a.organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Le changement d''organisation du contact rendrait des activités incohérentes'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.organization_contacts_guard_reparent() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.organization_contacts_guard_reparent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organization_contacts_guard_reparent ON public.organization_contacts;
CREATE TRIGGER organization_contacts_guard_reparent
  BEFORE UPDATE OF organization_id ON public.organization_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.organization_contacts_guard_reparent();

-- =========================================================
-- 4d. PARENT GUARD: crm_opportunities.organization_id
-- =========================================================
-- P3B4B: Protects the CRM graph from cross-organization
-- inconsistency. An opportunity organization change is rejected
-- if it would leave any linked activity inconsistent.
--
-- crm_opportunities.organization_id is nullable, so transitions
-- include A->B, A->NULL, NULL->A.
--
-- P3B4 activity rule: if opp.org is non-null, activity.org must
-- match. If opp.org is NULL, activity.org is unconstrained.
-- Therefore:
--   - NEW.organization_id = NULL -> always ALLOW (NULL opp doesn't
--     constrain activities).
--   - NEW.organization_id = non-null -> DENY if any linked activity
--     has organization_id IS DISTINCT FROM NEW.organization_id.
--
-- P3B3 contact/org integrity (crm_opportunities_check_contact_org)
-- is already enforced by the existing P3B3 trigger and is not
-- duplicated here. This guard only covers the activity dimension.
--
-- No automatic cascade.

CREATE OR REPLACE FUNCTION public.crm_opportunities_guard_reparent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conflict_count integer;
BEGIN
  -- No-op if organization_id unchanged
  IF OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
    RETURN NEW;
  END IF;

  -- NULL organization doesn't constrain activities (P3B4 rule)
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Non-null NEW organization: any linked activity with a
  -- mismatched (or NULL) organization_id would become inconsistent.
  SELECT count(*) INTO v_conflict_count
  FROM public.crm_activities a
  WHERE a.opportunity_id = NEW.id
    AND a.organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Le changement d''organisation de l''opportunité rendrait des activités incohérentes'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.crm_opportunities_guard_reparent() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_opportunities_guard_reparent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS crm_opportunities_guard_reparent ON public.crm_opportunities;
CREATE TRIGGER crm_opportunities_guard_reparent
  BEFORE UPDATE OF organization_id ON public.crm_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.crm_opportunities_guard_reparent();

-- =========================================================
-- 4e. P3B4C: Harden P3B3 crm_opportunities_check_contact_org
-- =========================================================
-- P3B3's crm_opportunities_check_contact_org() used a plain SELECT
-- (ACCESS SHARE) on organization_contacts, which does NOT conflict
-- with a concurrent contact reparent (FOR NO KEY UPDATE). A race
-- could allow an opportunity INSERT to validate against a stale
-- contact org and commit, then the contact reparents, leaving the
-- opportunity/contact graph inconsistent.
--
-- P3B4C replaces the function with identical semantics plus a
-- FOR SHARE lock on the contact row. FOR SHARE conflicts with the
-- parent UPDATE, serializing opportunity validation and contact
-- reparent. The trigger from P3B3 continues to fire; only the
-- function body is hardened.
--
-- P3B3 semantic behavior is preserved exactly:
--   - contact_id non-null => organization_id non-null AND matches
--   - contact_id null => no constraint
--   - error messages unchanged

CREATE OR REPLACE FUNCTION public.crm_opportunities_check_contact_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contact_org_id uuid;
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'Un contact nécessite une organisation (organization_id requis quand contact_id est renseigné)'
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
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.crm_opportunities_check_contact_org() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_opportunities_check_contact_org() FROM PUBLIC, anon, authenticated;

-- =========================================================
-- 5. RLS: crm_activities
-- =========================================================

ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.crm_activities FROM PUBLIC;
REVOKE ALL ON public.crm_activities FROM anon;
REVOKE ALL ON public.crm_activities FROM authenticated;
REVOKE ALL ON public.crm_activities FROM service_role;

-- authenticated: column-level INSERT/UPDATE on business columns only.
-- Protected columns (NOT in INSERT or UPDATE grants):
--   id          — default gen_random_uuid()
--   created_by  — server-derived via trigger (auth.uid())
--   created_at  — DB default now()
--   updated_at  — trigger-managed (public.set_updated_at())
GRANT SELECT, DELETE ON public.crm_activities TO authenticated;
GRANT INSERT (
  organization_id,
  contact_id,
  opportunity_id,
  activity_type,
  direction,
  subject,
  body,
  status,
  occurred_at,
  due_at,
  completed_at,
  assigned_to,
  metadata
) ON public.crm_activities TO authenticated;
GRANT UPDATE (
  organization_id,
  contact_id,
  opportunity_id,
  activity_type,
  direction,
  subject,
  body,
  status,
  occurred_at,
  due_at,
  completed_at,
  assigned_to,
  metadata
) ON public.crm_activities TO authenticated;

-- service_role: SELECT only (application credential, NOT database owner).
-- P3B4A: INSERT/UPDATE grants removed. No existing backend path requires
-- service_role to write crm_activities. INSERT always failed anyway
-- because created_by trigger sets auth.uid()=NULL (no user context) and
-- created_by is NOT NULL. Under least privilege, meaningless write
-- privileges are removed. service_role retains SELECT for read-only
-- operational access.
GRANT SELECT ON public.crm_activities TO service_role;

-- SELECT: internal users only.
CREATE POLICY crm_activities_select_internal
  ON public.crm_activities FOR SELECT TO authenticated
  USING (public.is_internal_user());

-- INSERT: internal users only.
CREATE POLICY crm_activities_insert_internal
  ON public.crm_activities FOR INSERT TO authenticated
  WITH CHECK (public.is_internal_user());

-- UPDATE: internal users only.
CREATE POLICY crm_activities_update_internal
  ON public.crm_activities FOR UPDATE TO authenticated
  USING (public.is_internal_user())
  WITH CHECK (public.is_internal_user());

-- DELETE: admin-only. Activity history has audit value.
-- Operators may create/update but not erase commercial history.
CREATE POLICY crm_activities_delete_admin
  ON public.crm_activities FOR DELETE TO authenticated
  USING (public.is_admin());

COMMIT;
