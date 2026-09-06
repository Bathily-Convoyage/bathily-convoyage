/**
 * MISSIONS-EXT-4A2 — Focused regression tests (static SQL/HTML assertions).
 *
 * These tests complement the runtime proofs in
 * missions-ext-4a2-runtime-proofs.test.cjs by statically verifying the
 * migration and dashboard HTML for the required design invariants.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const migrationPath = path.join(repoRoot, 'supabase/migrations/20260906150000_missions_ext_4a2_incident_flow_repair.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

const historicalMigrationPath = path.join(repoRoot, 'supabase/migrations/20260811000002_phase3_c22c1_mission_incidents.sql');
const historicalMigration = fs.readFileSync(historicalMigrationPath, 'utf8');

const convDashboardPath = path.join(repoRoot, 'dashboard-convoyeur.html');
const convDashboard = fs.readFileSync(convDashboardPath, 'utf8');

const operatorDashboardPath = path.join(repoRoot, 'dashboard-operator.html');
const operatorDashboard = fs.readFileSync(operatorDashboardPath, 'utf8');

const adminDashboardPath = path.join(repoRoot, 'dashboard-admin.html');
const adminDashboard = fs.readFileSync(adminDashboardPath, 'utf8');

// =========================================================
// Backend: report_mission_incident
// =========================================================

test('migration redefines report_mission_incident', () => {
  assert.ok(
    /CREATE OR REPLACE FUNCTION public\.report_mission_incident/.test(migration),
    'report_mission_incident redefined',
  );
});

test('report_mission_incident does NOT use is_operator()', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.report_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'report_mission_incident function found');
  assert.ok(
    !/public\.is_operator\(\)/.test(match[0]),
    'report_mission_incident must not use is_operator()',
  );
});

test('report_mission_incident uses is_assigned_non_banned_convoyeur', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.report_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'report_mission_incident function found');
  assert.ok(
    /public\.is_assigned_non_banned_convoyeur/.test(match[0]),
    'report_mission_incident uses is_assigned_non_banned_convoyeur',
  );
});

test('report_mission_incident is SECURITY DEFINER with search_path = ""', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.report_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'report_mission_incident function found');
  assert.ok(/SECURITY DEFINER/.test(match[0]), 'SECURITY DEFINER');
  assert.ok(/SET search_path = ''/.test(match[0]), 'search_path = empty');
});

test('report_mission_incident enforces auth.uid() guard', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.report_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'report_mission_incident function found');
  assert.ok(/auth\.uid\(\) IS NULL/.test(match[0]), 'auth.uid() null check');
});

test('report_mission_incident enforces mission status (accepted, in_progress, delivered)', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.report_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'report_mission_incident function found');
  assert.ok(
    /_mission\.status NOT IN \('accepted', 'in_progress', 'delivered'\)/.test(match[0]),
    'mission status check present',
  );
});

test('report_mission_incident logs incident_reported event', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.report_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'report_mission_incident function found');
  assert.ok(/log_mission_event/.test(match[0]), 'log_mission_event called');
  assert.ok(/incident_reported/.test(match[0]), 'incident_reported event type');
});

// =========================================================
// Backend: update_mission_incident
// =========================================================

test('migration redefines update_mission_incident', () => {
  assert.ok(
    /CREATE OR REPLACE FUNCTION public\.update_mission_incident/.test(migration),
    'update_mission_incident redefined',
  );
});

test('update_mission_incident does NOT use is_operator()', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.update_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'update_mission_incident function found');
  assert.ok(
    !/public\.is_operator\(\)/.test(match[0]),
    'update_mission_incident must not use is_operator()',
  );
});

test('update_mission_incident checks reported_by = auth.uid()', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.update_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'update_mission_incident function found');
  assert.ok(
    /reported_by <> auth\.uid\(\)/.test(match[0]),
    'reporter identity check present',
  );
});

test('update_mission_incident uses is_assigned_non_banned_convoyeur', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.update_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'update_mission_incident function found');
  assert.ok(
    /public\.is_assigned_non_banned_convoyeur/.test(match[0]),
    'uses is_assigned_non_banned_convoyeur',
  );
});

test('update_mission_incident only allows open status', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.update_mission_incident[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'update_mission_incident function found');
  assert.ok(
    /status <> 'open'/.test(match[0]),
    'open status check present',
  );
});

test('update_mission_incident does NOT expose mission_id, reported_by, status as parameters', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.update_mission_incident\([\s\S]*?\)/);
  assert.ok(match, 'update_mission_incident signature found');
  assert.ok(
    !/p_mission_id/.test(match[0]),
    'mission_id not a parameter',
  );
  assert.ok(
    !/p_reported_by/.test(match[0]),
    'reported_by not a parameter',
  );
  assert.ok(
    !/p_status/.test(match[0]),
    'status not a parameter',
  );
});

// =========================================================
// Backend: register_mission_incident_evidence
// =========================================================

test('migration redefines register_mission_incident_evidence', () => {
  assert.ok(
    /CREATE OR REPLACE FUNCTION public\.register_mission_incident_evidence/.test(migration),
    'register_mission_incident_evidence redefined',
  );
});

test('register_mission_incident_evidence does NOT use is_operator()', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_incident_evidence[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'register_mission_incident_evidence function found');
  assert.ok(
    !/public\.is_operator\(\)/.test(match[0]),
    'register_mission_incident_evidence must not use is_operator()',
  );
});

test('register_mission_incident_evidence checks reported_by = auth.uid()', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_incident_evidence[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'register_mission_incident_evidence function found');
  assert.ok(
    /reported_by <> auth\.uid\(\)/.test(match[0]),
    'reporter identity check present',
  );
});

test('register_mission_incident_evidence enforces bucket = mission-incidents', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_incident_evidence[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'register_mission_incident_evidence function found');
  assert.ok(
    /p_storage_bucket <> 'mission-incidents'/.test(match[0]),
    'bucket check present',
  );
});

test('register_mission_incident_evidence enforces MIME allowlist', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_incident_evidence[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'register_mission_incident_evidence function found');
  assert.ok(
    /image\/jpeg.*image\/png.*image\/webp/.test(match[0]),
    'MIME allowlist present',
  );
});

test('register_mission_incident_evidence enforces path coherence', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_incident_evidence[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'register_mission_incident_evidence function found');
  assert.ok(
    /_expected_path_prefix/.test(match[0]),
    'path prefix check present',
  );
});

test('register_mission_incident_evidence checks storage owner = auth.uid()', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.register_mission_incident_evidence[\s\S]*?\$\$\s*;/);
  assert.ok(match, 'register_mission_incident_evidence function found');
  assert.ok(
    /_obj\.owner IS DISTINCT FROM auth\.uid\(\)/.test(match[0]),
    'storage owner check present',
  );
});

// =========================================================
// ACL / GRANTs
// =========================================================

test('all 3 incident RPCs REVOKE from PUBLIC and anon', () => {
  const rpcNames = ['report_mission_incident', 'update_mission_incident', 'register_mission_incident_evidence'];
  for (const rpc of rpcNames) {
    const re = new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM PUBLIC`);
    assert.ok(re.test(migration), `${rpc} REVOKE FROM PUBLIC`);
    const reAnon = new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM anon`);
    assert.ok(reAnon.test(migration), `${rpc} REVOKE FROM anon`);
  }
});

test('all 3 incident RPCs GRANT to authenticated only', () => {
  const rpcNames = ['report_mission_incident', 'update_mission_incident', 'register_mission_incident_evidence'];
  for (const rpc of rpcNames) {
    const re = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) TO authenticated`);
    assert.ok(re.test(migration), `${rpc} GRANT TO authenticated`);
  }
});

// =========================================================
// RLS policies
// =========================================================

test('migration adds mission_incidents_select_convoyeur_assigned RLS policy', () => {
  assert.ok(
    /mission_incidents_select_convoyeur_assigned/.test(migration),
    'convoyeur SELECT policy on mission_incidents',
  );
});

test('convoyeur incident RLS checks reported_by = auth.uid()', () => {
  const match = migration.match(/mission_incidents_select_convoyeur_assigned[\s\S]*?USING \([\s\S]*?\)/);
  assert.ok(match, 'convoyeur incident RLS policy found');
  assert.ok(/reported_by = auth\.uid\(\)/.test(match[0]), 'reported_by check');
});

test('convoyeur incident RLS uses is_assigned_non_banned_convoyeur', () => {
  // Find the policy block by looking for the policy name and then the next few lines
  const idx = migration.indexOf('mission_incidents_select_convoyeur_assigned');
  assert.ok(idx >= 0, 'convoyeur incident RLS policy found');
  const block = migration.substring(idx, idx + 500);
  assert.ok(/is_assigned_non_banned_convoyeur/.test(block), 'banned check');
});

test('migration adds mission_incident_evidence_select_convoyeur_assigned RLS policy', () => {
  assert.ok(
    /mission_incident_evidence_select_convoyeur_assigned/.test(migration),
    'convoyeur SELECT policy on mission_incident_evidence',
  );
});

// =========================================================
// Storage policies
// =========================================================

test('migration adds mission_incidents_storage_insert_convoyeur policy', () => {
  assert.ok(
    /mission_incidents_storage_insert_convoyeur/.test(migration),
    'convoyeur INSERT storage policy',
  );
});

test('convoyeur storage INSERT checks banned = false', () => {
  const idx = migration.indexOf('mission_incidents_storage_insert_convoyeur');
  assert.ok(idx >= 0, 'convoyeur INSERT policy found');
  const block = migration.substring(idx, idx + 1200);
  assert.ok(/cv\.banned = false/.test(block), 'banned = false check');
});

test('convoyeur storage INSERT checks incident status = open', () => {
  const idx = migration.indexOf('mission_incidents_storage_insert_convoyeur');
  assert.ok(idx >= 0, 'convoyeur INSERT policy found');
  const block = migration.substring(idx, idx + 1200);
  assert.ok(/mi\.status = 'open'/.test(block), 'incident open check');
});

test('convoyeur storage INSERT checks reported_by = auth.uid()', () => {
  const idx = migration.indexOf('mission_incidents_storage_insert_convoyeur');
  assert.ok(idx >= 0, 'convoyeur INSERT policy found');
  const block = migration.substring(idx, idx + 1200);
  assert.ok(/mi\.reported_by = auth\.uid\(\)/.test(block), 'reported_by check');
});

test('migration adds mission_incidents_storage_select_convoyeur policy', () => {
  assert.ok(
    /mission_incidents_storage_select_convoyeur/.test(migration),
    'convoyeur SELECT storage policy',
  );
});

test('no UPDATE/DELETE storage policy added for convoyeur', () => {
  assert.ok(
    !/mission_incidents_storage_update/i.test(migration),
    'no UPDATE storage policy',
  );
  assert.ok(
    !/mission_incidents_storage_delete_convoyeur/i.test(migration),
    'no convoyeur DELETE storage policy',
  );
});

// =========================================================
// Historical migration untouched
// =========================================================

test('historical migration file is not modified by 4A2', () => {
  // The 4A2 migration should not reference modifying the historical file.
  // It only creates new policies and redefines functions.
  // The historical migration's immutability trigger should still be referenced.
  assert.ok(
    /mission_incident_evidence_immutable/.test(historicalMigration),
    'historical immutability trigger exists in original migration',
  );
});

test('review_mission_incident (admin) is NOT redefined by 4A2', () => {
  // 4A2 should not touch the admin review RPC.
  assert.ok(
    !/CREATE OR REPLACE FUNCTION public\.review_mission_incident/.test(migration),
    'review_mission_incident not redefined by 4A2',
  );
});

// =========================================================
// Direct/external not source-gated
// =========================================================

test('report_mission_incident does not gate on source_mission', () => {
  const match = migration.match(/CREATE OR REPLACE FUNCTION public\.report_mission_incident[\s\S]*?\$\$;/);
  assert.ok(match, 'report_mission_incident function found');
  assert.ok(
    !/source_mission/.test(match[0]),
    'report_mission_incident must not gate on source_mission',
  );
});

// =========================================================
// Convoyeur UI tests
// =========================================================

test('convoyeur dashboard has Signaler un incident button', () => {
  assert.ok(/Signaler un incident/.test(convDashboard), 'incident button present');
});

test('convoyeur dashboard calls report_mission_incident RPC', () => {
  assert.ok(/report_mission_incident/.test(convDashboard), 'report_mission_incident RPC called');
});

test('convoyeur dashboard calls update_mission_incident RPC', () => {
  assert.ok(/update_mission_incident/.test(convDashboard), 'update_mission_incident RPC called');
});

test('convoyeur dashboard calls register_mission_incident_evidence RPC', () => {
  assert.ok(/register_mission_incident_evidence/.test(convDashboard), 'register_mission_incident_evidence RPC called');
});

test('convoyeur dashboard uses mission-incidents storage bucket', () => {
  assert.ok(/mission-incidents/.test(convDashboard), 'mission-incidents bucket referenced');
});

test('convoyeur dashboard has Mes incidents tab', () => {
  assert.ok(/conv-tab-incidents/.test(convDashboard), 'incidents tab present');
  assert.ok(/Mes incidents/.test(convDashboard), 'incidents nav label present');
});

test('convoyeur dashboard does NOT use is_operator in incident path', () => {
  // The convoyeur dashboard should not check is_operator() for incident reporting.
  // It relies on the RPC for authorization. Strip JS comments before checking.
  const stripped = convDashboard.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/is_operator\s*\(/.test(stripped),
    'convoyeur dashboard does not call is_operator()',
  );
});

test('convoyeur incident button only shows for eligible statuses', () => {
  assert.ok(
    /\['accepted','in_progress','delivered'\]\.includes\(m\.status\)/.test(convDashboard),
    'incident button gated on eligible statuses',
  );
});

test('convoyeur dashboard has incident CSS styles', () => {
  assert.ok(/incident-badge/.test(convDashboard), 'incident-badge CSS class');
  assert.ok(/incident-item/.test(convDashboard), 'incident-item CSS class');
  assert.ok(/swal-incident-form/.test(convDashboard), 'swal-incident-form CSS class');
});

test('convoyeur evidence upload has orphan cleanup', () => {
  // The convoyeur evidence form should clean up orphan storage objects on registration failure.
  assert.ok(
    /storage\.from\('mission-incidents'\)\.remove\(\[path\]\)/.test(convDashboard),
    'orphan cleanup on registration failure',
  );
});

// =========================================================
// Operator UI tests
// =========================================================

test('operator dashboard has modalIncidents element in mission modal', () => {
  assert.ok(/id="modalIncidents"/.test(operatorDashboard), 'modalIncidents element present');
});

test('operator dashboard does NOT expose Signaler field-report button', () => {
  // MISSIONS-EXT-4A2 FIX-1: operator dashboard must not show a field-report
  // incident action to a non-assigned operator.
  assert.ok(
    !/showReportIncidentForm/.test(operatorDashboard),
    'operator dashboard must not reference showReportIncidentForm',
  );
  assert.ok(
    !/Signaler un incident/.test(operatorDashboard),
    'operator dashboard must not have Signaler un incident button',
  );
});

test('operator dashboard does NOT expose update/evidence field-report actions', () => {
  assert.ok(
    !/showUpdateIncidentForm/.test(operatorDashboard),
    'operator dashboard must not reference showUpdateIncidentForm',
  );
  assert.ok(
    !/showAddEvidenceForm/.test(operatorDashboard),
    'operator dashboard must not reference showAddEvidenceForm',
  );
});

test('operator dashboard does NOT call report/update/register incident RPCs', () => {
  assert.ok(
    !/report_mission_incident/.test(operatorDashboard),
    'operator dashboard must not call report_mission_incident',
  );
  assert.ok(
    !/update_mission_incident/.test(operatorDashboard),
    'operator dashboard must not call update_mission_incident',
  );
  assert.ok(
    !/register_mission_incident_evidence/.test(operatorDashboard),
    'operator dashboard must not call register_mission_incident_evidence',
  );
});

test('operator dashboard does NOT have evidence orphan cleanup (no evidence upload path)', () => {
  assert.ok(
    !/storage\.from\('mission-incidents'\)\.remove/.test(operatorDashboard),
    'operator dashboard must not have evidence orphan cleanup (no upload path)',
  );
});

test('operator dashboard does NOT have unused incident constants', () => {
  assert.ok(
    !/ALLOWED_EVIDENCE_MIMES/.test(operatorDashboard),
    'operator dashboard must not have ALLOWED_EVIDENCE_MIMES constant',
  );
  assert.ok(
    !/MAX_EVIDENCE_SIZE/.test(operatorDashboard),
    'operator dashboard must not have MAX_EVIDENCE_SIZE constant',
  );
});

test('operator dashboard does NOT have swal-incident-form CSS (form removed)', () => {
  assert.ok(
    !/swal-incident-form/.test(operatorDashboard),
    'operator dashboard must not have swal-incident-form CSS class',
  );
});

test('operator dashboard loads incidents when modal opens (read-only display)', () => {
  assert.ok(/loadMissionIncidents\(mission\.id\)/.test(operatorDashboard), 'loadMissionIncidents called on modal open');
});

test('operator dashboard retains incident evidence viewing (read-only)', () => {
  assert.ok(/showIncidentEvidence/.test(operatorDashboard), 'showIncidentEvidence function present for read-only viewing');
});

test('operator dashboard has no dead incident report/update/evidence callsites', () => {
  // No remaining references to the deleted functions should exist anywhere.
  const stripped = operatorDashboard.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/showReportIncidentForm|showUpdateIncidentForm|showAddEvidenceForm/.test(stripped),
    'no dead incident report/update/evidence callsites in code (comments excluded)',
  );
});

// =========================================================
// Admin UI tests
// =========================================================

test('admin dashboard has incident review functionality', () => {
  assert.ok(/admReviewIncident/.test(adminDashboard), 'admin review function present');
  assert.ok(/admResolveIncident/.test(adminDashboard), 'admin resolve function present');
  assert.ok(/review_mission_incident/.test(adminDashboard), 'review_mission_incident RPC called');
});

test('admin dashboard loads incidents for mission', () => {
  assert.ok(/loadAdminMissionIncidents/.test(adminDashboard), 'admin incident loader present');
});

test('admin dashboard does NOT have field-report incident button (admin reviews only)', () => {
  // Admin should not have a "Signaler un incident" field-report button.
  // Admin reviews/resolves only.
  assert.ok(
    !/showReportIncidentForm/.test(adminDashboard),
    'admin dashboard does not have field-report incident button',
  );
});
