/**
 * MISSIONS-EXT-2B-HF1 — Runtime Reference Error Hotfix — Tests
 *
 * Covers:
 * A. _isCreatingExternalMission declared before use (top-level scope)
 * B. creation click does not throw ReferenceError
 * C. second click while request pending is ignored
 * D. guard reset in finally
 * E. clearAddrErr callable/safe from autocomplete callback
 * F. departure autocomplete selection succeeds
 * G. arrival autocomplete selection succeeds
 * H. existing MISSIONS-EXT-1 creation flow still valid
 * I. duplicate UX remains precise
 *
 * Static tests only — no DB, no network, no browser.
 * Browser runtime test is in missions-ext-2b-hf1-runtime.test.mjs (Playwright).
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

const DASH_PATH = path.join(__dirname, '..', 'dashboard-admin.html');

// Extract function body from dashboard
function _extractFunction(dash, name) {
  var start = dash.indexOf(name);
  if (start < 0) return '';
  var braceStart = dash.indexOf('{', start);
  var depth = 0;
  for (var i = braceStart; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) return dash.substring(start, i + 1); }
  }
  return dash.substring(start);
}

// Check if a declaration is at the top level of the script (not inside a function)
function _isTopLevel(dash, searchStr) {
  var idx = dash.indexOf(searchStr);
  if (idx < 0) return false;
  // Find the start of the line
  var lineStart = dash.lastIndexOf('\n', idx) + 1;
  var lineEnd = dash.indexOf('\n', idx);
  var line = dash.substring(lineStart, lineEnd);
  // Top-level code has 2 spaces indentation (inside <script> block)
  // Code inside DOMContentLoaded has 4+ spaces
  var indent = line.length - line.trimStart().length;
  return indent <= 2;
}

async function runScopeTests() {
  console.log('\n--- SCOPE / DECLARATION TESTS ---');
  const dash = fs.readFileSync(DASH_PATH, 'utf8');

  await test('A1. _isCreatingExternalMission declared at top level', () => {
    assert.ok(dash.indexOf('let _isCreatingExternalMission = false;') !== -1,
      '_isCreatingExternalMission must be declared');
    assert.ok(_isTopLevel(dash, 'let _isCreatingExternalMission = false;'),
      '_isCreatingExternalMission must be at top level (not inside DOMContentLoaded)');
  });

  await test('A2. _isCreatingExternalMission declared before click handler', () => {
    var declIdx = dash.indexOf('let _isCreatingExternalMission = false;');
    var clickIdx = dash.indexOf("if (_isCreatingExternalMission) return;");
    assert.ok(declIdx !== -1 && clickIdx !== -1, 'Both must exist');
    assert.ok(declIdx < clickIdx, 'Declaration must come before usage in source');
  });

  await test('B1. creation click handler does not reference undefined variable', () => {
    // The click handler references _isCreatingExternalMission
    // It must be declared in an accessible scope (top level)
    var clickIdx = dash.indexOf("if (_isCreatingExternalMission) return;");
    assert.ok(clickIdx !== -1, 'Click handler guard must exist');
    // Verify the declaration is NOT inside a DOMContentLoaded handler
    var declIdx = dash.indexOf('let _isCreatingExternalMission = false;');
    var beforeDecl = dash.substring(0, declIdx);
    // Count DOMContentLoaded openings and closings before the declaration
    var domOpenCount = (beforeDecl.match(/DOMContentLoaded.*\{/g) || []).length;
    assert.ok(domOpenCount >= 0, 'Should be able to count DOMContentLoaded handlers');
    // The declaration should NOT be inside any DOMContentLoaded handler
    // We verify this by checking indentation (top level = 2 spaces)
    assert.ok(_isTopLevel(dash, 'let _isCreatingExternalMission = false;'),
      'Declaration must be at top level');
  });

  await test('C1. second click while pending is ignored (guard logic)', () => {
    var clickHandler = _extractFunction(dash, "document.getElementById('createExternalMissionConfirmBtn')?.addEventListener('click',");
    assert.ok(clickHandler.indexOf('if (_isCreatingExternalMission) return;') !== -1,
      'Guard check must exist at start of click handler');
    assert.ok(clickHandler.indexOf('_isCreatingExternalMission = true;') !== -1,
      'Guard must be set to true after check');
  });

  await test('D1. guard reset in finally block', () => {
    var clickHandler = _extractFunction(dash, "document.getElementById('createExternalMissionConfirmBtn')?.addEventListener('click',");
    assert.ok(clickHandler.indexOf('finally {') !== -1,
      'Click handler must have a finally block');
    assert.ok(clickHandler.indexOf('_isCreatingExternalMission = false;') !== -1,
      'Guard must be reset to false');
    // Verify the reset is in the finally block
    var finallyIdx = clickHandler.indexOf('finally {');
    var resetIdx = clickHandler.indexOf('_isCreatingExternalMission = false;', finallyIdx);
    assert.ok(resetIdx > finallyIdx, 'Guard reset must be inside finally block');
  });

  await test('E1. _clearAddrErr declared at top level (accessible from autocomplete)', () => {
    assert.ok(dash.indexOf('function _clearAddrErr(errId)') !== -1,
      '_clearAddrErr must be declared');
    assert.ok(_isTopLevel(dash, 'function _clearAddrErr(errId)'),
      '_clearAddrErr must be at top level (accessible from other script blocks)');
  });

  await test('E2. _showAddrErr declared at top level', () => {
    assert.ok(dash.indexOf('function _showAddrErr(errId)') !== -1,
      '_showAddrErr must be declared');
    assert.ok(_isTopLevel(dash, 'function _showAddrErr(errId)'),
      '_showAddrErr must be at top level');
  });

  await test('F1. departure autocomplete callback calls _clearAddrErr', () => {
    assert.ok(dash.indexOf("_clearAddrErr('errExtDepartAddr')") !== -1,
      'Departure autocomplete must call _clearAddrErr');
  });

  await test('G1. arrival autocomplete callback calls _clearAddrErr', () => {
    assert.ok(dash.indexOf("_clearAddrErr('errExtArriveeAddr')") !== -1,
      'Arrival autocomplete must call _clearAddrErr');
  });

  await test('H1. existing MISSIONS-EXT-1 creation flow still valid', () => {
    // Verify the external mission creation function still exists and has key fields
    var extFn = _extractFunction(dash, 'async function _doCreateExternalMission');
    assert.ok(extFn.length > 0, '_doCreateExternalMission must exist');
    assert.ok(extFn.indexOf('source_mission') !== -1, 'Must still set source_mission');
    assert.ok(extFn.indexOf('external_reference') !== -1, 'Must still set external_reference');
    assert.ok(extFn.indexOf('client_id: null') !== -1, 'Must still set client_id to null');
  });

  await test('I1. duplicate UX remains precise (AND logic)', () => {
    var extFn = _extractFunction(dash, 'async function _doCreateExternalMission');
    assert.ok(extFn.indexOf("(errCode === '23505') && (targetConstraintNamed || keyIdentified)") !== -1,
      'Must still use precise AND logic for duplicate detection');
    assert.ok(extFn.indexOf('uq_missions_external_ref_per_platform') !== -1,
      'Must still reference target constraint name');
  });
}

async function runStateVariableTests() {
  console.log('\n--- STATE VARIABLE SCOPE TESTS ---');
  const dash = fs.readFileSync(DASH_PATH, 'utf8');

  await test('E3. _extDepartSelected at top level', () => {
    assert.ok(_isTopLevel(dash, 'let _extDepartSelected = false;'),
      '_extDepartSelected must be at top level');
  });

  await test('E4. _extArriveeSelected at top level', () => {
    assert.ok(_isTopLevel(dash, 'let _extArriveeSelected = false;'),
      '_extArriveeSelected must be at top level');
  });

  await test('E5. _adminDepartSelected at top level', () => {
    assert.ok(_isTopLevel(dash, 'let _adminDepartSelected = false;'),
      '_adminDepartSelected must be at top level');
  });

  await test('E6. _isCreatingMission at top level', () => {
    assert.ok(_isTopLevel(dash, 'let _isCreatingMission = false;'),
      '_isCreatingMission must be at top level');
  });

  await test('E7. no duplicate declarations inside DOMContentLoaded', () => {
    // Verify the old declarations are removed from inside the DOMContentLoaded handler
    // The DOMContentLoaded handler at PARTIE 11 should NOT contain these declarations
    var domIdx = dash.indexOf('PARTIE 11 : GESTIONNAIRES');
    if (domIdx < 0) return; // If no PARTIE 11, nothing to check
    var afterDom = dash.substring(domIdx);
    // Check that there's no second declaration inside the DOMContentLoaded
    var matches = afterDom.match(/let _isCreatingExternalMission/g) || [];
    assert.ok(matches.length === 0,
      'No _isCreatingExternalMission declaration inside DOMContentLoaded (found ' + matches.length + ')');
    var clearMatches = afterDom.match(/function _clearAddrErr/g) || [];
    assert.ok(clearMatches.length === 0,
      'No _clearAddrErr declaration inside DOMContentLoaded (found ' + clearMatches.length + ')');
  });
}

async function main() {
  console.log('=== MISSIONS-EXT-2B-HF1 — Runtime Reference Error Hotfix — Tests ===\n');

  await runScopeTests();
  await runStateVariableTests();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
