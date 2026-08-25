import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260825204354_enforce_auth_role_separation_p4_2.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');
const normalized = sql.replace(/\s+/g, ' ').trim();

const checks = [
  ['migration is atomic', /^BEGIN;[\s\S]*COMMIT;\s*$/i],
  ['migration has a short lock timeout', /SET LOCAL lock_timeout = '5s';/i],
  ['migration has a bounded statement timeout', /SET LOCAL statement_timeout = '30s';/i],
  [
    'all identity tables are locked together',
    /LOCK TABLE public\.clients,[\s\S]*public\.convoyeurs,[\s\S]*public\.internal_operators,[\s\S]*public\.user_roles[\s\S]*IN SHARE ROW EXCLUSIVE MODE;/i,
  ],
  [
    'dependency tables are protected during the empty-profile check',
    /LOCK TABLE public\.candidatures,[\s\S]*public\.missions,[\s\S]*public\.support_tickets[\s\S]*IN SHARE MODE;/i,
  ],
  [
    'dedicated convoyeur Auth user is pinned by stable id',
    /target_auth_user_id CONSTANT uuid := '[0-9a-f-]{36}';/i,
  ],
  [
    'dedicated Auth user must be confirmed',
    /count\(\*\) FILTER \(WHERE u\.confirmed_at IS NOT NULL\)[\s\S]*target_confirmed_count <> 1/i,
  ],
  [
    'clean local databases install schema guards without Production data',
    /IF target_count = 0 THEN[\s\S]*applying schema guards only[\s\S]*RETURN;/i,
  ],
  [
    'target account must be free of every existing role',
    /FROM public\.clients c WHERE c\.auth_user_id = target_auth_user_id[\s\S]*FROM public\.convoyeurs v WHERE v\.auth_user_id = target_auth_user_id[\s\S]*FROM public\.internal_operators o WHERE o\.user_id = target_auth_user_id[\s\S]*FROM public\.user_roles r WHERE r\.user_id = target_auth_user_id/i,
  ],
  [
    'real profile is identified through both admin sources',
    /FROM public\.convoyeurs v[\s\S]*FROM public\.clients c[\s\S]*c\.role = 'admin'[\s\S]*FROM public\.user_roles r[\s\S]*r\.role = 'admin'/i,
  ],
  [
    'real profile must retain mission history',
    /FROM public\.missions m WHERE m\.convoyeur_id = real_profile_id[\s\S]*refuses to transfer an admin-linked profile without mission history/i,
  ],
  [
    'operator profile is identified through both operator sources',
    /FROM public\.internal_operators o WHERE o\.user_id = v\.auth_user_id[\s\S]*FROM public\.user_roles r[\s\S]*r\.role = 'operator'/i,
  ],
  [
    'operator profile deletion is blocked by every foreign-key dependency',
    /FROM public\.missions m WHERE m\.convoyeur_id = empty_operator_profile_id[\s\S]*FROM public\.candidatures c WHERE c\.convoyeur_id = empty_operator_profile_id[\s\S]*FROM public\.support_tickets s WHERE s\.convoyeur_id = empty_operator_profile_id[\s\S]*refuses to remove an operator-linked profile with dependencies/i,
  ],
  [
    'real profile id is preserved while Auth owner and email change',
    /UPDATE public\.convoyeurs[\s\S]*SET auth_user_id = target_auth_user_id,[\s\S]*email = target_email,[\s\S]*WHERE id = real_profile_id;/i,
  ],
  [
    'only the empty operator profile is deleted',
    /DELETE FROM public\.convoyeurs[\s\S]*WHERE id = empty_operator_profile_id;/i,
  ],
  [
    'guard function has an empty search path',
    /CREATE OR REPLACE FUNCTION public\.enforce_auth_role_separation\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path TO ''/i,
  ],
  [
    'guard serializes concurrent assignments per Auth user',
    /pg_catalog\.pg_advisory_xact_lock\([\s\S]*pg_catalog\.hashtextextended\(checked_user_id::text, 42002\)/i,
  ],
  [
    'guard function is trigger-only',
    /REVOKE EXECUTE ON FUNCTION public\.enforce_auth_role_separation\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role;/i,
  ],
];

for (const [name, pattern] of checks) {
  assert.match(sql, pattern, name);
  console.log(`ok - ${name}`);
}

const triggerTables = ['clients', 'convoyeurs', 'internal_operators', 'user_roles'];
for (const table of triggerTables) {
  assert.match(
    sql,
    new RegExp(
      `CREATE TRIGGER trg_enforce_auth_role_separation_${table}[\\s\\S]*ON public\\.${table}[\\s\\S]*EXECUTE FUNCTION public\\.enforce_auth_role_separation\\(\\);`,
      'i',
    ),
    `${table} must enforce cross-role separation`,
  );
  console.log(`ok - ${table} has a role-separation trigger`);
}

assert.equal(
  (sql.match(/DELETE FROM public\.convoyeurs/gi) ?? []).length,
  1,
  'exactly one convoyeur delete statement is allowed',
);
console.log('ok - exactly one convoyeur delete is present');

assert.doesNotMatch(
  sql,
  /DELETE FROM (?:auth\.users|public\.(?:clients|internal_operators|user_roles|missions|candidatures|support_tickets))/i,
  'no Auth account, role, mission or dependency row may be deleted',
);
console.log('ok - protected Auth, role and history tables are never deleted');

assert.doesNotMatch(
  sql,
  /(?:INSERT INTO|UPDATE) public\.(?:missions|mission_events|mission_evidence|candidatures|support_tickets)/i,
  'mission history and dependency rows must remain untouched',
);
console.log('ok - mission history and dependency rows remain untouched');

assert.doesNotMatch(
  sql,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  'no email address must be committed in the data migration',
);
console.log('ok - email is resolved from Auth instead of committed');

assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.enforce_auth_role_separation/i);
console.log('ok - trigger guard has no client-callable grant');

assert.doesNotMatch(sql, /SET\s+NOT\s+NULL/i, 'nullable onboarding links remain supported');
console.log('ok - nullable onboarding links remain supported');

console.log(`\n${checks.length + triggerTables.length + 6}/${checks.length + triggerTables.length + 6} P4.2 role-separation checks passed`);
