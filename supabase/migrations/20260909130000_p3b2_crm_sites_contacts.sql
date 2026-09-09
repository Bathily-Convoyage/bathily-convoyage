-- =========================================================
-- P3B2 — CRM Organization Sites + Contacts
-- =========================================================
-- Second CRM schema layer. Additive only.
-- Does NOT modify any existing table (clients, devis, missions,
-- billing_records, billing_events, organizations, organization_segments).
--
-- Tables:
--   public.organization_sites     (1:N child of organizations)
--   public.organization_contacts  (1:N child of organizations)
--
-- FKs:
--   organization_sites.organization_id    → organizations(id) ON DELETE CASCADE
--   organization_contacts.organization_id → organizations(id) ON DELETE CASCADE
--   organization_contacts.client_id       → clients(id) ON DELETE SET NULL  (optional)
--
-- RLS: enabled in this migration. Predicate = public.is_internal_user()
--   (is_admin() OR is_operator()). anon/client/convoyeur = NO access.
--   Physical DELETE = internal (admin + operator). These are mutable child
--   CRM records, not immutable audit evidence, so internal delete is
--   acceptable. Cascading delete from the parent organization is handled
--   by the FK ON DELETE CASCADE.
--
-- No SECURITY DEFINER functions introduced in this migration.
-- =========================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- =========================================================
-- 1. TABLE: public.organization_sites
-- =========================================================

CREATE TABLE IF NOT EXISTS public.organization_sites (
  id                uuid         DEFAULT gen_random_uuid() NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  organization_id   uuid         NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  name              text         NOT NULL,
  site_type         text         NOT NULL DEFAULT 'other',

  address_line1     text,
  address_line2     text,
  postal_code       text,
  city              text,
  country           text         NOT NULL DEFAULT 'FR',

  phone             text,
  email             text,

  active            boolean      NOT NULL DEFAULT true,

  PRIMARY KEY (id),

  -- name must not be empty/whitespace
  CONSTRAINT organization_sites_name_nonempty
    CHECK (btrim(name) <> ''),

  -- site_type constrained to the authoritative catalog (no separate table)
  CONSTRAINT organization_sites_site_type_check
    CHECK (site_type IN (
      'headquarters',
      'showroom',
      'workshop',
      'depot',
      'warehouse',
      'office',
      'pickup',
      'delivery',
      'auction_site',
      'other'
    )),

  -- country must not be empty/whitespace when present
  CONSTRAINT organization_sites_country_nonempty
    CHECK (btrim(country) <> '')
);

ALTER TABLE public.organization_sites OWNER TO postgres;

-- =========================================================
-- 2. INDEXES: organization_sites
-- =========================================================

-- FK column supporting index (organization_id lookups / cascade deletes).
CREATE INDEX IF NOT EXISTS organization_sites_organization_id_idx
  ON public.organization_sites(organization_id);

-- Filter by active sites (common CRM list filter).
CREATE INDEX IF NOT EXISTS organization_sites_active_idx
  ON public.organization_sites(active)
  WHERE active = true;

-- Search by city (case-insensitive) — CRM locality search.
CREATE INDEX IF NOT EXISTS organization_sites_city_lower_idx
  ON public.organization_sites(lower(city))
  WHERE city IS NOT NULL;

-- Search by postal_code (prefix lookups).
CREATE INDEX IF NOT EXISTS organization_sites_postal_code_idx
  ON public.organization_sites(postal_code)
  WHERE postal_code IS NOT NULL;

-- =========================================================
-- 3. TRIGGER: organization_sites updated_at
-- =========================================================
-- Reuses the existing shared public.set_updated_at() function.

DROP TRIGGER IF EXISTS organization_sites_set_updated_at ON public.organization_sites;
CREATE TRIGGER organization_sites_set_updated_at
  BEFORE UPDATE ON public.organization_sites
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- 4. TABLE: public.organization_contacts
-- =========================================================

CREATE TABLE IF NOT EXISTS public.organization_contacts (
  id                uuid         DEFAULT gen_random_uuid() NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  organization_id   uuid         NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  first_name        text,
  last_name         text,

  job_title         text,
  department        text,

  email             text,
  phone             text,
  mobile            text,

  preferred_channel text,

  decision_maker    boolean      NOT NULL DEFAULT false,
  primary_contact   boolean      NOT NULL DEFAULT false,

  active            boolean      NOT NULL DEFAULT true,

  -- Optional link to a registered client record. A contact person may
  -- also be a client. ON DELETE SET NULL keeps the contact when the
  -- client record is removed. clients.id is uuid (verified compatible).
  client_id         uuid         REFERENCES public.clients(id) ON DELETE SET NULL,

  notes             text,

  PRIMARY KEY (id),

  -- preferred_channel constrained to known channels (nullable accepted).
  CONSTRAINT organization_contacts_preferred_channel_check
    CHECK (preferred_channel IS NULL OR preferred_channel IN (
      'email',
      'phone',
      'mobile',
      'sms',
      'whatsapp',
      'none'
    ))
);

ALTER TABLE public.organization_contacts OWNER TO postgres;

-- =========================================================
-- 5. INDEXES: organization_contacts
-- =========================================================

-- FK column supporting index (organization_id lookups / cascade deletes).
CREATE INDEX IF NOT EXISTS organization_contacts_organization_id_idx
  ON public.organization_contacts(organization_id);

-- Search by email (case-insensitive) — CRM contact search.
CREATE INDEX IF NOT EXISTS organization_contacts_email_lower_idx
  ON public.organization_contacts(lower(email))
  WHERE email IS NOT NULL;

-- Filter by active contacts (common CRM list filter).
CREATE INDEX IF NOT EXISTS organization_contacts_active_idx
  ON public.organization_contacts(active)
  WHERE active = true;

-- Filter by primary contact (the partial unique index below also
-- serves lookups, but a non-unique partial index on active primary
-- contacts is useful for list views).
CREATE INDEX IF NOT EXISTS organization_contacts_primary_contact_idx
  ON public.organization_contacts(primary_contact)
  WHERE primary_contact = true;

-- =========================================================
-- 6. PRIMARY CONTACT UNIQUENESS
-- =========================================================
-- At most one primary_contact=true per organization. A partial unique
-- index allows organizations with NO primary contact (no row matches
-- the WHERE clause). Soft duplicate handling later, not hard uniqueness
-- on names/emails.

CREATE UNIQUE INDEX IF NOT EXISTS organization_contacts_primary_unique_idx
  ON public.organization_contacts(organization_id)
  WHERE primary_contact = true;

-- =========================================================
-- 7. TRIGGER: organization_contacts updated_at
-- =========================================================

DROP TRIGGER IF EXISTS organization_contacts_set_updated_at ON public.organization_contacts;
CREATE TRIGGER organization_contacts_set_updated_at
  BEFORE UPDATE ON public.organization_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- 8. RLS: organization_sites
-- =========================================================

ALTER TABLE public.organization_sites ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.organization_sites FROM PUBLIC;
REVOKE ALL ON public.organization_sites FROM anon;
REVOKE ALL ON public.organization_sites FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_sites TO authenticated;
GRANT ALL ON public.organization_sites TO service_role;

-- SELECT: internal users only.
CREATE POLICY organization_sites_select_internal
  ON public.organization_sites FOR SELECT TO authenticated
  USING (public.is_internal_user());

-- INSERT: internal users only.
CREATE POLICY organization_sites_insert_internal
  ON public.organization_sites FOR INSERT TO authenticated
  WITH CHECK (public.is_internal_user());

-- UPDATE: internal users only.
CREATE POLICY organization_sites_update_internal
  ON public.organization_sites FOR UPDATE TO authenticated
  USING (public.is_internal_user())
  WITH CHECK (public.is_internal_user());

-- DELETE: internal users only. These are mutable child CRM records,
-- not immutable audit evidence, so internal delete is acceptable.
-- Cascading delete from the parent organization is handled by the FK.
CREATE POLICY organization_sites_delete_internal
  ON public.organization_sites FOR DELETE TO authenticated
  USING (public.is_internal_user());

-- =========================================================
-- 9. RLS: organization_contacts
-- =========================================================

ALTER TABLE public.organization_contacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.organization_contacts FROM PUBLIC;
REVOKE ALL ON public.organization_contacts FROM anon;
REVOKE ALL ON public.organization_contacts FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_contacts TO authenticated;
GRANT ALL ON public.organization_contacts TO service_role;

-- SELECT: internal users only.
CREATE POLICY organization_contacts_select_internal
  ON public.organization_contacts FOR SELECT TO authenticated
  USING (public.is_internal_user());

-- INSERT: internal users only.
CREATE POLICY organization_contacts_insert_internal
  ON public.organization_contacts FOR INSERT TO authenticated
  WITH CHECK (public.is_internal_user());

-- UPDATE: internal users only.
CREATE POLICY organization_contacts_update_internal
  ON public.organization_contacts FOR UPDATE TO authenticated
  USING (public.is_internal_user())
  WITH CHECK (public.is_internal_user());

-- DELETE: internal users only. These are mutable child CRM records,
-- not immutable audit evidence, so internal delete is acceptable.
-- Cascading delete from the parent organization is handled by the FK.
CREATE POLICY organization_contacts_delete_internal
  ON public.organization_contacts FOR DELETE TO authenticated
  USING (public.is_internal_user());

-- =========================================================
-- 10. COMMENTS
-- =========================================================

COMMENT ON TABLE public.organization_sites IS
  'CRM organization sites. One organization may have multiple sites (headquarters, showroom, workshop, depot, etc.). site_type is constrained by CHECK (no separate catalog table). FK to organizations with ON DELETE CASCADE. Soft lifecycle via active flag.';

COMMENT ON COLUMN public.organization_sites.site_type IS
  'Constrained: headquarters, showroom, workshop, depot, warehouse, office, pickup, delivery, auction_site, other.';

COMMENT ON COLUMN public.organization_sites.country IS
  'ISO 3166-1 alpha-2 country code (default FR). Foreign sites are allowed.';

COMMENT ON TABLE public.organization_contacts IS
  'CRM organization contacts. One organization may have multiple contacts. email/phone are NOT globally unique (a person may appear at multiple organizations). At most one primary_contact=true per organization (partial unique index). Optional client_id link to clients(id) ON DELETE SET NULL.';

COMMENT ON COLUMN public.organization_contacts.preferred_channel IS
  'Constrained: email, phone, mobile, sms, whatsapp, none. Nullable.';

COMMENT ON COLUMN public.organization_contacts.client_id IS
  'Optional link to a registered client record. ON DELETE SET NULL keeps the contact when the client is removed.';

-- =========================================================
-- 11. SCHEMA CACHE
-- =========================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
