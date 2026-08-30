// INDY-3B.2 — Admin Billing Workflow Playwright E2E
// Runs against LOCAL Supabase only. No Production requests.
// Uses route interception to redirect supabase-config.js to local API.

import { test, expect, chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LOCAL_API = 'http://127.0.0.1:54821';
const ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const ADMIN_EMAIL = 'test-3b-e2e-admin@bathily.test';
const ADMIN_PASSWORD = 'TestAdmin3B!2026';
const CLIENT_EMAIL = 'test-3b-e2e-client@bathily.test';
const CLIENT_PASSWORD = 'TestClient3B!2026';

const OVERRIDE_CONFIG = `
window.SUPABASE_URL = "${LOCAL_API}";
window.SUPABASE_ANON_KEY = "${ANON_KEY}";
`;

function runSQL(sql) {
  const tmpFile = join(tmpdir(), `indy3b_${Date.now()}.sql`);
  writeFileSync(tmpFile, sql);
  execSync(`docker cp "${tmpFile}" supabase_db_SITE_DEFINITIF_BATHILY-CONVOYAGE:/tmp/indy3b_fixture.sql`, { stdio: 'ignore' });
  execSync(`docker exec supabase_db_SITE_DEFINITIF_BATHILY-CONVOYAGE psql -U postgres -d postgres -f /tmp/indy3b_fixture.sql`, { stdio: 'ignore' });
  try { unlinkSync(tmpFile); } catch(e) {}
}

let adminToken = null;
let adminUserId = null;
let clientUserId = null;

test.beforeAll(async () => {
  // Clean up any prior fixtures
  const cleanupSQL = `
ALTER TABLE public.billing_events DISABLE TRIGGER billing_events_protect_trigger;
DELETE FROM public.billing_events;
DELETE FROM public.billing_records;
DELETE FROM public.mission_events;
DELETE FROM public.missions WHERE reference LIKE 'E2E-3B-%';
DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'test-3b-e2e-%');
DELETE FROM public.clients WHERE email LIKE 'test-3b-e2e-%';
DELETE FROM auth.users WHERE email LIKE 'test-3b-e2e-%';
ALTER TABLE public.billing_events ENABLE TRIGGER billing_events_protect_trigger;
`;
  runSQL(cleanupSQL);

  // Create admin user via GoTrue API
  const signupRes = await fetch(`${LOCAL_API}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const signupData = await signupRes.json();
  adminUserId = signupData.id;

  // Confirm email and set admin role
  runSQL(`
UPDATE auth.users SET email_confirmed_at = now() WHERE id = '${adminUserId}';
INSERT INTO public.user_roles (user_id, role) VALUES ('${adminUserId}', 'admin') ON CONFLICT DO NOTHING;
INSERT INTO public.clients (id, email, nom, prenom, role, auth_user_id, telephone, adresse, code_postal, ville, pays, is_pro)
VALUES ('e2ea1111-1111-1111-1111-111111111111', '${ADMIN_EMAIL}', 'Admin', 'E2E', 'admin', '${adminUserId}', '0600000000', '1 Rue Admin', '75001', 'Paris', 'France', false)
ON CONFLICT (email) DO NOTHING;
`);

  // Sign in as admin
  const loginRes = await fetch(`${LOCAL_API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  const loginData = await loginRes.json();
  adminToken = loginData.access_token;

  // Create client user via GoTrue API
  const clientSignupRes = await fetch(`${LOCAL_API}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CLIENT_EMAIL, password: CLIENT_PASSWORD })
  });
  const clientSignupData = await clientSignupRes.json();
  clientUserId = clientSignupData.id;

  // Confirm client email and create client profile
  runSQL(`
UPDATE auth.users SET email_confirmed_at = now() WHERE id = '${clientUserId}';
INSERT INTO public.clients (id, email, nom, prenom, role, auth_user_id, telephone, adresse, code_postal, ville, pays, siret, tva_intra, is_pro, societe)
VALUES ('e2ec2222-2222-2222-2222-222222222222', '${CLIENT_EMAIL}', 'Dupont', 'Jean', 'client', '${clientUserId}', '0611111111', '10 Rue Client', '69001', 'Lyon', 'France', '12345678900012', 'FR12345678901', true, 'Dupont Transport SARL')
ON CONFLICT (email) DO NOTHING;
`);

  // Create missions
  runSQL(`
INSERT INTO public.missions (id, reference, client_nom, client_email, client_id, depart, arrivee, vehicule, mode_transport, pack, mode, montant_ht, status, date_mission, paiement_statut, created_at)
VALUES
('e2ee0000-0000-0000-0000-000000000001', 'E2E-3B-ELIGIBLE-001', 'Dupont Jean', '${CLIENT_EMAIL}', 'e2ec2222-2222-2222-2222-222222222222', 'Paris', 'Lyon', 'Renault Clio', 'route', 'Premium', 'route', 500.00, 'completed', '2026-08-31', 'pending', '2026-09-01'),
('e2ee0000-0000-0000-0000-000000000002', 'E2E-3B-HISTORICAL-002', 'Dupont Jean', '${CLIENT_EMAIL}', 'e2ec2222-2222-2222-2222-222222222222', 'Marseille', 'Nice', 'Peugeot 208', 'route', 'Standard', 'route', 300.00, 'completed', '2026-08-30', 'paid', '2026-08-28'),
('e2ee0000-0000-0000-0000-000000000003', 'E2E-3B-ZERO-003', 'Dupont Jean', '${CLIENT_EMAIL}', 'e2ec2222-2222-2222-2222-222222222222', 'Bordeaux', 'Toulouse', 'Citroen C3', 'route', 'Basic', 'route', 0, 'completed', '2026-09-20', 'pending', '2026-09-18'),
('e2ee0000-0000-0000-0000-000000000004', 'E2E-3B-ELIGIBLE-004', 'Dupont Jean', '${CLIENT_EMAIL}', 'e2ec2222-2222-2222-2222-222222222222', 'Lille', 'Strasbourg', 'Volkswagen Golf', 'route', 'Premium', 'route', 750.00, 'completed', '2026-09-25', 'pending', '2026-09-20'),
('e2ee0000-0000-0000-0000-000000000005', 'E2E-3B-ELIGIBLE-005', 'Dupont Jean', '${CLIENT_EMAIL}', 'e2ec2222-2222-2222-2222-222222222222', 'Nantes', 'Rennes', 'Toyota Yaris', 'route', 'Standard', 'route', 250.00, 'completed', '2026-09-28', 'pending', '2026-09-25')
ON CONFLICT (id) DO NOTHING;
`);

  // Create billing records (insert as prepared, then update for issued/cancelled)
  runSQL(`
INSERT INTO public.billing_records (id, mission_id, client_id, provider, status, invoice_type, total_ht, total_tva, total_ttc, currency, prepared_payload, created_by, created_at)
VALUES ('e2eb0000-0000-0000-0000-000000000001', 'e2ee0000-0000-0000-0000-000000000004', 'e2ec2222-2222-2222-2222-222222222222', 'indy', 'prepared', 'invoice', 750.00, 0, 750.00, 'EUR',
  jsonb_build_object(
    'seller', jsonb_build_object('name', 'Bathily-Convoyage', 'siret', '789 285 376 00032', 'address', '1 Rue Admin, 75001 Paris', 'email', 'contact@bathily-convoyage.fr', 'tva_regime', 'Franchise en base de TVA'),
    'customer', jsonb_build_object('name', 'Dupont Transport SARL', 'email', '${CLIENT_EMAIL}', 'address', '10 Rue Client', 'code_postal', '69001', 'ville', 'Lyon', 'pays', 'France', 'siret', '12345678900012', 'tva_intra', 'FR12345678901', 'is_pro', true),
    'mission', jsonb_build_object('reference', 'E2E-3B-ELIGIBLE-004', 'depart', 'Lille', 'arrivee', 'Strasbourg', 'vehicule', 'Volkswagen Golf', 'pack', 'Premium', 'mode', 'route', 'date_mission', '2026-09-25'),
    'financial', jsonb_build_object('total_ht', 750.00, 'total_tva', 0, 'total_ttc', 750.00, 'currency', 'EUR', 'tva_rate', 0)
  ), '${adminUserId}', now());

INSERT INTO public.billing_records (id, mission_id, client_id, provider, status, invoice_type, total_ht, total_tva, total_ttc, currency, prepared_payload, created_by, created_at)
VALUES ('e2eb0000-0000-0000-0000-000000000002', 'e2ee0000-0000-0000-0000-000000000005', 'e2ec2222-2222-2222-2222-222222222222', 'indy', 'prepared', 'invoice', 250.00, 0, 250.00, 'EUR',
  jsonb_build_object(
    'seller', jsonb_build_object('name', 'Bathily-Convoyage'),
    'customer', jsonb_build_object('name', 'Dupont Transport SARL', 'email', '${CLIENT_EMAIL}'),
    'mission', jsonb_build_object('reference', 'E2E-3B-ELIGIBLE-005'),
    'financial', jsonb_build_object('total_ht', 250.00, 'total_tva', 0, 'total_ttc', 250.00, 'currency', 'EUR')
  ), '${adminUserId}', now() - interval '1 day');
UPDATE public.billing_records SET status = 'issued', external_invoice_number = 'INDY-E2E-001', issued_at = now() WHERE id = 'e2eb0000-0000-0000-0000-000000000002';

INSERT INTO public.billing_records (id, mission_id, client_id, provider, status, invoice_type, total_ht, total_tva, total_ttc, currency, prepared_payload, created_by, created_at)
VALUES ('e2eb0000-0000-0000-0000-000000000003', 'e2ee0000-0000-0000-0000-000000000001', 'e2ec2222-2222-2222-2222-222222222222', 'indy', 'prepared', 'invoice', 500.00, 0, 500.00, 'EUR',
  jsonb_build_object(
    'seller', jsonb_build_object('name', 'Bathily-Convoyage'),
    'customer', jsonb_build_object('name', 'Dupont Jean'),
    'mission', jsonb_build_object('reference', 'E2E-3B-ELIGIBLE-001'),
    'financial', jsonb_build_object('total_ht', 500.00, 'total_tva', 0, 'total_ttc', 500.00, 'currency', 'EUR')
  ), '${adminUserId}', now() - interval '3 days');
UPDATE public.billing_records SET status = 'cancelled', cancelled_at = now() - interval '2 days', notes = 'E2E test cancel' WHERE id = 'e2eb0000-0000-0000-0000-000000000003';
`);
});

test.afterAll(async () => {
  try {
    runSQL(`
ALTER TABLE public.billing_events DISABLE TRIGGER billing_events_protect_trigger;
DELETE FROM public.billing_events;
DELETE FROM public.billing_records;
DELETE FROM public.mission_events;
DELETE FROM public.missions WHERE reference LIKE 'E2E-3B-%';
DELETE FROM public.user_roles WHERE user_id = '${adminUserId}';
DELETE FROM public.clients WHERE email LIKE 'test-3b-e2e-%';
DELETE FROM auth.users WHERE email LIKE 'test-3b-e2e-%';
ALTER TABLE public.billing_events ENABLE TRIGGER billing_events_protect_trigger;
`);
  } catch(e) {}
});

test.describe('INDY-3B Admin Billing E2E', () => {
  let browser, page, consoleErrors, failedRequests, productionRequests;

  test.beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    page = await browser.newPage();
    consoleErrors = [];
    failedRequests = [];
    productionRequests = [];

    // Intercept supabase-config.js and replace with local config
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

    // Navigate to admin dashboard
    await page.goto('http://127.0.0.1:5199/dashboard-admin.html', { waitUntil: 'networkidle' });

    // Login as admin — find the login form
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('dashboard loads without fatal console errors', async () => {
    const fatalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('font') && !e.includes('CSS') &&
      !e.includes('net::ERR') && !e.includes('Failed to load resource') &&
      !e.includes('404')
    );
    expect(fatalErrors).toEqual([]);
  });

  test('Facturation tab opens and loads billing data', async () => {
    await page.locator('.nav-item[data-tab="facturation"]').click();
    await page.waitForTimeout(2000);

    await expect(page.locator('#tab-facturation')).toBeVisible();
    await expect(page.locator('#billingKpiToInvoice')).toBeVisible();
    await expect(page.locator('#billingKpiPrepared')).toBeVisible();
    await expect(page.locator('#billingKpiIssued')).toBeVisible();
    await expect(page.locator('#billingKpiCancelled')).toBeVisible();

    const disclaimer = await page.locator('#tab-facturation').textContent();
    expect(disclaimer).toContain('Indy');
  });

  test('À facturer queue shows correct missions', async () => {
    await page.locator('.nav-item[data-tab="facturation"]').click();
    await page.waitForTimeout(2000);

    const tableText = await page.locator('#billingTableBody').textContent();

    // Eligible: 2026-08-31 (first eligible date), 500€, cancelled record → re-eligible
    expect(tableText).toContain('E2E-3B-ELIGIBLE-001');

    // Historical: 2026-08-30 (cutoff date, excluded by +1 day rule)
    expect(tableText).not.toContain('E2E-3B-HISTORICAL-002');

    // Zero amount: excluded
    expect(tableText).not.toContain('E2E-3B-ZERO-003');

    // Has prepared record: excluded
    expect(tableText).not.toContain('E2E-3B-ELIGIBLE-004');

    // Has issued record: excluded
    expect(tableText).not.toContain('E2E-3B-ELIGIBLE-005');
  });

  test('Préparées shows prepared records', async () => {
    await page.locator('.nav-item[data-tab="facturation"]').click();
    await page.waitForTimeout(1000);
    await page.locator('#billingKpiPrepared').click();
    await page.waitForTimeout(1000);

    const tableText = await page.locator('#billingTableBody').textContent();
    expect(tableText).toContain('E2E-3B-ELIGIBLE-004');
  });

  test('Émises shows issued records with Indy number', async () => {
    await page.locator('.nav-item[data-tab="facturation"]').click();
    await page.waitForTimeout(1000);
    await page.locator('#billingKpiIssued').click();
    await page.waitForTimeout(1000);

    const tableText = await page.locator('#billingTableBody').textContent();
    expect(tableText).toContain('INDY-E2E-001');
    expect(tableText).toContain('E2E-3B-ELIGIBLE-005');
  });

  test('Annulées shows cancelled records', async () => {
    await page.locator('.nav-item[data-tab="facturation"]').click();
    await page.waitForTimeout(1000);
    await page.locator('#billingKpiCancelled').click();
    await page.waitForTimeout(1000);

    const tableText = await page.locator('#billingTableBody').textContent();
    expect(tableText).toContain('E2E-3B-ELIGIBLE-001');
  });

  test('prepare_billing_record RPC works from UI', async () => {
    await page.locator('.nav-item[data-tab="facturation"]').click();
    await page.waitForTimeout(2000);

    // Mission 001 should be in À facturer
    const prepareBtn = page.locator('button:has-text("Préparer pour Indy")').first();
    await expect(prepareBtn).toBeVisible();

    // Click prepare
    await prepareBtn.click();
    await page.waitForTimeout(1000);

    // Confirm in SweetAlert
    const confirmBtn = page.locator('.swal2-confirm');
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }
    await page.waitForTimeout(3000);

    // Check that the mission is no longer in À facturer
    // (it should have moved to Préparées)
    // Verify by checking Préparées tab
    await page.locator('#billingKpiPrepared').click();
    await page.waitForTimeout(1000);
    const preparedText = await page.locator('#billingTableBody').textContent();
    // Mission 001 should now appear in Préparées (in addition to 004)
    expect(preparedText).toContain('E2E-3B-ELIGIBLE-001');
  });

  test('no requests sent to Production Supabase', async () => {
    await page.locator('.nav-item[data-tab="facturation"]').click();
    await page.waitForTimeout(2000);
    expect(productionRequests).toEqual([]);
  });
});

// =========================================================
// NON-ADMIN AUTHENTICATED RPC TEST
// =========================================================

test.describe('INDY-3B Non-admin authenticated RPC', () => {
  test('authenticated non-admin cannot call prepare_billing_record', async () => {
    // Sign in as client (non-admin) — client was created via GoTrue API
    const loginRes = await fetch(`${LOCAL_API}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CLIENT_EMAIL, password: CLIENT_PASSWORD })
    });
    const loginData = await loginRes.json();
    expect(loginData.access_token).toBeTruthy();

    // Call prepare_billing_record as non-admin
    const rpcRes = await fetch(`${LOCAL_API}/rest/v1/rpc/prepare_billing_record`, {
      method: 'POST',
      headers: {
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${loginData.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_mission_id: 'e2ee0000-0000-0000-0000-000000000001' })
    });
    const rpcData = await rpcRes.json();

    // The function has EXECUTE privilege for authenticated, but inside
    // the function is_admin() returns false and raises 42501 with
    // "Réservé à l'administrateur". PostgREST maps 42501 to HTTP 403
    // for authenticated users.
    expect(rpcRes.status).toBe(403);
    expect(rpcData.code).toBe('42501');
    expect(rpcData.message).toContain('Réservé à l\'administrateur');
  });
});

// =========================================================
// DUPLICATE EXTERNAL NUMBER ERROR TEST
// =========================================================

test.describe('INDY-3B Duplicate external number error', () => {
  test('duplicate Indy number returns clear error', async () => {
    // Sign in as admin
    const loginRes = await fetch(`${LOCAL_API}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    });
    const loginData = await loginRes.json();
    expect(loginData.access_token).toBeTruthy();

    // Try to link a duplicate external number (INDY-E2E-001 already exists)
    const rpcRes = await fetch(`${LOCAL_API}/rest/v1/rpc/link_external_invoice`, {
      method: 'POST',
      headers: {
        'apikey': ANON_KEY,
        'Authorization': `Bearer ${loginData.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_billing_record_id: 'e2eb0000-0000-0000-0000-000000000001', // the prepared record
        p_external_invoice_number: 'INDY-E2E-001', // already used by issued record
        p_external_invoice_id: null
      })
    });
    const rpcData = await rpcRes.json();

    expect(rpcRes.status).toBe(409);
    expect(rpcData.code).toBe('23505');
    // The frontend translateBillingError maps this to:
    // "Ce numéro de facture Indy est déjà enregistré."
  });
});
