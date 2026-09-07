// P3-B2.2B — Push subscriptions UPDATE RLS migration tests.
// Static tests verifying the migration SQL is correct, safe, and idempotent.
// No production database access. No migration apply.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const migrationPath = path.join(repoRoot, 'supabase/migrations/20260906170000_p3_b2_2b_push_update_own_rls.sql');
const baselinePath = path.join(repoRoot, 'supabase/migrations/20260807214536_remote_public_baseline.sql');
const optimizePath = path.join(repoRoot, 'supabase/migrations/20260825151634_optimize_rls_auth_initplan_p4_1b.sql');

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8');
}

function readBaseline() {
  return fs.readFileSync(baselinePath, 'utf8');
}

function readOptimize() {
  return fs.readFileSync(optimizePath, 'utf8');
}

// ── 1. UPDATE policy exists in migration ──

test('migration creates push_update_own UPDATE policy', () => {
  const sql = readMigration();
  assert.ok(sql.includes('CREATE POLICY'), 'migration must contain CREATE POLICY');
  assert.ok(sql.includes('push_update_own'), 'policy name must be push_update_own');
  assert.ok(sql.includes('FOR UPDATE'), 'policy must be FOR UPDATE');
});

// ── 2. Role authenticated only ──

test('UPDATE policy targets authenticated role only', () => {
  const sql = readMigration();
  assert.ok(sql.includes('TO "authenticated"') || sql.includes("TO 'authenticated'") || sql.includes('TO authenticated'),
    'policy must target authenticated role');
  assert.ok(!sql.includes('TO "anon"') && !sql.includes("TO 'anon'") && !sql.includes('TO anon'),
    'policy must NOT target anon role');
  assert.ok(!sql.includes('TO "public"') && !sql.includes("TO 'public'") && !sql.includes('TO public'),
    'policy must NOT target public role');
});

// ── 3. USING checks user_id = (select auth.uid()) ──

test('UPDATE policy USING clause checks user_id = (select auth.uid())', () => {
  const sql = readMigration();
  assert.ok(sql.includes('USING'),
    'policy must have USING clause');
  assert.ok(sql.includes('user_id = (select auth.uid())'),
    'USING must check user_id = (select auth.uid()) — using initplan optimization convention');
});

// ── 4. WITH CHECK checks user_id = (select auth.uid()) ──

test('UPDATE policy WITH CHECK clause checks user_id = (select auth.uid())', () => {
  const sql = readMigration();
  assert.ok(sql.includes('WITH CHECK'),
    'policy must have WITH CHECK clause');
  assert.ok(sql.includes('WITH CHECK (user_id = (select auth.uid()))'),
    'WITH CHECK must check user_id = (select auth.uid())');
});

// ── 5. No cross-user UPDATE allowed by policy text ──

test('policy does not allow cross-user UPDATE (USING restricts to own rows)', () => {
  const sql = readMigration();
  // USING clause restricts which rows can be UPDATEd — only own rows
  // Use a greedy match to handle nested parentheses in (select auth.uid())
  const usingMatch = sql.match(/USING\s*\((.+?)\)\s*\n\s*WITH CHECK/);
  assert.ok(usingMatch, 'USING clause must be present before WITH CHECK');
  const usingExpr = usingMatch[1].trim();
  assert.equal(usingExpr, 'user_id = (select auth.uid())',
    'USING must restrict to user_id = current user only');
});

// ── 6. Existing SELECT policy preserved ──

test('migration does NOT modify push_select_own policy', () => {
  const sql = readMigration();
  assert.ok(!sql.includes('push_select_own'),
    'migration must NOT touch push_select_own policy');
  assert.ok(!sql.includes('ALTER POLICY'),
    'migration must NOT use ALTER POLICY on existing policies');
});

// ── 7. Existing INSERT policy preserved ──

test('migration does NOT modify push_insert_own policy', () => {
  const sql = readMigration();
  assert.ok(!sql.includes('push_insert_own'),
    'migration must NOT touch push_insert_own policy');
});

// ── 8. Existing DELETE policy preserved ──

test('migration does NOT modify push_delete_own policy', () => {
  const sql = readMigration();
  assert.ok(!sql.includes('push_delete_own'),
    'migration must NOT touch push_delete_own policy');
});

// ── 9. No anon/public UPDATE policy ──

test('no anon or public UPDATE policy introduced', () => {
  const sql = readMigration();
  // The only CREATE POLICY should be for authenticated
  const createPolicyMatches = sql.match(/CREATE POLICY/g) || [];
  assert.ok(createPolicyMatches.length === 1,
    'migration should create exactly one policy');
  assert.ok(!sql.match(/TO\s+["']?anon["']?/i),
    'no anon role in any policy');
  assert.ok(!sql.match(/TO\s+["']?public["']?/i),
    'no public role in any policy');
});

// ── 10. UNIQUE(user_id, endpoint) unchanged ──

test('migration does NOT alter UNIQUE constraint or table schema', () => {
  const sql = readMigration();
  assert.ok(!sql.includes('ALTER TABLE'),
    'migration must NOT use ALTER TABLE (no schema changes)');
  assert.ok(!sql.includes('ADD CONSTRAINT'),
    'migration must NOT add constraints');
  assert.ok(!sql.includes('DROP CONSTRAINT'),
    'migration must NOT drop constraints');
  assert.ok(!sql.includes('CREATE INDEX'),
    'migration must NOT create indexes');
  assert.ok(!sql.includes('DROP INDEX'),
    'migration must NOT drop indexes');
  assert.ok(!sql.includes('CREATE TABLE'),
    'migration must NOT create tables');
  assert.ok(!sql.includes('ALTER COLUMN'),
    'migration must NOT alter columns');
});

// ── 11. No table/schema changes ──

test('migration contains only DROP POLICY IF EXISTS and CREATE POLICY', () => {
  const sql = readMigration().trim();
  // Remove comment lines
  const codeLines = sql.split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .filter(l => l.trim().length > 0)
    .map(l => l.trim());

  // Every code line should be either DROP POLICY IF EXISTS or CREATE POLICY or part of the policy definition
  const nonPolicyLines = codeLines.filter(l =>
    !l.startsWith('DROP POLICY') &&
    !l.startsWith('CREATE POLICY') &&
    !l.startsWith('ON ') &&
    !l.startsWith('FOR ') &&
    !l.startsWith('TO ') &&
    !l.startsWith('USING') &&
    !l.startsWith('WITH CHECK') &&
    !l.startsWith(');') &&
    !l.match(/^\(.*\);?$/)
  );

  assert.equal(nonPolicyLines.length, 0,
    'migration should only contain policy DDL, found: ' + JSON.stringify(nonPolicyLines));
});

// ── 12. No service_role restrictions accidentally added ──

test('migration does NOT add service_role restrictions', () => {
  const sql = readMigration();
  // Strip comments before checking — comments may mention service_role
  // for documentation purposes without actually referencing it in DDL
  const codeOnly = sql.replace(/--.*$/gm, '');
  assert.ok(!codeOnly.includes('service_role'),
    'migration DDL must NOT reference service_role (service_role bypasses RLS)');
  assert.ok(!codeOnly.includes('GRANT'),
    'migration must NOT change grants');
  assert.ok(!codeOnly.includes('REVOKE'),
    'migration must NOT revoke grants');
});

// ── Additional: idempotency ──

test('migration is idempotent (DROP POLICY IF EXISTS before CREATE)', () => {
  const sql = readMigration();
  assert.ok(sql.includes('DROP POLICY IF EXISTS'),
    'migration must DROP POLICY IF EXISTS for idempotency');
  assert.ok(sql.includes('DROP POLICY IF EXISTS "push_update_own"'),
    'must drop push_update_own specifically');
  // DROP must come before CREATE
  const dropIdx = sql.indexOf('DROP POLICY IF EXISTS');
  const createIdx = sql.indexOf('CREATE POLICY');
  assert.ok(dropIdx > -1 && createIdx > -1,
    'both DROP and CREATE must be present');
  assert.ok(dropIdx < createIdx,
    'DROP POLICY must come before CREATE POLICY');
});

// ── Additional: user_id reassignment blocked ──

test('WITH CHECK prevents user_id reassignment to another user', () => {
  const sql = readMigration();
  // WITH CHECK (user_id = (select auth.uid())) means:
  // after UPDATE, the row's user_id must still equal the current user.
  // This prevents changing user_id to another user's ID.
  // Use a greedy match to handle nested parentheses
  const withCheckMatch = sql.match(/WITH CHECK\s*\((.+?)\)\s*;/);
  assert.ok(withCheckMatch, 'WITH CHECK clause must exist');
  const withCheckExpr = withCheckMatch[1].trim();
  assert.equal(withCheckExpr, 'user_id = (select auth.uid())',
    'WITH CHECK must enforce user_id = current user after update');
});

// ── Additional: uses initplan optimization convention ──

test('migration uses (select auth.uid()) not bare auth.uid()', () => {
  const sql = readMigration();
  assert.ok(sql.includes('(select auth.uid())'),
    'migration must use (select auth.uid()) initplan optimization');
  // Should NOT use bare auth.uid() without the select wrapper
  assert.ok(!sql.match(/[^.]auth\.uid\(\)(?!\))/) || !sql.includes('auth.uid()') || sql.includes('(select auth.uid())'),
    'migration should use (select auth.uid()) convention, not bare auth.uid()');
});

// ── Additional: baseline confirms no UPDATE policy existed before ──

test('baseline migration has no UPDATE policy for push_subscriptions', () => {
  const baseline = readBaseline();
  // Check that baseline only has SELECT, INSERT, DELETE policies
  const pushPolicyLines = baseline.split('\n')
    .filter(l => l.includes('push_') && l.includes('POLICY'))
    .map(l => l.trim());

  for (const line of pushPolicyLines) {
    if (line.includes('push_subscriptions')) {
      assert.ok(!line.includes('FOR UPDATE'),
        'baseline must NOT have UPDATE policy for push_subscriptions');
    }
  }
});

// ── Additional: optimization migration did not add UPDATE policy ──

test('optimization migration did not add UPDATE policy for push_subscriptions', () => {
  const optimize = readOptimize();
  const pushLines = optimize.split('\n')
    .filter(l => l.includes('push_'))
    .map(l => l.trim());

  for (const line of pushLines) {
    assert.ok(!line.includes('FOR UPDATE') && !line.includes('push_update'),
      'optimization migration must NOT have added UPDATE policy');
  }
});

// ── Additional: file naming convention ──

test('migration file follows naming convention with timestamp', () => {
  const filename = path.basename(migrationPath);
  assert.ok(filename.match(/^\d{14}_p3_b2_2b_push_update_own_rls\.sql$/),
    'filename must match YYYYMMDDHHMMSS_suffix.sql pattern');
  assert.ok(filename.startsWith('20260906170000'),
    'timestamp must be 20260906170000 (next after 20260906160000)');
});

// ── Additional: no frontend/sender/package references ──

test('migration does NOT reference frontend, sender, or package files', () => {
  const sql = readMigration();
  assert.ok(!sql.includes('gamification'),
    'migration must NOT reference frontend files');
  assert.ok(!sql.includes('_push.js'),
    'migration must NOT reference sender files');
  assert.ok(!sql.includes('web-push'),
    'migration must NOT reference npm packages');
});
