import assert from 'assert';
import { findAuthUserByEmail, onRequest } from '../functions/api/stripe-webhook.js';

const missionId = '6fbb496e-7ea9-4926-8ef6-c3292d1a1223';
const baseMission = {
  id: missionId,
  reference: 'BC-2026-A40540CA',
  paiement_statut: 'paid',
  status: 'accepted',
  client_email: 'client@example.invalid',
  client_nom: 'Test Client',
};
const baseEnv = {
  STRIPE_SECRET_KEY: 'sk_test_local',
  STRIPE_WEBHOOK_SECRET: 'whsec_local',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'service-local',
  INTERNAL_SECRET: 'internal-local',
  URL: 'http://localhost:8791',
};

function event({ type = 'checkout.session.completed', paymentStatus = 'paid', id = 'evt_payment_1' } = {}) {
  return {
    id,
    type,
    data: {
      object: {
        id: 'cs_test_linked',
        payment_status: paymentStatus,
        metadata: { mission_id: missionId, reference: baseMission.reference },
      },
    },
  };
}

function request({ signature = 'valid' } = {}) {
  const headers = new Headers();
  if (signature) headers.set('stripe-signature', signature);
  return new Request('http://localhost:8791/api/stripe-webhook', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

function makeSupabase({ mission = baseMission, rpcError = null, profileError = null } = {}) {
  const calls = { rpc: 0, upsert: 0, listUsers: 0 };
  const supabase = {
    auth: {
      admin: {
        listUsers: async () => {
          calls.listUsers += 1;
          return { data: { users: [{ id: 'auth-client-1', email: mission.client_email }] }, error: null };
        },
        createUser: async () => ({ data: { user: { id: 'auth-created-1', email: mission.client_email } }, error: null }),
      },
    },
    from: (table) => {
      if (table === 'missions') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: mission, error: null }) }),
          }),
        };
      }
      if (table === 'clients') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { id: 'client-profile-1', role: 'client' }, error: null }) }),
          }),
          upsert: async () => {
            calls.upsert += 1;
            return { error: profileError };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (name, args) => {
      assert.strictEqual(name, 'complete_stripe_checkout_payment');
      assert.deepStrictEqual(args, { p_mission_id: missionId, p_session_id: 'cs_test_linked' });
      calls.rpc += 1;
      return { data: mission.paiement_statut === 'paid' ? 'already_paid' : 'paid', error: rpcError };
    },
  };
  return { supabase, calls };
}

function stripeStub(stripeEvent) {
  return { webhooks: { constructEventAsync: async () => stripeEvent } };
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('Stripe Webhook Reliability Tests');

await run('an already-paid retry still validates the RPC and retries side effects', async () => {
  const { supabase, calls } = makeSupabase();
  let emailBody;
  const response = await onRequest({
    request: request(),
    env: baseEnv,
    stripe: stripeStub(event()),
    supabase,
    fetchImpl: async (url, init) => {
      assert.strictEqual(url, 'http://localhost:8791/api/send-email');
      emailBody = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    },
  });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(calls.rpc, 1);
  assert.strictEqual(calls.upsert, 1);
  assert.strictEqual(emailBody.stripe_event_id, 'evt_payment_1');
});

await run('an email endpoint failure returns 500 so Stripe can retry', async () => {
  const { supabase, calls } = makeSupabase();
  const response = await onRequest({
    request: request(),
    env: baseEnv,
    stripe: stripeStub(event()),
    supabase,
    fetchImpl: async () => new Response('temporary failure', { status: 503 }),
  });

  assert.strictEqual(response.status, 500);
  assert.strictEqual(calls.rpc, 1);
});

await run('checkout.session.completed waits when payment is not yet paid', async () => {
  const { supabase, calls } = makeSupabase();
  const response = await onRequest({
    request: request(),
    env: baseEnv,
    stripe: stripeStub(event({ paymentStatus: 'unpaid' })),
    supabase,
    fetchImpl: async () => { throw new Error('must not send'); },
  });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(calls.rpc, 0);
  assert.strictEqual(calls.upsert, 0);
});

await run('checkout.session.async_payment_succeeded completes the payment', async () => {
  const { supabase, calls } = makeSupabase({ mission: { ...baseMission, paiement_statut: 'pending' } });
  const response = await onRequest({
    request: request(),
    env: baseEnv,
    stripe: stripeStub(event({ type: 'checkout.session.async_payment_succeeded', id: 'evt_async_1' })),
    supabase,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(calls.rpc, 1);
});

await run('Auth lookup paginates instead of silently stopping at the first page', async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => ({ id: `user-${index}`, email: `user-${index}@example.invalid` }));
  const pages = [];
  const supabase = {
    auth: {
      admin: {
        listUsers: async ({ page, perPage }) => {
          pages.push({ page, perPage });
          return page === 1
            ? { data: { users: firstPage }, error: null }
            : { data: { users: [{ id: 'target-id', email: 'TARGET@example.invalid' }] }, error: null };
        },
      },
    },
  };

  const user = await findAuthUserByEmail(supabase, 'target@example.invalid');
  assert.strictEqual(user.id, 'target-id');
  assert.deepStrictEqual(pages, [{ page: 1, perPage: 200 }, { page: 2, perPage: 200 }]);
});

await run('a profile persistence failure returns 500 before notification', async () => {
  const { supabase } = makeSupabase({ profileError: { message: 'database unavailable' } });
  let emailCalls = 0;
  const response = await onRequest({
    request: request(),
    env: baseEnv,
    stripe: stripeStub(event()),
    supabase,
    fetchImpl: async () => { emailCalls += 1; return new Response('{}', { status: 200 }); },
  });

  assert.strictEqual(response.status, 500);
  assert.strictEqual(emailCalls, 0);
});

await run('a missing Stripe signature is rejected', async () => {
  const { supabase } = makeSupabase();
  const response = await onRequest({
    request: request({ signature: '' }),
    env: baseEnv,
    stripe: stripeStub(event()),
    supabase,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  assert.strictEqual(response.status, 400);
});

console.log('7/7 Stripe webhook reliability tests passed.');
