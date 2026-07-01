import { test, expect } from '@playwright/test';

const TEST_CLIENT = process.env.TEST_CLIENT_EMAIL || 'client@example.com';
const TEST_CLIENT_PASSWORD = process.env.TEST_CLIENT_PASSWORD || 'password';
const TEST_CONVOYEUR = process.env.TEST_CONVOYEUR_EMAIL || 'convoyeur@example.com';
const TEST_CONVOYEUR_PASSWORD = process.env.TEST_CONVOYEUR_PASSWORD || 'password';
const TEST_ADMIN = process.env.TEST_ADMIN_EMAIL || 'admin@example.com';
const TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'password';

test.describe('Authentification dashboards', () => {
  test('Login client', async ({ page }) => {
    test.skip(!TEST_CLIENT || !TEST_CLIENT_PASSWORD, 'Pas de credentials client');
    await page.goto('/dashboard-client.html');
    await page.locator('input[type="email"]').fill(TEST_CLIENT);
    await page.locator('input[type="password"]').fill(TEST_CLIENT_PASSWORD);
    await page.locator('button[type="submit"], button:has-text("Connexion")').click();
    await page.waitForTimeout(3000);
    const overlay = await page.locator('#clientLoginOverlay').isVisible().catch(() => true);
    expect(overlay).toBe(false);
  });

  test('Login convoyeur', async ({ page }) => {
    test.skip(!TEST_CONVOYEUR || !TEST_CONVOYEUR_PASSWORD, 'Pas de credentials convoyeur');
    await page.goto('/dashboard-convoyeur.html');
    await page.locator('input[type="email"]').fill(TEST_CONVOYEUR);
    await page.locator('input[type="password"]').fill(TEST_CONVOYEUR_PASSWORD);
    await page.locator('button[type="submit"], button:has-text("Connexion")').click();
    await page.waitForTimeout(3000);
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toMatch(/Bienvenue|dashboard|convoyeur|missions/i);
  });

  test('Login admin', async ({ page }) => {
    test.skip(!TEST_ADMIN || !TEST_ADMIN_PASSWORD, 'Pas de credentials admin');
    await page.goto('/dashboard-admin.html');
    await page.locator('input[type="email"]').fill(TEST_ADMIN);
    await page.locator('input[type="password"]').fill(TEST_ADMIN_PASSWORD);
    await page.locator('button[type="submit"], button:has-text("Connexion")').click();
    await page.waitForTimeout(3000);
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toMatch(/admin|Admin|Dashboard|dashboard/i);
  });
});
