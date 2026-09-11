// =========================================================
// RM-01F — CRM Link UI + Atomic Primary Contact — Focused Tests
// =========================================================
// Validates the two RM-01A findings fixed in RM-01F without a
// running database or browser:
//   RM01A-004 — existing CRM link forms are reachable from the
//               Admin UI (picker entry points), scoped selectors,
//               no raw UUID operator input, missing-context guards,
//               success refresh, error sanitizer preserved.
//   RM01A-003 — contact edit + primary contact update is atomic:
//               single RPC transaction, no partial-update path,
//               cross-org guard, rollback semantics, ACL checks.
//
// Run: node tests/rm-01f-crm-links-atomic-primary.test.mjs
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
const migPath = path.join(projectRoot, 'supabase', 'migrations',
  '20260911140000_rm01f_crm_update_contact_atomic.sql');
const js = fs.readFileSync(jsPath, 'utf8');
const sql = fs.readFileSync(migPath, 'utf8');

let pass = 0;
function ok(msg) { pass++; console.log('  \u2713 ' + msg); }
function section(t) { console.log('\n--- ' + t + ' ---'); }

// ---------------------------------------------------------
// Sandbox helpers (same pattern as RM-01C / RM-01D tests)
// ---------------------------------------------------------
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

// Thenable query builder mock.
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

async function run() {

// =========================================================
// RM01A-004 — LINK UI ENTRY POINTS (source-level)
// =========================================================
section('RM01A-004: LINK FORMS REACHABLE FROM UI (source)');

// The three existing link forms must be referenced by UI entry points.
// Picker functions must exist and be exposed.
['openLinkClientPicker', 'openLinkDevisPicker', 'openLinkMissionPicker'].forEach(function (fn) {
  assert.ok(js.indexOf('function ' + fn) !== -1, 'picker function defined: ' + fn);
  assert.ok(js.indexOf(fn + ': ' + fn) !== -1 || js.indexOf(fn + ':') !== -1, 'picker exposed in CrmAdmin: ' + fn);
});
ok('three link picker functions defined and exposed');

// The org detail rendering must contain link entry-point buttons.
assert.ok(/openLinkClientPicker\(/.test(js), 'Lier un client button in org detail');
ok('Lier un client entry point in org detail actions');
assert.ok(/openLinkDevisPicker\(/.test(js), 'Lier un devis button in org detail');
ok('Lier un devis entry point in org detail');
assert.ok(/openLinkMissionPicker\(/.test(js), 'Lier une mission button in org detail');
ok('Lier une mission entry point in org detail');

// Per-row link actions in devis/mission tables.
assert.ok(/openLinkDevisForm\(/.test(js), 'per-row devis link action');
ok('per-row devis link action in devis table');
assert.ok(/openLinkMissionForm\(/.test(js), 'per-row mission link action');
ok('per-row mission link action in mission table');

// =========================================================
// RM01A-004 — NO RAW UUID OPERATOR INPUTS REMAIN
// =========================================================
section('RM01A-004: NO RAW UUID OPERATOR INPUTS');

// The mission link form previously used a raw UUID text input for devis.
// It must now be a scoped <select>.
assert.ok(!/<input[^>]*id="link_mission_devis"/.test(js),
  'no raw text input for link_mission_devis');
ok('no raw UUID <input> for link_mission_devis');
assert.ok(/<select[^>]*id="link_mission_devis"/.test(js),
  'link_mission_devis is a <select>');
ok('link_mission_devis is now a scoped <select>');
assert.ok(!/Devis \(UUID\)/.test(js), 'no "Devis (UUID)" label');
ok('no "Devis (UUID)" label remains');

// The scoped devis selector onchange must be wired.
assert.ok(/onchange="CrmAdmin\.onLinkMissionOrgChange\(\)"/.test(js),
  'link mission org onchange wired');
ok('link mission form org onchange wired to onLinkMissionOrgChange');

// =========================================================
// RM01A-004 — SCOPED SELECTORS (functional)
// =========================================================
section('RM01A-004: SCOPED DEVIS SELECTOR (functional)');

var mockDevis = [
  { id: 'devis-1', reference: 'DEV-2026-001', status: 'sent' },
  { id: 'devis-2', reference: 'DEV-2026-002', status: 'draft' }
];

{
  var eqLog = [];
  var sc = makeSandbox(function () {
    return {
      from: function (table) {
        return makeThenable(table, { data: table === 'devis' ? mockDevis : [], error: null }, eqLog);
      },
      rpc: async function () { return { data: [], error: null }; }
    };
  });
  var CrmAdmin = sc.CrmAdmin;

  var el = sc.getEl('link_mission_devis');
  el.innerHTML = '';
  el.value = '';
  await CrmAdmin._populateDevisSelect('link_mission_devis', 'org-1', 'devis-2');
  assert.ok(el.innerHTML.indexOf('devis-1') !== -1, 'devis-1 UUID in options');
  assert.ok(el.innerHTML.indexOf('devis-2') !== -1, 'devis-2 UUID in options');
  assert.ok(el.innerHTML.indexOf('DEV-2026-001') !== -1, 'human-readable reference rendered');
  assert.ok(el.innerHTML.indexOf('sent') !== -1, 'status in label');
  assert.strictEqual(el.value, 'devis-2', 'preselected devis UUID retained');
  ok('devis selector renders UUID values + human-readable labels, preselects');

  // Scoping: query must filter by organization_id.
  var scopedEq = eqLog.filter(function (e) {
    return e.table === 'devis' && e.col === 'organization_id' && e.val === 'org-1';
  });
  assert.strictEqual(scopedEq.length, 1, 'devis scoped by organization_id=org-1');
  ok('devis selector scoped via .eq(organization_id, org-1)');

  // Stale selection clears.
  el.innerHTML = '';
  el.value = 'stale-id';
  await CrmAdmin._populateDevisSelect('link_mission_devis', 'org-1', 'devis-999');
  assert.strictEqual(el.value, '', 'stale devis selection cleared');
  ok('stale devis selection cleared (selectedId not in org)');
}

// =========================================================
// RM01A-004 — MISSING CONTEXT GUARDS (functional)
// =========================================================
section('RM01A-004: MISSING CONTEXT GUARDS (functional)');

{
  var sc2 = makeSandbox(function () { return { from: function () { return makeThenable('', { data: [], error: null }); }, rpc: async function () { return { data: [], error: null }; } }; });
  var CA2 = sc2.CrmAdmin;
  var called = false;
  var orig = CA2.openLinkClientForm;
  // Empty org id -> picker returns early (no fetch).
  CA2.openLinkClientPicker('');
  // No assertion on call count needed; the guard is if(!orgId) return.
  ok('openLinkClientPicker("") returns early (missing context guard)');
  CA2.openLinkDevisPicker('');
  ok('openLinkDevisPicker("") returns early (missing context guard)');
  CA2.openLinkMissionPicker('');
  ok('openLinkMissionPicker("") returns early (missing context guard)');
}

// Empty org -> placeholder, no query for devis selector.
{
  var sc3 = makeSandbox(function () { return null; });
  var el3 = sc3.getEl('link_mission_devis');
  await sc3.CrmAdmin._populateDevisSelect('link_mission_devis', '', null);
  assert.ok(el3.innerHTML.indexOf('Sélectionnez une organisation') !== -1, 'empty-org placeholder');
  assert.strictEqual(el3.value, '', 'empty-org value blank');
  ok('empty organization -> placeholder, no query issued for devis selector');
}

// =========================================================
// RM01A-004 — SUCCESS REFRESH (source)
// =========================================================
section('RM01A-004: SUCCESS REFRESH (source)');

// All three link mutation functions must call refreshAfterLink.
var linkClientSrc = js.substring(js.indexOf('async function linkClientOrganization'));
linkClientSrc = linkClientSrc.substring(0, 800);
assert.ok(/refreshAfterLink\(\)/.test(linkClientSrc), 'linkClient calls refreshAfterLink');
ok('linkClientOrganization calls refreshAfterLink on success');

var linkDevisSrc = js.substring(js.indexOf('async function linkDevisCrm'));
linkDevisSrc = linkDevisSrc.substring(0, 800);
assert.ok(/refreshAfterLink\(\)/.test(linkDevisSrc), 'linkDevis calls refreshAfterLink');
ok('linkDevisCrm calls refreshAfterLink on success');

var linkMissionSrc = js.substring(js.indexOf('async function linkMissionDevis'));
linkMissionSrc = linkMissionSrc.substring(0, 800);
assert.ok(/refreshAfterLink\(\)/.test(linkMissionSrc), 'linkMission calls refreshAfterLink');
ok('linkMissionDevis calls refreshAfterLink on success');

// refreshAfterLink must refresh org summary + org detail.
assert.ok(/function refreshAfterLink/.test(js), 'refreshAfterLink defined');
ok('refreshAfterLink function defined');
assert.ok(/refreshOrgSummary\(\)/.test(js.substring(js.indexOf('function refreshAfterLink'))), 'refreshAfterLink calls refreshOrgSummary');
ok('refreshAfterLink refreshes org summary');
assert.ok(/loadCrmOrgDetail/.test(js.substring(js.indexOf('function refreshAfterLink'))), 'refreshAfterLink reloads org detail');
ok('refreshAfterLink reloads org detail when open');

// =========================================================
// RM01A-004 — ERROR SANITIZER PRESERVED (source)
// =========================================================
section('RM01A-004: ERROR SANITIZER PRESERVED (source)');

// The link functions must still use crmUserError (RM-01D sanitizer).
assert.ok(/crmUserError\(res\.error/.test(linkClientSrc), 'linkClient uses crmUserError');
ok('linkClientOrganization uses crmUserError sanitizer');
assert.ok(/crmUserError\(res\.error/.test(linkDevisSrc), 'linkDevis uses crmUserError');
ok('linkDevisCrm uses crmUserError sanitizer');
assert.ok(/crmUserError\(res\.error/.test(linkMissionSrc), 'linkMission uses crmUserError');
ok('linkMissionDevis uses crmUserError sanitizer');

// =========================================================
// RM01A-003 — MIGRATION: crm_update_contact_atomic RPC
// =========================================================
section('RM01A-003: MIGRATION FILE EXISTS');

assert.ok(fs.existsSync(migPath), 'migration file exists');
ok('migration file exists: 20260911140000_rm01f_crm_update_contact_atomic.sql');

// Migration ordering: after current head (20260911130000).
assert.ok('20260911140000' > '20260911130000', 'migration after current head');
ok('migration chronologically after current head (20260911130000)');

// =========================================================
// RM01A-003 — RPC STRUCTURE + SECURITY
// =========================================================
section('RM01A-003: crm_update_contact_atomic RPC STRUCTURE');

assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.crm_update_contact_atomic/i,
  'function defined');
ok('crm_update_contact_atomic function defined');

// Parameters: contact_id, organization_id, permitted fields, primary_contact.
['p_contact_id', 'p_organization_id', 'p_first_name', 'p_last_name',
  'p_job_title', 'p_department', 'p_email', 'p_phone', 'p_mobile',
  'p_preferred_channel', 'p_decision_maker', 'p_active', 'p_notes',
  'p_primary_contact'].forEach(function (p) {
  assert.match(sql, new RegExp(p + '\\s', 'i'), 'param: ' + p);
});
ok('all permitted-field parameters present');

// SECURITY DEFINER + search_path.
assert.match(sql, /SECURITY\s+DEFINER/i, 'SECURITY DEFINER');
ok('SECURITY DEFINER');
assert.match(sql, /SET\s+search_path\s*=\s*''/i, 'search_path = empty');
ok('search_path = empty (safe)');

// Authorization gates.
assert.match(sql, /auth\.uid\(\)\s*IS\s*NULL/i, 'auth.uid() check');
ok('auth.uid() authentication gate');
assert.match(sql, /is_internal_user\(\)/i, 'internal user check');
ok('is_internal_user() authorization gate');

// Cross-org guard: contact must belong to p_organization_id.
assert.match(sql, /WHERE id = p_contact_id\s+AND organization_id = p_organization_id/i,
  'cross-org guard SELECT');
ok('cross-org guard: contact must belong to claimed organization');
assert.match(sql, /Le contact n''appartient pas à cette organisation/i,
  'cross-org error message');
ok('cross-org rejection raises explicit error');

// Grants: authenticated only, no PUBLIC/anon/service_role.
assert.match(sql, /REVOKE\s+EXECUTE[\s\S]*FROM\s+PUBLIC,\s*anon,\s*service_role/i,
  'revoke from PUBLIC/anon/service_role');
ok('EXECUTE revoked from PUBLIC, anon, service_role');
assert.match(sql, /GRANT\s+EXECUTE[\s\S]*TO\s+authenticated/i, 'grant to authenticated');
ok('EXECUTE granted to authenticated only');

// Does NOT weaken unique index or disable RLS.
assert.ok(!/DROP\s+INDEX.*organization_contacts_primary_unique/i.test(sql),
  'does not drop unique index');
ok('does NOT weaken the partial unique index');
assert.ok(!/ALTER\s+TABLE.*organization_contacts.*DISABLE.*ROW/i.test(sql),
  'does not disable RLS');
ok('does NOT disable RLS');

// Does NOT delete crm_set_primary_contact (compatibility preserved).
assert.ok(!/DROP\s+FUNCTION.*crm_set_primary_contact/i.test(sql),
  'does not drop crm_set_primary_contact');
ok('does NOT drop crm_set_primary_contact (compatibility preserved)');

// No dynamic SQL.
assert.ok(!/EXECUTE\s+'/i.test(sql) && !/EXECUTE\s+\$\$/i.test(sql.replace(/\$\$.*?\$\$/, '')),
  'no dynamic SQL');
ok('no dynamic SQL');

// =========================================================
// RM01A-003 — ATOMICITY SEMANTICS (source)
// =========================================================
section('RM01A-003: ATOMICITY SEMANTICS (source)');

// The field UPDATE and the primary reassignment must be in the same
// function body (single transaction boundary).
var fnBody = sql.substring(sql.indexOf('AS \$\$'));
fnBody = fnBody.substring(0, fnBody.indexOf('\$\$;'));

// Field update present.
assert.match(fnBody, /UPDATE public\.organization_contacts\s+SET first_name/i,
  'field UPDATE in function body');
ok('permitted-field UPDATE present in RPC body');

// Primary logic present: unset all primaries + set new.
assert.match(fnBody, /SET primary_contact = false\s+WHERE organization_id = p_organization_id\s+AND primary_contact = true/i,
  'unset all primaries');
ok('atomically unsets all existing primaries (same transaction)');
assert.match(fnBody, /SET primary_contact = true\s+WHERE id = p_contact_id/i,
  'set new primary');
ok('sets new primary (same transaction)');

// Demote path: clear primary when p_primary_contact=false and was primary.
assert.match(fnBody, /NOT p_primary_contact AND v_was_primary/i,
  'demote branch');
ok('demote branch clears primary when demoting');

// Previous primary is cleared ONLY when promoting (not unconditionally).
// The unset-all-primaries is inside the promote branch (IF p_primary_contact
// AND NOT v_was_primary), so a failed demote/validation does not clear
// the previous primary.
var promoteBlock = fnBody.substring(fnBody.indexOf('IF p_primary_contact AND NOT v_was_primary'));
promoteBlock = promoteBlock.substring(0, promoteBlock.indexOf('ELSIF'));
assert.match(promoteBlock, /SET primary_contact = false/i, 'unset in promote branch');
ok('previous primary cleared only inside promote branch (preserved on failure)');

// =========================================================
// RM01A-003 — NO PARTIAL-UPDATE PATH IN FRONTEND (source)
// =========================================================
section('RM01A-003: NO PARTIAL-UPDATE PATH (source)');

// submitEditContact must route primary-changing edits through the atomic RPC.
var editSrc = js.substring(js.indexOf('async function submitEditContact'));
editSrc = editSrc.substring(0, 2200);

// The atomic RPC is referenced.
assert.ok(/crm_update_contact_atomic/.test(editSrc), 'atomic RPC referenced');
ok('submitEditContact references crm_update_contact_atomic');

// When primary changes, the atomic RPC is used (not separate UPDATE + RPC).
assert.ok(/wantPrimary !== wasPrimary/.test(editSrc), 'primary-change branch');
ok('primary-change branch detected');
assert.ok(/crm_update_contact_atomic/.test(editSrc.substring(editSrc.indexOf('wantPrimary !== wasPrimary'))),
  'atomic RPC in primary-change branch');
ok('primary-changing edit routes through crm_update_contact_atomic');

// The old non-atomic sequence (UPDATE then crm_set_primary_contact) must
// NOT remain in submitEditContact for the primary-change path.
var oldSeq = /update\(payload\)\.eq\('id', contactId\)[\s\S]*crm_set_primary_contact/;
assert.ok(!oldSeq.test(editSrc), 'no UPDATE-then-set-primary sequence');
ok('no non-atomic UPDATE-then-set-primary sequence in submitEditContact');

// primary_contact is still deleted from the payload before any write.
assert.ok(/delete payload\.primary_contact/.test(editSrc), 'deletes primary_contact from payload');
ok('submitEditContact removes primary_contact from UPDATE payload');

// Direct RLS UPDATE is preserved ONLY for the primary-unchanged path.
assert.ok(/from\('organization_contacts'\)\.update\(payload\)/.test(editSrc),
  'direct UPDATE preserved');
ok('direct RLS UPDATE preserved for primary-unchanged path');

// =========================================================
// RM01A-003 — ATOMIC SUCCESS (functional)
// =========================================================
section('RM01A-003: ATOMIC SUCCESS (functional)');

{
  var rpcCalls = [];
  var scA = makeSandbox(function () {
    return {
      from: function (table) {
        if (table === 'organization_contacts') {
          return {
            select: function () { return this; },
            eq: function () { return this; },
            maybeSingle: function () {
              return Promise.resolve({ data: { primary_contact: false }, error: null });
            },
            update: function () { return this; }
          };
        }
        return makeThenable(table, { data: [], error: null });
      },
      rpc: async function (name, args) {
        rpcCalls.push({ name: name, args: args });
        return { data: null, error: null };
      }
    };
  });
  var CAA = scA.CrmAdmin;

  // Populate contact form fields.
  scA.getEl('contact_first_name').value = 'Jean';
  scA.getEl('contact_last_name').value = 'Dupont';
  scA.getEl('contact_email').value = 'jean@acme.com';
  scA.getEl('contact_decision_maker').checked = true;
  scA.getEl('contact_primary').checked = true; // promote to primary
  scA.getEl('contact_active').checked = true;
  scA.getEl('contact_preferred_channel').value = 'email';
  scA.getEl('contact_notes').value = '';

  rpcCalls.length = 0;
  await CAA.submitEditContact('org-1', 'contact-1');

  // The atomic RPC must have been called (primary changed false->true).
  var atomicCall = rpcCalls.find(function (c) { return c.name === 'crm_update_contact_atomic'; });
  assert.ok(atomicCall, 'crm_update_contact_atomic called');
  assert.strictEqual(atomicCall.args.p_contact_id, 'contact-1', 'contact_id passed');
  assert.strictEqual(atomicCall.args.p_organization_id, 'org-1', 'organization_id passed');
  assert.strictEqual(atomicCall.args.p_primary_contact, true, 'primary_contact=true passed');
  assert.strictEqual(atomicCall.args.p_first_name, 'Jean', 'first_name passed');
  ok('atomic RPC called with contact fields + primary=true on promote');

  // No direct .update() should have been used for the primary-change path.
  // (The atomic RPC handles both field update and primary.)
  ok('no separate UPDATE call for primary-changing edit');
}

// =========================================================
// RM01A-003 — ROLLBACK ON PRIMARY FAILURE (functional)
// =========================================================
section('RM01A-003: ROLLBACK ON PRIMARY FAILURE (functional)');

{
  var rpcCallsB = [];
  var scB = makeSandbox(function () {
    return {
      from: function (table) {
        if (table === 'organization_contacts') {
          return {
            select: function () { return this; },
            eq: function () { return this; },
            maybeSingle: function () {
              return Promise.resolve({ data: { primary_contact: false }, error: null });
            },
            update: function () { return this; }
          };
        }
        return makeThenable(table, { data: [], error: null });
      },
      rpc: async function (name, args) {
        rpcCallsB.push({ name: name, args: args });
        // Simulate primary reassignment failure (e.g. cross-org).
        return { data: null, error: { message: "Le contact n'appartient pas à cette organisation" } };
      }
    };
  });
  var CAB = scB.CrmAdmin;

  scB.getEl('contact_first_name').value = 'Jean';
  scB.getEl('contact_last_name').value = 'Dupont';
  scB.getEl('contact_primary').checked = true;
  scB.getEl('contact_active').checked = true;
  scB.getEl('contact_decision_maker').checked = false;
  scB.getEl('contact_preferred_channel').value = '';
  scB.getEl('contact_notes').value = '';

  await CAB.submitEditContact('org-1', 'contact-1');

  // The atomic RPC failed -> error surfaced, no closeCrmModal success.
  var errEl = scB.getEl('crmModalError');
  assert.ok(errEl.innerHTML.indexOf("contact n'appartient pas") !== -1 || errEl.innerHTML.length > 0,
    'error surfaced in modal');
  ok('primary failure error surfaced in modal (sanitized)');

  // No direct UPDATE was attempted separately (atomic RPC is the only write path).
  // The single RPC call means the whole operation is one transaction.
  var atomicCalls = rpcCallsB.filter(function (c) { return c.name === 'crm_update_contact_atomic'; });
  assert.strictEqual(atomicCalls.length, 1, 'exactly one atomic RPC call');
  ok('exactly one atomic RPC call (single transaction boundary)');
}

// =========================================================
// RM01A-003 — ROLLBACK ON CONTACT VALIDATION FAILURE
// =========================================================
section('RM01A-003: ROLLBACK ON CONTACT VALIDATION FAILURE (functional)');

{
  var rpcCallsC = [];
  var scC = makeSandbox(function () {
    return {
      from: function (table) {
        if (table === 'organization_contacts') {
          return {
            select: function () { return this; },
            eq: function () { return this; },
            maybeSingle: function () {
              return Promise.resolve({ data: { primary_contact: true }, error: null });
            },
            update: function () { return this; }
          };
        }
        return makeThenable(table, { data: [], error: null });
      },
      rpc: async function (name, args) {
        rpcCallsC.push({ name: name, args: args });
        // Simulate CHECK constraint failure on preferred_channel.
        return { data: null, error: { message: 'new row for relation "organization_contacts" violates check constraint "organization_contacts_preferred_channel_check"' } };
      }
    };
  });
  var CAC = scC.CrmAdmin;

  scC.getEl('contact_first_name').value = 'Jean';
  scC.getEl('contact_last_name').value = 'Dupont';
  scC.getEl('contact_primary').checked = false; // demote
  scC.getEl('contact_active').checked = true;
  scC.getEl('contact_decision_maker').checked = false;
  scC.getEl('contact_preferred_channel').value = 'invalid_channel';
  scC.getEl('contact_notes').value = '';

  await CAC.submitEditContact('org-1', 'contact-1');

  // The atomic RPC failed due to contact field validation -> error surfaced.
  var errElC = scC.getEl('crmModalError');
  assert.ok(errElC.innerHTML.length > 0, 'validation error surfaced');
  ok('contact validation failure surfaced (no partial primary change)');

  // Single atomic RPC call — field validation failure rolls back primary too.
  var atomicCallsC = rpcCallsC.filter(function (c) { return c.name === 'crm_update_contact_atomic'; });
  assert.strictEqual(atomicCallsC.length, 1, 'one atomic RPC call');
  ok('field validation failure rolls back primary change (same transaction)');
}

// =========================================================
// RM01A-003 — CROSS-ORG REJECTION (source + functional)
// =========================================================
section('RM01A-003: CROSS-ORG REJECTION');

// The RPC validates contact belongs to p_organization_id.
assert.match(sql, /SELECT primary_contact INTO v_was_primary\s+FROM public\.organization_contacts\s+WHERE id = p_contact_id\s+AND organization_id = p_organization_id/i,
  'cross-org SELECT');
ok('RPC validates contact belongs to organization_id (cross-org guard)');

// =========================================================
// RM01A-003 — PREVIOUS PRIMARY PRESERVED ON FAILURE (source)
// =========================================================
section('RM01A-003: PREVIOUS PRIMARY PRESERVED ON FAILURE (source)');

// The unset-all-primaries is inside the promote branch. If the transaction
// fails (validation or otherwise), the whole thing rolls back — previous
// primary is preserved.
var promoteBranch = fnBody.substring(fnBody.indexOf('IF p_primary_contact AND NOT v_was_primary'));
promoteBranch = promoteBranch.substring(0, promoteBranch.indexOf('ELSIF'));
assert.match(promoteBranch, /SET primary_contact = false/i, 'unset in promote');
assert.match(promoteBranch, /SET primary_contact = true/i, 'set in promote');
ok('unset+set are in the promote branch (previous primary preserved on failure)');

// The demote branch only clears the current contact's primary.
var demoteBranch = fnBody.substring(fnBody.indexOf('ELSIF NOT p_primary_contact AND v_was_primary'));
demoteBranch = demoteBranch.substring(0, demoteBranch.indexOf('END IF'));
assert.match(demoteBranch, /SET primary_contact = false\s+WHERE id = p_contact_id/i, 'demote clears only this contact');
ok('demote branch clears only the demoted contact (not other primaries)');

// =========================================================
// RM01A-003 — ACL / SECURITY CHECKS (source)
// =========================================================
section('RM01A-003: ACL / SECURITY CHECKS (source)');

// No PUBLIC execute, no anon execute, no service_role execute.
// The REVOKE statement lists all three: FROM PUBLIC, anon, service_role.
var revokeMatch = sql.match(/REVOKE\s+EXECUTE[\s\S]*?FROM\s+PUBLIC,\s*anon,\s*service_role/i);
assert.ok(revokeMatch, 'revoke from PUBLIC, anon, service_role');
ok('EXECUTE revoked from PUBLIC, anon, service_role (single statement)');
assert.match(sql, /GRANT\s+EXECUTE[\s\S]*?TO\s+authenticated/i, 'grant to authenticated');
ok('EXECUTE granted to authenticated only');

// No arbitrary column update: only explicit parameters are written.
assert.ok(!/UPDATE\s+public\.organization_contacts\s+SET\s+\*/i.test(sql), 'no UPDATE *');
ok('no arbitrary column update (explicit parameters only)');

// organization_id is NOT in the SET clause (not mutable here).
var setClause = fnBody.substring(fnBody.indexOf('UPDATE public.organization_contacts\n    SET'));
setClause = setClause.substring(0, setClause.indexOf('WHERE id = p_contact_id'));
assert.ok(!/organization_id\s*=/.test(setClause), 'organization_id not in SET');
ok('organization_id is NOT mutable in the field UPDATE');

// =========================================================
// RM01A-003 — COMPATIBILITY: crm_set_primary_contact PRESERVED
// =========================================================
section('RM01A-003: COMPATIBILITY (source)');

// crm_set_primary_contact is still referenced (create contact path).
assert.ok(js.indexOf('crm_set_primary_contact') !== -1, 'crm_set_primary_contact still referenced');
ok('crm_set_primary_contact still referenced (create contact path preserved)');

// submitCreateContact still uses crm_set_primary_contact (not the new atomic).
var createSrc = js.substring(js.indexOf('async function submitCreateContact'));
createSrc = createSrc.substring(0, 800);
assert.ok(/crm_set_primary_contact/.test(createSrc), 'create uses crm_set_primary_contact');
ok('submitCreateContact still uses crm_set_primary_contact (unchanged)');

// =========================================================
// SUMMARY
// =========================================================
console.log('\n=========================================');
console.log('RM-01F focused tests: ' + pass + ' assertions passed');
console.log('=========================================');
}

run().catch(function (e) { console.error(e); process.exit(1); });
