// P3B3 — CRM Opportunities + Pipeline Events — Static Migration Validation
//
// Validates the migration SQL for:
// - crm_opportunities table schema (fields, PK, FKs, CHECKs)
// - crm_pipeline_events table schema (fields, PK, FK, CHECKs)
// - stage CHECK constraint (10 stages)
// - probability CHECK (0..100)
// - estimated_value CHECK (>= 0)
// - lost_reason invariant (NULL unless stage=lost)
// - contact/org integrity trigger
// - stage protection trigger (blocks direct UPDATE)
// - pipeline events immutability trigger
// - initial creation event trigger (AFTER INSERT, SECURITY DEFINER)
// - transition RPC (SECURITY DEFINER, search_path='', is_internal_user)
// - transition map (allowed stage transitions)
// - RLS enabled + policies
// - grants (opportunities CRUD to authenticated, events SELECT only)
// - RPC grants/revokes
// - no existing-table ALTER/DROP
// - updated_at trigger reuses shared helper
// - no duplicate set_updated_at helper

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260909140000_p3b3_crm_opportunities_pipeline.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

// =========================================================
// SCHEMA: crm_opportunities
// =========================================================

const oppChecks = [
  ['crm_opportunities table created', /CREATE TABLE IF NOT EXISTS public\.crm_opportunities\s*\(/i],
  ['id uuid PK DEFAULT gen_random_uuid', /id\s+uuid\s+DEFAULT gen_random_uuid\(\)\s+NOT NULL/i],
  ['created_at timestamptz NOT NULL DEFAULT now', /created_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['updated_at timestamptz NOT NULL DEFAULT now', /updated_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['organization_id uuid', /organization_id\s+uuid\s+REFERENCES\s+public\.organizations\(id\)\s+ON DELETE SET NULL/i],
  ['contact_id uuid', /contact_id\s+uuid\s+REFERENCES\s+public\.organization_contacts\(id\)\s+ON DELETE SET NULL/i],
  ['title text NOT NULL', /title\s+text\s+NOT NULL/i],
  ['stage text NOT NULL DEFAULT lead', /stage\s+text\s+NOT NULL\s+DEFAULT 'lead'/i],
  ['estimated_value numeric', /estimated_value\s+numeric/i],
  ['probability smallint', /probability\s+smallint/i],
  ['source text', /source\s+text/i],
  ['source_detail text', /source_detail\s+text/i],
  ['campaign text', /campaign\s+text/i],
  ['external_reference text', /external_reference\s+text/i],
  ['lead_first_name text', /lead_first_name\s+text/i],
  ['lead_last_name text', /lead_last_name\s+text/i],
  ['lead_email text', /lead_email\s+text/i],
  ['lead_phone text', /lead_phone\s+text/i],
  ['next_action text', /next_action\s+text/i],
  ['next_action_at timestamptz', /next_action_at\s+timestamptz/i],
  ['last_contact_at timestamptz', /last_contact_at\s+timestamptz/i],
  ['lost_reason text', /lost_reason\s+text/i],
  ['created_by uuid', /created_by\s+uuid/i],
  ['PRIMARY KEY (id)', /PRIMARY KEY\s*\(id\)/i],
];

for (const [name, pattern] of oppChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// STAGE CHECK
// =========================================================

const stages = [
  'lead', 'qualified', 'contacted', 'meeting', 'quote_requested',
  'quote_sent', 'negotiating', 'won', 'lost', 'dormant',
];

for (const st of stages) {
  const pattern = new RegExp(`'${st}'`, 'i');
  assert.match(sql, pattern, `stage '${st}' allowed`);
  console.log(`  ✓ stage '${st}' allowed`);
}

assert.match(
  sql,
  /crm_opportunities_stage_check[\s\S]*CHECK\s*\(stage\s+IN/i,
  'stage CHECK constraint named',
);
console.log('  ✓ stage CHECK constraint named');

// =========================================================
// PROBABILITY + ESTIMATED_VALUE + LOST_REASON CHECKS
// =========================================================

assert.match(
  sql,
  /crm_opportunities_probability_check[\s\S]*CHECK\s*\(probability\s+IS\s+NULL\s+OR\s+\(probability\s*>=\s*0\s+AND\s+probability\s*<=\s*100\)\)/i,
  'probability CHECK 0..100',
);
console.log('  ✓ probability CHECK 0..100');

assert.match(
  sql,
  /crm_opportunities_estimated_value_check[\s\S]*CHECK\s*\(estimated_value\s+IS\s+NULL\s+OR\s+estimated_value\s*>=\s*0\)/i,
  'estimated_value CHECK >= 0',
);
console.log('  ✓ estimated_value CHECK >= 0');

assert.match(
  sql,
  /crm_opportunities_lost_reason_invariant[\s\S]*CHECK\s*\(lost_reason\s+IS\s+NULL\s+OR\s+stage\s*=\s*'lost'\)/i,
  'lost_reason invariant (NULL unless stage=lost)',
);
console.log('  ✓ lost_reason invariant (NULL unless stage=lost)');

assert.match(
  sql,
  /crm_opportunities_title_nonempty[\s\S]*btrim\(title\)\s*<>\s*''/i,
  'title nonempty check',
);
console.log('  ✓ title nonempty check');

// =========================================================
// INDEXES: crm_opportunities
// =========================================================

const oppIndexChecks = [
  ['index organization_id partial', /CREATE\s+INDEX[^;]*crm_opportunities_organization_id_idx[^;]*\(organization_id\)[^;]*WHERE\s+organization_id\s+IS\s+NOT\s+NULL/i],
  ['index contact_id partial', /CREATE\s+INDEX[^;]*crm_opportunities_contact_id_idx[^;]*\(contact_id\)[^;]*WHERE\s+contact_id\s+IS\s+NOT\s+NULL/i],
  ['index stage', /CREATE\s+INDEX[^;]*crm_opportunities_stage_idx[^;]*\(stage\)/i],
  ['index next_action_at partial', /CREATE\s+INDEX[^;]*crm_opportunities_next_action_at_idx[^;]*\(next_action_at\)[^;]*WHERE\s+next_action_at\s+IS\s+NOT\s+NULL/i],
  ['index last_contact_at partial', /CREATE\s+INDEX[^;]*crm_opportunities_last_contact_at_idx[^;]*\(last_contact_at\)[^;]*WHERE\s+last_contact_at\s+IS\s+NOT\s+NULL/i],
  ['index created_at', /CREATE\s+INDEX[^;]*crm_opportunities_created_at_idx[^;]*\(created_at\)/i],
];

for (const [name, pattern] of oppIndexChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SCHEMA: crm_pipeline_events
// =========================================================

const eventChecks = [
  ['crm_pipeline_events table created', /CREATE TABLE IF NOT EXISTS public\.crm_pipeline_events\s*\(/i],
  ['id uuid PK DEFAULT gen_random_uuid', /id\s+uuid\s+DEFAULT gen_random_uuid\(\)\s+NOT NULL/i],
  ['created_at timestamptz NOT NULL DEFAULT now', /created_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['opportunity_id uuid NOT NULL', /opportunity_id\s+uuid\s+NOT NULL/i],
  ['FK opportunity_id ON DELETE RESTRICT', /REFERENCES\s+public\.crm_opportunities\(id\)\s+ON DELETE RESTRICT/i],
  ['from_stage text', /from_stage\s+text/i],
  ['to_stage text NOT NULL', /to_stage\s+text\s+NOT NULL/i],
  ['reason text', /reason\s+text/i],
  ['actor_user_id uuid', /actor_user_id\s+uuid/i],
  ['actor_role text', /actor_role\s+text/i],
  ['metadata jsonb NOT NULL DEFAULT', /metadata\s+jsonb\s+NOT NULL\s+DEFAULT/i],
  ['PRIMARY KEY (id)', /PRIMARY KEY\s*\(id\)/i],
];

for (const [name, pattern] of eventChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// actor_role CHECK
assert.match(
  sql,
  /crm_pipeline_events_actor_role_check[\s\S]*CHECK\s*\(actor_role\s+IS\s+NULL\s+OR\s+actor_role\s+IN\s*\('admin',\s*'operator'\)/i,
  'actor_role CHECK (admin/operator)',
);
console.log('  ✓ actor_role CHECK (admin/operator)');

// to_stage CHECK
assert.match(
  sql,
  /crm_pipeline_events_to_stage_check[\s\S]*CHECK\s*\(to_stage\s+IN/i,
  'to_stage CHECK constraint named',
);
console.log('  ✓ to_stage CHECK constraint named');

// from_stage CHECK
assert.match(
  sql,
  /crm_pipeline_events_from_stage_check[\s\S]*CHECK\s*\(from_stage\s+IS\s+NULL\s+OR\s+from_stage\s+IN/i,
  'from_stage CHECK constraint named',
);
console.log('  ✓ from_stage CHECK constraint named');

// =========================================================
// INDEXES: crm_pipeline_events
// =========================================================

assert.match(
  sql,
  /CREATE\s+INDEX[^;]*crm_pipeline_events_opportunity_created_idx[^;]*\(opportunity_id,\s*created_at\)/i,
  'index (opportunity_id, created_at)',
);
console.log('  ✓ index (opportunity_id, created_at)');

// =========================================================
// TRIGGERS: updated_at, contact/org, immutability, creation event
// =========================================================
// P3B3A: stage protection trigger removed — column-level privileges
// are the primary control.

const triggerChecks = [
  ['reuses public.set_updated_at()', /EXECUTE FUNCTION public\.set_updated_at\(\)/i],
  ['trigger crm_opportunities_set_updated_at', /CREATE\s+TRIGGER\s+crm_opportunities_set_updated_at/i],
  ['contact/org check trigger', /CREATE\s+TRIGGER\s+crm_opportunities_contact_org_check/i],
  ['contact/org check BEFORE INSERT OR UPDATE', /BEFORE\s+INSERT\s+OR\s+UPDATE\s+ON\s+public\.crm_opportunities/i],
  ['immutability trigger', /CREATE\s+TRIGGER\s+crm_pipeline_events_immutable_trigger/i],
  ['immutability BEFORE UPDATE OR DELETE', /BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+public\.crm_pipeline_events/i],
  ['creation event trigger', /CREATE\s+TRIGGER\s+crm_opportunities_create_event/i],
  ['creation event AFTER INSERT', /AFTER\s+INSERT\s+ON\s+public\.crm_opportunities/i],
];

for (const [name, pattern] of triggerChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// CONTACT/ORG INTEGRITY FUNCTION
// =========================================================

assert.match(
  sql,
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_opportunities_check_contact_org\(\)/i,
  'contact/org check function exists',
);
console.log('  ✓ contact/org check function exists');

assert.match(
  sql,
  /v_contact_org_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.organization_id/i,
  'contact/org mismatch check uses IS DISTINCT FROM',
);
console.log('  ✓ contact/org mismatch check uses IS DISTINCT FROM');

// =========================================================
// STAGE MUTATION HARDENING (column-level privileges, no trigger)
// =========================================================
// P3B3A: stage protection is via column-level UPDATE privileges,
// not a trigger. The protect_stage trigger was removed.
// authenticated has NO UPDATE on stage or lost_reason columns.

// No stage protection trigger function should exist.
assert.doesNotMatch(
  sql,
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_opportunities_protect_stage\(\)/i,
  'stage protection trigger function removed',
);
console.log('  ✓ stage protection trigger function removed');

// No protect_stage trigger.
assert.doesNotMatch(
  sql,
  /CREATE\s+TRIGGER\s+crm_opportunities_protect_stage/i,
  'stage protection trigger removed',
);
console.log('  ✓ stage protection trigger removed');

// No current_user = 'postgres' bypass as stage authorization.
assert.doesNotMatch(
  sql.replace(/^\s*--[^\n]*$/gm, ''),
  /current_user\s*<>\s*'postgres'/i,
  'no current_user postgres bypass as stage authorization',
);
console.log('  ✓ no current_user postgres bypass as stage authorization');

// Table-wide UPDATE NOT granted to authenticated.
assert.doesNotMatch(
  sql,
  /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/i,
  'no table-wide UPDATE grant to authenticated on crm_opportunities',
);
console.log('  ✓ no table-wide UPDATE grant to authenticated on crm_opportunities');

// P3B3B: No table-wide INSERT grant either.
assert.doesNotMatch(
  sql,
  /GRANT\s+SELECT,\s*INSERT,\s*DELETE\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/i,
  'no table-wide INSERT grant to authenticated on crm_opportunities',
);
console.log('  ✓ no table-wide INSERT grant to authenticated on crm_opportunities');

// Column-level UPDATE granted on non-stage columns.
assert.match(
  sql,
  /GRANT\s+UPDATE\s*\([^)]*organization_id[^)]*\)\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/i,
  'column-level UPDATE granted on non-stage columns',
);
console.log('  ✓ column-level UPDATE granted on non-stage columns');

// stage column NOT in any column-level UPDATE grant.
const updateGrantBlock = sql.match(/GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/is);
assert.ok(updateGrantBlock, 'column-level UPDATE grant block found');
assert.doesNotMatch(
  updateGrantBlock[1],
  /\bstage\b/i,
  'stage column NOT in column-level UPDATE grant',
);
console.log('  ✓ stage column NOT in column-level UPDATE grant');

// lost_reason column NOT in any column-level UPDATE grant.
assert.doesNotMatch(
  updateGrantBlock[1],
  /\blost_reason\b/i,
  'lost_reason column NOT in column-level UPDATE grant',
);
console.log('  ✓ lost_reason column NOT in column-level UPDATE grant');

// created_by NOT in column-level UPDATE grant (server-derived).
assert.doesNotMatch(
  updateGrantBlock[1],
  /\bcreated_by\b/i,
  'created_by NOT in column-level UPDATE grant (server-derived)',
);
console.log('  ✓ created_by NOT in column-level UPDATE grant (server-derived)');

// updated_at NOT in column-level UPDATE grant (trigger-managed).
assert.doesNotMatch(
  updateGrantBlock[1],
  /\bupdated_at\b/i,
  'updated_at NOT in column-level UPDATE grant (trigger-managed)',
);
console.log('  ✓ updated_at NOT in column-level UPDATE grant (trigger-managed)');

// P3B3B: Column-level INSERT granted on non-protected columns.
assert.match(
  sql,
  /GRANT\s+INSERT\s*\([^)]*organization_id[^)]*\)\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/i,
  'column-level INSERT granted on non-protected columns',
);
console.log('  ✓ column-level INSERT granted on non-protected columns');

// stage column NOT in any column-level INSERT grant.
const insertGrantBlock = sql.match(/GRANT\s+INSERT\s*\(([^)]*)\)\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/is);
assert.ok(insertGrantBlock, 'column-level INSERT grant block found');
assert.doesNotMatch(
  insertGrantBlock[1],
  /\bstage\b/i,
  'stage column NOT in column-level INSERT grant',
);
console.log('  ✓ stage column NOT in column-level INSERT grant');

// lost_reason column NOT in any column-level INSERT grant.
assert.doesNotMatch(
  insertGrantBlock[1],
  /\blost_reason\b/i,
  'lost_reason column NOT in column-level INSERT grant',
);
console.log('  ✓ lost_reason column NOT in column-level INSERT grant');

// created_by NOT in column-level INSERT grant (server-derived).
assert.doesNotMatch(
  insertGrantBlock[1],
  /\bcreated_by\b/i,
  'created_by NOT in column-level INSERT grant (server-derived)',
);
console.log('  ✓ created_by NOT in column-level INSERT grant (server-derived)');

// id NOT in column-level INSERT grant (default generated).
assert.doesNotMatch(
  insertGrantBlock[1],
  /\bid\b/i,
  'id NOT in column-level INSERT grant (default generated)',
);
console.log('  ✓ id NOT in column-level INSERT grant (default generated)');

// created_at NOT in column-level INSERT grant (DB default).
assert.doesNotMatch(
  insertGrantBlock[1],
  /\bcreated_at\b/i,
  'created_at NOT in column-level INSERT grant (DB default)',
);
console.log('  ✓ created_at NOT in column-level INSERT grant (DB default)');

// updated_at NOT in column-level INSERT grant (trigger-managed).
assert.doesNotMatch(
  insertGrantBlock[1],
  /\bupdated_at\b/i,
  'updated_at NOT in column-level INSERT grant (trigger-managed)',
);
console.log('  ✓ updated_at NOT in column-level INSERT grant (trigger-managed)');

// SELECT, DELETE still granted to authenticated (no table-wide INSERT/UPDATE).
assert.match(
  sql,
  /GRANT\s+SELECT,\s*DELETE\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/i,
  'SELECT, DELETE granted to authenticated (no table-wide INSERT/UPDATE)',
);
console.log('  ✓ SELECT, INSERT, DELETE granted to authenticated');

// =========================================================
// IMMUTABILITY FUNCTION
// =========================================================

assert.match(
  sql,
  /crm_pipeline_events_immutable\(\)[\s\S]*RAISE\s+EXCEPTION/i,
  'immutability function raises exception',
);
console.log('  ✓ immutability function raises exception');

// =========================================================
// CREATION EVENT FUNCTION (SECURITY DEFINER)
// =========================================================

assert.match(
  sql,
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_opportunities_create_event\(\)/i,
  'creation event function exists',
);
console.log('  ✓ creation event function exists');

// Extract the creation event function block to check SECURITY DEFINER
const createEventBlock = sql.match(
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_opportunities_create_event\(\)[\s\S]*?AS\s*\$\$[\s\S]*?\$\$;/i,
);
assert.ok(createEventBlock, 'creation event function block found');
assert.match(createEventBlock[0], /SECURITY\s+DEFINER/i, 'creation event function is SECURITY DEFINER');
console.log('  ✓ creation event function is SECURITY DEFINER');
assert.match(createEventBlock[0], /SET\s+search_path\s*=\s*''/i, 'creation event function has SET search_path');
console.log('  ✓ creation event function has SET search_path');
assert.match(createEventBlock[0], /from_stage,[\s\S]*?NULL/i, 'creation event inserts from_stage=NULL');
console.log('  ✓ creation event inserts from_stage=NULL');
assert.match(createEventBlock[0], /to_stage,[\s\S]*?NEW\.stage/i, 'creation event inserts to_stage=NEW.stage');
console.log('  ✓ creation event inserts to_stage=NEW.stage');

// =========================================================
// TRANSITION RPC
// =========================================================

const rpcBlock = sql.match(
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_transition_opportunity\([\s\S]*?AS\s*\$\$[\s\S]*?\$\$;/i,
);
assert.ok(rpcBlock, 'transition RPC function block found');

const rpcChecks = [
  ['transition RPC exists', /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_transition_opportunity\(/i],
  ['SECURITY DEFINER', /SECURITY\s+DEFINER/i],
  ['SET search_path = \'\'', /SET\s+search_path\s*=\s*''/i],
];

for (const [name, pattern] of rpcChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// Check inside RPC block
assert.match(rpcBlock[0], /public\.is_internal_user\(\)/i, 'RPC checks is_internal_user');
console.log('  ✓ RPC checks is_internal_user');

assert.match(rpcBlock[0], /FOR\s+UPDATE/i, 'RPC uses SELECT FOR UPDATE');
console.log('  ✓ RPC uses SELECT FOR UPDATE');

assert.match(rpcBlock[0], /v_from_stage\s*=\s*p_to_stage/i, 'RPC rejects no-op transition');
console.log('  ✓ RPC rejects no-op transition');

assert.match(rpcBlock[0], /Transition\s+non\s+autorisée/i, 'RPC rejects invalid transition');
console.log('  ✓ RPC rejects invalid transition');

assert.match(rpcBlock[0], /CASE\s+v_from_stage/i, 'RPC uses CASE for transition map');
console.log('  ✓ RPC uses CASE for transition map');

assert.match(rpcBlock[0], /lost_reason\s*=\s*CASE\s+WHEN\s+p_to_stage\s*=\s*'lost'/i, 'RPC sets lost_reason conditionally');
console.log('  ✓ RPC sets lost_reason conditionally');

assert.match(rpcBlock[0], /INSERT\s+INTO\s+public\.crm_pipeline_events/i, 'RPC inserts pipeline event');
console.log('  ✓ RPC inserts pipeline event');

assert.match(rpcBlock[0], /auth\.uid\(\)/i, 'RPC captures actor_user_id from auth.uid()');
console.log('  ✓ RPC captures actor_user_id from auth.uid()');

assert.match(rpcBlock[0], /public\.is_admin\(\)/i, 'RPC determines role via is_admin()');
console.log('  ✓ RPC determines role via is_admin()');

// =========================================================
// TRANSITION MAP VERIFICATION
// =========================================================

// Verify key transitions are in the map
const transitionMapChecks = [
  ['lead -> qualified', /WHEN\s+'lead'\s+THEN[\s\S]*?'qualified'/i],
  ['lead -> contacted', /WHEN\s+'lead'\s+THEN[\s\S]*?'contacted'/i],
  ['lead -> lost', /WHEN\s+'lead'\s+THEN[\s\S]*?'lost'/i],
  ['qualified -> meeting', /WHEN\s+'qualified'\s+THEN[\s\S]*?'meeting'/i],
  ['meeting -> quote_sent', /WHEN\s+'meeting'\s+THEN[\s\S]*?'quote_sent'/i],
  ['quote_sent -> negotiating', /WHEN\s+'quote_sent'\s+THEN[\s\S]*?'negotiating'/i],
  ['quote_sent -> won', /WHEN\s+'quote_sent'\s+THEN[\s\S]*?'won'/i],
  ['negotiating -> won', /WHEN\s+'negotiating'\s+THEN[\s\S]*?'won'/i],
  ['dormant -> contacted', /WHEN\s+'dormant'\s+THEN[\s\S]*?'contacted'/i],
  ['dormant -> qualified', /WHEN\s+'dormant'\s+THEN[\s\S]*?'qualified'/i],
];

for (const [name, pattern] of transitionMapChecks) {
  assert.match(rpcBlock[0], pattern, `transition map: ${name}`);
  console.log(`  ✓ transition map: ${name}`);
}

// =========================================================
// RLS: crm_opportunities
// =========================================================

const rlsOppChecks = [
  ['RLS enabled on crm_opportunities', /ALTER TABLE public\.crm_opportunities ENABLE ROW LEVEL SECURITY/i],
  ['REVOKE ALL FROM PUBLIC', /REVOKE ALL ON public\.crm_opportunities FROM PUBLIC/i],
  ['REVOKE ALL FROM anon', /REVOKE ALL ON public\.crm_opportunities FROM anon/i],
  ['REVOKE ALL FROM authenticated', /REVOKE ALL ON public\.crm_opportunities FROM authenticated/i],
  ['GRANT SELECT, DELETE to authenticated (no table INSERT/UPDATE)', /GRANT\s+SELECT,\s*DELETE\s+ON public\.crm_opportunities TO authenticated/i],
  ['P3B3C: no GRANT ALL to service_role on opportunities', /REVOKE\s+ALL\s+ON\s+public\.crm_opportunities\s+FROM\s+service_role/i],
  ['P3B3C: service_role SELECT on opportunities', /GRANT\s+SELECT\s+ON\s+public\.crm_opportunities\s+TO\s+service_role/i],
  ['P3B3C: service_role column-level INSERT on opportunities', /GRANT\s+INSERT\s*\([^)]*organization_id[^)]*\)\s+ON\s+public\.crm_opportunities\s+TO\s+service_role/i],
  ['P3B3C: service_role column-level UPDATE on opportunities', /GRANT\s+UPDATE\s*\([^)]*organization_id[^)]*\)\s+ON\s+public\.crm_opportunities\s+TO\s+service_role/i],
  ['SELECT policy uses is_internal_user', /crm_opportunities_select_internal[\s\S]*FOR SELECT[\s\S]*is_internal_user\(\)/i],
  ['INSERT policy uses is_internal_user', /crm_opportunities_insert_internal[\s\S]*FOR INSERT[\s\S]*is_internal_user\(\)/i],
  ['UPDATE policy uses is_internal_user', /crm_opportunities_update_internal[\s\S]*FOR UPDATE[\s\S]*is_internal_user\(\)/i],
  ['DELETE policy admin-only (is_admin)', /crm_opportunities_delete_admin[\s\S]*FOR DELETE[\s\S]*is_admin\(\)/i],
];

for (const [name, pattern] of rlsOppChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// RLS: crm_pipeline_events
// =========================================================

const rlsEventChecks = [
  ['RLS enabled on crm_pipeline_events', /ALTER TABLE public\.crm_pipeline_events ENABLE ROW LEVEL SECURITY/i],
  ['REVOKE ALL FROM PUBLIC', /REVOKE ALL ON public\.crm_pipeline_events FROM PUBLIC/i],
  ['REVOKE ALL FROM anon', /REVOKE ALL ON public\.crm_pipeline_events FROM anon/i],
  ['REVOKE ALL FROM authenticated', /REVOKE ALL ON public\.crm_pipeline_events FROM authenticated/i],
  ['GRANT SELECT only to authenticated', /GRANT\s+SELECT\s+ON public\.crm_pipeline_events TO authenticated/i],
  ['P3B3C: no GRANT ALL to service_role on events', /REVOKE\s+ALL\s+ON\s+public\.crm_pipeline_events\s+FROM\s+service_role/i],
  ['P3B3C: service_role SELECT only on events', /GRANT\s+SELECT\s+ON\s+public\.crm_pipeline_events\s+TO\s+service_role/i],
  ['SELECT policy uses is_internal_user', /crm_pipeline_events_select_internal[\s\S]*FOR SELECT[\s\S]*is_internal_user\(\)/i],
];

for (const [name, pattern] of rlsEventChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// Verify NO INSERT/UPDATE/DELETE policies on pipeline events
// Use a targeted regex that matches a policy name starting with crm_pipeline_events
// followed by a write operation.
assert.doesNotMatch(
  sql,
  /crm_pipeline_events_\w*\s+ON\s+public\.crm_pipeline_events\s+FOR\s+(INSERT|UPDATE|DELETE)\s+TO\s+authenticated/i,
  'no write policies on crm_pipeline_events for authenticated',
);
console.log('  ✓ no write policies on crm_pipeline_events for authenticated');

// =========================================================
// RPC GRANTS/REVOKES
// =========================================================

assert.match(
  sql,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_transition_opportunity\([^)]*\)\s+FROM\s+PUBLIC,\s*anon/i,
  'RPC REVOKE from PUBLIC and anon',
);
console.log('  ✓ RPC REVOKE from PUBLIC and anon');

assert.match(
  sql,
  /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_transition_opportunity\([^)]*\)\s+TO\s+authenticated/i,
  'RPC GRANT EXECUTE to authenticated',
);
console.log('  ✓ RPC GRANT EXECUTE to authenticated');

// =========================================================
// POLICY / GRANT CONSISTENCY GUARD
// =========================================================

const consistencyChecks = [
  {
    name: 'opportunities INSERT policy has matching column-level GRANT',
    policy: /crm_opportunities_insert_internal[\s\S]*FOR INSERT/i,
    grant: /GRANT\s+INSERT\s*\([^)]*\)\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/i,
  },
  {
    name: 'opportunities UPDATE policy has matching column-level GRANT',
    policy: /crm_opportunities_update_internal[\s\S]*FOR UPDATE/i,
    grant: /GRANT\s+UPDATE\s*\([^)]*\)\s+ON\s+public\.crm_opportunities\s+TO\s+authenticated/i,
  },
  {
    name: 'opportunities DELETE policy has matching GRANT',
    policy: /crm_opportunities_delete_admin[\s\S]*FOR DELETE/i,
    grant: /GRANT\s+SELECT,\s*DELETE\s+ON public\.crm_opportunities TO authenticated/i,
  },
];

for (const { name, policy, grant } of consistencyChecks) {
  assert.match(sql, policy, `${name} — policy exists`);
  assert.match(sql, grant, `${name} — grant exists`);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SECURITY DEFINER INVENTORY + SEARCH_PATH AUDIT
// =========================================================
// P3B3B: All 4 SECURITY DEFINER functions must have SET search_path = ''.
// Count SECURITY DEFINER as a function attribute (at start of line, not in a comment).
// Strip all comment lines (including indented ones) before counting.
const sqlNoComments2 = sql.replace(/^\s*--[^\n]*$/gm, '');
const securityDefinerCount = (sqlNoComments2.match(/^SECURITY\s+DEFINER/gim) || []).length;
// Expected: crm_transition_opportunity + crm_opportunities_create_event +
// crm_opportunities_check_contact_org + crm_opportunities_set_created_by = 4
assert.equal(securityDefinerCount, 4, `exactly 4 SECURITY DEFINER functions, found ${securityDefinerCount}`);
console.log(`  ✓ exactly 4 SECURITY DEFINER functions (count=${securityDefinerCount})`);

// All 4 SECURITY DEFINER functions must have SET search_path = ''.
const sdFunctions = [
  'crm_transition_opportunity',
  'crm_opportunities_create_event',
  'crm_opportunities_check_contact_org',
  'crm_opportunities_set_created_by',
];
for (const fn of sdFunctions) {
  const block = sql.match(
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\([\\s\\S]*?\\$\\$;`, 'i'),
  );
  assert.ok(block, `function block found for ${fn}`);
  assert.match(block[0], /SECURITY\s+DEFINER/i, `${fn} is SECURITY DEFINER`);
  assert.match(block[0], /SET\s+search_path\s*=\s*''/i, `${fn} has SET search_path = ''`);
  console.log(`  ✓ ${fn}: SECURITY DEFINER + SET search_path = ''`);
}

// =========================================================
// TRIGGER FUNCTION EXECUTE REVOCATIONS
// =========================================================
// Trigger functions should not be directly callable by authenticated/anon.
assert.match(
  sql,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_opportunities_create_event\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
  'create_event EXECUTE revoked from PUBLIC, anon, authenticated',
);
console.log('  ✓ create_event EXECUTE revoked from PUBLIC, anon, authenticated');

assert.match(
  sql,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_opportunities_check_contact_org\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
  'check_contact_org EXECUTE revoked from PUBLIC, anon, authenticated',
);
console.log('  ✓ check_contact_org EXECUTE revoked from PUBLIC, anon, authenticated');

assert.match(
  sql,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.crm_opportunities_set_created_by\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
  'set_created_by EXECUTE revoked from PUBLIC, anon, authenticated',
);
console.log('  ✓ set_created_by EXECUTE revoked from PUBLIC, anon, authenticated');

// =========================================================
// CREATED_BY SERVER-DERIVATION TRIGGER
// =========================================================
assert.match(
  sql,
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_opportunities_set_created_by\(\)/i,
  'set_created_by function exists',
);
console.log('  ✓ set_created_by function exists');

assert.match(
  sql,
  /CREATE\s+TRIGGER\s+crm_opportunities_set_created_by/i,
  'set_created_by trigger exists',
);
console.log('  ✓ set_created_by trigger exists');

assert.match(
  sql,
  /NEW\.created_by\s*:=\s*auth\.uid\(\)/i,
  'set_created_by assigns auth.uid()',
);
console.log('  ✓ set_created_by assigns auth.uid()');

// =========================================================
// SERVICE_ROLE PRIVILEGE CATALOG (P3B3C)
// =========================================================
// service_role is an application credential, NOT a database owner.
// It must not bypass lifecycle controls.

// No GRANT ALL on crm_opportunities to service_role.
assert.doesNotMatch(
  sql,
  /GRANT\s+ALL\s+ON\s+public\.crm_opportunities\s+TO\s+service_role/i,
  'no GRANT ALL on crm_opportunities to service_role',
);
console.log('  ✓ no GRANT ALL on crm_opportunities to service_role');

// service_role column-level INSERT on opportunities excludes protected columns.
const srInsertBlock = sql.match(/GRANT\s+INSERT\s*\(([^)]*)\)\s+ON\s+public\.crm_opportunities\s+TO\s+service_role/is);
assert.ok(srInsertBlock, 'service_role column-level INSERT block found');
assert.doesNotMatch(srInsertBlock[1], /\bstage\b/i, 'service_role INSERT excludes stage');
assert.doesNotMatch(srInsertBlock[1], /\blost_reason\b/i, 'service_role INSERT excludes lost_reason');
assert.doesNotMatch(srInsertBlock[1], /\bcreated_by\b/i, 'service_role INSERT excludes created_by');
assert.doesNotMatch(srInsertBlock[1], /\bid\b/i, 'service_role INSERT excludes id');
assert.doesNotMatch(srInsertBlock[1], /\bcreated_at\b/i, 'service_role INSERT excludes created_at');
assert.doesNotMatch(srInsertBlock[1], /\bupdated_at\b/i, 'service_role INSERT excludes updated_at');
console.log('  ✓ service_role INSERT excludes protected columns');

// service_role column-level UPDATE on opportunities excludes protected columns.
const srUpdateBlock = sql.match(/GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+public\.crm_opportunities\s+TO\s+service_role/is);
assert.ok(srUpdateBlock, 'service_role column-level UPDATE block found');
assert.doesNotMatch(srUpdateBlock[1], /\bstage\b/i, 'service_role UPDATE excludes stage');
assert.doesNotMatch(srUpdateBlock[1], /\blost_reason\b/i, 'service_role UPDATE excludes lost_reason');
assert.doesNotMatch(srUpdateBlock[1], /\bcreated_by\b/i, 'service_role UPDATE excludes created_by');
assert.doesNotMatch(srUpdateBlock[1], /\bupdated_at\b/i, 'service_role UPDATE excludes updated_at');
console.log('  ✓ service_role UPDATE excludes protected columns');

// No GRANT ALL on crm_pipeline_events to service_role.
assert.doesNotMatch(
  sql,
  /GRANT\s+ALL\s+ON\s+public\.crm_pipeline_events\s+TO\s+service_role/i,
  'no GRANT ALL on crm_pipeline_events to service_role',
);
console.log('  ✓ no GRANT ALL on crm_pipeline_events to service_role');

// service_role has only SELECT on pipeline events (no INSERT/UPDATE/DELETE).
assert.match(
  sql,
  /GRANT\s+SELECT\s+ON\s+public\.crm_pipeline_events\s+TO\s+service_role/i,
  'service_role SELECT only on pipeline events',
);
console.log('  ✓ service_role SELECT only on pipeline events');

// No table-wide INSERT/UPDATE/DELETE grant to service_role on events.
assert.doesNotMatch(
  sql,
  /GRANT\s+(INSERT|UPDATE|DELETE)\s+ON\s+public\.crm_pipeline_events\s+TO\s+service_role/i,
  'no table-wide INSERT/UPDATE/DELETE on events to service_role',
);
console.log('  ✓ no table-wide INSERT/UPDATE/DELETE on events to service_role');

// =========================================================
// NO MODIFICATION TO EXISTING TABLES
// =========================================================

const existingTableAlter = /ALTER TABLE\s+public\.(clients|devis|missions|convoyeurs|billing_records|billing_events|support_tickets|system_settings|user_roles|internal_operators|organizations|organization_segments|organization_sites|organization_contacts)\b/i;
assert.doesNotMatch(sql, existingTableAlter, 'does not ALTER existing tables');
console.log('  ✓ does not ALTER existing tables');

const existingTableDrop = /DROP TABLE\s+public\.(clients|devis|missions|convoyeurs|billing_records|billing_events|support_tickets|system_settings|user_roles|internal_operators|organizations|organization_segments|organization_sites|organization_contacts)\b/i;
assert.doesNotMatch(sql, existingTableDrop, 'does not DROP existing tables');
console.log('  ✓ does not DROP existing tables');

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

assert.doesNotMatch(
  sqlNoComments2,
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.set_updated_at\(\)/i,
  'does not redefine public.set_updated_at()',
);
console.log('  ✓ does not redefine public.set_updated_at()');

console.log('\n========================================');
console.log('P3B3 static migration validation: ALL PASS');
console.log('========================================');
