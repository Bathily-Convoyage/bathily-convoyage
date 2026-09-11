// =========================================================
// RM-01C — CRM Admin UI/UX Robustness — Focused Regression
// =========================================================
// Validates the three RM-01A findings fixed in RM-01C without a
// running database or browser:
//   RM01A-002 — Organization form ID contract (rendered IDs match
//               collectOrgForm; create/edit wiring; validation)
//   RM01A-006 — Empty/null organization_id navigation guard
//               (no invalid Supabase .eq('id','') query)
//   RM01A-011 — Raw UUID text inputs replaced by scoped selectors
//               (human-readable labels, UUID values, org scoping,
//               stale-selection clearing, empty/error states)
//
// Run: node tests/rm-01c-crm-ui-robustness.test.mjs
// =========================================================

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const jsPath = path.join(projectRoot, 'public', 'js', 'crm-admin.js');
const js = fs.readFileSync(jsPath, 'utf8');

let pass = 0;
function ok(msg) { pass++; console.log('  \u2713 ' + msg); }
function section(t) { console.log('\n--- ' + t + ' ---'); }

// ---------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------
// A configurable DOM: getElementById returns a persistent element
// (looked up in a Map) so .value set by tests is read back by val().
function makeSandbox(getSupabaseFn) {
  const elements = new Map();
  function makeEl() {
    return {
      innerHTML: '', value: '', textContent: '', style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener() {}, setAttribute() {}, appendChild() {},
      querySelectorAll() { return []; }, checked: false, disabled: false
    };
  }
  function getEl(id) {
    if (!elements.has(id)) elements.set(id, makeEl());
    return elements.get(id);
  }
  const documentStub = {
    getElementById: getEl,
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement() { return makeEl(); },
    addEventListener() {},
    confirm() { return true; }
  };
  const windowStub = {
    document: documentStub,
    console: console,
    getSupabase: typeof getSupabaseFn === 'function' ? getSupabaseFn : function () { return null; },
    escapeHtml: function (s) {
      if (s == null) return '';
      return String(s).replace(/&/g, '&').replace(/</g, '<')
        .replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, '&#39;');
    }
  };
  const sandbox = { window: windowStub, document: documentStub, console: console, navigator: { serviceWorker: undefined } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'crm-admin.js' });
  return { sandbox, CrmAdmin: sandbox.window.CrmAdmin, getEl: getEl, elements: elements };
}

// Thenable query builder mock. Records .eq() calls and resolves
// with configurable { data, error }.
function makeThenable(table, resolveData, eqLog) {
  var builder = {
    select() { return builder; },
    eq(col, val) { if (eqLog) eqLog.push({ table: table, col: col, val: val }); return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); },
    then(resolve) { Promise.resolve().then(function () { resolve(resolveData); }); }
  };
  return builder;
}

function mockClientFromData(contactsData, oppsData, eqLog, errorData) {
  return {
    from: function (table) {
      var data;
      if (errorData && errorData[table]) {
        return makeThenable(table, { data: null, error: errorData[table] }, eqLog);
      }
      data = table === 'organization_contacts' ? contactsData
        : table === 'crm_opportunities' ? oppsData : [];
      return makeThenable(table, { data: data, error: null }, eqLog);
    },
    rpc: async function () { return { data: [], error: null }; }
  };
}

async function run() {

// =========================================================
// RM01A-002 — Organization form ID contract
// =========================================================
section('RM01A-002: ORG FORM ID CONTRACT (source)');

// Rendered IDs must use the org_* prefix that collectOrgForm reads.
// field()-based fields pass the id as an argument; status/notes are inline.
['org_legal_name', 'org_trade_name', 'org_siret', 'org_siren',
  'org_vat_number', 'org_email', 'org_phone', 'org_website',
  'org_source', 'org_source_detail', 'org_external_reference'].forEach(function (id) {
  assert.ok(js.indexOf("field('" + id + "'") !== -1, 'org form field() id: ' + id);
});
// status + notes are inline <select>/<textarea> with literal id attributes.
assert.ok(js.indexOf('id="org_status"') !== -1, 'org form inline id: org_status');
assert.ok(js.indexOf('id="org_notes"') !== -1, 'org form inline id: org_notes');
ok('orgFormFields renders all org_* IDs (field() args + inline)');

// Bare IDs (the old mismatched contract) must NOT be rendered by field().
['legal_name', 'trade_name', 'siret', 'siren', 'vat_number'].forEach(function (id) {
  assert.ok(!new RegExp("field\\(\\s*'" + id + "'").test(js), 'no bare field id: ' + id);
});
ok('no bare (non-org_) field IDs remain in orgFormFields');

// collectOrgForm must read the org_* IDs.
['org_legal_name', 'org_siret', 'org_siren', 'org_trade_name',
  'org_vat_number', 'org_status', 'org_notes'].forEach(function (id) {
  assert.ok(js.indexOf("'" + id + "'") !== -1 || js.indexOf('"' + id + '"') !== -1, 'collectOrgForm reads: ' + id);
});
ok('collectOrgForm reads org_* IDs consistently');

// The validation message for missing legal_name is present.
assert.ok(js.indexOf('La raison sociale est obligatoire.') !== -1, 'legal_name validation message');
ok('required-field validation message preserved');

// --- Functional: valid legal_name is captured ---
section('RM01A-002: ORG FORM COLLECTOR (functional)');

{
  var s = makeSandbox();
  var CrmAdmin = s.CrmAdmin;
  // Populate the org form fields with valid values.
  s.getEl('org_legal_name').value = 'Acme SARL';
  s.getEl('org_trade_name').value = 'Acme';
  s.getEl('org_siret').value = '12345678900012';
  s.getEl('org_siren').value = '123456789';
  s.getEl('org_vat_number').value = 'FR12345678901';
  s.getEl('org_email').value = 'contact@acme.com';
  s.getEl('org_phone').value = '+33123456789';
  s.getEl('org_website').value = 'https://acme.com';
  s.getEl('org_source').value = 'referral';
  s.getEl('org_source_detail').value = '';
  s.getEl('org_external_reference').value = '';
  s.getEl('org_status').value = 'active';
  s.getEl('org_notes').value = 'Notes de test';
  s.getEl('crmModalError');

  var payload = CrmAdmin._collectOrgForm();
  assert.ok(payload, 'collectOrgForm returns a payload for valid input');
  assert.strictEqual(payload.legal_name, 'Acme SARL', 'legal_name captured');
  assert.strictEqual(payload.trade_name, 'Acme', 'trade_name captured');
  assert.strictEqual(payload.siret, '12345678900012', 'siret captured');
  assert.strictEqual(payload.siren, '123456789', 'siren captured');
  assert.strictEqual(payload.email, 'contact@acme.com', 'email captured');
  assert.strictEqual(payload.status, 'active', 'status captured');
  assert.strictEqual(payload.notes, 'Notes de test', 'notes captured');
  ok('valid legal_name + fields captured by collectOrgForm');

  // --- Missing legal_name triggers validation ---
  s.getEl('org_legal_name').value = '   ';
  var errEl = s.getEl('crmModalError');
  errEl.innerHTML = '';
  var bad = CrmAdmin._collectOrgForm();
  assert.strictEqual(bad, null, 'collectOrgForm returns null when legal_name missing');
  assert.ok(errEl.innerHTML.indexOf('La raison sociale est obligatoire.') !== -1,
    'validation error surfaced in modal error');
  ok('missing legal_name triggers validation and returns null');

  // --- Invalid SIRET triggers validation ---
  s.getEl('org_legal_name').value = 'Acme SARL';
  s.getEl('org_siret').value = '123';
  errEl.innerHTML = '';
  var badSiret = CrmAdmin._collectOrgForm();
  assert.strictEqual(badSiret, null, 'collectOrgForm returns null for invalid SIRET');
  assert.ok(errEl.innerHTML.indexOf('SIRET') !== -1, 'SIRET validation surfaced');
  ok('invalid SIRET triggers validation');
}

// =========================================================
// RM01A-006 — Empty/null organization_id navigation guard
// =========================================================
section('RM01A-006: EMPTY ORG NAVIGATION GUARD (source)');

// openCrmOrgDetail must guard against empty/null id before any query.
var openOrgSrc = js.substring(js.indexOf('function openCrmOrgDetail'));
openOrgSrc = openOrgSrc.substring(0, 400);
assert.ok(/if \(!id\)\s*return/.test(openOrgSrc), 'openCrmOrgDetail guards empty id');
ok('openCrmOrgDetail has if(!id) return guard');

// No fallback to empty-string org id in row onclick handlers.
assert.ok(!/openOrgDetail\(\s*'\\'\s*'\s*\+\s*\(op\.organization_id\s*\|\|\s*''\)/.test(js),
  'no openOrgDetail with (op.organization_id || "") fallback');
assert.ok(!/openOrgDetail\(\s*'\\'\s*'\s*\+\s*\(a\.organization_id\s*\|\|\s*''\)/.test(js),
  'no openOrgDetail with (a.organization_id || "") fallback');
ok('no empty-fallback org navigation in opportunity/activity rows');

// --- Functional: empty id issues no Supabase query ---
section('RM01A-006: EMPTY ORG NAVIGATION GUARD (functional)');

{
  var supabaseCalled = false;
  var s6 = makeSandbox(function () { supabaseCalled = true; return null; });
  var CrmAdmin6 = s6.CrmAdmin;

  // Empty string id -> guard returns early, no Supabase call.
  supabaseCalled = false;
  CrmAdmin6.openOrgDetail('');
  assert.strictEqual(supabaseCalled, false, 'no Supabase call for empty org id');
  ok('openOrgDetail("") does not invoke getSupabase');

  // null id -> guard returns early.
  supabaseCalled = false;
  CrmAdmin6.openOrgDetail(null);
  assert.strictEqual(supabaseCalled, false, 'no Supabase call for null org id');
  ok('openOrgDetail(null) does not invoke getSupabase');

  // undefined id -> guard returns early.
  supabaseCalled = false;
  CrmAdmin6.openOrgDetail(undefined);
  assert.strictEqual(supabaseCalled, false, 'no Supabase call for undefined org id');
  ok('openOrgDetail(undefined) does not invoke getSupabase');

  // Valid id -> Supabase client is reached (proves the guard does not
  // block legitimate navigation).
  supabaseCalled = false;
  CrmAdmin6.openOrgDetail('valid-org-uuid');
  assert.strictEqual(supabaseCalled, true, 'Supabase call for valid org id');
  ok('openOrgDetail("valid-org-uuid") reaches Supabase client');
}

// =========================================================
// RM01A-011 — Raw UUID text inputs replaced by scoped selectors
// =========================================================
section('RM01A-011: NO RAW UUID TEXT INPUTS (source)');

// The targeted relationship fields must no longer be raw text inputs.
var targetedFields = [
  'opp_contact_id', 'act_opportunity_id', 'act_contact_id',
  'link_devis_contact', 'link_devis_opp'
];
targetedFields.forEach(function (id) {
  assert.ok(!new RegExp('<input[^>]*id="' + id + '"').test(js),
    'no raw text input for: ' + id);
});
ok('no raw UUID <input> remains for ' + targetedFields.length + ' targeted fields');

// Each targeted field must now be a <select> (human-readable selector).
targetedFields.forEach(function (id) {
  assert.ok(new RegExp('<select[^>]*id="' + id + '"').test(js),
    'select rendered for: ' + id);
});
ok('all ' + targetedFields.length + ' targeted fields are <select> controls');

// No "UUID" placeholder/label remains for the targeted relationship fields.
assert.ok(!/placeholder="UUID contact"/.test(js), 'no "UUID contact" placeholder');
ok('no "UUID contact" placeholder remains');
assert.ok(!/Contact \(UUID\)/.test(js), 'no "Contact (UUID)" label');
ok('no "Contact (UUID)" label remains');
assert.ok(!/Opportunité \(UUID\)/.test(js), 'no "Opportunité (UUID)" label');
ok('no "Opportunité (UUID)" label remains');

// onchange handlers wired to repopulate on organization change.
assert.ok(/onchange="CrmAdmin\.onOppOrgChange\(\)"/.test(js), 'opp org onchange wired');
ok('opportunity form org onchange wired to onOppOrgChange');
assert.ok(/onchange="CrmAdmin\.onActOrgChange\(\)"/.test(js), 'act org onchange wired');
ok('activity form org onchange wired to onActOrgChange');
assert.ok(/onchange="CrmAdmin\.onLinkDevisOrgChange\(\)"/.test(js), 'link devis org onchange wired');
ok('link devis form org onchange wired to onLinkDevisOrgChange');

// Collectors still read the same IDs (submitted value remains UUID).
assert.ok(js.indexOf("val('opp_contact_id')") !== -1, 'collectOpportunityForm reads opp_contact_id');
assert.ok(js.indexOf("val('act_opportunity_id')") !== -1, 'collectActivityForm reads act_opportunity_id');
assert.ok(js.indexOf("val('act_contact_id')") !== -1, 'collectActivityForm reads act_contact_id');
assert.ok(js.indexOf("val('link_devis_contact')") !== -1, 'submitLinkDevis reads link_devis_contact');
assert.ok(js.indexOf("val('link_devis_opp')") !== -1, 'submitLinkDevis reads link_devis_opp');
ok('collectors still read selector IDs (UUID values submitted unchanged)');

// --- Functional: scoped contact selector ---
section('RM01A-011: SCOPED CONTACT SELECTOR (functional)');

var mockContacts = [
  { id: 'contact-1', first_name: 'Jean', last_name: 'Dupont', job_title: 'Directeur', email: 'jean@acme.com' },
  { id: 'contact-2', first_name: 'Marie', last_name: 'Curie', job_title: 'Responsable', email: 'marie@acme.com' }
];
var mockOpps = [
  { id: 'opp-1', title: 'Convoyage Paris', stage: 'qualified' },
  { id: 'opp-2', title: 'Convoyage Lyon', stage: 'quote_sent' }
];

{
  var eqLog = [];
  var sc = makeSandbox(function () { return mockClientFromData(mockContacts, mockOpps, eqLog, null); });
  var CrmAdminC = sc.CrmAdmin;

  // Populate contacts scoped to org-1, preselect contact-2.
  eqLog.length = 0;
  var el = sc.getEl('opp_contact_id');
  el.innerHTML = '';
  el.value = '';
  await CrmAdminC._populateContactSelect('opp_contact_id', 'org-1', 'contact-2');
  assert.ok(el.innerHTML.indexOf('contact-1') !== -1, 'contact-1 UUID in options');
  assert.ok(el.innerHTML.indexOf('contact-2') !== -1, 'contact-2 UUID in options');
  assert.ok(el.innerHTML.indexOf('Jean Dupont') !== -1, 'human-readable label rendered');
  assert.ok(el.innerHTML.indexOf('Directeur') !== -1, 'job_title in label');
  assert.ok(el.innerHTML.indexOf('jean@acme.com') !== -1, 'email in label');
  assert.strictEqual(el.value, 'contact-2', 'preselected contact UUID retained');
  ok('contact selector renders UUID values + human-readable labels, preselects');

  // Scoping: query must filter by organization_id.
  var scopedEq = eqLog.filter(function (e) {
    return e.table === 'organization_contacts' && e.col === 'organization_id' && e.val === 'org-1';
  });
  assert.strictEqual(scopedEq.length, 1, 'contacts scoped by organization_id=org-1');
  ok('contact selector scoped via .eq(organization_id, org-1)');

  // Stale selection clears when the selected id is not in the org.
  el.innerHTML = '';
  el.value = 'stale-id';
  await CrmAdminC._populateContactSelect('opp_contact_id', 'org-1', 'contact-999');
  assert.strictEqual(el.value, '', 'stale contact selection cleared');
  ok('stale contact selection cleared (selectedId not in org)');
}

// --- Functional: scoped opportunity selector ---
section('RM01A-011: SCOPED OPPORTUNITY SELECTOR (functional)');

{
  var eqLogO = [];
  var so = makeSandbox(function () { return mockClientFromData(mockContacts, mockOpps, eqLogO, null); });
  var CrmAdminO = so.CrmAdmin;

  eqLogO.length = 0;
  var elO = so.getEl('act_opportunity_id');
  elO.innerHTML = '';
  elO.value = '';
  await CrmAdminO._populateOpportunitySelect('act_opportunity_id', 'org-1', 'opp-1');
  assert.ok(elO.innerHTML.indexOf('opp-1') !== -1, 'opp-1 UUID in options');
  assert.ok(elO.innerHTML.indexOf('Convoyage Paris') !== -1, 'opportunity title in label');
  assert.ok(elO.innerHTML.indexOf('Qualifiée') !== -1, 'stage label in option');
  assert.strictEqual(elO.value, 'opp-1', 'preselected opportunity UUID retained');
  ok('opportunity selector renders UUID values + human-readable labels, preselects');

  var scopedEqO = eqLogO.filter(function (e) {
    return e.table === 'crm_opportunities' && e.col === 'organization_id' && e.val === 'org-1';
  });
  assert.strictEqual(scopedEqO.length, 1, 'opps scoped by organization_id=org-1');
  ok('opportunity selector scoped via .eq(organization_id, org-1)');

  // Stale opportunity selection clears.
  elO.value = 'stale-opp';
  await CrmAdminO._populateOpportunitySelect('act_opportunity_id', 'org-1', 'opp-999');
  assert.strictEqual(elO.value, '', 'stale opportunity selection cleared');
  ok('stale opportunity selection cleared');
}

// --- Functional: empty / no-data / error states ---
section('RM01A-011: SELECTOR EMPTY / NO-DATA / ERROR STATES');

{
  // Empty org -> placeholder, no query.
  var se = makeSandbox(function () { return mockClientFromData([], [], null, null); });
  var CrmAdminE = se.CrmAdmin;
  var elE = se.getEl('opp_contact_id');
  await CrmAdminE._populateContactSelect('opp_contact_id', '', null);
  assert.ok(elE.innerHTML.indexOf('Sélectionnez une organisation') !== -1, 'empty-org placeholder');
  assert.strictEqual(elE.value, '', 'empty-org value blank');
  ok('empty organization -> placeholder, no query issued');
}

{
  // No contacts for org -> empty state message.
  var sn = makeSandbox(function () { return mockClientFromData([], [], null, null); });
  var CrmAdminN = sn.CrmAdmin;
  var elN = sn.getEl('opp_contact_id');
  await CrmAdminN._populateContactSelect('opp_contact_id', 'org-empty', null);
  assert.ok(elN.innerHTML.indexOf('Aucun contact') !== -1, 'no-contacts message');
  assert.strictEqual(elN.value, '', 'no-contacts value blank');
  ok('no available contacts -> empty-state message (no raw DB error)');
}

{
  // Fetch error -> error state message, no raw DB error exposed.
  var serr = makeSandbox(function () {
    return mockClientFromData([], [], null, { organization_contacts: { message: 'permission denied' } });
  });
  var CrmAdminErr = serr.CrmAdmin;
  var elErr = serr.getEl('opp_contact_id');
  await CrmAdminErr._populateContactSelect('opp_contact_id', 'org-err', null);
  assert.ok(elErr.innerHTML.indexOf('Erreur de chargement') !== -1, 'error-state message');
  assert.ok(elErr.innerHTML.indexOf('permission denied') === -1, 'raw DB error not exposed');
  assert.strictEqual(elErr.value, '', 'error value blank');
  ok('fetch error -> concise French error message, raw DB error not exposed');
}

// --- Functional: org change clears stale child selection ---
section('RM01A-011: ORG CHANGE CLEARS STALE CHILD SELECTION');

{
  var eqLogG = [];
  var sg = makeSandbox(function () { return mockClientFromData(mockContacts, mockOpps, eqLogG, null); });
  var CrmAdminG = sg.CrmAdmin;

  // Simulate a previously-selected contact for another org.
  var orgEl = sg.getEl('opp_organization_id');
  orgEl.value = 'org-2';
  var contactEl = sg.getEl('opp_contact_id');
  contactEl.value = 'stale-contact';

  // onOppOrgChange repopulates with selectedId=null -> clears.
  await CrmAdminG.onOppOrgChange();
  assert.strictEqual(contactEl.value, '', 'stale contact cleared on org change');
  ok('onOppOrgChange clears stale contact selection when organization changes');

  // Activity form: both opportunity and contact clear on org change.
  var actOrgEl = sg.getEl('act_organization_id');
  actOrgEl.value = 'org-2';
  var actOppEl = sg.getEl('act_opportunity_id');
  actOppEl.value = 'stale-opp';
  var actContactEl = sg.getEl('act_contact_id');
  actContactEl.value = 'stale-contact';
  await CrmAdminG.onActOrgChange();
  assert.strictEqual(actOppEl.value, '', 'stale activity opportunity cleared');
  assert.strictEqual(actContactEl.value, '', 'stale activity contact cleared');
  ok('onActOrgChange clears stale opportunity + contact selections');
}

// =========================================================
// SUMMARY
// =========================================================
console.log('\n=== RM-01C Test Summary ===');
console.log('Assertions passed: ' + pass);
console.log('Result: PASS\n');

} // end run()

run().catch(function (e) {
  console.error('\n=== RM-01C Test FAILED ===');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
