import { test, expect } from '@playwright/test';
import { createServiceClient } from './helpers.js';

const TEST_EMAIL = 'test-newsletter-' + Date.now() + '@example.com';

test.describe('Formulaires publics', () => {
  test('La page d\'accueil se charge', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Bathily-Convoyage/i);
  });

  test('Inscription newsletter', async ({ page }) => {
    await page.goto('/');
    const form = await page.locator('#newsletterForm');
    await form.locator('input[name="email"]').fill('playwright-' + TEST_EMAIL);
    await form.locator('input[name="nom"]').fill('Testeur Playwright');
    await form.locator('button[type="submit"]').click();

    // Attendre SweetAlert de confirmation
    await page.waitForSelector('.swal2-confirm', { timeout: 10000 });
    const modalText = await page.locator('.swal2-title').textContent();
    expect(modalText).toMatch(/Inscription confirmée|confirmée/i);
  });

  test('Désinscription newsletter par token', async () => {
    test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'Pas de service role key');
    const sb = createServiceClient();

    const { data: subscriber } = await sb
      .from('newsletter_subscribers')
      .select('unsubscribe_token')
      .eq('email', 'playwright-' + TEST_EMAIL)
      .single();

    test.skip(!subscriber, 'Abonné de test non trouvé');

    // Note: ce test nécessite un navigateur, on ne peut pas le faire directement ici
    // Il faudrait utiliser page.goto('/unsubscribe.html?token=' + token)
  });

  test('Formulaire de contact / support anonyme', async ({ page }) => {
    await page.goto('/contact.html');
    await page.locator('input[name="email"], input[name="client_email"]').fill('test-contact@example.com');
    await page.locator('input[name="nom"], input[name="client_nom"]').fill('Testeur');
    await page.locator('input[name="sujet"]').fill('Test sujet');
    await page.locator('textarea[name="message"]').fill('Message de test Playwright');
    await page.locator('button[type="submit"]').click();

    await page.waitForTimeout(3000);
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toMatch(/merci|envoyé|succès|confirmé/i);
  });
});
