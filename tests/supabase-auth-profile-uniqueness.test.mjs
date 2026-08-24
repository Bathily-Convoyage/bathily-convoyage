import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260824134330_enforce_auth_profile_uniqueness.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

const checks = [
  ['migration is atomic', /^BEGIN;[\s\S]*COMMIT;\s*$/i],
  [
    'both profile tables are locked against a duplicate race',
    /LOCK TABLE public\.clients, public\.convoyeurs IN SHARE ROW EXCLUSIVE MODE;/i,
  ],
  [
    'clients duplicates are checked before index creation',
    /FROM public\.clients[\s\S]*WHERE auth_user_id IS NOT NULL[\s\S]*GROUP BY auth_user_id[\s\S]*HAVING count\(\*\) > 1[\s\S]*Cannot enforce clients\.auth_user_id uniqueness/i,
  ],
  [
    'convoyeurs duplicates are checked before index creation',
    /FROM public\.convoyeurs[\s\S]*WHERE auth_user_id IS NOT NULL[\s\S]*GROUP BY auth_user_id[\s\S]*HAVING count\(\*\) > 1[\s\S]*Cannot enforce convoyeurs\.auth_user_id uniqueness/i,
  ],
  ['duplicate preflights use unique-violation SQLSTATE', /USING ERRCODE = '23505';/i],
  [
    'clients has a partial unique index',
    /CREATE UNIQUE INDEX uq_clients_auth_user_id_not_null\s+ON public\.clients \(auth_user_id\)\s+WHERE auth_user_id IS NOT NULL;/i,
  ],
  [
    'convoyeurs has a partial unique index',
    /CREATE UNIQUE INDEX uq_convoyeurs_auth_user_id_not_null\s+ON public\.convoyeurs \(auth_user_id\)\s+WHERE auth_user_id IS NOT NULL;/i,
  ],
];

for (const [name, pattern] of checks) {
  assert.match(sql, pattern, name);
  console.log(`ok - ${name}`);
}

assert.equal(
  (sql.match(/USING ERRCODE = '23505';/gi) ?? []).length,
  2,
  'each profile table must have its own duplicate failure',
);
console.log('ok - each table has an explicit duplicate failure');

assert.doesNotMatch(sql, /ALTER\s+(?:TABLE|COLUMN)[\s\S]*SET NOT NULL/i, 'auth_user_id must stay nullable');
console.log('ok - auth_user_id remains nullable');

assert.doesNotMatch(sql, /CREATE\s+(?:OR REPLACE\s+)?(?:FUNCTION|TRIGGER)/i, 'migration must not add cross-table coupling');
console.log('ok - no cross-table trigger or function is introduced');

assert.doesNotMatch(sql, /CONCURRENTLY/i, 'transactional migration must not use CONCURRENTLY');
console.log('ok - index creation is transaction-compatible');

assert.doesNotMatch(sql, /DROP\s+(?:INDEX|CONSTRAINT)/i, 'existing indexes and constraints must remain untouched');
console.log('ok - existing indexes and constraints are preserved');

console.log(`\n${checks.length + 5}/${checks.length + 5} auth profile uniqueness checks passed`);
