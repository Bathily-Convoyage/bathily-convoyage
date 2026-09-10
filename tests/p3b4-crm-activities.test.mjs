// =========================================================
// P3B4 — CRM Activities Static Migration Validation
// =========================================================
// Validates the migration SQL without a running database.
// Run: node tests/p3b4-crm-activities.test.mjs
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
  '20260910100000_p3b4_crm_activities.sql',
);

assert.ok(fs.existsSync(migrationPath), `migration file exists: ${migrationPath}`);
const sql = fs.readFileSync(migrationPath, 'utf8');

console.log('=== P3B4 Static Migration Validation ===\n');

// =========================================================
// TABLE EXISTS
// =========================================================
assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.crm_activities/i, 'crm_activities table created');
console.log('  ✓ crm_activities table created');

// =========================================================
// COLUMNS
// =========================================================
const columnChecks = [
  ['id uuid PK', /id\s+uuid\s+DEFAULT\s+gen_random_uuid\(\)\s+NOT\s+NULL/i],
  ['created_at timestamptz', /created_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i],
  ['updated_at timestamptz', /updated_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i],
  ['organization_id uuid nullable', /organization_id\s+uuid\s+REFERENCES\s+public\.organizations\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i],
  ['contact_id uuid nullable', /contact_id\s+uuid\s+REFERENCES\s+public\.organization_contacts\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i],
  ['opportunity_id uuid nullable', /opportunity_id\s+uuid\s+REFERENCES\s+public\.crm_opportunities\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i],
  ['activity_type text NOT NULL', /activity_type\s+text\s+NOT\s+NULL/i],
  ['direction text nullable', /direction\s+text/i],
  ['subject text NOT NULL', /subject\s+text\s+NOT\s+NULL/i],
  ['body text nullable', /body\s+text/i],
  ['status text NOT NULL default completed', /status\s+text\s+NOT\s+NULL\s+DEFAULT\s+'completed'/i],
  ['occurred_at timestamptz nullable', /occurred_at\s+timestamptz/i],
  ['due_at timestamptz nullable', /due_at\s+timestamptz/i],
  ['completed_at timestamptz nullable', /completed_at\s+timestamptz/i],
  ['assigned_to uuid references auth.users', /assigned_to\s+uuid\s+REFERENCES\s+auth\.users\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i],
  ['created_by uuid NOT NULL references auth.users', /created_by\s+uuid\s+NOT\s+NULL\s+REFERENCES\s+auth\.users\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i],
  ['metadata jsonb default empty', /metadata\s+jsonb\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'::jsonb/i],
];

for (const [name, pattern] of columnChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// CHECK CONSTRAINTS
// =========================================================
assert.match(sql, /activity_type\s+IN\s*\(\s*'call'[\s\S]*?'other'/i, 'activity_type CHECK constraint');
console.log('  ✓ activity_type CHECK constraint');

assert.match(sql, /direction\s+IS\s+NULL\s+OR\s+direction\s+IN\s*\(\s*'inbound'[\s\S]*?'internal'\)/i, 'direction CHECK constraint');
console.log('  ✓ direction CHECK constraint');

assert.match(sql, /status\s+IN\s*\(\s*'pending'[\s\S]*?'cancelled'\)/i, 'status CHECK constraint');
console.log('  ✓ status CHECK constraint');

assert.match(sql, /btrim\s*\(\s*subject\s*\)\s*<>\s*''/, 'subject non-empty CHECK');
console.log('  ✓ subject non-empty CHECK');

// =========================================================
// INDEXES
// =========================================================
const indexChecks = [
  ['index organization_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_organization_id/i],
  ['index contact_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_contact_id/i],
  ['index opportunity_id', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_opportunity_id/i],
  ['index activity_type', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_activity_type/i],
  ['index status', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_status/i],
  ['index due_at', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_due_at/i],
  ['index occurred_at', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_occurred_at/i],
  ['index created_at', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_created_at/i],
  ['index assigned_to', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_assigned_to/i],
  ['partial index pending_due_at', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+crm_activities_pending_due_at[\s\S]*WHERE\s+status\s+IN\s*\(\s*'pending'[\s\S]*'in_progress'\)/i],
];

for (const [name, pattern] of indexChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// TRIGGERS: updated_at, cross-entity, created_by
// =========================================================
assert.match(sql, /EXECUTE\s+FUNCTION\s+public\.set_updated_at\(\)/i, 'reuses public.set_updated_at()');
console.log('  ✓ reuses public.set_updated_at()');

assert.match(sql, /CREATE\s+TRIGGER\s+crm_activities_set_updated_at/i, 'updated_at trigger exists');
console.log('  ✓ updated_at trigger exists');

assert.match(sql, /CREATE\s+TRIGGER\s+crm_activities_check_cross_entity/i, 'cross-entity trigger exists');
console.log('  ✓ cross-entity trigger exists');

assert.match(sql, /CREATE\s+TRIGGER\s+crm_activities_set_created_by/i, 'created_by trigger exists');
console.log('  ✓ created_by trigger exists');

// =========================================================
// CROSS-ENTITY INTEGRITY FUNCTION
// =========================================================
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_activities_check_cross_entity\(\)/i, 'cross-entity function exists');
console.log('  ✓ cross-entity function exists');

assert.match(sql, /SECURITY\s+DEFINER[\s\S]*?crm_activities_check_cross_entity/is, 'cross-entity is SECURITY DEFINER');
console.log('  ✓ cross-entity is SECURITY DEFINER');

assert.match(sql, /crm_activities_check_cross_entity[\s\S]*?SET\s+search_path\s*=\s*''/is, 'cross-entity has SET search_path = \'\'');
console.log("  ✓ cross-entity has SET search_path = ''");

// Contact/org integrity
assert.match(sql, /NEW\.contact_id\s+IS\s+NOT\s+NULL/i, 'cross-entity checks contact_id');
console.log('  ✓ cross-entity checks contact_id');

assert.match(sql, /organization_contacts[\s\S]*?WHERE\s+id\s*=\s*NEW\.contact_id/is, 'cross-entity queries organization_contacts');
console.log('  ✓ cross-entity queries organization_contacts');

assert.match(sql, /v_contact_org_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.organization_id/i, 'cross-entity checks contact org match');
console.log('  ✓ cross-entity checks contact org match');

// Opportunity/org integrity
assert.match(sql, /NEW\.opportunity_id\s+IS\s+NOT\s+NULL/i, 'cross-entity checks opportunity_id');
console.log('  ✓ cross-entity checks opportunity_id');

assert.match(sql, /crm_opportunities[\s\S]*?WHERE\s+id\s*=\s*NEW\.opportunity_id/is, 'cross-entity queries crm_opportunities');
console.log('  ✓ cross-entity queries crm_opportunities');

assert.match(sql, /v_opp_org_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.organization_id/i, 'cross-entity checks opportunity org match');
console.log('  ✓ cross-entity checks opportunity org match');

// P3B4A: assigned_to validation
assert.match(sql, /NEW\.assigned_to\s+IS\s+NOT\s+NULL/i, 'cross-entity checks assigned_to');
console.log('  ✓ cross-entity checks assigned_to');

assert.match(sql, /user_roles[\s\S]*?WHERE\s+ur\.user_id\s*=\s*NEW\.assigned_to\s+AND\s+ur\.role\s*=\s*'admin'/is, 'cross-entity validates admin assignee (user_roles)');
console.log('  ✓ cross-entity validates admin assignee (user_roles)');

// P3B4B: legacy admin path (clients.role='admin') must be recognized
assert.match(sql, /clients\s+c[\s\S]*?c\.role\s*=\s*'admin'[\s\S]*?c\.auth_user_id\s*=\s*NEW\.assigned_to/is, 'cross-entity validates legacy admin assignee (clients.role)');
console.log('  ✓ cross-entity validates legacy admin assignee (clients.role)');

assert.match(sql, /internal_operators\s+io\s+ON\s+io\.user_id\s*=\s*ur\.user_id[\s\S]*?io\.active\s*=\s*true/is, 'cross-entity validates active operator assignee');
console.log('  ✓ cross-entity validates active operator assignee');

assert.match(sql, /L''assigné doit être un utilisateur interne actif/i, 'cross-entity rejects non-internal assignee');
console.log('  ✓ cross-entity rejects non-internal assignee');

// =========================================================
// CREATED_BY FUNCTION
// =========================================================
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_activities_set_created_by\(\)/i, 'created_by function exists');
console.log('  ✓ created_by function exists');

assert.match(sql, /SECURITY\s+DEFINER[\s\S]*?crm_activities_set_created_by/is, 'created_by is SECURITY DEFINER');
console.log('  ✓ created_by is SECURITY DEFINER');

assert.match(sql, /crm_activities_set_created_by[\s\S]*?SET\s+search_path\s*=\s*''/is, 'created_by has SET search_path = \'\'');
console.log("  ✓ created_by has SET search_path = ''");

assert.match(sql, /NEW\.created_by\s*:=\s*auth\.uid\(\)/i, 'created_by assigns auth.uid()');
console.log('  ✓ created_by assigns auth.uid()');

// =========================================================
// RLS
// =========================================================
assert.match(sql, /ALTER\s+TABLE\s+public\.crm_activities\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i, 'RLS enabled');
console.log('  ✓ RLS enabled');

assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.crm_activities\s+FROM\s+PUBLIC/i, 'REVOKE from PUBLIC');
console.log('  ✓ REVOKE from PUBLIC');

assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.crm_activities\s+FROM\s+anon/i, 'REVOKE from anon');
console.log('  ✓ REVOKE from anon');

assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.crm_activities\s+FROM\s+authenticated/i, 'REVOKE from authenticated');
console.log('  ✓ REVOKE from authenticated');

assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.crm_activities\s+FROM\s+service_role/i, 'REVOKE from service_role');
console.log('  ✓ REVOKE from service_role');

// =========================================================
// GRANTS — authenticated (column-level)
// =========================================================
// No table-wide INSERT or UPDATE.
assert.doesNotMatch(
  sql,
  /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.crm_activities\s+TO\s+authenticated/i,
  'no table-wide CRUD grant to authenticated',
);
console.log('  ✓ no table-wide CRUD grant to authenticated');

// SELECT, DELETE granted.
assert.match(sql, /GRANT\s+SELECT,\s*DELETE\s+ON\s+public\.crm_activities\s+TO\s+authenticated/i, 'SELECT, DELETE to authenticated');
console.log('  ✓ SELECT, DELETE to authenticated');

// Column-level INSERT.
const insertBlock = sql.match(/GRANT\s+INSERT\s*\(([^)]*)\)\s+ON\s+public\.crm_activities\s+TO\s+authenticated/is);
assert.ok(insertBlock, 'column-level INSERT grant block found');
assert.doesNotMatch(insertBlock[1], /\bid\b/i, 'id NOT in INSERT grant');
assert.doesNotMatch(insertBlock[1], /\bcreated_by\b/i, 'created_by NOT in INSERT grant');
assert.doesNotMatch(insertBlock[1], /\bcreated_at\b/i, 'created_at NOT in INSERT grant');
assert.doesNotMatch(insertBlock[1], /\bupdated_at\b/i, 'updated_at NOT in INSERT grant');
assert.match(insertBlock[1], /organization_id/i, 'organization_id in INSERT grant');
assert.match(insertBlock[1], /activity_type/i, 'activity_type in INSERT grant');
assert.match(insertBlock[1], /subject/i, 'subject in INSERT grant');
assert.match(insertBlock[1], /assigned_to/i, 'assigned_to in INSERT grant');
console.log('  ✓ column-level INSERT excludes protected columns');

// Column-level UPDATE.
const updateBlock = sql.match(/GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+public\.crm_activities\s+TO\s+authenticated/is);
assert.ok(updateBlock, 'column-level UPDATE grant block found');
assert.doesNotMatch(updateBlock[1], /\bid\b/i, 'id NOT in UPDATE grant');
assert.doesNotMatch(updateBlock[1], /\bcreated_by\b/i, 'created_by NOT in UPDATE grant');
assert.doesNotMatch(updateBlock[1], /\bcreated_at\b/i, 'created_at NOT in UPDATE grant');
assert.doesNotMatch(updateBlock[1], /\bupdated_at\b/i, 'updated_at NOT in UPDATE grant');
console.log('  ✓ column-level UPDATE excludes protected columns');

// =========================================================
// GRANTS — service_role (SELECT only, P3B4A least privilege)
// =========================================================
assert.match(sql, /GRANT\s+SELECT\s+ON\s+public\.crm_activities\s+TO\s+service_role/i, 'service_role SELECT');
console.log('  ✓ service_role SELECT');

assert.doesNotMatch(sql, /GRANT\s+ALL\s+ON\s+public\.crm_activities\s+TO\s+service_role/i, 'no GRANT ALL to service_role');
console.log('  ✓ no GRANT ALL to service_role');

// P3B4A: service_role INSERT/UPDATE removed (no existing write path,
// INSERT always failed due to created_by=auth.uid()=NULL)
assert.doesNotMatch(sql, /GRANT\s+INSERT\s*\([^)]*\)\s+ON\s+public\.crm_activities\s+TO\s+service_role/is, 'no service_role INSERT grant');
console.log('  ✓ no service_role INSERT grant (P3B4A least privilege)');

assert.doesNotMatch(sql, /GRANT\s+UPDATE\s*\([^)]*\)\s+ON\s+public\.crm_activities\s+TO\s+service_role/is, 'no service_role UPDATE grant');
console.log('  ✓ no service_role UPDATE grant (P3B4A least privilege)');

// =========================================================
// RLS POLICIES
// =========================================================
assert.match(sql, /crm_activities_select_internal[\s\S]*FOR\s+SELECT[\s\S]*is_internal_user\(\)/is, 'SELECT policy internal');
console.log('  ✓ SELECT policy internal');

assert.match(sql, /crm_activities_insert_internal[\s\S]*FOR\s+INSERT[\s\S]*is_internal_user\(\)/is, 'INSERT policy internal');
console.log('  ✓ INSERT policy internal');

assert.match(sql, /crm_activities_update_internal[\s\S]*FOR\s+UPDATE[\s\S]*is_internal_user\(\)/is, 'UPDATE policy internal');
console.log('  ✓ UPDATE policy internal');

assert.match(sql, /crm_activities_delete_admin[\s\S]*FOR\s+DELETE[\s\S]*is_admin\(\)/is, 'DELETE policy admin-only');
console.log('  ✓ DELETE policy admin-only');

// =========================================================
// SECURITY DEFINER INVENTORY + SEARCH_PATH
// =========================================================
// P3B4B: 4 SECURITY DEFINER functions (2 original + 2 parent guards)
const sqlNoComments = sql.replace(/^\s*--[^\n]*$/gm, '');
const sdCount = (sqlNoComments.match(/^SECURITY\s+DEFINER/gim) || []).length;
assert.equal(sdCount, 4, `exactly 4 SECURITY DEFINER functions, found ${sdCount}`);
console.log(`  ✓ exactly 4 SECURITY DEFINER functions (count=${sdCount})`);

const sdFunctions = [
  'crm_activities_check_cross_entity',
  'crm_activities_set_created_by',
  'organization_contacts_guard_reparent',
  'crm_opportunities_guard_reparent',
];
for (const fn of sdFunctions) {
  const block = sql.match(
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\(\\)[\\s\\S]*?\\$\\$;`, 'i'),
  );
  assert.ok(block, `function block found for ${fn}`);
  assert.match(block[0], /SECURITY\s+DEFINER/i, `${fn} is SECURITY DEFINER`);
  assert.match(block[0], /SET\s+search_path\s*=\s*''/i, `${fn} has SET search_path = ''`);
  console.log(`  ✓ ${fn}: SECURITY DEFINER + SET search_path = ''`);
}

// =========================================================
// TRIGGER FUNCTION EXECUTE REVOCATIONS
// =========================================================
assert.match(
  sql,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_activities_check_cross_entity\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
  'cross_entity EXECUTE revoked from PUBLIC, anon, authenticated',
);
console.log('  ✓ cross_entity EXECUTE revoked from PUBLIC, anon, authenticated');

assert.match(
  sql,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_activities_set_created_by\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
  'set_created_by EXECUTE revoked from PUBLIC, anon, authenticated',
);
console.log('  ✓ set_created_by EXECUTE revoked from PUBLIC, anon, authenticated');

// =========================================================
// PARENT GUARDS (P3B4B)
// =========================================================
// Contact parent guard
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.organization_contacts_guard_reparent\(\)/i, 'contact parent guard function exists');
console.log('  ✓ contact parent guard function exists');

assert.match(sql, /organization_contacts_guard_reparent[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/is, 'contact guard is SECURITY DEFINER + fixed search_path');
console.log("  ✓ contact guard is SECURITY DEFINER + SET search_path = ''");

assert.match(sql, /organization_contacts_guard_reparent[\s\S]*?crm_opportunities\s+o[\s\S]*?o\.contact_id\s*=\s*NEW\.id[\s\S]*?o\.organization_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.organization_id/is, 'contact guard checks dependent opportunities');
console.log('  ✓ contact guard checks dependent opportunities');

assert.match(sql, /organization_contacts_guard_reparent[\s\S]*?crm_activities\s+a[\s\S]*?a\.contact_id\s*=\s*NEW\.id[\s\S]*?a\.organization_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.organization_id/is, 'contact guard checks dependent activities');
console.log('  ✓ contact guard checks dependent activities');

assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.organization_contacts_guard_reparent\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i, 'contact guard EXECUTE revoked');
console.log('  ✓ contact guard EXECUTE revoked from PUBLIC, anon, authenticated');

assert.match(sql, /CREATE\s+TRIGGER\s+organization_contacts_guard_reparent\s+BEFORE\s+UPDATE\s+OF\s+organization_id\s+ON\s+public\.organization_contacts/i, 'contact guard trigger on UPDATE OF organization_id');
console.log('  ✓ contact guard trigger on UPDATE OF organization_id');

// Opportunity parent guard
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_opportunities_guard_reparent\(\)/i, 'opportunity parent guard function exists');
console.log('  ✓ opportunity parent guard function exists');

assert.match(sql, /crm_opportunities_guard_reparent[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/is, 'opportunity guard is SECURITY DEFINER + fixed search_path');
console.log("  ✓ opportunity guard is SECURITY DEFINER + SET search_path = ''");

assert.match(sql, /crm_opportunities_guard_reparent[\s\S]*?NEW\.organization_id\s+IS\s+NULL[\s\S]*?RETURN\s+NEW/is, 'opportunity guard allows NULL org (no constraint)');
console.log('  ✓ opportunity guard allows NULL org transition');

assert.match(sql, /crm_opportunities_guard_reparent[\s\S]*?crm_activities\s+a[\s\S]*?a\.opportunity_id\s*=\s*NEW\.id[\s\S]*?a\.organization_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.organization_id/is, 'opportunity guard checks dependent activities');
console.log('  ✓ opportunity guard checks dependent activities');

assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_opportunities_guard_reparent\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i, 'opportunity guard EXECUTE revoked');
console.log('  ✓ opportunity guard EXECUTE revoked from PUBLIC, anon, authenticated');

assert.match(sql, /CREATE\s+TRIGGER\s+crm_opportunities_guard_reparent\s+BEFORE\s+UPDATE\s+OF\s+organization_id\s+ON\s+public\.crm_opportunities/i, 'opportunity guard trigger on UPDATE OF organization_id');
console.log('  ✓ opportunity guard trigger on UPDATE OF organization_id');

// No automatic cascade — guards must not UPDATE child records
assert.doesNotMatch(sql, /organization_contacts_guard_reparent[\s\S]*?UPDATE\s+public\.crm_opportunities/is, 'contact guard does not cascade-update opportunities');
assert.doesNotMatch(sql, /organization_contacts_guard_reparent[\s\S]*?UPDATE\s+public\.crm_activities/is, 'contact guard does not cascade-update activities');
assert.doesNotMatch(sql, /crm_opportunities_guard_reparent[\s\S]*?UPDATE\s+public\.crm_activities/is, 'opportunity guard does not cascade-update activities');
console.log('  ✓ no automatic cascade in parent guards');

// =========================================================
// NO MODIFICATION TO EXISTING TABLES (P3B4B exception: triggers)
// =========================================================
// P3B4B authorizes protective triggers on organization_contacts
// and crm_opportunities. No ALTER TABLE, no column changes, no FK
// changes, no RLS changes to existing tables.
const existingTableAlter = /ALTER\s+TABLE\s+public\.(clients|devis|missions|convoyeurs|billing_records|billing_events|support_tickets|system_settings|user_roles|internal_operators|organizations|organization_segments|organization_sites|organization_contacts|crm_opportunities|crm_pipeline_events)\b/i;
assert.doesNotMatch(sql, existingTableAlter, 'does not ALTER existing tables');
console.log('  ✓ does not ALTER existing tables (triggers only, P3B4B authorized)');

// =========================================================
// NO DUPLICATE set_updated_at
// =========================================================
assert.doesNotMatch(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.set_updated_at\(\)/i, 'does not redefine public.set_updated_at()');
console.log('  ✓ does not redefine public.set_updated_at()');

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
assert.doesNotMatch(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_activities_write/i, 'no generic activities write RPC');
console.log('  ✓ no generic elevated CRUD RPC');

console.log('\n========================================');
console.log('P3B4 static migration validation: ALL PASS');
console.log('========================================');
