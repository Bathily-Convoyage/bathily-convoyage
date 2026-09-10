-- =========================================================
-- P3B5 — CRM Business Links
-- =========================================================
-- Connects historical business records (clients, devis, missions)
-- to the CRM graph (organizations, contacts, opportunities).
--
-- Additive only. No backfill. No default other than NULL.
-- Does NOT modify existing columns, FKs, RLS, or grants.
-- Does NOT add missions.contact_id or missions.opportunity_id.
--
-- New columns (6):
--   clients.organization_id       -> organizations(id) ON DELETE SET NULL
--   devis.organization_id         -> organizations(id) ON DELETE SET NULL
--   devis.contact_id              -> organization_contacts(id) ON DELETE SET NULL
--   devis.opportunity_id          -> crm_opportunities(id) ON DELETE SET NULL
--   missions.devis_id             -> devis(id) ON DELETE RESTRICT
--   missions.organization_id      -> organizations(id) ON DELETE SET NULL
--
-- Authorization model (P3B5D):
--   CRM link mutations (create/change/remove) require is_internal_user()
--   for devis/missions, is_admin() OR is_operator() for clients.
--   auth.uid() IS NULL alone is NOT privileged.
--   service_role direct CRM-link mutation = DENY.
--   anon/client/convoyeur = DENY.
--
-- Concurrency model (P3B5F corrected):
--   CHILD_SIDE_PARENT_LOCKS = FOR SHARE
--   PARENT_SIDE_DEPENDENT_LOCKS = NONE (plain SELECT only)
--   ADVISORY_LOCKS = NO
--
-- RPCs (3, canonical CRM-link write path):
--   crm_link_client_organization(client_id, organization_id)
--   crm_link_devis_crm(devis_id, organization_id, contact_id, opportunity_id)
--   crm_link_mission_devis(mission_id, devis_id, organization_id)
--   FULL_REPLACEMENT semantics. No default arguments.
--   EXECUTE: authenticated only.
--
-- SECURITY DEFINER inventory (11 total):
--   8 trigger-only (6 new + 2 CREATE OR REPLACE of P3B4)
--   3 callable RPCs
--   All: SET search_path = '', OWNER postgres
--   Trigger-only: REVOKE EXECUTE FROM PUBLIC, anon, authenticated, service_role
--   RPCs: REVOKE EXECUTE FROM PUBLIC, anon, service_role; GRANT EXECUTE TO authenticated
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. COLUMNS (6)
-- =========================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS organization_id uuid;

ALTER TABLE public.devis
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS contact_id uuid,
  ADD COLUMN IF NOT EXISTS opportunity_id uuid;

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS devis_id uuid,
  ADD COLUMN IF NOT EXISTS organization_id uuid;

-- =========================================================
-- 2. FOREIGN KEYS (6)
-- =========================================================

ALTER TABLE public.clients
  ADD CONSTRAINT clients_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
    ON DELETE SET NULL;

ALTER TABLE public.devis
  ADD CONSTRAINT devis_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
    ON DELETE SET NULL;

ALTER TABLE public.devis
  ADD CONSTRAINT devis_contact_id_fkey
    FOREIGN KEY (contact_id) REFERENCES public.organization_contacts(id)
    ON DELETE SET NULL;

ALTER TABLE public.devis
  ADD CONSTRAINT devis_opportunity_id_fkey
    FOREIGN KEY (opportunity_id) REFERENCES public.crm_opportunities(id)
    ON DELETE SET NULL;

ALTER TABLE public.missions
  ADD CONSTRAINT missions_devis_id_fkey
    FOREIGN KEY (devis_id) REFERENCES public.devis(id)
    ON DELETE RESTRICT;

ALTER TABLE public.missions
  ADD CONSTRAINT missions_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
    ON DELETE SET NULL;

-- =========================================================
-- 3. INDEXES (6 partial)
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_clients_organization_id
  ON public.clients (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_devis_organization_id
  ON public.devis (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_devis_contact_id
  ON public.devis (contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_devis_opportunity_id
  ON public.devis (opportunity_id)
  WHERE opportunity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_missions_devis_id
  ON public.missions (devis_id)
  WHERE devis_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_missions_organization_id
  ON public.missions (organization_id)
  WHERE organization_id IS NOT NULL;

-- =========================================================
-- 4. AUTHORIZATION GUARD: clients.organization_id
-- =========================================================
-- Separate from guard_clients_privileged_fields() to preserve
-- legacy semantics. Uses is_admin() OR is_operator() — NOT
-- auth.uid() IS NULL.
-- INSERT: non-null org requires authorization.
-- UPDATE: ANY change to organization_id (including to NULL)
--   requires is_admin() OR is_operator().
--   This covers: NULL→value, value→value, value→NULL.
--   FK ON DELETE SET NULL cascades fire this trigger; admin
--   deletes (auth.uid()=admin) pass is_admin(), service_role
--   deletes (auth.uid()=NULL) are correctly denied.

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
    END IF;
  ELSE  -- UPDATE
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      IF NOT (public.is_admin() OR public.is_operator()) THEN
        RAISE EXCEPTION 'Non autorisé : organization_id modifiable par admin ou opérateur actif uniquement'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_clients_organization_id() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.guard_clients_organization_id()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_clients_organization_id ON public.clients;
CREATE TRIGGER trg_guard_clients_organization_id
  BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_clients_organization_id();

-- =========================================================
-- 5. AUTHORIZATION + CONSISTENCY GUARD: devis CRM links
-- =========================================================
-- Phase 1: AUTHORIZATION (no CRM lookups — prevents error oracle)
--   ANY CRM link mutation (NULL→value, value→value, value→NULL)
--   requires is_internal_user().
--   service_role (auth.uid()=NULL) is denied for all mutations.
--   FK ON DELETE SET NULL cascades fire this trigger; admin
--   deletes pass is_internal_user(), service_role deletes denied.
-- Phase 2: CROSS-ENTITY CONSISTENCY (CRM lookups — always runs)
--   - contact set => org required + contact.org = devis.org
--   - opportunity set + opp.org non-null => devis.org = opp.org
--   - client set + client.org non-null + devis.org non-null => same org
-- Child-side locks: client -> contact -> opportunity (FOR SHARE, deterministic)

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

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.devis_guard_crm_links() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.devis_guard_crm_links()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_devis_guard_crm_links ON public.devis;
CREATE TRIGGER trg_devis_guard_crm_links
  BEFORE INSERT OR UPDATE ON public.devis
  FOR EACH ROW
  EXECUTE FUNCTION public.devis_guard_crm_links();

-- =========================================================
-- 6. AUTHORIZATION + CONSISTENCY GUARD: missions devis/org
-- =========================================================
-- Phase 1: AUTHORIZATION (no CRM lookups)
--   ANY CRM link mutation (NULL→value, value→value, value→NULL)
--   requires is_internal_user().
--   service_role (auth.uid()=NULL) is denied for all mutations.
--   FK ON DELETE SET NULL cascades fire this trigger; admin
--   deletes pass is_internal_user(), service_role deletes denied.
-- Phase 2: CONSISTENCY
--   If devis_id set, lock devis FOR SHARE.
--   If devis.org non-null, mission.org must match.

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

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.missions_check_devis_org() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.missions_check_devis_org()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_missions_check_devis_org ON public.missions;
CREATE TRIGGER trg_missions_check_devis_org
  BEFORE INSERT OR UPDATE ON public.missions
  FOR EACH ROW
  EXECUTE FUNCTION public.missions_check_devis_org();

-- =========================================================
-- 7. PARENT GRAPH GUARD: clients.organization_id
-- =========================================================
-- If NEW.organization_id = NULL: client imposes no org constraint
--   on linked contacts or devis. ALLOW.
-- If NEW.organization_id non-null: linked contacts/devis with
--   non-null org must match. DENY on conflict.
-- Plain SELECT on dependents — NO FOR SHARE (avoids deadlock cycle).

CREATE OR REPLACE FUNCTION public.clients_guard_reparent()
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

  -- NULL organization imposes no constraint on dependents
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Non-null NEW organization: check linked contacts (plain SELECT)
  SELECT count(*) INTO v_conflict_count
  FROM public.organization_contacts
  WHERE client_id = NEW.id
    AND organization_id IS NOT NULL
    AND organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Un contact lié appartient à une organisation différente'
      USING ERRCODE = 'P0001';
  END IF;

  -- Check linked devis (plain SELECT)
  SELECT count(*) INTO v_conflict_count
  FROM public.devis
  WHERE client_id = NEW.id
    AND organization_id IS NOT NULL
    AND organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Un devis lié appartient à une organisation différente'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.clients_guard_reparent() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.clients_guard_reparent()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_clients_guard_reparent ON public.clients;
CREATE TRIGGER trg_clients_guard_reparent
  BEFORE UPDATE OF organization_id ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.clients_guard_reparent();

-- =========================================================
-- 8. PARENT GRAPH GUARD: devis.organization_id
-- =========================================================
-- If NEW.organization_id = NULL: devis imposes no org constraint
--   on linked missions. But contact_id or opportunity with
--   non-null org still requires the cross-entity validator to
--   reject invalid state (handled by devis_guard_crm_links).
-- If NEW.organization_id non-null: linked missions with non-null
--   org must match. DENY on conflict.
-- Plain SELECT on dependents — NO FOR SHARE.

CREATE OR REPLACE FUNCTION public.devis_guard_reparent()
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

  -- NULL organization: no mission constraint (missions may have
  -- independent org context). The devis_guard_crm_links trigger
  -- handles contact/opportunity consistency separately.
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Non-null NEW organization: check linked missions (plain SELECT)
  SELECT count(*) INTO v_conflict_count
  FROM public.missions
  WHERE devis_id = NEW.id
    AND organization_id IS NOT NULL
    AND organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Une mission liée appartient à une organisation différente'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.devis_guard_reparent() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.devis_guard_reparent()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_devis_guard_reparent ON public.devis;
CREATE TRIGGER trg_devis_guard_reparent
  BEFORE UPDATE OF organization_id ON public.devis
  FOR EACH ROW
  EXECUTE FUNCTION public.devis_guard_reparent();

-- =========================================================
-- 9. CHILD-SIDE VALIDATOR: organization_contacts ↔ client org
-- =========================================================
-- If contact.client_id is set and client.organization_id is non-null,
-- contact.organization_id must equal client.organization_id.
-- organization_contacts.organization_id is NOT NULL, so the contact
-- always has an org. The client may have NULL org (no constraint).
-- Locks referenced client FOR SHARE (child-side lock).

CREATE OR REPLACE FUNCTION public.organization_contacts_check_client_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_client_org_id uuid;
BEGIN
  IF NEW.client_id IS NOT NULL THEN
    SELECT organization_id INTO v_client_org_id
    FROM public.clients
    WHERE id = NEW.client_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Client introuvable' USING ERRCODE = 'P0002';
    END IF;

    -- If client.org is NULL, no constraint on contact
    IF v_client_org_id IS NOT NULL THEN
      IF v_client_org_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'Le contact n''appartient pas à la même organisation que le client'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.organization_contacts_check_client_org() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.organization_contacts_check_client_org()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_organization_contacts_check_client_org ON public.organization_contacts;
CREATE TRIGGER trg_organization_contacts_check_client_org
  BEFORE INSERT OR UPDATE ON public.organization_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.organization_contacts_check_client_org();

-- =========================================================
-- 10. EXTEND P3B4: organization_contacts_guard_reparent
-- =========================================================
-- Preserve all P3B4 behavior (opportunities, activities).
-- Add: devis.contact_id dependency.
-- Add: clients.organization_id through contact.client_id.
-- Plain SELECT on all dependents — NO FOR SHARE.

CREATE OR REPLACE FUNCTION public.organization_contacts_guard_reparent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conflict_count integer;
  v_client_org_id  uuid;
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

  -- P3B5: Check dependent devis (devis.contact_id requires matching org)
  SELECT count(*) INTO v_conflict_count
  FROM public.devis d
  WHERE d.contact_id = NEW.id
    AND d.organization_id IS NOT NULL
    AND d.organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Le changement d''organisation du contact rendrait des devis incohérents'
      USING ERRCODE = 'P0001';
  END IF;

  -- P3B5: Check client org consistency through contact.client_id
  -- If the contact is linked to a client and the client has a non-null org,
  -- the contact's new org must match the client's org.
  IF NEW.client_id IS NOT NULL THEN
    SELECT organization_id INTO v_client_org_id
    FROM public.clients
    WHERE id = NEW.client_id;

    IF FOUND AND v_client_org_id IS NOT NULL THEN
      IF v_client_org_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'Le changement d''organisation du contact est incompatible avec l''organisation du client lié'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.organization_contacts_guard_reparent() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.organization_contacts_guard_reparent()
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger already exists from P3B4; no need to recreate.

-- =========================================================
-- 11. EXTEND P3B4: crm_opportunities_guard_reparent
-- =========================================================
-- Preserve all P3B4 behavior (activities).
-- Add: devis.opportunity_id dependency.
-- Plain SELECT on dependents — NO FOR SHARE.

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
    -- P3B5: still check devis — if devis has non-null org and references
    -- this opportunity, a NULL opp org is fine (devis.org is unconstrained
    -- by opp.org when opp.org is NULL). So ALLOW.
    RETURN NEW;
  END IF;

  -- Non-null NEW organization: check dependent activities (P3B4)
  SELECT count(*) INTO v_conflict_count
  FROM public.crm_activities a
  WHERE a.opportunity_id = NEW.id
    AND a.organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Le changement d''organisation de l''opportunité rendrait des activités incohérentes'
      USING ERRCODE = 'P0001';
  END IF;

  -- P3B5: Check dependent devis (devis.opportunity_id)
  SELECT count(*) INTO v_conflict_count
  FROM public.devis d
  WHERE d.opportunity_id = NEW.id
    AND d.organization_id IS NOT NULL
    AND d.organization_id IS DISTINCT FROM NEW.organization_id;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Le changement d''organisation de l''opportunité rendrait des devis incohérents'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.crm_opportunities_guard_reparent() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_opportunities_guard_reparent()
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger already exists from P3B4; no need to recreate.

-- =========================================================
-- 12. RPC: crm_link_client_organization
-- =========================================================
-- Canonical CRM-link write path for admin AND operator.
-- FULL_REPLACEMENT semantics. No default arguments.
-- SECURITY DEFINER, SET search_path = ''.
-- EXECUTE: authenticated only.

CREATE OR REPLACE FUNCTION public.crm_link_client_organization(
  p_client_id       uuid,
  p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Authorization: admin or active operator only
  IF NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Non autorisé : opération réservée aux utilisateurs internes'
      USING ERRCODE = '42501';
  END IF;

  -- Target client must exist
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'Client introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Target organization must exist (if non-null)
  IF p_organization_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
      RAISE EXCEPTION 'Organisation introuvable' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- Atomic update: only organization_id
  -- guard_clients_organization_id trigger validates authorization.
  -- clients_guard_reparent trigger validates graph integrity.
  UPDATE public.clients
    SET organization_id = p_organization_id
    WHERE id = p_client_id;
END;
$$;

ALTER FUNCTION public.crm_link_client_organization(uuid, uuid) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_link_client_organization(uuid, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.crm_link_client_organization(uuid, uuid)
  TO authenticated;

-- =========================================================
-- 13. RPC: crm_link_devis_crm
-- =========================================================
-- FULL_REPLACEMENT of organization_id, contact_id, opportunity_id.
-- No default arguments. Explicit NULL = intentional unlink.

CREATE OR REPLACE FUNCTION public.crm_link_devis_crm(
  p_devis_id        uuid,
  p_organization_id uuid,
  p_contact_id      uuid,
  p_opportunity_id  uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Authorization: admin or active operator only
  IF NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Non autorisé : opération réservée aux utilisateurs internes'
      USING ERRCODE = '42501';
  END IF;

  -- Target devis must exist
  IF NOT EXISTS (SELECT 1 FROM public.devis WHERE id = p_devis_id) THEN
    RAISE EXCEPTION 'Devis introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Atomic update: only CRM link columns (full replacement)
  -- devis_guard_crm_links trigger validates authorization + consistency.
  -- devis_guard_reparent trigger validates graph integrity.
  UPDATE public.devis
    SET organization_id = p_organization_id,
        contact_id = p_contact_id,
        opportunity_id = p_opportunity_id
    WHERE id = p_devis_id;
END;
$$;

ALTER FUNCTION public.crm_link_devis_crm(uuid, uuid, uuid, uuid) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_link_devis_crm(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.crm_link_devis_crm(uuid, uuid, uuid, uuid)
  TO authenticated;

-- =========================================================
-- 14. RPC: crm_link_mission_devis
-- =========================================================
-- FULL_REPLACEMENT of devis_id, organization_id.
-- No default arguments. Explicit NULL = intentional unlink.

CREATE OR REPLACE FUNCTION public.crm_link_mission_devis(
  p_mission_id      uuid,
  p_devis_id        uuid,
  p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Authorization: admin or active operator only
  IF NOT public.is_internal_user() THEN
    RAISE EXCEPTION 'Non autorisé : opération réservée aux utilisateurs internes'
      USING ERRCODE = '42501';
  END IF;

  -- Target mission must exist
  IF NOT EXISTS (SELECT 1 FROM public.missions WHERE id = p_mission_id) THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Target devis must exist (if non-null)
  IF p_devis_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.devis WHERE id = p_devis_id) THEN
      RAISE EXCEPTION 'Devis introuvable' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- Atomic update: only devis_id + organization_id
  -- missions_check_devis_org trigger validates authorization + consistency.
  -- missions_sensitive_protect trigger bypasses (current_user = postgres, SD).
  -- missions_financial_protect trigger does nothing (financial fields unchanged).
  UPDATE public.missions
    SET devis_id = p_devis_id,
        organization_id = p_organization_id
    WHERE id = p_mission_id;
END;
$$;

ALTER FUNCTION public.crm_link_mission_devis(uuid, uuid, uuid) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.crm_link_mission_devis(uuid, uuid, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.crm_link_mission_devis(uuid, uuid, uuid)
  TO authenticated;

COMMIT;
