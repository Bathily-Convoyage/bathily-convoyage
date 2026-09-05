/**
 * MISSIONS-EXT-2C-HF1 — Responsive Expense Modal Hotfix
 *
 * Playwright runtime tests that verify the admin expense-entry SweetAlert
 * modal is responsive across multiple viewport sizes with no horizontal
 * overflow, all fields reachable, and buttons visible.
 *
 * Also includes a functional smoke test verifying the Train submit flow
 * still produces exactly one RPC mutation with no ReferenceError.
 */

import { test, expect } from '@playwright/test';

// ─── Mock Supabase context (shared by all tests) ───────────────────────
async function setupMockAdminContext(page) {
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

// ─── Viewport definitions ──────────────────────────────────────────────
const VIEWPORTS = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1024x700', width: 1024, height: 700 },
  { name: '768x700',  width: 768,  height: 700 },
  { name: '390x844',  width: 390,  height: 844 },
];

// ─── Responsive tests per viewport ─────────────────────────────────────
test.describe('MISSIONS-EXT-2C-HF1: Responsive Expense Modal', () => {
  for (const vp of VIEWPORTS) {
    test(`viewport ${vp.name}: no horizontal overflow, all fields + buttons reachable`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setupMockAdminContext(page);
      await page.goto('/dashboard-admin.html');
      await page.waitForTimeout(2000);

      await page.evaluate(() => {
        const el = document.getElementById('authOverlay');
        if (el) el.classList.add('hidden');
      });

      // Open the expense modal
      await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
      await page.waitForTimeout(800);

      // Popup must be visible
      const popup = page.locator('.admin-expense-modal');
      await expect(popup).toBeVisible({ timeout: 5000 });

      // Popup width must not exceed viewport width
      const popupBox = await popup.boundingBox();
      expect(popupBox).not.toBeNull();
      expect(popupBox.width).toBeLessThanOrEqual(vp.width);

      // No horizontal scrollbar on the popup: scrollWidth <= clientWidth
      const overflow = await page.evaluate(() => {
        const el = document.querySelector('.admin-expense-modal');
        if (!el) return { scrollW: 0, clientW: 0, bodyScrollW: 0, bodyClientW: 0 };
        return {
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          bodyScrollW: document.documentElement.scrollWidth,
          bodyClientW: document.documentElement.clientWidth,
        };
      });
      expect(overflow.scrollW).toBeLessThanOrEqual(overflow.clientW);
      // Body should also not have horizontal overflow
      expect(overflow.bodyScrollW).toBeLessThanOrEqual(overflow.bodyClientW);

      // All form fields must be visible/reachable
      await expect(page.locator('#admExpType')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('#admExpAmount')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('#admExpDate')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('#admExpDesc')).toBeVisible({ timeout: 3000 });

      // Buttons must be visible/reachable
      await expect(page.locator('.swal2-confirm')).toBeVisible({ timeout: 3000 });
      await expect(page.locator('.swal2-cancel')).toBeVisible({ timeout: 3000 });

      // Verify the scoped class is applied (not a global swal2-popup change)
      const hasScopedClass = await page.evaluate(() => {
        const el = document.querySelector('.admin-expense-modal');
        return el !== null && el.classList.contains('admin-expense-modal');
      });
      expect(hasScopedClass).toBe(true);

      // Close the modal
      await page.evaluate(() => { if (typeof Swal !== 'undefined') Swal.close(); });
    });
  }

  // ─── Functional smoke test ──────────────────────────────────────────
  test('Train smoke: submit flow — single mutation, no ReferenceError, UI refresh', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await setupMockAdminContext(page);
    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      const el = document.getElementById('authOverlay');
      if (el) el.classList.add('hidden');
    });

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(800);

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

  // ─── Admin wording fix ──────────────────────────────────────────────
  test('modal wording: "saisie admin" (not "saisie admin/opérateur")', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await setupMockAdminContext(page);
    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      const el = document.getElementById('authOverlay');
      if (el) el.classList.add('hidden');
    });

    await openExpenseForm(page, '00000000-0000-0000-0000-000000000001');
    await page.waitForTimeout(800);

    const modalText = await page.evaluate(() => {
      const el = document.querySelector('.admin-expense-modal .swal2-html-container');
      return el ? el.textContent : '';
    });
    expect(modalText).toContain('saisie admin');
    expect(modalText).not.toContain('saisie admin/opérateur');

    await page.evaluate(() => { if (typeof Swal !== 'undefined') Swal.close(); });
  });
});
