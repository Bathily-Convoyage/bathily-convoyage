// =========================================================
// P3B5 — CRM Business Links Static Migration Validation
// =========================================================
// Validates the migration SQL without a running database.
// Run: node tests/p3b5-crm-business-links.test.mjs
// =========================================================

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const migrationPath = path.join(
  projectRoot,
  'supabase',
  'migrations',
  '20260910110000_p3b5_crm_business_links.sql',
);

assert.ok(fs.existsSync(migrationPath), `migration file exists: ${migrationPath}`);
const sql = fs.readFileSync(migrationPath, 'utf8');

console.log('=== P3B5 Static Migration Validation ===\n');

// =========================================================
// COLUMNS (6)
// =========================================================
assert.match(sql, /ALTER\s+TABLE\s+public\.clients\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+organization_id\s+uuid/i, 'clients.organization_id added');
console.log('  ✓ clients.organization_id added');

assert.match(sql, /ALTER\s+TABLE\s+public\.devis\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+organization_id\s+uuid/i, 'devis.organization_id added');
console.log('  ✓ devis.organization_id added');

assert.match(sql, /ALTER\s+TABLE\s+public\.devis[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+contact_id\s+uuid/i, 'devis.contact_id added');
console.log('  ✓ devis.contact_id added');

assert.match(sql, /ALTER\s+TABLE\s+public\.devis[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+opportunity_id\s+uuid/i, 'devis.opportunity_id added');
console.log('  ✓ devis.opportunity_id added');

assert.match(sql, /ALTER\s+TABLE\s+public\.missions\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+devis_id\s+uuid/i, 'missions.devis_id added');
console.log('  ✓ missions.devis_id added');

assert.match(sql, /ALTER\s+TABLE\s+public\.missions[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+organization_id\s+uuid/i, 'missions.organization_id added');
console.log('  ✓ missions.organization_id added');

// No backfill: the only UPDATEs in the migration are inside RPC function bodies
// (crm_link_client_organization, crm_link_devis_crm, crm_link_mission_devis)
// which set organization_id = p_organization_id (a parameter, not a join/subquery).
// There are no standalone UPDATE statements outside function bodies.
const updateCount = (sql.match(/UPDATE\s+public\.(clients|devis|missions)\s+SET\s+organization_id/gi) || []).length;
assert.equal(updateCount, 2, `exactly 2 UPDATEs setting organization_id (RPCs only), found ${updateCount}`);
console.log('  ✓ no backfill UPDATE (only 2 RPC UPDATEs set organization_id)');

// No missions.contact_id or missions.opportunity_id
assert.doesNotMatch(sql, /ALTER\s+TABLE\s+public\.missions[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+contact_id/i, 'no missions.contact_id');
assert.doesNotMatch(sql, /ALTER\s+TABLE\s+public\.missions[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+opportunity_id/i, 'no missions.opportunity_id');
console.log('  ✓ no missions.contact_id or missions.opportunity_id');

// =========================================================
// FOREIGN KEYS (6)
// =========================================================
assert.match(sql, /clients_organization_id_fkey[\s\S]*?FOREIGN\s+KEY\s+\(organization_id\)\s+REFERENCES\s+public\.organizations\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i, 'clients.organization_id FK SET NULL');
console.log('  ✓ clients.organization_id FK ON DELETE SET NULL');

assert.match(sql, /devis_organization_id_fkey[\s\S]*?FOREIGN\s+KEY\s+\(organization_id\)\s+REFERENCES\s+public\.organizations\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i, 'devis.organization_id FK SET NULL');
console.log('  ✓ devis.organization_id FK ON DELETE SET NULL');

assert.match(sql, /devis_contact_id_fkey[\s\S]*?FOREIGN\s+KEY\s+\(contact_id\)\s+REFERENCES\s+public\.organization_contacts\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i, 'devis.contact_id FK SET NULL');
console.log('  ✓ devis.contact_id FK ON DELETE SET NULL');

assert.match(sql, /devis_opportunity_id_fkey[\s\S]*?FOREIGN\s+KEY\s+\(opportunity_id\)\s+REFERENCES\s+public\.crm_opportunities\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i, 'devis.opportunity_id FK SET NULL');
console.log('  ✓ devis.opportunity_id FK ON DELETE SET NULL');

assert.match(sql, /missions_devis_id_fkey[\s\S]*?FOREIGN\s+KEY\s+\(devis_id\)\s+REFERENCES\s+public\.devis\(id\)\s+ON\s+DELETE\s+RESTRICT/i, 'missions.devis_id FK RESTRICT');
console.log('  ✓ missions.devis_id FK ON DELETE RESTRICT');

assert.match(sql, /missions_organization_id_fkey[\s\S]*?FOREIGN\s+KEY\s+\(organization_id\)\s+REFERENCES\s+public\.organizations\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i, 'missions.organization_id FK SET NULL');
console.log('  ✓ missions.organization_id FK ON DELETE SET NULL');

// No CASCADE on business-record deletion
assert.doesNotMatch(sql, /ON\s+DELETE\s+CASCADE/i, 'no ON DELETE CASCADE');
console.log('  ✓ no ON DELETE CASCADE');

// No devis.client_id FK
assert.doesNotMatch(sql, /devis_client_id_fkey/i, 'no devis.client_id FK');
console.log('  ✓ no devis.client_id FK (debt remains open)');

// =========================================================
// INDEXES (6 partial)
// =========================================================
const indexChecks = [
  ['idx_clients_organization_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_clients_organization_id[\s\S]*?WHERE\s+organization_id\s+IS\s+NOT\s+NULL/i],
  ['idx_devis_organization_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_devis_organization_id[\s\S]*?WHERE\s+organization_id\s+IS\s+NOT\s+NULL/i],
  ['idx_devis_contact_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_devis_contact_id[\s\S]*?WHERE\s+contact_id\s+IS\s+NOT\s+NULL/i],
  ['idx_devis_opportunity_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_devis_opportunity_id[\s\S]*?WHERE\s+opportunity_id\s+IS\s+NOT\s+NULL/i],
  ['idx_missions_devis_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_missions_devis_id[\s\S]*?WHERE\s+devis_id\s+IS\s+NOT\s+NULL/i],
  ['idx_missions_organization_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_missions_organization_id[\s\S]*?WHERE\s+organization_id\s+IS\s+NOT\s+NULL/i],
];

for (const [name, pattern] of indexChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name} (partial)`);
}

// =========================================================
// AUTHORIZATION GUARD: guard_clients_organization_id
// =========================================================
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.guard_clients_organization_id\(\)/i, 'guard_clients_organization_id exists');
console.log('  ✓ guard_clients_organization_id exists');

assert.match(sql, /guard_clients_organization_id[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/is, 'guard_clients_organization_id SECURITY DEFINER + search_path');
console.log("  ✓ guard_clients_organization_id: SECURITY DEFINER + SET search_path = ''");

// INSERT: non-null requires is_admin() OR is_operator()
assert.match(sql, /guard_clients_organization_id[\s\S]*?TG_OP\s*=\s*'INSERT'[\s\S]*?NEW\.organization_id\s+IS\s+NOT\s+NULL[\s\S]*?is_admin\(\)\s+OR\s+public\.is_operator\(\)/is, 'INSERT authorization check');
console.log('  ✓ INSERT: non-null org requires is_admin() OR is_operator()');

// UPDATE: IS DISTINCT FROM OLD requires is_admin() OR is_operator()
assert.match(sql, /guard_clients_organization_id[\s\S]*?NEW\.organization_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.organization_id[\s\S]*?is_admin\(\)\s+OR\s+public\.is_operator\(\)/is, 'UPDATE authorization check');
console.log('  ✓ UPDATE: IS DISTINCT FROM OLD requires is_admin() OR is_operator() (covers unlink)');

// NOT auth.uid() IS NULL bypass
assert.doesNotMatch(sql, /guard_clients_organization_id[\s\S]*?auth\.uid\(\)\s+IS\s+NULL[\s\S]*?RETURN\s+NEW/is, 'no auth.uid() IS NULL bypass in guard_clients_organization_id');
console.log('  ✓ no auth.uid() IS NULL bypass');

// EXECUTE revoked
assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.guard_clients_organization_id\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i, 'EXECUTE revoked');
console.log('  ✓ guard_clients_organization_id EXECUTE revoked from all');

// =========================================================
// AUTHORIZATION + CONSISTENCY: devis_guard_crm_links
// =========================================================
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.devis_guard_crm_links\(\)/i, 'devis_guard_crm_links exists');
console.log('  ✓ devis_guard_crm_links exists');

assert.match(sql, /devis_guard_crm_links[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/is, 'devis_guard_crm_links SECURITY DEFINER + search_path');
console.log("  ✓ devis_guard_crm_links: SECURITY DEFINER + SET search_path = ''");

// Phase 1: INSERT mutation detection
assert.match(sql, /devis_guard_crm_links[\s\S]*?TG_OP\s*=\s*'INSERT'[\s\S]*?NEW\.organization_id\s+IS\s+NOT\s+NULL[\s\S]*?NEW\.contact_id\s+IS\s+NOT\s+NULL[\s\S]*?NEW\.opportunity_id\s+IS\s+NOT\s+NULL/is, 'INSERT mutation detection');
console.log('  ✓ INSERT mutation detection (any CRM link non-null)');

// Phase 1: UPDATE mutation detection (IS DISTINCT FROM — covers unlink)
assert.match(sql, /devis_guard_crm_links[\s\S]*?NEW\.organization_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.organization_id[\s\S]*?NEW\.contact_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.contact_id[\s\S]*?NEW\.opportunity_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.opportunity_id/is, 'UPDATE mutation detection');
console.log('  ✓ UPDATE mutation detection (IS DISTINCT FROM — covers unlink)');

// Phase 1: is_internal_user() authorization
assert.match(sql, /devis_guard_crm_links[\s\S]*?_crm_mutation\s+AND\s+NOT\s+public\.is_internal_user\(\)/is, 'is_internal_user() authorization');
console.log('  ✓ Phase 1: is_internal_user() authorization');

// Phase 2: contact/org consistency with FOR SHARE
assert.match(sql, /devis_guard_crm_links[\s\S]*?NEW\.contact_id\s+IS\s+NOT\s+NULL[\s\S]*?organization_contacts[\s\S]*?FOR\s+SHARE/is, 'contact/org consistency with FOR SHARE');
console.log('  ✓ Phase 2: contact/org consistency with FOR SHARE');

// Phase 2: opportunity/org consistency with FOR SHARE
assert.match(sql, /devis_guard_crm_links[\s\S]*?NEW\.opportunity_id\s+IS\s+NOT\s+NULL[\s\S]*?crm_opportunities[\s\S]*?FOR\s+SHARE/is, 'opportunity/org consistency with FOR SHARE');
console.log('  ✓ Phase 2: opportunity/org consistency with FOR SHARE');

// Phase 2: client/org consistency with FOR SHARE
assert.match(sql, /devis_guard_crm_links[\s\S]*?NEW\.client_id\s+IS\s+NOT\s+NULL[\s\S]*?public\.clients[\s\S]*?FOR\s+SHARE/is, 'client/org consistency with FOR SHARE');
console.log('  ✓ Phase 2: client/org consistency with FOR SHARE');

// EXECUTE revoked
assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.devis_guard_crm_links\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i, 'EXECUTE revoked');
console.log('  ✓ devis_guard_crm_links EXECUTE revoked from all');

// =========================================================
// AUTHORIZATION + CONSISTENCY: missions_check_devis_org
// =========================================================
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.missions_check_devis_org\(\)/i, 'missions_check_devis_org exists');
console.log('  ✓ missions_check_devis_org exists');

assert.match(sql, /missions_check_devis_org[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/is, 'missions_check_devis_org SECURITY DEFINER + search_path');
console.log("  ✓ missions_check_devis_org: SECURITY DEFINER + SET search_path = ''");

// Phase 1: INSERT mutation detection
assert.match(sql, /missions_check_devis_org[\s\S]*?TG_OP\s*=\s*'INSERT'[\s\S]*?NEW\.devis_id\s+IS\s+NOT\s+NULL[\s\S]*?NEW\.organization_id\s+IS\s+NOT\s+NULL/is, 'INSERT mutation detection');
console.log('  ✓ INSERT mutation detection');

// Phase 1: UPDATE mutation detection (IS DISTINCT FROM — covers unlink)
assert.match(sql, /missions_check_devis_org[\s\S]*?NEW\.devis_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.devis_id[\s\S]*?NEW\.organization_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.organization_id/is, 'UPDATE mutation detection');
console.log('  ✓ UPDATE mutation detection (IS DISTINCT FROM — covers unlink)');

// CRITICAL: No IS NOT NULL bypass in any UPDATE mutation detection
// The pattern "NEW.col IS NOT NULL AND NEW.col IS DISTINCT FROM OLD.col"
// would bypass authorization for value→NULL unlinks. This must NOT exist.
const unlinkBypassPatterns = [
  /NEW\.organization_id\s+IS\s+NOT\s+NULL\s+AND\s+NEW\.organization_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.organization_id/i,
  /NEW\.contact_id\s+IS\s+NOT\s+NULL\s+AND\s+NEW\.contact_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.contact_id/i,
  /NEW\.opportunity_id\s+IS\s+NOT\s+NULL\s+AND\s+NEW\.opportunity_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.opportunity_id/i,
  /NEW\.devis_id\s+IS\s+NOT\s+NULL\s+AND\s+NEW\.devis_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.devis_id/i,
];
for (const pat of unlinkBypassPatterns) {
  assert.ok(!pat.test(sql), 'No IS NOT NULL bypass in UPDATE mutation detection');
}
console.log('  ✓ No IS NOT NULL bypass in UPDATE mutation detection (unlink requires auth)');

// Phase 1: is_internal_user() authorization
assert.match(sql, /missions_check_devis_org[\s\S]*?_crm_mutation\s+AND\s+NOT\s+public\.is_internal_user\(\)/is, 'is_internal_user() authorization');
console.log('  ✓ Phase 1: is_internal_user() authorization');

// Phase 2: devis/org consistency with FOR SHARE
assert.match(sql, /missions_check_devis_org[\s\S]*?NEW\.devis_id\s+IS\s+NOT\s+NULL[\s\S]*?public\.devis[\s\S]*?FOR\s+SHARE/is, 'devis/org consistency with FOR SHARE');
console.log('  ✓ Phase 2: devis/org consistency with FOR SHARE');

// EXECUTE revoked
assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.missions_check_devis_org\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i, 'EXECUTE revoked');
console.log('  ✓ missions_check_devis_org EXECUTE revoked from all');

// =========================================================
// PARENT GRAPH GUARDS
// =========================================================

// Helper: extract a function body block from the SQL
function extractFunctionBlock(fnName) {
  const block = sql.match(
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fnName}\\([\\s\\S]*?\\$\\$;`, 'i'),
  );
  assert.ok(block, `function block found for ${fnName}`);
  return block[0];
}

// clients_guard_reparent
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.clients_guard_reparent\(\)/i, 'clients_guard_reparent exists');
console.log('  ✓ clients_guard_reparent exists');

{
  const block = extractFunctionBlock('clients_guard_reparent');
  assert.match(block, /SECURITY\s+DEFINER/i, 'clients_guard_reparent SECURITY DEFINER');
  assert.match(block, /SET\s+search_path\s*=\s*''/i, 'clients_guard_reparent search_path');
  console.log("  ✓ clients_guard_reparent: SECURITY DEFINER + SET search_path = ''");

  // NULL org = no constraint
  assert.match(block, /NEW\.organization_id\s+IS\s+NULL[\s\S]*?RETURN\s+NEW/is, 'clients_guard_reparent NULL org = no constraint');
  console.log('  ✓ clients_guard_reparent: NULL org = no constraint (ALLOW)');

  // Plain SELECT on dependents (no FOR SHARE)
  assert.match(block, /FROM\s+public\.organization_contacts[\s\S]*?WHERE\s+client_id\s*=\s*NEW\.id/is, 'clients_guard_reparent checks contacts');
  console.log('  ✓ clients_guard_reparent checks linked contacts');

  assert.match(block, /FROM\s+public\.devis[\s\S]*?WHERE\s+client_id\s*=\s*NEW\.id/is, 'clients_guard_reparent checks devis');
  console.log('  ✓ clients_guard_reparent checks linked devis');

  assert.doesNotMatch(block, /FOR\s+SHARE/is, 'clients_guard_reparent no FOR SHARE on dependents');
  console.log('  ✓ clients_guard_reparent: NO FOR SHARE on dependents (deadlock-safe)');
}

// devis_guard_reparent
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.devis_guard_reparent\(\)/i, 'devis_guard_reparent exists');
console.log('  ✓ devis_guard_reparent exists');

{
  const block = extractFunctionBlock('devis_guard_reparent');
  assert.match(block, /SECURITY\s+DEFINER/i, 'devis_guard_reparent SECURITY DEFINER');
  assert.match(block, /SET\s+search_path\s*=\s*''/i, 'devis_guard_reparent search_path');
  console.log("  ✓ devis_guard_reparent: SECURITY DEFINER + SET search_path = ''");

  assert.match(block, /FROM\s+public\.missions[\s\S]*?WHERE\s+devis_id\s*=\s*NEW\.id/is, 'devis_guard_reparent checks missions');
  console.log('  ✓ devis_guard_reparent checks linked missions');

  assert.doesNotMatch(block, /FOR\s+SHARE/is, 'devis_guard_reparent no FOR SHARE on dependents');
  console.log('  ✓ devis_guard_reparent: NO FOR SHARE on dependents (deadlock-safe)');
}

// organization_contacts_check_client_org
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.organization_contacts_check_client_org\(\)/i, 'organization_contacts_check_client_org exists');
console.log('  ✓ organization_contacts_check_client_org exists');

{
  const block = extractFunctionBlock('organization_contacts_check_client_org');
  assert.match(block, /SECURITY\s+DEFINER/i, 'organization_contacts_check_client_org SECURITY DEFINER');
  assert.match(block, /SET\s+search_path\s*=\s*''/i, 'organization_contacts_check_client_org search_path');
  console.log("  ✓ organization_contacts_check_client_org: SECURITY DEFINER + SET search_path = ''");

  assert.match(block, /FROM\s+public\.clients[\s\S]*?FOR\s+SHARE/is, 'organization_contacts_check_client_org locks client FOR SHARE');
  console.log('  ✓ organization_contacts_check_client_org: locks client FOR SHARE (child-side)');
}

// =========================================================
// EXTENDED P3B4 REPARENT GUARDS
// =========================================================

// organization_contacts_guard_reparent extended with devis
{
  const block = extractFunctionBlock('organization_contacts_guard_reparent');
  assert.match(block, /FROM\s+public\.devis\s+d[\s\S]*?d\.contact_id\s*=\s*NEW\.id/is, 'contact reparent checks devis');
  console.log('  ✓ organization_contacts_guard_reparent extended: checks dependent devis');

  assert.match(block, /NEW\.client_id\s+IS\s+NOT\s+NULL[\s\S]*?FROM\s+public\.clients/is, 'contact reparent checks client org');
  console.log('  ✓ organization_contacts_guard_reparent extended: checks client org consistency');

  assert.doesNotMatch(block, /FOR\s+SHARE/is, 'contact reparent no FOR SHARE on dependents');
  console.log('  ✓ organization_contacts_guard_reparent: NO FOR SHARE on dependents');
}

// crm_opportunities_guard_reparent extended with devis
{
  const block = extractFunctionBlock('crm_opportunities_guard_reparent');
  assert.match(block, /FROM\s+public\.devis\s+d[\s\S]*?d\.opportunity_id\s*=\s*NEW\.id/is, 'opportunity reparent checks devis');
  console.log('  ✓ crm_opportunities_guard_reparent extended: checks dependent devis');

  assert.doesNotMatch(block, /FOR\s+SHARE/is, 'opportunity reparent no FOR SHARE on dependents');
  console.log('  ✓ crm_opportunities_guard_reparent: NO FOR SHARE on dependents');
}

// =========================================================
// RPCs (3)
// =========================================================

// crm_link_client_organization
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_link_client_organization\(\s*p_client_id\s+uuid,\s*p_organization_id\s+uuid\s*\)/i, 'crm_link_client_organization signature');
console.log('  ✓ crm_link_client_organization(client_id, organization_id) — no defaults');

{
  const block = extractFunctionBlock('crm_link_client_organization');
  assert.match(block, /SECURITY\s+DEFINER/i, 'crm_link_client_organization SECURITY DEFINER');
  assert.match(block, /SET\s+search_path\s*=\s*''/i, 'crm_link_client_organization search_path');
  console.log("  ✓ crm_link_client_organization: SECURITY DEFINER + SET search_path = ''");

  assert.match(block, /is_internal_user\(\)/i, 'crm_link_client_organization authorization');
  console.log('  ✓ crm_link_client_organization: is_internal_user() gate');
}

assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_link_client_organization\(uuid,\s*uuid\)\s+FROM\s+PUBLIC,\s*anon,\s*service_role/i, 'crm_link_client_organization REVOKE');
console.log('  ✓ crm_link_client_organization: EXECUTE revoked from PUBLIC, anon, service_role');

assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_link_client_organization\(uuid,\s*uuid\)\s+TO\s+authenticated/i, 'crm_link_client_organization GRANT');
console.log('  ✓ crm_link_client_organization: EXECUTE granted to authenticated');

// crm_link_devis_crm
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_link_devis_crm\(\s*p_devis_id\s+uuid,\s*p_organization_id\s+uuid,\s*p_contact_id\s+uuid,\s*p_opportunity_id\s+uuid\s*\)/i, 'crm_link_devis_crm signature');
console.log('  ✓ crm_link_devis_crm(devis_id, organization_id, contact_id, opportunity_id) — no defaults');

{
  const block = extractFunctionBlock('crm_link_devis_crm');
  assert.match(block, /SECURITY\s+DEFINER/i, 'crm_link_devis_crm SECURITY DEFINER');
  assert.match(block, /SET\s+search_path\s*=\s*''/i, 'crm_link_devis_crm search_path');
  console.log("  ✓ crm_link_devis_crm: SECURITY DEFINER + SET search_path = ''");

  assert.match(block, /is_internal_user\(\)/i, 'crm_link_devis_crm authorization');
  console.log('  ✓ crm_link_devis_crm: is_internal_user() gate');

  assert.match(block, /SET\s+organization_id\s*=\s*p_organization_id,\s*contact_id\s*=\s*p_contact_id,\s*opportunity_id\s*=\s*p_opportunity_id/is, 'crm_link_devis_crm full replacement');
  console.log('  ✓ crm_link_devis_crm: FULL_REPLACEMENT of 3 CRM columns');
}

assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_link_devis_crm\(uuid,\s*uuid,\s*uuid,\s*uuid\)\s+FROM\s+PUBLIC,\s*anon,\s*service_role/i, 'crm_link_devis_crm REVOKE');
console.log('  ✓ crm_link_devis_crm: EXECUTE revoked from PUBLIC, anon, service_role');

assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_link_devis_crm\(uuid,\s*uuid,\s*uuid,\s*uuid\)\s+TO\s+authenticated/i, 'crm_link_devis_crm GRANT');
console.log('  ✓ crm_link_devis_crm: EXECUTE granted to authenticated');

// crm_link_mission_devis
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_link_mission_devis\(\s*p_mission_id\s+uuid,\s*p_devis_id\s+uuid,\s*p_organization_id\s+uuid\s*\)/i, 'crm_link_mission_devis signature');
console.log('  ✓ crm_link_mission_devis(mission_id, devis_id, organization_id) — no defaults');

{
  const block = extractFunctionBlock('crm_link_mission_devis');
  assert.match(block, /SECURITY\s+DEFINER/i, 'crm_link_mission_devis SECURITY DEFINER');
  assert.match(block, /SET\s+search_path\s*=\s*''/i, 'crm_link_mission_devis search_path');
  console.log("  ✓ crm_link_mission_devis: SECURITY DEFINER + SET search_path = ''");

  assert.match(block, /is_internal_user\(\)/i, 'crm_link_mission_devis authorization');
  console.log('  ✓ crm_link_mission_devis: is_internal_user() gate');

  assert.match(block, /SET\s+devis_id\s*=\s*p_devis_id,\s*organization_id\s*=\s*p_organization_id/is, 'crm_link_mission_devis full replacement');
  console.log('  ✓ crm_link_mission_devis: FULL_REPLACEMENT of 2 CRM columns');
}

assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_link_mission_devis\(uuid,\s*uuid,\s*uuid\)\s+FROM\s+PUBLIC,\s*anon,\s*service_role/i, 'crm_link_mission_devis REVOKE');
console.log('  ✓ crm_link_mission_devis: EXECUTE revoked from PUBLIC, anon, service_role');

assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_link_mission_devis\(uuid,\s*uuid,\s*uuid\)\s+TO\s+authenticated/i, 'crm_link_mission_devis GRANT');
console.log('  ✓ crm_link_mission_devis: EXECUTE granted to authenticated');

// No default arguments (no DEFAULT keyword in RPC signatures)
const rpcSignatures = sql.match(/crm_link_client_organization\([^)]+\)|crm_link_devis_crm\([^)]+\)|crm_link_mission_devis\([^)]+\)/gi) || [];
for (const sig of rpcSignatures) {
  if (sig.includes('CREATE') || sig.includes('REPLACE')) continue;
  assert.doesNotMatch(sig, /DEFAULT/i, `no DEFAULT in ${sig}`);
}
console.log('  ✓ no DEFAULT arguments in any RPC');

// =========================================================
// SECURITY DEFINER INVENTORY (11 total)
// =========================================================
const sqlNoComments = sql.replace(/^\s*--[^\n]*$/gm, '');
const sdCount = (sqlNoComments.match(/SECURITY\s+DEFINER/gi) || []).length;
assert.equal(sdCount, 11, `exactly 11 SECURITY DEFINER functions, found ${sdCount}`);
console.log(`  ✓ exactly 11 SECURITY DEFINER functions (count=${sdCount})`);

// All have SET search_path = ''
const sdFunctions = [
  'guard_clients_organization_id',
  'devis_guard_crm_links',
  'missions_check_devis_org',
  'clients_guard_reparent',
  'devis_guard_reparent',
  'organization_contacts_check_client_org',
  'organization_contacts_guard_reparent',
  'crm_opportunities_guard_reparent',
  'crm_link_client_organization',
  'crm_link_devis_crm',
  'crm_link_mission_devis',
];
for (const fn of sdFunctions) {
  const block = sql.match(
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\([\\s\\S]*?\\$\\$;`, 'i'),
  );
  assert.ok(block, `function block found for ${fn}`);
  assert.match(block[0], /SECURITY\s+DEFINER/i, `${fn} is SECURITY DEFINER`);
  assert.match(block[0], /SET\s+search_path\s*=\s*''/i, `${fn} has SET search_path = ''`);
}
console.log('  ✓ all 11 SD functions have SET search_path = \'\'');

// All have OWNER postgres
for (const fn of sdFunctions) {
  assert.match(sql, new RegExp(`ALTER\\s+FUNCTION\\s+public\\.${fn}\\([^)]*\\)\\s+OWNER\\s+TO\\s+postgres`, 'i'), `${fn} OWNER postgres`);
}
console.log('  ✓ all 11 SD functions have OWNER postgres');

// Trigger-only functions: EXECUTE revoked from PUBLIC, anon, authenticated, service_role
const triggerOnlyFns = sdFunctions.slice(0, 8);
for (const fn of sdFunctions.slice(0, 8)) {
  assert.match(sql, new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn}\\(\\)\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated,\\s*service_role`, 'i'), `${fn} EXECUTE revoked`);
}
console.log('  ✓ 8 trigger-only functions: EXECUTE revoked from all');

// RPCs: EXECUTE revoked from PUBLIC, anon, service_role; granted to authenticated
const rpcFns = sdFunctions.slice(8);
for (const fn of rpcFns) {
  // RPCs have typed arguments, so we need a more flexible regex
  assert.match(sql, new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn}\\([^)]*\\)\\s+FROM\\s+PUBLIC,\\s*anon,\\s*service_role`, 'i'), `${fn} EXECUTE revoked from PUBLIC, anon, service_role`);
  assert.match(sql, new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fn}\\([^)]*\\)\\s+TO\\s+authenticated`, 'i'), `${fn} EXECUTE granted to authenticated`);
}
console.log('  ✓ 3 RPCs: EXECUTE revoked from PUBLIC, anon, service_role; granted to authenticated');

// =========================================================
// NO RLS EXPANSION
// =========================================================
assert.doesNotMatch(sql, /CREATE\s+POLICY/i, 'no new RLS policies');
console.log('  ✓ no new RLS policies (no RLS expansion)');

assert.doesNotMatch(sql, /ALTER\s+TABLE\s+public\.(clients|devis|missions)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i, 'no RLS enable on existing tables');
console.log('  ✓ no RLS changes to existing tables');

// =========================================================
// NO GRANT CHANGES TO EXISTING TABLES
// =========================================================
assert.doesNotMatch(sql, /GRANT\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\s+ON\s+public\.(clients|devis|missions)\s+TO/i, 'no table-level grants on existing tables');
console.log('  ✓ no table-level grants on clients/devis/missions');

// =========================================================
// NO MODIFICATION TO EXISTING P3B1-P3B4 MIGRATIONS
// =========================================================
// The migration must not ALTER existing CRM tables (no column/FK/RLS changes).
// CREATE TRIGGER and DROP TRIGGER IF EXISTS are allowed (additive triggers only).
assert.doesNotMatch(sql, /ALTER\s+TABLE\s+public\.(organizations|organization_segments|organization_sites|organization_contacts|crm_opportunities|crm_pipeline_events|crm_activities)\s+(ADD|DROP|ENABLE|DISABLE|RENAME|ALTER|OWNER)/i, 'no ALTER TABLE on CRM tables');
console.log('  ✓ no ALTER TABLE on CRM tables');

// =========================================================
// NO FINANCE TABLES
// =========================================================
assert.doesNotMatch(sql, /CREATE\s+TABLE.*expense/i, 'no expenses table');
assert.doesNotMatch(sql, /CREATE\s+TABLE.*journal_entr/i, 'no journal_entries table');
assert.doesNotMatch(sql, /CREATE\s+TABLE.*treasury/i, 'no treasury table');
assert.doesNotMatch(sql, /CREATE\s+TABLE.*bank_transaction/i, 'no bank_transactions table');
assert.doesNotMatch(sql, /CREATE\s+TABLE.*accounting/i, 'no accounting table');
console.log('  ✓ no finance tables');

// =========================================================
// NO GENERIC ELEVATED CRUD RPC
// =========================================================
assert.doesNotMatch(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_admin_write/i, 'no generic admin write RPC');
assert.doesNotMatch(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_business_write/i, 'no generic business write RPC');
console.log('  ✓ no generic elevated CRUD RPC');

// =========================================================
// NO AUTOMATIC CASCADE
// =========================================================
{
  const block = extractFunctionBlock('clients_guard_reparent');
  assert.doesNotMatch(block, /UPDATE\s+public\.(organization_contacts|devis)/is, 'clients_guard_reparent does not cascade');
}
{
  const block = extractFunctionBlock('devis_guard_reparent');
  assert.doesNotMatch(block, /UPDATE\s+public\.missions/is, 'devis_guard_reparent does not cascade');
}
{
  const block = extractFunctionBlock('organization_contacts_guard_reparent');
  assert.doesNotMatch(block, /UPDATE\s+public\.(devis|clients)/is, 'contact reparent does not cascade');
}
{
  const block = extractFunctionBlock('crm_opportunities_guard_reparent');
  assert.doesNotMatch(block, /UPDATE\s+public\.devis/is, 'opportunity reparent does not cascade');
}
console.log('  ✓ no automatic cascade in parent guards');

// =========================================================
// NO DUPLICATE set_updated_at
// =========================================================
assert.doesNotMatch(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.set_updated_at\(\)/i, 'does not redefine public.set_updated_at()');
console.log('  ✓ does not redefine public.set_updated_at()');

console.log('\n========================================');
console.log('P3B5 static migration validation: ALL PASS');
console.log('========================================');
