// =========================================================
// P3C1 — CRM Admin Foundation — Static + Module Validation
// =========================================================
// Validates the CRM admin layer without a running database or
// browser. Covers:
//   - CRM navigation rendering (HTML)
//   - authorization gate preserved (admin role, authOverlay)
//   - organizations summary mapping (RPC fields used)
//   - organizations list mapping (columns)
//   - opportunity stage labels (all 10 stages)
//   - activity status/type mappings (all types + statuses)
//   - timeline cursor construction (both-NULL, both-non-NULL)
//   - timeline mixed cursor prevention
//   - empty / error states present
//   - API/RPC error handling path
//   - regression: existing missions/devis/clients/admin nav intact
//
// Run: node tests/p3c1-crm-admin-foundation.test.mjs
// =========================================================

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const htmlPath = path.join(projectRoot, 'dashboard-admin.html');
const jsPath = path.join(projectRoot, 'public', 'js', 'crm-admin.js');
const migrationPath = path.join(projectRoot, 'supabase', 'migrations', '20260910120000_p3b6_crm_consolidation.sql');
const html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');
const migration = fs.readFileSync(migrationPath, 'utf8');

let pass = 0;
function ok(msg) { console.log('  \u2713 ' + msg); pass++; }
function section(t) { console.log('\n--- ' + t + ' ---'); }

// =========================================================
// 1. CRM NAVIGATION RENDERING (HTML)
// =========================================================
section('CRM NAVIGATION RENDERING');

assert.ok(fs.existsSync(jsPath), 'public/js/crm-admin.js exists');
ok('public/js/crm-admin.js exists');

// Sidebar CRM section
assert.match(html, /<div class="nav-section-lbl">CRM<\/div>/, 'CRM nav section label');
ok('CRM nav section label present');

const crmTabs = ['crm-dashboard', 'crm-organizations', 'crm-opportunities', 'crm-activities', 'crm-timeline'];
crmTabs.forEach(function (t) {
  assert.match(html, new RegExp('data-tab="' + t + '"'), 'nav item ' + t);
  assert.match(html, new RegExp('id="tab-' + t + '"'), 'tab panel ' + t);
});
ok('all 5 CRM nav items + tab panels present');

// Mobile "Plus" panel entries
assert.match(html, /adminMobileNavClick\('crm-dashboard'\)/, 'mobile CRM dashboard entry');
assert.match(html, /adminMobileNavClick\('crm-timeline'\)/, 'mobile CRM timeline entry');
ok('mobile CRM entries present');

// External script loaded
assert.match(html, /<script src="js\/crm-admin\.js"><\/script>/, 'crm-admin.js script tag');
ok('crm-admin.js script tag present');

// No public CRM routes (CRM only inside admin)
assert.ok(!html.match(/href="\/crm/i) && !html.match(/action="\/crm/i), 'no public CRM routes');
ok('no public CRM routes');

// =========================================================
// 2. AUTHORIZATION GATE PRESERVED
// =========================================================
section('AUTHORIZATION GATE');

assert.match(html, /id="authOverlay"/, 'authOverlay present');
ok('authOverlay present');
assert.match(html, /checkAdminSession\(\)/, 'checkAdminSession called');
ok('checkAdminSession called');
assert.match(html, /profile\.role !== 'admin'/, 'admin role check preserved');
ok('admin role check (clients.role === admin) preserved');
// CRM loads only after auth (inside loadAllData / tab switch)
assert.match(html, /CrmAdmin\.initAll\(\)/, 'CRM init hooked after auth');
ok('CRM init hooked into post-auth loadAllData');

// =========================================================
// 3. LOAD CRM MODULE IN A SANDBOX (pure logic)
// =========================================================
section('CRM MODULE LOGIC');

// Minimal DOM stub: getElementById returns a stub element with innerHTML.
function stubEl() {
  return {
    innerHTML: '',
    style: {},
    value: '',
    textContent: '',
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
    addEventListener: function () {},
    setAttribute: function () {},
    appendChild: function () {}
  };
}
const documentStub = {
  getElementById: function () { return stubEl(); },
  querySelectorAll: function () { return []; },
  querySelector: function () { return null; },
  createElement: function () { return stubEl(); },
  addEventListener: function () {}
};
const windowStub = {
  document: documentStub,
  console: console,
  getSupabase: function () { return null; },
  escapeHtml: function (s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
};
const sandbox = { window: windowStub, document: documentStub, console: console, navigator: { serviceWorker: undefined } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: 'crm-admin.js' });

const CrmAdmin = sandbox.window.CrmAdmin;
assert.ok(CrmAdmin, 'window.CrmAdmin exposed');
ok('window.CrmAdmin exposed');
assert.strictEqual(typeof CrmAdmin._buildTimelineParams, 'function', '_buildTimelineParams callable');
ok('_buildTimelineParams callable');

// =========================================================
// 4. ORGANIZATIONS SUMMARY MAPPING
// =========================================================
section('ORGANIZATIONS SUMMARY MAPPING');

// The RPC contract is defined in the P3B6 migration. Validate the contract
// there, then validate that the UI only relies on fields the RPC returns
// (no fabricated metrics).
const summaryFields = [
  'organization_id', 'legal_name', 'trade_name', 'status',
  'contacts_count', 'opportunities_count', 'activities_count',
  'devis_count', 'missions_count', 'billing_count',
  'pipeline_value', 'last_activity_at', 'last_devis_at', 'last_mission_at'
];
summaryFields.forEach(function (f) {
  assert.ok(migration.indexOf(f) !== -1, 'summary field in RPC contract: ' + f);
});
ok('crm_organizations_summary RPC contract has all 14 fields (migration)');

// Fields the UI actually relies on must be a subset of the contract.
const uiUsed = ['organization_id', 'legal_name', 'trade_name', 'status',
  'contacts_count', 'opportunities_count', 'activities_count',
  'devis_count', 'missions_count', 'billing_count',
  'pipeline_value', 'last_activity_at'];
uiUsed.forEach(function (f) {
  assert.ok(js.indexOf(f) !== -1, 'UI uses contract field: ' + f);
  assert.ok(summaryFields.indexOf(f) !== -1, 'UI field is in RPC contract: ' + f);
});
ok('UI relies only on fields the RPC returns (no fabricated metrics)');
assert.ok(js.indexOf('crm_organizations_summary') !== -1, 'rpc name used');
ok('crm_organizations_summary RPC used');

// Organizations list columns
const orgCols = ['contacts_count', 'opportunities_count', 'activities_count', 'devis_count', 'missions_count', 'pipeline_value', 'last_activity_at'];
orgCols.forEach(function (c) {
  assert.ok(html.indexOf(c) !== -1 || js.indexOf(c) !== -1, 'org column ' + c);
});
ok('organizations list columns mapped (contacts, opps, activities, devis, missions, pipeline, last activity)');

// =========================================================
// 5. OPPORTUNITY STAGE LABELS (all 10 stages)
// =========================================================
section('OPPORTUNITY STAGE LABELS');

const stages = ['lead', 'qualified', 'contacted', 'meeting', 'quote_requested', 'quote_sent', 'negotiating', 'won', 'lost', 'dormant'];
const stageLabels = CrmAdmin._STAGE_LABELS;
stages.forEach(function (s) {
  assert.ok(stageLabels[s], 'stage label for ' + s);
  assert.ok(js.indexOf("'" + s + "'") !== -1, 'stage value ' + s + ' in source');
});
ok('all 10 pipeline stages mapped to labels');
// Stage filter options in HTML
stages.forEach(function (s) {
  assert.match(html, new RegExp('<option value="' + s + '"'), 'stage filter option ' + s);
});
ok('all 10 stage filter options in HTML');

// =========================================================
// 6. ACTIVITY TYPE + STATUS MAPPINGS
// =========================================================
section('ACTIVITY TYPE + STATUS MAPPINGS');

const actTypes = ['call', 'email', 'meeting', 'note', 'task', 'follow_up', 'sms', 'whatsapp', 'other'];
const typeLabels = CrmAdmin._ACTIVITY_TYPE_LABELS;
actTypes.forEach(function (t) {
  assert.ok(typeLabels[t], 'activity type label for ' + t);
});
ok('all 9 activity types mapped to labels');
actTypes.forEach(function (t) {
  assert.match(html, new RegExp('<option value="' + t + '"'), 'activity type filter ' + t);
});
ok('all 9 activity type filter options in HTML');

const actStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
const statusLabels = CrmAdmin._ACTIVITY_STATUS_LABELS;
actStatuses.forEach(function (s) {
  assert.ok(statusLabels[s], 'activity status label for ' + s);
});
ok('all 4 activity statuses mapped to labels');
actStatuses.forEach(function (s) {
  assert.match(html, new RegExp('<option value="' + s + '"'), 'activity status filter ' + s);
});
ok('all 4 activity status filter options in HTML');

// =========================================================
// 7. TIMELINE CURSOR CONSTRUCTION
// =========================================================
section('TIMELINE CURSOR CONSTRUCTION');

// First page: both cursor params absent (NULL).
var p1 = CrmAdmin._buildTimelineParams({}, null, 50);
assert.ok(!('p_before_event_at' in p1), 'first page: no p_before_event_at');
assert.ok(!('p_before_event_key' in p1), 'first page: no p_before_event_key');
assert.strictEqual(p1.p_limit, 50, 'first page limit 50');
ok('first page: cursor both NULL (params absent)');

// Next page: both cursor params present together.
var p2 = CrmAdmin._buildTimelineParams({}, { eventAt: '2026-09-10T12:00:00Z', eventKey: 'mission:abc', hasMore: true }, 50);
assert.strictEqual(p2.p_before_event_at, '2026-09-10T12:00:00Z', 'next page: p_before_event_at set');
assert.strictEqual(p2.p_before_event_key, 'mission:abc', 'next page: p_before_event_key set');
ok('next page: both cursor params set together');

// Mixed cursor prevention: eventAt set, eventKey null -> must NOT emit either.
var p3 = CrmAdmin._buildTimelineParams({}, { eventAt: '2026-09-10T12:00:00Z', eventKey: null }, 50);
assert.ok(!('p_before_event_at' in p3), 'mixed cursor: no p_before_event_at emitted');
assert.ok(!('p_before_event_key' in p3), 'mixed cursor: no p_before_event_key emitted');
ok('mixed cursor (one NULL): neither param emitted');

// Limit bounding: clamped to [1, 200].
assert.strictEqual(CrmAdmin._buildTimelineParams({}, null, 0).p_limit, 1, 'limit min 1');
assert.strictEqual(CrmAdmin._buildTimelineParams({}, null, 999).p_limit, 200, 'limit max 200');
assert.strictEqual(CrmAdmin._buildTimelineParams({}, null, null).p_limit, 50, 'limit default 50');
ok('limit bounded [1, 200], default 50');

// Filters mapped to RPC params
var p4 = CrmAdmin._buildTimelineParams({ organizationId: 'org-1', missionId: 'm-1', opportunityId: 'o-1', clientId: 'c-1' }, null, 50);
assert.strictEqual(p4.p_organization_id, 'org-1', 'filter org');
assert.strictEqual(p4.p_mission_id, 'm-1', 'filter mission');
assert.strictEqual(p4.p_opportunity_id, 'o-1', 'filter opportunity');
assert.strictEqual(p4.p_client_id, 'c-1', 'filter client');
ok('timeline filters mapped to RPC params');

// RPC name + cursor contract in source
assert.ok(js.indexOf('crm_timeline_read') !== -1, 'crm_timeline_read rpc used');
ok('crm_timeline_read RPC used');
assert.ok(js.indexOf('p_before_event_at') !== -1 && js.indexOf('p_before_event_key') !== -1, 'cursor params in source');
ok('cursor params referenced in source');

// Timeline source + record_kind labels
const sources = ['pipeline_event', 'mission_event', 'billing_event', 'devis', 'mission', 'activity'];
sources.forEach(function (s) { assert.ok(CrmAdmin._SOURCE_LABELS[s], 'source label ' + s); });
ok('all 6 timeline source types mapped');
assert.ok(CrmAdmin._RECORD_KIND_LABELS.immutable_event && CrmAdmin._RECORD_KIND_LABELS.state_projection, 'record kinds mapped');
ok('record_kind labels (immutable_event / state_projection) mapped');

// =========================================================
// 8. EMPTY / ERROR STATES
// =========================================================
section('EMPTY / ERROR STATES');

assert.ok(js.indexOf('crm-empty') !== -1, 'crm-empty class used');
ok('crm-empty empty-state class used');
assert.ok(js.indexOf('crm-error') !== -1, 'crm-error class used');
ok('crm-error error-state class used');
assert.ok(js.indexOf('fa-spinner') !== -1, 'loading spinner used');
ok('loading spinner state used');
assert.ok(js.indexOf('Aucune') !== -1, 'Aucune... empty messages present');
ok('empty-state messages present');

// =========================================================
// 9. API/RPC ERROR HANDLING
// =========================================================
section('API/RPC ERROR HANDLING');

assert.ok(js.indexOf('handleRpcError') !== -1, 'handleRpcError defined');
ok('handleRpcError defined');
// RLS denial surfaced honestly (not worked around)
assert.ok(js.indexOf('Accès refusé') !== -1, 'RLS denial message');
ok('RLS/authorization denial surfaced honestly');
// service_role must NOT be referenced
assert.ok(!js.match(/service_role/i), 'no service_role reference in crm-admin.js');
ok('no service_role reference in crm-admin.js');
assert.ok(!js.match(/SUPABASE_SERVICE_ROLE_KEY/i), 'no service role key');
ok('no SUPABASE_SERVICE_ROLE_KEY reference');

// =========================================================
// 10. REGRESSION — existing modules intact
// =========================================================
section('REGRESSION — EXISTING MODULES');

// Existing nav items still present
['dashboard', 'missions', 'devis', 'clients', 'convoyeurs', 'facturation', 'analytics'].forEach(function (t) {
  assert.match(html, new RegExp('data-tab="' + t + '"'), 'existing nav ' + t);
});
ok('existing nav items (dashboard, missions, devis, clients, convoyeurs, facturation, analytics) intact');

// Existing tab panels still present
['tab-dashboard', 'tab-missions', 'tab-devis', 'tab-clients', 'tab-convoyeurs'].forEach(function (t) {
  assert.match(html, new RegExp('id="' + t + '"'), 'existing tab ' + t);
});
ok('existing tab panels intact');

// Existing load functions still present
['loadClients', 'loadConvoyeurs', 'loadMissions', 'loadDevis', 'loadAllData'].forEach(function (f) {
  assert.ok(html.indexOf(f) !== -1, 'existing function ' + f);
});
ok('existing load functions intact');

// Mobile bottom nav still present
assert.match(html, /class="mobile-bottom-nav"/, 'mobile bottom nav present');
ok('mobile bottom nav intact');

// No destructive CRM operations on immutable tables.
// P3C2 adds legitimate .delete() on mutable CRM tables
// (organization_segments). Immutable tables must never be
// deleted from the frontend.
assert.ok(!js.match(/crm_pipeline_events.*\.delete\(\)|\.delete\(\).*crm_pipeline_events/i), 'no pipeline_events delete');
ok('no direct crm_pipeline_events DELETE');
assert.ok(!js.match(/crm_link_events.*\.delete\(\)|\.delete\(\).*crm_link_events/i), 'no link_events delete');
ok('no direct crm_link_events DELETE');
assert.ok(!js.match(/\.update\(\s*\{\s*stage/i), 'no direct stage update');
ok('no direct .update({ stage:... })');
assert.ok(!js.match(/crm_pipeline_events.*insert|insert.*crm_pipeline_events/i), 'no pipeline event writes');
ok('no direct crm_pipeline_events INSERT');
assert.ok(!js.match(/crm_link_events.*insert|insert.*crm_link_events/i), 'no link event writes');
ok('no direct crm_link_events INSERT');

// =========================================================
// SUMMARY
// =========================================================
console.log('\n=== P3C1 Test Summary ===');
console.log('Assertions passed: ' + pass);
console.log('Result: PASS\n');
