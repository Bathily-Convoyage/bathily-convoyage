/**
 * MISSIONS-EXT-4A3 — Focused regression tests (static SQL/HTML assertions).
 *
 * Verifies the migration and admin dashboard HTML for the required
 * external billing isolation invariants.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const migrationPath = path.join(repoRoot, 'supabase/migrations/20260906160000_missions_ext_4a3_external_billing_isolation.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

const adminDashboardPath = path.join(repoRoot, 'dashboard-admin.html');
const adminDashboard = fs.readFileSync(adminDashboardPath, 'utf8');

// =========================================================
// Backend: prepare_billing_record source_mission guard
// =========================================================

test('migration redefines prepare_billing_record', () => {
  assert.ok(
    /CREATE OR REPLACE FUNCTION public\.prepare_billing_record/.test(migration),
    'prepare_billing_record redefined',
  );
});

test('prepare_billing_record is SECURITY DEFINER with search_path = ""', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'prepare_billing_record function found');
  assert.ok(/SECURITY DEFINER/.test(match[0]), 'SECURITY DEFINER');
  assert.ok(/SET search_path = ''/.test(match[0]), 'search_path = empty');
});

test('prepare_billing_record checks source_mission = direct', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'prepare_billing_record function found');
  assert.ok(
    /source_mission.*<>.*'direct'/.test(match[0]),
    'source_mission direct check present',
  );
});

test('prepare_billing_record source guard is before any INSERT', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'prepare_billing_record function found');
  const fnBody = match[0];
  const guardIdx = fnBody.indexOf("source_mission <> 'direct'");
  const insertIdx = fnBody.indexOf('INSERT INTO public.billing_records');
  assert.ok(guardIdx >= 0, 'source guard found');
  assert.ok(insertIdx >= 0, 'INSERT found');
  assert.ok(guardIdx < insertIdx, 'source guard is before INSERT (atomicity)');
});

test('prepare_billing_record preserves is_admin() auth check', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'prepare_billing_record function found');
  assert.ok(/public\.is_admin\(\)/.test(match[0]), 'is_admin() check preserved');
});

test('prepare_billing_record preserves auth.uid() check', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'prepare_billing_record function found');
  assert.ok(/v_actor_id uuid := auth\.uid\(\)/.test(match[0]), 'auth.uid() assignment preserved');
  assert.ok(/IF v_actor_id IS NULL THEN/.test(match[0]), 'auth null check preserved');
});

test('prepare_billing_record preserves FOR UPDATE lock', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'prepare_billing_record function found');
  assert.ok(/FOR UPDATE/.test(match[0]), 'FOR UPDATE lock preserved');
});

test('prepare_billing_record preserves duplicate active invoice guard', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'prepare_billing_record function found');
  assert.ok(/Une facture active existe déjà/.test(match[0]), 'duplicate invoice guard preserved');
});

test('prepare_billing_record preserves billing_event logging', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.prepare_billing_record[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'prepare_billing_record function found');
  assert.ok(/log_billing_event/.test(match[0]), 'log_billing_event preserved');
  assert.ok(/billing_record_created/.test(match[0]), 'billing_record_created event preserved');
});

// =========================================================
// ACL preservation
// =========================================================

test('prepare_billing_record REVOKE from PUBLIC and anon', () => {
  assert.ok(
    /REVOKE EXECUTE ON FUNCTION public\.prepare_billing_record\(uuid, text\) FROM PUBLIC, anon/.test(migration),
    'REVOKE FROM PUBLIC, anon',
  );
});

test('prepare_billing_record GRANT to authenticated only', () => {
  assert.ok(
    /GRANT EXECUTE ON FUNCTION public\.prepare_billing_record\(uuid, text\) TO authenticated/.test(migration),
    'GRANT TO authenticated',
  );
});

test('migration does NOT grant to anon', () => {
  assert.ok(
    !/GRANT EXECUTE ON FUNCTION public\.prepare_billing_record[^;]+TO anon/.test(migration),
    'no GRANT TO anon',
  );
});

// =========================================================
// Scope: no platform_fee, no margin formula change
// =========================================================

test('migration does NOT introduce platform_fee column or logic', () => {
  // Strip SQL comments before checking — the migration header explicitly
  // states "Does NOT introduce platform_fee" which would false-positive.
  const noComments = migration.replace(/^--[^\n]*$/gm, '');
  assert.ok(
    !/platform_fee/i.test(noComments),
    'no platform_fee introduced in executable SQL',
  );
});

test('migration does NOT change margin formula', () => {
  // The migration should not reference marge calculation or margin changes
  const noComments = migration.replace(/^--[^\n]*$/gm, '');
  assert.ok(
    !/marge\s*[:=]/i.test(noComments.replace(/v_mission\.marge/g, '')),
    'no margin formula change',
  );
});

test('migration does NOT modify link_external_invoice', () => {
  assert.ok(
    !/CREATE OR REPLACE FUNCTION public\.link_external_invoice/.test(migration),
    'link_external_invoice not modified',
  );
});

test('migration does NOT modify cancel_billing_record', () => {
  assert.ok(
    !/CREATE OR REPLACE FUNCTION public\.cancel_billing_record/.test(migration),
    'cancel_billing_record not modified',
  );
});

test('migration is forward-only (BEGIN/COMMIT)', () => {
  assert.ok(/BEGIN/.test(migration), 'BEGIN present');
  assert.ok(/COMMIT/.test(migration), 'COMMIT present');
});

// =========================================================
// Frontend: admin billing UI
// =========================================================

test('admin getEligibleMissions excludes external missions', () => {
  assert.ok(
    /source_mission.*&&.*source_mission.*!==.*'direct'/.test(adminDashboard),
    'getEligibleMissions filters out external missions',
  );
});

test('admin getEligibleMissions preserves completed status filter', () => {
  assert.ok(
    /m\.status !== 'completed'/.test(adminDashboard),
    'completed status filter preserved',
  );
});

test('admin getEligibleMissions preserves montant_ht > 0 filter', () => {
  assert.ok(
    /montant.*<= 0/.test(adminDashboard),
    'montant_ht > 0 filter preserved',
  );
});

test('admin getEligibleMissions preserves active invoice dedup', () => {
  assert.ok(
    /activeInvoiceMissionIds/.test(adminDashboard),
    'active invoice dedup preserved',
  );
});

test('admin dashboard still has prepareBilling action for direct missions', () => {
  assert.ok(/prepareBilling/.test(adminDashboard), 'prepareBilling function present');
  assert.ok(/prepare_billing_record/.test(adminDashboard), 'prepare_billing_record RPC called');
});

test('admin dashboard still has link_external_invoice for Indy flow', () => {
  assert.ok(/link_external_invoice/.test(adminDashboard), 'link_external_invoice RPC called');
});

test('admin dashboard still has cancel_billing_record', () => {
  assert.ok(/cancel_billing_record/.test(adminDashboard), 'cancel_billing_record RPC called');
});

// =========================================================
// Scope: settlement/expenses/incidents unchanged
// =========================================================

test('migration does NOT touch settlement fields', () => {
  // Strip comments — the header says "Does NOT touch settlement" which would false-positive.
  const noComments = migration.replace(/^--[^\n]*$/gm, '');
  assert.ok(
    !/paid_at|settlement/i.test(noComments),
    'no settlement/paid_at change in executable SQL',
  );
});

test('migration does NOT touch expenses', () => {
  const noComments = migration.replace(/^--[^\n]*$/gm, '');
  assert.ok(
    !/mission_expenses|create_mission_expense|update_mission_expense/.test(noComments),
    'no expense change in executable SQL',
  );
});

test('migration does NOT touch incidents', () => {
  const noComments = migration.replace(/^--[^\n]*$/gm, '');
  assert.ok(
    !/mission_incidents|report_mission_incident|update_mission_incident/.test(noComments),
    'no incident change in executable SQL',
  );
});
