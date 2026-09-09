// P3B2 — CRM Organization Sites + Contacts — Static Migration Validation
//
// Validates the migration SQL for:
// - organization_sites table schema (fields, PK, FK, CHECK)
// - organization_contacts table schema (fields, PK, FK, CHECK)
// - site_type CHECK constraint (constrained values)
// - preferred_channel CHECK constraint
// - active defaults
// - primary_contact partial unique index
// - optional client_id FK to clients(id) ON DELETE SET NULL
// - ON DELETE CASCADE from organizations
// - RLS enabled + internal-user policies
// - grants (anon denied, authenticated CRUD, service_role ALL)
// - grant/policy consistency guard (like P3B1B)
// - no SECURITY DEFINER functions introduced
// - updated_at triggers reuse shared helper
// - no modification to existing production tables

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260909130000_p3b2_crm_sites_contacts.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

// =========================================================
// SCHEMA: organization_sites
// =========================================================

const sitesChecks = [
  ['organization_sites table created', /CREATE TABLE IF NOT EXISTS public\.organization_sites\s*\(/i],
  ['id uuid PK DEFAULT gen_random_uuid', /id\s+uuid\s+DEFAULT gen_random_uuid\(\)\s+NOT NULL/i],
  ['created_at timestamptz NOT NULL DEFAULT now', /created_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['updated_at timestamptz NOT NULL DEFAULT now', /updated_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['organization_id uuid NOT NULL', /organization_id\s+uuid\s+NOT NULL/i],
  ['name text NOT NULL', /name\s+text\s+NOT NULL/i],
  ['site_type text NOT NULL DEFAULT other', /site_type\s+text\s+NOT NULL\s+DEFAULT 'other'/i],
  ['address_line1 text', /address_line1\s+text/i],
  ['address_line2 text', /address_line2\s+text/i],
  ['postal_code text', /postal_code\s+text/i],
  ['city text', /city\s+text/i],
  ['country text NOT NULL DEFAULT FR', /country\s+text\s+NOT NULL\s+DEFAULT 'FR'/i],
  ['phone text', /phone\s+text/i],
  ['email text', /email\s+text/i],
  ['active boolean NOT NULL DEFAULT true', /active\s+boolean\s+NOT NULL\s+DEFAULT true/i],
  ['PRIMARY KEY (id)', /PRIMARY KEY\s*\(id\)/i],
];

for (const [name, pattern] of sitesChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SITES: FK organization_id → organizations(id) ON DELETE CASCADE
// =========================================================

assert.match(
  sql,
  /REFERENCES\s+public\.organizations\(id\)\s+ON DELETE CASCADE/i,
  'organization_sites.organization_id FK → organizations(id) ON DELETE CASCADE',
);
console.log('  ✓ organization_sites.organization_id FK → organizations(id) ON DELETE CASCADE');

// =========================================================
// SITES: site_type CHECK values
// =========================================================

const siteTypes = [
  'headquarters', 'showroom', 'workshop', 'depot', 'warehouse',
  'office', 'pickup', 'delivery', 'auction_site', 'other',
];

for (const st of siteTypes) {
  const pattern = new RegExp(`'${st}'`, 'i');
  assert.match(sql, pattern, `site_type '${st}' allowed`);
  console.log(`  ✓ site_type '${st}' allowed`);
}

assert.match(
  sql,
  /organization_sites_site_type_check[\s\S]*CHECK\s*\(site_type\s+IN/i,
  'site_type CHECK constraint named',
);
console.log('  ✓ site_type CHECK constraint named');

// =========================================================
// SITES: name nonempty CHECK
// =========================================================

assert.match(
  sql,
  /organization_sites_name_nonempty[\s\S]*btrim\(name\)\s*<>\s*''/i,
  'organization_sites name nonempty check',
);
console.log('  ✓ organization_sites name nonempty check');

// =========================================================
// SITES: indexes
// =========================================================

const sitesIndexChecks = [
  ['index organization_id', /CREATE\s+INDEX[^;]*organization_sites_organization_id_idx[^;]*\(organization_id\)/i],
  ['index active partial', /CREATE\s+INDEX[^;]*organization_sites_active_idx[^;]*\(active\)[^;]*WHERE\s+active\s*=\s*true/i],
  ['index lower(city) partial', /CREATE\s+INDEX[^;]*organization_sites_city_lower_idx[^;]*lower\(city\)[^;]*WHERE\s+city\s+IS\s+NOT\s+NULL/i],
  ['index postal_code partial', /CREATE\s+INDEX[^;]*organization_sites_postal_code_idx[^;]*\(postal_code\)[^;]*WHERE\s+postal_code\s+IS\s+NOT\s+NULL/i],
];

for (const [name, pattern] of sitesIndexChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SITES: updated_at trigger
// =========================================================

const sitesTriggerChecks = [
  ['reuses public.set_updated_at()', /EXECUTE FUNCTION public\.set_updated_at\(\)/i],
  ['trigger organization_sites_set_updated_at', /CREATE\s+TRIGGER\s+organization_sites_set_updated_at/i],
  ['BEFORE UPDATE ON organization_sites', /BEFORE\s+UPDATE\s+ON\s+public\.organization_sites/i],
];

for (const [name, pattern] of sitesTriggerChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SCHEMA: organization_contacts
// =========================================================

const contactsChecks = [
  ['organization_contacts table created', /CREATE TABLE IF NOT EXISTS public\.organization_contacts\s*\(/i],
  ['id uuid PK DEFAULT gen_random_uuid', /id\s+uuid\s+DEFAULT gen_random_uuid\(\)\s+NOT NULL/i],
  ['created_at timestamptz NOT NULL DEFAULT now', /created_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['updated_at timestamptz NOT NULL DEFAULT now', /updated_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['organization_id uuid NOT NULL', /organization_id\s+uuid\s+NOT NULL/i],
  ['first_name text', /first_name\s+text/i],
  ['last_name text', /last_name\s+text/i],
  ['job_title text', /job_title\s+text/i],
  ['department text', /department\s+text/i],
  ['email text', /email\s+text/i],
  ['phone text', /phone\s+text/i],
  ['mobile text', /mobile\s+text/i],
  ['preferred_channel text', /preferred_channel\s+text/i],
  ['decision_maker boolean NOT NULL DEFAULT false', /decision_maker\s+boolean\s+NOT NULL\s+DEFAULT false/i],
  ['primary_contact boolean NOT NULL DEFAULT false', /primary_contact\s+boolean\s+NOT NULL\s+DEFAULT false/i],
  ['active boolean NOT NULL DEFAULT true', /active\s+boolean\s+NOT NULL\s+DEFAULT true/i],
  ['client_id uuid', /client_id\s+uuid/i],
  ['notes text', /notes\s+text/i],
  ['PRIMARY KEY (id)', /PRIMARY KEY\s*\(id\)/i],
];

for (const [name, pattern] of contactsChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// CONTACTS: FK organization_id → organizations(id) ON DELETE CASCADE
// =========================================================

// Two FKs to organizations exist (sites + contacts). Verify the contacts one
// appears after the organization_contacts table definition.
const contactsBlock = sql.match(
  /CREATE TABLE IF NOT EXISTS public\.organization_contacts[\s\S]*?ALTER TABLE public\.organization_contacts OWNER TO postgres/i,
);
assert.ok(contactsBlock, 'organization_contacts table block found');
assert.match(
  contactsBlock[0],
  /REFERENCES\s+public\.organizations\(id\)\s+ON DELETE CASCADE/i,
  'organization_contacts.organization_id FK → organizations(id) ON DELETE CASCADE',
);
console.log('  ✓ organization_contacts.organization_id FK → organizations(id) ON DELETE CASCADE');

// =========================================================
// CONTACTS: client_id FK → clients(id) ON DELETE SET NULL
// =========================================================

assert.match(
  contactsBlock[0],
  /client_id\s+uuid\s+REFERENCES\s+public\.clients\(id\)\s+ON DELETE SET NULL/i,
  'organization_contacts.client_id FK → clients(id) ON DELETE SET NULL',
);
console.log('  ✓ organization_contacts.client_id FK → clients(id) ON DELETE SET NULL');

// =========================================================
// CONTACTS: preferred_channel CHECK values
// =========================================================

const channels = ['email', 'phone', 'mobile', 'sms', 'whatsapp', 'none'];

for (const ch of channels) {
  const pattern = new RegExp(`'${ch}'`, 'i');
  assert.match(sql, pattern, `preferred_channel '${ch}' allowed`);
  console.log(`  ✓ preferred_channel '${ch}' allowed`);
}

assert.match(
  sql,
  /organization_contacts_preferred_channel_check[\s\S]*CHECK\s*\(preferred_channel\s+IS\s+NULL\s+OR\s+preferred_channel\s+IN/i,
  'preferred_channel CHECK constraint named (nullable accepted)',
);
console.log('  ✓ preferred_channel CHECK constraint named (nullable accepted)');

// =========================================================
// CONTACTS: no global uniqueness on email or names
// =========================================================

assert.doesNotMatch(
  sql,
  /organization_contacts_email_unique|UNIQUE\s*\(\s*email\s*\)/i,
  'email is NOT globally unique',
);
console.log('  ✓ email is NOT globally unique');

assert.doesNotMatch(
  sql,
  /UNIQUE\s*\(\s*first_name\s*,\s*last_name\s*\)/i,
  'first_name + last_name is NOT unique',
);
console.log('  ✓ first_name + last_name is NOT unique');

// =========================================================
// CONTACTS: primary_contact partial unique index
// =========================================================

assert.match(
  sql,
  /CREATE\s+UNIQUE\s+INDEX[^;]*organization_contacts_primary_unique_idx[^;]*\(organization_id\)[^;]*WHERE\s+primary_contact\s*=\s*true/i,
  'partial unique index on primary_contact (max one per organization)',
);
console.log('  ✓ partial unique index on primary_contact (max one per organization)');

// =========================================================
// CONTACTS: indexes
// =========================================================

const contactsIndexChecks = [
  ['index organization_id', /CREATE\s+INDEX[^;]*organization_contacts_organization_id_idx[^;]*\(organization_id\)/i],
  ['index lower(email) partial', /CREATE\s+INDEX[^;]*organization_contacts_email_lower_idx[^;]*lower\(email\)[^;]*WHERE\s+email\s+IS\s+NOT\s+NULL/i],
  ['index active partial', /CREATE\s+INDEX[^;]*organization_contacts_active_idx[^;]*\(active\)[^;]*WHERE\s+active\s*=\s*true/i],
  ['index primary_contact partial', /CREATE\s+INDEX[^;]*organization_contacts_primary_contact_idx[^;]*\(primary_contact\)[^;]*WHERE\s+primary_contact\s*=\s*true/i],
];

for (const [name, pattern] of contactsIndexChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// CONTACTS: updated_at trigger
// =========================================================

const contactsTriggerChecks = [
  ['trigger organization_contacts_set_updated_at', /CREATE\s+TRIGGER\s+organization_contacts_set_updated_at/i],
  ['BEFORE UPDATE ON organization_contacts', /BEFORE\s+UPDATE\s+ON\s+public\.organization_contacts/i],
];

for (const [name, pattern] of contactsTriggerChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// RLS: organization_sites
// =========================================================

const rlsSitesChecks = [
  ['RLS enabled on organization_sites', /ALTER TABLE public\.organization_sites ENABLE ROW LEVEL SECURITY/i],
  ['REVOKE ALL FROM PUBLIC on organization_sites', /REVOKE ALL ON public\.organization_sites FROM PUBLIC/i],
  ['REVOKE ALL FROM anon on organization_sites', /REVOKE ALL ON public\.organization_sites FROM anon/i],
  ['REVOKE ALL FROM authenticated on organization_sites', /REVOKE ALL ON public\.organization_sites FROM authenticated/i],
  ['GRANT CRUD to authenticated on organization_sites', /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON public\.organization_sites TO authenticated/i],
  ['GRANT ALL to service_role on organization_sites', /GRANT ALL ON public\.organization_sites TO service_role/i],
  ['SELECT policy uses is_internal_user', /organization_sites_select_internal[\s\S]*FOR SELECT[\s\S]*is_internal_user\(\)/i],
  ['INSERT policy uses is_internal_user', /organization_sites_insert_internal[\s\S]*FOR INSERT[\s\S]*is_internal_user\(\)/i],
  ['UPDATE policy uses is_internal_user', /organization_sites_update_internal[\s\S]*FOR UPDATE[\s\S]*is_internal_user\(\)/i],
  ['DELETE policy uses is_internal_user', /organization_sites_delete_internal[\s\S]*FOR DELETE[\s\S]*is_internal_user\(\)/i],
];

for (const [name, pattern] of rlsSitesChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// RLS: organization_contacts
// =========================================================

const rlsContactsChecks = [
  ['RLS enabled on organization_contacts', /ALTER TABLE public\.organization_contacts ENABLE ROW LEVEL SECURITY/i],
  ['REVOKE ALL FROM PUBLIC on organization_contacts', /REVOKE ALL ON public\.organization_contacts FROM PUBLIC/i],
  ['REVOKE ALL FROM anon on organization_contacts', /REVOKE ALL ON public\.organization_contacts FROM anon/i],
  ['REVOKE ALL FROM authenticated on organization_contacts', /REVOKE ALL ON public\.organization_contacts FROM authenticated/i],
  ['GRANT CRUD to authenticated on organization_contacts', /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON public\.organization_contacts TO authenticated/i],
  ['GRANT ALL to service_role on organization_contacts', /GRANT ALL ON public\.organization_contacts TO service_role/i],
  ['SELECT policy uses is_internal_user', /organization_contacts_select_internal[\s\S]*FOR SELECT[\s\S]*is_internal_user\(\)/i],
  ['INSERT policy uses is_internal_user', /organization_contacts_insert_internal[\s\S]*FOR INSERT[\s\S]*is_internal_user\(\)/i],
  ['UPDATE policy uses is_internal_user', /organization_contacts_update_internal[\s\S]*FOR UPDATE[\s\S]*is_internal_user\(\)/i],
  ['DELETE policy uses is_internal_user', /organization_contacts_delete_internal[\s\S]*FOR DELETE[\s\S]*is_internal_user\(\)/i],
];

for (const [name, pattern] of rlsContactsChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// POLICY / GRANT CONSISTENCY GUARD
// =========================================================
// Every INSERT/UPDATE/DELETE RLS policy must have a matching GRANT
// to authenticated. Without the GRANT, the policy is dead code
// (PostgreSQL checks SQL privileges BEFORE RLS policies).

const consistencyChecks = [
  {
    name: 'organization_sites INSERT policy has matching GRANT',
    policy: /organization_sites_insert_internal[\s\S]*FOR INSERT/i,
    grant: /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON public\.organization_sites TO authenticated/i,
  },
  {
    name: 'organization_sites UPDATE policy has matching GRANT',
    policy: /organization_sites_update_internal[\s\S]*FOR UPDATE/i,
    grant: /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON public\.organization_sites TO authenticated/i,
  },
  {
    name: 'organization_sites DELETE policy has matching GRANT',
    policy: /organization_sites_delete_internal[\s\S]*FOR DELETE/i,
    grant: /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON public\.organization_sites TO authenticated/i,
  },
  {
    name: 'organization_contacts INSERT policy has matching GRANT',
    policy: /organization_contacts_insert_internal[\s\S]*FOR INSERT/i,
    grant: /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON public\.organization_contacts TO authenticated/i,
  },
  {
    name: 'organization_contacts UPDATE policy has matching GRANT',
    policy: /organization_contacts_update_internal[\s\S]*FOR UPDATE/i,
    grant: /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON public\.organization_contacts TO authenticated/i,
  },
  {
    name: 'organization_contacts DELETE policy has matching GRANT',
    policy: /organization_contacts_delete_internal[\s\S]*FOR DELETE/i,
    grant: /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON public\.organization_contacts TO authenticated/i,
  },
];

for (const { name, policy, grant } of consistencyChecks) {
  assert.match(sql, policy, `${name} — policy exists`);
  assert.match(sql, grant, `${name} — grant exists`);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// NO SECURITY DEFINER FUNCTIONS
// =========================================================
// Strip SQL line comments (-- ...) before checking, so that
// comments mentioning "SECURITY DEFINER" do not produce false positives.

const sqlNoComments = sql.replace(/^--[^\n]*$/gm, '');
const securityDefinerCount = (sqlNoComments.match(/SECURITY\s+DEFINER/gi) || []).length;
assert.equal(securityDefinerCount, 0, 'no SECURITY DEFINER functions introduced in P3B2');
console.log(`  ✓ no SECURITY DEFINER functions (count=${securityDefinerCount})`);

// =========================================================
// NO MODIFICATION TO EXISTING PRODUCTION TABLES
// =========================================================
// P3B2 must NOT ALTER/DROP existing tables (clients, devis, missions,
// billing_records, billing_events, organizations, organization_segments).
// Only references to them through new foreign keys are allowed.

const existingTableAlter = /ALTER TABLE\s+public\.(clients|devis|missions|convoyeurs|billing_records|billing_events|support_tickets|system_settings|user_roles|internal_operators|organizations|organization_segments)\b/i;
assert.doesNotMatch(sql, existingTableAlter, 'does not ALTER existing production tables');
console.log('  ✓ does not ALTER existing production tables');

const existingTableDrop = /DROP TABLE\s+public\.(clients|devis|missions|convoyeurs|billing_records|billing_events|support_tickets|system_settings|user_roles|internal_operators|organizations|organization_segments)\b/i;
assert.doesNotMatch(sql, existingTableDrop, 'does not DROP existing production tables');
console.log('  ✓ does not DROP existing production tables');

// =========================================================
// TRANSACTION WRAPPING
// =========================================================

assert.match(sql, /^BEGIN;/m, 'migration wrapped in BEGIN');
console.log('  ✓ migration wrapped in BEGIN');
assert.match(sql, /COMMIT;/, 'migration wrapped in COMMIT');
console.log('  ✓ migration wrapped in COMMIT');

// =========================================================
// NO DUPLICATE set_updated_at HELPER
// =========================================================
// P3B2 must reuse the existing public.set_updated_at() function,
// not define a new one.

assert.doesNotMatch(
  sqlNoComments,
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.set_updated_at\(\)/i,
  'does not redefine public.set_updated_at() (reuses existing helper)',
);
console.log('  ✓ does not redefine public.set_updated_at() (reuses existing helper)');

console.log('\n========================================');
console.log('P3B2 static migration validation: ALL PASS');
console.log('========================================');
