// =========================================================
// RM-01B1 — CRM Admin Deployability Smoke Test
// =========================================================
// Playwright smoke test verifying:
//   - dashboard-admin.html contains the 5 CRM nav tabs
//   - js/crm-admin.js loads successfully (HTTP 200)
//   - window.CrmAdmin becomes defined after page load
//
// Uses mocked Supabase context — no real backend required.
// Scope: deployability/smoke only. No CRM mutation coverage.
//
// Run via Playwright: npx playwright test tests/rm-01b1-crm-admin-smoke.test.mjs
// =========================================================

import { test, expect } from '@playwright/test';

const CRM_TABS = [
  { dataTab: 'crm-dashboard', label: 'Vue d\'ensemble' },
  { dataTab: 'crm-organizations', label: 'Organisations' },
  { dataTab: 'crm-opportunities', label: 'Opportunit\u00e9s' },
  { dataTab: 'crm-activities', label: 'Activit\u00e9s' },
  { dataTab: 'crm-timeline', label: 'Timeline' },
];

test.describe('RM-01B1: CRM Admin Deployability Smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Mock the Supabase JS module so createClient returns our mock.
    await page.route('**/@supabase/supabase-js@2**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'window.supabase = { createClient: function() { return window.__mockSupabaseClient; } };',
      });
    });

    // Set up mock Supabase context before page scripts run.
    await page.addInitScript(() => {
      window.SUPABASE_URL = 'http://localhost:0';
      window.SUPABASE_ANON_KEY = 'mock-anon-key';

      function makeQueryBuilder(table) {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          in() { return builder; },
          order() { return builder; },
          limit() { return builder; },
          single() { return Promise.resolve({ data: null, error: null }); },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
          then(resolve) { Promise.resolve().then(() => resolve({ data: [], error: null })); },
        };
        return builder;
      }

      const mockClient = {
        from() { return makeQueryBuilder(); },
        async rpc() { return { data: [], error: null }; },
        auth: {
          getSession() { return Promise.resolve({ data: { session: null } }); },
          signOut() { return Promise.resolve({}); },
        },
      };

      window.supabase = { createClient() { return mockClient; } };
      window.__mockSupabaseClient = mockClient;

      // Hide auth overlay so the dashboard is visible.
      const hideOverlay = () => {
        const el = document.getElementById('authOverlay');
        if (el) el.classList.add('hidden');
      };
      // Run on next tick after DOM is ready.
      setTimeout(hideOverlay, 0);
      setTimeout(hideOverlay, 100);
      setTimeout(hideOverlay, 500);
    });
  });

  test('dashboard-admin.html contains all 5 CRM nav tabs', async ({ page }) => {
    await page.goto('/dashboard-admin.html');
    // Wait for page to settle.
    await page.waitForTimeout(1000);

    for (const tab of CRM_TABS) {
      const navItem = page.locator(`.nav-item[data-tab="${tab.dataTab}"]`);
      await expect(navItem).toBeVisible({ timeout: 5000 });
    }
  });

  test('js/crm-admin.js loads successfully (HTTP 200)', async ({ page }) => {
    const responses = [];
    page.on('response', (response) => {
      if (response.url().includes('crm-admin.js')) {
        responses.push({ url: response.url(), status: response.status() });
      }
    });

    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);

    expect(responses.length).toBeGreaterThan(0);
    const crmResponse = responses[0];
    expect(crmResponse.status).toBe(200);
  });

  test('window.CrmAdmin is defined after page load', async ({ page }) => {
    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);

    const crmAdminDefined = await page.evaluate(() => {
      return typeof window.CrmAdmin !== 'undefined';
    });
    expect(crmAdminDefined).toBe(true);
  });

  test('window.CrmAdmin exposes expected public API methods', async ({ page }) => {
    await page.goto('/dashboard-admin.html');
    await page.waitForTimeout(2000);

    const api = await page.evaluate(() => {
      if (!window.CrmAdmin) return null;
      return {
        loadDashboard: typeof window.CrmAdmin.loadDashboard,
        loadOrganizations: typeof window.CrmAdmin.loadOrganizations,
        loadOpportunities: typeof window.CrmAdmin.loadOpportunities,
        loadActivities: typeof window.CrmAdmin.loadActivities,
        loadTimeline: typeof window.CrmAdmin.loadTimeline,
      };
    });

    expect(api).not.toBeNull();
    expect(api.loadDashboard).toBe('function');
    expect(api.loadOrganizations).toBe('function');
    expect(api.loadOpportunities).toBe('function');
    expect(api.loadActivities).toBe('function');
    expect(api.loadTimeline).toBe('function');
  });
});
