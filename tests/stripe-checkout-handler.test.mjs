import assert from 'assert';
import { onRequest } from '../functions/api/create-checkout-session.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  Promise.resolve()
    .then(() => fn())
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { failed++; console.log(`  ✗ ${name}`); console.log(`    ERROR: ${err.message}`); });
}

const missionId = '6fbb496e-7ea9-4926-8ef6-c3292d1a1223';
const userId = 'e368470a-2e1d-4362-b8f6-d93813da3975';
const clientId = 'df768f22-bb93-46e6-af6b-069d4fd65ee9';

const baseMission = {
  id: missionId,
  reference: 'BC-2026-A40540CA',
  depart: 'Paris (75000)',
  arrivee: 'Lyon (69000)',
  vehicule: 'Berline',
  mode: 'one-way',
  pack: 'standard',
  montant_ht: 1042,
  paiement_statut: 'pending',
  status: 'accepted',
  client_id: clientId,
  client_email: 'client@example.invalid',
  client_nom: 'Test Client',
  convoyeur_nom: 'Convoyeur Test',
  stripe_session_id: null,
};

const baseUser = {
  id: userId,
  email: 'client@example.invalid',
};

const baseProfile = {
  id: clientId,
  role: 'client',
  email: 'client@example.invalid',
};

const baseEnv = {
  STRIPE_SECRET_KEY: 'sk_live_51U6SHPRzwrumP7RM',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'srvc-local',
  SUPABASE_ANON_KEY: 'anon-local',
  URL: 'http://localhost:8791',
};

let requestIpCounter = 1;

function makeRequest(body, { token = 'local-jwt', origin = 'http://localhost:5173' } = {}) {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${token}`);
  headers.set('origin', origin);
  headers.set('cf-connecting-ip', `127.0.0.${requestIpCounter++}`);
  return new Request('http://localhost:8791/api/create-checkout-session', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function makeSupabaseAnon(profileOverride = null, userOverride = null) {
  return {
    auth: {
      getUser: async () => ({ data: { user: userOverride || baseUser }, error: null }),
    },
    from: (table) => ({
      select: (cols) => ({
        eq: (col, val) => ({
          maybeSingle: async () => {
            if (table === 'clients') return { data: profileOverride || baseProfile, error: null };
            return { data: null, error: null };
          },
        }),
      }),
    }),
  };
}

function makeSupabase({ mission = baseMission, rpcResult = 'linked', rpcError = null } = {}) {
  return {
    from: (table) => ({
      select: (cols) => ({
        eq: (col, val) => ({
          single: async () => {
            if (table === 'missions') return { data: mission, error: null };
            return { data: null, error: null };
          },
        }),
      }),
    }),
    rpc: async (name, args) => {
      if (name === 'record_stripe_checkout_session') {
        return { data: rpcResult, error: rpcError };
      }
      return { data: null, error: null };
    },
  };
}

function makeStripe(stripeOverrides = {}) {
  const calls = { retrieve: 0, create: 0, expire: 0 };
  const stub = {
    checkout: {
      sessions: {
        retrieve: async (id) => { calls.retrieve++; return stripeOverrides.retrieve ? stripeOverrides.retrieve(id) : null; },
        create: async (params) => { calls.create++; return stripeOverrides.create ? stripeOverrides.create(params) : { id: 'cs_test_new', url: 'https://checkout.stripe.com/pay/cs_test_new' }; },
        expire: async (id) => { calls.expire++; return {}; },
      },
    },
  };
  return { stub, calls };
}

function makeContext({ request, env = baseEnv, supabase, supabaseAnon, stripe }) {
  return { request, env, supabase, supabaseAnon, stripe };
}

console.log('Stripe Checkout Handler Tests');

// =====================================================
// Existing session reuse
// =====================================================

test('CASE_4_REUSE: existing open+unpaid coherent -> 200, reused, 0 create/rpc/expire', async () => {
  const existingSession = {
    id: 'cs_live_existing',
    url: 'https://checkout.stripe.com/pay/cs_live_existing',
    livemode: true,
    status: 'open',
    payment_status: 'unpaid',
    mode: 'payment',
    currency: 'eur',
    amount_total: 104200,
    metadata: { mission_id: missionId, reference: 'BC-2026-A40540CA' },
  };
  const { stub: stripe, calls } = makeStripe({ retrieve: async () => existingSession });
  const mission = { ...baseMission, stripe_session_id: 'cs_live_existing' };
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
  const context = makeContext({ request, supabase: makeSupabase({ mission }), supabaseAnon: makeSupabaseAnon(), stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.reused, true);
  assert.strictEqual(body.url, existingSession.url);
  assert.strictEqual(calls.retrieve, 1);
  assert.strictEqual(calls.create, 0);
  assert.strictEqual(calls.expire, 0);
});

// =====================================================
// Existing session fail-closed
// =====================================================

async function testExistingFail(name, existingSession) {
  test(name, async () => {
    const { stub: stripe, calls } = makeStripe({ retrieve: async () => existingSession });
    const mission = { ...baseMission, stripe_session_id: 'cs_live_existing' };
    const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
    const context = makeContext({ request, supabase: makeSupabase({ mission }), supabaseAnon: makeSupabaseAnon(), stripe });
    const res = await onRequest(context);
    assert.notStrictEqual(res.status, 200);
    assert.strictEqual(calls.create, 0);
    assert.strictEqual(calls.expire, 0);
  });
}

testExistingFail('A. amount mismatch', {
  id: 'cs_live_existing',
  url: 'https://checkout.stripe.com/pay/cs_live_existing',
  livemode: true,
  status: 'open',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 99900,
  metadata: { mission_id: missionId, reference: 'BC-2026-A40540CA' },
});

testExistingFail('B. mission metadata mismatch', {
  id: 'cs_live_existing',
  url: 'https://checkout.stripe.com/pay/cs_live_existing',
  livemode: true,
  status: 'open',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 104200,
  metadata: { mission_id: 'other', reference: 'BC-2026-A40540CA' },
});

testExistingFail('C. reference mismatch', {
  id: 'cs_live_existing',
  url: 'https://checkout.stripe.com/pay/cs_live_existing',
  livemode: true,
  status: 'open',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 104200,
  metadata: { mission_id: missionId, reference: 'OTHER-REF' },
});

testExistingFail('D. currency mismatch', {
  id: 'cs_live_existing',
  url: 'https://checkout.stripe.com/pay/cs_live_existing',
  livemode: true,
  status: 'open',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'usd',
  amount_total: 104200,
  metadata: { mission_id: missionId, reference: 'BC-2026-A40540CA' },
});

testExistingFail('E. livemode mismatch', {
  id: 'cs_live_existing',
  url: 'https://checkout.stripe.com/pay/cs_live_existing',
  livemode: false,
  status: 'open',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 104200,
  metadata: { mission_id: missionId, reference: 'BC-2026-A40540CA' },
});

testExistingFail('F. expired', {
  id: 'cs_live_existing',
  url: 'https://checkout.stripe.com/pay/cs_live_existing',
  livemode: true,
  status: 'expired',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 104200,
  metadata: { mission_id: missionId, reference: 'BC-2026-A40540CA' },
});

testExistingFail('G. complete + paid', {
  id: 'cs_live_existing',
  url: 'https://checkout.stripe.com/pay/cs_live_existing',
  livemode: true,
  status: 'complete',
  payment_status: 'paid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 104200,
  metadata: { mission_id: missionId, reference: 'BC-2026-A40540CA' },
});

testExistingFail('H. complete + unpaid', {
  id: 'cs_live_existing',
  url: 'https://checkout.stripe.com/pay/cs_live_existing',
  livemode: true,
  status: 'complete',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 104200,
  metadata: { mission_id: missionId, reference: 'BC-2026-A40540CA' },
});

test('I. resource_missing / retrieve failure', async () => {
  const { stub: stripe, calls } = makeStripe({
    retrieve: async () => { throw new Error('No such checkout.session'); },
  });
  const mission = { ...baseMission, stripe_session_id: 'cs_live_missing' };
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
  const context = makeContext({ request, supabase: makeSupabase({ mission }), supabaseAnon: makeSupabaseAnon(), stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(calls.create, 0);
});

testExistingFail('J. missing URL', {
  id: 'cs_live_existing',
  url: '',
  livemode: true,
  status: 'open',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 104200,
  metadata: { mission_id: missionId, reference: 'BC-2026-A40540CA' },
});

// =====================================================
// NULL session path
// =====================================================

test('NULL_SESSION: nominal -> create 1, record 1, URL returned', async () => {
  const { stub: stripe, calls } = makeStripe({
    create: async () => ({ id: 'cs_test_new', url: 'https://checkout.stripe.com/pay/cs_test_new' }),
  });
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
  const supabase = makeSupabase({ mission: baseMission, rpcResult: 'linked', rpcError: null });
  const context = makeContext({ request, supabase, supabaseAnon: makeSupabaseAnon(), stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.url, 'https://checkout.stripe.com/pay/cs_test_new');
  assert.strictEqual(calls.create, 1);
});

test('NULL_SESSION: RPC failure -> create 1, record 1, expire 1', async () => {
  const { stub: stripe, calls } = makeStripe({
    create: async () => ({ id: 'cs_test_new', url: 'https://checkout.stripe.com/pay/cs_test_new' }),
  });
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
  const supabase = makeSupabase({ mission: baseMission, rpcError: { message: 'already linked' } });
  const context = makeContext({ request, supabase, supabaseAnon: makeSupabaseAnon(), stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 500);
  assert.strictEqual(calls.create, 1);
  assert.strictEqual(calls.expire, 1);
});

// =====================================================
// Early security guards
// =====================================================

test('EARLY_1: already paid DB -> 409, 0 stripe calls', async () => {
  const { stub: stripe, calls } = makeStripe({});
  const mission = { ...baseMission, paiement_statut: 'paid' };
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
  const context = makeContext({ request, supabase: makeSupabase({ mission }), supabaseAnon: makeSupabaseAnon(), stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(calls.retrieve, 0);
  assert.strictEqual(calls.create, 0);
});

test('EARLY_2: unauthorized client -> 403, 0 stripe calls', async () => {
  const { stub: stripe, calls } = makeStripe({});
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
  const otherUser = { id: 'other-user', email: 'other@example.invalid' };
  const otherProfile = { id: 'other-client', role: 'client', email: 'other@example.invalid' };
  const supabaseAnon = makeSupabaseAnon(otherProfile, otherUser);
  const context = makeContext({ request, supabase: makeSupabase({}), supabaseAnon, stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(calls.retrieve, 0);
  assert.strictEqual(calls.create, 0);
});

test('EARLY_3: invalid auth -> 401, 0 stripe calls', async () => {
  const { stub: stripe, calls } = makeStripe({});
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' }, { token: 'bad-token' });
  const supabaseAnon = {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  };
  const context = makeContext({ request, supabase: makeSupabase({}), supabaseAnon, stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 401);
  assert.strictEqual(calls.retrieve, 0);
  assert.strictEqual(calls.create, 0);
});

test('EARLY_4: non-payable status -> blocked, 0 stripe calls', async () => {
  const { stub: stripe, calls } = makeStripe({});
  const mission = { ...baseMission, status: 'completed' };
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
  const context = makeContext({ request, supabase: makeSupabase({ mission }), supabaseAnon: makeSupabaseAnon(), stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(calls.create, 0);
});

test('EARLY_5: invalid amount -> blocked, 0 stripe calls', async () => {
  const { stub: stripe, calls } = makeStripe({});
  const mission = { ...baseMission, montant_ht: 0 };
  const request = makeRequest({ missionId, successUrl: 'http://s', cancelUrl: 'http://c' });
  const context = makeContext({ request, supabase: makeSupabase({ mission }), supabaseAnon: makeSupabaseAnon(), stripe });
  const res = await onRequest(context);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(calls.create, 0);
});

setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}, 100);
