-- =========================================================
-- P3B1 — CRM Organizations + Segments Foundation
-- =========================================================
-- First CRM schema layer. Additive only.
-- Does NOT modify any existing table (clients, devis, missions, etc.).
--
-- Tables:
--   public.organizations
--   public.organization_segments  (M:N join, no separate catalog)
--
-- RLS: enabled in this migration. Predicate = public.is_internal_user()
--   (is_admin() OR is_operator()). anon/client/convoyeur = NO access.
--
-- No SECURITY DEFINER functions introduced in this migration.
-- Soft lifecycle: status='archived' instead of physical DELETE.
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. TABLE: public.organizations
-- =========================================================

CREATE TABLE IF NOT EXISTS public.organizations (
  id                uuid         DEFAULT gen_random_uuid() NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  legal_name        text         NOT NULL,
  trade_name        text,

  siret             text,
  siren             text,
  vat_number        text,

  email             text,
  phone             text,
  website           text,

  billing_email     text,
  billing_address   text,

  source            text,
  source_detail     text,
  external_reference text,

  status            text         NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'archived')),

  notes             text,

  PRIMARY KEY (id),

  -- SIRET format: 14 digits where present (French SIRET).
  -- Nullable — prospects/foreign entities may not have one.
  CONSTRAINT organizations_siret_format_check
    CHECK (siret IS NULL OR (siret ~ '^\d{14}$')),

  -- SIREN format: 9 digits where present.
  CONSTRAINT organizations_siren_format_check
    CHECK (siren IS NULL OR (siren ~ '^\d{9}$')),

  -- legal_name must not be empty/whitespace
  CONSTRAINT organizations_legal_name_nonempty
    CHECK (btrim(legal_name) <> '')
);

ALTER TABLE public.organizations OWNER TO postgres;

-- =========================================================
-- 2. INDEXES: organizations
-- =========================================================

-- Partial unique index on SIRET: unique only where a SIRET is provided.
-- Organizations without SIRET are NOT constrained.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_siret_unique_idx
  ON public.organizations(siret)
  WHERE siret IS NOT NULL;

-- Search by company name (case-insensitive). lower() for stable matching.
CREATE INDEX IF NOT EXISTS organizations_legal_name_lower_idx
  ON public.organizations(lower(legal_name));

CREATE INDEX IF NOT EXISTS organizations_trade_name_lower_idx
  ON public.organizations(lower(trade_name))
  WHERE trade_name IS NOT NULL;

-- Filter by status (active/inactive/archived) — common CRM list filter.
CREATE INDEX IF NOT EXISTS organizations_status_idx
  ON public.organizations(status);

-- =========================================================
-- 3. TRIGGER: organizations updated_at
-- =========================================================
-- Reuses the existing shared public.set_updated_at() function
-- (defined in the remote baseline, reused by billing_records).

DROP TRIGGER IF EXISTS organizations_set_updated_at ON public.organizations;
CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- 4. TABLE: public.organization_segments
-- =========================================================
-- M:N assignment table. One organization → many segments.
-- No separate segment catalog table in P3B1; the CHECK constraint
-- below is the authoritative list of allowed segment values.

CREATE TABLE IF NOT EXISTS public.organization_segments (
  organization_id   uuid         NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  segment           text         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),

  PRIMARY KEY (organization_id, segment),

  CONSTRAINT organization_segments_segment_check
    CHECK (segment IN (
      'concession',
      'garage',
      'rental',
      'auction',
      'notary',
      'fleet',
      'leasing',
      'dealer',
      'logistics',
      'other'
    ))
);

ALTER TABLE public.organization_segments OWNER TO postgres;

-- =========================================================
-- 5. RLS: organizations
-- =========================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- Revoke all direct table privileges; access is via RLS policies only.
REVOKE ALL ON public.organizations FROM PUBLIC;
REVOKE ALL ON public.organizations FROM anon;
REVOKE ALL ON public.organizations FROM authenticated;
GRANT SELECT ON public.organizations TO authenticated;

-- SELECT: internal users (admin + operator) only.
CREATE POLICY organizations_select_internal
  ON public.organizations FOR SELECT TO authenticated
  USING (public.is_internal_user());

-- INSERT: internal users only.
CREATE POLICY organizations_insert_internal
  ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (public.is_internal_user());

-- UPDATE: internal users only.
-- Physical DELETE is admin-only (see below); normal lifecycle = status='archived'.
CREATE POLICY organizations_update_internal
  ON public.organizations FOR UPDATE TO authenticated
  USING (public.is_internal_user())
  WITH CHECK (public.is_internal_user());

-- DELETE: admin-only. Operators use soft-delete (status='archived').
-- This allows physical cleanup by admins for genuine mistakes/spam,
-- while keeping the normal CRM lifecycle soft.
CREATE POLICY organizations_delete_admin
  ON public.organizations FOR DELETE TO authenticated
  USING (public.is_admin());

-- =========================================================
-- 6. RLS: organization_segments
-- =========================================================

ALTER TABLE public.organization_segments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.organization_segments FROM PUBLIC;
REVOKE ALL ON public.organization_segments FROM anon;
REVOKE ALL ON public.organization_segments FROM authenticated;
GRANT SELECT ON public.organization_segments TO authenticated;

-- SELECT: internal users only.
CREATE POLICY organization_segments_select_internal
  ON public.organization_segments FOR SELECT TO authenticated
  USING (public.is_internal_user());

-- INSERT: internal users only.
CREATE POLICY organization_segments_insert_internal
  ON public.organization_segments FOR INSERT TO authenticated
  WITH CHECK (public.is_internal_user());

-- UPDATE: denied. Segments are immutable once assigned; to change,
-- delete and re-insert. (No UPDATE policy = denied under RLS.)
-- This keeps the segment assignment append/replace-only and simple.

-- DELETE: internal users only. Removing a segment tag is a normal
-- admin/operator operation (un-tagging). Cascading delete from the
-- parent organization is handled by the FK ON DELETE CASCADE.
CREATE POLICY organization_segments_delete_internal
  ON public.organization_segments FOR DELETE TO authenticated
  USING (public.is_internal_user());

-- =========================================================
-- 7. COMMENTS
-- =========================================================

COMMENT ON TABLE public.organizations IS
  'CRM organization entity. Generalized — covers concessions, garages, rentals, auctions, notaries, fleets, dealers, logistics partners, etc. Soft lifecycle via status (active/inactive/archived). SIRET unique only where present.';
COMMENT ON COLUMN public.organizations.siret IS
  'French SIRET (14 digits) or NULL for entities without one. Unique among non-null values.';
COMMENT ON COLUMN public.organizations.status IS
  'active = operational; inactive = paused/dormant; archived = soft-deleted. Physical DELETE is admin-only, not the normal lifecycle.';

COMMENT ON TABLE public.organization_segments IS
  'M:N segment tags for organizations. One organization may have multiple segments (e.g. garage + dealer). No separate catalog table; allowed values enforced by CHECK constraint.';

-- =========================================================
-- 8. SCHEMA CACHE
-- =========================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
