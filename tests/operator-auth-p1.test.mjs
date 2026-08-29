import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { onRequest } from '../functions/api/operator-reset-password.js';

const operatorEmail = 'operator@example.invalid';
const userId = '41feb69c-c024-45d6-a3c1-ab4aa6122748';
let requestCounter = 1;

function request(body = { email: operatorEmail }, method = 'POST') {
  return new Request('https://www.bathily-convoyage.fr/api/operator-reset-password', {
    method,
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.bathily-convoyage.fr',
      'cf-connecting-ip': `127.10.0.${requestCounter++}`
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
}

function supabaseStub({ user = true, role = true, active = true, executor = true, banned = false, resend = false } = {}) {
  const calls = { generateLink: 0, reset: 0 };
  const rows = {
    user_roles: role ? { role: 'operator' } : null,
    internal_operators: active ? { active: true } : { active: false },
    convoyeurs: executor ? { id: 'executor-1', prenom: 'Opérateur', banned } : null
  };
  const stub = {
    calls,
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: user ? [{ id: userId, email: operatorEmail }] : [] }, error: null }),
        generateLink: async () => {
          calls.generateLink++;
          return { data: { properties: { action_link: 'https://supabase.invalid/recovery-link' } }, error: null };
        }
      },
      resetPasswordForEmail: async (email, options) => {
        calls.reset++;
        calls.resetEmail = email;
        calls.redirectTo = options.redirectTo;
        return { error: null };
      }
    },
    from: table => ({
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({ data: rows[table], error: null })
        };
        return chain;
      }
    })
  };
  return { stub, calls, env: resend ? { RESEND_API_KEY: 're_test' } : {} };
}

function context(options = {}) {
  return {
    request: options.request || request(),
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-local',
      ...(options.env || {})
    },
    supabase: options.supabase,
    fetch: options.fetch
  };
}

test('rejects methods other than POST', async () => {
  const { stub } = supabaseStub();
  const response = await onRequest(context({ request: request({}, 'GET'), supabase: stub }));
  assert.equal(response.status, 405);
});

test('requires an email', async () => {
  const { stub } = supabaseStub();
  const response = await onRequest(context({ request: request({}), supabase: stub }));
  assert.equal(response.status, 400);
});

test('does not reveal an unknown account', async () => {
  const { stub, calls } = supabaseStub({ user: false });
  const response = await onRequest(context({ supabase: stub }));
  assert.equal(response.status, 200);
  assert.equal(calls.generateLink, 0);
  assert.equal(calls.reset, 0);
});

test('does not send recovery for an inactive or unauthorized operator', async () => {
  const { stub, calls } = supabaseStub({ active: false });
  const response = await onRequest(context({ supabase: stub }));
  assert.equal(response.status, 200);
  assert.equal(calls.generateLink, 0);
  assert.equal(calls.reset, 0);
});

test('uses Supabase recovery email with the dedicated redirect when Resend is absent', async () => {
  const { stub, calls } = supabaseStub();
  const response = await onRequest(context({ supabase: stub }));
  assert.equal(response.status, 200);
  assert.equal(calls.reset, 1);
  assert.equal(calls.resetEmail, operatorEmail);
  assert.equal(calls.redirectTo, 'https://www.bathily-convoyage.fr/reset-password.html');
});

test('operator recovery no longer requires a convoyeur profile after P4.2', async () => {
  const { stub, calls } = supabaseStub({ executor: false });
  const response = await onRequest(context({ supabase: stub }));
  assert.equal(response.status, 200);
  assert.equal(calls.reset, 1);
  assert.equal(calls.resetEmail, operatorEmail);
});

test('uses a generated recovery link when Resend is configured', async () => {
  const { stub, calls, env } = supabaseStub({ resend: true });
  const sent = [];
  const response = await onRequest(context({
    supabase: stub,
    env,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response('{}', { status: 200 });
    }
  }));
  assert.equal(response.status, 200);
  assert.equal(calls.generateLink, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].init.body, /recovery-link/);
});

test('operator login exposes a local forgot-password action', async () => {
  const html = await readFile(new URL('../dashboard-operator.html', import.meta.url), 'utf8');
  assert.match(html, /id="opForgotPassword"/);
  assert.match(html, /\/api\/operator-reset-password/);
  assert.doesNotMatch(html, /Mot de passe oublié" depuis la page publique/);
});

test('homepage forwards invite and recovery tokens before Supabase consumes them', async () => {
  const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const redirect = await readFile(new URL('../public/js/auth-entry-redirect.js', import.meta.url), 'utf8');
  assert.match(index, /auth-entry-redirect\.js/);
  assert.match(redirect, /authType !== 'invite'/);
  assert.match(redirect, /reset-password\.html/);
});

test('reset page accepts invite tokens as well as recovery tokens', async () => {
  const html = await readFile(new URL('../reset-password.html', import.meta.url), 'utf8');
  assert.match(html, /hashType === 'recovery' \|\| hashType === 'invite'/);
  assert.match(html, /queryType === 'recovery' \|\| queryType === 'invite'/);
});
