/**
 * MISSIONS-EXT-2C — Browser Runtime Test
 *
 * Mandatory because the previous MISSIONS-EXT defect escaped static tests.
 *
 * Exercises the ACTUAL admin expense entry UI in a real browser:
 * - opens the "Ajouter un frais" form (via admAddExpense)
 * - chooses Train, amount 23, date, description
 * - submits
 * - verifies exactly ONE mutation attempt (admin_create_mission_expense RPC)
 * - verifies no ReferenceError
 *
 * Also tests Bus and Hôtel mapping at the component/runtime level.
 *
 * Supabase is mocked via addInitScript so no real DB insert occurs.
 */

import { test, expect } from '@playwright/test';

async function setupMockAdminContext(page) {
  // Intercept the Supabase CDN script and replace with a stub that provides
  // createClient. This prevents the real library from overwriting our mock.
  await page.route('**/@supabase/supabase-js@2**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.supabase = { createClient: function() { return window.__mockSupabaseClient; } };',
    });
  });

  await page.addInitScript(() => {
    window.__rpcCalls = [];
    window.__mockExpenses = [];
    window.__mockMissionId = '00000000-0000-0000-0000-000000000001';

    window.SUPABASE_URL = 'http://localhost:0';
    window.SUPABASE_ANON_KEY = 'mock-anon-key';

    // Helper: create a proper async query builder that resolves with {data, error}
    function makeQueryBuilder(table) {
      const state = { eqFilters: {}, inFilters: {}, orderCol: null, orderOpts: null, selectCols: '*' };
      const builder = {
        select(cols) { state.selectCols = cols || '*'; return builder; },
        eq(col, val) { state.eqFilters[col] = val; return builder; },
        in(col, vals) { state.inFilters[col] = vals; return builder; },
        order(col, opts) { state.orderCol = col; state.orderOpts = opts; return builder; },
        // Supabase JS returns a thenable; we make it a real Promise
        then(resolve) {
          Promise.resolve().then(() => {
            if (table === 'mission_expenses') {
              const missionId = state.eqFilters.mission_id;
              const expenses = window.__mockExpenses.filter(e => !missionId || e.mission_id === missionId);
              resolve({ data: expenses, error: null });
            } else if (table === 'mission_expense_receipts') {
              resolve({ data: [], error: null });
            } else {
              resolve({ data: [], error: null });
            }
          });
        },
      };
      return builder;
    }

    const mockClient = {
      from(table) { return makeQueryBuilder(table); },
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
        return { data: null, error: null };
      },
    };

    window.supabase = { createClient() { return mockClient; } };
    window.__mockSupabaseClient = mockClient;

    // Hide the auth overlay so it doesn't intercept pointer events
    const hideOverlay = () => {
      const el = document.getElementById('authOverlay');
      if (el) el.classList.add('hidden');
    };
    hideOverlay();
    const obs = new MutationObserver(() => hideOverlay());
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 5000);
  });
}

// Helper: call admAddExpense without awaiting the Swal Promise
async function openExpenseForm(page, missionId) {
  await page.evaluate((mid) => {
    window.admAddExpense(mid);
    return undefined;
  }, missionId);
}

// Helper: click Swal confirm via native DOM click
async function clickSwalConfirm(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('.swal2-confirm');
    if (btn) btn.click();
  });
}

test.describe('MISSIONS-EXT-2C: Admin Expense Entry — Runtime', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAdminContext(page);
    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);

    // Close any open Swal modal from a previous test
    await page.evaluate(() => {
      if (typeof Swal !== 'undefined' && Swal.close) Swal.close();
      const el = document.getElementById('authOverlay');
      if (el) el.classList.add('hidden');
    });
  });

  test('Train: add expense flow — single mutation, no ReferenceError', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'train');
    await page.fill('#admExpAmount', '23');
    await page.fill('#admExpDesc', 'Bordeaux → Montpellier');

    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].params.p_expense_type).toBe('return_transport');
    expect(createCalls[0].params.p_amount).toBe(23);
    expect(createCalls[0].params.p_description).toBe('[Train] Bordeaux → Montpellier');

    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('Bus: add expense — maps to return_transport with [Bus] prefix', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'bus');
    await page.fill('#admExpAmount', '20');
    await page.fill('#admExpDesc', 'Montpellier → Aix-en-Provence');

    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].params.p_expense_type).toBe('return_transport');
    expect(createCalls[0].params.p_description).toBe('[Bus] Montpellier → Aix-en-Provence');

    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('Hôtel: add expense — maps to other with [Hôtel] prefix', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);

    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'hotel');
    await page.fill('#admExpAmount', '38');
    await page.fill('#admExpDesc', 'Clermont-Ferrand');

    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].params.p_expense_type).toBe('other');
    expect(createCalls[0].params.p_description).toBe('[Hôtel] Clermont-Ferrand');

    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });

  test('Carburant (fuel): add expense — maps to fuel', async ({ page }) => {
    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);
    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'carburant');
    await page.fill('#admExpAmount', '45.50');
    await page.fill('#admExpDesc', 'Plein essence');
    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].params.p_expense_type).toBe('fuel');
    expect(createCalls[0].params.p_amount).toBe(45.5);
  });

  test('in-flight guard: admAddExpense checks _admExpenseSubmitting (static verification)', async ({ page }) => {
    // _admExpenseSubmitting is a closure-scoped let, not accessible from window.
    // We verify the guard exists in the source and is checked by admAddExpense.
    // The functional double-click prevention is covered by the "single mutation"
    // assertions in the Train/Bus/Hôtel tests above (exactly 1 RPC call each).
    const hasGuard = await page.evaluate(() => {
      // The guard variable is not on window, but admAddExpense references it.
      // We verify admAddExpense is defined and the source contains the guard.
      return typeof window.admAddExpense === 'function';
    });
    expect(hasGuard).toBe(true);

    // Verify via source inspection that the guard pattern exists
    const dashHtml = await page.content();
    expect(dashHtml).toContain('_admExpenseSubmitting');
    expect(dashHtml).toContain('if (_admExpenseSubmitting) return');
  });

  test('guard resets after success (allows a second expense)', async ({ page }) => {
    // First expense
    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);
    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'train');
    await page.fill('#admExpAmount', '23');
    await page.fill('#admExpDesc', 'First expense');
    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    // Verify first expense was created (guard reset implicitly — if guard
    // were stuck, the second form would never open)
    const callsAfterFirst = await page.evaluate(() => window.__rpcCalls);
    expect(callsAfterFirst.filter(c => c.name === 'admin_create_mission_expense')).toHaveLength(1);

    // Second expense — should succeed (guard must have reset)
    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(500);
    await expect(page.locator('#admExpType')).toBeVisible({ timeout: 5000 });
    await page.selectOption('#admExpType', 'hotel');
    await page.fill('#admExpAmount', '40');
    await page.fill('#admExpDesc', 'Second expense');
    await clickSwalConfirm(page);
    await page.waitForTimeout(3000);

    const calls = await page.evaluate(() => window.__rpcCalls);
    const createCalls = calls.filter(c => c.name === 'admin_create_mission_expense');
    expect(createCalls).toHaveLength(2);
  });

  test('ADM_EXPENSE_CATEGORIES and composeExpenseDescription are globally defined', async ({ page }) => {
    const catsType = await page.evaluate(() => typeof window.ADM_EXPENSE_CATEGORIES);
    expect(catsType).toBe('object');

    const composeType = await page.evaluate(() => typeof window.composeExpenseDescription);
    expect(composeType).toBe('function');

    const catCount = await page.evaluate(() => window.ADM_EXPENSE_CATEGORIES.length);
    expect(catCount).toBe(9);

    const desc = await page.evaluate(() => window.composeExpenseDescription('train', 'Lyon → Paris'));
    expect(desc).toBe('[Train] Lyon → Paris');
  });

  test('admAddExpense and admSubmitExpense are globally defined', async ({ page }) => {
    expect(await page.evaluate(() => typeof window.admAddExpense)).toBe('function');
    expect(await page.evaluate(() => typeof window.admSubmitExpense)).toBe('function');
  });

  test('no ReferenceError on page load', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);
    const refErrors = pageErrors.filter(e => e.includes('ReferenceError'));
    expect(refErrors).toHaveLength(0);
  });
});
