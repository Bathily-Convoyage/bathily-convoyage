import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const stripeHelper = readFileSync(new URL('../functions/_stripe.js', import.meta.url), 'utf8');
const checkoutHandler = readFileSync(new URL('../functions/api/create-checkout-session.js', import.meta.url), 'utf8');
const webhookHandler = readFileSync(new URL('../functions/api/stripe-webhook.js', import.meta.url), 'utf8');

test('Stripe SDK is pinned to the reviewed major version', () => {
  assert.equal(packageJson.dependencies.stripe, '22.6.0');
});

test('Stripe API behavior remains explicitly pinned during the SDK upgrade', () => {
  assert.match(stripeHelper, /STRIPE_API_VERSION = '2024-04-10'/);
  assert.match(stripeHelper, /new Stripe\(secretKey, \{ apiVersion: STRIPE_API_VERSION \}\)/);
});

test('all server handlers use the centralized Stripe client', () => {
  for (const source of [checkoutHandler, webhookHandler]) {
    assert.match(source, /createStripeClient\(env\.STRIPE_SECRET_KEY\)/);
    assert.doesNotMatch(source, /Stripe\(env\.STRIPE_SECRET_KEY\)/);
  }
});

test('Checkout uses Stripe dynamic payment methods', () => {
  assert.doesNotMatch(checkoutHandler, /payment_method_types/);
});
