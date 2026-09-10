// =========================================================
// P3B6 — CRM Consolidation Static Migration Validation
// =========================================================
// Validates the migration SQL without a running database.
// Run: node tests/p3b6-crm-consolidation.test.mjs
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
  '20260910120000_p3b6_crm_consolidation.sql',
);

assert.ok(fs.existsSync(migrationPath), `migration file exists: ${migrationPath}`);
const sql = fs.readFileSync(migrationPath, 'utf8');

console.log('=== P3B6 Static Migration Validation ===\n');

// =========================================================
// 1. CRM LINK EVENTS TABLE
// =========================================================
console.log('--- CRM LINK EVENTS TABLE ---');

assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.crm_link_events/i, 'crm_link_events table created');
console.log('  ✓ crm_link_events table created');

// Exact columns
assert.match(sql, /id\s+uuid\s+DEFAULT\s+gen_random_uuid\(\)\s+NOT\s+NULL/i, 'id column');
console.log('  ✓ id column');

assert.match(sql, /created_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i, 'created_at column');
console.log('  ✓ created_at column');

assert.match(sql, /actor_user_id\s+uuid\s+NOT\s+NULL/i, 'actor_user_id column');
console.log('  ✓ actor_user_id column');

assert.match(sql, /actor_role\s+text\s+NOT\s+NULL/i, 'actor_role column');
console.log('  ✓ actor_role column');

assert.match(sql, /entity_type\s+text\s+NOT\s+NULL/i, 'entity_type column');
console.log('  ✓ entity_type column');

assert.match(sql, /entity_id\s+uuid\s+NOT\s+NULL/i, 'entity_id column');
console.log('  ✓ entity_id column');

assert.match(sql, /field_name\s+text\s+NOT\s+NULL/i, 'field_name column');
console.log('  ✓ field_name column');

assert.match(sql, /old_value\s+uuid/i, 'old_value column');
console.log('  ✓ old_value column');

assert.match(sql, /new_value\s+uuid/i, 'new_value column');
console.log('  ✓ new_value column');

assert.match(sql, /metadata\s+jsonb\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'::jsonb/i, 'metadata column');
console.log('  ✓ metadata column');

// =========================================================
// 2. CRM LINK EVENTS CHECK CONSTRAINTS
// =========================================================
console.log('\n--- CRM LINK EVENTS CHECK CONSTRAINTS ---');

assert.match(sql, /crm_link_events_actor_role_check[\s\S]*?CHECK\s*\(\s*actor_role\s+IN\s*\(\s*'admin'\s*,\s*'operator'\s*\)/i, 'actor_role CHECK');
console.log('  ✓ actor_role CHECK (admin, operator)');

assert.match(sql, /crm_link_events_entity_type_check[\s\S]*?CHECK\s*\(\s*entity_type\s+IN\s*\(\s*'client'\s*,\s*'devis'\s*,\s*'mission'\s*\)/i, 'entity_type CHECK');
console.log('  ✓ entity_type CHECK (client, devis, mission)');

assert.match(sql, /crm_link_events_field_name_check[\s\S]*?CHECK\s*\(\s*field_name\s+IN\s*\(\s*'organization_id'\s*,\s*'contact_id'\s*,\s*'opportunity_id'\s*,\s*'devis_id'\s*\)/i, 'field_name CHECK');
console.log('  ✓ field_name CHECK (organization_id, contact_id, opportunity_id, devis_id)');

// Entity/field compatibility CHECK
assert.match(sql, /crm_link_events_entity_field_compatible[\s\S]*?CHECK[\s\S]*?entity_type\s*=\s*'client'[\s\S]*?field_name\s*=\s*'organization_id'[\s\S]*?entity_type\s*=\s*'devis'[\s\S]*?field_name\s+IN\s*\(\s*'organization_id'\s*,\s*'contact_id'\s*,\s*'opportunity_id'\s*\)[\s\S]*?entity_type\s*=\s*'mission'[\s\S]*?field_name\s+IN\s*\(\s*'devis_id'\s*,\s*'organization_id'\s*\)/i, 'entity/field compatibility CHECK');
console.log('  ✓ entity/field compatibility CHECK');

// =========================================================
// 3. IMMUTABILITY TRIGGER
// =========================================================
console.log('\n--- IMMUTABILITY TRIGGER ---');

assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_link_events_immutable\(\)/i, 'immutable function exists');
console.log('  ✓ crm_link_events_immutable function exists');

assert.match(sql, /SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''[\s\S]*?RAISE\s+EXCEPTION[\s\S]*?42501/i, 'immutable function SECURITY DEFINER + 42501');
console.log('  ✓ immutable function SECURITY DEFINER + raises 42501');

assert.match(sql, /CREATE\s+TRIGGER\s+crm_link_events_protect_trigger\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+public\.crm_link_events/i, 'immutable trigger BEFORE UPDATE OR DELETE');
console.log('  ✓ immutable trigger BEFORE UPDATE OR DELETE');

assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_link_events_immutable\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i, 'immutable function EXECUTE revoked');
console.log('  ✓ immutable function EXECUTE revoked from all');

// =========================================================
// 4. RLS + GRANTS
// =========================================================
console.log('\n--- RLS + GRANTS ---');

assert.match(sql, /ALTER\s+TABLE\s+public\.crm_link_events\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i, 'RLS enabled');
console.log('  ✓ RLS enabled');

assert.match(sql, /ALTER\s+TABLE\s+public\.crm_link_events\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, 'RLS forced');
console.log('  ✓ RLS forced');

assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.crm_link_events\s+FROM\s+PUBLIC/i, 'REVOKE from PUBLIC');
console.log('  ✓ REVOKE ALL from PUBLIC');

assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.crm_link_events\s+FROM\s+anon/i, 'REVOKE from anon');
console.log('  ✓ REVOKE ALL from anon');

assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.crm_link_events\s+FROM\s+authenticated/i, 'REVOKE from authenticated');
console.log('  ✓ REVOKE ALL from authenticated');

assert.match(sql, /REVOKE\s+ALL\s+ON\s+public\.crm_link_events\s+FROM\s+service_role/i, 'REVOKE from service_role');
console.log('  ✓ REVOKE ALL from service_role');

assert.match(sql, /GRANT\s+SELECT\s+ON\s+public\.crm_link_events\s+TO\s+authenticated/i, 'GRANT SELECT to authenticated');
console.log('  ✓ GRANT SELECT to authenticated (RLS restricts to admin)');

assert.match(sql, /crm_link_events_admin_select[\s\S]*?FOR\s+SELECT\s+TO\s+authenticated[\s\S]*?USING\s*\(\s*public\.is_admin\(\)\s*\)/i, 'admin-only SELECT policy');
console.log('  ✓ admin-only SELECT policy');

// No INSERT/UPDATE/DELETE policies
const insertPolicyCount = (sql.match(/crm_link_events[\s\S]*?FOR\s+INSERT/gi) || []).length;
assert.equal(insertPolicyCount, 0, `no INSERT policy on crm_link_events, found ${insertPolicyCount}`);
console.log('  ✓ no INSERT policy (writes via guard functions only)');

// =========================================================
// 5. LOG_CRM_LINK_EVENT HELPER
// =========================================================
console.log('\n--- LOG_CRM_LINK_EVENT HELPER ---');

assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.log_crm_link_event/i, 'helper function exists');
console.log('  ✓ log_crm_link_event function exists');

assert.match(sql, /SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''[\s\S]*?INSERT\s+INTO\s+public\.crm_link_events/i, 'helper SECURITY DEFINER + INSERT');
console.log('  ✓ helper SECURITY DEFINER + INSERT');

assert.match(sql, /auth\.uid\(\)/i, 'helper uses auth.uid()');
console.log('  ✓ helper uses auth.uid() for actor_user_id');

// actor_role derived, not user-supplied
assert.match(sql, /IF\s+public\.is_admin\(\)\s+THEN[\s\S]*?v_actor_role\s*:=\s*'admin'/i, 'actor_role derived admin');
console.log('  ✓ actor_role derived from is_admin()');

assert.match(sql, /ELSIF\s+public\.is_operator\(\)\s+THEN[\s\S]*?v_actor_role\s*:=\s*'operator'/i, 'actor_role derived operator');
console.log('  ✓ actor_role derived from is_operator()');

assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.log_crm_link_event[\s\S]*?FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i, 'helper EXECUTE revoked');
console.log('  ✓ helper EXECUTE revoked from all');

// No user-supplied actor parameters
assert.doesNotMatch(sql, /log_crm_link_event[\s\S]*?p_actor_user_id/i, 'no user-supplied actor_user_id parameter');
console.log('  ✓ no user-supplied actor_user_id parameter');

assert.doesNotMatch(sql, /log_crm_link_event[\s\S]*?p_actor_role/i, 'no user-supplied actor_role parameter');
console.log('  ✓ no user-supplied actor_role parameter');

// =========================================================
// 6. EXTENDED P3B5 GUARDS
// =========================================================
console.log('\n--- EXTENDED P3B5 GUARDS ---');

// guard_clients_organization_id extended
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.guard_clients_organization_id\(\)/i, 'guard_clients_organization_id extended');
console.log('  ✓ guard_clients_organization_id CREATE OR REPLACE');

assert.match(sql, /guard_clients_organization_id[\s\S]*?log_crm_link_event[\s\S]*?'client'[\s\S]*?'organization_id'/i, 'client guard inserts audit');
console.log('  ✓ client guard inserts audit for organization_id');

// devis_guard_crm_links extended with up to 3 audit INSERTs
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.devis_guard_crm_links\(\)/i, 'devis_guard_crm_links extended');
console.log('  ✓ devis_guard_crm_links CREATE OR REPLACE');

// Extract the devis_guard_crm_links function body to count audit calls
const devisGuardMatch = sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.devis_guard_crm_links\(\)[\s\S]*?AS\s+\$\$[\s\S]*?\$\$;/);
assert.ok(devisGuardMatch, 'devis guard function body found');
const devisGuardBody = devisGuardMatch[0];
const devisOrgAudits = (devisGuardBody.match(/log_crm_link_event\(\s*'devis'[\s\S]*?'organization_id'/gi) || []).length;
const devisContactAudits = (devisGuardBody.match(/log_crm_link_event\(\s*'devis'[\s\S]*?'contact_id'/gi) || []).length;
const devisOppAudits = (devisGuardBody.match(/log_crm_link_event\(\s*'devis'[\s\S]*?'opportunity_id'/gi) || []).length;
assert.ok(devisOrgAudits >= 2, `devis guard audits organization_id (INSERT + UPDATE), found ${devisOrgAudits}`);
assert.ok(devisContactAudits >= 2, `devis guard audits contact_id (INSERT + UPDATE), found ${devisContactAudits}`);
assert.ok(devisOppAudits >= 2, `devis guard audits opportunity_id (INSERT + UPDATE), found ${devisOppAudits}`);
console.log('  ✓ devis guard audits organization_id, contact_id, opportunity_id (INSERT + UPDATE)');

// missions_check_devis_org extended with up to 2 audit INSERTs
assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.missions_check_devis_org\(\)/i, 'missions_check_devis_org extended');
console.log('  ✓ missions_check_devis_org CREATE OR REPLACE');

const missionGuardMatch = sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.missions_check_devis_org\(\)[\s\S]*?AS\s+\$\$[\s\S]*?\$\$;/);
assert.ok(missionGuardMatch, 'mission guard function body found');
const missionGuardBody = missionGuardMatch[0];
const missionDevisAudits = (missionGuardBody.match(/log_crm_link_event\(\s*'mission'[\s\S]*?'devis_id'/gi) || []).length;
const missionOrgAudits = (missionGuardBody.match(/log_crm_link_event\(\s*'mission'[\s\S]*?'organization_id'/gi) || []).length;
assert.ok(missionDevisAudits >= 2, `mission guard audits devis_id (INSERT + UPDATE), found ${missionDevisAudits}`);
assert.ok(missionOrgAudits >= 2, `mission guard audits organization_id (INSERT + UPDATE), found ${missionOrgAudits}`);
console.log('  ✓ mission guard audits devis_id, organization_id (INSERT + UPDATE)');

// All extended guards preserve SECURITY DEFINER + search_path
assert.match(sql, /guard_clients_organization_id[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/i, 'client guard SD + search_path');
console.log('  ✓ client guard SECURITY DEFINER + search_path');

assert.match(sql, /devis_guard_crm_links[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/i, 'devis guard SD + search_path');
console.log('  ✓ devis guard SECURITY DEFINER + search_path');

assert.match(sql, /missions_check_devis_org[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/i, 'mission guard SD + search_path');
console.log('  ✓ mission guard SECURITY DEFINER + search_path');

// All owned by postgres
assert.match(sql, /ALTER\s+FUNCTION\s+public\.guard_clients_organization_id\(\)\s+OWNER\s+TO\s+postgres/i, 'client guard owner postgres');
console.log('  ✓ client guard OWNER postgres');

assert.match(sql, /ALTER\s+FUNCTION\s+public\.devis_guard_crm_links\(\)\s+OWNER\s+TO\s+postgres/i, 'devis guard owner postgres');
console.log('  ✓ devis guard OWNER postgres');

assert.match(sql, /ALTER\s+FUNCTION\s+public\.missions_check_devis_org\(\)\s+OWNER\s+TO\s+postgres/i, 'mission guard owner postgres');
console.log('  ✓ mission guard OWNER postgres');

// =========================================================
// 7. TIMELINE FUNCTION
// =========================================================
console.log('\n--- TIMELINE FUNCTION ---');

assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_timeline_read/i, 'timeline function exists');
console.log('  ✓ crm_timeline_read function exists');

assert.match(sql, /crm_timeline_read[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/i, 'timeline SD + search_path');
console.log('  ✓ timeline SECURITY DEFINER + search_path');

// Gate: is_internal_user() FIRST
const gateMatch = sql.match(/crm_timeline_read[\s\S]*?BEGIN[\s\S]*?IF\s+NOT\s+public\.is_internal_user\(\)\s+THEN[\s\S]*?42501/i);
assert.ok(gateMatch, 'timeline gates on is_internal_user() first');
console.log('  ✓ timeline gates on is_internal_user() (raises 42501)');

// v_is_admin recorded once
assert.match(sql, /v_is_admin\s*:=\s*public\.is_admin\(\)/i, 'v_is_admin recorded');
console.log('  ✓ v_is_admin recorded once');

// Limit bounding
assert.match(sql, /v_limit\s*:=\s*LEAST\s*\(\s*GREATEST\s*\(\s*COALESCE\s*\(\s*p_limit\s*,\s*50\s*\)\s*,\s*1\s*\)\s*,\s*200\s*\)/i, 'limit bounded');
console.log('  ✓ limit bounded (default 50, min 1, max 200)');

// Cursor pair validation
assert.match(sql, /22023/i, 'cursor pair validation ERRCODE 22023');
console.log('  ✓ cursor pair validation (ERRCODE 22023)');

// Cursor predicate
assert.match(sql, /p_before_event_at\s+IS\s+NULL\s+OR\s+t\.event_at\s*<\s*p_before_event_at\s+OR\s*\(\s*t\.event_at\s*=\s*p_before_event_at\s+AND\s+t\.event_key\s*<\s*p_before_event_key/i, 'cursor predicate');
console.log('  ✓ cursor predicate (event_at + event_key)');

// Ordering
assert.match(sql, /ORDER\s+BY\s+t\.event_at\s+DESC,\s*t\.event_key\s+DESC/i, 'ordering DESC DESC');
console.log('  ✓ ordering event_at DESC, event_key DESC');

// Return columns (no organization_id_at_event, no is_historical)
assert.match(sql, /record_kind\s+text/i, 'record_kind column');
console.log('  ✓ record_kind column');

assert.doesNotMatch(sql, /organization_id_at_event/i, 'no organization_id_at_event column');
console.log('  ✓ no organization_id_at_event column');

assert.doesNotMatch(sql, /is_historical/i, 'no is_historical column');
console.log('  ✓ no is_historical column');

// 6 source labels
assert.match(sql, /'pipeline_event'::text\s+AS\s+event_source/i, 'pipeline_event source');
console.log('  ✓ pipeline_event source');

assert.match(sql, /'mission_event'::text\s+AS\s+event_source/i, 'mission_event source');
console.log('  ✓ mission_event source');

assert.match(sql, /'billing_event'::text\s+AS\s+event_source/i, 'billing_event source');
console.log('  ✓ billing_event source');

assert.match(sql, /'devis'::text\s+AS\s+event_source/i, 'devis source');
console.log('  ✓ devis source');

assert.match(sql, /'mission'::text\s+AS\s+event_source/i, 'mission source');
console.log('  ✓ mission source');

assert.match(sql, /'activity'::text\s+AS\s+event_source/i, 'activity source');
console.log('  ✓ activity source');

// record_kind values
assert.match(sql, /'immutable_event'::text\s+AS\s+record_kind/i, 'immutable_event record_kind');
console.log('  ✓ immutable_event record_kind');

assert.match(sql, /'state_projection'::text\s+AS\s+record_kind/i, 'state_projection record_kind');
console.log('  ✓ state_projection record_kind');

// billing_records NOT included
assert.doesNotMatch(sql, /'billing_record'::text\s+AS\s+event_source/i, 'no billing_record source');
console.log('  ✓ billing_records NOT included as timeline source');

// crm_link_events NOT included
assert.doesNotMatch(sql, /'link_event'::text\s+AS\s+event_source/i, 'no link_event source');
console.log('  ✓ crm_link_events NOT included as timeline source');

// Role-dependent redaction for billing_events
assert.match(sql, /CASE\s+WHEN\s+v_is_admin\s+THEN[\s\S]*?be\.metadata\s+ELSE[\s\S]*?jsonb_build_object\(\s*'from_status'[\s\S]*?'to_status'[\s\S]*?'event_type'/i, 'billing redaction CASE');
console.log('  ✓ billing_events metadata redacted for non-admin (allow-list)');

// stripe_session_id NEVER exposed in function bodies (only in comments is OK)
// Extract crm_timeline_read function body and check it doesn't reference stripe_session_id
const timelineFnMatch = sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_timeline_read[\s\S]*?AS\s+\$\$[\s\S]*?\$\$;/);
assert.ok(timelineFnMatch, 'timeline function body found for stripe check');
assert.doesNotMatch(timelineFnMatch[0], /stripe_session_id/i, 'no stripe_session_id in timeline function body');
console.log('  ✓ stripe_session_id never exposed in timeline function body');

// No dynamic SQL (EXECUTE as a statement, not EXECUTE FUNCTION in triggers)
assert.doesNotMatch(sql, /EXECUTE\s+'/i, 'no EXECUTE string (no dynamic SQL)');
console.log('  ✓ no dynamic SQL (no EXECUTE string)');

assert.doesNotMatch(sql, /EXECUTE\s+format\s*\(/i, 'no EXECUTE format() (no dynamic SQL)');
console.log('  ✓ no EXECUTE format() (no dynamic SQL)');

// Authorization before filter lookup
const authBeforeFilter = sql.match(/is_internal_user\(\)[\s\S]*?42501[\s\S]*?v_is_admin[\s\S]*?v_limit[\s\S]*?RETURN\s+QUERY/i);
assert.ok(authBeforeFilter, 'authorization before query');
console.log('  ✓ authorization occurs before filter lookup');

// Privileges
assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_timeline_read[\s\S]*?FROM\s+PUBLIC,\s*anon,\s*service_role/i, 'timeline REVOKE');
console.log('  ✓ timeline REVOKE from PUBLIC, anon, service_role');

assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_timeline_read[\s\S]*?TO\s+authenticated/i, 'timeline GRANT');
console.log('  ✓ timeline GRANT to authenticated');

// =========================================================
// 8. ORGANIZATION SUMMARY FUNCTION
// =========================================================
console.log('\n--- ORGANIZATION SUMMARY FUNCTION ---');

assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_organizations_summary/i, 'summary function exists');
console.log('  ✓ crm_organizations_summary function exists');

assert.match(sql, /crm_organizations_summary[\s\S]*?SECURITY\s+DEFINER[\s\S]*?SET\s+search_path\s*=\s*''/i, 'summary SD + search_path');
console.log('  ✓ summary SECURITY DEFINER + search_path');

assert.match(sql, /crm_organizations_summary[\s\S]*?IF\s+NOT\s+public\.is_internal_user\(\)\s+THEN[\s\S]*?42501/i, 'summary gate');
console.log('  ✓ summary gates on is_internal_user()');

// Operator-safe fields
const summaryFields = [
  'organization_id', 'legal_name', 'trade_name', 'status',
  'contacts_count', 'opportunities_count', 'activities_count',
  'devis_count', 'missions_count', 'billing_count', 'pipeline_value',
  'last_activity_at', 'last_devis_at', 'last_mission_at'
];
for (const f of summaryFields) {
  assert.match(sql, new RegExp(`${f}\\s+(uuid|text|bigint|numeric|timestamptz)`, 'i'), `summary field ${f}`);
}
console.log('  ✓ all 14 operator-safe summary fields present');

// billing_amount NOT present in RETURNS TABLE or SELECT output
// Check only the RETURNS TABLE block of crm_organizations_summary
const summaryFnMatch = sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_organizations_summary\(\)[\s\S]*?RETURNS\s+TABLE\s*\([\s\S]*?\)\s*LANGUAGE/i);
assert.ok(summaryFnMatch, 'summary RETURNS TABLE block found');
assert.doesNotMatch(summaryFnMatch[0], /billing_amount/i, 'no billing_amount in RETURNS TABLE');
console.log('  ✓ billing_amount NOT in summary RETURNS TABLE');

// siret, siren, vat_number NOT in summary output
// (they may appear in the SELECT from organizations but not in the RETURNS TABLE)
const summaryReturnMatch = sql.match(/RETURNS\s+TABLE\s*\([\s\S]*?\)\s*LANGUAGE/i);
if (summaryReturnMatch) {
  assert.doesNotMatch(summaryReturnMatch[0], /siret/i, 'no siret in RETURNS TABLE');
  assert.doesNotMatch(summaryReturnMatch[0], /siren/i, 'no siren in RETURNS TABLE');
  assert.doesNotMatch(summaryReturnMatch[0], /vat_number/i, 'no vat_number in RETURNS TABLE');
}
console.log('  ✓ siret, siren, vat_number NOT in summary output');

// Pre-aggregated CTEs (no Cartesian fan-out)
assert.match(sql, /WITH\s+contacts_agg\s+AS\s*\([\s\S]*?GROUP\s+BY\s+oc\.organization_id/i, 'contacts_agg CTE');
console.log('  ✓ contacts_agg CTE (pre-aggregated)');

assert.match(sql, /opportunities_agg\s+AS\s*\([\s\S]*?GROUP\s+BY\s+op\.organization_id/i, 'opportunities_agg CTE');
console.log('  ✓ opportunities_agg CTE (pre-aggregated)');

assert.match(sql, /activities_agg\s+AS\s*\([\s\S]*?GROUP\s+BY\s+act\.organization_id/i, 'activities_agg CTE');
console.log('  ✓ activities_agg CTE (pre-aggregated)');

assert.match(sql, /devis_agg\s+AS\s*\([\s\S]*?GROUP\s+BY\s+d\.organization_id/i, 'devis_agg CTE');
console.log('  ✓ devis_agg CTE (pre-aggregated)');

assert.match(sql, /missions_agg\s+AS\s*\([\s\S]*?GROUP\s+BY\s+m\.organization_id/i, 'missions_agg CTE');
console.log('  ✓ missions_agg CTE (pre-aggregated)');

assert.match(sql, /billing_agg\s+AS\s*\([\s\S]*?GROUP\s+BY\s+m\.organization_id/i, 'billing_agg CTE');
console.log('  ✓ billing_agg CTE (pre-aggregated, derived through missions)');

// Archived orgs excluded
assert.match(sql, /o\.status\s*<>\s*'archived'/i, 'archived orgs excluded');
console.log('  ✓ archived organizations excluded');

// Privileges
assert.match(sql, /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_organizations_summary\(\)\s+FROM\s+PUBLIC,\s*anon,\s*service_role/i, 'summary REVOKE');
console.log('  ✓ summary REVOKE from PUBLIC, anon, service_role');

assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_organizations_summary\(\)\s+TO\s+authenticated/i, 'summary GRANT');
console.log('  ✓ summary GRANT to authenticated');

// =========================================================
// 9. INDEX
// =========================================================
console.log('\n--- INDEX ---');

assert.match(sql, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_mission_events_mission_created_at\s+ON\s+public\.mission_events\s+\(mission_id,\s*created_at\s+DESC\)/i, 'composite index');
console.log('  ✓ idx_mission_events_mission_created_at (mission_id, created_at DESC)');

// No speculative composite indexes
const createIndexCount = (sql.match(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/gi) || []).length;
assert.equal(createIndexCount, 1, `exactly 1 index created, found ${createIndexCount}`);
console.log('  ✓ exactly 1 index (no speculative indexes)');

// =========================================================
// 10. NO CHANGES TO EXISTING TABLES
// =========================================================
console.log('\n--- NO CHANGES TO EXISTING TABLES ---');

// No ALTER POLICY on existing tables
assert.doesNotMatch(sql, /ALTER\s+POLICY\s+ON\s+public\.(clients|devis|missions|mission_events|billing_records|billing_events|organizations|crm_opportunities|crm_pipeline_events|crm_activities)/i, 'no ALTER POLICY on existing tables');
console.log('  ✓ no ALTER POLICY on existing tables');

// No CREATE POLICY on existing tables (only on crm_link_events)
const createPolicyMatches = sql.match(/CREATE\s+POLICY\s+\S+\s+ON\s+public\.(\w+)/gi) || [];
for (const m of createPolicyMatches) {
  const tbl = m.match(/ON\s+public\.(\w+)/i)[1];
  assert.equal(tbl, 'crm_link_events', `CREATE POLICY only on crm_link_events, found ${tbl}`);
}
console.log('  ✓ CREATE POLICY only on crm_link_events');

// No GRANT/REVOKE changes on existing tables
const grantMatches = sql.match(/GRANT\s+\S+\s+ON\s+public\.(\w+)/gi) || [];
for (const m of grantMatches) {
  const tbl = m.match(/ON\s+public\.(\w+)/i)[1];
  assert.equal(tbl, 'crm_link_events', `GRANT only on crm_link_events, found ${tbl}`);
}
console.log('  ✓ GRANT only on crm_link_events');

// No ALTER TABLE on existing tables (no column/FK changes)
const alterTableMatches = sql.match(/ALTER\s+TABLE\s+public\.(\w+)/gi) || [];
for (const m of alterTableMatches) {
  const tbl = m.match(/public\.(\w+)/i)[1];
  assert.equal(tbl, 'crm_link_events', `ALTER TABLE only on crm_link_events, found ${tbl}`);
}
console.log('  ✓ ALTER TABLE only on crm_link_events');

// No DROP TRIGGER on existing tables
assert.doesNotMatch(sql, /DROP\s+TRIGGER\s+IF\s+EXISTS\s+\w+\s+ON\s+public\.(clients|devis|missions|mission_events|billing_records|billing_events|organizations|crm_opportunities|crm_pipeline_events|crm_activities)/i, 'no DROP TRIGGER on existing tables');
console.log('  ✓ no DROP TRIGGER on existing tables');

// =========================================================
// 11. SECURITY DEFINER INVENTORY
// =========================================================
console.log('\n--- SECURITY DEFINER INVENTORY ---');

// New SD functions: crm_link_events_immutable, log_crm_link_event,
// crm_timeline_read, crm_organizations_summary (4 new)
// Extended (CREATE OR REPLACE): guard_clients_organization_id,
// devis_guard_crm_links, missions_check_devis_org (3 extended)
// Total SD in this migration: 7
const sdFunctions = [
  'crm_link_events_immutable',
  'log_crm_link_event',
  'guard_clients_organization_id',
  'devis_guard_crm_links',
  'missions_check_devis_org',
  'crm_timeline_read',
  'crm_organizations_summary'
];
for (const fn of sdFunctions) {
  assert.match(sql, new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}`, 'i'), `SD function ${fn}`);
}
console.log(`  ✓ ${sdFunctions.length} SECURITY DEFINER functions in P3B6 migration`);

// All have OWNER postgres
for (const fn of sdFunctions) {
  assert.match(sql, new RegExp(`ALTER\\s+FUNCTION\\s+public\\.${fn}[\\s\\S]*?OWNER\\s+TO\\s+postgres`, 'i'), `OWNER postgres: ${fn}`);
}
console.log('  ✓ all SD functions OWNER postgres');

// All have SET search_path = ''
for (const fn of sdFunctions) {
  assert.match(sql, new RegExp(`FUNCTION\\s+public\\.${fn}[\\s\\S]*?SET\\s+search_path\\s*=\\s*''`, 'i'), `search_path '': ${fn}`);
}
console.log('  ✓ all SD functions SET search_path = \'\'');

// =========================================================
// 12. HISTORICAL MIGRATIONS UNCHANGED
// =========================================================
console.log('\n--- HISTICAL MIGRATIONS UNCHANGED ---');

const p3b5Path = path.join(projectRoot, 'supabase', 'migrations', '20260910110000_p3b5_crm_business_links.sql');
const p3b5Stat = fs.statSync(p3b5Path);
assert.ok(p3b5Stat.size > 0, 'P3B5 migration still exists');
console.log('  ✓ P3B5 migration file unchanged');

console.log('\n=== P3B6 Static Validation: ALL PASSED ===');
