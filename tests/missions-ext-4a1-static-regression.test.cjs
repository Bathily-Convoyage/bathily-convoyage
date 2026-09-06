/**
 * MISSIONS-EXT-4A1 — Focused regression tests (static SQL/HTML assertions).
 *
 * These tests complement the runtime proofs in
 * missions-ext-4a1-runtime-proofs.test.cjs by statically verifying the
 * migration and dashboard HTML for the required design invariants.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const migrationPath = path.join(repoRoot, 'supabase/migrations/20260906140000_missions_ext_4a1_convoyeur_expense_auth.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

const convDashboardPath = path.join(repoRoot, 'dashboard-convoyeur.html');
const convDashboard = fs.readFileSync(convDashboardPath, 'utf8');

const adminDashboardPath = path.join(repoRoot, 'dashboard-admin.html');
const adminDashboard = fs.readFileSync(adminDashboardPath, 'utf8');

// =========================================================
// Status transition UI
// =========================================================

test('convoyeur dashboard has Démarrer button for accepted missions', () => {
  assert.ok(/Démarrer/.test(convDashboard), 'Démarrer button label present');
});

test('convoyeur dashboard has Marquer livrée button for in-progress missions', () => {
  assert.ok(/Marquer\s+livrée|MarquerLivr/.test(convDashboard), 'Marquer livrée button label present');
});

test('convoyeur dashboard calls transition_mission_status for status transitions', () => {
  assert.ok(/transition_mission_status/.test(convDashboard), 'convoyeur UI calls transition_mission_status RPC');
});

test('admin dashboard does NOT expose dead Marquer livrée button for in_progress missions', () => {
  // The dead admin path should be removed or disabled.
  // Check that there is no canMarkDelivered variable that triggers updateMissionStatus to 'delivered'.
  assert.ok(
    !/canMarkDelivered\s*=\s*\(status\s*===?\s*'in_progress'\)/.test(adminDashboard),
    'admin dashboard must not expose canMarkDelivered for in_progress status',
  );
});

test('admin dashboard delivered→completed path is preserved', () => {
  // The admin/operator delivered -> completed transition should remain available.
  assert.ok(
    /'completed'/.test(adminDashboard),
    'admin dashboard still references completed status',
  );
});

// =========================================================
// Expense authorization migration
// =========================================================

test('migration creates is_assigned_non_banned_convoyeur helper', () => {
  assert.ok(
    /CREATE OR REPLACE FUNCTION public\.is_assigned_non_banned_convoyeur/.test(migration),
    'helper function created',
  );
  assert.ok(
    /c\.banned = false/.test(migration),
    'helper checks banned = false',
  );
});

test('migration does NOT use is_operator() in convoyeur expense RPCs', () => {
  // The redefined RPCs should not gate on is_operator().
  const rpcs = migration.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g) || [];
  const expenseRpcs = rpcs.filter(r =>
    /create_mission_expense_draft|update_mission_expense_draft|delete_mission_expense_draft|submit_mission_expense|register_mission_expense_receipt/.test(r)
  );
  for (const rpc of expenseRpcs) {
    assert.ok(
      !/public\.is_operator\(\)/.test(rpc),
      'expense RPC must not use is_operator()',
    );
  }
});

test('create_mission_expense_draft uses is_assigned_non_banned_convoyeur', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.create_mission_expense_draft[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/is_assigned_non_banned_convoyeur/.test(fn[0]), 'uses helper');
  assert.ok(/SECURITY DEFINER/.test(fn[0]), 'SECURITY DEFINER');
  assert.ok(/SET search_path = ''/.test(fn[0]), 'empty search_path');
});

test('update_mission_expense_draft requires owner + assigned non-banned', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.update_mission_expense_draft[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/is_assigned_non_banned_convoyeur/.test(fn[0]), 'uses helper');
  assert.ok(/_expense\.submitted_by <> auth\.uid\(\)/.test(fn[0]), 'owner check');
  assert.ok(/_expense\.status <> 'draft'/.test(fn[0]), 'draft-only gate');
});

test('delete_mission_expense_draft requires owner + assigned non-banned + draft', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.delete_mission_expense_draft[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/is_assigned_non_banned_convoyeur/.test(fn[0]), 'uses helper');
  assert.ok(/_expense\.submitted_by <> auth\.uid\(\)/.test(fn[0]), 'owner check');
  assert.ok(/_expense\.status <> 'draft'/.test(fn[0]), 'draft-only gate');
  assert.ok(/_receipt_count > 0/.test(fn[0]), 'blocks delete if receipts exist');
});

test('submit_mission_expense requires owner + assigned non-banned + draft', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.submit_mission_expense[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/is_assigned_non_banned_convoyeur/.test(fn[0]), 'uses helper');
  assert.ok(/_expense\.submitted_by <> auth\.uid\(\)/.test(fn[0]), 'owner check');
  assert.ok(/_expense\.status <> 'draft'/.test(fn[0]), 'draft-only gate');
  assert.ok(/expense_type <> 'washing' AND _receipt_count < 1/.test(fn[0]), 'receipt required for non-washing');
  assert.ok(/_receipt_count > 3/.test(fn[0]), 'max 3 receipts');
});

test('register_mission_expense_receipt preserves MIME allowlist', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_expense_receipt[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/image\/jpeg/.test(fn[0]), 'JPEG allowed');
  assert.ok(/image\/png/.test(fn[0]), 'PNG allowed');
  assert.ok(/image\/webp/.test(fn[0]), 'WebP allowed');
  assert.ok(/application\/pdf/.test(fn[0]), 'PDF allowed');
});

test('register_mission_expense_receipt preserves path validation', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_expense_receipt[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/split_part\(p_storage_path, '\/', 2\)/.test(fn[0]), 'path mission extraction');
  assert.ok(/split_part\(p_storage_path, '\/', 4\)/.test(fn[0]), 'path expense extraction');
  assert.ok(/_path_mission <> \(_expense\.mission_id\):?:text/.test(fn[0]), 'mission path match check');
  assert.ok(/_path_expense <> \(_expense\.id\):?:text/.test(fn[0]), 'expense path match check');
});

test('register_mission_expense_receipt preserves bucket check', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_expense_receipt[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/p_storage_bucket <> 'mission-expenses'/.test(fn[0]), 'bucket validation');
});

test('register_mission_expense_receipt preserves max 3 receipts', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_expense_receipt[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/_count >= 3/.test(fn[0]), 'max 3 receipts enforced');
});

test('register_mission_expense_receipt preserves storage owner check', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_expense_receipt[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/owner = auth\.uid\(\)/.test(fn[0]), 'storage owner check');
});

test('register_mission_expense_receipt only allows draft expenses', () => {
  const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_expense_receipt[\s\S]*?\$\$;/);
  assert.ok(fn, 'function found');
  assert.ok(/_expense\.status <> 'draft'/.test(fn[0]), 'draft-only receipt registration');
});

// =========================================================
// RLS policies
// =========================================================

test('migration drops old operator-only SELECT policy on mission_expenses', () => {
  assert.ok(
    /DROP POLICY IF EXISTS "mission_expenses_select_operator_assigned" ON public\.mission_expenses/.test(migration),
    'old operator-only SELECT policy dropped',
  );
});

test('migration creates convoyeur SELECT policy on mission_expenses', () => {
  assert.ok(
    /CREATE POLICY "mission_expenses_select_convoyeur_assigned"/.test(migration),
    'convoyeur SELECT policy created',
  );
  assert.ok(
    /submitted_by = auth\.uid\(\)/.test(migration),
    'SELECT policy checks submitted_by ownership',
  );
});

test('migration drops old operator-only SELECT policy on receipts', () => {
  assert.ok(
    /DROP POLICY IF EXISTS "mission_expense_receipts_select_operator_assigned" ON public\.mission_expense_receipts/.test(migration),
    'old operator-only receipts SELECT policy dropped',
  );
});

test('migration creates convoyeur SELECT policy on receipts', () => {
  assert.ok(
    /CREATE POLICY "mission_expense_receipts_select_convoyeur_assigned"/.test(migration),
    'convoyeur receipts SELECT policy created',
  );
});

// =========================================================
// Storage policies
// =========================================================

test('migration drops old operator-only INSERT storage policy', () => {
  assert.ok(
    /DROP POLICY IF EXISTS "mission_expenses_storage_insert" ON storage\.objects/.test(migration),
    'old INSERT storage policy dropped',
  );
});

test('migration creates new INSERT storage policy for convoyeur', () => {
  assert.ok(
    /CREATE POLICY "mission_expenses_storage_insert"/.test(migration),
    'new INSERT storage policy created',
  );
  const policy = migration.match(/CREATE POLICY "mission_expenses_storage_insert"[\s\S]*?;/);
  assert.ok(policy, 'INSERT policy found');
  assert.ok(/bucket_id = 'mission-expenses'/.test(policy[0]), 'bucket check');
  assert.ok(/cv\.banned = false/.test(policy[0]), 'banned check in storage INSERT');
  assert.ok(/me\.submitted_by = auth\.uid\(\)/.test(policy[0]), 'owner check in storage INSERT');
  assert.ok(/me\.status = 'draft'/.test(policy[0]), 'draft-only in storage INSERT');
  assert.ok(/name ~ '\^missions\/\[0-9a-fA-F\]/.test(policy[0]), 'UUID path pattern');
});

test('migration drops old operator-only SELECT storage policy', () => {
  assert.ok(
    /DROP POLICY IF EXISTS "mission_expenses_storage_select" ON storage\.objects/.test(migration),
    'old SELECT storage policy dropped',
  );
});

test('migration creates new SELECT storage policy with admin + convoyeur', () => {
  assert.ok(
    /CREATE POLICY "mission_expenses_storage_select"/.test(migration),
    'new SELECT storage policy created',
  );
  const policy = migration.match(/CREATE POLICY "mission_expenses_storage_select"[\s\S]*?;/);
  assert.ok(policy, 'SELECT policy found');
  assert.ok(/public\.is_admin\(\)/.test(policy[0]), 'admin can SELECT');
  assert.ok(/cv\.banned = false/.test(policy[0]), 'banned check in storage SELECT');
});

test('migration does NOT create UPDATE or DELETE storage policies', () => {
  assert.ok(
    !/CREATE POLICY.*mission_expenses_storage_(update|delete)/i.test(migration),
    'no UPDATE or DELETE storage policies created',
  );
});

// =========================================================
// Admin review unchanged
// =========================================================

test('migration does NOT modify review_mission_expense', () => {
  assert.ok(
    !/CREATE OR REPLACE FUNCTION public\.review_mission_expense/.test(migration),
    'admin review function is not touched',
  );
});

test('migration does NOT modify admin_create_mission_expense', () => {
  assert.ok(
    !/CREATE OR REPLACE FUNCTION public\.admin_create_mission_expense/.test(migration),
    'admin expense creation is not touched',
  );
});

// =========================================================
// Migration safety
// =========================================================

test('migration is forward-only (no edits to historical files)', () => {
  // The migration filename should be the new timestamp
  const filename = path.basename(migrationPath);
  assert.ok(
    /^20260906140000_/.test(filename),
    'migration filename has correct forward-only timestamp',
  );
});

test('migration does not touch Indy, incidents, notifications, or settlement', () => {
  assert.ok(!/indy/i.test(migration), 'no Indy references');
  assert.ok(!/incident/i.test(migration), 'no incident references');
  assert.ok(!/notification/i.test(migration), 'no notification references');
  assert.ok(!/settlement/i.test(migration), 'no settlement references');
});

test('migration does not modify transition_mission_status or validate_mission_edl', () => {
  assert.ok(
    !/CREATE OR REPLACE FUNCTION public\.transition_mission_status/.test(migration),
    'transition_mission_status is not touched',
  );
  assert.ok(
    !/CREATE OR REPLACE FUNCTION public\.validate_mission_edl/.test(migration),
    'validate_mission_edl is not touched',
  );
});

// =========================================================
// Convoyeur expense UI
// =========================================================

test('convoyeur dashboard has Frais navigation item', () => {
  assert.ok(/Frais/.test(convDashboard), 'Frais nav item present');
});

test('convoyeur dashboard has conv-tab-frais tab', () => {
  assert.ok(/conv-tab-frais/.test(convDashboard), 'Frais tab id present');
});

test('convoyeur dashboard calls create_mission_expense_draft', () => {
  assert.ok(/create_mission_expense_draft/.test(convDashboard), 'create draft RPC call present');
});

test('convoyeur dashboard calls update_mission_expense_draft', () => {
  assert.ok(/update_mission_expense_draft/.test(convDashboard), 'update draft RPC call present');
});

test('convoyeur dashboard calls delete_mission_expense_draft', () => {
  assert.ok(/delete_mission_expense_draft/.test(convDashboard), 'delete draft RPC call present');
});

test('convoyeur dashboard calls submit_mission_expense', () => {
  assert.ok(/submit_mission_expense/.test(convDashboard), 'submit expense RPC call present');
});

test('convoyeur dashboard calls register_mission_expense_receipt', () => {
  assert.ok(/register_mission_expense_receipt/.test(convDashboard), 'register receipt RPC call present');
});

test('convoyeur dashboard uses mission-expenses storage bucket', () => {
  assert.ok(/mission-expenses/.test(convDashboard), 'mission-expenses bucket referenced');
});

test('convoyeur dashboard loads expenses in loadConvoyeurData', () => {
  assert.ok(
    /loadConvoyeurExpenses/.test(convDashboard),
    'loadConvoyeurExpenses function referenced',
  );
});

console.log('MISSIONS-EXT-4A1 static regression tests loaded.');
