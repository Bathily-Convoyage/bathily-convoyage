/**
 * P2 — BUG-LOGIN-LEGACY fix verification
 *
 * Verifies that dashboard-client.html and dashboard-convoyeur.html:
 * 1. Call getEmailNotConfirmedMessage() for email_not_confirmed errors
 * 2. Call getPasswordRejectionMessage() for weak_password errors
 * 3. Fall back to "Email ou mot de passe incorrect" (NOT "migré")
 * 4. Never show "Votre compte n'est pas encore migré" for any auth failure
 *
 * Also verifies that dashboard-operator.html already had the correct pattern
 * (regression guard).
 *
 * Also verifies that auth-password-errors.js exposes getEmailNotConfirmedMessage
 * and that it correctly detects email_not_confirmed errors.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// Load the auth-password-errors helper
const helperSource = await readFile(
  new URL('../public/js/auth-password-errors.js', import.meta.url),
  'utf8'
);
const browserContext = { window: {} };
vm.runInNewContext(helperSource, browserContext);
const AuthErrors = browserContext.window.BathilyAuthErrors;

// ============================================================
// Helper unit tests
// ============================================================

test('getEmailNotConfirmedMessage detects email_not_confirmed code', () => {
  const msg = AuthErrors.getEmailNotConfirmedMessage({
    code: 'email_not_confirmed',
    message: 'Email not confirmed'
  });
  assert.equal(msg, AuthErrors.EMAIL_NOT_CONFIRMED_MESSAGE);
  assert.match(msg, /confirmée/);
});

test('getEmailNotConfirmedMessage detects "email not confirmed" message', () => {
  const msg = AuthErrors.getEmailNotConfirmedMessage({
    message: 'Email not confirmed'
  });
  assert.equal(msg, AuthErrors.EMAIL_NOT_CONFIRMED_MESSAGE);
});

test('getEmailNotConfirmedMessage detects "email not verified" message', () => {
  const msg = AuthErrors.getEmailNotConfirmedMessage({
    message: 'Email not verified'
  });
  assert.equal(msg, AuthErrors.EMAIL_NOT_CONFIRMED_MESSAGE);
});

test('getEmailNotConfirmedMessage returns null for invalid credentials', () => {
  assert.equal(AuthErrors.getEmailNotConfirmedMessage({
    code: 'invalid_credentials',
    message: 'Invalid login credentials'
  }), null);
});

test('getEmailNotConfirmedMessage returns null for network errors', () => {
  assert.equal(AuthErrors.getEmailNotConfirmedMessage({
    message: 'Failed to fetch'
  }), null);
});

test('getPasswordRejectionMessage still detects weak_password', () => {
  const msg = AuthErrors.getPasswordRejectionMessage({
    code: 'weak_password',
    name: 'AuthWeakPasswordError',
    reasons: ['pwned']
  });
  assert.equal(msg, AuthErrors.COMPROMISED_PASSWORD_MESSAGE);
});

// ============================================================
// HTML source verification
// ============================================================

test('dashboard-client.html calls getEmailNotConfirmedMessage in login handler', async () => {
  const html = await readFile(
    new URL('../dashboard-client.html', import.meta.url),
    'utf8'
  );
  assert.match(
    html,
    /getEmailNotConfirmedMessage/,
    'dashboard-client.html must call getEmailNotConfirmedMessage in login handler'
  );
});

test('dashboard-client.html does NOT show "migré" fallback for auth failures', async () => {
  const html = await readFile(
    new URL('../dashboard-client.html', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(
    html,
    /pas encore migré/,
    'dashboard-client.html must not show "pas encore migré" as auth fallback'
  );
});

test('dashboard-client.html falls back to "Email ou mot de passe incorrect"', async () => {
  const html = await readFile(
    new URL('../dashboard-client.html', import.meta.url),
    'utf8'
  );
  assert.match(
    html,
    /Email ou mot de passe incorrect/,
    'dashboard-client.html must use generic invalid credentials fallback'
  );
});

test('dashboard-convoyeur.html calls getEmailNotConfirmedMessage in login handler', async () => {
  const html = await readFile(
    new URL('../dashboard-convoyeur.html', import.meta.url),
    'utf8'
  );
  assert.match(
    html,
    /getEmailNotConfirmedMessage/,
    'dashboard-convoyeur.html must call getEmailNotConfirmedMessage in login handler'
  );
});

test('dashboard-convoyeur.html does NOT show "migré" fallback for auth failures', async () => {
  const html = await readFile(
    new URL('../dashboard-convoyeur.html', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(
    html,
    /pas encore migré/,
    'dashboard-convoyeur.html must not show "pas encore migré" as auth fallback'
  );
});

test('dashboard-convoyeur.html falls back to "Email ou mot de passe incorrect"', async () => {
  const html = await readFile(
    new URL('../dashboard-convoyeur.html', import.meta.url),
    'utf8'
  );
  assert.match(
    html,
    /Email ou mot de passe incorrect/,
    'dashboard-convoyeur.html must use generic invalid credentials fallback'
  );
});

// ============================================================
// Regression guard: operator dashboard was already correct
// ============================================================

test('dashboard-operator.html does NOT show "migré" fallback (regression guard)', async () => {
  const html = await readFile(
    new URL('../dashboard-operator.html', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(
    html,
    /pas encore migré/,
    'dashboard-operator.html must not show "pas encore migré" (was already correct)'
  );
});

// ============================================================
// Auth information leak check
// ============================================================

test('no login handler exposes whether an email exists in the system', async () => {
  const files = [
    'dashboard-client.html',
    'dashboard-convoyeur.html',
    'dashboard-operator.html'
  ];
  for (const file of files) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    // The fallback message must be generic — no "compte existe" or "email trouvé"
    assert.doesNotMatch(
      html,
      /ce compte existe|cet email est enregistré|compte trouvé/i,
      `${file} must not leak account existence information`
    );
  }
});

// ============================================================
// Reset password flow unchanged
// ============================================================

test('reset password flow handlers are unchanged in client dashboard', async () => {
  const html = await readFile(
    new URL('../dashboard-client.html', import.meta.url),
    'utf8'
  );
  assert.match(html, /handleForgotPassword/, 'handleForgotPassword must still exist');
});

test('reset password flow handlers are unchanged in convoyeur dashboard', async () => {
  const html = await readFile(
    new URL('../dashboard-convoyeur.html', import.meta.url),
    'utf8'
  );
  assert.match(html, /handleConvoForgotPassword/, 'handleConvoForgotPassword must still exist');
});
