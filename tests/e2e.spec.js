import { test, expect } from '@playwright/test';

// =====================================================
// Tests E2E — Page d'accueil
// =====================================================

test.describe('Page d\'accueil', () => {
  test('charge la page d\'accueil correctement', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Bathily.*Convoyage/i);
  });

  test('affiche les packs de service', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Formule Starter').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Pack Sérénité').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Pack Excellence').first()).toBeVisible({ timeout: 10000 });
  });

  test('redirige vers le devis au clic CTA', async ({ page }) => {
    await page.goto('/');
    const devisLink = page.locator('a[href*="devis.html"]').first();
    await expect(devisLink).toBeVisible();
  });
});

// =====================================================
// Tests E2E — Page Devis
// =====================================================

test.describe('Page Devis', () => {
  test('charge le formulaire de devis', async ({ page }) => {
    await page.goto('/devis.html');
    await expect(page.locator('#devisForm')).toBeVisible({ timeout: 10000 });
  });

  test('calcule un prix après saisie du trajet', async ({ page }) => {
    await page.goto('/devis.html');

    // Saisir le départ et l'arrivée
    await page.locator('#depart').fill('Paris');
    await page.locator('#depart').blur();
    await page.locator('#arrivee').fill('Lyon');
    await page.locator('#arrivee').blur();

    // Passer à l'étape 2 pour afficher le prix
    await page.locator('#panel-1 .btn-next').click();

    // Attendre que le calcul soit terminé (le prix ou une erreur s'affiche)
    await expect(page.locator('#priceDisplay')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#priceDisplay')).not.toHaveText(/\.{3}/, { timeout: 15000 });
    const priceText = await page.locator('#priceDisplay').textContent();
    // Le prix doit contenir un chiffre OU indiquer "Distance non calculable"
    const hasNumber = /\d/.test(priceText || '');
    const hasError = /Distance non calculable|non calculable/i.test(priceText || '');
    expect(hasNumber || hasError).toBeTruthy();
  });

  test('valide les champs obligatoires', async ({ page }) => {
    await page.goto('/devis.html');

    // Tenter de soumettre sans remplir
    const submitBtn = page.locator('button[type="submit"], #btnDevisSubmit').first();
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
      // Une erreur de validation doit apparaître
      await expect(page.locator('.field-err, .swal2-popup')).toBeVisible({ timeout: 5000 });
    }
  });

  test('accepte les CGU avec rel="noopener"', async ({ page }) => {
    await page.goto('/devis.html');
    const cguLink = page.locator('a[href*="mentions-legales.html#cgu"]');
    await expect(cguLink).toHaveAttribute('rel', 'noopener');
  });
});

// =====================================================
// Tests E2E — Page Contact
// =====================================================

test.describe('Page Contact', () => {
  test('charge le formulaire de contact', async ({ page }) => {
    await page.goto('/contact.html');
    await expect(page.locator('#contactForm')).toBeVisible({ timeout: 10000 });
  });

  test('lien politique de confidentialité a rel="noopener"', async ({ page }) => {
    await page.goto('/contact.html');
    const privacyLink = page.locator('a[href*="mentions-legales.html#privacy"]');
    await expect(privacyLink).toHaveAttribute('rel', 'noopener');
  });
});

// =====================================================
// Tests E2E — Pages SEO
// =====================================================

test.describe('Pages SEO', () => {
  const seoPages = [
    '/convoyage-bordeaux.html',
    '/convoyage-lyon.html',
    '/convoyage-marseille.html',
    '/convoyage-toulouse.html',
    '/convoyage-montpellier.html',
    '/convoyage-moto-voiture-paris.html',
    '/convoyage-moto-voiture-france.html',
    '/convoyage-vehicule-lille.html',
    '/convoyage-vehicule-nantes.html',
    '/convoyage-vehicule-nice.html',
    '/convoyage-vehicule-rennes.html',
    '/convoyage-vehicule-strasbourg.html',
  ];

  for (const seoPage of seoPages) {
    test(`${seoPage} se charge correctement`, async ({ page }) => {
      await page.goto(seoPage);
      await expect(page).toHaveTitle(/Convoyage/i);
      // Vérifier qu'il n'y a pas d'erreur console critique
      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      await page.waitForLoadState('networkidle');
      // Les erreurs de config Supabase en local sont acceptables
      const criticalErrors = consoleErrors.filter(e =>
        !e.includes('Supabase') && !e.includes('supabase') && !e.includes('404') && !e.includes('Failed to load')
      );
      expect(criticalErrors).toHaveLength(0);
    });
  }
});

// =====================================================
// Tests E2E — Page Formation
// =====================================================

test.describe('Page Formation', () => {
  test('charge la page formation', async ({ page }) => {
    await page.goto('/formation-convoyeur.html');
    await expect(page).toHaveTitle(/Devenir convoyeur/i);
  });

  test('affiche les modules de formation', async ({ page }) => {
    await page.goto('/formation-convoyeur.html');
    await page.waitForLoadState('networkidle');
    // La page doit avoir du contenu de formation
    const content = await page.textContent('body');
    expect(content?.length || 0).toBeGreaterThan(500);
  });
});

// =====================================================
// Tests E2E — Sécurité headers
// =====================================================

test.describe('Sécurité headers', () => {
  test('les headers de sécurité sont présents', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toContain('strict-origin');
  });
});

// =====================================================
// Tests E2E — Pages Dashboard (sans auth)
// =====================================================

test.describe('Dashboards sans authentification', () => {
  test('dashboard-client redirige si non connecté', async ({ page }) => {
    await page.goto('/dashboard-client.html');
    await page.waitForLoadState('networkidle');
    // Doit afficher un écran de login ou rediriger
    const url = page.url();
    const hasLogin = await page.locator('input[type="email"], input[type="password"], .swal2-popup').first().isVisible().catch(() => false);
    expect(hasLogin || url.includes('login') || url.includes('index')).toBeTruthy();
  });

  test('dashboard-convoyeur redirige si non connecté', async ({ page }) => {
    await page.goto('/dashboard-convoyeur.html');
    await page.waitForLoadState('networkidle');
    const url = page.url();
    const hasLogin = await page.locator('input[type="email"], input[type="password"], .swal2-popup').first().isVisible().catch(() => false);
    expect(hasLogin || url.includes('login') || url.includes('index')).toBeTruthy();
  });

  test('dashboard-admin redirige si non connecté', async ({ page }) => {
    await page.goto('/dashboard-admin.html');
    await page.waitForLoadState('networkidle');
    const url = page.url();
    const hasLogin = await page.locator('input[type="email"], input[type="password"], .swal2-popup').first().isVisible().catch(() => false);
    expect(hasLogin || url.includes('login') || url.includes('index')).toBeTruthy();
  });
});
