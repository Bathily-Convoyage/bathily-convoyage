// MISSIONS-EXT-3A — Browser runtime smoke test
// Loads dashboard-admin.html, injects mock mission data, verifies
// source-aware payment wording in the rendered DOM.
// No Supabase, no network, no auth required.

import { test, expect } from '@playwright/test';

const MOCK_CONFIG = `
window.SUPABASE_URL = "http://127.0.0.1:59999";
window.SUPABASE_ANON_KEY = "mock-anon-key";
`;

// Payment cell is at index 10 in the missions table
const PAY_CELL_INDEX = 10;

test.describe('MISSIONS-EXT-3A — Platform Settlement Semantics (browser smoke)', () => {
  test.beforeEach(async ({ page }) => {
    // Intercept supabase-config.js to prevent real API calls
    await page.route('**/supabase-config.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: MOCK_CONFIG,
      });
    });
    // Intercept any Supabase API calls
    await page.route('http://127.0.0.1:59999/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/dashboard-admin.html');
    // Wait for the page to settle — loadMissions will fail silently
    await page.waitForLoadState('networkidle');
    // Small delay to let any async loadMissions complete
    await page.waitForTimeout(500);
  });

  test('Scenario A — DIRECT mission pending: old wording preserved', async ({ page }) => {
    const result = await page.evaluate((payIdx) => {
      const mission = {
        id: 'direct-pending-001',
        reference: 'BC-DIRECT-001',
        source_mission: 'direct',
        paiement_statut: 'pending',
        status: 'assigned',
        depart: 'Paris',
        arrivee: 'Lyon',
        client_nom: 'TestClient',
        convoyeur_nom: 'TestConvoyeur',
        vehicule: 'Berline',
        pack: 'Standard',
        montant_ht: 500,
        date_mission: '2026-09-06',
      };
      const disp = window.getMissionPaymentDisplay(mission);
      window._allMissions = [mission];
      window._missionIncidentCounts = {};
      window._missionExpenseSubmittedCounts = {};
      window.renderMissionsTable([mission]);
      const rows = document.querySelectorAll('#missionsTableBody tr');
      const payCell = rows.length > 0 ? rows[0].cells[payIdx] : null;
      return {
        badgeLabel: disp.badgeLabel,
        actionLabel: disp.actionLabel,
        isExternal: disp.isExternal,
        payCellText: payCell ? payCell.textContent.trim() : null,
      };
    }, PAY_CELL_INDEX);
    expect(result.isExternal).toBe(false);
    expect(result.badgeLabel).toBe('En attente');
    expect(result.actionLabel).toBe('Marquer payée');
    expect(result.payCellText).toContain('En attente');
    expect(result.payCellText).not.toContain('règlement');
  });

  test('Scenario A2 — DIRECT mission paid: old wording preserved', async ({ page }) => {
    const result = await page.evaluate((payIdx) => {
      const mission = {
        id: 'direct-paid-001',
        reference: 'BC-DIRECT-002',
        source_mission: 'direct',
        paiement_statut: 'paid',
        status: 'completed',
        depart: 'Paris',
        arrivee: 'Lyon',
        client_nom: 'TestClient',
        convoyeur_nom: 'TestConvoyeur',
        vehicule: 'Berline',
        pack: 'Standard',
        montant_ht: 500,
        date_mission: '2026-09-06',
      };
      const disp = window.getMissionPaymentDisplay(mission);
      window._allMissions = [mission];
      window._missionIncidentCounts = {};
      window._missionExpenseSubmittedCounts = {};
      window.renderMissionsTable([mission]);
      const rows = document.querySelectorAll('#missionsTableBody tr');
      const payCell = rows.length > 0 ? rows[0].cells[payIdx] : null;
      return {
        badgeLabel: disp.badgeLabel,
        payCellText: payCell ? payCell.textContent.trim() : null,
      };
    }, PAY_CELL_INDEX);
    expect(result.badgeLabel).toBe('Payé');
    expect(result.payCellText).toContain('Payé');
    expect(result.payCellText).not.toContain('Règlement');
  });

  test('Scenario B — HIFLOW mission pending: settlement wording', async ({ page }) => {
    const result = await page.evaluate((payIdx) => {
      const mission = {
        id: 'hiflow-pending-001',
        reference: 'BC-HIFLOW-001',
        source_mission: 'hiflow',
        external_reference: 'HF-123456',
        paiement_statut: 'pending',
        status: 'assigned',
        depart: 'Paris',
        arrivee: 'Marseille',
        client_nom: null,
        convoyeur_nom: 'TestConvoyeur',
        vehicule: 'SUV',
        pack: null,
        montant_ht: 800,
        date_mission: '2026-09-06',
      };
      const disp = window.getMissionPaymentDisplay(mission);
      window._allMissions = [mission];
      window._missionIncidentCounts = {};
      window._missionExpenseSubmittedCounts = {};
      window.renderMissionsTable([mission]);
      const rows = document.querySelectorAll('#missionsTableBody tr');
      const payCell = rows.length > 0 ? rows[0].cells[payIdx] : null;
      const actionBtn = rows.length > 0 ? rows[0].querySelector('button[onclick*="markMissionPaid"]') : null;
      return {
        badgeLabel: disp.badgeLabel,
        actionLabel: disp.actionLabel,
        sectionLabel: disp.sectionLabel,
        isExternal: disp.isExternal,
        payCellText: payCell ? payCell.textContent.trim() : null,
        actionBtnTitle: actionBtn ? actionBtn.getAttribute('title') : null,
      };
    }, PAY_CELL_INDEX);
    expect(result.isExternal).toBe(true);
    expect(result.badgeLabel).toBe('En attente de règlement');
    expect(result.actionLabel).toBe('Marquer règlement reçu');
    expect(result.sectionLabel).toBe('Règlement plateforme');
    expect(result.payCellText).toContain('En attente de règlement');
    expect(result.payCellText).not.toContain('Payé');
    expect(result.actionBtnTitle).toBe('Marquer règlement reçu');
  });

  test('Scenario B2 — HIFLOW mission paid: settlement received', async ({ page }) => {
    const result = await page.evaluate((payIdx) => {
      const mission = {
        id: 'hiflow-paid-001',
        reference: 'BC-HIFLOW-002',
        source_mission: 'hiflow',
        external_reference: 'HF-789012',
        paiement_statut: 'paid',
        status: 'completed',
        depart: 'Paris',
        arrivee: 'Marseille',
        client_nom: null,
        convoyeur_nom: 'TestConvoyeur',
        vehicule: 'SUV',
        pack: null,
        montant_ht: 800,
        date_mission: '2026-09-06',
      };
      const disp = window.getMissionPaymentDisplay(mission);
      window._allMissions = [mission];
      window._missionIncidentCounts = {};
      window._missionExpenseSubmittedCounts = {};
      window.renderMissionsTable([mission]);
      const rows = document.querySelectorAll('#missionsTableBody tr');
      const payCell = rows.length > 0 ? rows[0].cells[payIdx] : null;
      return {
        badgeLabel: disp.badgeLabel,
        payCellText: payCell ? payCell.textContent.trim() : null,
      };
    }, PAY_CELL_INDEX);
    expect(result.badgeLabel).toBe('Règlement reçu');
    expect(result.payCellText).toContain('Règlement reçu');
    expect(result.payCellText).not.toContain('Payé');
  });

  test('Scenario C — HIFLOW mission details modal: settlement wording', async ({ page }) => {
    // Set mock data and open the details modal
    // _allMissions is a `let` in the global lexical scope, not on window.
    // Assign directly (without window.) to update the closure variable.
    await page.evaluate(() => {
      const mission = {
        id: 'hiflow-detail-001',
        reference: 'BC-HIFLOW-003',
        source_mission: 'hiflow',
        external_reference: 'HF-DETAIL-001',
        paiement_statut: 'pending',
        status: 'assigned',
        depart: 'Paris',
        arrivee: 'Marseille',
        client_nom: null,
        client_email: null,
        client_telephone: null,
        convoyeur_nom: 'TestConvoyeur',
        vehicule: 'Berline',
        mode: 'route',
        montant_ht: 800,
        date_mission: '2026-09-06',
      };
      // Assign to the lexical _allMissions (let-declared in global scope)
      _allMissions = [mission];
      viewMissionDetails('hiflow-detail-001');
    });
    // Wait for Swal modal to appear
    await page.waitForSelector('.swal2-modal', { timeout: 5000 });
    const modalText = await page.textContent('.swal2-modal');
    expect(modalText).toContain('En attente de règlement');
    // Verify no standalone direct "Payé" wording leaked into external modal
    expect(modalText).not.toContain('Payé');
    // Check the action button in the modal
    const modalHtml = await page.innerHTML('.swal2-html-container');
    expect(modalHtml).toContain('Marquer règlement reçu');
    expect(modalHtml).not.toContain('Marquer payée');
  });

  test('Scenario D — No "Payer" or Stripe wording for external missions', async ({ page }) => {
    const result = await page.evaluate((payIdx) => {
      const mission = {
        id: 'ext-no-payer-001',
        reference: 'BC-EXT-004',
        source_mission: 'driiveme',
        external_reference: 'DR-001',
        paiement_statut: 'pending',
        status: 'assigned',
        depart: 'Lille',
        arrivee: 'Nantes',
        client_nom: null,
        convoyeur_nom: 'TestConvoyeur',
        vehicule: 'Van',
        pack: null,
        montant_ht: 600,
        date_mission: '2026-09-06',
      };
      const disp = window.getMissionPaymentDisplay(mission);
      window._allMissions = [mission];
      window._missionIncidentCounts = {};
      window._missionExpenseSubmittedCounts = {};
      window.renderMissionsTable([mission]);
      const rows = document.querySelectorAll('#missionsTableBody tr');
      const payCell = rows.length > 0 ? rows[0].cells[payIdx] : null;
      const allBtns = rows.length > 0 ? Array.from(rows[0].querySelectorAll('button')) : [];
      const allBtnTexts = allBtns.map(b => b.textContent + ' ' + (b.getAttribute('title') || ''));
      return {
        payCellText: payCell ? payCell.textContent.trim() : null,
        allBtnTexts: allBtnTexts,
        actionLabel: disp.actionLabel,
      };
    }, PAY_CELL_INDEX);
    expect(result.payCellText).not.toContain('Payer');
    expect(result.actionLabel).not.toContain('Payer');
    const allText = result.payCellText + ' ' + result.allBtnTexts.join(' ');
    expect(allText).not.toContain('Stripe');
    expect(allText).not.toContain('checkout');
  });
});
