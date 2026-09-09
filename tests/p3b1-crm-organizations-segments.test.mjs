// P3B1 — CRM Organizations + Segments Foundation — Static Migration Validation
//
// Validates the migration SQL for:
// - organizations table schema (fields, PK, constraints)
// - organization_segments table schema (M:N join, FK, CHECK)
// - SIRET nullable + partial unique index
// - status soft-delete model
// - RLS enabled + internal-user policies
// - grants (anon denied, authenticated SELECT only)
// - no SECURITY DEFINER functions introduced
// - updated_at trigger reuses shared helper
// - no modification to existing production tables

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260909120000_p3b1_crm_organizations_segments.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

// =========================================================
// SCHEMA: organizations
// =========================================================

const organizationsChecks = [
  ['organizations table created', /CREATE TABLE IF NOT EXISTS public\.organizations\s*\(/i],
  ['id uuid PK DEFAULT gen_random_uuid', /id\s+uuid\s+DEFAULT gen_random_uuid\(\)\s+NOT NULL/i],
  ['created_at timestamptz NOT NULL DEFAULT now', /created_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['updated_at timestamptz NOT NULL DEFAULT now', /updated_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['legal_name text NOT NULL', /legal_name\s+text\s+NOT NULL/i],
  ['trade_name text', /trade_name\s+text/i],
  ['siret text (nullable)', /siret\s+text/i],
  ['siren text', /siren\s+text/i],
  ['vat_number text', /vat_number\s+text/i],
  ['email text', /email\s+text/i],
  ['phone text', /phone\s+text/i],
  ['website text', /website\s+text/i],
  ['billing_email text', /billing_email\s+text/i],
  ['billing_address text', /billing_address\s+text/i],
  ['source text', /source\s+text/i],
  ['source_detail text', /source_detail\s+text/i],
  ['external_reference text', /external_reference\s+text/i],
  ['notes text', /notes\s+text/i],
  ['PRIMARY KEY (id)', /PRIMARY KEY\s*\(id\)/i],
];

for (const [name, pattern] of organizationsChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// STATUS CONSTRAINT (soft-delete model)
// =========================================================

const statusChecks = [
  ['status text NOT NULL DEFAULT active', /status\s+text\s+NOT NULL\s+DEFAULT 'active'/i],
  ['status CHECK active/inactive/archived', /CHECK\s*\(status\s+IN\s*\('active',\s*'inactive',\s*'archived'\)\)/i],
];

for (const [name, pattern] of statusChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SIRET / SIREN NORMALIZATION
// =========================================================

const siretChecks = [
  ['siret format check 14 digits', /siret\s+IS\s+NULL\s+OR\s+\(siret\s+~\s*'\^\\d\{14\}\$'\)/i],
  ['siren format check 9 digits', /siren\s+IS\s+NULL\s+OR\s+\(siren\s+~\s*'\^\\d\{9\}\$'\)/i],
  ['legal_name nonempty check', /btrim\(legal_name\)\s*<>\s*''/i],
  ['partial unique index on siret WHERE NOT NULL', /CREATE\s+UNIQUE\s+INDEX[^;]*organizations_siret_unique_idx[^;]*WHERE\s+siret\s+IS\s+NOT\s+NULL/i],
];

for (const [name, pattern] of siretChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// INDEXES
// =========================================================

const indexChecks = [
  ['index lower(legal_name)', /CREATE\s+INDEX[^;]*organizations_legal_name_lower_idx[^;]*lower\(legal_name\)/i],
  ['index lower(trade_name) partial', /CREATE\s+INDEX[^;]*organizations_trade_name_lower_idx[^;]*lower\(trade_name\)[^;]*WHERE\s+trade_name\s+IS\s+NOT\s+NULL/i],
  ['index status', /CREATE\s+INDEX[^;]*organizations_status_idx[^;]*\(status\)/i],
];

for (const [name, pattern] of indexChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SCHEMA: organization_segments (M:N join)
// =========================================================

const segmentsChecks = [
  ['organization_segments table created', /CREATE TABLE IF NOT EXISTS public\.organization_segments\s*\(/i],
  ['organization_id uuid NOT NULL', /organization_id\s+uuid\s+NOT NULL/i],
  ['FK organization_id → organizations(id) ON DELETE CASCADE', /REFERENCES\s+public\.organizations\(id\)\s+ON DELETE CASCADE/i],
  ['segment text NOT NULL', /segment\s+text\s+NOT NULL/i],
  ['created_at timestamptz NOT NULL DEFAULT now', /created_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['composite PK (organization_id, segment)', /PRIMARY KEY\s*\(organization_id,\s*segment\)/i],
];

for (const [name, pattern] of segmentsChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SEGMENT VALUES CHECK
// =========================================================

const segmentValues = [
  'concession', 'garage', 'rental', 'auction', 'notary',
  'fleet', 'leasing', 'dealer', 'logistics', 'other',
];

for (const seg of segmentValues) {
  const pattern = new RegExp(`'${seg}'`, 'i');
  assert.match(sql, pattern, `segment value '${seg}' allowed`);
  console.log(`  ✓ segment value '${seg}' allowed`);
}

// =========================================================
// UPDATED_AT TRIGGER
// =========================================================

const triggerChecks = [
  ['reuses public.set_updated_at()', /EXECUTE FUNCTION public\.set_updated_at\(\)/i],
  ['trigger organizations_set_updated_at', /CREATE\s+TRIGGER\s+organizations_set_updated_at/i],
  ['BEFORE UPDATE ON organizations', /BEFORE\s+UPDATE\s+ON\s+public\.organizations/i],
];

for (const [name, pattern] of triggerChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// RLS: organizations
// =========================================================

const rlsOrgChecks = [
  ['RLS enabled on organizations', /ALTER TABLE public\.organizations ENABLE ROW LEVEL SECURITY/i],
  ['REVOKE ALL FROM PUBLIC on organizations', /REVOKE ALL ON public\.organizations FROM PUBLIC/i],
  ['REVOKE ALL FROM anon on organizations', /REVOKE ALL ON public\.organizations FROM anon/i],
  ['REVOKE ALL FROM authenticated on organizations', /REVOKE ALL ON public\.organizations FROM authenticated/i],
  ['GRANT SELECT to authenticated on organizations', /GRANT SELECT ON public\.organizations TO authenticated/i],
  ['SELECT policy uses is_internal_user', /organizations_select_internal[\s\S]*FOR SELECT[\s\S]*is_internal_user\(\)/i],
  ['INSERT policy uses is_internal_user', /organizations_insert_internal[\s\S]*FOR INSERT[\s\S]*is_internal_user\(\)/i],
  ['UPDATE policy uses is_internal_user', /organizations_update_internal[\s\S]*FOR UPDATE[\s\S]*is_internal_user\(\)/i],
  ['DELETE policy admin-only (is_admin)', /organizations_delete_admin[\s\S]*FOR DELETE[\s\S]*is_admin\(\)/i],
];

for (const [name, pattern] of rlsOrgChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// RLS: organization_segments
// =========================================================

const rlsSegChecks = [
  ['RLS enabled on organization_segments', /ALTER TABLE public\.organization_segments ENABLE ROW LEVEL SECURITY/i],
  ['REVOKE ALL FROM PUBLIC on organization_segments', /REVOKE ALL ON public\.organization_segments FROM PUBLIC/i],
  ['REVOKE ALL FROM anon on organization_segments', /REVOKE ALL ON public\.organization_segments FROM anon/i],
  ['REVOKE ALL FROM authenticated on organization_segments', /REVOKE ALL ON public\.organization_segments FROM authenticated/i],
  ['GRANT SELECT to authenticated on organization_segments', /GRANT SELECT ON public\.organization_segments TO authenticated/i],
  ['SELECT policy uses is_internal_user', /organization_segments_select_internal[\s\S]*FOR SELECT[\s\S]*is_internal_user\(\)/i],
  ['INSERT policy uses is_internal_user', /organization_segments_insert_internal[\s\S]*FOR INSERT[\s\S]*is_internal_user\(\)/i],
  ['DELETE policy uses is_internal_user', /organization_segments_delete_internal[\s\S]*FOR DELETE[\s\S]*is_internal_user\(\)/i],
];

for (const [name, pattern] of rlsSegChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// NO SECURITY DEFINER FUNCTIONS
// =========================================================
// Strip SQL line comments (-- ...) before checking, so that
// comments mentioning "SECURITY DEFINER" do not produce false positives.

const sqlNoComments = sql.replace(/^--[^\n]*$/gm, '');
const securityDefinerCount = (sqlNoComments.match(/SECURITY\s+DEFINER/gi) || []).length;
assert.equal(securityDefinerCount, 0, 'no SECURITY DEFINER functions introduced in P3B1');
console.log(`  ✓ no SECURITY DEFINER functions (count=${securityDefinerCount})`);

// =========================================================
// NO MODIFICATION TO EXISTING PRODUCTION TABLES
// =========================================================

const existingTableAlter = /ALTER TABLE\s+(?!public\.organizations|public\.organization_segments)\s*public\.(clients|devis|missions|convoyeurs|billing_records|billing_events|support_tickets|system_settings|user_roles|internal_operators)\b/i;
assert.doesNotMatch(sql, existingTableAlter, 'does not ALTER existing production tables');
console.log('  ✓ does not ALTER existing production tables');

const existingTableDrop = /DROP TABLE\s+public\.(clients|devis|missions|convoyeurs|billing_records|billing_events|support_tickets|system_settings|user_roles|internal_operators)\b/i;
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
// OWNER_USER_ID DEFERRED
// =========================================================

assert.doesNotMatch(sql, /owner_user_id/i, 'owner_user_id NOT added (deferred — no commercial owner role in P3)');
console.log('  ✓ owner_user_id deferred (not added)');

console.log('\n========================================');
console.log('P3B1 static migration validation: ALL PASS');
console.log('========================================');
