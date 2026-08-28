import Stripe from 'stripe';

// Keep the API behavior stable while the Node SDK is upgraded independently.
// A later, test-mode-only gate will validate the Dahlia API migration.
export const STRIPE_API_VERSION = '2024-04-10';

export function createStripeClient(secretKey) {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
}
