/**
 * P2A — AUTH ERROR ROUTING FINAL VERIFICATION
 *
 * Verifies exact user-visible outcomes for each auth error case in
 * dashboard-client.html and dashboard-convoyeur.html login handlers.
 *
 * Routing chain (both dashboards):
 *   emailMessage || passwordMessage || networkMessage || fallbackMessage
 *
 * Where:
 *   emailMessage    = getEmailNotConfirmedMessage(authError)  → email_not_confirmed
 *   passwordMessage = getPasswordRejectionMessage(authError)  → weak_password
 *   networkMessage  = getNetworkErrorMessage(authError)       → network/transient
 *   fallbackMessage = 'Email ou mot de passe incorrect...'     → invalid_credentials/unknown
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
// Helper unit tests — exact detection conditions
// ============================================================

// --- invalid_credentials ---
test('invalid_credentials: getEmailNotConfirmedMessage returns null', () => {
  const err = { code: 'invalid_credentials', message: 'Invalid login credentials' };
  assert.equal(AuthErrors.getEmailNotConfirmedMessage(err), null);
});

test('invalid_credentials: getPasswordRejectionMessage returns null', () => {
  const err = { code: 'invalid_credentials', message: 'Invalid login credentials' };
  assert.equal(AuthErrors.getPasswordRejectionMessage(err), null);
});

test('invalid_credentials: getNetworkErrorMessage returns null', () => {
  const err = { code: 'invalid_credentials', message: 'Invalid login credentials' };
  assert.equal(AuthErrors.getNetworkErrorMessage(err), null);
});

test('invalid_credentials: routing resolves to fallback (generic, no enumeration)', () => {
  const err = { code: 'invalid_credentials', message: 'Invalid login credentials' };
  const emailMessage = AuthErrors.getEmailNotConfirmedMessage(err);
  const passwordMessage = AuthErrors.getPasswordRejectionMessage(err);
  const networkMessage = AuthErrors.getNetworkErrorMessage(err);
  const fallbackMessage = 'Email ou mot de passe incorrect. Utilisez « Mot de passe oublié » pour réinitialiser votre mot de passe.';
  const result = emailMessage || passwordMessage || networkMessage || fallbackMessage;
  assert.equal(result, fallbackMessage);
  assert.doesNotMatch(result, /migré/i, 'Must not mention migration');
  assert.doesNotMatch(result, /existe|enregistré|trouvé/i, 'Must not leak account existence');
});

// --- email_not_confirmed ---
test('email_not_confirmed (code): getEmailNotConfirmedMessage returns specific message', () => {
  const err = { code: 'email_not_confirmed', message: 'Email not confirmed' };
  const msg = AuthErrors.getEmailNotConfirmedMessage(err);
  assert.equal(msg, AuthErrors.EMAIL_NOT_CONFIRMED_MESSAGE);
  assert.match(msg, /confirmée/);
});

test('email_not_confirmed (message variant): detected by message text', () => {
  const err = { message: 'Email not confirmed' };
  const msg = AuthErrors.getEmailNotConfirmedMessage(err);
  assert.equal(msg, AuthErrors.EMAIL_NOT_CONFIRMED_MESSAGE);
});

test('email_not_confirmed (verified variant): detected by message text', () => {
  const err = { message: 'Email not verified' };
  const msg = AuthErrors.getEmailNotConfirmedMessage(err);
  assert.equal(msg, AuthErrors.EMAIL_NOT_CONFIRMED_MESSAGE);
});

test('email_not_confirmed: does NOT fall through to invalid credentials', () => {
  const err = { code: 'email_not_confirmed', message: 'Email not confirmed' };
  const emailMessage = AuthErrors.getEmailNotConfirmedMessage(err);
  const passwordMessage = AuthErrors.getPasswordRejectionMessage(err);
  const networkMessage = AuthErrors.getNetworkErrorMessage(err);
  const fallbackMessage = 'Email ou mot de passe incorrect.';
  const result = emailMessage || passwordMessage || networkMessage || fallbackMessage;
  assert.equal(result, AuthErrors.EMAIL_NOT_CONFIRMED_MESSAGE);
  assert.doesNotMatch(result, /incorrect/i, 'Must not show invalid credentials text');
  assert.doesNotMatch(result, /migré/i, 'Must not show migration text');
});

// --- weak_password ---
test('weak_password (pwned): getPasswordRejectionMessage returns compromised message', () => {
  const err = { code: 'weak_password', name: 'AuthWeakPasswordError', reasons: ['pwned'] };
  const msg = AuthErrors.getPasswordRejectionMessage(err);
  assert.equal(msg, AuthErrors.COMPROMISED_PASSWORD_MESSAGE);
});

test('weak_password (length): getPasswordRejectionMessage returns weak message', () => {
  const err = { code: 'weak_password', name: 'AuthWeakPasswordError', reasons: ['length'] };
  const msg = AuthErrors.getPasswordRejectionMessage(err);
  assert.equal(msg, AuthErrors.WEAK_PASSWORD_MESSAGE);
});

test('weak_password: does NOT fall through to invalid credentials', () => {
  const err = { code: 'weak_password', name: 'AuthWeakPasswordError', reasons: ['pwned'] };
  const emailMessage = AuthErrors.getEmailNotConfirmedMessage(err);
  const passwordMessage = AuthErrors.getPasswordRejectionMessage(err);
  const networkMessage = AuthErrors.getNetworkErrorMessage(err);
  const fallbackMessage = 'Email ou mot de passe incorrect.';
  const result = emailMessage || passwordMessage || networkMessage || fallbackMessage;
  assert.equal(result, AuthErrors.COMPROMISED_PASSWORD_MESSAGE);
  assert.doesNotMatch(result, /incorrect/i);
});

// --- network/fetch failure ---
test('network failure (AuthRetryableError): getNetworkErrorMessage returns neutral message', () => {
  const err = { name: 'AuthRetryableError', message: 'fetch failed', status: 0 };
  const msg = AuthErrors.getNetworkErrorMessage(err);
  assert.equal(msg, AuthErrors.NETWORK_ERROR_MESSAGE);
  assert.match(msg, /erreur technique/i);
  assert.match(msg, /connexion/i);
});

test('network failure (status 0): detected as network error', () => {
  const err = { message: 'Network request failed', status: 0 };
  assert.ok(AuthErrors.isNetworkOrTransientError(err));
  const msg = AuthErrors.getNetworkErrorMessage(err);
  assert.equal(msg, AuthErrors.NETWORK_ERROR_MESSAGE);
});

test('network failure (fetch in message, no code): detected as network error', () => {
  const err = { message: 'TypeError: fetch failed' };
  assert.ok(AuthErrors.isNetworkOrTransientError(err));
  const msg = AuthErrors.getNetworkErrorMessage(err);
  assert.equal(msg, AuthErrors.NETWORK_ERROR_MESSAGE);
});

test('network failure (timeout in message, no code): detected as network error', () => {
  const err = { message: 'Request timeout' };
  assert.ok(AuthErrors.isNetworkOrTransientError(err));
  const msg = AuthErrors.getNetworkErrorMessage(err);
  assert.equal(msg, AuthErrors.NETWORK_ERROR_MESSAGE);
});

test('network failure (5xx status): detected as network error', () => {
  const err = { message: 'Internal Server Error', status: 500 };
  assert.ok(AuthErrors.isNetworkOrTransientError(err));
  const msg = AuthErrors.getNetworkErrorMessage(err);
  assert.equal(msg, AuthErrors.NETWORK_ERROR_MESSAGE);
});

test('network failure: does NOT show "compte non migré"', () => {
  const err = { name: 'AuthRetryableError', message: 'fetch failed', status: 0 };
  const emailMessage = AuthErrors.getEmailNotConfirmedMessage(err);
  const passwordMessage = AuthErrors.getPasswordRejectionMessage(err);
  const networkMessage = AuthErrors.getNetworkErrorMessage(err);
  const fallbackMessage = 'Email ou mot de passe incorrect.';
  const result = emailMessage || passwordMessage || networkMessage || fallbackMessage;
  assert.equal(result, AuthErrors.NETWORK_ERROR_MESSAGE);
  assert.doesNotMatch(result, /migré/i, 'Must not show migration text');
});

test('network failure: does NOT claim "Email ou mot de passe incorrect"', () => {
  const err = { name: 'AuthRetryableError', message: 'fetch failed', status: 0 };
  const emailMessage = AuthErrors.getEmailNotConfirmedMessage(err);
  const passwordMessage = AuthErrors.getPasswordRejectionMessage(err);
  const networkMessage = AuthErrors.getNetworkErrorMessage(err);
  const fallbackMessage = 'Email ou mot de passe incorrect.';
  const result = emailMessage || passwordMessage || networkMessage || fallbackMessage;
  assert.equal(result, AuthErrors.NETWORK_ERROR_MESSAGE);
  assert.doesNotMatch(result, /incorrect/i, 'Must not claim credentials are incorrect');
});

// --- timeout/transient ---
test('transient (abort in message, no code): detected as network error', () => {
  const err = { message: 'The operation was aborted' };
  assert.ok(AuthErrors.isNetworkOrTransientError(err));
});

test('transient (connection in message, no code): detected as network error', () => {
  const err = { message: 'Connection refused' };
  assert.ok(AuthErrors.isNetworkOrTransientError(err));
});

// --- unknown authentication error ---
test('unknown auth error (with unrecognized code): falls to fallback', () => {
  const err = { code: 'some_unknown_code', message: 'Something unexpected' };
  const emailMessage = AuthErrors.getEmailNotConfirmedMessage(err);
  const passwordMessage = AuthErrors.getPasswordRejectionMessage(err);
  const networkMessage = AuthErrors.getNetworkErrorMessage(err);
  const fallbackMessage = 'Email ou mot de passe incorrect.';
  const result = emailMessage || passwordMessage || networkMessage || fallbackMessage;
  assert.equal(result, fallbackMessage);
  assert.doesNotMatch(result, /migré/i);
});

test('unknown auth error (4xx status, not invalid_credentials): NOT detected as network', () => {
  const err = { code: 'over_request_rate_limit', message: 'Rate limited', status: 429 };
  assert.equal(AuthErrors.isNetworkOrTransientError(err), false);
});

// --- invalid_credentials must NOT be detected as network error ---
test('invalid_credentials (status 400): NOT detected as network error', () => {
  const err = { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 };
  assert.equal(AuthErrors.isNetworkOrTransientError(err), false);
});

test('invalid_credentials: routing does NOT produce network message', () => {
  const err = { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 };
  const networkMessage = AuthErrors.getNetworkErrorMessage(err);
  assert.equal(networkMessage, null);
});

// ============================================================
// HTML source verification — both dashboards
// ============================================================

test('dashboard-client.html routes through getNetworkErrorMessage', async () => {
  const html = await readFile(new URL('../dashboard-client.html', import.meta.url), 'utf8');
  assert.match(html, /getNetworkErrorMessage/, 'client login must call getNetworkErrorMessage');
  // Verify routing order: emailMessage || passwordMessage || networkMessage || fallbackMessage
  const routingMatch = html.match(/emailMessage\s*\|\|\s*passwordMessage\s*\|\|\s*networkMessage\s*\|\|\s*fallbackMessage/);
  assert.ok(routingMatch, 'client login must route: email || password || network || fallback');
});

test('dashboard-convoyeur.html routes through getNetworkErrorMessage', async () => {
  const html = await readFile(new URL('../dashboard-convoyeur.html', import.meta.url), 'utf8');
  assert.match(html, /getNetworkErrorMessage/, 'convoyeur login must call getNetworkErrorMessage');
  const routingMatch = html.match(/emailMessage\s*\|\|\s*passwordMessage\s*\|\|\s*networkMessage\s*\|\|\s*fallbackMessage/);
  assert.ok(routingMatch, 'convoyeur login must route: email || password || network || fallback');
});

test('neither dashboard shows "migré" in login handler', async () => {
  const clientHtml = await readFile(new URL('../dashboard-client.html', import.meta.url), 'utf8');
  const convoHtml = await readFile(new URL('../dashboard-convoyeur.html', import.meta.url), 'utf8');
  assert.doesNotMatch(clientHtml, /pas encore migré/, 'client must not show migration text');
  assert.doesNotMatch(convoHtml, /pas encore migré/, 'convoyeur must not show migration text');
});

// ============================================================
// CHECK 2 — Legacy positive condition
// ============================================================

test('no positive legacy detection mechanism exists in auth-password-errors.js', async () => {
  const src = await readFile(new URL('../public/js/auth-password-errors.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /legacy|migré|not.*migrated/i, 'No legacy detection mechanism');
});

test('no positive legacy detection mechanism exists in dashboard-client.html login', async () => {
  const html = await readFile(new URL('../dashboard-client.html', import.meta.url), 'utf8');
  // Only check the login handler region (around handleClientLogin)
  const loginStart = html.indexOf('async function handleClientLogin');
  assert.ok(loginStart !== -1, 'handleClientLogin must exist');
  const loginRegion = html.substring(loginStart, loginStart + 2000);
  assert.doesNotMatch(loginRegion, /isLegacy|isMigrated|pas encore migré/i, 'No legacy detection in login handler');
});

test('no positive legacy detection mechanism exists in dashboard-convoyeur.html login', async () => {
  const html = await readFile(new URL('../dashboard-convoyeur.html', import.meta.url), 'utf8');
  const loginStart = html.indexOf('async function handleConvoyeurLogin');
  assert.ok(loginStart !== -1, 'handleConvoyeurLogin must exist');
  const loginRegion = html.substring(loginStart, loginStart + 2000);
  assert.doesNotMatch(loginRegion, /isLegacy|isMigrated|pas encore migré/i, 'No legacy detection in login handler');
});

// ============================================================
// CHECK 2 — Reset/migration path preserved
// ============================================================

test('dashboard-client.html preserves handleForgotPassword function', async () => {
  const html = await readFile(new URL('../dashboard-client.html', import.meta.url), 'utf8');
  assert.match(html, /async function handleForgotPassword/, 'handleForgotPassword must exist');
  assert.match(html, /resetPasswordForEmail|client-reset-password/, 'reset password endpoint must exist');
});

test('dashboard-convoyeur.html preserves handleConvoForgotPassword function', async () => {
  const html = await readFile(new URL('../dashboard-convoyeur.html', import.meta.url), 'utf8');
  assert.match(html, /async function handleConvoForgotPassword/, 'handleConvoForgotPassword must exist');
  assert.match(html, /resetPasswordForEmail|client-reset-password/, 'reset password endpoint must exist');
});

test('dashboard-client.html preserves "Mot de passe oublié" link', async () => {
  const html = await readFile(new URL('../dashboard-client.html', import.meta.url), 'utf8');
  assert.match(html, /linkForgotPassword/, 'forgot password link must exist');
  assert.match(html, /Mot de passe oublié/, 'forgot password text must exist');
});

test('dashboard-convoyeur.html preserves "Mot de passe oublié" link', async () => {
  const html = await readFile(new URL('../dashboard-convoyeur.html', import.meta.url), 'utf8');
  assert.match(html, /convLinkForgotPassword/, 'forgot password link must exist');
  assert.match(html, /Mot de passe oublié/, 'forgot password text must exist');
});

// ============================================================
// CHECK 4 — Invalid credentials without enumeration
// ============================================================

test('invalid_credentials message does not enumerate accounts (client)', async () => {
  const html = await readFile(new URL('../dashboard-client.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /ce compte existe|cet email est enregistré|compte trouvé/i);
});

test('invalid_credentials message does not enumerate accounts (convoyeur)', async () => {
  const html = await readFile(new URL('../dashboard-convoyeur.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /ce compte existe|cet email est enregistré|compte trouvé/i);
});

// ============================================================
// CHECK 5 — Email not confirmed uses specific helper
// ============================================================

test('dashboard-client.html calls getEmailNotConfirmedMessage (not inline check)', async () => {
  const html = await readFile(new URL('../dashboard-client.html', import.meta.url), 'utf8');
  assert.match(html, /getEmailNotConfirmedMessage/, 'must use the specific helper');
});

test('dashboard-convoyeur.html calls getEmailNotConfirmedMessage (not inline check)', async () => {
  const html = await readFile(new URL('../dashboard-convoyeur.html', import.meta.url), 'utf8');
  assert.match(html, /getEmailNotConfirmedMessage/, 'must use the specific helper');
});

// ============================================================
// Regression — operator dashboard unchanged
// ============================================================

test('dashboard-operator.html does NOT show "migré" (regression guard)', async () => {
  const html = await readFile(new URL('../dashboard-operator.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /pas encore migré/);
});
