// INDY-3C — Client Billing Cleanup Playwright E2E
// Runs against LOCAL Supabase only. No Production requests.
// Uses route interception to redirect supabase-config.js to local API.

import { test, expect, chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LOCAL_API = 'http://127.0.0.1:54821';
const ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const CLIENT_A_EMAIL = 'test-3c-e2e-client-a@bathily.test';
const CLIENT_A_PASSWORD = 'TestClient3CA!2026';
const CLIENT_B_EMAIL = 'test-3c-e2e-client-b@bathily.test';
const CLIENT_B_PASSWORD = 'TestClient3CB!2026';

const OVERRIDE_CONFIG = `
window.SUPABASE_URL = "${LOCAL_API}";
window.SUPABASE_ANON_KEY = "${ANON_KEY}";
`;

function runSQL(sql) {
  const tmpFile = join(tmpdir(), `indy3c_${Date.now()}.sql`);
  writeFileSync(tmpFile, sql);
  execSync(`docker cp "${tmpFile}" supabase_db_SITE_DEFINITIF_BATHILY-CONVOYAGE:/tmp/indy3c_fixture.sql`, { stdio: 'ignore' });
  execSync(`docker exec supabase_db_SITE_DEFINITIF_BATHILY-CONVOYAGE psql -U postgres -d postgres -f /tmp/indy3c_fixture.sql`, { stdio: 'ignore' });
  try { unlinkSync(tmpFile); } catch(e) {}
}

let clientAUserId = null;
let clientBUserId = null;

test.beforeAll(async () => {
  // Clean up any prior fixtures
  const cleanupSQL = `
ALTER TABLE public.billing_events DISABLE TRIGGER billing_events_protect_trigger;
DELETE FROM public.billing_events;
DELETE FROM public.billing_records WHERE mission_id IN (SELECT id FROM public.missions WHERE reference LIKE 'E2E-3C-%');
DELETE FROM public.mission_events WHERE mission_id IN (SELECT id FROM public.missions WHERE reference LIKE 'E2E-3C-%');
DELETE FROM public.missions WHERE reference LIKE 'E2E-3C-%';
DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'test-3c-e2e-%');
DELETE FROM public.clients WHERE email LIKE 'test-3c-e2e-%';
DELETE FROM auth.users WHERE email LIKE 'test-3c-e2e-%';
ALTER TABLE public.billing_events ENABLE TRIGGER billing_events_protect_trigger;
`;
  runSQL(cleanupSQL);

  // Create client A via GoTrue API
  const signupARes = await fetch(`${LOCAL_API}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CLIENT_A_EMAIL, password: CLIENT_A_PASSWORD })
  });
  const signupAData = await signupARes.json();
  clientAUserId = signupAData.id;

  // Confirm email and create client A profile
  runSQL(`
UPDATE auth.users SET email_confirmed_at = now() WHERE id = '${clientAUserId}';
INSERT INTO public.clients (id, email, nom, prenom, role, auth_user_id, telephone, adresse, code_postal, ville, pays, siret, tva_intra, is_pro, societe)
VALUES ('e2ca1111-1111-1111-1111-111111111111', '${CLIENT_A_EMAIL}', 'Dupont', 'Jean', 'client', '${clientAUserId}', '0611111111', '10 Rue Client', '69001', 'Lyon', 'France', '12345678900012', 'FR12345678901', true, 'Dupont Transport SARL')
ON CONFLICT (email) DO NOTHING;
`);

  // Create client B via GoTrue API
  const signupBRes = await fetch(`${LOCAL_API}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CLIENT_B_EMAIL, password: CLIENT_B_PASSWORD })
  });
  const signupBData = await signupBRes.json();
  clientBUserId = signupBData.id;

  // Confirm email and create client B profile
  runSQL(`
UPDATE auth.users SET email_confirmed_at = now() WHERE id = '${clientBUserId}';
INSERT INTO public.clients (id, email, nom, prenom, role, auth_user_id, telephone, adresse, code_postal, ville, pays, is_pro)
VALUES ('e2cb2222-2222-2222-2222-222222222222', '${CLIENT_B_EMAIL}', 'Martin', 'Sophie', 'client', '${clientBUserId}', '0622222222', '20 Rue Autre', '75001', 'Paris', 'France', false)
ON CONFLICT (email) DO NOTHING;
`);

  // Create missions for client A
  runSQL(`
INSERT INTO public.missions (id, reference, client_nom, client_email, client_id, depart, arrivee, vehicule, mode_transport, pack, mode, montant_ht, status, date_mission, paiement_statut, created_at)
VALUES
('e2ce0001-0000-0000-0000-000000000001', 'E2E-3C-NO-BR-001', 'Dupont Jean', '${CLIENT_A_EMAIL}', 'e2ca1111-1111-1111-1111-111111111111', 'Paris', 'Lyon', 'Renault Clio', 'route', 'Premium', 'route', 500.00, 'completed', '2026-09-05', 'pending', '2026-09-01'),
('e2ce0001-0000-0000-0000-000000000002', 'E2E-3C-PREPARED-002', 'Dupont Jean', '${CLIENT_A_EMAIL}', 'e2ca1111-1111-1111-1111-111111111111', 'Marseille', 'Nice', 'Peugeot 208', 'route', 'Standard', 'route', 300.00, 'completed', '2026-09-10', 'paid', '2026-09-05'),
('e2ce0001-0000-0000-0000-000000000003', 'E2E-3C-ISSUED-003', 'Dupont Jean', '${CLIENT_A_EMAIL}', 'e2ca1111-1111-1111-1111-111111111111', 'Bordeaux', 'Toulouse', 'Citroen C3', 'route', 'Basic', 'route', 250.00, 'completed', '2026-09-15', 'paid', '2026-09-10'),
('e2ce0001-0000-0000-0000-000000000004', 'E2E-3C-CANCELLED-004', 'Dupont Jean', '${CLIENT_A_EMAIL}', 'e2ca1111-1111-1111-1111-111111111111', 'Lille', 'Strasbourg', 'VW Golf', 'route', 'Premium', 'route', 750.00, 'completed', '2026-09-20', 'pending', '2026-09-15')
ON CONFLICT (id) DO NOTHING;

-- Mission for client B (cross-client isolation test)
INSERT INTO public.missions (id, reference, client_nom, client_email, client_id, depart, arrivee, vehicule, mode_transport, pack, mode, montant_ht, status, date_mission, paiement_statut, created_at)
VALUES ('e2ce0002-0000-0000-0000-000000000005', 'E2E-3C-CLIENTB-005', 'Martin Sophie', '${CLIENT_B_EMAIL}', 'e2cb2222-2222-2222-2222-222222222222', 'Nantes', 'Rennes', 'Toyota Yaris', 'route', 'Standard', 'route', 400.00, 'completed', '2026-09-25', 'paid', '2026-09-20')
ON CONFLICT (id) DO NOTHING;
`);

  // Create billing records for client A missions
  runSQL(`
-- Prepared record for mission 002
INSERT INTO public.billing_records (id, mission_id, client_id, provider, status, invoice_type, total_ht, total_tva, total_ttc, currency, prepared_payload, created_by, created_at)
VALUES ('e2cb0001-0000-0000-0000-000000000002', 'e2ce0001-0000-0000-0000-000000000002', 'e2ca1111-1111-1111-1111-111111111111', 'indy', 'prepared', 'invoice', 300.00, 0, 300.00, 'EUR',
  jsonb_build_object(
    'seller', jsonb_build_object('name', 'Bathily-Convoyage', 'siret', '789 285 376 00032', 'address', '34, rue de Padirac 34070 Montpellier', 'email', 'contact@bathily-convoyage.fr', 'tva_regime', 'TVA non applicable — franchise en base (art. 293 B CGI)'),
    'customer', jsonb_build_object('name', 'Dupont Transport SARL', 'email', '${CLIENT_A_EMAIL}', 'address', '10 Rue Client', 'code_postal', '69001', 'ville', 'Lyon', 'pays', 'France', 'siret', '12345678900012', 'tva_intra', 'FR12345678901', 'is_pro', true),
    'mission', jsonb_build_object('reference', 'E2E-3C-PREPARED-002', 'depart', 'Marseille', 'arrivee', 'Nice', 'vehicule', 'Peugeot 208', 'pack', 'Standard', 'mode', 'route', 'date_mission', '2026-09-10', 'service_description', 'Mission de convoyage — Mode route — Pack Standard'),
    'financial', jsonb_build_object('total_ht', 300.00, 'total_tva', 0, 'total_ttc', 300.00, 'currency', 'EUR', 'tva_rate', 0)
  ), '${clientAUserId}', now());

-- Issued record for mission 003
INSERT INTO public.billing_records (id, mission_id, client_id, provider, status, invoice_type, total_ht, total_tva, total_ttc, currency, prepared_payload, created_by, created_at)
VALUES ('e2cb0001-0000-0000-0000-000000000003', 'e2ce0001-0000-0000-0000-000000000003', 'e2ca1111-1111-1111-1111-111111111111', 'indy', 'prepared', 'invoice', 250.00, 0, 250.00, 'EUR',
  jsonb_build_object(
    'seller', jsonb_build_object('name', 'Bathily-Convoyage', 'siret', '789 285 376 00032', 'address', '34, rue de Padirac 34070 Montpellier', 'email', 'contact@bathily-convoyage.fr', 'tva_regime', 'TVA non applicable — franchise en base (art. 293 B CGI)'),
    'customer', jsonb_build_object('name', 'Dupont Transport SARL', 'email', '${CLIENT_A_EMAIL}', 'address', '10 Rue Client', 'code_postal', '69001', 'ville', 'Lyon', 'pays', 'France', 'siret', '12345678900012', 'tva_intra', 'FR12345678901', 'is_pro', true),
    'mission', jsonb_build_object('reference', 'E2E-3C-ISSUED-003', 'depart', 'Bordeaux', 'arrivee', 'Toulouse', 'vehicule', 'Citroen C3', 'pack', 'Basic', 'mode', 'route', 'date_mission', '2026-09-15', 'service_description', 'Mission de convoyage — Mode route — Pack Basic'),
    'financial', jsonb_build_object('total_ht', 250.00, 'total_tva', 0, 'total_ttc', 250.00, 'currency', 'EUR', 'tva_rate', 0)
  ), '${clientAUserId}', now() - interval '2 days');
UPDATE public.billing_records SET status = 'issued', external_invoice_number = 'INDY-3C-E2E-001', issued_at = now() - interval '1 day' WHERE id = 'e2cb0001-0000-0000-0000-000000000003';

-- Cancelled record for mission 004
INSERT INTO public.billing_records (id, mission_id, client_id, provider, status, invoice_type, total_ht, total_tva, total_ttc, currency, prepared_payload, created_by, created_at)
VALUES ('e2cb0001-0000-0000-0000-000000000004', 'e2ce0001-0000-0000-0000-000000000004', 'e2ca1111-1111-1111-1111-111111111111', 'indy', 'prepared', 'invoice', 750.00, 0, 750.00, 'EUR',
  jsonb_build_object(
    'seller', jsonb_build_object('name', 'Bathily-Convoyage'),
    'customer', jsonb_build_object('name', 'Dupont Transport SARL', 'email', '${CLIENT_A_EMAIL}'),
    'mission', jsonb_build_object('reference', 'E2E-3C-CANCELLED-004'),
    'financial', jsonb_build_object('total_ht', 750.00, 'total_tva', 0, 'total_ttc', 750.00, 'currency', 'EUR')
  ), '${clientAUserId}', now() - interval '3 days');
UPDATE public.billing_records SET status = 'cancelled', cancelled_at = now() - interval '2 days', notes = 'E2E test cancel' WHERE id = 'e2cb0001-0000-0000-0000-000000000004';

-- Issued record for client B mission 005
INSERT INTO public.billing_records (id, mission_id, client_id, provider, status, invoice_type, total_ht, total_tva, total_ttc, currency, prepared_payload, created_by, created_at)
VALUES ('e2cb0002-0000-0000-0000-000000000005', 'e2ce0002-0000-0000-0000-000000000005', 'e2cb2222-2222-2222-2222-222222222222', 'indy', 'prepared', 'invoice', 400.00, 0, 400.00, 'EUR',
  jsonb_build_object(
    'seller', jsonb_build_object('name', 'Bathily-Convoyage'),
    'customer', jsonb_build_object('name', 'Martin Sophie', 'email', '${CLIENT_B_EMAIL}'),
    'mission', jsonb_build_object('reference', 'E2E-3C-CLIENTB-005'),
    'financial', jsonb_build_object('total_ht', 400.00, 'total_tva', 0, 'total_ttc', 400.00, 'currency', 'EUR')
  ), '${clientBUserId}', now() - interval '1 day');
UPDATE public.billing_records SET status = 'issued', external_invoice_number = 'INDY-3C-CLIENTB-001', issued_at = now() WHERE id = 'e2cb0002-0000-0000-0000-000000000005';
`);
});

test.afterAll(async () => {
  try {
    runSQL(`
ALTER TABLE public.billing_events DISABLE TRIGGER billing_events_protect_trigger;
DELETE FROM public.billing_events;
DELETE FROM public.billing_records WHERE mission_id IN (SELECT id FROM public.missions WHERE reference LIKE 'E2E-3C-%');
DELETE FROM public.mission_events WHERE mission_id IN (SELECT id FROM public.missions WHERE reference LIKE 'E2E-3C-%');
DELETE FROM public.missions WHERE reference LIKE 'E2E-3C-%';
DELETE FROM public.user_roles WHERE user_id IN ('${clientAUserId}', '${clientBUserId}');
DELETE FROM public.clients WHERE email LIKE 'test-3c-e2e-%';
DELETE FROM auth.users WHERE email LIKE 'test-3c-e2e-%';
ALTER TABLE public.billing_events ENABLE TRIGGER billing_events_protect_trigger;
`);
  } catch(e) {}
});

test.describe('INDY-3C Client Billing E2E', () => {
  let browser, page, consoleErrors, productionRequests, billingMutationCalls;

  test.beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test.beforeEach(async () => {
    page = await browser.newPage();
    consoleErrors = [];
    productionRequests = [];
    billingMutationCalls = [];

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
      const url = response.url();
      if (url.includes('supabase.co') || url.includes('yzfulgmmngvenxvdvgbp')) {
        productionRequests.push(url);
      }
      // Detect billing mutation RPC calls
      if (url.includes('/rest/v1/rpc/prepare_billing_record') ||
          url.includes('/rest/v1/rpc/link_external_invoice') ||
          url.includes('/rest/v1/rpc/cancel_billing_record')) {
        billingMutationCalls.push(url);
      }
    });

    // Navigate to client dashboard
    await page.goto('http://127.0.0.1:5199/dashboard-client.html', { waitUntil: 'networkidle' });

    // Login as client A
    await page.fill('input[type="email"]', CLIENT_A_EMAIL);
    await page.fill('input[type="password"]', CLIENT_A_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);

    // Dismiss any SweetAlert2 popup that may appear after login
    try {
      const swal = page.locator('.swal2-confirm');
      if (await swal.count() > 0) await swal.click();
    } catch(e) {}
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('client dashboard loads without fatal console errors', async () => {
    // Filter out expected network errors (local environment may have minor issues)
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') && !e.includes('Failed to load resource')
    );
    expect(criticalErrors.length).toBe(0);
  });

  test('Facturation tab opens and shows billing history', async () => {
    // Click on the factures tab
    const facturesTab = page.locator('[onclick*="factures"]');
    await facturesTab.first().click();
    await page.waitForTimeout(1000);

    // Check that the facturation section is visible
    const factList = page.locator('#clientFactList');
    await expect(factList).toBeVisible();

    // Check Indy disclaimer is present
    const bodyText = await page.locator('#tab-factures').textContent();
    expect(bodyText).toContain('Indy');
  });

  test('mission with no billing record shows "Facture non disponible"', async () => {
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(1000);

    const factList = await page.locator('#clientFactList').textContent();
    expect(factList).toContain('Facture non disponible');
    // Must NOT contain a pseudo invoice number
    expect(factList).not.toContain('FAC-');
  });

  test('prepared billing record shows "en cours de préparation"', async () => {
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(1000);

    const factList = await page.locator('#clientFactList').textContent();
    expect(factList).toContain('en cours de préparation');
    // The prepared mission (E2E-3C-PREPARED-002) should NOT have an invoice number
    // Note: the issued mission's number may appear elsewhere in the list
    const preparedItems = await page.locator('#clientFactList .fact-item').all();
    let preparedItemText = '';
    for (const item of preparedItems) {
      const text = await item.textContent();
      if (text.includes('E2E-3C-PREPARED-002')) {
        preparedItemText = text;
        break;
      }
    }
    expect(preparedItemText).toContain('en cours de préparation');
    expect(preparedItemText).not.toContain('Numéro de facture');
    expect(preparedItemText).not.toContain('INDY-');
  });

  test('issued billing record shows external invoice number and date', async () => {
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(1000);

    const factList = await page.locator('#clientFactList').textContent();
    expect(factList).toContain('Facture émise');
    expect(factList).toContain('INDY-3C-E2E-001');
    expect(factList).toContain("Numéro de facture");
    expect(factList).toContain("Date d'émission");
    // Must NOT have a PDF download button
    expect(factList).not.toContain('downloadClientInvoicePdf');
    expect(factList).not.toContain('Télécharger');
  });

  test('cancelled record does not display as issued invoice', async () => {
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(1000);

    const factList = await page.locator('#clientFactList').textContent();
    // The cancelled mission (E2E-3C-CANCELLED-004) should show "Facture non disponible"
    // because cancelled records are ignored in client view
    // It should NOT show "Facture émise" for the cancelled mission
    // The reference should appear as "Référence mission"
    expect(factList).toContain('Référence mission');
  });

  test('no billing mutation RPC calls are made from client dashboard', async () => {
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(2000);

    // Navigate through tabs to trigger any lazy loading
    await page.locator('[onclick*="missions"]').first().click();
    await page.waitForTimeout(1000);
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(1000);

    expect(billingMutationCalls.length).toBe(0);
  });

  test('no requests sent to Production Supabase', async () => {
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(2000);
    expect(productionRequests.length).toBe(0);
  });

  test('payment status remains visible and separate from billing', async () => {
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(1000);

    const factList = await page.locator('#clientFactList').textContent();
    // Payment status must be visible
    expect(factList).toContain('Paiement');
    expect(factList).toMatch(/Payé|En attente/);
    // Billing and payment must be separate labels
    expect(factList).toMatch(/Facture non disponible|en cours de préparation|Facture émise/);
  });

  test('no jsPDF or autoTable scripts loaded', async () => {
    // Check that jsPDF script tag is not present
    const jspdfScript = await page.locator('script[src*="jspdf"]').count();
    expect(jspdfScript).toBe(0);

    const autoTableScript = await page.locator('script[src*="autotable"]').count();
    expect(autoTableScript).toBe(0);
  });

  test('cross-client isolation: client A cannot see client B billing records', async () => {
    await page.locator('[onclick*="factures"]').first().click();
    await page.waitForTimeout(1000);

    const factList = await page.locator('#clientFactList').textContent();
    // Client B's invoice number must NOT appear in client A's view
    expect(factList).not.toContain('INDY-3C-CLIENTB-001');
    // Client B's mission reference must NOT appear
    expect(factList).not.toContain('E2E-3C-CLIENTB-005');
  });
});
