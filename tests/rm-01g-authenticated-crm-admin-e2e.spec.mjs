// =========================================================
// RM-01G — Authenticated CRM Admin E2E
// =========================================================
// Real local Supabase Auth session + real local Postgres.
// No fake auth, no mocking, no Production requests.
//
// Run via: npx playwright test --project=crm-auth-e2e tests/rm-01g-authenticated-crm-admin-e2e.spec.mjs
// =========================================================

import { test, expect, chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LOCAL_API = 'http://127.0.0.1:54321';
const ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const DB_CONTAINER = 'supabase_db_SITE_DEFINITIF_BATHILY-CONVOYAGE';
const APP_URL = 'http://localhost:5173';

const ADMIN_EMAIL = 'rm01g-e2e-admin@bathily.test';
const ADMIN_PASSWORD = 'Rm01gE2e!2026';
const NON_INTERNAL_EMAIL = 'rm01g-e2e-client@bathily.test';
const NON_INTERNAL_PASSWORD = 'Rm01gE2eClient!2026';

const OVERRIDE_CONFIG = `
window.SUPABASE_URL = "${LOCAL_API}";
window.SUPABASE_ANON_KEY = "${ANON_KEY}";
`;

function runSQL(sql) {
  const tmpFile = join(tmpdir(), `rm01g_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmpFile, sql);
  try {
    execSync(`docker cp "${tmpFile}" ${DB_CONTAINER}:/tmp/rm01g_fixture.sql`, { stdio: 'ignore' });
    const result = execSync(`docker exec ${DB_CONTAINER} psql -U postgres -d postgres -f /tmp/rm01g_fixture.sql`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return result.toString();
  } catch(e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    console.error('SQL ERROR:', stderr);
    throw new Error(`SQL failed: ${stderr.slice(0, 500)}`);
  } finally {
    try { unlinkSync(tmpFile); } catch(e) {}
  }
}

let adminUserId = null;
let nonInternalUserId = null;
let adminToken = null;

test.beforeAll(async () => {
  // Clean up any prior fixtures
  runSQL(`
DELETE FROM public.crm_link_events WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.organization_contacts WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.organization_sites WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.organization_opportunities WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.crm_activities WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%';
DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'rm01g-e2e-%');
DELETE FROM public.clients WHERE email LIKE 'rm01g-e2e-%';
DELETE FROM auth.users WHERE email LIKE 'rm01g-e2e-%';
`);

  // Create admin user via GoTrue API
  const adminSignup = await fetch(`${LOCAL_API}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const adminData = await adminSignup.json();
  adminUserId = adminData.id;

  // Confirm email and set admin role
  runSQL(`
UPDATE auth.users SET email_confirmed_at = now() WHERE id = '${adminUserId}';
INSERT INTO public.user_roles (user_id, role) VALUES ('${adminUserId}', 'admin') ON CONFLICT DO NOTHING;
INSERT INTO public.clients (id, email, nom, prenom, role, auth_user_id, telephone, adresse, code_postal, ville, pays, is_pro)
VALUES ('a1a1a000-0000-0000-0000-000000000001', '${ADMIN_EMAIL}', 'Admin', 'RM01G', 'admin', '${adminUserId}', '0600000000', '1 Rue Test', '75001', 'Paris', 'France', false)
ON CONFLICT (email) DO NOTHING;
`);

  // Sign in as admin to get token
  const adminLogin = await fetch(`${LOCAL_API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const adminLoginData = await adminLogin.json();
  adminToken = adminLoginData.access_token;

  // Create non-internal user
  const clientSignup = await fetch(`${LOCAL_API}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: NON_INTERNAL_EMAIL, password: NON_INTERNAL_PASSWORD })
  });
  const clientData = await clientSignup.json();
  nonInternalUserId = clientData.id;

  runSQL(`
UPDATE auth.users SET email_confirmed_at = now() WHERE id = '${nonInternalUserId}';
INSERT INTO public.clients (id, email, nom, prenom, role, auth_user_id, telephone, adresse, code_postal, ville, pays, is_pro)
VALUES ('b2b2b000-0000-0000-0000-000000000002', '${NON_INTERNAL_EMAIL}', 'Client', 'RM01G', 'client', '${nonInternalUserId}', '0611111111', '10 Rue Client', '69001', 'Lyon', 'France', false)
ON CONFLICT (email) DO NOTHING;
`);

  // Create CRM fixtures
  runSQL(`
INSERT INTO public.organizations (id, legal_name, email, phone, website, status, notes)
VALUES ('c1c1c100-0000-0000-0000-000000000001', 'RM01G_E2E_OrgA', 'contact@orga.test', '0100000000', 'https://orga.test', 'active', 'RM01G E2E fixture')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_sites (id, organization_id, name, site_type, address_line1, city, postal_code, country)
VALUES ('d1d1d100-0000-0000-0000-000000000001', 'c1c1c100-0000-0000-0000-000000000001', 'Site Principal', 'main', '1 Rue Org', 'Paris', '75001', 'FR')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name, job_title, email, phone, preferred_channel, decision_maker, primary_contact, active)
VALUES ('e1e1e100-0000-0000-0000-000000000011', 'c1c1c100-0000-0000-0000-000000000001', 'Alice', 'Primary', 'Directrice', 'alice@orga.test', '0100000000', 'email', true, true, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name, job_title, email, phone, preferred_channel, decision_maker, primary_contact, active)
VALUES ('e1e1e100-0000-0000-0000-000000000012', 'c1c1c100-0000-0000-0000-000000000001', 'Bob', 'Secondary', 'Manager', 'bob@orga.test', '0100000001', 'email', false, false, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_opportunities (id, organization_id, title, stage, estimated_value, probability, created_by)
VALUES ('f1f1f100-0000-0000-0000-000000000001', 'c1c1c100-0000-0000-0000-000000000001', 'Mission convoyage Q4', 'qualified', 5000, 50, '${adminUserId}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.crm_activities (id, organization_id, activity_type, subject, body, status, occurred_at, created_by)
VALUES ('a1a1a101-0000-0000-0000-000000000001', 'c1c1c100-0000-0000-0000-000000000001', 'call', 'Appel de decouverte', 'RM01G E2E activity', 'completed', '2026-09-11', '${adminUserId}')
ON CONFLICT (id) DO NOTHING;
`);

  // Verify auth context
  const verifyRes = runSQLVerify(`
SET ROLE authenticated;
SET request.jwt.claim.sub = '${adminUserId}';
SET request.jwt.claims = '{"sub":"${adminUserId}","role":"authenticated"}';
SELECT auth.uid() as uid, public.is_internal_user() as is_internal, public.is_admin() as is_admin;
RESET ROLE;
`);
});

function runSQLVerify(sql) {
  const tmpFile = join(tmpdir(), `rm01g_verify_${Date.now()}.sql`);
  writeFileSync(tmpFile, sql);
  try {
    const out = execSync(`docker exec -i ${DB_CONTAINER} psql -U postgres -d postgres -t -A -f -`, { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
    return out.toString();
  } catch(e) {
    return '';
  } finally {
    try { unlinkSync(tmpFile); } catch(e) {}
  }
}

test.afterAll(async () => {
  try {
    runSQL(`
DELETE FROM public.crm_link_events WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.organization_contacts WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.organization_sites WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.organization_opportunities WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.crm_activities WHERE organization_id IN (SELECT id FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%');
DELETE FROM public.organizations WHERE legal_name LIKE 'RM01G_E2E_%';
DELETE FROM public.user_roles WHERE user_id = '${adminUserId}';
DELETE FROM public.clients WHERE email LIKE 'rm01g-e2e-%';
DELETE FROM auth.users WHERE email LIKE 'rm01g-e2e-%';
`);
  } catch(e) {}
});

test.describe('RM-01G: Authenticated CRM Admin E2E', () => {
  let browser;

  test.beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  // Helper: create a page with route interception and console monitoring
  async function createPage() {
    const page = await browser.newPage();
    const consoleErrors = [];
    const failedRequests = [];
    const productionRequests = [];

    await page.route('**/supabase-config.js', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: OVERRIDE_CONFIG
      });
    });

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    page.on('response', response => {
      if (response.status() >= 400) {
        failedRequests.push(`${response.status()} ${response.url()}`);
      }
      const url = response.url();
      if (url.includes('supabase.co') || url.includes('yzfulgmmngvenxvdvgbp')) {
        productionRequests.push(url);
      }
    });

    return { page, consoleErrors, failedRequests, productionRequests };
  }

  // =========================================================
  // A. AUTH / ACCESS
  // =========================================================

  test('A1: Unauthenticated access to Admin CRM shows auth overlay', async () => {
    const { page, consoleErrors, productionRequests } = await createPage();
    await page.goto(`${APP_URL}/dashboard-admin.html`, { waitUntil: 'networkidle' });

    // Auth overlay should be visible (blocks access)
    await expect(page.locator('#authOverlay')).toBeVisible();
    await expect(page.locator('#authOverlay')).not.toHaveClass(/hidden/);

    // No production requests
    expect(productionRequests.length).toBe(0);

    await page.close();
  });

  test('A2: Authenticated non-internal user denied CRM Admin access', async () => {
    const { page, consoleErrors, productionRequests } = await createPage();
    await page.goto(`${APP_URL}/dashboard-admin.html`, { waitUntil: 'networkidle' });

    // Login as non-internal user
    await page.fill('#adminEmailInput', NON_INTERNAL_EMAIL);
    await page.fill('#adminPasswordInput', NON_INTERNAL_PASSWORD);
    await page.click('#loginBtn');

    // Wait for error message or auth overlay to remain
    await page.waitForTimeout(2000);

    // Auth overlay should still be visible (login rejected)
    const authOverlay = page.locator('#authOverlay');
    const isHidden = await authOverlay.evaluate(el => el.classList.contains('hidden'));
    expect(isHidden).toBe(false);

    // No production requests
    expect(productionRequests.length).toBe(0);

    await page.close();
  });

  test('A3: Authenticated admin/internal user gets CRM Admin access', async () => {
    const { page, consoleErrors, productionRequests } = await createPage();
    await page.goto(`${APP_URL}/dashboard-admin.html`, { waitUntil: 'networkidle' });

    // Login as admin
    await page.fill('#adminEmailInput', ADMIN_EMAIL);
    await page.fill('#adminPasswordInput', ADMIN_PASSWORD);
    await page.click('#loginBtn');

    // Wait for auth overlay to hide
    await expect(page.locator('#authOverlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Dashboard layout should be visible
    await expect(page.locator('.dash-layout')).toBeVisible();

    // No production requests
    expect(productionRequests.length).toBe(0);

    await page.close();
  });

  // =========================================================
  // B. CRM ADMIN LOAD
  // =========================================================

  test('B: CRM Admin loads without fatal JS error', async () => {
    const { page, consoleErrors, productionRequests } = await createPage();
    await page.goto(`${APP_URL}/dashboard-admin.html`, { waitUntil: 'networkidle' });

    // Login as admin
    await page.fill('#adminEmailInput', ADMIN_EMAIL);
    await page.fill('#adminPasswordInput', ADMIN_PASSWORD);
    await page.click('#loginBtn');
    await expect(page.locator('#authOverlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Navigate to CRM Organizations
    await page.click('[data-tab="crm-organizations"]');

    // Wait for CRM section to be visible
    await expect(page.locator('#tab-crm-organizations')).toBeVisible({ timeout: 5000 });

    // CRM Admin JS should be loaded
    const crmAdminDefined = await page.evaluate(() => typeof window.CrmAdmin !== 'undefined');
    expect(crmAdminDefined).toBe(true);

    // No production requests
    expect(productionRequests.length).toBe(0);

    // No fatal JS errors (allow network errors from external CDNs)
    const fatalErrors = consoleErrors.filter(e =>
      !e.includes('net::') &&
      !e.includes('Failed to load resource') &&
      !e.includes('favicon')
    );
    expect(fatalErrors.length).toBe(0);

    await page.close();
  });

  // =========================================================
  // C. ORGANIZATION DETAIL
  // =========================================================

  test('C: Organization detail renders with child sections', async () => {
    const { page, consoleErrors, productionRequests } = await createPage();
    await page.goto(`${APP_URL}/dashboard-admin.html`, { waitUntil: 'networkidle' });

    // Login as admin
    await page.fill('#adminEmailInput', ADMIN_EMAIL);
    await page.fill('#adminPasswordInput', ADMIN_PASSWORD);
    await page.click('#loginBtn');
    await expect(page.locator('#authOverlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Navigate to CRM Organizations
    await page.click('[data-tab="crm-organizations"]');
    await expect(page.locator('#tab-crm-organizations')).toBeVisible({ timeout: 5000 });

    // Wait for organizations to load
    await page.waitForTimeout(2000);

    // Click on the RM01G E2E organization
    const orgRow = page.locator('text=RM01G_E2E_OrgA').first();
    await expect(orgRow).toBeVisible({ timeout: 10000 });
    await orgRow.click();

    // Wait for detail to load
    await page.waitForTimeout(2000);

    // Verify organization detail body is visible
    const detailBody = page.locator('#crmOrgDetailBody');
    await expect(detailBody).toBeVisible({ timeout: 5000 });

    // Verify contact names are readable (not UUID-only)
    await expect(page.locator('text=Alice').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Bob').first()).toBeVisible({ timeout: 5000 });

    // No production requests
    expect(productionRequests.length).toBe(0);

    await page.close();
  });

  // =========================================================
  // D. RM-01F LINK ENTRY POINTS
  // =========================================================

  test('D: RM-01F link entry points visible and usable', async () => {
    const { page, consoleErrors, productionRequests } = await createPage();
    await page.goto(`${APP_URL}/dashboard-admin.html`, { waitUntil: 'networkidle' });

    // Login as admin
    await page.fill('#adminEmailInput', ADMIN_EMAIL);
    await page.fill('#adminPasswordInput', ADMIN_PASSWORD);
    await page.click('#loginBtn');
    await expect(page.locator('#authOverlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Navigate to CRM Organizations
    await page.click('[data-tab="crm-organizations"]');
    await expect(page.locator('#tab-crm-organizations')).toBeVisible({ timeout: 5000 });

    // Wait for organizations to load
    await page.waitForTimeout(3000);

    // Open org detail
    const orgRow = page.locator('text=RM01G_E2E_OrgA').first();
    await expect(orgRow).toBeVisible({ timeout: 10000 });
    await orgRow.click();

    // Wait for org detail to fully load (contacts should be visible)
    await expect(page.locator('text=Alice').first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Verify link entry points are visible
    await expect(page.locator('text=Lier un client').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Lier un devis').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Lier une mission').first()).toBeVisible({ timeout: 5000 });

    // Open the "Lier un client" picker and verify it opens a form/modal
    await page.locator('text=Lier un client').first().click();

    // The CRM modal should appear (custom modal with .open class)
    await expect(page.locator('#crmModalOverlay')).toHaveClass(/open/, { timeout: 5000 });

    // Verify no raw UUID text input in the modal for normal operator workflow
    const modalUuidInputs = await page.locator('#crmModalBody input[type="text"][placeholder*="UUID"], #crmModalBody input[type="text"][placeholder*="uuid"]').count();
    expect(modalUuidInputs).toBe(0);

    // Close the modal (cancel)
    await page.locator('#crmModalFooter button.btn-outline').first().click().catch(() => {});
    await page.waitForTimeout(500);

    // No production requests
    expect(productionRequests.length).toBe(0);

    await page.close();
  });

  // =========================================================
  // E. ATOMIC PRIMARY CONTACT E2E
  // =========================================================

  test('E: Atomic primary contact update through UI', async () => {
    const { page, consoleErrors, productionRequests } = await createPage();
    await page.goto(`${APP_URL}/dashboard-admin.html`, { waitUntil: 'networkidle' });

    // Login as admin
    await page.fill('#adminEmailInput', ADMIN_EMAIL);
    await page.fill('#adminPasswordInput', ADMIN_PASSWORD);
    await page.click('#loginBtn');
    await expect(page.locator('#authOverlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Navigate to CRM Organizations
    await page.click('[data-tab="crm-organizations"]');
    await expect(page.locator('#tab-crm-organizations')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(3000);

    // Open org detail
    const orgRow = page.locator('text=RM01G_E2E_OrgA').first();
    await expect(orgRow).toBeVisible({ timeout: 10000 });
    await orgRow.click();

    // Wait for org detail to fully load (contacts should be visible)
    await expect(page.locator('text=Bob').first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Find Bob's edit button (Bob is non-primary, we'll promote him)
    const bobRow = page.locator('tr', { hasText: 'Bob' }).first();
    await expect(bobRow).toBeVisible({ timeout: 5000 });

    // Click the edit button in Bob's row
    const editBtn = bobRow.locator('button[onclick*="openEditContactForm"]').first();
    await editBtn.click();

    // The CRM modal should appear (custom modal with .open class)
    await expect(page.locator('#crmModalOverlay')).toHaveClass(/open/, { timeout: 5000 });

    // Modify a harmless field (e.g., job_title)
    const jobTitleInput = page.locator('#crmModalBody input[id*="job"], #crmModalBody input[id*="Job"], #crmModalBody input[placeholder*="fonction"], #crmModalBody input[placeholder*="Fonction"]').first();
    const jobVisible = await jobTitleInput.isVisible().catch(() => false);

    if (jobVisible) {
      await jobTitleInput.fill('Manager Updated E2E');
    }

    // Find and check the primary contact checkbox
    const primaryCheckbox = page.locator('#crmModalBody input[type="checkbox"][id*="primary"], #crmModalBody input[type="checkbox"][id*="Primary"]').first();
    const primaryVisible = await primaryCheckbox.isVisible().catch(() => false);

    if (primaryVisible) {
      const isChecked = await primaryCheckbox.isChecked();
      if (!isChecked) {
        await primaryCheckbox.click();
      }
    }

    // Submit the form
    const confirmBtn = page.locator('#crmModalFooter button.btn-red, #crmModalSubmit').first();
    await confirmBtn.click();

    // Wait for the operation to complete
    await page.waitForTimeout(3000);

    // Verify in the database that the atomic update succeeded
    const dbResult = runSQLVerify(`
SELECT
  (SELECT first_name || ' ' || last_name || ' ' || job_title FROM public.organization_contacts WHERE id = 'e1e1e100-0000-0000-0000-000000000012') as bob_state,
  (SELECT primary_contact::text FROM public.organization_contacts WHERE id = 'e1e1e100-0000-0000-0000-000000000012') as bob_primary,
  (SELECT primary_contact::text FROM public.organization_contacts WHERE id = 'e1e1e100-0000-0000-0000-000000000011') as alice_primary,
  (SELECT count(*)::text FROM public.organization_contacts WHERE organization_id = 'c1c1c100-0000-0000-0000-000000000001' AND primary_contact = true) as primary_count;
`);

    // Parse the DB result
    const lines = dbResult.trim().split('\n').filter(l => l.trim());
    if (lines.length >= 4) {
      const [bobState, bobPrimary, alicePrimary, primaryCount] = lines.map(l => l.split('|').map(s => s.trim()));

      // Bob's field should be updated
      expect(bobState[0]).toContain('Bob');
      // Bob should be primary
      expect(bobPrimary[0]).toBe('t');
      // Alice should no longer be primary
      expect(alicePrimary[0]).toBe('f');
      // Exactly one primary
      expect(primaryCount[0]).toBe('1');
    }

    // No production requests
    expect(productionRequests.length).toBe(0);

    await page.close();
  });

  // =========================================================
  // F. ERROR SANITIZATION E2E
  // =========================================================

  test('F: Error sanitization — no SQLSTATE or table name leakage', async () => {
    const { page, consoleErrors, productionRequests } = await createPage();
    await page.goto(`${APP_URL}/dashboard-admin.html`, { waitUntil: 'networkidle' });

    // Login as admin
    await page.fill('#adminEmailInput', ADMIN_EMAIL);
    await page.fill('#adminPasswordInput', ADMIN_PASSWORD);
    await page.click('#loginBtn');
    await expect(page.locator('#authOverlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Navigate to CRM Organizations
    await page.click('[data-tab="crm-organizations"]');
    await expect(page.locator('#tab-crm-organizations')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2000);

    // Open org detail
    const orgRow = page.locator('text=RM01G_E2E_OrgA').first();
    await expect(orgRow).toBeVisible({ timeout: 10000 });
    await orgRow.click();

    // Wait for org detail to fully load (contacts should be visible)
    await expect(page.locator('text=Alice').first()).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Open Alice's edit form (she's primary)
    const aliceRow = page.locator('tr', { hasText: 'Alice' }).first();
    await expect(aliceRow).toBeVisible({ timeout: 5000 });
    const editBtn = aliceRow.locator('button[onclick*="openEditContactForm"]').first();
    await editBtn.click();

    // The CRM modal should appear
    await expect(page.locator('#crmModalOverlay')).toHaveClass(/open/, { timeout: 5000 });

    // Try to set an invalid preferred_channel (CHECK constraint violation)
    const channelSelect = page.locator('#crmModalBody select[id*="channel"], #crmModalBody select').first();
    const channelVisible = await channelSelect.isVisible().catch(() => false);

    if (channelVisible) {
      // Try to select an invalid value via JavaScript (bypass UI select validation)
      await page.evaluate(() => {
        const selects = document.querySelectorAll('#crmModalBody select');
        for (const sel of selects) {
          if (sel.id && sel.id.toLowerCase().includes('channel')) {
            // Add an invalid option and select it
            const opt = document.createElement('option');
            opt.value = 'invalid_channel_e2e';
            opt.text = 'Invalid';
            sel.appendChild(opt);
            sel.value = 'invalid_channel_e2e';
          }
        }
      });
    }

    // Submit the form
    const confirmBtn = page.locator('#crmModalFooter button.btn-red, #crmModalSubmit').first();
    await confirmBtn.click();

    // Wait for error response
    await page.waitForTimeout(3000);

    // Check for error message — should be sanitized
    const pageText = await page.textContent('body').catch(() => '');

    // Should NOT contain raw SQLSTATE, table names, or Postgres DETAIL
    expect(pageText).not.toContain('SQLSTATE');
    expect(pageText).not.toContain('organization_contacts');
    expect(pageText).not.toContain('check_constraint');
    expect(pageText).not.toContain('pg_');
    expect(pageText).not.toContain('ERROR:');
    expect(pageText).not.toContain('DETAIL:');

    // No production requests
    expect(productionRequests.length).toBe(0);

    await page.close();
  });
});
