import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { onRequest } from '../functions/api/client-signup.js';

const helperSource = await readFile(new URL('../public/js/auth-password-errors.js', import.meta.url), 'utf8');
const browserContext = { window: {} };
vm.runInNewContext(helperSource, browserContext);
const messages = browserContext.window.BathilyAuthErrors;

test('maps a pwned Supabase password error to a clear French message', () => {
  const message = messages.getPasswordRejectionMessage({
    code: 'weak_password',
    name: 'AuthWeakPasswordError',
    reasons: ['pwned']
  });
  assert.equal(message, messages.COMPROMISED_PASSWORD_MESSAGE);
  assert.match(message, /compromis/);
});

test('maps other weak-password reasons without exposing a provider message', () => {
  const message = messages.getPasswordRejectionMessage({
    code: 'weak_password',
    reasons: ['length', 'characters'],
    message: 'Password should contain at least one character of each type'
  });
  assert.equal(message, messages.WEAK_PASSWORD_MESSAGE);
  assert.doesNotMatch(message, /Password/);
});

test('does not relabel unrelated authentication failures', () => {
  assert.equal(messages.getPasswordRejectionMessage({ code: 'invalid_credentials' }), null);
  assert.equal(messages.getPasswordRejectionMessage(null), null);
});

test('client signup returns a stable weak_password payload', async () => {
  // SEC-1F4A.1: Updated mock to match auth.signUp() architecture.
  // The new client-signup.js uses an anon client for auth.signUp()
  // and a service-role admin client for profile lookups.
  // The weak_password error now comes from auth.signUp, not admin.createUser.
  const supabaseAnon = {
    auth: {
      signUp: async () => ({
        data: { user: null, session: null },
        error: {
          code: 'weak_password',
          name: 'AuthWeakPasswordError',
          message: 'Password is known to be weak',
          reasons: ['pwned']
        }
      })
    }
  };
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null })
        })
      })
    })
  };
  const request = new Request('https://www.bathily-convoyage.fr/api/client-signup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.bathily-convoyage.fr',
      'cf-connecting-ip': '127.36.0.1'
    },
    body: JSON.stringify({
      email: 'client-p36@example.invalid',
      password: 'password',
      prenom: 'Client',
      nom: 'P36'
    })
  });

  const response = await onRequest({
    request,
    supabase,
    supabaseAnon,
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-local',
      SUPABASE_ANON_KEY: 'anon-key-local'
    }
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, 'weak_password');
  assert.deepEqual(body.reasons, ['pwned']);
  assert.doesNotMatch(JSON.stringify(body), /known to be weak/);
});

test('all password entry pages load and use the shared translator', async () => {
  const files = [
    'dashboard-admin.html',
    'dashboard-client.html',
    'dashboard-convoyeur.html',
    'dashboard-operator.html',
    'reset-password.html'
  ];

  for (const file of files) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(html, /\/js\/auth-password-errors\.js/, `${file} must load the helper`);
    assert.match(html, /getPasswordRejectionMessage/, `${file} must translate weak password errors`);
  }
});
