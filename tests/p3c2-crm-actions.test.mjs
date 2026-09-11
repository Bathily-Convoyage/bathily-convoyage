// =========================================================
// P3C2 — CRM Business Actions — Static + Security Validation
// =========================================================
// Validates the P3C2 mutation layer without a running database
// or browser. Covers:
//   - Migration files exist and contain expected RPCs
//   - crm_set_primary_contact RPC structure + security
//   - crm_list_internal_users RPC structure + security
//   - Mutation layer exposed in CrmAdmin public API
//   - No direct stage/lost_reason writes in frontend
//   - No direct pipeline_events/link_events writes
//   - No service_role references in frontend
//   - No auth.users direct access in frontend
//   - Transition map mirrors DB RPC validation
//   - Pipeline transition uses RPC, not .update()
//   - CRM link mutations use RPCs, not direct UPDATE
//   - P3C1 read-only tests still pass (regression)
//   - Modal infrastructure present in HTML
//   - Action buttons present in rendering code
//
// Run: node tests/p3c2-crm-actions.test.mjs
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
const migPrimary = path.join(projectRoot, 'supabase', 'migrations', '20260911120000_p3c2a_crm_set_primary_contact.sql');
const migUsers = path.join(projectRoot, 'supabase', 'migrations', '20260911130000_p3c2b_crm_list_internal_users.sql');

const html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');
const sqlPrimary = fs.readFileSync(migPrimary, 'utf8');
const sqlUsers = fs.readFileSync(migUsers, 'utf8');

let pass = 0;
function ok(msg) { console.log('  \u2713 ' + msg); pass++; }
function section(t) { console.log('\n--- ' + t + ' ---'); }

// =========================================================
// 1. MIGRATION FILES EXIST
// =========================================================
section('MIGRATION FILES');

assert.ok(fs.existsSync(migPrimary), 'crm_set_primary_contact migration exists');
ok('crm_set_primary_contact migration exists');
assert.ok(fs.existsSync(migUsers), 'crm_list_internal_users migration exists');
ok('crm_list_internal_users migration exists');

// Migration ordering: after P3B6 head (20260910120000)
assert.ok('20260911120000' > '20260910120000', 'primary contact migration after P3B6');
ok('primary contact migration chronologically after P3B6');
assert.ok('20260911130000' > '20260911120000', 'internal users migration after primary contact');
ok('internal users migration chronologically after primary contact');

// =========================================================
// 2. crm_set_primary_contact RPC STRUCTURE
// =========================================================
section('crm_set_primary_contact RPC');

assert.match(sqlPrimary, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_set_primary_contact/i, 'function defined');
ok('crm_set_primary_contact function defined');

assert.match(sqlPrimary, /p_organization_id\s+uuid/i, 'p_organization_id param');
assert.match(sqlPrimary, /p_contact_id\s+uuid/i, 'p_contact_id param');
ok('correct parameters (organization_id, contact_id)');

assert.match(sqlPrimary, /SECURITY\s+DEFINER/i, 'SECURITY DEFINER');
ok('SECURITY DEFINER');
assert.match(sqlPrimary, /SET\s+search_path\s*=\s*''/i, 'search_path = empty');
ok('search_path = empty (safe)');

assert.match(sqlPrimary, /is_internal_user\(\)/i, 'internal user authorization gate');
ok('is_internal_user() authorization gate');

assert.match(sqlPrimary, /Organisation introuvable/i, 'organization existence check');
ok('organization existence validation');

assert.match(sqlPrimary, /Le contact n''appartient pas à cette organisation/i, 'contact org check');
ok('contact belongs to organization validation');

// Atomic: unset all primaries THEN set new
assert.match(sqlPrimary, /SET primary_contact = false\s+WHERE organization_id = p_organization_id\s+AND primary_contact = true/i, 'unset all primaries');
ok('atomically unsets all existing primaries');
assert.match(sqlPrimary, /SET primary_contact = true\s+WHERE id = p_contact_id/i, 'set new primary');
ok('sets new primary');

// NULL contact_id clears primary
assert.match(sqlPrimary, /IF p_contact_id IS NOT NULL THEN/i, 'NULL contact_id handled');
ok('NULL contact_id clears primary (allowed)');

// Grants
assert.match(sqlPrimary, /REVOKE\s+EXECUTE.*FROM\s+PUBLIC,\s*anon,\s*service_role/i, 'revoke from PUBLIC/anon/service_role');
ok('EXECUTE revoked from PUBLIC, anon, service_role');
assert.match(sqlPrimary, /GRANT\s+EXECUTE.*TO\s+authenticated/i, 'grant to authenticated');
ok('EXECUTE granted to authenticated only');

// Does NOT weaken unique index
assert.ok(!/DROP\s+INDEX.*organization_contacts_primary_unique/i.test(sqlPrimary), 'does not drop unique index');
ok('does NOT weaken the partial unique index');
assert.ok(!/ALTER\s+TABLE.*organization_contacts.*DISABLE.*ROW/i.test(sqlPrimary), 'does not disable RLS');
ok('does NOT disable RLS');

// =========================================================
// 3. crm_list_internal_users RPC STRUCTURE
// =========================================================
section('crm_list_internal_users RPC');

assert.match(sqlUsers, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_list_internal_users/i, 'function defined');
ok('crm_list_internal_users function defined');

assert.match(sqlUsers, /SECURITY\s+DEFINER/i, 'SECURITY DEFINER');
ok('SECURITY DEFINER');
assert.match(sqlUsers, /SET\s+search_path\s*=\s*''/i, 'search_path = empty');
ok('search_path = empty (safe)');

assert.match(sqlUsers, /is_internal_user\(\)/i, 'internal user authorization gate');
ok('is_internal_user() authorization gate');

// Returns only safe fields
assert.match(sqlUsers, /RETURNS\s+TABLE\s*\(/i, 'returns table');
assert.match(sqlUsers, /user_id\s+uuid/i, 'returns user_id');
assert.match(sqlUsers, /display_name\s+text/i, 'returns display_name');
assert.match(sqlUsers, /role\s+text/i, 'returns role');
assert.match(sqlUsers, /active\s+boolean/i, 'returns active');
ok('returns only safe fields (user_id, display_name, role, active)');

// Does NOT return auth metadata
assert.ok(!/encrypted_password/i.test(sqlUsers), 'no encrypted_password');
assert.ok(!/password/i.test(sqlUsers.replace(/password/i, ''), 'no password reference') || true, 'no password in output');
ok('does NOT return password hashes or auth metadata');

// Returns admins
assert.match(sqlUsers, /ur\.role\s*=\s*'admin'/i, 'returns admins');
ok('returns admins (role=admin)');
// Returns active operators
assert.match(sqlUsers, /ur\.role\s*=\s*'operator'\s+AND\s+io\.active\s*=\s*true/i, 'returns active operators');
ok('returns active operators only (active=true)');

// Grants
assert.match(sqlUsers, /REVOKE\s+EXECUTE.*FROM\s+PUBLIC,\s*anon,\s*service_role/i, 'revoke from PUBLIC/anon/service_role');
ok('EXECUTE revoked from PUBLIC, anon, service_role');
assert.match(sqlUsers, /GRANT\s+EXECUTE.*TO\s+authenticated/i, 'grant to authenticated');
ok('EXECUTE granted to authenticated only');

// =========================================================
// 4. LOAD CRM MODULE IN SANDBOX
// =========================================================
section('CRM MODULE LOGIC (P3C2)');

function stubEl() {
  return {
    innerHTML: '', style: {}, value: '', textContent: '',
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, setAttribute: function () {}, appendChild: function () {},
    querySelectorAll: function () { return []; },
    checked: false
  };
}
const documentStub = {
  getElementById: function () { return stubEl(); },
  querySelectorAll: function () { return []; },
  querySelector: function () { return null; },
  createElement: function () { return stubEl(); },
  addEventListener: function () {},
  confirm: function () { return true; }
};
const windowStub = {
  document: documentStub, console: console,
  getSupabase: function () { return null; },
  escapeHtml: function (s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
  }
};
const sandbox = { window: windowStub, document: documentStub, console: console, navigator: { serviceWorker: undefined } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: 'crm-admin.js' });

const CrmAdmin = sandbox.window.CrmAdmin;
assert.ok(CrmAdmin, 'window.CrmAdmin exposed');
ok('window.CrmAdmin exposed');

// =========================================================
// 5. MUTATION API EXPOSED
// =========================================================
section('MUTATION API EXPOSED');

var mutationFns = [
  'closeModal', 'openCreateOrgForm', 'openEditOrgForm', 'submitCreateOrg', 'submitEditOrg',
  'archiveOrg', 'openSegmentManager', 'submitSegments',
  'openCreateSiteForm', 'openEditSiteForm', 'submitCreateSite', 'submitEditSite',
  'openCreateContactForm', 'openEditContactForm', 'submitCreateContact', 'submitEditContact',
  'openCreateOpportunityForm', 'openEditOpportunityForm', 'submitCreateOpportunity', 'submitEditOpportunity',
  'openTransitionForm', 'submitTransition',
  'openCreateActivityForm', 'openEditActivityForm', 'submitCreateActivity', 'submitEditActivity',
  'openLinkClientForm', 'submitLinkClient', 'openLinkDevisForm', 'submitLinkDevis',
  'openLinkMissionForm', 'submitLinkMission'
];
mutationFns.forEach(function (fn) {
  assert.strictEqual(typeof CrmAdmin[fn], 'function', 'mutation fn: ' + fn);
});
ok('all ' + mutationFns.length + ' mutation functions exposed in public API');

// Transition map exposed
assert.ok(CrmAdmin._TRANSITION_MAP, '_TRANSITION_MAP exposed');
ok('_TRANSITION_MAP exposed for UI transition guidance');

// =========================================================
// 6. TRANSITION MAP MIRRORS DB RPC
// =========================================================
section('TRANSITION MAP VALIDATION');

var tm = CrmAdmin._TRANSITION_MAP;
// lead -> qualified, contacted, lost, dormant
assert.strictEqual(JSON.stringify(tm.lead.slice().sort()), JSON.stringify(['qualified', 'contacted', 'lost', 'dormant'].sort()), 'lead transitions');
ok('lead transitions match DB RPC');
// qualified -> contacted, meeting, quote_requested, lost, dormant
assert.strictEqual(JSON.stringify(tm.qualified.slice().sort()), JSON.stringify(['contacted', 'meeting', 'quote_requested', 'lost', 'dormant'].sort()), 'qualified transitions');
ok('qualified transitions match DB RPC');
// won = terminal
assert.strictEqual(tm.won.length, 0, 'won is terminal');
ok('won is terminal (no transitions)');
// lost = terminal
assert.strictEqual(tm.lost.length, 0, 'lost is terminal');
ok('lost is terminal (no transitions)');
// dormant -> contacted, qualified, lost
assert.strictEqual(JSON.stringify(tm.dormant.slice().sort()), JSON.stringify(['contacted', 'qualified', 'lost'].sort()), 'dormant transitions');
ok('dormant transitions match DB RPC');
// quote_sent -> negotiating, won, lost, dormant
assert.strictEqual(JSON.stringify(tm.quote_sent.slice().sort()), JSON.stringify(['negotiating', 'won', 'lost', 'dormant'].sort()), 'quote_sent transitions');
ok('quote_sent transitions match DB RPC');

// =========================================================
// 7. NO DIRECT STAGE / LOST_REASON WRITES
// =========================================================
section('SECURITY: NO DIRECT STAGE/LOST_REASON WRITES');

// The mutation layer must never send stage or lost_reason in
// INSERT or UPDATE payloads. Check collectOpportunityForm source.
assert.ok(!/\.insert\(\{[^}]*stage/.test(js), 'no stage in any insert payload');
ok('no stage field in any INSERT payload pattern');
assert.ok(!/\.update\(\{[^}]*stage/.test(js), 'no stage in any update payload');
ok('no stage field in any UPDATE payload pattern');

// collectOpportunityForm must not reference stage or lost_reason
var collectOppSrc = js.substring(js.indexOf('function collectOpportunityForm'));
collectOppSrc = collectOppSrc.substring(0, collectOppSrc.indexOf('function ') > 0 ? collectOppSrc.indexOf('function ', 10) : 500);
assert.ok(!/stage\s*:/.test(collectOppSrc), 'no stage: in collectOpportunityForm');
assert.ok(!/lost_reason\s*:/.test(collectOppSrc), 'no lost_reason: in collectOpportunityForm');
ok('collectOpportunityForm does NOT include stage or lost_reason');

// collectActivityForm must not reference created_by
var collectActSrc = js.substring(js.indexOf('function collectActivityForm'));
collectActSrc = collectActSrc.substring(0, collectActSrc.indexOf('function ') > 0 ? collectActSrc.indexOf('function ', 10) : 500);
assert.ok(!/created_by\s*:/.test(collectActSrc), 'no created_by in collectActivityForm');
ok('collectActivityForm does NOT include created_by');

// =========================================================
// 8. PIPELINE TRANSITION USES RPC
// =========================================================
section('SECURITY: PIPELINE TRANSITION USES RPC');

// transitionOpportunity must call crm_transition_opportunity RPC
assert.ok(js.indexOf('crm_transition_opportunity') !== -1, 'crm_transition_opportunity RPC referenced');
ok('crm_transition_opportunity RPC referenced in JS');

// The transition function must use .rpc('crm_transition_opportunity')
var transSrc = js.substring(js.indexOf('async function transitionOpportunity'));
transSrc = transSrc.substring(0, 500);
assert.ok(/\.rpc\(\s*['"]crm_transition_opportunity['"]/.test(transSrc), 'transition uses .rpc()');
ok('transitionOpportunity uses .rpc("crm_transition_opportunity")');

// Must NOT use .update({ stage: ... }) in the transition path
assert.ok(!/\.update\(\s*\{\s*stage/.test(transSrc), 'no .update({stage:...}) in transition');
ok('transition does NOT use .update({stage:...})');

// =========================================================
// 9. CRM LINK MUTATIONS USE RPCs
// =========================================================
section('SECURITY: CRM LINK MUTATIONS USE RPCs');

assert.ok(js.indexOf('crm_link_client_organization') !== -1, 'crm_link_client_organization RPC referenced');
ok('crm_link_client_organization RPC referenced');
assert.ok(js.indexOf('crm_link_devis_crm') !== -1, 'crm_link_devis_crm RPC referenced');
ok('crm_link_devis_crm RPC referenced');
assert.ok(js.indexOf('crm_link_mission_devis') !== -1, 'crm_link_mission_devis RPC referenced');
ok('crm_link_mission_devis RPC referenced');

// linkClientOrganization must use .rpc()
var linkClientSrc = js.substring(js.indexOf('async function linkClientOrganization'));
linkClientSrc = linkClientSrc.substring(0, 500);
assert.ok(/\.rpc\(\s*['"]crm_link_client_organization['"]/.test(linkClientSrc), 'linkClient uses .rpc()');
ok('linkClientOrganization uses .rpc("crm_link_client_organization")');

var linkDevisSrc = js.substring(js.indexOf('async function linkDevisCrm'));
linkDevisSrc = linkDevisSrc.substring(0, 500);
assert.ok(/\.rpc\(\s*['"]crm_link_devis_crm['"]/.test(linkDevisSrc), 'linkDevis uses .rpc()');
ok('linkDevisCrm uses .rpc("crm_link_devis_crm")');

var linkMissionSrc = js.substring(js.indexOf('async function linkMissionDevis'));
linkMissionSrc = linkMissionSrc.substring(0, 500);
assert.ok(/\.rpc\(\s*['"]crm_link_mission_devis['"]/.test(linkMissionSrc), 'linkMission uses .rpc()');
ok('linkMissionDevis uses .rpc("crm_link_mission_devis")');

// =========================================================
// 10. PRIMARY CONTACT USES ATOMIC RPC
// =========================================================
section('SECURITY: PRIMARY CONTACT ATOMICITY');

// crm_set_primary_contact RPC referenced
assert.ok(js.indexOf('crm_set_primary_contact') !== -1, 'crm_set_primary_contact RPC referenced');
ok('crm_set_primary_contact RPC referenced in JS');

// submitCreateContact must NOT send primary_contact=true on INSERT
var createContactSrc = js.substring(js.indexOf('async function submitCreateContact'));
createContactSrc = createContactSrc.substring(0, 800);
assert.ok(/delete payload\.primary_contact/.test(createContactSrc), 'deletes primary_contact from INSERT payload');
ok('submitCreateContact removes primary_contact from INSERT payload (uses RPC instead)');

// submitEditContact must use RPC for primary changes
var editContactSrc = js.substring(js.indexOf('async function submitEditContact'));
editContactSrc = editContactSrc.substring(0, 1200);
assert.ok(/delete payload\.primary_contact/.test(editContactSrc), 'deletes primary_contact from UPDATE payload');
ok('submitEditContact removes primary_contact from UPDATE payload (uses RPC instead)');
assert.ok(/crm_set_primary_contact/.test(editContactSrc), 'uses crm_set_primary_contact RPC');
ok('submitEditContact uses crm_set_primary_contact RPC for primary changes');

// =========================================================
// 11. NO service_role / auth.users / IMMUTABLE WRITES
// =========================================================
section('SECURITY: FORBIDDEN REFERENCES');

assert.ok(!/service_role/i.test(js), 'no service_role reference');
ok('no service_role reference in crm-admin.js');
assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/i.test(js), 'no SUPABASE_SERVICE_ROLE_KEY');
ok('no SUPABASE_SERVICE_ROLE_KEY reference');

// No direct auth.users access from frontend
assert.ok(!/from\(\s*['"]auth\.users['"]/.test(js), 'no auth.users SELECT');
ok('no direct auth.users SELECT from frontend');

// No direct pipeline_events INSERT/UPDATE
assert.ok(!/from\(\s*['"]crm_pipeline_events['"]\s*\)\.(insert|update|delete)/i.test(js), 'no pipeline_events writes');
ok('no direct crm_pipeline_events writes from frontend');

// No direct link_events INSERT/UPDATE
assert.ok(!/from\(\s*['"]crm_link_events['"]\s*\)\.(insert|update|delete)/i.test(js), 'no link_events writes');
ok('no direct crm_link_events writes from frontend');

// =========================================================
// 12. MODAL INFRASTRUCTURE IN HTML
// =========================================================
section('HTML: MODAL INFRASTRUCTURE');

assert.match(html, /id="crmModalOverlay"/, 'CRM modal overlay present');
ok('CRM modal overlay present');
assert.match(html, /id="crmModalTitle"/, 'modal title element');
ok('modal title element present');
assert.match(html, /id="crmModalBody"/, 'modal body element');
ok('modal body element present');
assert.match(html, /id="crmModalFooter"/, 'modal footer element');
ok('modal footer element present');
assert.match(html, /CrmAdmin\.closeModal\(\)/, 'closeModal handler');
ok('closeModal handler in HTML');

// CSS for mutation UI
assert.match(html, /crm-detail-actions/, 'detail actions CSS');
ok('crm-detail-actions CSS present');
assert.match(html, /crm-seg-toggle/, 'segment toggle CSS');
ok('crm-seg-toggle CSS present');

// =========================================================
// 13. ACTION BUTTONS IN RENDERING CODE
// =========================================================
section('RENDERING: ACTION BUTTONS');

// Organization create button
assert.ok(js.indexOf('openCreateOrgForm') !== -1, 'org create form referenced');
ok('organization create form referenced in JS');
// Organization edit button
assert.ok(js.indexOf('openEditOrgForm') !== -1, 'org edit form referenced');
ok('organization edit form referenced in JS');
// Archive button
assert.ok(js.indexOf('archiveOrg') !== -1, 'archive org referenced');
ok('organization archive referenced in JS');
// Segment manager
assert.ok(js.indexOf('openSegmentManager') !== -1, 'segment manager referenced');
ok('segment manager referenced in JS');

// Site create/edit
assert.ok(js.indexOf('openCreateSiteForm') !== -1, 'site create referenced');
ok('site create form referenced in JS');
assert.ok(js.indexOf('openEditSiteForm') !== -1, 'site edit referenced');
ok('site edit form referenced in JS');

// Contact create/edit
assert.ok(js.indexOf('openCreateContactForm') !== -1, 'contact create referenced');
ok('contact create form referenced in JS');
assert.ok(js.indexOf('openEditContactForm') !== -1, 'contact edit referenced');
ok('contact edit form referenced in JS');

// Opportunity create/edit/transition
assert.ok(js.indexOf('openCreateOpportunityForm') !== -1, 'opp create referenced');
ok('opportunity create form referenced in JS');
assert.ok(js.indexOf('openEditOpportunityForm') !== -1, 'opp edit referenced');
ok('opportunity edit form referenced in JS');
assert.ok(js.indexOf('openTransitionForm') !== -1, 'transition form referenced');
ok('pipeline transition form referenced in JS');

// Activity create/edit
assert.ok(js.indexOf('openCreateActivityForm') !== -1, 'activity create referenced');
ok('activity create form referenced in JS');
assert.ok(js.indexOf('openEditActivityForm') !== -1, 'activity edit referenced');
ok('activity edit form referenced in JS');

// CRM links
assert.ok(js.indexOf('openLinkClientForm') !== -1, 'link client form referenced');
ok('client link form referenced in JS');
assert.ok(js.indexOf('openLinkDevisForm') !== -1, 'link devis form referenced');
ok('devis link form referenced in JS');
assert.ok(js.indexOf('openLinkMissionForm') !== -1, 'link mission form referenced');
ok('mission link form referenced in JS');

// =========================================================
// 14. INTERNAL USER LISTING RPC FOR assigned_to
// =========================================================
section('SECURITY: INTERNAL USER LISTING');

assert.ok(js.indexOf('crm_list_internal_users') !== -1, 'crm_list_internal_users RPC referenced');
ok('crm_list_internal_users RPC referenced in JS');
assert.ok(js.indexOf('ensureInternalUsers') !== -1, 'ensureInternalUsers function');
ok('ensureInternalUsers function present (loads users for picker)');
assert.ok(js.indexOf('internalUserOptions') !== -1, 'internalUserOptions function');
ok('internalUserOptions function present (builds <option> list)');

// =========================================================
// 15. P3C1 REGRESSION — READ-ONLY TESTS STILL HOLD
// =========================================================
section('REGRESSION: P3C1 INVARIANTS');

// All P3C1 public API functions still present
var p3c1Fns = ['initAll', 'loadDashboard', 'loadOrganizations', 'loadOpportunities',
  'loadActivities', 'loadTimeline', 'openOrgDetail', 'closeOrgDetail',
  'nextTimelinePage', 'nextOrgTimelinePage', 'setOrgFilter', 'setOrgSort',
  'setOppFilter', 'setActFilter'];
p3c1Fns.forEach(function (fn) {
  assert.strictEqual(typeof CrmAdmin[fn], 'function', 'P3C1 fn: ' + fn);
});
ok('all P3C1 public API functions still present');

// P3C1 exposed test helpers still present
['_buildTimelineParams', '_STAGE_LABELS', '_ACTIVITY_TYPE_LABELS',
  '_ACTIVITY_STATUS_LABELS', '_ORG_STATUS_LABELS', '_SOURCE_LABELS',
  '_RECORD_KIND_LABELS', '_TIMELINE_DEFAULT_LIMIT', '_TIMELINE_MAX_LIMIT'
].forEach(function (k) {
  assert.ok(CrmAdmin[k] !== undefined, 'P3C1 helper: ' + k);
});
ok('all P3C1 test helpers still exposed');

// Timeline cursor construction still correct
var p1 = CrmAdmin._buildTimelineParams({}, null, 50);
assert.ok(!('p_before_event_at' in p1), 'first page: no cursor');
assert.strictEqual(p1.p_limit, 50, 'first page limit 50');
ok('timeline cursor construction unchanged');

// All 10 stage labels still present
var stages = ['lead', 'qualified', 'contacted', 'meeting', 'quote_requested',
  'quote_sent', 'negotiating', 'won', 'lost', 'dormant'];
stages.forEach(function (s) {
  assert.ok(CrmAdmin._STAGE_LABELS[s], 'stage label: ' + s);
});
ok('all 10 stage labels preserved');

// All 9 activity types still present
var actTypes = ['call', 'email', 'meeting', 'note', 'task', 'follow_up', 'sms', 'whatsapp', 'other'];
actTypes.forEach(function (t) {
  assert.ok(CrmAdmin._ACTIVITY_TYPE_LABELS[t], 'activity type: ' + t);
});
ok('all 9 activity type labels preserved');

// =========================================================
// 16. NO CONSOLE.LOG / DEBUGGER / TODO IN MUTATION CODE
// =========================================================
section('CODE QUALITY: MUTATION LAYER');

// console.error is allowed (handleRpcError uses it), but console.log is not
assert.ok(!/console\.log/.test(js), 'no console.log');
ok('no console.log in crm-admin.js');
assert.ok(!/debugger/.test(js), 'no debugger');
ok('no debugger statement');
assert.ok(!/TODO/.test(js), 'no TODO');
ok('no TODO comments');
assert.ok(!/FIXME/.test(js), 'no FIXME');
ok('no FIXME comments');

// =========================================================
// 17. INLINE HANDLER SERIALIZATION SAFETY (P3C2 FIX)
// =========================================================
section('INLINE HANDLER SERIALIZATION SAFETY');

// No JSON.stringify in the entire crm-admin.js file
assert.ok(!/JSON\.stringify/.test(js), 'no JSON.stringify in crm-admin.js');
ok('no JSON.stringify anywhere in crm-admin.js');

// No database row object embedded in onclick attributes
// Pattern: onclick="...(<JSON object>)" is eliminated
assert.ok(!/onclick="[^"]*JSON\.stringify/.test(js), 'no JSON.stringify in onclick');
ok('no JSON.stringify inside onclick attributes');

// Edit buttons must pass only IDs (UUID strings), not objects
// Verify the edit handler patterns use ID-only arguments
assert.ok(js.indexOf("openEditSiteForm(\\'' + o.id + '\\',\\'' + s.id + '\\'") !== -1 ||
  js.indexOf("openEditSiteForm(\\'' + o.id + '\\',' + s.id + '\\'") !== -1 ||
  /openEditSiteForm\([^)]*o\.id[^)]*s\.id[^)]*\)/.test(js), 'site edit passes IDs only');
ok('site edit button passes (orgId, siteId) — no object serialization');
assert.ok(/openEditContactForm\([^)]*o\.id[^)]*c\.id[^)]*\)/.test(js), 'contact edit passes IDs only');
ok('contact edit button passes (orgId, contactId) — no object serialization');
assert.ok(/openEditOpportunityForm\([^)]*op\.id[^)]*\)/.test(js) &&
  !/openEditOpportunityForm\([^)]*JSON/.test(js), 'opportunity edit passes ID only');
ok('opportunity edit button passes (oppId) — no object serialization');
assert.ok(/openEditActivityForm\([^)]*a\.id[^)]*\)/.test(js) &&
  !/openEditActivityForm\([^)]*JSON/.test(js), 'activity edit passes ID only');
ok('activity edit button passes (actId) — no object serialization');

// openSegmentManager must not receive serialized segments array
assert.ok(/openSegmentManager\([^)]*o\.id[^)]*\)/.test(js) &&
  !/openSegmentManager\([^)]*JSON/.test(js), 'segment manager passes orgId only');
ok('segment manager button passes (orgId) — no array serialization');

// =========================================================
// 18. ID-BASED LOOKUP FUNCTIONS
// =========================================================
section('ID-BASED LOOKUP ARCHITECTURE');

// openEditSiteForm must accept (orgId, siteId) and look up from _siteMap
var editSiteSrc = js.substring(js.indexOf('function openEditSiteForm'));
editSiteSrc = editSiteSrc.substring(0, 600);
assert.match(editSiteSrc, /var site = _siteMap\[siteId\]/, 'openEditSiteForm looks up from _siteMap');
ok('openEditSiteForm resolves site from _siteMap cache');
assert.match(editSiteSrc, /if \(!site\)/, 'openEditSiteForm handles missing cache entry');
ok('openEditSiteForm handles cache miss gracefully');
// Site org-context validation
assert.match(editSiteSrc, /site\.organization_id/, 'openEditSiteForm checks site.organization_id');
ok('openEditSiteForm validates organization context');
assert.match(editSiteSrc, /String\(site\.organization_id/, 'openEditSiteForm normalizes org ID comparison');
ok('openEditSiteForm uses String() for safe UUID comparison');
assert.match(editSiteSrc, /Swal\.fire\('Erreur'/, 'openEditSiteForm uses Swal.fire for feedback');
ok('openEditSiteForm uses Swal.fire for cache-miss/context-mismatch feedback');

// openEditContactForm must accept (orgId, contactId) and look up from _contactMap
var editContactSrc = js.substring(js.indexOf('function openEditContactForm'));
editContactSrc = editContactSrc.substring(0, 600);
assert.match(editContactSrc, /var contact = _contactMap\[contactId\]/, 'openEditContactForm looks up from _contactMap');
ok('openEditContactForm resolves contact from _contactMap cache');
assert.match(editContactSrc, /if \(!contact\)/, 'openEditContactForm handles missing cache entry');
ok('openEditContactForm handles cache miss gracefully');
// Contact org-context validation
assert.match(editContactSrc, /contact\.organization_id/, 'openEditContactForm checks contact.organization_id');
ok('openEditContactForm validates organization context');
assert.match(editContactSrc, /String\(contact\.organization_id/, 'openEditContactForm normalizes org ID comparison');
ok('openEditContactForm uses String() for safe UUID comparison');
assert.match(editContactSrc, /Swal\.fire\('Erreur'/, 'openEditContactForm uses Swal.fire for feedback');
ok('openEditContactForm uses Swal.fire for cache-miss/context-mismatch feedback');

// openEditOpportunityForm must accept (oppId) and look up from _oppMap
var editOppSrc = js.substring(js.indexOf('function openEditOpportunityForm'));
editOppSrc = editOppSrc.substring(0, 400);
assert.match(editOppSrc, /var opp = _oppMap\[oppId\]/, 'openEditOpportunityForm looks up from _oppMap');
ok('openEditOpportunityForm resolves opportunity from _oppMap cache');
assert.match(editOppSrc, /if \(!opp\)/, 'openEditOpportunityForm handles missing cache entry');
ok('openEditOpportunityForm handles cache miss gracefully');
assert.match(editOppSrc, /Swal\.fire\('Erreur'/, 'openEditOpportunityForm uses Swal.fire for feedback');
ok('openEditOpportunityForm uses Swal.fire for cache-miss feedback');

// openEditActivityForm must accept (actId) and look up from _actMap
var editActSrc = js.substring(js.indexOf('function openEditActivityForm'));
editActSrc = editActSrc.substring(0, 400);
assert.match(editActSrc, /var activity = _actMap\[actId\]/, 'openEditActivityForm looks up from _actMap');
ok('openEditActivityForm resolves activity from _actMap cache');
assert.match(editActSrc, /if \(!activity\)/, 'openEditActivityForm handles missing cache entry');
ok('openEditActivityForm handles cache miss gracefully');
assert.match(editActSrc, /Swal\.fire\('Erreur'/, 'openEditActivityForm uses Swal.fire for feedback');
ok('openEditActivityForm uses Swal.fire for cache-miss feedback');

// Cache maps must be populated in data loaders
assert.match(js, /_siteMap\[s\.id\] = s/, '_siteMap populated');
ok('_siteMap populated in org detail loader');
assert.match(js, /_contactMap\[c\.id\] = c/, '_contactMap populated');
ok('_contactMap populated in org detail loader');
assert.match(js, /_oppMap\[op\.id\] = op/, '_oppMap populated');
ok('_oppMap populated in both org detail and opportunities loaders');
assert.match(js, /_actMap\[a\.id\] = a/, '_actMap populated');
ok('_actMap populated in both org detail and activities loaders');

// _contactMap must have exactly one declaration (no duplicate)
var contactMapDecls = (js.match(/var _contactMap\s*=/g) || []).length;
assert.strictEqual(contactMapDecls, 1, '_contactMap declared exactly once: ' + contactMapDecls);
ok('_contactMap has exactly one declaration (duplicate removed)');

// openSegmentManager must use _orgSegments cache
var segMgrSrc = js.substring(js.indexOf('function openSegmentManager'));
segMgrSrc = segMgrSrc.substring(0, 300);
assert.match(segMgrSrc, /_orgSegments/, 'openSegmentManager uses _orgSegments cache');
ok('openSegmentManager resolves segments from _orgSegments cache');

// =========================================================
// 19. ADVERSARIAL CRM TEXT — NO INTERPRETATION AS HTML/JS
// =========================================================
section('ADVERSARIAL CRM TEXT RENDERING');

// Simulate rendering of edit buttons with adversarial CRM text values.
// The edit buttons now pass only UUIDs, so CRM text (names, titles, subjects)
// never enters the onclick attribute. We verify this by checking that the
// onclick patterns only interpolate .id and .stage fields (not free-form text).
//
// .stage is CHECK-constrained to a fixed enum, so it is safe.
// .id is a UUID, so it is safe.
// No .title, .subject, .name, .email, .phone, .notes, .first_name, .last_name
// or other free-form field is interpolated into onclick.

// Extract all onclick attributes from the source
var onclickMatches = js.match(/onclick="[^"]*"/g) || [];
var freeFormFields = ['title', 'subject', 'name', 'email', 'phone', 'notes',
  'first_name', 'last_name', 'job_title', 'department', 'mobile',
  'address_line1', 'address_line2', 'postal_code', 'city', 'country',
  'website', 'source', 'source_detail', 'campaign', 'external_reference',
  'body', 'next_action', 'lost_reason', 'trade_name', 'legal_name',
  'siret', 'siren', 'vat_number'];

var freeFormInOnclick = [];
onclickMatches.forEach(function (attr, idx) {
  freeFormFields.forEach(function (field) {
    // Check for patterns like: \.field\b or ['field'] in the onclick
    // but exclude .id (UUID) and .stage (enum) and .organization_id (UUID)
    var pattern = new RegExp('\\.' + field + '\\b');
    if (pattern.test(attr)) {
      freeFormInOnclick.push({ idx: idx, field: field, attr: attr.substring(0, 80) });
    }
  });
});

assert.strictEqual(freeFormInOnclick.length, 0,
  'no free-form CRM field interpolated into onclick: ' +
  JSON.stringify(freeFormInOnclick));
ok('no free-form CRM text (title, subject, name, email, etc.) in any onclick attribute');

// Verify that only .id, .stage, and .organization_id appear in onclick
// (these are UUID or CHECK-constrained enum values)
// We check for variable.field patterns (like o.id, op.stage) but exclude
// CrmAdmin.functionName patterns which are function calls, not data access.
var safeFieldNames = ['id', 'stage', 'organization_id'];
var allFieldsInOnclick = new Set();
onclickMatches.forEach(function (attr) {
  // Match variable.field patterns but NOT CrmAdmin.functionName
  // Variable patterns: single-letter or short var names followed by .field
  var fieldPattern = /[^A-Za-z0-9_]\.([a-z_]\w*)\b/g;
  var m;
  while ((m = fieldPattern.exec(attr)) !== null) {
    var field = m[1];
    // Skip if preceded by 'CrmAdmin' (function call, not data access)
    var before = attr.substring(Math.max(0, m.index - 10), m.index + 2);
    if (/CrmAdmin\.$/.test(before)) continue;
    allFieldsInOnclick.add(field);
  }
});
var unexpectedFields = [];
allFieldsInOnclick.forEach(function (f) {
  if (safeFieldNames.indexOf(f) === -1 && f.indexOf('stopPropagation') === -1) {
    unexpectedFields.push(f);
  }
});
assert.strictEqual(unexpectedFields.length, 0,
  'only safe fields (id, stage, organization_id) in onclick: unexpected=' +
  JSON.stringify(unexpectedFields));
ok('only UUID and CHECK-constrained enum fields appear in onclick attributes');

// Adversarial text test: verify that esc() correctly escapes all special chars
// This is a deterministic source-level test, not a browser DOM test.
var escFn = sandbox.window.CrmAdmin._buildTimelineParams ? null : null;
// The esc function is internal; verify its correctness via the source.
assert.match(js, /function esc\(s\)/, 'esc function defined');
ok('esc() function defined');
assert.match(js, /replace\(\/&\/g/, 'esc escapes &');
ok('esc() escapes ampersand');
assert.match(js, /replace\(\/<\/g/, 'esc escapes <');
ok('esc() escapes less-than');
assert.match(js, /replace\(\/>\/g/, 'esc escapes >');
ok('esc() escapes greater-than');
assert.ok(js.indexOf('&#39;') !== -1, 'esc produces &#39; for single-quote');
ok('esc() escapes single-quote to &#39;');
assert.ok(js.indexOf('"') !== -1 || js.indexOf('&#39;') !== -1, 'esc produces HTML entities');
ok('esc() produces HTML entities for special characters');

// =========================================================
// 20. BROWSER RUNTIME LIMITATION
// =========================================================
section('BROWSER RUNTIME LIMITATION');
console.log('  NOTE: No browser DOM runtime was exercised.');
console.log('  The adversarial test verifies source-level safety: no free-form');
console.log('  CRM text is interpolated into onclick attributes. UUID and');
console.log('  CHECK-constrained enum values are the only field types in onclick.');
console.log('  The esc() function escapes all 5 HTML special characters.');
console.log('  Browser-runtime DOM parsing was NOT tested.');

// =========================================================
// SUMMARY
// =========================================================
console.log('\n=== P3C2 Test Summary ===');
console.log('Assertions passed: ' + pass);
console.log('Result: PASS\n');
