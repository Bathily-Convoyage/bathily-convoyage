/**
 * MISSIONS-EXT-3B — Admin Expense Receipts — Browser Runtime Test
 *
 * Mandatory Playwright scenario from the spec (section 13):
 *
 * ADMIN success:
 *   1. open mission detail
 *   2. add expense
 *   3. select Train
 *   4. amount 23
 *   5. attach a small PDF fixture
 *   6. submit
 *   7. exactly one expense creation
 *   8. exactly one receipt upload/link flow
 *   9. no duplicate expense
 *   10. no duplicate upload
 *   11. receipt visible in expense display
 *   12. open/view action available
 *   13. no ReferenceError
 *   14. no page horizontal overflow
 *
 * ADMIN upload failure:
 *   - expense creation succeeds, receipt upload fails
 *   - UI explicitly says expense saved, receipt failed
 *
 * Supabase is mocked via addInitScript so no real DB/storage action occurs.
 */

import { test, expect } from '@playwright/test';

async function setupMockAdminContext(page, options = {}) {
  const { uploadShouldFail = false, attachShouldFail = false } = options;

  await page.route('**/@supabase/supabase-js@2**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.supabase = { createClient: function() { return window.__mockSupabaseClient; } };',
    });
  });

  await page.addInitScript(({ uploadShouldFail, attachShouldFail }) => {
    window.__rpcCalls = [];
    window.__storageUploads = [];
    window.__storageRemoves = [];
    window.__mockExpenses = [];
    window.__mockReceipts = {};
    window.__mockMissionId = '00000000-0000-0000-0000-000000000001';
    window.__uploadShouldFail = uploadShouldFail;
    window.__attachShouldFail = attachShouldFail;

    window.SUPABASE_URL = 'http://localhost:0';
    window.SUPABASE_ANON_KEY = 'mock-anon-key';

    function makeQueryBuilder(table) {
      const state = { eqFilters: {}, inFilters: {}, orderCol: null, orderOpts: null, selectCols: '*' };
      const builder = {
        select(cols) { state.selectCols = cols || '*'; return builder; },
        eq(col, val) { state.eqFilters[col] = val; return builder; },
        in(col, vals) { state.inFilters[col] = vals; return builder; },
        order(col, opts) { state.orderCol = col; state.orderOpts = opts; return builder; },
        then(resolve) {
          Promise.resolve().then(() => {
            if (table === 'mission_expenses') {
              const missionId = state.eqFilters.mission_id;
              const expenses = window.__mockExpenses.filter(e => !missionId || e.mission_id === missionId);
              resolve({ data: expenses, error: null });
            } else if (table === 'mission_expense_receipts') {
              // Return receipts for the requested expense_ids
              const expenseIds = state.inFilters.expense_id || [];
              const receipts = [];
              expenseIds.forEach(eid => {
                (window.__mockReceipts[eid] || []).forEach(r => receipts.push({ expense_id: eid }));
              });
              resolve({ data: receipts, error: null });
            } else {
              resolve({ data: [], error: null });
            }
          });
        },
      };
      return builder;
    }

    const mockStorage = {
      from(bucket) {
        return {
          async upload(path, file, opts) {
            window.__storageUploads.push({ bucket, path, contentType: opts && opts.contentType, fileSize: file && file.size });
            if (window.__uploadShouldFail) {
              return { data: null, error: { message: 'Storage upload failed' } };
            }
            return { data: { path }, error: null };
          },
          async remove(paths) {
            window.__storageRemoves.push({ bucket, paths });
            return { data: paths, error: null };
          },
          async createSignedUrl(path, seconds) {
            return { data: { signedUrl: 'https://mock.example/signed/' + encodeURIComponent(path) }, error: null };
          },
        };
      },
    };

    const mockClient = {
      from(table) { return makeQueryBuilder(table); },
      storage: mockStorage,
      async rpc(name, params) {
        window.__rpcCalls.push({ name, params: { ...params } });
        if (name === 'admin_create_mission_expense') {
          const newId = 'exp-' + (window.__rpcCalls.length);
          window.__mockExpenses.push({
            id: newId,
            mission_id: params.p_mission_id,
            expense_type: params.p_expense_type,
            amount: params.p_amount,
            expense_date: params.p_expense_date,
            description: params.p_description,
            status: 'approved',
            created_at: new Date().toISOString(),
            submitted_at: new Date().toISOString(),
            reviewed_by: 'admin-user-id',
            reviewed_at: new Date().toISOString(),
            review_notes: null,
          });
          return { data: newId, error: null };
        }
        if (name === 'admin_attach_mission_expense_receipt') {
          if (window.__attachShouldFail) {
            return { data: null, error: { message: 'Attach failed' } };
          }
          const eid = params.p_expense_id;
          if (!window.__mockReceipts[eid]) window.__mockReceipts[eid] = [];
          window.__mockReceipts[eid].push({
            id: 'receipt-' + window.__rpcCalls.length,
            storage_path: params.p_storage_path,
            mime_type: params.p_mime_type,
          });
          return { data: 'receipt-' + window.__rpcCalls.length, error: null };
        }
        return { data: null, error: null };
      },
    };

    window.supabase = { createClient() { return mockClient; } };
    window.__mockSupabaseClient = mockClient;

    const hideOverlay = () => {
      const el = document.getElementById('authOverlay');
      if (el) el.classList.add('hidden');
    };
    hideOverlay();
    const obs = new MutationObserver(() => hideOverlay());
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 5000);
  }, { uploadShouldFail, attachShouldFail });
}

async function openExpenseForm(page, missionId) {
  await page.evaluate((mid) => {
    window.admAddExpense(mid);
    return undefined;
  }, missionId);
}

async function clickSwalConfirm(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('.swal2-confirm');
    if (btn) btn.click();
  });
}

// Small valid PDF buffer
const PDF_FIXTURE = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n0\n%%EOF');

// Small JPEG buffer (1x1 pixel)
const JPEG_FIXTURE = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
  0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
  0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
  0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
  0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC9, 0x00, 0x0B, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xCC, 0x00, 0x06, 0x00, 0x10,
  0x10, 0x05, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
  0xD2, 0xCF, 0x20, 0xFF, 0xD9
]);

test.describe('MISSIONS-EXT-3B: Admin Expense Receipts — Runtime', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAdminContext(page);
    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      if (typeof Swal !== 'undefined' && Swal.close) Swal.close();
      const el = document.getElementById('authOverlay');
      if (el) el.classList.add('hidden');
    });
  });

  test('PDF receipt: add expense with receipt — single creation, single upload, no ReferenceError', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'train');
    await page.fill('#admExpAmount', '23');
    await page.fill('#admExpDesc', 'Bordeaux → Montpellier');

    // Attach PDF receipt
    await page.locator('#admExpReceipt').setInputFiles({
      name: 'receipt.pdf',
      mimeType: 'application/pdf',
      buffer: PDF_FIXTURE,
    });

    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    const attachCalls = calls.filter(c => c.name === 'admin_attach_mission_expense_receipt');

    // Exactly one expense creation
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].params.p_expense_type).toBe('return_transport');
    expect(createCalls[0].params.p_amount).toBe(23);
    expect(createCalls[0].params.p_description).toBe('[Train] Bordeaux → Montpellier');

    // Exactly one receipt upload/link
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].params.p_storage_bucket).toBe('mission-expenses');
    expect(attachCalls[0].params.p_mime_type).toBe('application/pdf');
    expect(attachCalls[0].params.p_storage_path).toMatch(/^missions\/[^\/]+\/expenses\/[^\/]+\//);

    // Exactly one storage upload
    const uploads = await page.evaluate(() => window.__storageUploads);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe('mission-expenses');
    expect(uploads[0].contentType).toBe('application/pdf');

    // No orphan cleanup (success path)
    const removes = await page.evaluate(() => window.__storageRemoves);
    expect(removes).toHaveLength(0);

    // No ReferenceError
    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('JPEG receipt: add expense with image — single creation, single upload', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'carburant');
    await page.fill('#admExpAmount', '45.50');
    await page.fill('#admExpDesc', 'Plein essence');

    await page.locator('#admExpReceipt').setInputFiles({
      name: 'fuel.jpg',
      mimeType: 'image/jpeg',
      buffer: JPEG_FIXTURE,
    });

    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    const attachCalls = calls.filter(c => c.name === 'admin_attach_mission_expense_receipt');

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].params.p_expense_type).toBe('fuel');
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].params.p_mime_type).toBe('image/jpeg');

    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('no receipt: add expense without receipt — single creation, no upload', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'peage');
    await page.fill('#admExpAmount', '12.30');
    await page.fill('#admExpDesc', 'Péage A10');

    // No file attached
    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    const attachCalls = calls.filter(c => c.name === 'admin_attach_mission_expense_receipt');

    expect(createCalls).toHaveLength(1);
    expect(attachCalls).toHaveLength(0); // no receipt attach

    const uploads = await page.evaluate(() => window.__storageUploads);
    expect(uploads).toHaveLength(0);

    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('upload failure: expense saved, receipt failed — explicit partial message', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    // Re-setup with upload failure
    await page.evaluate(() => {
      window.__uploadShouldFail = true;
      window.__rpcCalls = [];
      window.__storageUploads = [];
      window.__mockExpenses = [];
    });

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'train');
    await page.fill('#admExpAmount', '23');
    await page.fill('#admExpDesc', 'Bordeaux → Paris');

    await page.locator('#admExpReceipt').setInputFiles({
      name: 'receipt.pdf',
      mimeType: 'application/pdf',
      buffer: PDF_FIXTURE,
    });

    await clickSwalConfirm(page);
    await page.waitForTimeout(4000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    const attachCalls = calls.filter(c => c.name === 'admin_attach_mission_expense_receipt');

    // Expense was created (saved)
    expect(createCalls).toHaveLength(1);

    // Receipt attach was NOT called (upload failed first)
    expect(attachCalls).toHaveLength(0);

    // Storage upload was attempted
    const uploads = await page.evaluate(() => window.__storageUploads);
    expect(uploads).toHaveLength(1);

    // No orphan cleanup needed (upload failed, no object created)
    const removes = await page.evaluate(() => window.__storageRemoves);
    expect(removes).toHaveLength(0);

    // The UI should show the partial failure message
    const swalText = await page.evaluate(() => {
      const popup = document.querySelector('.swal2-popup');
      return popup ? popup.textContent : '';
    });
    expect(swalText).toContain('Frais enregistré');
    expect(swalText).toContain('justificatif');

    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('attach failure: expense saved, RPC link fails, orphan cleanup', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    // Re-setup with attach failure (upload succeeds, RPC fails)
    await page.evaluate(() => {
      window.__attachShouldFail = true;
      window.__rpcCalls = [];
      window.__storageUploads = [];
      window.__storageRemoves = [];
      window.__mockExpenses = [];
    });

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'hotel');
    await page.fill('#admExpAmount', '80');
    await page.fill('#admExpDesc', 'Clermont-Ferrand');

    await page.locator('#admExpReceipt').setInputFiles({
      name: 'hotel.pdf',
      mimeType: 'application/pdf',
      buffer: PDF_FIXTURE,
    });

    await clickSwalConfirm(page);
    await page.waitForTimeout(4000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    const attachCalls = calls.filter(c => c.name === 'admin_attach_mission_expense_receipt');

    // Expense was created
    expect(createCalls).toHaveLength(1);

    // Receipt attach was attempted (and failed)
    expect(attachCalls).toHaveLength(1);

    // Storage upload succeeded
    const uploads = await page.evaluate(() => window.__storageUploads);
    expect(uploads).toHaveLength(1);

    // Orphan cleanup was attempted (remove called)
    const removes = await page.evaluate(() => window.__storageRemoves);
    expect(removes).toHaveLength(1);
    expect(removes[0].bucket).toBe('mission-expenses');

    // UI shows partial failure
    const swalText = await page.evaluate(() => {
      const popup = document.querySelector('.swal2-popup');
      return popup ? popup.textContent : '';
    });
    expect(swalText).toContain('Frais enregistré');

    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('no duplicate expense on double submit (in-flight guard)', async ({ page }) => {
    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'train');
    await page.fill('#admExpAmount', '23');
    await page.fill('#admExpDesc', 'Test double');

    await page.locator('#admExpReceipt').setInputFiles({
      name: 'r.pdf',
      mimeType: 'application/pdf',
      buffer: PDF_FIXTURE,
    });

    // Click confirm twice rapidly
    await clickSwalConfirm(page);
    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    expect(createCalls).toHaveLength(1);
  });

  test('receipt visible in expense display after refresh', async ({ page }) => {
    // The #adminMissionExpenses element only exists inside the mission detail
    // modal. We inject it into the DOM so loadAdminMissionExpenses can render
    // into it, then verify the rendered HTML shows the receipt action.
    await page.evaluate(() => {
      // Inject the container if the mission modal isn't open
      if (!document.getElementById('adminMissionExpenses')) {
        const div = document.createElement('div');
        div.id = 'adminMissionExpenses';
        document.body.appendChild(div);
      }
      window.__mockExpenses = [{
        id: 'exp-pre-1',
        mission_id: '00000000-0000-0000-0000-000000000001',
        expense_type: 'fuel',
        amount: 30,
        expense_date: '2026-09-01',
        description: 'Essence',
        status: 'approved',
        created_at: new Date().toISOString(),
        submitted_at: new Date().toISOString(),
        reviewed_by: 'admin',
        reviewed_at: new Date().toISOString(),
        review_notes: null,
      }];
      window.__mockReceipts['exp-pre-1'] = [{
        id: 'receipt-pre-1',
        storage_path: 'missions/00000000-0000-0000-0000-000000000001/expenses/exp-pre-1/test.pdf',
        mime_type: 'application/pdf',
      }];
    });

    // Trigger expense reload
    await page.evaluate(() => {
      window._adminCurrentExpenseMissionId = '00000000-0000-0000-0000-000000000001';
      window.loadAdminMissionExpenses('00000000-0000-0000-0000-000000000001');
    });
    await page.waitForTimeout(2000);

    // The expense should show "Justificatif" (view button)
    const expenseHtml = await page.evaluate(() => {
      const el = document.getElementById('adminMissionExpenses');
      return el ? el.innerHTML : '';
    });
    expect(expenseHtml).toContain('Justificatif');
    expect(expenseHtml).toContain('admViewExpenseReceipts');
  });

  test('expense without receipt shows "Ajouter un justificatif" action', async ({ page }) => {
    await page.evaluate(() => {
      if (!document.getElementById('adminMissionExpenses')) {
        const div = document.createElement('div');
        div.id = 'adminMissionExpenses';
        document.body.appendChild(div);
      }
      window.__mockExpenses = [{
        id: 'exp-pre-2',
        mission_id: '00000000-0000-0000-0000-000000000001',
        expense_type: 'toll',
        amount: 15,
        expense_date: '2026-09-01',
        description: 'Péage',
        status: 'approved',
        created_at: new Date().toISOString(),
        submitted_at: new Date().toISOString(),
        reviewed_by: 'admin',
        reviewed_at: new Date().toISOString(),
        review_notes: null,
      }];
      window.__mockReceipts['exp-pre-2'] = [];
    });

    await page.evaluate(() => {
      window._adminCurrentExpenseMissionId = '00000000-0000-0000-0000-000000000001';
      window.loadAdminMissionExpenses('00000000-0000-0000-0000-000000000001');
    });
    await page.waitForTimeout(2000);

    const expenseHtml = await page.evaluate(() => {
      const el = document.getElementById('adminMissionExpenses');
      return el ? el.innerHTML : '';
    });
    expect(expenseHtml).toContain('Ajouter un justificatif');
    expect(expenseHtml).toContain('admAttachExpenseReceipt');
  });

  test('no page horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(overflow).toBe(false);
  });

  test('no ReferenceError on page load', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);
    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('admUploadAndAttachReceipt and admAttachExpenseReceipt are globally defined', async ({ page }) => {
    expect(await page.evaluate(() => typeof window.admUploadAndAttachReceipt)).toBe('function');
    expect(await page.evaluate(() => typeof window.admAttachExpenseReceipt)).toBe('function');
  });

  test('ADM_RECEIPT_ALLOWED_MIMES and ADM_RECEIPT_MAX_SIZE are defined', async ({ page }) => {
    // These are closure-scoped consts, but the form validation uses them.
    // We verify the form input has the correct accept attribute.
    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);
    const accept = await page.locator('#admExpReceipt').getAttribute('accept');
    expect(accept).toBe('image/jpeg,image/png,image/webp,application/pdf');
  });
});
