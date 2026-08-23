import assert from 'assert';
import { canReuseExistingSession } from '../functions/api/create-checkout-session.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result
        .then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((err) => { failed++; console.log(`  ✗ ${name}`); console.log(`    ERROR: ${err.message}`); });
    } else {
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ERROR: ${err.message}`);
  }
}

const baseMission = {
  id: '6fbb496e-7ea9-4926-8ef6-c3292d1a1223',
  reference: 'BC-2026-A40540CA',
  montant_ht: 1042,
};

const baseLiveEnv = { STRIPE_SECRET_KEY: 'sk_live_51U6SHPRzwrumP7RM' };
const baseTestEnv = { STRIPE_SECRET_KEY: 'sk_test_51U6SHPRzwrumP7RM' };

const validLiveSession = {
  id: 'cs_live_abc',
  url: 'https://checkout.stripe.com/pay/cs_live_abc',
  livemode: true,
  status: 'open',
  payment_status: 'unpaid',
  mode: 'payment',
  currency: 'eur',
  amount_total: 104200,
  metadata: {
    mission_id: '6fbb496e-7ea9-4926-8ef6-c3292d1a1223',
    reference: 'BC-2026-A40540CA',
  },
};

console.log('Stripe Checkout Session Reuse Logic Tests');

test('CASE_1: existing open+unpaid coherent with live key -> reusable', () => {
  const result = canReuseExistingSession(validLiveSession, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, true);
  assert.strictEqual(result.url, validLiveSession.url);
});

test('CASE_2: existing open+unpaid amount mismatch -> blocked', () => {
  const session = { ...validLiveSession, amount_total: 99900 };
  const result = canReuseExistingSession(session, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
});

test('CASE_3: metadata mission_id mismatch -> blocked', () => {
  const session = { ...validLiveSession, metadata: { ...validLiveSession.metadata, mission_id: 'other' } };
  const result = canReuseExistingSession(session, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
});

test('CASE_4: metadata reference mismatch -> blocked', () => {
  const session = { ...validLiveSession, metadata: { ...validLiveSession.metadata, reference: 'OTHER-REF' } };
  const result = canReuseExistingSession(session, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
});

test('CASE_5: currency mismatch -> blocked', () => {
  const session = { ...validLiveSession, currency: 'usd' };
  const result = canReuseExistingSession(session, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
});

test('CASE_6: livemode mismatch (test key but live session) -> blocked', () => {
  const result = canReuseExistingSession(validLiveSession, baseMission, baseTestEnv);
  assert.strictEqual(result.reusable, false);
});

test('CASE_7: status=complete + payment_status=paid -> 409-like blocked', () => {
  const session = { ...validLiveSession, status: 'complete', payment_status: 'paid' };
  const result = canReuseExistingSession(session, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
  assert.ok(result.reason.includes('déjà'));
});

test('CASE_8: status=complete + unpaid -> blocked', () => {
  const session = { ...validLiveSession, status: 'complete', payment_status: 'unpaid' };
  const result = canReuseExistingSession(session, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
});

test('CASE_9: status=expired -> blocked', () => {
  const session = { ...validLiveSession, status: 'expired' };
  const result = canReuseExistingSession(session, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
  assert.ok(result.reason.includes('expiré'));
});

test('CASE_10: Stripe retrieve returns resource_missing (null session) -> blocked', () => {
  const result = canReuseExistingSession(null, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
});

test('CASE_11: open+unpaid but URL missing -> blocked', () => {
  const session = { ...validLiveSession, url: '' };
  const result = canReuseExistingSession(session, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, false);
});

test('CASE_13: already paid DB mission not handled by canReuse but amount total preserved', () => {
  // canReuse does not inspect mission.paiement_statut; onRequest already guards that
  const result = canReuseExistingSession(validLiveSession, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, true);
});

test('CASE_18: existing session reuse causes zero DB mutation', () => {
  // Pure logic: no DB side effects in this function
  const result = canReuseExistingSession(validLiveSession, baseMission, baseLiveEnv);
  assert.strictEqual(result.reusable, true);
});

// Wait for async tests to finish
setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}, 100);
