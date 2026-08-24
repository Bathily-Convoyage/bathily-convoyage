import assert from 'assert';
import { onRequest } from '../functions/api/send-email.js';

const mission = {
  id: '6fbb496e-7ea9-4926-8ef6-c3292d1a1223',
  reference: 'BC-2026-A40540CA',
  client_nom: 'Test Client',
  client_email: 'client@example.invalid',
  client_telephone: null,
  depart: 'Paris',
  arrivee: 'Lyon',
  vehicule: 'Berline',
  mode: 'route',
  pack: 'standard',
  montant_ht: 1042,
  paiement_statut: 'paid',
  status: 'accepted',
  convoyeur_nom: null,
  convoyeur_id: null,
  date_mission: null,
};

const env = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'service-local',
  INTERNAL_SECRET: 'internal-local',
  RESEND_API_KEY: 're_local',
  EMAIL_FROM: 'noreply@example.invalid',
  EMAIL_ADMIN: 'admin@example.invalid',
};

let requestCounter = 1;

function makeRequest(id, eventId) {
  return new Request('http://localhost:8791/api/send-email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': env.INTERNAL_SECRET,
      'cf-connecting-ip': `127.0.1.${requestCounter++}`,
    },
    body: JSON.stringify({ trigger: 'payment_success', id, stripe_event_id: eventId }),
  });
}

function supabaseFor(currentMission) {
  return {
    from: (table) => {
      assert.strictEqual(table, 'missions');
      return {
        select: () => ({
          eq: () => ({ single: async () => ({ data: currentMission, error: null }) }),
        }),
      };
    },
  };
}

async function run(name, fn) {
  await fn();
  console.log(`  ✓ ${name}`);
}

console.log('Payment Email Idempotency Tests');

await run('client and admin emails use stable event-scoped idempotency keys', async () => {
  const sends = [];
  const response = await onRequest({
    request: makeRequest(mission.id, 'evt_payment_1'),
    env,
    supabase: supabaseFor(mission),
    fetchImpl: async (url, init) => {
      sends.push({ url, init });
      return new Response(JSON.stringify({ id: `email-${sends.length}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(sends.length, 2);
  assert.strictEqual(sends[0].init.headers['Idempotency-Key'], 'stripe/evt_payment_1/client');
  assert.strictEqual(sends[1].init.headers['Idempotency-Key'], 'stripe/evt_payment_1/admin');
});

await run('a missing client email never sends to a placeholder address', async () => {
  const sends = [];
  const response = await onRequest({
    request: makeRequest(mission.id, 'evt_payment_2'),
    env,
    supabase: supabaseFor({ ...mission, client_email: null }),
    fetchImpl: async (url, init) => {
      sends.push({ url, init });
      return new Response(JSON.stringify({ id: 'email-admin' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.strictEqual(response.status, 200);
  assert.strictEqual(sends.length, 1);
  const payload = JSON.parse(sends[0].init.body);
  assert.deepStrictEqual(payload.to, ['admin@example.invalid']);
  assert.strictEqual(sends[0].init.headers['Idempotency-Key'], 'stripe/evt_payment_2/admin');
});

console.log('2/2 payment email idempotency tests passed.');
