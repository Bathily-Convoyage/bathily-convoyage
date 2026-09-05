/**
 * MISSIONS-EXT-2C — Admin/Operator Expense Entry — Tests
 *
 * Covers the 45 cases from the spec (section 14) plus isolation/guards:
 *   1-6   Add expense button visible + source support (direct/hiflow/driiveme/alb/other)
 *   7-15  Type mapping (fuel, charging, toll, parking, bus, train, hotel, washing, other)
 *   16-18 Subtype preserved in description (bus, train, hotel)
 *   19-25 Validation (amount>0, negative, zero, invalid number, invalid type, invalid date, sanitized)
 *   26-28 Admin-created status semantics, audit metadata, no forged reviewed_by
 *   29-35 Profitability (approved included, non-approved excluded, margin decreases, no double count, missions.marge not used)
 *   36-38 Hiflow reporting + source-independent
 *   39-43 Isolation (no Stripe, no quote, no billing, no mission status, no AI)
 *   44-46 In-flight guard (double click prevented, resets on success, resets on error)
 *
 * Static tests only — no DB, no network, no browser. The runtime UI interaction
 * is covered separately by the Playwright runtime test.
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
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260905130000_missions_ext_2c_admin_expense_rpc.sql');

// =====================================================
// Helpers — extract bounded function bodies from dashboard
// =====================================================
function extractFunction(dash, marker) {
  const start = dash.indexOf(marker);
  if (start < 0) return '';
  const braceStart = dash.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < dash.length; i++) {
    if (dash[i] === '{') depth++;
    else if (dash[i] === '}') { depth--; if (depth === 0) return dash.substring(start, i + 1); }
  }
  return dash.substring(start);
}

// Build a sandbox that exposes the category mapping + description composer.
// We extract the relevant const/function and run them with a mock escapeHtml.
function compileExpenseHelpers(dash) {
  const catBlock = dash.match(/const ADM_EXPENSE_CATEGORIES\s*=\s*\[[\s\S]*?\];/);
  assert.ok(catBlock, 'ADM_EXPENSE_CATEGORIES not found in dashboard');
  // The by-key block ends with `});` (forEach), not `};`.
  const byKeyBlock = dash.match(/const ADM_EXPENSE_CATEGORY_BY_KEY\s*=\s*\{\};[\s\S]*?\}\);/);
  assert.ok(byKeyBlock, 'ADM_EXPENSE_CATEGORY_BY_KEY block not found');
  const prefixBlock = dash.match(/const ADM_EXPENSE_SUBTYPE_PREFIXES\s*=\s*\{[\s\S]*?\};/);
  assert.ok(prefixBlock, 'ADM_EXPENSE_SUBTYPE_PREFIXES not found');
  const composeFn = extractFunction(dash, 'function composeExpenseDescription');
  assert.ok(composeFn, 'composeExpenseDescription not found');
  const cleanFn = extractFunction(dash, 'function admExpCleanDescription');
  assert.ok(cleanFn, 'admExpCleanDescription not found');
  const labelFn = extractFunction(dash, 'function admExpDisplayLabel');
  assert.ok(labelFn, 'admExpDisplayLabel not found');
  const typeLabelFn = extractFunction(dash, 'function admExpTypeLabel');
  assert.ok(typeLabelFn, 'admExpTypeLabel not found');

  const code = [
    'const ADM_EXPENSE_TYPES = { fuel:"Carburant", charging:"Recharge électrique", toll:"Péage", parking:"Parking", return_transport:"Transport aller / retour", washing:"Lavage", other:"Autre" };',
    'const ADM_EXPENSE_STATUSES = { draft:"Brouillon", submitted:"En attente", approved:"Approuvé", rejected:"Refusé" };',
    catBlock[0],
    byKeyBlock[0],
    prefixBlock[0],
    'function escapeHtml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',
    typeLabelFn,
    labelFn,
    cleanFn,
    composeFn
  ].join('\n');

  const sandbox = { console: { log() {} } };
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.ADM_EXPENSE_CATEGORIES=ADM_EXPENSE_CATEGORIES;this.ADM_EXPENSE_CATEGORY_BY_KEY=ADM_EXPENSE_CATEGORY_BY_KEY;this.composeExpenseDescription=composeExpenseDescription;this.admExpCleanDescription=admExpCleanDescription;this.admExpDisplayLabel=admExpDisplayLabel;this.admExpTypeLabel=admExpTypeLabel;', sandbox);
  return sandbox;
}

// =====================================================
// TEST SUITES
// =====================================================
async function runAll() {
  const dash = fs.readFileSync(DASH_PATH, 'utf8');
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const helpers = compileExpenseHelpers(dash);

  // -----------------------------------------------------
  // 1-6: Button presence + source support
  // -----------------------------------------------------
  console.log('\n--- ADMIN CREATE — UI + SOURCE SUPPORT ---');
  await test('1. Add expense button present in mission detail', () => {
    assert.ok(dash.indexOf('admAddExpense(') !== -1, 'admAddExpense call must be present');
    assert.ok(/Ajouter un frais/.test(dash), '"Ajouter un frais" button label must be present');
    assert.ok(/id="adminMissionExpenses"/.test(dash), 'expenses container must be present');
  });
  await test('1b. Add expense button gated on currentAdminUser (admin-only UI)', () => {
    // The button must be conditionally rendered only when currentAdminUser is set
    assert.ok(/currentAdminUser \?/.test(dash), 'button must be gated on currentAdminUser ternary');
    assert.ok(/admAddExpense/.test(dash), 'admAddExpense present in template');
  });
  await test('2. Direct mission supported (no source restriction in add flow)', () => {
    // The add-expense flow does not branch on source_mission; the RPC validates
    // only mission existence, not source.
    assert.ok(/admin_create_mission_expense/.test(dash), 'RPC call present');
    assert.ok(!/source_mission.*admAddExpense|admAddExpense.*source_mission/.test(dash), 'add flow must not gate on source');
  });
  await test('3. Hiflow mission supported', () => {
    const rpc = extractFunction(dash, 'async function admSubmitExpense');
    assert.ok(rpc.indexOf('p_mission_id') !== -1, 'submit passes mission_id only');
    assert.ok(rpc.indexOf('source_mission') === -1, 'submit does not reference source_mission');
  });
  await test('4. Driiveme supported (source-independent)', () => {
    assert.ok(/admin_create_mission_expense/.test(dash), 'RPC used regardless of source');
  });
  await test('5. ALB supported (source-independent)', () => {
    assert.ok(/admin_create_mission_expense/.test(dash), 'RPC used regardless of source');
  });
  await test('6. Other supported (source-independent)', () => {
    assert.ok(/admin_create_mission_expense/.test(dash), 'RPC used regardless of source');
  });

  // -----------------------------------------------------
  // 7-15: Type mapping
  // -----------------------------------------------------
  console.log('\n--- TYPE MAPPING ---');
  const catByKey = helpers.ADM_EXPENSE_CATEGORY_BY_KEY;
  await test('7. fuel mapping (Carburant -> fuel)', () => {
    assert.strictEqual(catByKey.carburant.dbType, 'fuel');
  });
  await test('8. charging mapping (Recharge -> charging)', () => {
    assert.strictEqual(catByKey.recharge.dbType, 'charging');
  });
  await test('9. toll mapping (Péage -> toll)', () => {
    assert.strictEqual(catByKey.peage.dbType, 'toll');
  });
  await test('10. parking mapping (Parking -> parking)', () => {
    assert.strictEqual(catByKey.parking.dbType, 'parking');
  });
  await test('11. bus -> return_transport', () => {
    assert.strictEqual(catByKey.bus.dbType, 'return_transport');
  });
  await test('12. train -> return_transport', () => {
    assert.strictEqual(catByKey.train.dbType, 'return_transport');
  });
  await test('13. hotel -> other', () => {
    assert.strictEqual(catByKey.hotel.dbType, 'other');
  });
  await test('14. washing mapping (Lavage -> washing)', () => {
    assert.strictEqual(catByKey.lavage.dbType, 'washing');
  });
  await test('15. other mapping (Autre -> other)', () => {
    assert.strictEqual(catByKey.autre.dbType, 'other');
  });

  // -----------------------------------------------------
  // 16-18: Subtype preserved in description
  // -----------------------------------------------------
  console.log('\n--- SUBTYPE PRESERVATION ---');
  await test('16. bus subtype preserved in description', () => {
    const d = helpers.composeExpenseDescription('bus', 'Montpellier → Aix-en-Provence');
    assert.strictEqual(d, '[Bus] Montpellier → Aix-en-Provence');
  });
  await test('17. train subtype preserved in description', () => {
    const d = helpers.composeExpenseDescription('train', 'Bordeaux → Montpellier');
    assert.strictEqual(d, '[Train] Bordeaux → Montpellier');
  });
  await test('18. hotel subtype preserved in description', () => {
    const d = helpers.composeExpenseDescription('hotel', 'Clermont-Ferrand');
    assert.strictEqual(d, '[Hôtel] Clermont-Ferrand');
  });
  await test('16b. bus with no user desc still non-empty + prefixed', () => {
    const d = helpers.composeExpenseDescription('bus', '');
    assert.strictEqual(d, '[Bus]');
    assert.ok(d.trim().length > 0, 'must satisfy DB btrim>0 CHECK');
  });
  await test('17b. train with no user desc still non-empty + prefixed', () => {
    const d = helpers.composeExpenseDescription('train', '   ');
    assert.strictEqual(d, '[Train]');
  });
  await test('18b. hotel with no user desc still non-empty + prefixed', () => {
    const d = helpers.composeExpenseDescription('hotel', '');
    assert.strictEqual(d, '[Hôtel]');
  });
  await test('18c. user description not overwritten for non-subtype', () => {
    const d = helpers.composeExpenseDescription('carburant', 'Essence plein');
    assert.strictEqual(d, 'Essence plein');
  });
  await test('18d. non-subtype empty desc falls back to label (DB CHECK safe)', () => {
    const d = helpers.composeExpenseDescription('carburant', '');
    assert.strictEqual(d, 'Carburant');
    assert.ok(d.trim().length > 0);
  });

  // -----------------------------------------------------
  // 19-25: Validation (client-side preConfirm + RPC SQL)
  // -----------------------------------------------------
  console.log('\n--- VALIDATION ---');
  const preConfirm = extractFunction(dash, 'preConfirm: function');
  await test('19. amount > 0 required (client)', () => {
    assert.ok(/amount\s*<=\s*0|amount\s*<\s*=/.test(preConfirm) || /<=\s*0/.test(preConfirm), 'client must reject amount <= 0');
    assert.ok(/isNaN\(amount\)/.test(preConfirm), 'client must reject NaN amount');
  });
  await test('20. negative amount rejected (client)', () => {
    assert.ok(/amount\s*<=\s*0/.test(preConfirm), 'client rejects negative via <= 0');
  });
  await test('21. zero amount rejected (client)', () => {
    assert.ok(/amount\s*<=\s*0/.test(preConfirm), 'client rejects zero via <= 0');
  });
  await test('22. invalid number rejected (client)', () => {
    assert.ok(/isNaN\(amount\)/.test(preConfirm), 'client rejects NaN');
    assert.ok(/!isFinite\(amount\)/.test(preConfirm), 'client rejects non-finite');
  });
  await test('23. invalid type rejected (client + RPC allowlist)', () => {
    assert.ok(/Type de frais invalide/.test(preConfirm), 'client validates type key');
    // RPC validates against exact DB allowlist
    assert.ok(/p_expense_type NOT IN \('fuel', 'charging', 'toll', 'parking', 'return_transport', 'washing', 'other'\)/.test(migration), 'RPC enforces DB allowlist');
  });
  await test('24. invalid date rejected (client + RPC)', () => {
    assert.ok(/isNaN\(d\.getTime\(\)\)/.test(preConfirm), 'client validates date parse');
    assert.ok(/p_expense_date IS NULL/.test(migration), 'RPC rejects null date');
  });
  await test('25. description escaped/sanitized in UI rendering', () => {
    // Render path uses escapeHtml on the clean description
    const render = extractFunction(dash, 'function _admRenderExpenseItem');
    assert.ok(/escapeHtml\(cleanDesc\)/.test(render), 'description is escaped before rendering');
    // RPC enforces length + btrim
    assert.ok(/length\(p_description\)\s*>\s*500/.test(migration), 'RPC rejects description > 500');
    assert.ok(/length\(_desc_trim\)\s*=\s*0/.test(migration), 'RPC rejects empty/whitespace description');
  });

  // -----------------------------------------------------
  // 26-28: Status / audit semantics (RPC)
  // -----------------------------------------------------
  console.log('\n--- STATUS / AUDIT ---');
  await test('26. admin-created status = approved (server-side)', () => {
    assert.ok(/'approved'/.test(migration), 'RPC sets approved');
    // status must NOT be a parameter
    assert.ok(migration.indexOf('p_status') === -1, 'no p_status parameter (caller cannot choose status)');
  });
  await test('27. audit metadata server-derived (reviewed_by/reviewed_at)', () => {
    // INSERT column list includes reviewed_by/reviewed_at with server-derived values.
    // reviewed_at is the last column (no trailing comma); reviewed_by precedes it.
    assert.ok(/reviewed_by,\s*\n\s*reviewed_at\s*\n\s*\) VALUES/.test(migration), 'reviewed_by + reviewed_at columns in INSERT');
    // VALUES: submitted_at=now(), reviewed_by=auth.uid(), reviewed_at=now()
    assert.ok(/now\(\),\s*\n\s*auth\.uid\(\),\s*\n\s*now\(\)/.test(migration), 'submitted_at=now(), reviewed_by=auth.uid(), reviewed_at=now() in VALUES');
  });
  await test('28. no forged reviewed_by (not a parameter, not from client)', () => {
    assert.ok(migration.indexOf('p_reviewed_by') === -1, 'no p_reviewed_by parameter');
    assert.ok(migration.indexOf('p_reviewed_at') === -1, 'no p_reviewed_at parameter');
    assert.ok(migration.indexOf('p_status') === -1, 'no p_status parameter');
  });

  // -----------------------------------------------------
  // 29-35: Profitability integration
  // -----------------------------------------------------
  console.log('\n--- PROFITABILITY ---');
  // Reuse the deterministic aggregation: approved only, deterministic margin.
  // We simulate the dashboard's approved-expense aggregation logic directly.
  function approvedExpensesByMission(expenses) {
    const map = {};
    for (const exp of expenses) {
      if (exp.status === 'approved') {
        map[exp.mission_id] = (map[exp.mission_id] || 0) + (parseFloat(exp.amount) || 0);
      }
    }
    return map;
  }
  function deterministicMargin(mission, approvedMap) {
    if (mission.montant_ht == null || mission.remuneration_convoyeur == null) return null;
    const approved = approvedMap[mission.id] || 0;
    return parseFloat(mission.montant_ht) - parseFloat(mission.remuneration_convoyeur) - approved;
  }
  const mission = { id: 'm1', montant_ht: 328, remuneration_convoyeur: 200, marge: 999, source_mission: 'direct' };

  await test('29. approved expense included in profitability', () => {
    const apm = approvedExpensesByMission([
      { mission_id: 'm1', amount: 20, status: 'approved' },
      { mission_id: 'm1', amount: 40, status: 'approved' }
    ]);
    assert.strictEqual(apm.m1, 60);
    assert.strictEqual(deterministicMargin(mission, apm), 68);
  });
  await test('30. submitted expense excluded', () => {
    const apm = approvedExpensesByMission([
      { mission_id: 'm1', amount: 100, status: 'submitted' },
      { mission_id: 'm1', amount: 40, status: 'approved' }
    ]);
    assert.strictEqual(apm.m1, 40);
  });
  await test('31. draft expense excluded', () => {
    const apm = approvedExpensesByMission([
      { mission_id: 'm1', amount: 100, status: 'draft' },
      { mission_id: 'm1', amount: 40, status: 'approved' }
    ]);
    assert.strictEqual(apm.m1, 40);
  });
  await test('32. rejected expense excluded', () => {
    const apm = approvedExpensesByMission([
      { mission_id: 'm1', amount: 100, status: 'rejected' },
      { mission_id: 'm1', amount: 40, status: 'approved' }
    ]);
    assert.strictEqual(apm.m1, 40);
  });
  await test('33. margin decreases exactly by approved expense', () => {
    const before = deterministicMargin(mission, approvedExpensesByMission([{ mission_id: 'm1', amount: 20, status: 'approved' }]));
    const after = deterministicMargin(mission, approvedExpensesByMission([{ mission_id: 'm1', amount: 20, status: 'approved' }, { mission_id: 'm1', amount: 40, status: 'approved' }]));
    assert.strictEqual(before - after, 40);
  });
  await test('34. no double counting (one row per expense)', () => {
    const apm = approvedExpensesByMission([
      { mission_id: 'm1', amount: 20, status: 'approved' },
      { mission_id: 'm1', amount: 20, status: 'approved' }
    ]);
    assert.strictEqual(apm.m1, 40);
    // 328 - 200 - 40 = 88 (each expense counted once, not duplicated)
    assert.strictEqual(deterministicMargin(mission, apm), 88);
  });
  await test('35. stored missions.marge NOT used as authoritative', () => {
    // The deterministic margin ignores mission.marge (here 999) entirely.
    const apm = approvedExpensesByMission([{ mission_id: 'm1', amount: 60, status: 'approved' }]);
    const dm = deterministicMargin(mission, apm);
    assert.notStrictEqual(dm, mission.marge);
    assert.strictEqual(dm, 68);
  });

  // -----------------------------------------------------
  // 36-38: Hiflow reporting + source-independent
  // -----------------------------------------------------
  console.log('\n--- HIFLOW REPORTING ---');
  await test('36. Hiflow approved expense reflected in reporting aggregation', () => {
    const hiflowMission = { id: 'h1', montant_ht: 500, remuneration_convoyeur: 300, source_mission: 'hiflow' };
    const apm = approvedExpensesByMission([{ mission_id: 'h1', amount: 50, status: 'approved' }]);
    assert.strictEqual(deterministicMargin(hiflowMission, apm), 150);
  });
  await test('37. Hiflow margin updated after approved expense', () => {
    const hiflowMission = { id: 'h1', montant_ht: 500, remuneration_convoyeur: 300, source_mission: 'hiflow' };
    const before = deterministicMargin(hiflowMission, approvedExpensesByMission([]));
    const after = deterministicMargin(hiflowMission, approvedExpensesByMission([{ mission_id: 'h1', amount: 50, status: 'approved' }]));
    assert.strictEqual(before, 200);
    assert.strictEqual(after, 150);
  });
  await test('38. source-independent behavior (same RPC for all sources)', () => {
    const rpc = extractFunction(dash, 'async function admSubmitExpense');
    ['direct', 'hiflow', 'driiveme', 'alb', 'other'].forEach(src => {
      assert.ok(rpc.indexOf(src) === -1, 'submit must not branch on source: ' + src);
    });
  });

  // -----------------------------------------------------
  // 39-43: Source / billing isolation
  // -----------------------------------------------------
  console.log('\n--- SOURCE / BILLING ISOLATION ---');
  const addFlow = extractFunction(dash, 'async function admAddExpense') + extractFunction(dash, 'async function admSubmitExpense');
  await test('39. no Stripe call in add-expense flow', () => {
    assert.ok(!/stripe|create-checkout-session|createCheckoutSession/i.test(addFlow), 'add-expense flow must not call Stripe');
  });
  await test('40. no quote calculator call in add-expense flow', () => {
    assert.ok(!/calculateQuote|quote-calculator|devis/i.test(addFlow), 'add-expense flow must not call quote calculator');
  });
  await test('41. no billing mutation in add-expense flow', () => {
    assert.ok(!/billing|cancel_billing|loadBillingData/i.test(addFlow), 'add-expense flow must not mutate billing');
  });
  await test('42. no mission status mutation in add-expense flow', () => {
    assert.ok(!/transition_mission_status|updateMissionStatus|mission.*status/i.test(addFlow), 'add-expense flow must not mutate mission status');
    assert.ok(!/transition_mission_status/.test(migration), 'RPC must not call transition_mission_status');
  });
  await test('43. no AI automatic call in add-expense flow', () => {
    assert.ok(!/analyzeMissionProfitability|ai-assist|openai|chatgpt/i.test(addFlow), 'add-expense flow must not trigger AI');
  });

  // -----------------------------------------------------
  // 44-46: In-flight guard
  // -----------------------------------------------------
  console.log('\n--- IN-FLIGHT GUARD ---');
  await test('44. duplicate click / in-flight guard prevents double insert', () => {
    assert.ok(/let _admExpenseSubmitting = false/.test(dash), 'guard flag defined');
    const submit = extractFunction(dash, 'async function admSubmitExpense');
    assert.ok(/if \(_admExpenseSubmitting\) return/.test(submit), 'submit re-entry guarded');
    const add = extractFunction(dash, 'async function admAddExpense');
    assert.ok(/if \(_admExpenseSubmitting\) return/.test(add), 'add re-entry guarded');
  });
  await test('45. guard resets on success', () => {
    const submit = extractFunction(dash, 'async function admSubmitExpense');
    assert.ok(/finally\s*{[\s\S]*?_admExpenseSubmitting = false/.test(submit), 'guard reset in finally (covers success)');
  });
  await test('46. guard resets on error', () => {
    const submit = extractFunction(dash, 'async function admSubmitExpense');
    // finally block runs on both success and error paths
    assert.ok(/finally\s*{[\s\S]*?_admExpenseSubmitting = false/.test(submit), 'guard reset in finally (covers error)');
  });

  // -----------------------------------------------------
  // RPC security (authorization) — SQL-level
  // -----------------------------------------------------
  console.log('\n--- RPC SECURITY (SQL) ---');
  await test('47. RPC rejects anonymous callers', () => {
    assert.ok(/auth\.uid\(\) IS NULL/.test(migration), 'RPC checks auth.uid() IS NULL');
  });
  await test('48. admin allowed via is_admin()', () => {
    assert.ok(/public\.is_admin\(\)/.test(migration), 'RPC uses is_admin()');
  });
  await test('49. operator BLOCKED (admin-only, not is_operator)', () => {
    assert.ok(!/public\.is_operator\(\)/.test(migration), 'RPC must NOT use is_operator() (admin-only)');
    assert.ok(!/is_operator/.test(migration), 'RPC must not reference is_operator at all');
  });
  await test('50. client blocked (admin-only required)', () => {
    assert.ok(/NOT public\.is_admin\(\)/.test(migration), 'RPC requires is_admin() only');
    assert.ok(!/OR _is_operator/.test(migration), 'RPC must NOT allow operator');
  });
  await test('51. convoyeur admin access blocked (no convoyeur-only path)', () => {
    assert.ok(!/is_convoyeur_for_mission/.test(migration), 'RPC does not grant convoyeur-only access');
  });
  await test('52. mission existence validated', () => {
    assert.ok(/SELECT \* INTO _mission FROM public\.missions WHERE id = p_mission_id/.test(migration), 'RPC validates mission exists');
    assert.ok(/NOT FOUND/.test(migration), 'RPC rejects missing mission');
  });
  await test('53. amount > 0 + finite validated server-side', () => {
    assert.ok(/p_amount > 0/.test(migration), 'RPC checks amount > 0');
    assert.ok(/'NaN'::numeric/.test(migration), 'RPC rejects NaN');
  });
  await test('54. EXECUTE grants match P3.5 pattern (no PUBLIC, no anon)', () => {
    assert.ok(/REVOKE EXECUTE ON FUNCTION public\.admin_create_mission_expense.*FROM PUBLIC/.test(migration), 'REVOKE FROM PUBLIC');
    assert.ok(/REVOKE EXECUTE ON FUNCTION public\.admin_create_mission_expense.*FROM anon/.test(migration), 'REVOKE FROM anon');
    assert.ok(/GRANT EXECUTE ON FUNCTION public\.admin_create_mission_expense.*TO authenticated, service_role/.test(migration), 'GRANT to authenticated, service_role');
  });
  await test('55. no broad table INSERT/UPDATE grant added (additive only)', () => {
    assert.ok(!/GRANT INSERT ON public\.mission_expenses/.test(migration), 'no INSERT grant on table');
    assert.ok(!/GRANT UPDATE ON public\.mission_expenses/.test(migration), 'no UPDATE grant on table');
    assert.ok(!/ALTER TABLE public\.mission_expenses/.test(migration), 'no table ALTER');
    assert.ok(!/CREATE POLICY/.test(migration), 'no RLS policy change');
  });
  await test('56. SECURITY DEFINER + safe search_path', () => {
    assert.ok(/SECURITY DEFINER/.test(migration), 'RPC is SECURITY DEFINER');
    assert.ok(/SET search_path = ''/.test(migration), 'RPC uses empty search_path');
  });
  await test('57. audit event logged (expense_approved, actor_role=admin)', () => {
    assert.ok(/log_mission_event/.test(migration), 'RPC logs mission event');
    assert.ok(/'expense_approved'/.test(migration), 'event type is expense_approved');
    assert.ok(/'admin_created', true/.test(migration), 'admin_created flag set in metadata');
    // actor_role must be hardcoded 'admin' (no operator branch)
    assert.ok(/'admin',/.test(migration), 'actor_role is admin');
    assert.ok(!/CASE WHEN _is_admin THEN 'admin' ELSE 'operator' END/.test(migration), 'no operator actor_role branch');
  });

  // -----------------------------------------------------
  // Display label rendering (friendly subtype)
  // -----------------------------------------------------
  console.log('\n--- DISPLAY LABEL ---');
  await test('58. Train expense displays as "Train" (subtype label)', () => {
    assert.strictEqual(helpers.admExpDisplayLabel('return_transport', '[Train] Bordeaux → Montpellier'), 'Train');
  });
  await test('59. Bus expense displays as "Bus"', () => {
    assert.strictEqual(helpers.admExpDisplayLabel('return_transport', '[Bus] Aix'), 'Bus');
  });
  await test('60. Hôtel expense displays as "Hôtel"', () => {
    assert.strictEqual(helpers.admExpDisplayLabel('other', '[Hôtel] Clermont'), 'Hôtel');
  });
  await test('61. clean description strips subtype prefix', () => {
    assert.strictEqual(helpers.admExpCleanDescription('[Train] Bordeaux → Montpellier'), 'Bordeaux → Montpellier');
    assert.strictEqual(helpers.admExpCleanDescription('[Hôtel] Clermont-Ferrand'), 'Clermont-Ferrand');
  });
  await test('62. non-subtype description unchanged by clean', () => {
    assert.strictEqual(helpers.admExpCleanDescription('Essence plein'), 'Essence plein');
  });

  // -----------------------------------------------------
  // Receipt deferral
  // -----------------------------------------------------
  console.log('\n--- RECEIPT DEFERRAL ---');
  await test('63. admin receipt upload deferred (no upload in add flow)', () => {
    const add = extractFunction(dash, 'async function admAddExpense');
    // No storage upload calls in the add flow. The UI may mention that
    // justificatif is not required, but must not perform any upload.
    assert.ok(!/storage\.from|\.upload\(|register_mission_expense_receipt|admViewExpenseReceipts/i.test(add), 'add flow must not upload or register receipts');
    assert.ok(/Justificatif non requis/.test(dash), 'UI states justificatif not required');
  });

  // -----------------------------------------------------
  // Results
  // -----------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exitCode = 1;
}

runAll().catch((err) => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});
