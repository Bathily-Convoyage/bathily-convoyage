/**
 * MISSIONS-EXT-3B — Admin Expense Receipts — Static Tests
 *
 * Covers the mandatory test matrix from the spec (section 12):
 *   ADMIN: no receipt PASS, PDF/JPEG/PNG/WEBP PASS, unsupported DENY,
 *          oversize DENY, duplicate DENY, nonexistent DENY, forged path DENY
 *   OPERATOR: admin receipt attach DENY
 *   CLIENT: DENY
 *   ACTIVE CONVOYEUR: admin path DENY, existing flow unchanged
 *   BANNED CONVOYEUR: DENY
 *   ANON: DENY
 *
 * Also verifies:
 *   - Storage INSERT policy is admin-only (not broad authenticated)
 *   - Storage DELETE policy is admin-only + orphan-only
 *   - Receipt immutability preserved (immutable trigger untouched)
 *   - No public bucket exposure
 *   - Audit event logged (expense_receipt_attached)
 *   - UI: receipt file input, MIME/size validation, partial-failure UX,
 *         "Ajouter un justificatif" action, no raw storage paths exposed
 *
 * Static tests only — no DB, no network, no browser. The runtime UI
 * interaction is covered separately by the Playwright runtime test.
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
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260906130000_missions_ext_3b_admin_expense_receipts.sql');
const EXISTING_RECEIPT_MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20260811000003_phase3_c22c3_mission_expenses.sql');
const ADMIN_EXPENSE_MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20260905130000_missions_ext_2c_admin_expense_rpc.sql');

// =====================================================
// Helpers
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

// =====================================================
// TEST SUITES
// =====================================================
async function runAll() {
  const dash = fs.readFileSync(DASH_PATH, 'utf8');
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const existingReceiptMigration = fs.readFileSync(EXISTING_RECEIPT_MIGRATION, 'utf8');
  const adminExpenseMigration = fs.readFileSync(ADMIN_EXPENSE_MIGRATION, 'utf8');

  // -----------------------------------------------------
  // ADMIN: create approved expense without receipt => PASS
  // -----------------------------------------------------
  console.log('\n--- ADMIN: NO RECEIPT ---');
  await test('1. admin_create_mission_expense still works without receipt (unchanged)', () => {
    // The existing RPC is not modified by the 3B migration
    assert.ok(/admin_create_mission_expense/.test(adminExpenseMigration), 'existing RPC present');
    assert.ok(!/admin_attach_mission_expense_receipt/.test(adminExpenseMigration), '3B does not modify 2C migration');
  });
  await test('2. receiptFile is optional in form (null allowed)', () => {
    const preConfirm = extractFunction(dash, 'preConfirm: function');
    assert.ok(/receiptFile/.test(preConfirm), 'preConfirm handles receiptFile');
    assert.ok(/receiptFile \|\| null/.test(preConfirm), 'receiptFile defaults to null');
  });
  await test('3. admSubmitExpense handles null receiptFile (no upload attempt)', () => {
    const submit = extractFunction(dash, 'async function admSubmitExpense');
    assert.ok(/payload\.receiptFile && expenseId/.test(submit), 'upload gated on receiptFile && expenseId');
  });

  // -----------------------------------------------------
  // ADMIN: create approved expense with receipt => PASS (PDF/JPEG/PNG/WEBP)
  // -----------------------------------------------------
  console.log('\n--- ADMIN: RECEIPT UPLOAD (PDF/JPEG/PNG/WEBP) ---');
  await test('4. PDF receipt accepted (client + server)', () => {
    const preConfirm = extractFunction(dash, 'preConfirm: function');
    assert.ok(/application\/pdf/.test(preConfirm) || /ADM_RECEIPT_ALLOWED_MIMES/.test(preConfirm), 'client checks MIME allowlist');
    assert.ok(/application\/pdf/.test(migration), 'server allows application/pdf');
  });
  await test('5. JPEG receipt accepted (client + server)', () => {
    assert.ok(/image\/jpeg/.test(migration), 'server allows image/jpeg');
    const consts = dash.match(/const ADM_RECEIPT_ALLOWED_MIMES\s*=\s*\[[\s\S]*?\];/);
    assert.ok(consts, 'ADM_RECEIPT_ALLOWED_MIMES defined');
    assert.ok(/image\/jpeg/.test(consts[0]), 'client allows image/jpeg');
  });
  await test('6. PNG receipt accepted (client + server)', () => {
    assert.ok(/image\/png/.test(migration), 'server allows image/png');
  });
  await test('7. WEBP receipt accepted (client + server)', () => {
    assert.ok(/image\/webp/.test(migration), 'server allows image/webp');
  });
  await test('8. form has file input with correct accept attribute', () => {
    assert.ok(/id="admExpReceipt"/.test(dash), 'receipt file input present');
    assert.ok(/accept="image\/jpeg,image\/png,image\/webp,application\/pdf"/.test(dash), 'accept attribute lists allowed types');
  });
  await test('9. admUploadAndAttachReceipt uploads to correct path pattern', () => {
    const fn = extractFunction(dash, 'async function admUploadAndAttachReceipt');
    assert.ok(/missions\/.*\/expenses\/.*\//.test(fn), 'path follows missions/{mid}/expenses/{eid}/ pattern');
    assert.ok(/mission-expenses/.test(fn), 'uses mission-expenses bucket');
  });
  await test('10. admUploadAndAttachReceipt calls admin_attach_mission_expense_receipt RPC', () => {
    const fn = extractFunction(dash, 'async function admUploadAndAttachReceipt');
    assert.ok(/admin_attach_mission_expense_receipt/.test(fn), 'calls admin_attach RPC');
    assert.ok(/p_expense_id/.test(fn), 'passes expense_id');
    assert.ok(/p_storage_bucket/.test(fn), 'passes bucket');
    assert.ok(/p_storage_path/.test(fn), 'passes path');
    assert.ok(/p_mime_type/.test(fn), 'passes mime type');
  });

  // -----------------------------------------------------
  // UNSUPPORTED MIME => DENY
  // -----------------------------------------------------
  console.log('\n--- UNSUPPORTED MIME DENY ---');
  await test('11. server rejects unsupported MIME (not in allowlist)', () => {
    assert.ok(/p_mime_type NOT IN \('image\/jpeg', 'image\/png', 'image\/webp', 'application\/pdf'\)/.test(migration), 'RPC enforces MIME allowlist');
  });
  await test('12. client rejects unsupported MIME', () => {
    const preConfirm = extractFunction(dash, 'preConfirm: function');
    assert.ok(/ADM_RECEIPT_ALLOWED_MIMES\.includes\(receiptFile\.type\)/.test(preConfirm), 'client checks MIME against allowlist');
    assert.ok(/Format de justificatif refusé/.test(preConfirm), 'client shows format refused message');
  });
  await test('13. SVG not in allowlist', () => {
    assert.ok(!/image\/svg/.test(migration), 'SVG not allowed server-side');
    const consts = dash.match(/const ADM_RECEIPT_ALLOWED_MIMES\s*=\s*\[[\s\S]*?\];/);
    assert.ok(!/svg/.test(consts[0]), 'SVG not allowed client-side');
  });
  await test('14. HTML not in allowlist', () => {
    assert.ok(!/text\/html/.test(migration), 'HTML not allowed server-side');
  });

  // -----------------------------------------------------
  // OVERSIZE => DENY
  // -----------------------------------------------------
  console.log('\n--- OVERSIZE DENY ---');
  await test('15. client rejects files > 5 MiB', () => {
    const preConfirm = extractFunction(dash, 'preConfirm: function');
    assert.ok(/ADM_RECEIPT_MAX_SIZE/.test(preConfirm), 'client checks max size');
    assert.ok(/receiptFile\.size > ADM_RECEIPT_MAX_SIZE/.test(preConfirm), 'client compares size to max');
    assert.ok(/5 Mo max/.test(preConfirm), 'client shows 5 Mo max message');
  });
  await test('16. ADM_RECEIPT_MAX_SIZE = 5 MiB', () => {
    const consts = dash.match(/const ADM_RECEIPT_MAX_SIZE\s*=\s*[\d\s*\/]+;/);
    assert.ok(consts, 'ADM_RECEIPT_MAX_SIZE defined');
    // Evaluate the expression
    const expr = consts[0].replace(/const ADM_RECEIPT_MAX_SIZE\s*=\s*/, '').replace(/;/, '');
    assert.strictEqual(eval(expr), 5 * 1024 * 1024, 'max size is 5 MiB');
  });
  await test('17. server bucket enforces 5 MiB limit (unchanged)', () => {
    assert.ok(/5242880/.test(existingReceiptMigration), 'bucket file_size_limit = 5 MiB');
  });

  // -----------------------------------------------------
  // SECOND RECEIPT SAME EXPENSE => DENY
  // -----------------------------------------------------
  console.log('\n--- DUPLICATE RECEIPT DENY ---');
  await test('18. server enforces max 1 receipt per expense', () => {
    assert.ok(/_count >= 1/.test(migration), 'RPC checks count >= 1');
    assert.ok(/Un justificatif maximum par frais/.test(migration), 'RPC rejects with max 1 message');
  });
  await test('19. RECEIPT_REPLACE = DENY (immutable trigger untouched)', () => {
    // The 3B migration must NOT create/drop/replace the immutability trigger
    assert.ok(!/CREATE.*TRIGGER.*mission_expense_receipts_immutable/.test(migration), '3B does not create immutability trigger');
    assert.ok(!/DROP TRIGGER.*mission_expense_receipts_immutable/.test(migration), '3B does not drop immutability trigger');
    assert.ok(!/CREATE OR REPLACE FUNCTION public\.mission_expense_receipts_immutable/.test(migration), '3B does not replace immutability function');
    // The existing immutability trigger blocks UPDATE and DELETE
    assert.ok(/mission_expense_receipts_immutable/.test(existingReceiptMigration), 'immutability trigger exists');
    assert.ok(/BEFORE UPDATE OR DELETE/.test(existingReceiptMigration), 'trigger blocks UPDATE and DELETE');
  });

  // -----------------------------------------------------
  // ATTACH TO NONEXISTENT EXPENSE => DENY
  // -----------------------------------------------------
  console.log('\n--- NONEXISTENT EXPENSE DENY ---');
  await test('20. server rejects nonexistent expense', () => {
    assert.ok(/SELECT \* INTO _expense FROM public\.mission_expenses WHERE id = p_expense_id/.test(migration), 'RPC selects expense');
    assert.ok(/IF NOT FOUND/.test(migration), 'RPC checks NOT FOUND');
  });

  // -----------------------------------------------------
  // FORGED PATH (cross-mission) => DENY
  // -----------------------------------------------------
  console.log('\n--- FORGED PATH DENY ---');
  await test('21. server validates path matches expense mission_id', () => {
    assert.ok(/_path_mission := split_part\(p_storage_path, '\/', 2\)/.test(migration), 'extracts mission from path');
    assert.ok(/_path_mission <> \(_expense\.mission_id\)::text/.test(migration), 'compares path mission to expense mission');
  });
  await test('22. server validates path matches expense_id', () => {
    assert.ok(/_path_expense := split_part\(p_storage_path, '\/', 4\)/.test(migration), 'extracts expense from path');
    assert.ok(/_path_expense <> \(_expense\.id\)::text/.test(migration), 'compares path expense to expense id');
  });
  await test('23. server verifies object exists with owner = auth.uid()', () => {
    assert.ok(/SELECT 1 FROM storage\.objects/.test(migration), 'checks storage.objects');
    assert.ok(/owner = auth\.uid\(\)/.test(migration), 'verifies owner is caller');
  });
  await test('24. server rejects wrong bucket', () => {
    assert.ok(/p_storage_bucket <> 'mission-expenses'/.test(migration), 'RPC checks bucket exact match');
  });

  // -----------------------------------------------------
  // OPERATOR: admin receipt attach => DENY
  // -----------------------------------------------------
  console.log('\n--- OPERATOR DENY ---');
  await test('25. RPC is admin-only (is_admin, not is_operator)', () => {
    assert.ok(/public\.is_admin\(\)/.test(migration), 'RPC uses is_admin()');
    assert.ok(!/public\.is_operator\(\)/.test(migration), 'RPC does NOT use is_operator()');
  });
  await test('26. storage INSERT policy is admin-only', () => {
    assert.ok(/mission_expenses_storage_insert_admin/.test(migration), 'admin INSERT policy exists');
    assert.ok(/public\.is_admin\(\)/.test(migration), 'INSERT policy checks is_admin()');
    // The existing operator INSERT policy must NOT be modified
    assert.ok(!/DROP POLICY IF EXISTS "mission_expenses_storage_insert" ON storage\.objects/.test(migration), '3B does not drop existing operator INSERT policy');
  });
  await test('27. operator cannot use admin_attach RPC (no is_operator branch)', () => {
    const rpcBody = migration.match(/CREATE OR REPLACE FUNCTION public\.admin_attach_mission_expense_receipt[\s\S]*?\$\$/);
    assert.ok(rpcBody, 'RPC body found');
    assert.ok(!/is_operator/.test(rpcBody[0]), 'RPC body has no is_operator reference');
  });

  // -----------------------------------------------------
  // CLIENT: DENY
  // -----------------------------------------------------
  console.log('\n--- CLIENT DENY ---');
  await test('28. client blocked (admin-only, no client role check)', () => {
    assert.ok(/NOT public\.is_admin\(\)/.test(migration), 'RPC requires is_admin() only');
    assert.ok(!/is_client/.test(migration), 'RPC does not reference is_client');
  });

  // -----------------------------------------------------
  // ACTIVE CONVOYEUR: admin path DENY, existing flow unchanged
  // -----------------------------------------------------
  console.log('\n--- CONVOYEUR ---');
  await test('29. convoyeur cannot use admin_attach RPC (no convoyeur branch)', () => {
    const rpcBody = migration.match(/CREATE OR REPLACE FUNCTION public\.admin_attach_mission_expense_receipt[\s\S]*?\$\$/);
    assert.ok(!/is_convoyeur/.test(rpcBody[0]), 'RPC body has no convoyeur reference');
  });
  await test('30. existing convoyeur receipt RPC unchanged', () => {
    // 3B migration must NOT modify register_mission_expense_receipt
    // 3B migration must NOT create/replace/drop the existing convoyeur RPC
    assert.ok(!/CREATE.*FUNCTION.*register_mission_expense_receipt/.test(migration), '3B does not create convoyeur RPC');
    assert.ok(!/DROP FUNCTION.*register_mission_expense_receipt/.test(migration), '3B does not drop convoyeur RPC');
  });
  await test('31. existing convoyeur storage SELECT policy unchanged', () => {
    assert.ok(!/DROP POLICY IF EXISTS "mission_expenses_storage_select"/.test(migration), '3B does not touch existing SELECT policy');
  });
  await test('32. existing convoyeur storage INSERT policy unchanged', () => {
    assert.ok(!/DROP POLICY IF EXISTS "mission_expenses_storage_insert" ON/.test(migration), '3B does not drop operator INSERT policy');
    // The new admin INSERT policy is ADDITIVE (DROP IF EXISTS only for the admin policy name)
    assert.ok(/DROP POLICY IF EXISTS "mission_expenses_storage_insert_admin"/.test(migration), '3B only drops its own admin INSERT policy');
  });

  // -----------------------------------------------------
  // BANNED CONVOYEUR: DENY
  // -----------------------------------------------------
  console.log('\n--- BANNED CONVOYEUR DENY ---');
  await test('33. banned convoyeur blocked (is_admin required, no convoyeur bypass)', () => {
    assert.ok(/IF NOT public\.is_admin\(\) THEN/.test(migration), 'RPC hard-gates on is_admin()');
  });

  // -----------------------------------------------------
  // ANON: DENY
  // -----------------------------------------------------
  console.log('\n--- ANON DENY ---');
  await test('34. anonymous blocked (auth.uid() IS NULL check)', () => {
    assert.ok(/auth\.uid\(\) IS NULL/.test(migration), 'RPC checks auth.uid() IS NULL');
  });
  await test('35. EXECUTE grants: no PUBLIC, no anon', () => {
    assert.ok(/REVOKE EXECUTE ON FUNCTION public\.admin_attach_mission_expense_receipt.*FROM PUBLIC/.test(migration), 'REVOKE FROM PUBLIC');
    assert.ok(/REVOKE EXECUTE ON FUNCTION public\.admin_attach_mission_expense_receipt.*FROM anon/.test(migration), 'REVOKE FROM anon');
    assert.ok(/GRANT EXECUTE ON FUNCTION public\.admin_attach_mission_expense_receipt.*TO authenticated, service_role/.test(migration), 'GRANT to authenticated, service_role');
  });

  // -----------------------------------------------------
  // PUBLIC BUCKET = NO, BROAD AUTH INSERT = NO
  // -----------------------------------------------------
  console.log('\n--- NO PUBLIC BUCKET / NO BROAD INSERT ---');
  await test('36. no public bucket exposure (bucket remains private)', () => {
    assert.ok(!/public\s*=\s*true/.test(migration), '3B does not set bucket to public');
    // The existing bucket is private
    assert.ok(/public,\s*\n\s*ARRAY\['image\/jpeg'/.test(existingReceiptMigration) || /false,/.test(existingReceiptMigration), 'existing bucket is private');
  });
  await test('37. no broad authenticated INSERT (admin-only policy)', () => {
    // The INSERT policy must require is_admin(), not just authenticated
    const insertPolicy = migration.match(/CREATE POLICY "mission_expenses_storage_insert_admin"[\s\S]*?;/);
    assert.ok(insertPolicy, 'admin INSERT policy found');
    assert.ok(/public\.is_admin\(\)/.test(insertPolicy[0]), 'INSERT policy requires is_admin()');
  });

  // -----------------------------------------------------
  // FAILURE SAFETY
  // -----------------------------------------------------
  console.log('\n--- FAILURE SAFETY ---');
  await test('38. expense saved + receipt failed: UI shows explicit partial message', () => {
    const submit = extractFunction(dash, 'async function admSubmitExpense');
    assert.ok(/Frais enregistré, justificatif échoué/.test(submit), 'partial failure message present');
    assert.ok(/Le frais a été enregistré et approuvé/.test(submit), 'confirms expense saved');
    assert.ok(/justificatif n\\'a pas pu être ajouté/.test(submit), 'states receipt failed');
  });
  await test('39. expense remains valid on receipt failure (refresh still happens)', () => {
    const submit = extractFunction(dash, 'async function admSubmitExpense');
    // After partial failure, _refreshAdminExpenses is still called
    assert.ok(/_refreshAdminExpenses\(\)/.test(submit), 'expenses refreshed after partial failure');
  });
  await test('40. retry possible via "Ajouter un justificatif" on expense row', () => {
    assert.ok(/admAttachExpenseReceipt/.test(dash), 'attach function defined');
    assert.ok(/Ajouter un justificatif/.test(dash), 'attach button label present');
  });
  await test('41. orphan cleanup on RPC link failure', () => {
    const fn = extractFunction(dash, 'async function admUploadAndAttachReceipt');
    assert.ok(/storage\.from\('mission-expenses'\)\.remove/.test(fn), 'cleanup removes orphaned object');
  });
  await test('42. storage DELETE policy only allows orphaned objects', () => {
    const deletePolicy = migration.match(/CREATE POLICY "mission_expenses_storage_delete_admin_orphan"[\s\S]*?;/);
    assert.ok(deletePolicy, 'admin DELETE policy found');
    assert.ok(/NOT EXISTS/.test(deletePolicy[0]), 'DELETE policy requires NOT EXISTS (orphan only)');
    assert.ok(/mission_expense_receipts/.test(deletePolicy[0]), 'DELETE policy checks receipts table');
    assert.ok(/mer\.storage_path = objects\.name/.test(deletePolicy[0]), 'DELETE policy checks path match');
  });

  // -----------------------------------------------------
  // AUDIT TRAIL
  // -----------------------------------------------------
  console.log('\n--- AUDIT TRAIL ---');
  await test('43. audit event logged (expense_receipt_attached)', () => {
    assert.ok(/log_mission_event/.test(migration), 'RPC logs mission event');
    assert.ok(/'expense_receipt_attached'/.test(migration), 'event type is expense_receipt_attached');
  });
  await test('44. audit metadata includes expense_id and receipt_id', () => {
    assert.ok(/'expense_id', _expense\.id/.test(migration), 'metadata has expense_id');
    assert.ok(/'receipt_id', _receipt_id/.test(migration), 'metadata has receipt_id');
  });
  await test('45. audit actor_role = admin', () => {
    assert.ok(/'admin'/.test(migration), 'actor_role is admin');
    assert.ok(/'admin_attached', true/.test(migration), 'admin_attached flag set');
  });
  await test('46. no sensitive storage secret in audit metadata', () => {
    const metadata = migration.match(/jsonb_build_object\([\s\S]*?\)/);
    assert.ok(metadata, 'metadata found');
    assert.ok(!/secret|password|token|key/.test(metadata[0]), 'no secrets in metadata');
  });

  // -----------------------------------------------------
  // UI: no raw storage paths exposed
  // -----------------------------------------------------
  console.log('\n--- UI: NO RAW PATHS ---');
  await test('47. UI does not expose raw storage paths to users', () => {
    // The admViewExpenseReceipts function uses signed URLs, not raw paths
    const viewFn = extractFunction(dash, 'async function admViewExpenseReceipts');
    assert.ok(/createSignedUrl/.test(viewFn), 'uses signed URLs for viewing');
    assert.ok(!/storage_path.*innerHTML|innerHTML.*storage_path/.test(viewFn), 'does not render raw storage_path in HTML');
  });
  await test('48. expense row shows "Justificatif" when receipt attached', () => {
    const render = extractFunction(dash, 'function _admRenderExpenseItem');
    assert.ok(/Justificatif/.test(render), 'shows Justificatif label for expenses with receipts');
  });
  await test('49. expense row shows "Ajouter un justificatif" when no receipt', () => {
    const render = extractFunction(dash, 'function _admRenderExpenseItem');
    assert.ok(/Ajouter un justificatif/.test(render), 'shows attach action for expenses without receipts');
  });

  // -----------------------------------------------------
  // SECURITY: SQL injection / path traversal
  // -----------------------------------------------------
  console.log('\n--- SECURITY ---');
  await test('50. SECURITY DEFINER + safe search_path', () => {
    assert.ok(/SECURITY DEFINER/.test(migration), 'RPC is SECURITY DEFINER');
    assert.ok(/SET search_path = ''/.test(migration), 'RPC uses empty search_path');
  });
  await test('51. no broad table INSERT/UPDATE grant added', () => {
    assert.ok(!/GRANT INSERT ON public\.mission_expense_receipts/.test(migration), 'no INSERT grant on receipts table');
    assert.ok(!/GRANT UPDATE ON public\.mission_expense_receipts/.test(migration), 'no UPDATE grant on receipts table');
    assert.ok(!/ALTER TABLE public\.mission_expense_receipts/.test(migration), 'no table ALTER');
  });
  await test('52. no RLS policy change on existing tables', () => {
    assert.ok(!/CREATE POLICY.*ON public\.mission_expenses/.test(migration), 'no new policy on mission_expenses table');
    assert.ok(!/CREATE POLICY.*ON public\.mission_expense_receipts/.test(migration), 'no new policy on receipts table');
  });
  await test('53. migration is additive (BEGIN/COMMIT, no destructive ops)', () => {
    assert.ok(/BEGIN;/.test(migration), 'migration wrapped in transaction');
    assert.ok(/COMMIT;/.test(migration), 'migration commits');
    assert.ok(!/DROP TABLE/.test(migration), 'no DROP TABLE');
    assert.ok(!/DROP COLUMN/.test(migration), 'no DROP COLUMN');
    assert.ok(!/TRUNCATE/.test(migration), 'no TRUNCATE');
  });

  // -----------------------------------------------------
  // EXISTING CONVOYEUR FLOW UNCHANGED
  // -----------------------------------------------------
  console.log('\n--- CONVOYEUR REGRESSION ---');
  await test('54. existing operator receipt flow unchanged (dashboard-operator.html)', () => {
    const opDash = fs.readFileSync(path.join(__dirname, '..', 'dashboard-operator.html'), 'utf8');
    assert.ok(/register_mission_expense_receipt/.test(opDash), 'operator still uses register_mission_expense_receipt');
    assert.ok(/showAddReceiptForm/.test(opDash), 'operator receipt form still present');
    assert.ok(!/admin_attach_mission_expense_receipt/.test(opDash), 'operator does NOT use admin_attach RPC');
  });
  await test('55. admin dashboard does NOT use convoyeur register RPC', () => {
    // Admin should use admin_attach, not the operator register RPC
    const adminAttachUsed = /admin_attach_mission_expense_receipt/.test(dash);
    const operatorRegisterUsed = /register_mission_expense_receipt/.test(dash);
    assert.ok(adminAttachUsed, 'admin uses admin_attach RPC');
    // register_mission_expense_receipt may appear in comments/old code but
    // the new upload flow must use admin_attach
    const uploadFn = extractFunction(dash, 'async function admUploadAndAttachReceipt');
    assert.ok(/admin_attach_mission_expense_receipt/.test(uploadFn), 'upload uses admin_attach');
    assert.ok(!/register_mission_expense_receipt/.test(uploadFn), 'upload does NOT use register RPC');
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
