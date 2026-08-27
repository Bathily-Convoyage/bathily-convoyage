import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260827160216_allow_assigned_convoyeur_execution_p4_2b.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

const expectedPolicies = [
  'missions_select_b3',
  'edls_select_client_b2',
  'mission_events_convoyeur_select_b2',
  'mission_evidence_select_client_b2',
  'convoyeur_media_select_mission_concerned',
  'convoyeur_media_insert_missions_b2v',
];

const expectedFunctions = [
  ['admin_assign_mission', 'uuid, uuid'],
  ['respond_mission_assignment', 'uuid, boolean'],
  ['transition_mission_status', 'uuid, text, text, jsonb'],
  ['validate_mission_edl', 'uuid, text, jsonb, uuid, text'],
  ['authorize_gps_session', 'uuid'],
  [
    'record_gps_position',
    'uuid, double precision, double precision, double precision, double precision',
  ],
];

assert.match(sql, /^-- P4\.2b:/);
assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/m, 'migration must be atomic');
assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
assert.match(sql, /SET LOCAL statement_timeout = '2min';/);

const policyStatements = sql.match(/ALTER POLICY[\s\S]*?;\s*/gi) ?? [];
assert.equal(policyStatements.length, 6, 'only the six preflighted policies may change');

const actualPolicies = policyStatements.map((statement) => {
  const parsed = statement.match(/ALTER POLICY "([^"]+)" ON (?:public|storage)\.[a-z_]+/i);
  assert.ok(parsed, `unparseable policy statement: ${statement.slice(0, 120)}`);
  assert.match(statement, /\(select auth\.uid\(\)\)/i, `${parsed[1]} must use initPlan auth.uid`);
  return parsed[1];
});

assert.deepEqual(
  [...actualPolicies].sort(),
  [...expectedPolicies].sort(),
  'the migration must alter the exact P4.2b policy set',
);

const policySql = sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION'));
const directPolicyAuthCalls = policySql
  .replace(/\(select auth\.uid\(\)\)/gi, '')
  .replace(/\(select auth\.jwt\(\)\)/gi, '');
assert.doesNotMatch(
  directPolicyAuthCalls,
  /auth\.(?:uid|jwt)\(\)/i,
  'RLS Auth helpers must retain P4.1b initPlan wrappers',
);

assert.equal(
  (sql.match(/external_convoyeurs_enabled\(\)/gi) ?? []).length,
  1,
  'the rollout flag must remain only on the available-mission branch',
);
assert.match(
  policyStatements.find((statement) => statement.includes('missions_select_b3')) ?? '',
  /status = 'available'[\s\S]*is_internal_user\(\)[\s\S]*external_convoyeurs_enabled\(\)/i,
  'available missions must remain behind the rollout gate',
);

for (const policy of policyStatements) {
  if (policy.includes('missions_select_b3') || policy.includes('convoyeur')) {
    assert.match(policy, /banned = false/i, 'assigned convoyeur access must reject banned profiles');
  }
}

assert.doesNotMatch(sql, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\.app_settings/i);
assert.doesNotMatch(sql, /ALTER POLICY "(?:candidatures|convoyeurs_insert_own|reseau_)/i);
assert.doesNotMatch(sql, /CREATE\s+POLICY|DROP\s+POLICY/i);
assert.doesNotMatch(sql, /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
assert.doesNotMatch(sql, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

const functionDefinitions = sql.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/gi) ?? [];
assert.equal(functionDefinitions.length, 6, 'exactly six workflow functions must be replaced');

for (const [name, signature] of expectedFunctions) {
  const definition = functionDefinitions.find((item) =>
    new RegExp(`FUNCTION public\\.${name}\\(`, 'i').test(item),
  );
  assert.ok(definition, `${name} must be replaced`);
  assert.match(definition, /SECURITY DEFINER/i, `${name} must remain SECURITY DEFINER`);
  assert.match(definition, /SET search_path TO ''/i, `${name} must keep an empty search_path`);
  assert.doesNotMatch(
    definition,
    /external_convoyeurs_enabled\(\)/i,
    `${name} must authorize by assignment ownership instead of the global flag`,
  );

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    sql,
    new RegExp(`ALTER FUNCTION public\\.${escapedName}\\(${escapedSignature}\\) OWNER TO postgres;`, 'i'),
    `${name} owner must remain postgres`,
  );
  assert.match(
    sql,
    new RegExp(
      `REVOKE EXECUTE ON FUNCTION public\\.${escapedName}\\(${escapedSignature}\\) FROM PUBLIC, anon, authenticated, service_role;`,
      'i',
    ),
    `${name} must lose implicit execute grants`,
  );
  assert.match(
    sql,
    new RegExp(
      `GRANT EXECUTE ON FUNCTION public\\.${escapedName}\\(${escapedSignature}\\) TO authenticated, service_role;`,
      'i',
    ),
    `${name} must retain the P3.5 allowlist`,
  );
}

const functionByName = (name) =>
  functionDefinitions.find((item) => item.includes(`FUNCTION public.${name}(`)) ?? '';

const assign = functionByName('admin_assign_mission');
assert.match(assign, /public\.is_admin\(\) OR public\.is_operator\(\)/);
assert.match(assign, /_current_status <> 'available'/);
assert.match(assign, /_convoyeur\.auth_user_id IS NULL OR coalesce\(_convoyeur\.banned, true\)/);
assert.match(assign, /FROM auth\.users u[\s\S]*u\.deleted_at IS NULL[\s\S]*u\.confirmed_at IS NOT NULL/);
assert.match(assign, /u\.banned_until IS NULL OR u\.banned_until <= now\(\)/);

const respond = functionByName('respond_mission_assignment');
assert.match(respond, /is_convoyeur_for_mission\(p_mission_id, _caller_user_id\)/);
assert.match(respond, /c\.banned = false/);
assert.match(respond, /_current_status <> 'assigned'/);
assert.match(respond, /p_accepted[\s\S]*status = 'accepted'/);
assert.match(respond, /convoyeur_id = NULL[\s\S]*status = 'available'/);

const transition = functionByName('transition_mission_status');
assert.match(transition, /_is_convoyeur :=[\s\S]*is_convoyeur_for_mission[\s\S]*c\.banned = false/);
assert.match(transition, /'assigned' AND p_target_status IN \('accepted', 'available'\)/);
assert.match(transition, /'accepted' AND p_target_status = 'in_progress'/);
assert.match(transition, /'in_progress' AND p_target_status = 'delivered'/);
assert.match(transition, /mission_has_valid_edl\(p_mission_id, 'depart'\)/);
assert.match(transition, /mission_has_valid_edl\(p_mission_id, 'arrivee'\)/);
assert.equal(
  (transition.match(/mission_has_valid_edl\(/gi) ?? []).length,
  2,
  'only departure and arrival transitions may require an EDL',
);

const edl = functionByName('validate_mission_edl');
assert.match(edl, /_convoyeur_auth IS DISTINCT FROM _caller_user_id/);
assert.match(edl, /coalesce\(_convoyeur_banned, true\)/);
assert.match(edl, /WHEN 'depart' THEN 'accepted' WHEN 'arrivee' THEN 'in_progress'/);
assert.match(edl, /_required_photos int := 5/);
assert.match(edl, /_obj\.owner IS DISTINCT FROM _caller_user_id/);
assert.match(edl, /p_edl_type = 'arrivee' AND _selfie < 1/);

for (const name of ['authorize_gps_session', 'record_gps_position']) {
  const gps = functionByName(name);
  assert.match(gps, /_status <> 'in_progress'/, `${name} must require an active mission`);
  assert.match(gps, /c\.id = _convoyeur[\s\S]*c\.auth_user_id = _caller_user_id[\s\S]*c\.banned = false/);
}

console.log('P4.2b assigned-convoyeur RLS and workflow checks passed.');
