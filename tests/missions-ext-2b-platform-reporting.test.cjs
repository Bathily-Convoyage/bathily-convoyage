/**
 * MISSIONS-EXT-2B — Platform Reporting + Duplicate UX — Tests
 *
 * Covers:
 * 1.  Source labels (friendly names)
 * 2.  Mission count by source
 * 3.  Revenue aggregation
 * 4.  Remuneration aggregation
 * 5.  Approved expenses included
 * 6.  Pending expenses excluded
 * 7.  Rejected expenses excluded
 * 8.  Margin subtracts remuneration + approved expenses
 * 9.  Unknown remuneration => unknown margin
 * 10. Unknown revenue => unknown margin
 * 11. No expenses => zero expenses
 * 12. Average revenue
 * 13. Average margin computed only from known-margin missions
 * 14. Partial-margin completeness indicator X/Y
 * 15. Direct source works
 * 16. Hiflow works
 * 17. Driiveme works
 * 18. ALB works
 * 19. Other works
 * 20. Empty source renders safely
 * 21. Zero external missions renders safely
 * 22. Mission-list source filter unchanged
 * 23. Reporting comparison remains all-source
 * 24. No quote calculator call
 * 25. No Stripe call
 * 26. No AI automatic call
 * 27. Duplicate same platform -> friendly message
 * 28. Duplicate error detects exact constraint / 23505
 * 29. Unrelated DB error retains generic behavior
 * 30. No raw Postgres error as primary duplicate UX
 *
 * Static tests only — no DB, no network, no browser.
 * The aggregation logic is tested by extracting and executing _renderPlatformReport
 * in a sandbox with mock DOM, mock missions, and mock expenses.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  \u2713 ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  \u2717 ${name}`);
      console.log(`    ERROR: ${err.message}`);
    });
}

// =====================================================
// File paths
// =====================================================
const DASH_PATH = path.join(__dirname, '..', 'dashboard-admin.html');
const CHECKOUT_PATH = path.join(__dirname, '..', 'functions', 'api', 'create-checkout-session.js');

// =====================================================
// Helpers — extract bounded function bodies from dashboard
// =====================================================

// Extract _renderPlatformReport function body
function _extractRenderPlatformReport(dash) {
  var start = dash.indexOf('function _renderPlatformReport');
  if (start < 0) return '';
  var braceStart = dash.indexOf('{', start);
  var depth = 0;
  for (var i = braceStart; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) return dash.substring(start, i + 1); }
  }
  return dash.substring(start);
}

// Extract _doCreateExternalMission function body
function _extractExtFunction(dash) {
  var start = dash.indexOf('async function _doCreateExternalMission');
  if (start < 0) return '';
  var braceStart = dash.indexOf('{', start);
  var depth = 0;
  for (var i = braceStart; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) return dash.substring(start, i + 1); }
  }
  return dash.substring(start);
}

// Create a sandbox with mock DOM elements for _renderPlatformReport
function createSandbox() {
  var cells = {};
  var tbodyHtml = '';
  var sandbox = {
    document: {
      getElementById: function(id) {
        if (id === 'platformReportBody') {
          return { innerHTML: '', set innerHTML(v) { tbodyHtml = v; }, get innerHTML() { return tbodyHtml; } };
        }
        return null;
      }
    },
    escapeHtml: function(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
    _PLATFORM_LABELS: null,
    _PLATFORM_ORDER: null,
    _fmtEur: null,
    _renderPlatformReport: null,
    console: { log: function() {} }
  };
  return { sandbox: sandbox, getHtml: function() { return tbodyHtml; } };
}

// Compile and run _renderPlatformReport + helpers in a sandbox
function compileReporter(dash) {
  var reportCode = _extractRenderPlatformReport(dash);
  assert.ok(reportCode.length > 0, '_renderPlatformReport not found in dashboard');

  // Also extract _PLATFORM_LABELS, _PLATFORM_ORDER, _fmtEur
  var labelsMatch = dash.match(/var _PLATFORM_LABELS\s*=\s*(\{[\s\S]*?\});/);
  var orderMatch = dash.match(/var _PLATFORM_ORDER\s*=\s*(\[[\s\S]*?\]);/);
  var fmtMatch = dash.match(/function _fmtEur[\s\S]*?\n\s*\}/);

  assert.ok(labelsMatch, '_PLATFORM_LABELS not found');
  assert.ok(orderMatch, '_PLATFORM_ORDER not found');
  assert.ok(fmtMatch, '_fmtEur not found');

  var fullCode = labelsMatch[0] + '\n' + orderMatch[0] + '\n' + fmtMatch[0] + '\n' + reportCode;

  var ctx = createSandbox();
  vm.createContext(ctx.sandbox);
  vm.runInContext(fullCode, ctx.sandbox);

  return ctx;
}

// =====================================================
// PLATFORM REPORTING — UI STRUCTURE TESTS
// =====================================================

async function runUiStructureTests() {
  console.log('\n--- PLATFORM REPORTING — UI STRUCTURE ---');
  const dash = fs.readFileSync(DASH_PATH, 'utf8');

  await test('1. source labels (friendly names) defined', () => {
    assert.ok(dash.indexOf("_PLATFORM_LABELS") !== -1, '_PLATFORM_LABELS must be defined');
    assert.ok(/direct:\s*'Direct'/.test(dash), 'direct label must be Direct');
    assert.ok(/hiflow:\s*'Hiflow'/.test(dash), 'hiflow label must be Hiflow');
    assert.ok(/driiveme:\s*'Driiveme'/.test(dash), 'driiveme label must be Driiveme');
    assert.ok(/alb:\s*'ALB Convoyage'/.test(dash), 'alb label must be ALB Convoyage');
    assert.ok(/other:\s*'Autre'/.test(dash), 'other label must be Autre');
  });

  await test('2. platform report table exists in analytics tab', () => {
    assert.ok(dash.indexOf('id="platformReportTable"') !== -1, 'platform report table must exist');
    assert.ok(dash.indexOf('id="platformReportBody"') !== -1, 'platform report tbody must exist');
  });

  await test('3. platform report has all 8 columns', () => {
    var tableStart = dash.indexOf('id="platformReportTable"');
    var tableEnd = dash.indexOf('</thead>', tableStart);
    var tableHtml = dash.substring(tableStart, tableEnd);
    assert.ok(tableHtml.indexOf('Plateforme') !== -1, 'Platform column');
    assert.ok(tableHtml.indexOf('Missions') !== -1, 'Mission count column');
    assert.ok(tableHtml.indexOf('CA HT') !== -1, 'Revenue column');
    assert.ok(tableHtml.indexOf('Rémun') !== -1, 'Remuneration column');
    assert.ok(tableHtml.indexOf('Frais approuvés') !== -1, 'Approved expenses column');
    assert.ok(tableHtml.indexOf('Marge déterministe') !== -1, 'Deterministic margin column');
    assert.ok(tableHtml.indexOf('CA moyen') !== -1, 'Average revenue column');
    assert.ok(tableHtml.indexOf('Marge moyenne') !== -1, 'Average margin column');
  });

  await test('4. _renderPlatformReport function exists', () => {
    assert.ok(dash.indexOf('function _renderPlatformReport') !== -1, '_renderPlatformReport must exist');
  });

  await test('5. loadAnalytics calls _renderPlatformReport', () => {
    var laStart = dash.indexOf('function loadAnalytics()');
    var laEnd = dash.indexOf('\n  }', laStart);
    var laBody = dash.substring(laStart, laEnd);
    assert.ok(laBody.indexOf('_renderPlatformReport') !== -1, 'loadAnalytics must call _renderPlatformReport');
  });
}

// =====================================================
// AGGREGATION LOGIC TESTS
// =====================================================

async function runAggregationTests() {
  console.log('\n--- AGGREGATION LOGIC ---');
  const dash = fs.readFileSync(DASH_PATH, 'utf8');
  const ctx = compileReporter(dash);
  const render = ctx.sandbox._renderPlatformReport;

  await test('6. mission count by source', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: 200 },
      { id: '2', source_mission: 'direct', montant_ht: 300, remuneration_convoyeur: 150 },
      { id: '3', source_mission: 'hiflow', montant_ht: 450, remuneration_convoyeur: 200 },
    ];
    render(missions, []);
    var html = ctx.getHtml();
    // Direct should have count=2, Hiflow count=1
    assert.ok(html.indexOf('Direct') !== -1, 'Direct row present');
    assert.ok(html.indexOf('Hiflow') !== -1, 'Hiflow row present');
    // Check that count appears in the right cell — we verify the row structure
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow, 'Direct row found');
    assert.ok(/>\s*2\s*</.test(directRow), 'Direct count should be 2');
  });

  await test('7. revenue aggregation sums known montant_ht', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: 200 },
      { id: '2', source_mission: 'direct', montant_ht: 300, remuneration_convoyeur: 150 },
    ];
    render(missions, []);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow.indexOf('800.00 €') !== -1, 'Revenue should be 800.00 € (500+300)');
  });

  await test('8. remuneration aggregation sums known remuneration', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: 200 },
      { id: '2', source_mission: 'direct', montant_ht: 300, remuneration_convoyeur: 150 },
    ];
    render(missions, []);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow.indexOf('350.00 €') !== -1, 'Remuneration should be 350.00 € (200+150)');
  });

  await test('9. approved expenses included in aggregation', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: 200 },
    ];
    var expenses = [
      { mission_id: '1', amount: 50, status: 'approved' },
      { mission_id: '1', amount: 30, status: 'approved' },
    ];
    render(missions, expenses);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow.indexOf('80.00 €') !== -1, 'Approved expenses should be 80.00 € (50+30)');
  });

  await test('10. pending expenses excluded', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: 200 },
    ];
    var expenses = [
      { mission_id: '1', amount: 50, status: 'approved' },
      { mission_id: '1', amount: 100, status: 'submitted' },
    ];
    render(missions, expenses);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow.indexOf('50.00 €') !== -1, 'Only approved (50) should show, not pending (100)');
  });

  await test('11. rejected expenses excluded', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: 200 },
    ];
    var expenses = [
      { mission_id: '1', amount: 50, status: 'approved' },
      { mission_id: '1', amount: 200, status: 'rejected' },
    ];
    render(missions, expenses);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow.indexOf('50.00 €') !== -1, 'Only approved (50) should show, not rejected (200)');
  });

  await test('12. margin subtracts remuneration + approved expenses', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: 200 },
    ];
    var expenses = [
      { mission_id: '1', amount: 80, status: 'approved' },
    ];
    render(missions, expenses);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    // margin = 500 - 200 - 80 = 220
    assert.ok(directRow.indexOf('220.00 €') !== -1, 'Margin should be 220.00 € (500-200-80)');
  });

  await test('13. unknown remuneration => unknown margin', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: null },
    ];
    render(missions, []);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow.indexOf('Indisponible') !== -1, 'Margin should be Indisponible when remuneration is null');
  });

  await test('14. unknown revenue => unknown margin', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: null, remuneration_convoyeur: 200 },
    ];
    render(missions, []);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow.indexOf('Indisponible') !== -1, 'Margin should be Indisponible when revenue is null');
  });

  await test('15. no expenses => zero expenses', () => {
    var missions = [
      { id: '1', source_mission: 'direct', montant_ht: 500, remuneration_convoyeur: 200 },
    ];
    render(missions, []);
    var html = ctx.getHtml();
    var directRow = html.split('<tr>').find(r => r.indexOf('Direct') !== -1);
    assert.ok(directRow.indexOf('0.00 €') !== -1, 'Expenses should be 0.00 € when none exist');
  });

  await test('16. average revenue per mission', () => {
    var missions = [
      { id: '1', source_mission: 'hiflow', montant_ht: 600, remuneration_convoyeur: 200 },
      { id: '2', source_mission: 'hiflow', montant_ht: 300, remuneration_convoyeur: 100 },
    ];
    render(missions, []);
    var html = ctx.getHtml();
    var hiflowRow = html.split('<tr>').find(r => r.indexOf('Hiflow') !== -1);
    // avg revenue = (600+300)/2 = 450
    assert.ok(hiflowRow.indexOf('450.00 €') !== -1, 'Average revenue should be 450.00 €');
  });

  await test('17. average margin computed only from known-margin missions', () => {
    var missions = [
      { id: '1', source_mission: 'hiflow', montant_ht: 600, remuneration_convoyeur: 200 },
      { id: '2', source_mission: 'hiflow', montant_ht: 300, remuneration_convoyeur: null }, // unknown margin
    ];
    render(missions, []);
    var html = ctx.getHtml();
    var hiflowRow = html.split('<tr>').find(r => r.indexOf('Hiflow') !== -1);
    // Only mission 1 has known margin: 600-200-0 = 400
    // avg margin = 400/1 = 400
    assert.ok(hiflowRow.indexOf('400.00 €') !== -1, 'Average margin should be 400.00 € (only 1 known)');
  });

  await test('18. partial-margin completeness indicator X/Y', () => {
    var missions = [
      { id: '1', source_mission: 'hiflow', montant_ht: 600, remuneration_convoyeur: 200 },
      { id: '2', source_mission: 'hiflow', montant_ht: 300, remuneration_convoyeur: null },
    ];
    render(missions, []);
    var html = ctx.getHtml();
    var hiflowRow = html.split('<tr>').find(r => r.indexOf('Hiflow') !== -1);
    assert.ok(hiflowRow.indexOf('1/2') !== -1, 'Completeness indicator should show 1/2');
  });

  await test('19. direct source works', () => {
    var missions = [{ id: '1', source_mission: 'direct', montant_ht: 100, remuneration_convoyeur: 50 }];
    render(missions, []);
    var html = ctx.getHtml();
    assert.ok(html.indexOf('Direct') !== -1, 'Direct row must render');
  });

  await test('20. hiflow source works', () => {
    var missions = [{ id: '1', source_mission: 'hiflow', montant_ht: 100, remuneration_convoyeur: 50 }];
    render(missions, []);
    var html = ctx.getHtml();
    assert.ok(html.indexOf('Hiflow') !== -1, 'Hiflow row must render');
  });

  await test('21. driiveme source works', () => {
    var missions = [{ id: '1', source_mission: 'driiveme', montant_ht: 100, remuneration_convoyeur: 50 }];
    render(missions, []);
    var html = ctx.getHtml();
    assert.ok(html.indexOf('Driiveme') !== -1, 'Driiveme row must render');
  });

  await test('22. alb source works', () => {
    var missions = [{ id: '1', source_mission: 'alb', montant_ht: 100, remuneration_convoyeur: 50 }];
    render(missions, []);
    var html = ctx.getHtml();
    assert.ok(html.indexOf('ALB Convoyage') !== -1, 'ALB Convoyage row must render');
  });

  await test('23. other source works', () => {
    var missions = [{ id: '1', source_mission: 'other', montant_ht: 100, remuneration_convoyeur: 50 }];
    render(missions, []);
    var html = ctx.getHtml();
    assert.ok(html.indexOf('Autre') !== -1, 'Autre row must render');
  });

  await test('24. empty source renders safely (no missions for a platform)', () => {
    var missions = [{ id: '1', source_mission: 'direct', montant_ht: 100, remuneration_convoyeur: 50 }];
    render(missions, []);
    var html = ctx.getHtml();
    // Hiflow, Driiveme, ALB, Autre rows should render with count=0
    var hiflowRow = html.split('<tr>').find(r => r.indexOf('Hiflow') !== -1);
    assert.ok(hiflowRow, 'Hiflow row must render even with 0 missions');
    assert.ok(/>\s*0\s*</.test(hiflowRow), 'Hiflow count should be 0');
  });

  await test('25. zero external missions renders safely', () => {
    render([], []);
    var html = ctx.getHtml();
    assert.ok(html.indexOf('Aucune mission') !== -1, 'Empty state message must show');
  });

  await test('26. all 5 platform rows always present (all-source comparison)', () => {
    var missions = [{ id: '1', source_mission: 'direct', montant_ht: 100, remuneration_convoyeur: 50 }];
    render(missions, []);
    var html = ctx.getHtml();
    assert.ok(html.indexOf('Direct') !== -1, 'Direct always present');
    assert.ok(html.indexOf('Hiflow') !== -1, 'Hiflow always present');
    assert.ok(html.indexOf('Driiveme') !== -1, 'Driiveme always present');
    assert.ok(html.indexOf('ALB Convoyage') !== -1, 'ALB always present');
    assert.ok(html.indexOf('Autre') !== -1, 'Autre always present');
  });
}

// =====================================================
// NO SIDE EFFECTS TESTS
// =====================================================

async function runNoSideEffectsTests() {
  console.log('\n--- NO SIDE EFFECTS ---');
  const dash = fs.readFileSync(DASH_PATH, 'utf8');

  await test('27. no quote calculator call in reporting', () => {
    var reportStart = dash.indexOf('MISSIONS-EXT-2B — Platform Reporting');
    var reportEnd = dash.indexOf('// ============================================================', reportStart + 100);
    var reportSection = dash.substring(reportStart, reportEnd > 0 ? reportEnd : dash.length);
    assert.ok(reportSection.indexOf('calculate-quote') === -1, 'Reporting must not call calculate-quote');
  });

  await test('28. no Stripe call in reporting', () => {
    var reportStart = dash.indexOf('MISSIONS-EXT-2B — Platform Reporting');
    var reportEnd = dash.indexOf('// ============================================================', reportStart + 100);
    var reportSection = dash.substring(reportStart, reportEnd > 0 ? reportEnd : dash.length);
    assert.ok(reportSection.indexOf('stripe') === -1, 'Reporting must not call Stripe');
    assert.ok(reportSection.indexOf('checkout') === -1, 'Reporting must not call checkout');
  });

  await test('29. no AI automatic call in reporting', () => {
    var reportStart = dash.indexOf('MISSIONS-EXT-2B — Platform Reporting');
    var reportEnd = dash.indexOf('// ============================================================', reportStart + 100);
    var reportSection = dash.substring(reportStart, reportEnd > 0 ? reportEnd : dash.length);
    assert.ok(reportSection.indexOf('analyzeMissionProfitability') === -1, 'Reporting must not auto-call AI');
    assert.ok(reportSection.indexOf('profitabilityAdvisory') === -1, 'Reporting must not trigger AI advisory');
  });

  await test('30. mission-list source filter unchanged', () => {
    assert.ok(dash.indexOf('id="filter-source"') !== -1, 'Source filter still exists');
    assert.ok(dash.indexOf('sourceFilter') !== -1, 'Source filter logic still exists');
    assert.ok(dash.indexOf('applyMissionFilters') !== -1, 'applyMissionFilters still exists');
  });
}

// =====================================================
// DUPLICATE UX TESTS
// =====================================================

async function runDuplicateUxTests() {
  console.log('\n--- DUPLICATE UX ---');
  const dash = fs.readFileSync(DASH_PATH, 'utf8');
  const extFn = _extractExtFunction(dash);

  await test('31. duplicate same platform -> friendly message', () => {
    assert.ok(extFn.indexOf('Référence déjà utilisée') !== -1, 'Friendly duplicate title must be present');
    assert.ok(extFn.indexOf('Une mission avec cette référence existe déjà sur cette plateforme') !== -1,
      'Friendly duplicate message must be present');
  });

  await test('32. duplicate error detects PostgreSQL code 23505', () => {
    assert.ok(extFn.indexOf("23505") !== -1, 'Must detect PostgreSQL unique violation code 23505');
  });

  await test('33. duplicate error detects exact constraint name', () => {
    assert.ok(extFn.indexOf('uq_missions_external_ref_per_platform') !== -1,
      'Must detect exact constraint name uq_missions_external_ref_per_platform');
  });

  await test('34. unrelated DB error retains generic behavior', () => {
    // The generic "Impossible de créer la mission externe" must still exist for non-duplicate errors
    assert.ok(extFn.indexOf('Impossible de créer la mission externe') !== -1,
      'Generic error message must still exist for non-duplicate errors');
    // The isDuplicateRef check must be conditional (if/else), not unconditional
    assert.ok(extFn.indexOf('if (isDuplicateRef)') !== -1, 'Must branch on isDuplicateRef');
  });

  await test('35. no raw Postgres error as primary duplicate UX', () => {
    // The friendly message must come BEFORE the technical details
    var friendlyIdx = extFn.indexOf('Une mission avec cette référence existe déjà');
    var detailsIdx = extFn.indexOf('Détail technique', friendlyIdx);
    assert.ok(friendlyIdx !== -1, 'Friendly message must exist');
    assert.ok(detailsIdx > friendlyIdx, 'Technical details must come after friendly message');
  });
}

// =====================================================
// MAIN
// =====================================================
async function main() {
  console.log('=== MISSIONS-EXT-2B — Platform Reporting + Duplicate UX — Tests ===\n');

  await runUiStructureTests();
  await runAggregationTests();
  await runNoSideEffectsTests();
  await runDuplicateUxTests();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
