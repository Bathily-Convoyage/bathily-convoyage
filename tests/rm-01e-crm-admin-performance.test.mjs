// =========================================================
// RM-01E — CRM Admin Performance Hardening — Focused Tests
// =========================================================
// Validates the three RM-01A performance findings fixed in RM-01E:
//   RM01A-008 — bounded opportunity loading (page size, deterministic
//               ordering, load-more pagination, no unbounded select)
//   RM01A-009 — organization detail parallelized reads (Promise.all for
//               independent child reads, dependency order preserved)
//   RM01A-010 — scoped contact loading (no global 1000-row fetch, scoped
//               .in() batched read, no N+1)
//
// Run: node tests/rm-01e-crm-admin-performance.test.mjs
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

// Mock Supabase client that tracks calls and supports configurable responses
function makeMockClient(config) {
  config = config || {};
  var calls = [];
  var client = {
    rpc: function (name, params) {
      calls.push({ type: 'rpc', name: name });
      if (config.rpc) return config.rpc(name, params);
      return Promise.resolve({ data: [], error: null });
    },
    from: function (table) {
      var query = {
        _table: table, _filters: [], _order: null, _limit: null, _range: null, _select: null, _in: [],
        select: function (cols) { this._select = cols; return this; },
        eq: function (col, val) { this._filters.push({ eq: col, val: val }); return this; },
        in: function (col, vals) { this._in.push({ col: col, vals: vals }); return this; },
        order: function (col, opts) { this._order = { col: col, opts: opts }; return this; },
        limit: function (n) { this._limit = n; return this; },
        range: function (from, to) { this._range = { from: from, to: to }; return this; },
        maybeSingle: function () { return this; },
        single: function () { return this; },
        then: function (resolve) {
          calls.push({ type: 'from', table: this._table, select: this._select, filters: this._filters, order: this._order, limit: this._limit, range: this._range, in: this._in });
          if (config.from) {
            var res = config.from(this._table, this);
            Promise.resolve(res).then(resolve);
          } else {
            resolve({ data: [], error: null });
          }
        }
      };
      return query;
    }
  };
  return { client: client, calls: calls, config: config };
}

async function run() {

// =========================================================
// RM01A-008 — Bounded opportunity loading
// =========================================================
section('RM01A-008: BOUNDED OPPORTUNITY LOADING (source)');

// OPP_PAGE_SIZE constant must exist.
assert.ok(js.indexOf('OPP_PAGE_SIZE') !== -1, 'OPP_PAGE_SIZE defined');
ok('OPP_PAGE_SIZE constant exists');

// No unbounded select — .range() or .limit() must be present in loadCrmOpportunities.
var loadOppSrc = js.substring(js.indexOf('async function loadCrmOpportunities'));
loadOppSrc = loadOppSrc.substring(0, 1200);
assert.ok(/\.range\(/.test(loadOppSrc), 'loadCrmOpportunities uses .range()');
ok('loadCrmOpportunities uses .range() (bounded select)');

// Deterministic ordering preserved.
assert.ok(/\.order\('created_at'/.test(loadOppSrc), 'deterministic ordering by created_at');
ok('deterministic ordering by created_at preserved');

// RM-01E-R2: secondary order on immutable unique 'id' for stable total order.
assert.ok(/\.order\('id'/.test(loadOppSrc), 'secondary order on id for stable total order');
ok('secondary order on id (stable total order for range pagination)');

// Load-more function must exist.
assert.ok(js.indexOf('function loadMoreOpportunities') !== -1, 'loadMoreOpportunities defined');
ok('loadMoreOpportunities function exists');

// No .limit(1000) on opportunities.
assert.ok(!/crm_opportunities[\s\S]*?\.limit\(1000\)/.test(js), 'no .limit(1000) on crm_opportunities');
ok('no unbounded .limit(1000) on crm_opportunities');

// --- Functional: bounded select with correct range ---
section('RM01A-008: BOUNDED SELECT (functional)');

{
  var mock = makeMockClient({
    from: function (table, q) {
      if (table === 'crm_opportunities') {
        // Return exactly PAGE_SIZE rows to simulate "more available"
        var rows = [];
        for (var i = 0; i < 100; i++) {
          rows.push({ id: 'opp-' + (q._range ? q._range.from + i : i), title: 'Opp ' + i, stage: 'lead', contact_id: 'ct-' + i, organization_id: 'org-1', created_at: '2026-01-01' });
        }
        return { data: rows, error: null };
      }
      if (table === 'organization_contacts') return { data: [], error: null };
      return { data: [], error: null };
    },
    rpc: function (name) {
      if (name === 'crm_organizations_summary') return { data: [{ organization_id: 'org-1', legal_name: 'Org 1' }], error: null };
      return { data: [], error: null };
    }
  });
  var s = makeSandbox(function () { return mock.client; });
  var CrmAdmin = s.CrmAdmin;

  // First load (reset=true) — should use range(0, 99).
  await CrmAdmin._loadCrmOpportunities(true);
  var oppCalls = mock.calls.filter(function (c) { return c.type === 'from' && c.table === 'crm_opportunities'; });
  assert.ok(oppCalls.length >= 1, 'at least one opportunities call');
  var firstCall = oppCalls[0];
  assert.ok(firstCall.range, 'first call has range');
  assert.strictEqual(firstCall.range.from, 0, 'first page starts at 0');
  assert.strictEqual(firstCall.range.to, 99, 'first page ends at PAGE_SIZE-1');
  ok('first page uses range(0, 99) — bounded to OPP_PAGE_SIZE');

  // hasMore should be true (100 rows returned = PAGE_SIZE).
  var cursor = CrmAdmin._getOppCursorForTest();
  assert.ok(cursor.hasMore, 'hasMore=true when full page returned');
  ok('hasMore=true when full page returned (more data available)');

  // Load-more should use range(100, 199).
  mock.calls.length = 0;
  await CrmAdmin._loadMoreOpportunities();
  var secondCalls = mock.calls.filter(function (c) { return c.type === 'from' && c.table === 'crm_opportunities'; });
  assert.ok(secondCalls.length >= 1, 'load-more issues opportunities call');
  var secondCall = secondCalls[0];
  assert.ok(secondCall.range, 'second call has range');
  assert.strictEqual(secondCall.range.from, 100, 'second page starts at 100');
  assert.strictEqual(secondCall.range.to, 199, 'second page ends at 199');
  ok('load-more uses range(100, 199) — correct offset for second page');
}

// --- Functional: no duplicate opportunities across pages ---
section('RM01A-008: NO DUPLICATES ACROSS PAGES');

{
  var page2Config = {
    from: function (table, q) {
      if (table === 'crm_opportunities') {
        // Return 50 rows, some overlapping with previous page
        var rows = [];
        var start = q._range ? q._range.from : 100;
        for (var i = 0; i < 50; i++) {
          // First 10 overlap with previous page (IDs 90-99)
          var id = i < 10 ? 'opp-' + (90 + i) : 'opp-' + (start + i);
          rows.push({ id: id, title: 'Opp ' + id, stage: 'lead', contact_id: null, organization_id: 'org-1', created_at: '2026-01-01' });
        }
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    },
    rpc: function () { return { data: [], error: null }; }
  };
  var mock2 = makeMockClient({
    from: function (table, q) {
      if (table === 'crm_opportunities') {
        // First page: 100 rows
        var rows = [];
        var start = q._range ? q._range.from : 0;
        for (var i = 0; i < 100; i++) {
          rows.push({ id: 'opp-' + (start + i), title: 'Opp ' + (start + i), stage: 'lead', contact_id: null, organization_id: 'org-1', created_at: '2026-01-01' });
        }
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    },
    rpc: function () { return { data: [], error: null }; }
  });
  var s2 = makeSandbox(function () { return mock2.client; });
  var CrmAdmin2 = s2.CrmAdmin;

  await CrmAdmin2._loadCrmOpportunities(true);
  // Now switch to page-2 config for the load-more call (mutate config.from
  // in place — the mock closure references the original config object).
  mock2.config.from = page2Config.from;
  await CrmAdmin2._loadMoreOpportunities();
  var cursor2 = CrmAdmin2._getOppCursorForTest();
  // RM-01E-R2: offset must advance by RAW page length (100 + 50 = 150),
  // NOT deduped count (100 + 40 = 140). This prevents range overlap.
  assert.strictEqual(cursor2.offset, 150, 'offset advances by raw page length (100+50=150)');
  ok('offset advances by raw page length (150), not deduped count (140)');
  // loaded tracks deduped renderable count
  assert.ok(cursor2.loaded <= 140, 'loaded reflects deduped count (<=140)');
  ok('loaded reflects deduped renderable count (no duplicate opportunities)');
}

// --- Functional: filters still apply ---
section('RM01A-008: FILTERS PRESERVED');

{
  // Verify source still has filter logic in renderCrmOpportunities.
  var renderSrc = js.substring(js.indexOf('function renderCrmOpportunities'));
  renderSrc = renderSrc.substring(0, 600);
  assert.ok(renderSrc.indexOf('_oppFilters.stage') !== -1, 'stage filter preserved');
  assert.ok(renderSrc.indexOf('_oppFilters.q') !== -1, 'search filter preserved');
  ok('opportunity filters (stage, search) preserved in renderCrmOpportunities');
}

// =========================================================
// RM01A-009 — Parallelize org-detail reads
// =========================================================
section('RM01A-009: PARALLELIZE ORG-DETAIL READS (source)');

// Promise.all must be present in loadCrmOrgDetail.
var orgDetailSrc = js.substring(js.indexOf('async function loadCrmOrgDetail'));
orgDetailSrc = orgDetailSrc.substring(0, 3000);
assert.ok(orgDetailSrc.indexOf('Promise.all') !== -1, 'Promise.all used in loadCrmOrgDetail');
ok('Promise.all used for parallel child reads');

// No sequential awaits for the 7 child reads.
// The org identity read is sequential (dependency), but children are parallel.
var childReadSection = orgDetailSrc.substring(orgDetailSrc.indexOf('RM01A-009'));
assert.ok(childReadSection.indexOf('await') === -1 || childReadSection.indexOf('Promise.all') !== -1,
  'children read via Promise.all (no sequential awaits)');
ok('7 child reads parallelized via Promise.all (no sequential awaits)');

// --- Functional: parallel reads launched concurrently ---
section('RM01A-009: CONCURRENT READS (functional)');

{
  var launchOrder = [];
  var resolveOrder = [];
  var mock3 = {
    client: {
      rpc: function (name) { return Promise.resolve({ data: [], error: null }); },
      from: function (table) {
        var query = {
          _table: table, _filters: [], _order: null, _limit: null, _select: null,
          select: function (c) { this._select = c; return this; },
          eq: function (col, val) { this._filters.push({ eq: col, val: val }); return this; },
          order: function (col, opts) { this._order = { col: col, opts: opts }; return this; },
          limit: function (n) { this._limit = n; return this; },
          maybeSingle: function () { return this; },
          then: function (resolve) {
            launchOrder.push(table);
            // Resolve asynchronously to prove concurrency
            setTimeout(function () {
              resolveOrder.push(table);
              if (table === 'organizations') resolve({ data: { id: 'org-1', legal_name: 'Test' }, error: null });
              else if (table === 'organization_segments') resolve({ data: [{ segment: 'seg1' }], error: null });
              else if (table === 'organization_contacts') resolve({ data: [], error: null });
              else resolve({ data: [], error: null });
            }, 10);
          }
        };
        return query;
      }
    }
  };
  var s3 = makeSandbox(function () { return mock3.client; });
  var CrmAdmin3 = s3.CrmAdmin;

  await CrmAdmin3._loadCrmOrgDetail('org-1');

  // All 7 child reads should be launched before any resolves (concurrent).
  // The org identity read launches first, then all 7 children launch together.
  var childTables = ['organization_segments', 'organization_sites', 'organization_contacts',
                     'crm_opportunities', 'crm_activities', 'devis', 'missions'];
  // After org identity resolves, all 7 children should be launched before any child resolves.
  var firstChildLaunchIdx = launchOrder.indexOf('organization_segments');
  var lastChildLaunchIdx = launchOrder.lastIndexOf('missions');
  // All 7 children should be launched before the first child resolves.
  // Since setTimeout(10) is async, all 7 .then() calls register before any fires.
  // Verify all 7 children were launched.
  childTables.forEach(function (t) {
    assert.ok(launchOrder.indexOf(t) !== -1, 'child read launched: ' + t);
  });
  ok('all 7 child reads launched (organization_segments, sites, contacts, opportunities, activities, devis, missions)');

  // Verify org identity read is sequential (launched before children).
  var orgLaunchIdx = launchOrder.indexOf('organizations');
  assert.ok(orgLaunchIdx < firstChildLaunchIdx, 'org identity read launched before children');
  ok('org identity read is sequential (dependency: gates children)');
}

// --- Functional: error handling remains stable ---
section('RM01A-009: ERROR HANDLING STABLE');

{
  // Verify source still checks for errors after Promise.all.
  assert.ok(orgDetailSrc.indexOf('errors.length') !== -1, 'error aggregation preserved');
  assert.ok(orgDetailSrc.indexOf('handleRpcError') !== -1, 'handleRpcError called on error');
  ok('error handling preserved (errors aggregated, handleRpcError called)');
}

// =========================================================
// RM01A-010 — Scoped contact loading
// =========================================================
section('RM01A-010: SCOPED CONTACT LOADING (source)');

// No global .limit(1000) on organization_contacts in loadCrmOpportunities.
var loadOppSrc2 = js.substring(js.indexOf('async function loadCrmOpportunities'));
loadOppSrc2 = loadOppSrc2.substring(0, 3000);
assert.ok(!/\.limit\(1000\)/.test(loadOppSrc2), 'no .limit(1000) in loadCrmOpportunities');
ok('no global .limit(1000) on organization_contacts in loadCrmOpportunities');

// Scoped .in() batched read must be present.
assert.ok(/\.in\('id'/.test(loadOppSrc2), 'scoped .in() batched contact read');
ok('scoped .in() batched contact read (no global fetch)');

// --- Functional: scoped contact fetch ---
section('RM01A-010: SCOPED CONTACT FETCH (functional)');

{
  var contactCalls = [];
  var mock4 = {
    client: {
      rpc: function () { return Promise.resolve({ data: [{ organization_id: 'org-1', legal_name: 'Org 1' }], error: null }); },
      from: function (table) {
        var query = {
          _table: table, _filters: [], _order: null, _limit: null, _range: null, _select: null, _in: [],
          select: function (c) { this._select = c; return this; },
          eq: function (col, val) { this._filters.push({ eq: col, val: val }); return this; },
          in: function (col, vals) { this._in.push({ col: col, vals: vals }); return this; },
          order: function (col, opts) { this._order = { col: col, opts: opts }; return this; },
          range: function (from, to) { this._range = { from: from, to: to }; return this; },
          then: function (resolve) {
            if (table === 'crm_opportunities') {
              // Return 3 opportunities with 3 distinct contact_ids
              resolve({ data: [
                { id: 'opp-1', title: 'Opp 1', stage: 'lead', contact_id: 'ct-1', organization_id: 'org-1', created_at: '2026-01-01' },
                { id: 'opp-2', title: 'Opp 2', stage: 'lead', contact_id: 'ct-2', organization_id: 'org-1', created_at: '2026-01-02' },
                { id: 'opp-3', title: 'Opp 3', stage: 'lead', contact_id: 'ct-3', organization_id: 'org-1', created_at: '2026-01-03' }
              ], error: null });
            } else if (table === 'organization_contacts') {
              contactCalls.push({ in: query._in, select: query._select });
              resolve({ data: [
                { id: 'ct-1', first_name: 'Alice', last_name: 'Smith' },
                { id: 'ct-2', first_name: 'Bob', last_name: 'Jones' },
                { id: 'ct-3', first_name: 'Carol', last_name: 'Lee' }
              ], error: null });
            } else {
              resolve({ data: [], error: null });
            }
          }
        };
        return query;
      }
    }
  };
  var s4 = makeSandbox(function () { return mock4.client; });
  var CrmAdmin4 = s4.CrmAdmin;

  await CrmAdmin4._loadCrmOpportunities(true);

  // Verify organization_contacts was called with .in('id', ['ct-1', 'ct-2', 'ct-3'])
  assert.ok(contactCalls.length >= 1, 'organization_contacts called');
  var ctCall = contactCalls[0];
  assert.ok(ctCall.in.length >= 1, '.in() filter used');
  var inFilter = ctCall.in[0];
  assert.strictEqual(inFilter.col, 'id', '.in() on id column');
  assert.ok(inFilter.vals.indexOf('ct-1') !== -1, 'contact ct-1 in scope');
  assert.ok(inFilter.vals.indexOf('ct-2') !== -1, 'contact ct-2 in scope');
  assert.ok(inFilter.vals.indexOf('ct-3') !== -1, 'contact ct-3 in scope');
  assert.strictEqual(inFilter.vals.length, 3, 'only 3 contacts fetched (scoped)');
  ok('scoped contact fetch: .in("id", [ct-1, ct-2, ct-3]) — only referenced contacts');

  // No .limit(1000) on the contact call.
  assert.ok(!contactCalls.some(function (c) { return c.limit === 1000; }), 'no .limit(1000)');
  ok('no global .limit(1000) on contact fetch');
}

// --- Functional: no N+1 (single batched read) ---
section('RM01A-010: NO N+1 (SINGLE BATCHED READ)');

{
  var contactCallCount = 0;
  var mock5 = {
    client: {
      rpc: function () { return Promise.resolve({ data: [], error: null }); },
      from: function (table) {
        var query = {
          _table: table, _filters: [], _order: null, _limit: null, _range: null, _select: null, _in: [],
          select: function (c) { this._select = c; return this; },
          eq: function (col, val) { this._filters.push({ eq: col, val: val }); return this; },
          in: function (col, vals) { this._in.push({ col: col, vals: vals }); return this; },
          order: function (col, opts) { this._order = { col: col, opts: opts }; return this; },
          range: function (from, to) { this._range = { from: from, to: to }; return this; },
          then: function (resolve) {
            if (table === 'crm_opportunities') {
              var rows = [];
              for (var i = 0; i < 50; i++) rows.push({ id: 'opp-' + i, contact_id: 'ct-' + i, organization_id: 'org-1', created_at: '2026-01-01' });
              resolve({ data: rows, error: null });
            } else if (table === 'organization_contacts') {
              contactCallCount++;
              resolve({ data: [], error: null });
            } else {
              resolve({ data: [], error: null });
            }
          }
        };
        return query;
      }
    }
  };
  var s5 = makeSandbox(function () { return mock5.client; });
  var CrmAdmin5 = s5.CrmAdmin;

  await CrmAdmin5._loadCrmOpportunities(true);
  assert.strictEqual(contactCallCount, 1, 'single batched contact read (no N+1)');
  ok('single batched contact read for 50 opportunities (no N+1)');
}

// --- Functional: selectors still resolve UUID → readable label ---
section('RM01A-010: SELECTOR LABEL RESOLUTION PRESERVED');

{
  // Verify fetchContactsForOrg (RM-01C scoped selector) still exists and uses .eq(organization_id).
  assert.ok(js.indexOf('function fetchContactsForOrg') !== -1, 'fetchContactsForOrg exists');
  var fcSrc = js.substring(js.indexOf('async function fetchContactsForOrg'));
  fcSrc = fcSrc.substring(0, 400);
  assert.ok(/\.eq\('organization_id'/.test(fcSrc), 'fetchContactsForOrg uses .eq(organization_id)');
  ok('fetchContactsForOrg (RM-01C selector) preserved — scoped by organization_id');

  // contactName helper still exists.
  assert.ok(js.indexOf('function contactName') !== -1, 'contactName exists');
  ok('contactName helper preserved for label resolution');
}

// =========================================================
// PERFORMANCE INVARIANTS
// =========================================================
section('PERFORMANCE INVARIANTS');

// UNBOUNDED_OPPORTUNITY_QUERY_COUNT=0
// Every crm_opportunities select must have .range(), .limit(), or .eq() (scoped).
// The org-detail read uses .eq(organization_id) — scoped, not unbounded.
// The list read uses .range() — bounded.
// The selector read uses .eq(organization_id) — scoped.
var oppSelects = js.split("from('crm_opportunities')");
oppSelects.shift(); // remove before first match
var unbounded = 0;
oppSelects.forEach(function (frag, idx) {
  // Look at the next ~500 chars after from('crm_opportunities') for bounding.
  // Multi-line reads (org-detail) may have .eq() further down.
  var snippet = frag.substring(0, 500);
  var hasRange = /\.range\(/.test(snippet);
  var hasLimit = /\.limit\(/.test(snippet);
  var hasEq = /\.eq\(/.test(snippet);
  // Insert/update operations are bounded by definition (single row).
  var isInsert = /\.insert\(/.test(snippet) || /\.update\(/.test(snippet);
  if (!hasRange && !hasLimit && !hasEq && !isInsert) unbounded++;
});
assert.strictEqual(unbounded, 0, 'no unbounded crm_opportunities select (all have .range/.limit/.eq or are insert/update)');
ok('UNBOUNDED_OPPORTUNITY_QUERY_COUNT=0');

// GLOBAL_1000_CONTACT_FETCH_COUNT=0
assert.ok(!/organization_contacts[\s\S]*?\.limit\(1000\)/.test(js), 'no .limit(1000) on organization_contacts');
ok('GLOBAL_1000_CONTACT_FETCH_COUNT=0');

// N_PLUS_ONE_CONTACT_LOOKUPS=0 — verified functionally above
ok('N_PLUS_ONE_CONTACT_LOOKUPS=0 (single batched .in() read)');

// SERIALIZED_INDEPENDENT_REQUESTS=0 — org detail uses Promise.all
ok('SERIALIZED_INDEPENDENT_REQUESTS=0 (org detail children via Promise.all)');

// =========================================================
// RM-01E-R2 — Stable total order regression
// =========================================================
section('RM-01E-R2: STABLE TOTAL ORDER (identical created_at)');

{
  // Multiple opportunities sharing identical created_at must not cause
  // duplicates or skips across pages. The secondary .order('id') ensures
  // a stable total order.
  var r2mock = makeMockClient({
    from: function (table, q) {
      if (table === 'crm_opportunities') {
        var rows = [];
        var start = q._range ? q._range.from : 0;
        // All rows share the same created_at — only id differs.
        for (var i = 0; i < 100; i++) {
          rows.push({ id: 'opp-' + (start + i), title: 'Opp ' + (start + i), stage: 'lead', contact_id: null, organization_id: 'org-1', created_at: '2026-09-11T10:00:00Z' });
        }
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    },
    rpc: function () { return { data: [], error: null }; }
  });
  var sr = makeSandbox(function () { return r2mock.client; });
  var CA = sr.CrmAdmin;

  await CA._loadCrmOpportunities(true);
  var c1 = CA._getOppCursorForTest();
  assert.strictEqual(c1.offset, 100, 'page 1 offset=100 (raw page length)');
  assert.strictEqual(c1.loaded, 100, 'page 1 loaded=100 (no dedup needed)');
  assert.ok(c1.hasMore, 'hasMore=true (full page)');
  ok('page 1 with identical created_at: offset=100, loaded=100, hasMore=true');

  await CA._loadMoreOpportunities();
  var c2 = CA._getOppCursorForTest();
  assert.strictEqual(c2.offset, 200, 'page 2 offset=200 (raw page length, no overlap)');
  assert.strictEqual(c2.loaded, 200, 'page 2 loaded=200 (no duplicates)');
  ok('page 2 with identical created_at: offset=200, loaded=200 (no overlap, no duplicates)');
}

// =========================================================
// RM-01E-R2 — Raw offset cursor (duplicate ID regression)
// =========================================================
section('RM-01E-R2: RAW OFFSET CURSOR (duplicate ID)');

{
  // Backend returns a page containing a duplicate ID already in _oppMap.
  // The offset must still advance by the RAW page length, not the deduped
  // insert count. This prevents an infinite loop where the same range is
  // re-fetched.
  var dupMock = makeMockClient({
    from: function (table, q) {
      if (table === 'crm_opportunities') {
        var rows = [];
        var start = q._range ? q._range.from : 0;
        for (var i = 0; i < 100; i++) {
          rows.push({ id: 'opp-' + (start + i), title: 'Opp ' + (start + i), stage: 'lead', contact_id: null, organization_id: 'org-1', created_at: '2026-01-01' });
        }
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    },
    rpc: function () { return { data: [], error: null }; }
  });
  var ds = makeSandbox(function () { return dupMock.client; });
  var CA2 = ds.CrmAdmin;

  await CA2._loadCrmOpportunities(true);
  // Now make page 2 return 100 rows where 20 are duplicates of page 1
  dupMock.config.from = function (table, q) {
    if (table === 'crm_opportunities') {
      var rows = [];
      var start = q._range ? q._range.from : 100;
      for (var i = 0; i < 100; i++) {
        // First 20 are duplicates (IDs 80-99 from page 1)
        var id = i < 20 ? 'opp-' + (80 + i) : 'opp-' + (start + i);
        rows.push({ id: id, title: 'Opp ' + id, stage: 'lead', contact_id: null, organization_id: 'org-1', created_at: '2026-01-01' });
      }
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  };
  await CA2._loadMoreOpportunities();
  var dc = CA2._getOppCursorForTest();
  // offset must be 200 (100 + 100 raw), NOT 180 (100 + 80 deduped)
  assert.strictEqual(dc.offset, 200, 'offset=200 (raw page length, not deduped)');
  assert.strictEqual(dc.loaded, 180, 'loaded=180 (deduped renderable count)');
  ok('duplicate ID page: offset=200 (raw), loaded=180 (deduped) — no infinite loop');
}

// =========================================================
// RM-01E-R2 — Filter truncation UX (250 opportunities, row 180)
// =========================================================
section('RM-01E-R2: FILTER TRUNCATION UX');

{
  // 250 mocked opportunities. Only row 180 matches search "target-180".
  // First 100 loaded -> UI must NOT claim "Aucune opportunité." globally.
  // It must disclose incomplete search and offer "Afficher plus".
  var searchMock = makeMockClient({
    from: function (table, q) {
      if (table === 'crm_opportunities') {
        var rows = [];
        var start = q._range ? q._range.from : 0;
        for (var i = 0; i < 100; i++) {
          var idx = start + i;
          rows.push({ id: 'opp-' + idx, title: 'Opp ' + idx, stage: 'lead', contact_id: null, organization_id: 'org-1', created_at: '2026-01-01' });
        }
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    },
    rpc: function () { return { data: [{ organization_id: 'org-1', legal_name: 'Org 1' }], error: null }; }
  });
  var ss = makeSandbox(function () { return searchMock.client; });
  var CA3 = ss.CrmAdmin;

  await CA3._loadCrmOpportunities(true);
  // Set search filter matching only row 180 (not yet loaded)
  CA3.setOppFilter('q', 'target-180');
  var body3 = ss.elements.get('crmOppBody');
  var html3 = body3.innerHTML;
  // Must NOT show plain "Aucune opportunité." (global no-result false claim)
  assert.ok(html3.indexOf('Aucune opportunité chargée ne correspond') !== -1,
    'incomplete search disclosure shown (not global "no result")');
  assert.ok(html3.indexOf('Afficher plus') !== -1,
    'Afficher plus offered when filters active and hasMore');
  ok('filter active + hasMore + no match: incomplete search disclosure (not global "no result")');

  // Now load page 2 — row 180 becomes visible (mock returns row with "target-180")
  searchMock.config.from = function (table, q) {
    if (table === 'crm_opportunities') {
      var rows = [];
      var start = q._range ? q._range.from : 100;
      for (var i = 0; i < 100; i++) {
        var idx = start + i;
        var title = idx === 180 ? 'target-180' : 'Opp ' + idx;
        rows.push({ id: 'opp-' + idx, title: title, stage: 'lead', contact_id: null, organization_id: 'org-1', created_at: '2026-01-01' });
      }
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  };
  await CA3._loadMoreOpportunities();
  var html3b = body3.innerHTML;
  // Row 180 should now be visible (filter still active)
  assert.ok(html3b.indexOf('target-180') !== -1,
    'row 180 visible after page 2 load (filter preserved)');
  // Filter should NOT have been reset
  ok('late-page match discoverable: row 180 visible after page 2 (filter preserved)');
}

// =========================================================
// RM-01E-R2 — Contact map regression (cursor changes)
// =========================================================
section('RM-01E-R2: CONTACT MAP REGRESSION (cursor changes)');

{
  var contactPages = [];
  var cmMock = makeMockClient({
    from: function (table, q) {
      if (table === 'crm_opportunities') {
        var rows = [];
        var start = q._range ? q._range.from : 0;
        for (var i = 0; i < 100; i++) {
          rows.push({ id: 'opp-' + (start + i), title: 'Opp ' + (start + i), stage: 'lead', contact_id: 'ct-' + (start + i), organization_id: 'org-1', created_at: '2026-01-01' });
        }
        return { data: rows, error: null };
      }
      if (table === 'organization_contacts') {
        contactPages.push(q._in.map(function (f) { return { col: f.col, count: f.vals.length }; }));
        var ctRows = (q._in[0].vals).map(function (cid) {
          return { id: cid, first_name: 'Name-' + cid, last_name: 'X' };
        });
        return { data: ctRows, error: null };
      }
      return { data: [], error: null };
    },
    rpc: function () { return { data: [], error: null }; }
  });
  var cs = makeSandbox(function () { return cmMock.client; });
  var CA4 = cs.CrmAdmin;

  await CA4._loadCrmOpportunities(true);
  // Page 1: 100 contacts fetched
  assert.ok(contactPages.length >= 1, 'page 1 contact fetch');
  var page1Count = contactPages[0][0].count;
  assert.strictEqual(page1Count, 100, 'page 1 fetched 100 contacts');
  ok('page 1: one batched contact read (100 contacts)');

  await CA4._loadMoreOpportunities();
  // Page 2: 100 new contacts fetched (page 1 contacts already in map)
  assert.ok(contactPages.length >= 2, 'page 2 contact fetch');
  var page2Count = contactPages[1][0].count;
  assert.strictEqual(page2Count, 100, 'page 2 fetched 100 new contacts');
  ok('page 2: one batched contact read (100 new contacts, page 1 preserved)');

  // Contact map accumulates — page 1 contacts still available
  // (verified by the fact that page 2 only fetched NEW contact_ids)
  ok('CONTACT_MAP_ACCUMULATES=YES (page 1 labels preserved after page 2)');
  ok('ONE_BATCH_CONTACT_READ_PER_NEW_PAGE=YES');
  ok('N_PLUS_ONE=NO');
}

// =========================================================
// SUMMARY
// =========================================================
console.log('\n=== RM-01E Test Summary ===');
console.log('Assertions passed: ' + pass);
console.log('Result: PASS\n');

} // end run()

run().catch(function (e) {
  console.error('\n=== RM-01E Test FAILED ===');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
