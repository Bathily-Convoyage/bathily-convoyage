import { test, expect } from '@playwright/test';
import { createAnonClient, signIn, SUPABASE_URL, SUPABASE_ANON_KEY } from './helpers.js';

// Utilisateurs de test (à renseigner dans .env)
const TEST_ADMIN = process.env.TEST_ADMIN_EMAIL || 'admin@example.com';
const TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'password';
const TEST_CLIENT = process.env.TEST_CLIENT_EMAIL || 'client@example.com';
const TEST_CLIENT_PASSWORD = process.env.TEST_CLIENT_PASSWORD || 'password';
const TEST_CONVOYEUR = process.env.TEST_CONVOYEUR_EMAIL || 'convoyeur@example.com';
const TEST_CONVOYEUR_PASSWORD = process.env.TEST_CONVOYEUR_PASSWORD || 'password';

test.describe('Vérification sécurité RLS / RPC', () => {
  test('anon peut exécuter is_admin()', async () => {
    const sb = createAnonClient();
    const { data, error } = await sb.rpc('is_admin');
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  test('anon ne peut pas exécuter admin_delete_user', async () => {
    const sb = createAnonClient();
    const { error } = await sb.rpc('admin_delete_user', {
      target_id: '00000000-0000-0000-0000-000000000000',
      target_table: 'clients'
    });
    expect(error).not.toBeNull();
  });

  test('anon ne peut pas exécuter apply_parrainage_code', async () => {
    const sb = createAnonClient();
    const { error } = await sb.rpc('apply_parrainage_code', { code_input: 'TEST123' });
    expect(error).not.toBeNull();
  });

  test('anon ne peut pas exécuter like_reseau_post', async () => {
    const sb = createAnonClient();
    const { error } = await sb.rpc('like_reseau_post', {
      post_id: '00000000-0000-0000-0000-000000000000'
    });
    expect(error).not.toBeNull();
  });

  test('authenticated peut exécuter apply_parrainage_code', async () => {
    test.skip(!TEST_CONVOYEUR || !TEST_CONVOYEUR_PASSWORD, 'Pas de credentials convoyeur de test');
    const sb = await signIn(TEST_CONVOYEUR, TEST_CONVOYEUR_PASSWORD);
    const { error } = await sb.rpc('apply_parrainage_code', { code_input: 'INVALIDE' });
    // La RPC doit être appelable (même si le code est invalide)
    expect(error?.message).not.toMatch(/permission|not allowed|authorization/i);
  });

  test('authenticated peut exécuter like_reseau_post', async () => {
    test.skip(!TEST_CONVOYEUR || !TEST_CONVOYEUR_PASSWORD, 'Pas de credentials convoyeur de test');
    const sb = await signIn(TEST_CONVOYEUR, TEST_CONVOYEUR_PASSWORD);
    const { error } = await sb.rpc('like_reseau_post', {
      post_id: '00000000-0000-0000-0000-000000000000'
    });
    // La RPC doit être appelable (même si le post n'existe pas)
    expect(error?.message).not.toMatch(/permission|not allowed|authorization/i);
  });

  test('admin_delete_user est appelable par authenticated mais refuse sans droit admin', async () => {
    test.skip(!TEST_CLIENT || !TEST_CLIENT_PASSWORD, 'Pas de credentials client de test');
    const sb = await signIn(TEST_CLIENT, TEST_CLIENT_PASSWORD);
    const { error } = await sb.rpc('admin_delete_user', {
      target_id: '00000000-0000-0000-0000-000000000000',
      target_table: 'clients'
    });
    // Appelable, mais doit refuser car pas admin
    expect(error).not.toBeNull();
    expect(error.message.toLowerCase()).toMatch(/permission|administrateur|refusée/);
  });
});
